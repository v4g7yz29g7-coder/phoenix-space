'use strict';

/**
 * analytics/tracker.js
 * ============================================================
 * Простой трекер событий для проекта PHOENIX (Node.js / CommonJS).
 *
 * Публичный API (module.exports):
 *
 *   track(name, props)  -> записывает событие в memory/analytics_events.jsonl
 *                          (append, по одной JSON-строке на событие).
 *   getStats()          -> агрегаты по типам событий (по всему журналу).
 *   report(options?)    -> печатает console-summary и возвращает те же агрегаты.
 *
 * Дополнительно экспортируются утилиты (reset, _readEvents, _paths),
 * но обязательный контракт — ровно { track, getStats, report }.
 *
 * Формат строки журнала (JSONL):
 *   {"ts":"2026-09-15T20:19:40.366Z","name":"page_view","props":{"page":"/"}}
 *
 * Модуль не имеет внешних зависимостей. Запись синхронная и "безопасная":
 * ошибки ввода/диска не роняют вызывающий код (кроме невалидного имени
 * события, которое считается программной ошибкой вызывающего).
 *
 * Путь к журналу переопределяется переменной окружения ANALYTICS_FILE —
 * это удобно для smoke-тестов, чтобы не портить боевой журнал.
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

/** Корень проекта: файл лежит в analytics/, журнал — в memory/. */
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Каталог агрегированных событий. */
const MEMORY_DIR = path.join(PROJECT_ROOT, 'memory');

/** Полный путь до журнала событий по умолчанию. */
const EVENTS_FILE = path.join(MEMORY_DIR, 'analytics_events.jsonl');

/** Максимальная длина значения строкового свойства (защита от мусора). */
const MAX_PROP_STRING = 512;

/** Максимальное количество ключей props, которое сохраняем. */
const MAX_PROP_KEYS = 50;

/** Максимальная длина имени события. */
const MAX_NAME_LENGTH = 128;

/**
 * Возвращает путь к журналу с учётом ANALYTICS_FILE (лениво, для тестов).
 * @returns {string}
 */
function resolveEventsFile() {
  const override = process.env.ANALYTICS_FILE;
  if (typeof override === 'string' && override.trim().length > 0) {
    return path.resolve(override);
  }
  return EVENTS_FILE;
}

/**
 * Приводит произвольную метку времени к ISO-строке.
 * Понимает ISO-строки, epoch-ms (число) и null/undefined.
 * @param {*} value
 * @returns {string|null}
 */
function toIso(value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

/**
 * Валидирует и нормализует имя события.
 * Пустое/нестроковое имя — программная ошибка, бросаем TypeError.
 * @param {*} name
 * @returns {string}
 */
function normalizeName(name) {
  if (typeof name !== 'string') {
    throw new TypeError('track(name, props): name must be a non-empty string');
  }
  const str = name.trim();
  if (!str) {
    throw new TypeError('track(name, props): name must be a non-empty string');
  }
  return str.slice(0, MAX_NAME_LENGTH);
}

/**
 * Аккуратно сериализует props: обрезает строки, лимитирует ключи,
 * защищается от cyclic-структур, функций и символов.
 * @param {*} props
 * @returns {Object}
 */
function normalizeProps(props) {
  if (props === null || props === undefined) return {};
  if (Array.isArray(props)) {
    return { _array: props.slice(0, MAX_PROP_KEYS) };
  }
  if (typeof props !== 'object') {
    return { value: String(props).slice(0, MAX_PROP_STRING) };
  }

  const out = {};
  const keys = Object.keys(props).slice(0, MAX_PROP_KEYS);
  for (const key of keys) {
    const value = props[key];
    const t = typeof value;
    if (value === null || t === 'number' || t === 'boolean') {
      out[key] = value;
    } else if (t === 'string') {
      out[key] = value.slice(0, MAX_PROP_STRING);
    } else if (t === 'bigint') {
      out[key] = value.toString();
    } else if (t === 'function' || t === 'symbol') {
      out[key] = '[' + t + ']';
    } else {
      // object / array — пробуем JSON, при неудаче помечаем.
      try {
        const json = JSON.stringify(value);
        out[key] = json === undefined ? '[object]' : json.slice(0, MAX_PROP_STRING);
      } catch (_err) {
        out[key] = '[unserializable]';
      }
    }
  }
  return out;
}

/**
 * Гарантирует существование каталога.
 * @param {string} dir
 * @returns {boolean}
 */
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return true;
    console.error('[tracker] cannot create dir:', err && err.message);
    return false;
  }
}

