'use strict';

/**
 * sensors/system_metrics.js
 * ============================================================================
 * Host metrics collector for Linux (dependency-free).
 *
 * Data sources (kernel virtual filesystems):
 *   - /proc/stat            -> aggregate + per-core CPU jiffies
 *   - /proc/meminfo         -> MemTotal / MemAvailable / swap / caches
 *   - fs.statfsSync('/')    -> root filesystem capacity (bytes)
 *
 * Public API
 * ----------
 *   getMetrics() -> { cpu: number, ram: number, disk: number }
 *
 *     cpu : CPU utilization percent (0..100) measured as the busy delta
 *           between the previous sample and the current one.
 *     ram : RAM utilization percent (0..100) derived from MemAvailable.
 *     disk: disk usage of the root filesystem in gigabytes (used bytes).
 *
 *   getDetailedMetrics() -> extended snapshot (totals, per-core, load, etc.)
 *
 * The required contract is `{ getMetrics }`; everything else is a bonus used
 * by diagnostics and tests.
 * ============================================================================
 */

const fs = require('fs');
const os = require('os');

const PROC_STAT = '/proc/stat';
const PROC_MEMINFO = '/proc/meminfo';
const DEFAULT_MOUNT = '/';
const BYTES_PER_GB = 1024 * 1024 * 1024;

/* -------------------------------------------------------------------------- *
 * Generic helpers
 * -------------------------------------------------------------------------- */

/** Clamp a number into [min, max]; NaN collapses to `min`. */
function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Round to a fixed number of decimal places. */
function round(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, digits);
  return Math.round(n * factor) / factor;
}

/** Safe numeric coercion with fallback. */
function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Read a file as UTF-8, returning null on any error. */
function readTextSafe(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (_err) {
    return null;
  }
}

/* -------------------------------------------------------------------------- *
 * /proc/stat parsing
 * -------------------------------------------------------------------------- */

/**
 * Parse /proc/stat and return the aggregate CPU line plus per-core lines.
 * @returns {{cpu: object|null, cores: Object<string, object>}}
 */
function readCpuStat() {
  const text = readTextSafe(PROC_STAT);
  const result = { cpu: null, cores: {} };
  if (!text) return result;

  for (const rawLine of text.split('\n')) {
    if (!rawLine.startsWith('cpu')) continue;

    const parts = rawLine.trim().split(/\s+/);
    const label = parts[0];
    const nums = parts.slice(1).map((n) => toNumber(n, 0));

    const entry = {
      user: nums[0] || 0,
      nice: nums[1] || 0,
      system: nums[2] || 0,
      idle: nums[3] || 0,
      iowait: nums[4] || 0,
      irq: nums[5] || 0,
      softirq: nums[6] || 0,
      steal: nums[7] || 0,
    };

    if (label === 'cpu') {
      result.cpu = entry;
    } else {
      result.cores[label] = entry;
    }
  }

  return result;
}

/** Total and idle jiffies for one CPU snapshot (idle + iowait = not busy). */
function cpuTotals(cpu) {
  if (!cpu) return { total: 0, idle: 0 };
  const idle = toNumber(cpu.idle) + toNumber(cpu.iowait);
  const total =
    toNumber(cpu.user) +
    toNumber(cpu.nice) +
    toNumber(cpu.system) +
    toNumber(cpu.idle) +
    toNumber(cpu.iowait) +
    toNumber(cpu.irq) +
    toNumber(cpu.softirq) +
    toNumber(cpu.steal);
  return { total, idle };
}

/** CPU utilization percent between two jiffie snapshots. */
function cpuPercentBetween(prev, curr) {
  if (!prev || !curr) return 0;
  const totalDiff = curr.total - prev.total;
  const idleDiff = curr.idle - prev.idle;
  if (totalDiff <= 0) return 0;
  const busy = totalDiff - idleDiff;
  return clamp((busy / totalDiff) * 100, 0, 100);
}

/* -------------------------------------------------------------------------- *
 * /proc/meminfo parsing
 * -------------------------------------------------------------------------- */

/**
 * Parse /proc/meminfo into a numeric kB key/value map.
 * @returns {Object<string, number>}
 */
function readMemInfo() {
  const text = readTextSafe(PROC_MEMINFO);
  const out = {};
  if (!text) return out;

  for (const line of text.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)/);
    if (match) out[match[1]] = parseInt(match[2], 10);
  }
  return out;
}

/** RAM utilization percent based on MemAvailable (fallback: free+cache). */
function ramPercent(meminfo) {
  const total = toNumber(meminfo.MemTotal, 0);
  if (total <= 0) return 0;

  const available =
    typeof meminfo.MemAvailable === 'number'
      ? meminfo.MemAvailable
      : toNumber(meminfo.MemFree, 0) +
        toNumber(meminfo.Cached, 0) +
        toNumber(meminfo.Buffers, 0);

  const used = total - available;
  return clamp((used / total) * 100, 0, 100);
}

/* -------------------------------------------------------------------------- *
 * Filesystem capacity
 * -------------------------------------------------------------------------- */

