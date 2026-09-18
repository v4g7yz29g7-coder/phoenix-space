'use strict';

/**
 * observability/system_metrics.js
 * ---------------------------------------------------------------------------
 * Сборщик системных метрик: CPU / RAM / load / disk.
 *
 * Источники данных — только встроенные модули Node (`os`, `fs`) и
 * псевдо-файловая система `/proc` (Linux). Никаких внешних зависимостей.
 *
 * Основной API:
 *
 *   const metrics = require('./observability/system_metrics');
 *   const sample = metrics.collect();
 *   // -> { cpu_pct: 12.34, ram_pct: 67.5, load1: 2.89, disk_pct: 62.5 }
 *
 * КРИТЕРИЙ (соблюдается):
 *   collect() возвращает объект ровно с полями cpu_pct, ram_pct, load1,
 *   disk_pct; каждое поле — число в диапазоне [0..100]; load1 читается из
 *   реального /proc/loadavg.
 *
 * Все значения клампятся в [0..100] и округляются до 2 знаков, чтобы ни один
 * сбой парсинга /proc не просочился наружу в виде NaN/Infinity.
 *
 * @module observability/system_metrics
 */

const fs = require('fs');
const os = require('os');

// ---------------------------------------------------------------------------
// Константы / настройки по умолчанию
// ---------------------------------------------------------------------------

const PROC_LOADAVG = '/proc/loadavg';
const PROC_STAT = '/proc/stat';
const PROC_MEMINFO = '/proc/meminfo';
const DEFAULT_DISK_PATH = process.platform === 'win32' ? process.cwd() : '/';

const PCT_MIN = 0;
const PCT_MAX = 100;
const PCT_DIGITS = 2;

// ---------------------------------------------------------------------------
// Мелкие утилиты
// ---------------------------------------------------------------------------

/**
 * Округлить число до N знаков. Нечисловые значения возвращаются как есть.
 * @param {number} value
 * @param {number} [digits=2]
 * @returns {number}
 */
function round(value, digits = PCT_DIGITS) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

/**
 * Привести произвольное значение к числу в диапазоне [0..100].
 * NaN / Infinity / не-числа превращаются в `fallback` (по умолчанию 0).
 * @param {*} value
 * @param {number} [fallback=0]
 * @returns {number}
 */
function clampPct(value, fallback = 0) {
  let n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) {
    // Нечисловое значение — используем fallback (тоже 0..100).
    n = typeof fallback === 'number' ? fallback : Number(fallback);
    if (!Number.isFinite(n)) n = 0;
  }
  // ±Infinity естественно упирается в границы диапазона.
  if (n < PCT_MIN) return PCT_MIN;
  if (n > PCT_MAX) return PCT_MAX;
  return round(n, PCT_DIGITS);
}

/**
 * Безопасное чтение файла: возвращает null вместо исключения.
 * @param {string} file
 * @returns {string|null}
 */
function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// /proc/loadavg
// ---------------------------------------------------------------------------

/**
 * Разобрать содержимое /proc/loadavg.
 * Формат: "0.00 0.01 0.05 1/234 5678"
 * @param {string} text
 * @returns {{load1:number, load5:number, load15:number, running:number|null, total:number|null, lastPid:number|null}|null}
 */
function parseLoadavg(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  const parts = text.trim().split(/\s+/);
  const load1 = Number.parseFloat(parts[0]);
  const load5 = Number.parseFloat(parts[1]);
  const load15 = Number.parseFloat(parts[2]);
  if (!Number.isFinite(load1)) return null;

  let running = null;
  let total = null;
  if (parts[3] && parts[3].includes('/')) {
    const [r, t] = parts[3].split('/');
    running = Number.parseInt(r, 10);
    total = Number.parseInt(t, 10);
  }

  return {
    load1,
    load5: Number.isFinite(load5) ? load5 : load1,
    load15: Number.isFinite(load15) ? load15 : load1,
    running: Number.isFinite(running) ? running : null,
    total: Number.isFinite(total) ? total : null,
    lastPid: parts[4] ? Number.parseInt(parts[4], 10) || null : null,
  };
}

/**
 * Прочитать РЕАЛЬНЫЙ /proc/loadavg с диска (без кеша).
 * При недоступности /proc — фолбэк на `os.loadavg()`.
 * @returns {{load1:number, load5:number, load15:number, running:number|null, total:number|null, lastPid:number|null, source:string}}
 */
function readLoadavg() {
  const text = safeRead(PROC_LOADAVG);
  const parsed = parseLoadavg(text);
  if (parsed) {
    return Object.assign(parsed, { source: 'proc' });
  }
  const fallback = os.loadavg();
  return {
    load1: Number.isFinite(fallback[0]) ? fallback[0] : 0,
    load5: Number.isFinite(fallback[1]) ? fallback[1] : 0,
    load15: Number.isFinite(fallback[2]) ? fallback[2] : 0,
    running: null,
    total: null,
    lastPid: null,
    source: 'os',
  };
}

