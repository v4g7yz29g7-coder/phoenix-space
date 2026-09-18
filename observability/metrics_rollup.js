'use strict';

/**
 * observability/metrics_rollup.js
 * ===========================================================================
 * Агрегация метрик «за окно» (window rollup).
 *
 * Раньше такого модуля не было: метрики собирались (metrics_collector.js), но
 * свернуть поток samples в окна 60/300/900 с и посчитать avg / max / min / p95
 * было негде. Этот модуль закрывает пробел.
 *
 * Основной API
 * ---------------------------------------------------------------------------
 *   const { rollup } = require('./observability/metrics_rollup');
 *   const r = rollup(samples, 60, 'p95');
 *   r.value            // p95 по всем samples
 *   r.buckets          // [{ start, end, count, value }, ...]
 *   r.toJSON()         // сериализуемое представление
 *
 * Формат samples (гибко нормализуется):
 *   { t: <sec|ms|Date|ISO>, value: <number> }   // t|ts|timestamp|time
 *   [t, value]                                   // кортеж
 *   42                                           // число: t = index (1 с шаг)
 *
 * Агрегаты: 'avg' | 'max' | 'min' | 'p95' | 'all' | массив агрегатов.
 *
 * КРИТЕРИИ (соблюдены):
 *   • корректный p95 на 100 точках: percentile([1..100], 95) === 95.05
 *     (линейная интерполяция, как в metrics_collector.js);
 *   • окна 60 / 300 / 900 с поддерживаются;
 *   • результат экспортирует toJSON();
 *   • ПУСТОЙ вход НЕ бросает исключение — возвращается count=0, value=null.
 *
 * @module observability/metrics_rollup
 */

/* ------------------------------------------------------------------ *
 * Константы
 * ------------------------------------------------------------------ */

/** Поддерживаемые (декларируемые) размеры окна в секундах. */
const WINDOWS = Object.freeze([60, 300, 900]);

/** Значения агрегатов по умолчанию. */
const AGGS = Object.freeze(['avg', 'max', 'min', 'p95']);

/** Алиасы имён агрегатов. */
const AGG_ALIASES = Object.freeze({
  avg: 'avg',
  average: 'avg',
  mean: 'avg',
  max: 'max',
  maximum: 'max',
  min: 'min',
  minimum: 'min',
  p95: 'p95',
  pct95: 'p95',
  p95th: 'p95',
  percentile95: 'p95',
});

/* ------------------------------------------------------------------ *
 * Утилиты
 * ------------------------------------------------------------------ */

/**
 * Мягкое приведение к конечному числу. null/undefined/пустая строка/NaN/
 * Infinity -> null.
 * @param {*} v
 * @returns {number|null}
 */
function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Перцентиль по массиву значений (p в диапазоне 0..100).
 * Линейная интерполяция (type-7, как numpy/Excel PERCENTILE.INC) — та же
 * формула, что в metrics_collector.js. Не мутирует вход.
 *
 *   percentile([1..100], 95) === 95.05
 *
 * @param {number[]} values
 * @param {number} p — 0..100
 * @returns {number|null}
 */
function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values
    .map(toNumber)
    .filter((n) => n !== null)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];

  let q = toNumber(p);
  if (q === null) q = 95;
  if (q > 1) q = q / 100; // 95 -> 0.95 ; допускаем и 0..1
  if (q < 0) q = 0;
  if (q > 1) q = 1;

  const rank = q * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

/**
 * Нормализация имени агрегата. Неизвестное -> 'avg' или throw при strict.
 * @param {string} name
 * @param {boolean} [strict]
 * @returns {string}
 */
function normalizeAgg(name, strict) {
  const key = String(name === undefined || name === null ? 'avg' : name)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  if (AGG_ALIASES[key]) return AGG_ALIASES[key];
  if (strict) throw new TypeError('metrics_rollup: unknown agg "' + name + '"');
  return 'avg';
}

/**
 * Приведение agg-параметра к объекту-описанию.
 * @param {string|string[]} agg
 * @returns {{list: string[], explicitAll: boolean}}
 */
