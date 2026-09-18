'use strict';
/**
 * metrics_collector.js
 * --------------------
 * Сбор системных метрик (CPU, RAM, load average, диск) каждые 5 секунд
 * с записью в ring-buffer на 720 точек (1 час при интервале 5s).
 *
 * Только стандартная библиотека Node.js — без внешних зависимостей.
 *
 * API:
 *   collect([snap])      -> snapshot                 замер -> буфер; либо принять внешний снапшот
 *   latest()             -> snapshot | null          последний замер
 *   history(n)           -> snapshot[]               последние n замеров (по возрастанию времени)
 *   percentiles([..])    -> number[]                 перцентили CPU (0..100) для списка перцентилей
 *   percentilesOf(v, p)  -> number[]                 чистый расчёт перцентилей по массиву значений
 *
 * Дополнительно:
 *   start(intervalMs)    запустить автозамер (по умолчанию 5000 мс)
 *   stop()               остановить автозамер
 *   snapshot()           текущее состояние без записи (не трогает буфер)
 *   reset()              очистить ring-buffer и дельта-состояние CPU (для тестов)
 *
 * Размер окна задаётся константой RING_SIZE, её можно переопределить окружением
 * MC_RING_SIZE (например MC_RING_SIZE=60 для окна на 60 точек). По умолчанию 720.
 */

const fs = require('fs');
const os = require('os');

const DEFAULT_RING_SIZE = 720;  // 720 точек * 5s = 3600s = 1 час
const INTERVAL_MS = 5000;       // 5 секунд

// Размер окна (ring-buffer). Переопределяется через MC_RING_SIZE, напр. 60.
const RING_SIZE = (function () {
  const n = parseInt(process.env.MC_RING_SIZE, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RING_SIZE;
})();

// ---------------------------------------------------------------------------
// Парсинг /proc/stat  ->  { idle, total }
// ---------------------------------------------------------------------------
let _prevCpu = null;            // предыдущее суммарное значение для дельты

function readCpuTimes() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const line = stat.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const f = line.trim().split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal guest guest_nice
    const idle = (f[3] || 0) + (f[4] || 0);            // idle + iowait
    const total = f.reduce((a, b) => a + (b || 0), 0);
    return { idle, total };
  } catch (e) {
    return null;
  }
}

function cpuPercent() {
  const now = readCpuTimes();
  if (!now || now.total <= 0) return 0;

  let pct;
  if (_prevCpu) {
    const dTotal = now.total - _prevCpu.total;
    const dIdle = now.idle - _prevCpu.idle;
    pct = dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
  } else {
    // Первый замер — среднее с момента загрузки системы.
    pct = (1 - now.idle / now.total) * 100;
  }
  _prevCpu = now;

  if (!Number.isFinite(pct)) pct = 0;
  return clampPct(pct);
}

// ---------------------------------------------------------------------------
// Парсинг /proc/meminfo  ->  { total, used, free, available, pct }
// ---------------------------------------------------------------------------
function readMem() {
  const res = { total: 0, used: 0, free: 0, available: 0, pct: 0 };
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = txt.match(new RegExp('^' + key + ':\\s+(\\d+)\\s*kB', 'm'));
      return m ? Number(m[1]) * 1024 : 0;         // клик -> байты
    };
    res.total = get('MemTotal');
    res.free = get('MemFree');
    res.available = get('MemAvailable') || res.free;
    res.used = Math.max(0, res.total - res.available);
    res.pct = res.total > 0 ? clampPct((res.used / res.total) * 100) : 0;
  } catch (e) { /* ignore */ }
  return res;
}

// ---------------------------------------------------------------------------
// Диск (/, statfs) — только стандартная библиотека
// ---------------------------------------------------------------------------
function readDisk() {
  const out = { mount: '/', total: 0, used: 0, free: 0, pct: 0 };
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync('/');
      const bsize = st.bsize || st.bsize === 0 ? st.bsize : 1;
      const totalBytes = st.blocks * bsize;
      const freeBytes = st.bfree * bsize;
      const availBytes = (st.bavail != null ? st.bavail : st.bfree) * bsize;
      out.total = totalBytes;
      out.free = availBytes;
      out.used = Math.max(0, totalBytes - freeBytes);
      out.pct = totalBytes > 0 ? clampPct((out.used / totalBytes) * 100) : 0;
    }
  } catch (e) { /* ignore */ }
  return out;
}