/**
 * Read filesystem stats via fs.statfsSync. Total/free/used in bytes.
 * @param {string} mount
 */
function readFilesystem(mount) {
  try {
    const st = fs.statfsSync(mount);
    const bsize = toNumber(st.bsize, 0);
    const totalBytes = toNumber(st.blocks, 0) * bsize;
    const freeBytes = toNumber(st.bavail, 0) * bsize;
    const usedBytes = Math.max(0, totalBytes - toNumber(st.bfree, 0) * bsize);
    return { totalBytes, freeBytes, usedBytes };
  } catch (_err) {
    return { totalBytes: 0, freeBytes: 0, usedBytes: 0 };
  }
}

/* -------------------------------------------------------------------------- *
 * CPU baseline state
 *
 * A CPU percentage is inherently a delta. We capture a baseline when the
 * module is first loaded so the *first* getMetrics() call already has a
 * meaningful window (as long as some time passed since require()).
 * -------------------------------------------------------------------------- */

let lastCpuTotals = null;

function primeBaseline() {
  try {
    lastCpuTotals = cpuTotals(readCpuStat().cpu);
  } catch (_err) {
    lastCpuTotals = null;
  }
}

primeBaseline();

/* -------------------------------------------------------------------------- *
 * Public API
 * -------------------------------------------------------------------------- */

/**
 * Collect current system metrics.
 * @returns {{cpu: number, ram: number, disk: number}}
 */
function getMetrics() {
  const cpuStat = readCpuStat();
  const totals = cpuTotals(cpuStat.cpu);

  let cpuPct = 0;
  if (lastCpuTotals) {
    cpuPct = round(cpuPercentBetween(lastCpuTotals, totals), 1);
  }
  lastCpuTotals = totals;

  const meminfo = readMemInfo();
  const ramPct = round(ramPercent(meminfo), 1);

  const fsStats = readFilesystem(DEFAULT_MOUNT);
  const diskGb = round(fsStats.usedBytes / BYTES_PER_GB, 2);

  return { cpu: cpuPct, ram: ramPct, disk: diskGb };
}

/** Extended snapshot for diagnostics and dashboards. */
function getDetailedMetrics() {
  const base = getMetrics();

  const cpuStat = readCpuStat();
  const meminfo = readMemInfo();
  const fsStats = readFilesystem(DEFAULT_MOUNT);

  const memTotalKb = toNumber(meminfo.MemTotal, 0);
  const memAvailableKb =
    typeof meminfo.MemAvailable === 'number'
      ? meminfo.MemAvailable
      : toNumber(meminfo.MemFree, 0) +
        toNumber(meminfo.Cached, 0) +
        toNumber(meminfo.Buffers, 0);

  let loadavg = [0, 0, 0];
  let uptimeSec = 0;
  let hostname = 'unknown';
  try {
    const la = os.loadavg();
    if (Array.isArray(la)) loadavg = la.map((v) => round(v, 2));
  } catch (_err) { /* ignore */ }
  try { uptimeSec = Math.round(os.uptime()); } catch (_err) { /* ignore */ }
  try { hostname = os.hostname(); } catch (_err) { /* ignore */ }

  return {
    cpu: base.cpu,
    ram: base.ram,
    disk: base.disk,
    cpuCores: Object.keys(cpuStat.cores).length,
    memoryKb: {
      total: memTotalKb,
      available: memAvailableKb,
      used: Math.max(0, memTotalKb - memAvailableKb),
    },
    memoryGb: {
      total: round(memTotalKb / 1024 / 1024, 2),
      used: round(Math.max(0, memTotalKb - memAvailableKb) / 1024 / 1024, 2),
    },
    diskBytes: fsStats,
    diskGb: {
      total: round(fsStats.totalBytes / BYTES_PER_GB, 2),
      free: round(fsStats.freeBytes / BYTES_PER_GB, 2),
      used: round(fsStats.usedBytes / BYTES_PER_GB, 2),
    },
    loadavg,
    uptimeSec,
    hostname,
    platform: process.platform,
    timestamp: Date.now(),
  };
}

/** CPU-only convenience wrapper (percent since previous call). */
function getCpuPercent() {
  return getMetrics().cpu;
}

/** RAM-only convenience wrapper (percent). */
function getRamPercent() {
  return round(ramPercent(readMemInfo()), 1);
}

/** Disk used in GB for the root filesystem. */
function getDiskUsedGB() {
  return round(readFilesystem(DEFAULT_MOUNT).usedBytes / BYTES_PER_GB, 2);
}

/* -------------------------------------------------------------------------- *
 * Exports
 * -------------------------------------------------------------------------- */

module.exports = {
  getMetrics,
  getDetailedMetrics,
  getCpuPercent,
  getRamPercent,
  getDiskUsedGB,
  _internal: {
    readCpuStat,
    cpuTotals,
    cpuPercentBetween,
    readMemInfo,
    ramPercent,
    readFilesystem,
    clamp,
    round,
    toNumber,
    primeBaseline,
  },
};

// Convenience: `require('...')()` also works.
module.exports.default = getMetrics;