/**
 * Записывает событие в журнал (append, синхронно).
 *
 * @param {string} name  имя события, например 'page_view'
 * @param {Object} [props] произвольные свойства события
 * @returns {{ok:boolean, ts:string, name:string, props:Object, error?:string}}
 */
function track(name, props) {
  const event = {
    ts: new Date().toISOString(),
    name: normalizeName(name),
    props: normalizeProps(props),
  };

  const file = resolveEventsFile();

  try {
    if (!ensureDir(path.dirname(file))) {
      return { ok: false, ts: event.ts, name: event.name, props: event.props, error: 'no dir' };
    }
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf8');
    return { ok: true, ts: event.ts, name: event.name, props: event.props };
  } catch (err) {
    console.error('[tracker] write failed:', err && err.message);
    return { ok: false, ts: event.ts, name: event.name, props: event.props, error: err && err.message };
  }
}

/**
 * Читает журнал и возвращает массив распарсенных событий.
 * Битые строки молча пропускаются. Понимает старые записи, где время
 * хранилось как tsMs/iso — они нормализуются к ISO.
 * @returns {Array<{ts:(string|null),name:string,props:Object}>}
 */
function readEvents() {
  const events = [];
  const file = resolveEventsFile();
  if (!fs.existsSync(file)) return events;

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error('[tracker] read failed:', err && err.message);
    return events;
  }

  const lines = raw.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && parsed.name) {
        events.push({
          ts: toIso(parsed.ts) || toIso(parsed.iso) || toIso(parsed.tsMs) || null,
          name: String(parsed.name),
          props: parsed.props && typeof parsed.props === 'object' ? parsed.props : {},
        });
      }
    } catch (_err) {
      // пропускаем повреждённую строку
    }
  }
  return events;
}

/**
 * Собирает агрегаты по типам событий.
 *
 * @returns {{
 *   total:number,
 *   uniqueEvents:number,
 *   firstTs:(string|null),
 *   lastTs:(string|null),
 *   byName:Object,
 *   byEvent:Object,
 *   eventList:Array<{name:string,count:number,first:(string|null),last:(string|null)}>,
 *   topEvents:Array<{name:string,count:number}>
 * }}
 */
function getStats() {
  const events = readEvents();
  const byName = {};
  let firstTs = null;
  let lastTs = null;

  for (const ev of events) {
    const name = ev.name || 'unknown';
    if (!byName[name]) {
      byName[name] = { count: 0, first: ev.ts || null, last: ev.ts || null, props: {} };
    }
    const bucket = byName[name];
    bucket.count += 1;

    if (ev.ts && (!bucket.first || ev.ts < bucket.first)) bucket.first = ev.ts;
    if (ev.ts && (!bucket.last || ev.ts > bucket.last)) bucket.last = ev.ts;
    if (ev.ts && (!firstTs || ev.ts < firstTs)) firstTs = ev.ts;
    if (ev.ts && (!lastTs || ev.ts > lastTs)) lastTs = ev.ts;

    // Считаем частоты скалярных значений props по ключам.
    for (const key of Object.keys(ev.props)) {
      const value = ev.props[key];
      const valueType = typeof value;
      if (value === null || valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
        if (!bucket.props[key]) bucket.props[key] = {};
        const label = String(value);
        bucket.props[key][label] = (bucket.props[key][label] || 0) + 1;
      }
    }
  }

  const eventList = Object.keys(byName)
    .map(function (name) {
      return {
        name: name,
        count: byName[name].count,
        first: byName[name].first,
        last: byName[name].last,
      };
    })
    .sort(function (a, b) {
      return b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });

  const topEvents = eventList.map(function (item) {
    return { name: item.name, count: item.count };
  });

  return {
    total: events.length,
    uniqueEvents: Object.keys(byName).length,
    firstTs: firstTs,
    lastTs: lastTs,
    byName: byName,
    // Псевдоним byEvent для обратной совместимости с dashboard/потребителями.
    byEvent: byName,
    eventList: eventList,
    topEvents: topEvents,
  };
}