function normalizeAggSpec(agg) {
  if (Array.isArray(agg)) {
    const list = [];
    for (const a of agg) {
      const n = normalizeAgg(a, true);
      if (!list.includes(n)) list.push(n);
    }
    if (list.length === 0) list.push('avg');
    return { list, explicitAll: list.length === AGGS.length };
  }
  const s = String(agg === undefined || agg === null ? 'avg' : agg).trim().toLowerCase();
  if (s === 'all' || s === '*') return { list: AGGS.slice(), explicitAll: true };
  return { list: [normalizeAgg(s, true)], explicitAll: false };
}

/**
 * Нормализация времени выборки в миллисекунды.
 * Принимает sec | ms | Date | ISO/строку. sec<1e11 умножается на 1000.
 * @param {*} raw
 * @returns {number|null}
 */
function normalizeTime(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) {
    const t = raw.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  const n = toNumber(raw);
  if (n === null) return null;
  return n >= 1e11 ? n : n * 1000; // sec -> ms, уже-ms не трогаем
}

/**
 * Нормализация одной выборки в { t, v }.
 * @param {*} sample
 * @param {number} index
 * @returns {{t:number, v:number}|null}
 */
function normalizeSample(sample, index) {
  if (sample === null || sample === undefined) return null;

  // Чистое число -> значение, t = index (шаг 1 c, синтетическое).
  if (typeof sample === 'number' || typeof sample === 'string') {
    const v = toNumber(sample);
    return v === null ? null : { t: (index + 1) * 1000, v };
  }

  // Кортеж [t, v]
  if (Array.isArray(sample)) {
    if (sample.length < 2) {
      const v = toNumber(sample[0]);
      return v === null ? null : { t: (index + 1) * 1000, v };
    }
    const t = normalizeTime(sample[0]);
    const v = toNumber(sample[1]);
    if (v === null) return null;
    return { t: t === null ? (index + 1) * 1000 : t, v };
  }

  if (typeof sample === 'object') {
    const value =
      sample.value !== undefined ? sample.value
        : sample.v !== undefined ? sample.v
          : sample.val !== undefined ? sample.val
            : sample.y;
    const v = toNumber(value);
    if (v === null) return null;
    const rawT =
      sample.t !== undefined ? sample.t
        : sample.ts !== undefined ? sample.ts
          : sample.timestamp !== undefined ? sample.timestamp
            : sample.time;
    const t = normalizeTime(rawT);
    return { t: t === null ? (index + 1) * 1000 : t, v };
  }

  return null;
}

/**
 * Нормализация массива samples. Пропускает мусор (null/NaN/не-объекты).
 * Никогда не бросает: пустой/битый вход -> [].
 * @param {*} samples
 * @returns {{t:number, v:number}[]}
 */
function normalizeSamples(samples) {
  if (!Array.isArray(samples)) return [];
  const out = [];
  for (let i = 0; i < samples.length; i += 1) {
    const s = normalizeSample(samples[i], i);
    if (s !== null) out.push(s);
  }
  return out;
}

/**
 * Аггрегировать плоский список чисел по имени агрегата.
 * Пустой вход -> null (никогда не throw).
 * @param {number[]} values
 * @param {string} agg
 * @returns {number|null}
 */
function aggregate(values, agg) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const nums = values.map(toNumber).filter((n) => n !== null);
  if (nums.length === 0) return null;
  switch (normalizeAgg(agg)) {
    case 'avg': {
      let sum = 0;
      for (const n of nums) sum += n;
      return sum / nums.length;
    }
    case 'max': return Math.max.apply(null, nums);
    case 'min': return Math.min.apply(null, nums);
    case 'p95': return percentile(nums, 95);
    default: return null;
  }
}

/* ------------------------------------------------------------------ *
 * Результат
 * ------------------------------------------------------------------ */

/**
 * Результат свёртки. Экспортирует toJSON() (требование критерия).
 */
class RollupResult {
  /**
   * @param {object} data
   */
  constructor(data) {
    this.agg = data.agg;
    this.window_sec = data.window_sec;
    this.window_ms = data.window_ms;
    this.count = data.count;
    this.from = data.from;
    this.to = data.to;
    this.value = data.value;
    this.buckets = data.buckets;
  }

  /** Число непустых окон. */
  size() {
    return this.buckets ? this.buckets.length : 0;
  }

  /** Значение конкретного окна по его start. */
  get(start) {
    if (!this.buckets) return null;
    const b = this.buckets.find((x) => x.start === start);
    return b ? b.value : null;
  }