/** Конечное число или 0 (null-safe: undefined/NaN/Infinity -> 0). */
function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * null-safe чтение load average: os.loadavg() может бросить исключение или
 * вернуть не-массив/частичный массив — тогда недостающее заменяется на 0,
 * чтобы снимок всегда содержал load = { 1, 5, 15 }.
 */
function safeLoadavg() {
  let raw = null;
  try {
    raw = os.loadavg();
  } catch (e) {
    raw = null;
  }
  if (!Array.isArray(raw)) raw = [];
  return [safeNumber(raw[0]), safeNumber(raw[1]), safeNumber(raw[2])];
}

function clampPct(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

// ---------------------------------------------------------------------------
// Валидация / нормализация внешнего снапшота (collect(snapshot))
// ---------------------------------------------------------------------------
function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Ошибка невалидного снапшота с локализацией "metrics_collector.js:<строка>".
 * Ровно одна ошибка на один вызов collect(invalid) — никаких частичных записей.
 */
function locatedError(reason) {
  const e = new Error(reason);
  e.code = 'MC_INVALID_SNAPSHOT';
  const frames = String(e.stack || '').split('\n');
  let loc = null;
  for (const f of frames) {
    const m = f.match(/metrics_collector\.js:(\d+)/);
    if (m) { loc = 'metrics_collector.js:' + m[1]; break; }
  }
  e.location = loc || 'metrics_collector.js:0';
  e.message = e.location + ': invalid snapshot: ' + reason;
  return e;
}

/** load: number | [a,b,c] | {1,5,15}. null/undefined -> null (не задан). */
function normLoad(v) {
  if (v === undefined || v === null) return null;
  if (isFiniteNum(v)) return { one: v, five: v, fifteen: v, arr: [v, v, v] };
  if (Array.isArray(v)) {
    if (!v.length) throw locatedError('load[] пуст');
    const nums = v.map(function (x) {
      if (!isFiniteNum(x)) throw locatedError('load[] содержит не-число');
      return x;
    });
    const one = nums[0];
    const five = nums.length > 1 ? nums[1] : nums[0];
    const fifteen = nums.length > 2 ? nums[2] : nums[0];
    return { one: one, five: five, fifteen: fifteen, arr: [one, five, fifteen] };
  }
  if (typeof v === 'object') {
    const one = ('1' in v) ? v['1'] : (('one' in v) ? v.one : NaN);
    const five = ('5' in v) ? v['5'] : (('five' in v) ? v.five : NaN);
    const fifteen = ('15' in v) ? v['15'] : (('fifteen' in v) ? v.fifteen : NaN);
    if (!isFiniteNum(one) || !isFiniteNum(five) || !isFiniteNum(fifteen)) {
      throw locatedError('load{} содержит не-число');
    }
    return { one: one, five: five, fifteen: fifteen, arr: [one, five, fifteen] };
  }
  throw locatedError('load имеет недопустимый тип');
}

/** disk: number(pct) | object. null/undefined -> null (не задан). */
function normDisk(v) {
  if (v === undefined || v === null) return null;
  if (isFiniteNum(v)) {
    if (v < 0 || v > 100) throw locatedError('disk pct вне 0..100');
    return { mount: '/', total: 0, used: 0, free: 0, pct: v };
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    const pct = ('pct' in v) ? v.pct : 0;
    if (pct !== undefined && !isFiniteNum(pct)) throw locatedError('disk.pct не число');
    if (isFiniteNum(pct) && (pct < 0 || pct > 100)) throw locatedError('disk.pct вне 0..100');
    return {
      mount: typeof v.mount === 'string' ? v.mount : '/',
      total: isFiniteNum(v.total) ? v.total : 0,
      used: isFiniteNum(v.used) ? v.used : 0,
      free: isFiniteNum(v.free) ? v.free : 0,
      pct: isFiniteNum(pct) ? pct : 0,
    };
  }
  throw locatedError('disk имеет недопустимый тип');
}

/** Нормализует внешний снапшот в канонический вид {ts,cpu,ram,mem,load,loadavg,disk}. */
function normalizeSnapshot(input) {
  const bounded = function (v, lo, hi, name) {
    if (!isFiniteNum(v)) throw locatedError(name + ' должен быть конечным числом');
    if (v < lo || v > hi) throw locatedError(name + ' вне ' + lo + '..' + hi);
    return v;
  };

  const cpu = ('cpu' in input) ? bounded(input.cpu, 0, 100, 'cpu') : 0;
  let ram;
  if ('ram' in input) {
    ram = bounded(input.ram, 0, 100, 'ram');
  } else if (input.mem && isFiniteNum(input.mem.pct)) {
    ram = bounded(input.mem.pct, 0, 100, 'mem.pct');
  } else if (input.mem) {
    ram = 0;
  } else {
    ram = 0;
  }

  const load = normLoad(('load' in input) ? input.load : (('loadavg' in input) ? input.loadavg : null))
    || { one: 0, five: 0, fifteen: 0, arr: [0, 0, 0] };
  const disk = normDisk(('disk' in input) ? input.disk : null)
    || { mount: '/', total: 0, used: 0, free: 0, pct: 0 };

  let ts;
  if ('ts' in input && input.ts !== undefined) {
    if (!isFiniteNum(input.ts)) throw locatedError('ts должен быть конечным числом');
    ts = input.ts;
  } else {
    ts = Date.now();
  }

  return {
    ts: ts,
    cpu: cpu,
    ram: ram,
    mem: { total: 0, used: 0, free: 0, available: 0, pct: ram },
    load: { 1: load.one, 5: load.five, 15: load.fifteen },
    loadavg: load.arr.slice(),
    disk: disk,
  };
}

// ---------------------------------------------------------------------------
// Ring-buffer на RING_SIZE точек
// ---------------------------------------------------------------------------
const _buf = [];                // храним snapshots, хвост — свежие

function push(snap) {
  _buf.push(snap);
  while (_buf.length > RING_SIZE) _buf.shift();
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------
/** Реальный замер /proc + os.loadavg() с записью в буфер. */
function measure() {
  const mem = readMem();
  const disk = readDisk();
  const load = safeLoadavg();
  const snap = {
    ts: Date.now(),
    cpu: cpuPercent(),
    ram: mem.pct,
    mem: {
      total: mem.total,
      used: mem.used,
      free: mem.free,
      available: mem.available,
      pct: mem.pct,
    },
    load: { 1: load[0], 5: load[1], 15: load[2] },
    loadavg: load.slice(),
    disk,
  };
  push(snap);
  return snap;
}

/**
 * collect([snapshot]) -> snapshot
 *   - без аргумента / null / undefined / '' / {}  -> реальный замер (пустой вход не бросает);
 *   - внешний объект-снапшот                      -> валидация, нормализация, запись в буфер;
 *   - невалидный снапшот                           -> РОВНО одна ошибка с локализацией
 *                                                    "metrics_collector.js:<строка>".
 */
function collect(input) {
  if (input === undefined || input === null || input === '') return measure();

  if (typeof input === 'object' && !Array.isArray(input)) {
    if (Object.keys(input).length === 0) return measure(); // пустой объект — тоже пустой вход
    const snap = normalizeSnapshot(input);
    push(snap);
    return snap;
  }

  throw locatedError(
    'snapshot должен быть объектом, получено ' +
      (Array.isArray(input) ? 'array' : typeof input)
  );
}

function latest() {
  return _buf.length ? _buf[_buf.length - 1] : null;
}

/** Очистить ring-buffer и дельта-состояние CPU (для изоляции тестов). */
function reset() {
  _buf.length = 0;
  _prevCpu = null;
  return _buf.length;
}

function history(n) {
  const len = _buf.length;
  if (n === undefined || n === null) return _buf.slice();
  const k = Math.max(0, Math.min(len, n | 0));
  return _buf.slice(len - k);
}

// Линейная интерполяция ("R-7"), отсортированный массив чисел.
function percentileOf(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/** Привести произвольный элемент-источник к числу (number -> сам; snapshot -> .cpu). */
function toCpuNumber(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && isFiniteNum(v.cpu)) return v.cpu;
  return NaN;
}

/**
 * percentilesOf(values, [ps]) -> number[]  ЧИСТЫЙ расчёт перцентилей по массиву.
 * values: массив чисел ИЛИ массив снапшотов (берётся .cpu). Не мутирует вход,
 * нефинитные элементы отбрасываются, пустой вход -> нули (не бросает).
 */
function percentilesOf(values, ps) {
  const listP = Array.isArray(ps) && ps.length ? ps : [50];
  const nums = (Array.isArray(values) ? values : [])
    .map(toCpuNumber)
    .filter(Number.isFinite)
    .sort(function (a, b) { return a - b; });
  return listP.map(function (p) { return percentileOf(nums, p); });
}

/**
 * percentiles([50, 95, 99], [values]) -> number[]  (перцентили CPU, значения 0..100)
 * Без второго аргумента считает по ring-buffer; со вторым — по переданному массиву
 * (чисел или снапшотов). Возвращает массив ровно в порядке списка перцентилей.
 * Дополнительно навешены массивы .cpu/.ram/.load и именованные .p50/.p95/.p99.
 */
function percentiles(ps, values) {
  const listP = Array.isArray(ps) && ps.length ? ps : [50];

  let cpuVals;
  let ramVals;
  let loadVals;

  if (Array.isArray(values) && values.length) {
    const objs = values.filter(function (v) { return v && typeof v === 'object'; });
    if (objs.length === values.length) {
      cpuVals = objs.map(function (s) { return s.cpu; }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
      ramVals = objs.map(function (s) { return s.ram; }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
      loadVals = objs.map(function (s) { return (s && s.load) ? s.load['1'] : NaN; }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    } else {
      cpuVals = values.map(toCpuNumber).filter(Number.isFinite).sort(function (a, b) { return a - b; });
      ramVals = cpuVals.slice();
      loadVals = cpuVals.slice();
    }
  } else {
    cpuVals = _buf.map(function (s) { return (s ? s.cpu : NaN); }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    ramVals = _buf.map(function (s) { return (s ? s.ram : NaN); }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    loadVals = _buf.map(function (s) { return (s && s.load) ? s.load['1'] : NaN; }).filter(Number.isFinite).sort(function (a, b) { return a - b; });
  }

  const cpuOut = listP.map(function (p) { return clampPct(percentileOf(cpuVals, p)); });
  const ramOut = listP.map(function (p) { return clampPct(percentileOf(ramVals, p)); });
  const loadOut = listP.map(function (p) { return percentileOf(loadVals, p); });

  const out = cpuOut.slice();               // primary: CPU, number[]
  out.cpu = cpuOut;
  out.ram = ramOut;
  out.load = loadOut;
  out.percentiles = listP.slice();
  // удобные именованные поля: .p50, .p95, .p99 ...
  listP.forEach(function (p, i) { out['p' + p] = cpuOut[i]; });
  return out;
}

// ---------------------------------------------------------------------------
// Автосбор
// ---------------------------------------------------------------------------
let _timer = null;

function start(intervalMs) {
  if (_timer) return _timer;
  const ms = intervalMs && intervalMs > 0 ? intervalMs : INTERVAL_MS;
  collect();                                  // первый замер сразу
  _timer = setInterval(collect, ms);
  if (_timer.unref) _timer.unref();           // не блокируем выход процесса
  return _timer;
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

function snapshot() {
  // Замер без записи в буфер.
  const mem = readMem();
  const disk = readDisk();
  const load = safeLoadavg();
  return {
    ts: Date.now(),
    cpu: cpuPercent(),
    ram: mem.pct,
    mem: { total: mem.total, used: mem.used, free: mem.free, available: mem.available, pct: mem.pct },
    load: { 1: load[0], 5: load[1], 15: load[2] },
    loadavg: load.slice(),
    disk,
  };
}

const api = {
  collect,
  latest,
  history,
  percentiles,
  percentilesOf,
  snapshot,
  reset,
  start,
  stop,
  RING_SIZE,
  DEFAULT_RING_SIZE,
  INTERVAL_MS,
  size: () => _buf.length,
};

module.exports = api;
module.exports.default = api;

// Автозапуск (можно отключить: MC_NO_AUTOSTART=1)
if (require.main === module) {
  start();
  console.log('metrics_collector: автосбор каждые ' + INTERVAL_MS + ' мс, буфер ' + RING_SIZE + ' точек.');
} else if (!process.env.MC_NO_AUTOSTART) {
  start();
}