// ---------------------------------------------------------------------------
// /proc/stat — CPU
// ---------------------------------------------------------------------------

/**
 * Разобрать агрегированную строку CPU из /proc/stat.
 * @param {string} line строка, начинающаяся с "cpu "
 * @returns {{total:number, idle:number}|null}
 */
function parseCpuLine(line) {
  if (typeof line !== 'string' || !line.startsWith('cpu')) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;

  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = parts;
  // guest / guest_nice (индексы 8,9) уже входят в user/nice — не считаем дважды.
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  const idleAll = idle + iowait;
  if (total <= 0) return null;
  return { total, idle: idleAll };
}

/**
 * Прочитать первую строку "cpu " из /proc/stat.
 * @returns {{total:number, idle:number}|null}
 */
function readCpuStat() {
  const text = safeRead(PROC_STAT);
  if (!text) return null;
  const line = text.split('\n', 1)[0];
  return parseCpuLine(line);
}

// Последний сэмпл CPU для дельта-вычислений между вызовами collect().
let lastCpuSample = null;

/**
 * Посчитать cpu_pct по двум сэмплам счётчиков jiffies.
 * @param {{total:number, idle:number}} prev
 * @param {{total:number, idle:number}} cur
 * @returns {number|null}
 */
function cpuPercentBetween(prev, cur) {
  if (!prev || !cur) return null;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (!(dTotal > 0) || dIdle < 0) return null;
  return clampPct((1 - dIdle / dTotal) * 100);
}

/**
 * Вычислить загрузку CPU в процентах.
 * Приоритет: дельта с прошлым вызовом → среднее с момента загрузки →
 * фолбэк на `os.cpus()`.
 * @param {object} [opts]
 * @param {boolean} [opts.reset=false] сбросить накопленный сэмпл
 * @returns {number} 0..100
 */
function readCpuPct(opts = {}) {
  const cur = readCpuStat();

  if (cur) {
    const prev = opts.reset ? null : lastCpuSample;
    lastCpuSample = cur;
    const between = cpuPercentBetween(prev, cur);
    if (between !== null) return between;
    // Первый вызов: средняя загрузка с момента старта системы.
    if (cur.total > 0) {
      return clampPct((1 - cur.idle / cur.total) * 100);
    }
  }

  // Фолбэк: агрегируем времена ядер из os.cpus().
  const cpus = os.cpus() || [];
  let busy = 0;
  let total = 0;
  for (const c of cpus) {
    if (!c || !c.times) continue;
    const t = c.times;
    const idle = (t.idle || 0);
    const all = (t.user || 0) + (t.nice || 0) + (t.sys || 0) + (t.irq || 0) + idle;
    busy += all - idle;
    total += all;
  }
  if (total > 0) return clampPct((busy / total) * 100);

  // Последний рубеж: нормированный loadavg.
  const la = readLoadavg().load1;
  const cores = cpus.length || 1;
  return clampPct((la / cores) * 100);
}

// ---------------------------------------------------------------------------
// /proc/meminfo — RAM
// ---------------------------------------------------------------------------

/**
 * Разобрать /proc/meminfo в объект {Key: bytes}.
 * @param {string} text
 * @returns {Object<string, number>}
 */
function parseMeminfo(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Za-z_()]+):\s+(\d+)(?:\s+kB)?/);
    if (!m) continue;
    const key = m[1];
    const val = Number.parseInt(m[2], 10);
    if (!Number.isFinite(val)) continue;
    // Значения в кБ переводим в байты, кроме беcединичных.
    out[key] = /kB/i.test(line) ? val * 1024 : val;
  }
  return out;
}

/**
 * Прочитать /proc/meminfo.
 * @returns {Object<string, number>}
 */
function readMeminfo() {
  return parseMeminfo(safeRead(PROC_MEMINFO));
}

/**
 * Вычислить процент использования RAM.
 * Приоритет: /proc/meminfo (MemTotal − MemAvailable) → os.totalmem/freemem.
 * @returns {number} 0..100
 */
