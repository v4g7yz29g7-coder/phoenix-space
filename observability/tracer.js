'use strict';

/**
 * observability/tracer.js
 * ===========================================================================
 * Модуль распределённого трейсинга (span-трейсер) для гонок пула.
 *
 * Назначение
 * ---------------------------------------------------------------------------
 * Гонка пула (pool race) исполняется параллельно несколькими боксами/агентами,
 * поэтому длительности и вложенность операций нужно мерить строго: один
 * корневой span на гонку (pool), дочерние span'ы на фазы (box_start, think,
 * finish, judge ...) и агрегированный p95 по всем span'ам.
 *
 * Публичный API (singleton, CommonJS)
 * ---------------------------------------------------------------------------
 *   start(spec, parent?)  -> span   // завести span; spec: string | object
 *   end(spanOrId, opts?)  -> record // закрыть span, выставить duration_ms
 *   flatten(opts?)        -> record[] // ПЛОСКИЙ список (без children)
 *   getSpan(id)           -> record|null      // alias: span(id)
 *   spans()               -> record[]         // все span'ы в порядке старта
 *   open()                -> record[]         // незакрытые span'ы
 *   traces()              -> traceSummary[]   // группировка по traceId
 *   stats()               -> stats            // count/min/max/avg/p50/p95/p99
 *   percentile(values, p) -> number           // линейная интерполяция
 *   p95(values)           -> number           // shortcut
 *   reset()               -> void
 *   createTracer(opts)    -> изолированный экземпляр (свой clock / idGen)
 *
 * Константы / вспомогательное
 * ---------------------------------------------------------------------------
 *   MAX_DEPTH   === 5    // максимум уровней вложенности (root = уровень 1)
 *   HEX_ID_RE   /^[0-9a-f]{16}$/            // span id — РОВНО 16 hex символов
 *   TRACE_ID_RE /^[0-9a-f]{16}$/            // traceId == id корневого span'а
 *
 * Гарантии (то, что проверяет standalone-тест)
 * ---------------------------------------------------------------------------
 *   1. span.id — строго 16 hex-символов (`^[0-9a-f]{16}$`), уникален.
 *   2. Вложенность трейса — до 5 уровней включительно. Попытка завести span
 *      на 6-м уровне бросает RangeError (см. MAX_DEPTH).
 *   3. flatten() возвращает ПЛОСКИЙ массив: у записей нет полей-массивов с
 *      детьми, у каждой закрытой записи есть числовой duration_ms.
 *   4. stats().p95_ms по 100 span'ам считается линейной интерполяцией
 *      (percentile([1..100], 95) === 95.05) — точнее, чем ±1% от эталона.
 *   5. end() принимает и id (string), и span-объект, и {id}.
 *   6. Двойное закрытие / неизвестный id / конец раньше начала /
 *      неизвестный родитель / превышение глубины — бросают Error.
 *   7. Часы и генератор id инъектируемы (createTracer) — детерминизм в тестах.
 *
 * Зависимостей нет (node:crypto опционален, есть fallback на Math.random).
 *
 * Запуск self-check:
 *   node observability/tracer.standalone.test.js
 *
 * @module observability/tracer
 */

/* ------------------------------------------------------------------------- *
 * Константы
 * ------------------------------------------------------------------------- */

/** span id / traceId: ровно 16 hex-символов. */
const HEX_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_ID_RE = HEX_ID_RE;

/** Максимум уровней вложенности: уровень 1 — корень трейса, уровень 5 — лист. */
const MAX_DEPTH = 5;

/** Статусы span'а. */
const STATUS_OPEN = 'open';
const STATUS_CLOSED = 'closed';

/** Разрешённые режимы сортировки для flatten(). */
const SORTS = ['start', 'duration', 'depth', 'name'];

const HEX_DIGITS = '0123456789abcdef';

/* ------------------------------------------------------------------------- *
 * Генерация id и работа с временем
 * ------------------------------------------------------------------------- */

let _crypto = null;
try {
  // eslint-disable-next-line global-require
  _crypto = require('crypto');
} catch (_e) {
  _crypto = null;
}

/**
 * 16 hex-символов (64 бита). Криптостойкая случайность, если доступен crypto.
 * @param {() => number} [rng] инъектируемый ГПСЧ (0..1), для тестов
 * @returns {string}
 */