/**
 * Печатает console-summary по агрегатам и возвращает сами агрегаты.
 *
 * @param {{log?:function(string):void, limit?:number}} [options]
 *        log   — функция вывода (по умолчанию console.log);
 *        limit — сколько типов событий показать (по умолчанию 20).
 * @returns {ReturnType<typeof getStats>}
 */
function report(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const log = typeof opts.log === 'function' ? opts.log : console.log.bind(console);
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 20;

  const stats = getStats();
  const line = '-'.repeat(60);

  log(line);
  log('  ANALYTICS REPORT  (memory/analytics_events.jsonl)');
  log(line);
  log('  total       : ' + stats.total);
  log('  unique types: ' + stats.uniqueEvents);
  log('  first event : ' + (stats.firstTs || 'n/a'));
  log('  last event  : ' + (stats.lastTs || 'n/a'));

  if (stats.eventList.length === 0) {
    log('  (no events recorded yet)');
    log(line);
    return stats;
  }

  log(line);
  log('  BY EVENT TYPE');
  log(line);

  let nameWidth = 8;
  for (const item of stats.eventList) {
    if (item.name.length > nameWidth) nameWidth = item.name.length;
  }
  if (nameWidth > 28) nameWidth = 28;

  const shown = stats.eventList.slice(0, limit);
  for (const item of shown) {
    const bucket = stats.byName[item.name];
    log(
      '  ' + item.name.slice(0, nameWidth).padEnd(nameWidth, ' ') +
      '  ' + String(item.count).padStart(6) + '  ' +
      '[' + (item.first || 'n/a') + ' .. ' + (item.last || 'n/a') + ']'
    );

    const propKeys = Object.keys(bucket.props).slice(0, 5);
    for (const key of propKeys) {
      const values = Object.keys(bucket.props[key])
        .sort(function (a, b) {
          return bucket.props[key][b] - bucket.props[key][a];
        })
        .slice(0, 5)
        .map(function (v) {
          return v + '=' + bucket.props[key][v];
        })
        .join(', ');
      log('    - ' + key + ': ' + values);
    }
  }

  if (stats.eventList.length > shown.length) {
    log('  ... and ' + (stats.eventList.length - shown.length) + ' more event type(s)');
  }

  log(line);
  return stats;
}

/**
 * Сбрасывает журнал (осторожно — в основном для smoke-тестов).
 * @returns {boolean}
 */
function reset() {
  try {
    const file = resolveEventsFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (err) {
    console.error('[tracker] reset failed:', err && err.message);
    return false;
  }
}

module.exports = {
  track: track,
  getStats: getStats,
  report: report,
  // необязательные утилиты — не входят в обязательный контракт
  reset: reset,
  _readEvents: readEvents,
  _paths: { MEMORY_DIR: MEMORY_DIR, EVENTS_FILE: EVENTS_FILE, PROJECT_ROOT: PROJECT_ROOT },
};

// Позволяет запускать как CLI: `node analytics/tracker.js report`
if (require.main === module) {
  const cmd = process.argv[2] || 'report';
  if (cmd === 'report') {
    report();
  } else {
    console.log('usage: node analytics/tracker.js [report]');
  }
}