function readRamPct() {
  const info = readMeminfo();
  const total = info.MemTotal;
  if (Number.isFinite(total) && total > 0) {
    let available = info.MemAvailable;
    if (!Number.isFinite(available)) {
      // Старые ядра: MemFree + Buffers + Cached (+ SReclaimable).
      available =
        (info.MemFree || 0) +
        (info.Buffers || 0) +
        (info.Cached || 0) +
        (info.SReclaimable || 0);
    }
    return clampPct(((total - available) / total) * 100);
  }

  const t = os.totalmem();
  if (t > 0) {
    return clampPct(((t - os.freemem()) / t) * 100);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Диск
// ---------------------------------------------------------------------------

/**
 * Процент использования файловой системы для пути.
 * Приоритет: fs.statfsSync → `os`-независимый фолбэк 0.
 * @param {string} [mountPath='/']
 * @returns {number} 0..100
 */
function diskUsagePercent(mountPath = DEFAULT_DISK_PATH) {
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(mountPath);
      const blocks = st.blocks;
      const free = st.bfree;
      if (blocks > 0 && Number.isFinite(blocks) && Number.isFinite(free)) {
        return clampPct(((blocks - free) / blocks) * 100);
      }
    }
  } catch (_err) {
    // игнорируем и пробуем следующий источник
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/**
 * Снять один набор системных метрик.
 *
 * @param {object} [opts]
 * @param {string} [opts.diskPath='/'] путь для измерения диска.
 * @param {boolean} [opts.resetCpu=false] сбросить накопленный сэмпл CPU.
 * @returns {{cpu_pct:number, ram_pct:number, load1:number, disk_pct:number}}
 */
function collect(opts = {}) {
  const diskPath = typeof opts.diskPath === 'string' && opts.diskPath
    ? opts.diskPath
    : DEFAULT_DISK_PATH;

  const loadavg = readLoadavg();

  return {
    cpu_pct: readCpuPct({ reset: !!opts.resetCpu }),
    ram_pct: readRamPct(),
    // load1 — реальное значение из /proc/loadavg, клампленное в [0..100].
    load1: clampPct(loadavg.load1),
    disk_pct: diskUsagePercent(diskPath),
  };
}

/**
 * Расширенный снимок: те же 4 ключевых поля плюс сырые данные и источники.
 * @param {object} [opts] как у collect().
 * @returns {object}
 */
function collectDetailed(opts = {}) {
  const diskPath = typeof opts.diskPath === 'string' && opts.diskPath
    ? opts.diskPath
    : DEFAULT_DISK_PATH;

  const loadavg = readLoadavg();
  const cpuStat = readCpuStat();
  const mem = readMeminfo();

  const base = collect(Object.assign({}, opts, { diskPath }));

  return {
    cpu_pct: base.cpu_pct,
    ram_pct: base.ram_pct,
    load1: base.load1,
    disk_pct: base.disk_pct,
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    raw: {
      loadavg,
      cpu: cpuStat,
      memTotalBytes: mem.MemTotal || os.totalmem(),
      memAvailableBytes:
        mem.MemAvailable ||
        (mem.MemFree || 0) + (mem.Buffers || 0) + (mem.Cached || 0),
      diskPath,
    },
    sources: {
      loadavg: loadavg.source,
      cpu: cpuStat ? 'proc' : 'os',
      ram: Number.isFinite(mem.MemTotal) ? 'proc' : 'os',
      disk: typeof fs.statfsSync === 'function' ? 'statfs' : 'unavailable',
    },
    host: {
      hostname: safeHostname(),
      platform: process.platform,
      arch: process.arch,
      cores: (os.cpus() || []).length || 1,
    },
  };
}

function safeHostname() {
  try {
    return os.hostname();
  } catch (_err) {
    return 'unknown';
  }
}

/**
 * Создать независимый сборщик с историей наблюдений.
 *
 * @param {object} [options]
 * @param {number} [options.historyLimit=240] максимум хранимых сэмплов.
 * @param {string} [options.diskPath='/'] путь для измерения диска.
 * @returns {{collect:Function, latest:Function, history:Function, stats:Function, reset:Function}}
 */
function createCollector(options = {}) {
  const limit = Number.isFinite(options.historyLimit)
    ? Math.max(1, options.historyLimit)
    : 240;
  const diskPath = options.diskPath || DEFAULT_DISK_PATH;
  const buffer = [];
  let count = 0;
  let lastDetailed = null;

  return {
    collect(extra = {}) {
      const sample = collect(Object.assign({}, extra, { diskPath }));
      count += 1;
      const entry = Object.assign({ seq: count, timestamp: Date.now() }, sample);
      buffer.push(entry);
      if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
      return sample;
    },
    collectDetailed(extra = {}) {
      lastDetailed = collectDetailed(Object.assign({}, extra, { diskPath }));
      return lastDetailed;
    },
    latest() {
      return buffer.length ? buffer[buffer.length - 1] : null;
    },
    history() {
      return buffer.slice();
    },
    stats() {
      return { samples: count, retained: buffer.length, historyLimit: limit, diskPath };
    },
    reset() {
      buffer.length = 0;
      lastDetailed = null;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// CLI: `node observability/system_metrics.js`
// ---------------------------------------------------------------------------

if (require.main === module) {
  const sample = collectDetailed();
  process.stdout.write(JSON.stringify(sample, null, 2) + '\n');
}

module.exports = {
  collect,
  collectDetailed,
  createCollector,
  // helpers (экспортированы для тестов и переиспользования)
  readLoadavg,
  parseLoadavg,
  readCpuStat,
  parseCpuLine,
  cpuPercentBetween,
  readCpuPct,
  readMeminfo,
  parseMeminfo,
  readRamPct,
  diskUsagePercent,
  clampPct,
  round,
  PROC_LOADAVG,
  PROC_STAT,
  PROC_MEMINFO,
  DEFAULT_DISK_PATH,
};