function randomHex16(rng) {
  if (typeof rng === 'function') {
    let out = '';
    for (let i = 0; i < 16; i += 1) {
      const r = rng();
      const idx = Math.floor((Number.isFinite(r) ? Math.abs(r) : 0) * 16) % 16;
      out += HEX_DIGITS[idx];
    }
    return out;
  }
  if (_crypto && typeof _crypto.randomBytes === 'function') {
    return _crypto.randomBytes(8).toString('hex');
  }
  let out = '';
  for (let i = 0; i < 16; i += 1) out += HEX_DIGITS[Math.floor(Math.random() * 16)];
  return out;
}

/** @returns {number} текущее время в мс */
function defaultNow() {
  return Date.now();
}

/* ------------------------------------------------------------------------- *
 * Утилиты
 * ------------------------------------------------------------------------- */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** Сортировка по (start_ms, id) — детерминированный порядок flatten(). */
function cmpByStart(a, b) {
  if (a.start_ms !== b.start_ms) return a.start_ms - b.start_ms;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function cmpStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Перцентиль с линейной интерполяцией (как в numpy/statistics).
 * percentile([1..100], 95) === 95.05.
 * @param {number[]} values
 * @param {number} p 0..100
 * @returns {number|null} null для пустого входа
 */
function percentile(values, p) {
  if (!Array.isArray(values)) throw new TypeError('percentile: values must be an array');
  if (!isFiniteNumber(p) || p < 0 || p > 100) {
    throw new RangeError('percentile: p must be a number in [0, 100]');
  }
  const nums = values
    .filter((v) => isFiniteNumber(v))
    .slice()
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  const k = (nums.length - 1) * (p / 100);
  const lo = Math.floor(k);
  const hi = Math.min(nums.length - 1, Math.ceil(k));
  const frac = k - lo;
  return nums[lo] + (nums[hi] - nums[lo]) * frac;
}

/** @param {number[]} values @returns {number|null} */
function p95(values) {
  return percentile(values, 95);
}

/* ------------------------------------------------------------------------- *
 * createTracer — изолированный экземпляр
 * ------------------------------------------------------------------------- */

/**
 * @param {object} [options]
 * @param {() => number} [options.now]   часы (по умолчанию Date.now)
 * @param {() => string} [options.idGen] генератор id (по умолчанию 16 hex)
 * @param {number} [options.maxDepth]    максимум уровней вложенности
 * @returns {object} tracer
 */
function createTracer(options) {
  const opts = isPlainObject(options) ? options : {};
  const now = typeof opts.now === 'function' ? opts.now : defaultNow;
  const idGen = typeof opts.idGen === 'function' ? opts.idGen : () => randomHex16();
  const maxDepth = opts.maxDepth == null ? MAX_DEPTH : opts.maxDepth;
  if (!isFiniteNumber(maxDepth) || maxDepth < 1 || Math.floor(maxDepth) !== maxDepth) {
    throw new RangeError('createTracer: maxDepth must be a positive integer');
  }

  /** @type {Map<string, object>} */
  const store = new Map();
  /** @type {Map<string, string>} traceId -> rootSpanId */
  const roots = new Map();

  /* ---------------- внутренние helpers ---------------- */

  function requireSpanOrId(spanOrId, who) {
    let id = null;
    if (typeof spanOrId === 'string') id = spanOrId;
    else if (isPlainObject(spanOrId) && typeof spanOrId.id === 'string') id = spanOrId.id;
    if (id === null) {
      throw new TypeError(who + ': expected span id (string) or span object');
    }
    const s = store.get(id);
    if (!s) throw new Error(who + ': unknown span id "' + id + '"');
    return s;
  }

  function publicRecord(s) {
    return {
      id: s.id,
      traceId: s.traceId,
      parentId: s.parentId,
      name: s.name,
      depth: s.depth,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      duration_ms: s.duration_ms,
      status: s.status,
      pool: s.pool,
      tags: Object.assign({}, s.tags),
    };
  }

  /* ---------------- start ---------------- */

  /**
   * Завести span.
   * @param {string|object} spec
   *        строка — имя span'а; объект — {name, parent|parentId, traceId, pool,
   *        tags, start, id, depth?}
   * @param {string|object} [parent] id или объект родителя (альтернатива spec.parent)
   * @returns {object} span (публичная запись, содержит .id, .depth, ...)
   */
  function start(spec, parent) {
    let s = null;
    if (isNonEmptyString(spec)) {
      s = { name: spec };
    } else if (isPlainObject(spec)) {
      s = spec;
    } else {
      throw new TypeError('start: spec must be a non-empty string or an object');
    }

    const name = s.name;
    if (!isNonEmptyString(name)) {
      throw new TypeError('start: name must be a non-empty string');
    }

    // родитель: spec.parent | spec.parentId | второй аргумент
    let parentRef = null;
    if (s.parent != null) parentRef = s.parent;
    else if (s.parentId != null) parentRef = s.parentId;
    if (parentRef == null && parent != null) parentRef = parent;

    let parentSpan = null;
    if (parentRef != null) {
      parentSpan = requireSpanOrId(parentRef, 'start');
    }

    const depth = parentSpan == null ? 1 : parentSpan.depth + 1;
    if (depth > maxDepth) {
      throw new RangeError(
        'start: max nesting depth exceeded (depth=' + depth + ', max=' + maxDepth + ')'
      );
    }

    // id
    let id;
    if (s.id != null) {
      if (typeof s.id !== 'string' || !HEX_ID_RE.test(s.id)) {
        throw new TypeError('start: explicit id must match ' + HEX_ID_RE);
      }
      if (store.has(s.id)) throw new Error('start: duplicate span id "' + s.id + '"');
      id = s.id;
    } else {
      id = idGen();
      if (typeof id !== 'string' || !HEX_ID_RE.test(id)) {
        throw new TypeError('start: idGen() must return 16 hex chars, got "' + String(id) + '"');
      }
      if (store.has(id)) throw new Error('start: duplicate span id "' + id + '"');
    }

    // traceId
    let traceId = s.traceId != null ? s.traceId : parentSpan == null ? id : parentSpan.traceId;
    if (typeof traceId !== 'string' || !TRACE_ID_RE.test(traceId)) {
      throw new TypeError('start: traceId must match ' + TRACE_ID_RE);
    }
    if (traceId !== id && !roots.has(traceId)) {
      throw new Error('start: unknown traceId "' + traceId + '"');
    }

    // время старта
    const at = s.start == null ? now() : s.start;
    if (!isFiniteNumber(at)) throw new TypeError('start: start must be a finite number');

    const tags = isPlainObject(s.tags) ? Object.assign({}, s.tags) : {};

    const span = {
      id,
      traceId,
      parentId: parentSpan == null ? null : parentSpan.id,
      name,
      depth,
      start_ms: at,
      end_ms: null,
      duration_ms: null,
      status: STATUS_OPEN,
      pool: s.pool == null ? (parentSpan == null ? null : parentSpan.pool) : s.pool,
      tags,
      childIds: [],
    };
    store.set(id, span);
    if (parentSpan == null) roots.set(traceId, id);
    else parentSpan.childIds.push(id);

    return publicRecord(span);
  }

  /* ---------------- end ---------------- */

  /**
   * Закрыть span.
   * @param {string|object} spanOrId id, span-объект или {id}
   * @param {object|number} [o] {end|end_ms} либо число (время конца)
   * @returns {object} закрытая публичная запись
   */
  function end(spanOrId, o) {
    const span = requireSpanOrId(spanOrId, 'end');
    if (span.status === STATUS_CLOSED) {
      throw new Error('end: span "' + span.id + '" already ended');
    }

    let at;
    if (isFiniteNumber(o)) at = o;
    else if (isPlainObject(o) && isFiniteNumber(o.end)) at = o.end;
    else if (isPlainObject(o) && isFiniteNumber(o.end_ms)) at = o.end_ms;
    else at = now();

    if (!isFiniteNumber(at)) throw new TypeError('end: end time must be a finite number');
    if (at < span.start_ms) {
      throw new Error('end: end time before start time for span "' + span.id + '"');
    }

    span.end_ms = at;
    span.duration_ms = at - span.start_ms;
    span.status = STATUS_CLOSED;
    return publicRecord(span);
  }

  /* ---------------- flatten / выборки ---------------- */

  /**
   * ПЛОСКИЙ список span'ов (без children!), по умолчанию — по времени старта.
   * @param {object} [flattenOpts]
   * @param {'start'|'duration'|'depth'|'name'} [flattenOpts.sort]
   * @param {string} [flattenOpts.traceId]  только этот трейс
   * @param {boolean} [flattenOpts.closedOnly] только закрытые
   * @returns {object[]}
   */
  function flatten(flattenOpts) {
    const f = isPlainObject(flattenOpts) ? flattenOpts : {};
    const sort = f.sort == null ? 'start' : f.sort;
    if (SORTS.indexOf(sort) < 0) {
      throw new RangeError('flatten: sort must be one of ' + SORTS.join('/'));
    }

    let list = [];
    for (const s of store.values()) {
      if (f.traceId != null && s.traceId !== f.traceId) continue;
      if (f.closedOnly === true && s.status !== STATUS_CLOSED) continue;
      list.push(publicRecord(s));
    }

    if (sort === 'start') list.sort(cmpByStart);
    else if (sort === 'duration') {
      list.sort((a, b) => {
        const da = a.duration_ms == null ? Infinity : a.duration_ms;
        const db = b.duration_ms == null ? Infinity : b.duration_ms;
        if (da !== db) return da - db;
        return cmpByStart(a, b);
      });
    } else if (sort === 'depth') {
      list.sort((a, b) => a.depth - b.depth || cmpByStart(a, b));
    } else if (sort === 'name') {
      list.sort((a, b) => cmpStrings(a.name, b.name) || cmpByStart(a, b));
    }
    return list;
  }

  function spans() {
    return flatten({ sort: 'start' });
  }

  function open() {
    return spans().filter((r) => r.status === STATUS_OPEN);
  }

  /** @returns {object|null} */
  function getSpan(id) {
    const s = typeof id === 'string' ? store.get(id) : null;
    return s ? publicRecord(s) : null;
  }

  function spansOfTrace(traceId) {
    if (typeof traceId !== 'string' || !TRACE_ID_RE.test(traceId)) {
      throw new TypeError('spansOfTrace: traceId must match ' + TRACE_ID_RE);
    }
    let root = null;
    for (const s of store.values()) {
      if (s.id === roots.get(traceId)) { root = s; break; }
    }
    if (!root) return [];
    const out = [];
    const stack = [root.id];
    while (stack.length) {
      const sid = stack.shift();
      const s = store.get(sid);
      if (!s) continue;
      out.push(publicRecord(s));
      for (const cid of s.childIds) stack.push(cid);
    }
    return out;
  }

  /** Сводка по каждому трейсу (гонке пула): размеры, длительность, глубина. */
  function traces() {
    const summaries = [];
    for (const [traceId, rootId] of roots) {
      const root = store.get(rootId);
      if (!root) continue;
      const all = spansOfTrace(traceId);
      const closed = all.filter((r) => r.status === STATUS_CLOSED);
      const durations = closed.map((r) => r.duration_ms);
      summaries.push({
        traceId,
        pool: root.pool,
        name: root.name,
        count: all.length,
        closed: closed.length,
        open: all.length - closed.length,
        max_depth: all.reduce((m, r) => (r.depth > m ? r.depth : m), 0),
        duration_ms: root.status === STATUS_CLOSED ? root.duration_ms : null,
        sum_ms: durations.reduce((a, b) => a + b, 0),
      });
    }
    summaries.sort((a, b) => cmpStrings(a.traceId, b.traceId));
    return summaries;
  }

  /** Агрегированная статистика по закрытым span'ам. */
  function stats() {
    const all = spans();
    const closed = all.filter((r) => r.status === STATUS_CLOSED);
    const durs = closed.map((r) => r.duration_ms).sort((a, b) => a - b);
    const sum = durs.reduce((a, b) => a + b, 0);
    return {
      count: all.length,
      closed: closed.length,
      open: all.length - closed.length,
      traces: roots.size,
      min_ms: durs.length ? durs[0] : null,
      max_ms: durs.length ? durs[durs.length - 1] : null,
      sum_ms: sum,
      avg_ms: durs.length ? sum / durs.length : null,
      p50_ms: percentile(durs, 50),
      p90_ms: percentile(durs, 90),
      p95_ms: percentile(durs, 95),
      p99_ms: percentile(durs, 99),
      durations: durs,
    };
  }

  function reset() {
    store.clear();
    roots.clear();
  }

  return {
    start,
    end,
    flatten,
    spans,
    open,
    getSpan,
    span: getSpan,
    spansOfTrace,
    traces,
    stats,
    reset,
    now,
    idGen,
    maxDepth,
    size: () => store.size,
  };
}

/* ------------------------------------------------------------------------- *
 * Singleton по умолчанию
 * ------------------------------------------------------------------------- */

const _default = createTracer();

module.exports = {
  // API-методы singleton'а
  start: _default.start,
  end: _default.end,
  flatten: _default.flatten,
  spans: _default.spans,
  open: _default.open,
  getSpan: _default.getSpan,
  span: _default.getSpan,
  spansOfTrace: _default.spansOfTrace,
  traces: _default.traces,
  stats: _default.stats,
  reset: _default.reset,

  // фабрика / утилиты / константы
  createTracer,
  randomHex16,
  percentile,
  p95,
  MAX_DEPTH,
  HEX_ID_RE,
  TRACE_ID_RE,
  SORTS,
  STATUS_OPEN,
  STATUS_CLOSED,
};