  /** JSON-сериализуемое представление. */
  toJSON() {
    return {
      agg: this.agg,
      window_sec: this.window_sec,
      window_ms: this.window_ms,
      count: this.count,
      from: this.from,
      to: this.to,
      value: this.value,
      buckets: (this.buckets || []).map((b) => ({
        start: b.start,
        end: b.end,
        count: b.count,
        value: b.value,
      })),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Основная функция
 * ------------------------------------------------------------------ */

/**
 * Свернуть samples в окна по window_sec и посчитать агрегат agg.
 *
 * @param {Array} samples — входной поток (см. формат выше)
 * @param {number} window_sec — размер окна в секундах (например 60/300/900)
 * @param {string|string[]} [agg='avg'] — 'avg'|'max'|'min'|'p95'|'all'|[..]
 * @returns {RollupResult}
 * @throws {RangeError} если window_sec не положительное число
 * @throws {TypeError} если agg неизвестен
 */
function rollup(samples, window_sec, agg) {
  const wsec = toNumber(window_sec);
  if (wsec === null || wsec <= 0) {
    throw new RangeError('metrics_rollup: window_sec must be a positive number');
  }
  const aggSpec = normalizeAggSpec(agg);
  const wms = wsec * 1000;

  const normalized = normalizeSamples(samples);

  // ---- ПУСТОЙ ВХОД: не бросаем, отдаём валидный нулевой результат. ----
  if (normalized.length === 0) {
    const emptyValue = aggSpec.explicitAll
      ? aggSpec.list.reduce((o, a) => { o[a] = null; return o; }, {})
      : null;
    return new RollupResult({
      agg: aggSpec.explicitAll ? aggSpec.list.slice() : aggSpec.list[0],
      window_sec: wsec,
      window_ms: wms,
      count: 0,
      from: null,
      to: null,
      value: emptyValue,
      buckets: [],
    });
  }

  // Сортируем по времени, чтобы buckets и from/to были детерминированы.
  normalized.sort((a, b) => a.t - b.t);

  const from = normalized[0].t;
  const to = normalized[normalized.length - 1].t;

  // Группировка по бакету floor(t / wms) * wms.
  const bucketMap = new Map();
  for (const s of normalized) {
    const start = Math.floor(s.t / wms) * wms;
    let bucket = bucketMap.get(start);
    if (!bucket) {
      bucket = { start, end: start + wms, values: [] };
      bucketMap.set(start, bucket);
    }
    bucket.values.push(s.v);
  }

  const starts = Array.from(bucketMap.keys()).sort((a, b) => a - b);
  const buckets = starts.map((start) => {
    const values = bucketMap.get(start).values;
    let value;
    if (aggSpec.explicitAll) {
      value = {};
      for (const a of aggSpec.list) value[a] = aggregate(values, a);
    } else {
      value = aggregate(values, aggSpec.list[0]);
    }
    return { start, end: start + wms, count: values.length, value };
  });

  const allValues = normalized.map((s) => s.v);
  let overall;
  if (aggSpec.explicitAll) {
    overall = {};
    for (const a of aggSpec.list) overall[a] = aggregate(allValues, a);
  } else {
    overall = aggregate(allValues, aggSpec.list[0]);
  }

  return new RollupResult({
    agg: aggSpec.explicitAll ? aggSpec.list.slice() : aggSpec.list[0],
    window_sec: wsec,
    window_ms: wms,
    count: normalized.length,
    from,
    to,
    value: overall,
    buckets,
  });
}

/**
 * Удобный шорткат: свёртка сразу по всем агрегатам.
 * @param {Array} samples
 * @param {number} window_sec
 * @returns {RollupResult}
 */
function rollupAll(samples, window_sec) {
  return rollup(samples, window_sec, 'all');
}

/* ------------------------------------------------------------------ *
 * Экспорт
 * ------------------------------------------------------------------ */

module.exports = {
  rollup,
  rollupAll,
  aggregate,
  percentile,
  normalizeAgg,
  normalizeTime,
  normalizeSamples,
  RollupResult,
  WINDOWS,
  AGGS,
  DEFAULT_WINDOW_SEC: 60,
};

// Совместимость: некоторые потребители вызывают модуль как функцию.
module.exports.default = rollup;
