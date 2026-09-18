'use strict';

/**
 * system_monitor.js — System observability & monitoring module.
 *
 * Provides two public APIs:
 *   - snapshot(): captures a single point-in-time measurement of the host
 *     (CPU load, memory, uptime, process stats, event-loop lag, etc.)
 *     and returns a structured, serializable object.
 *   - watch(interval, options): starts a recurring sampler that invokes a
 *     callback on every tick with a fresh snapshot, tracks deltas/trends,
 *     evaluates alert thresholds and can be stopped at any time.
 *
 * The module is dependency-free (Node built-ins only) so it can be dropped
 * into any runtime without an install step. All sampling is guarded so a
 * failure never throws out of a timer tick.
 *
 * @module observability/system_monitor
 */

const os = require('os');
const process = require('process');

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  interval: 5000,          // ms between samples
  deep: true,              // include optional / expensive fields
  historyLimit: 240,       // max retained snapshots in the ring buffer
  thresholds: {
    loadPerCore: 1.25,     // loadavg[0] / cpuCount alert line
    memPercent: 90,        // used memory % alert line
    heapPercent: 90,       // V8 heap usage % alert line
    eventLoopLagMs: 120,   // absolute lag alert line
  },
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

function round(value, digits = 2) {
  if (typeof value !== 'number' || !isFinite(value)) return value;
  const f = Math.pow(10, digits);
  return Math.round(value * f) / f;
}

function percent(part, whole) {
  if (!whole) return 0;
  return round((part / whole) * 100, 2);
}

function safeCall(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch (_err) {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Event-loop lag probe
// ---------------------------------------------------------------------------

let lastLoopProbe = process.hrtime.bigint();

function eventLoopLagMs() {
  const ts = process.hrtime.bigint();
  const delta = Number(ts - lastLoopProbe) / 1e6; // ms
  lastLoopProbe = ts;
  return round(delta, 3);
}

// ---------------------------------------------------------------------------
// Snapshot primitives
// ---------------------------------------------------------------------------

function cpuSection() {
  const cpus = safeCall(() => os.cpus(), []) || [];
  const cpuCount = cpus.length || 1;
  const load = safeCall(() => os.loadavg(), [0, 0, 0]) || [0, 0, 0];
  const model = cpus.length ? cpus[0].model : 'unknown';

  let user = 0;
  let sys = 0;
  let idle = 0;
  for (const c of cpus) {
    if (!c || !c.times) continue;
    user += c.times.user || 0;
    sys += c.times.sys || 0;
    idle += c.times.idle || 0;
  }
  const total = user + sys + idle || 1;

  return {
    count: cpuCount,
    model: String(model).trim(),
    load1: round(load[0], 3),
    load5: round(load[1], 3),
    load15: round(load[2], 3),
    loadPerCore: round(load[0] / cpuCount, 3),
    busyPercent: percent(total - idle, total),
    userPercent: percent(user, total),
    sysPercent: percent(sys, total),
    idlePercent: percent(idle, total),
  };
}

function memorySection() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    totalMB: round(total / 1048576, 1),
    usedMB: round(used / 1048576, 1),
    freeMB: round(free / 1048576, 1),
    usedPercent: percent(used, total),
  };
}

function heapSection() {
  const m = safeCall(() => process.memoryUsage(), null);
  if (!m) return null;
  return {
    rssMB: round(m.rss / 1048576, 2),
    heapTotalMB: round(m.heapTotal / 1048576, 2),
    heapUsedMB: round(m.heapUsed / 1048576, 2),
    externalMB: round((m.external || 0) / 1048576, 2),
    arrayBuffersMB: round((m.arrayBuffers || 0) / 1048576, 2),
    heapPercent: percent(m.heapUsed, m.heapTotal),
  };
}

function processSection() {
  const mem = safeCall(() => process.memoryUsage(), {}) || {};
  return {
    pid: process.pid,
    ppid: typeof process.ppid === 'number' ? process.ppid : null,
    uptimeSec: round(process.uptime(), 2),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    title: process.title,
    cwd: safeCall(() => process.cwd(), null),
    rssMB: round((mem.rss || 0) / 1048576, 2),
    handles: safeCall(
      () => (process._getActiveHandles ? process._getActiveHandles().length : null),
      null
    ),
    requests: safeCall(
      () => (process._getActiveRequests ? process._getActiveRequests().length : null),
      null
    ),
  };
}

function diskSection() {
  // Best-effort: no native module available, so report nothing rather than lie.
  return {
    available: false,
    reason: 'no-disk-probe',
  };
}

function loadAvgSection() {
  const load = safeCall(() => os.loadavg(), [0, 0, 0]) || [0, 0, 0];
  return {
    load1: round(load[0], 3),
    load5: round(load[1], 3),
    load15: round(load[2], 3),
  };
}

function networkSection() {
  const ifaces = safeCall(() => os.networkInterfaces(), {}) || {};
  const out = [];
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name] || [];
    for (const addr of list) {
      if (!addr) continue;
      out.push({
        iface: name,
        family: addr.family,
        address: addr.address,
        internal: !!addr.internal,
        mac: addr.mac,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API: snapshot()
// ---------------------------------------------------------------------------

/**
 * Capture a single system snapshot synchronously.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.deep=true] include optional sections
 * @returns {object} structured snapshot
 */
function snapshot(opts = {}) {
  const deep = opts.deep !== undefined ? !!opts.deep : DEFAULTS.deep;

  const snap = {
    kind: 'system_snapshot',
    timestamp: nowIso(),
    epochMs: Date.now(),
    host: {
      hostname: safeCall(() => os.hostname(), 'unknown'),
      platform: os.platform(),
      release: safeCall(() => os.release(), 'unknown'),
      arch: os.arch(),
      uptimeSec: round(safeCall(() => os.uptime(), 0), 2),
    },
    cpu: cpuSection(),
    memory: memorySection(),
    loadAvg: loadAvgSection(),
    eventLoopLagMs: eventLoopLagMs(),
  };

  if (deep) {
    snap.process = processSection();
    snap.heap = heapSection();
    snap.network = networkSection();
    snap.disk = diskSection();
    snap.user = safeCall(() => {
      const info = os.userInfo();
      return { username: info.username, uid: info.uid, gid: info.gid };
    }, null);
  }

  return snap;
}

// ---------------------------------------------------------------------------
// Internal state for watch()
// ---------------------------------------------------------------------------

const state = {
  timer: null,
  startedAt: null,
  samples: 0,
  failures: 0,
  lastSnapshot: null,
  previousSnapshot: null,
  history: [],
  listeners: new Set(),
};

function resetState() {
  state.timer = null;
  state.startedAt = null;
  state.samples = 0;
  state.failures = 0;
  state.lastSnapshot = null;
  state.previousSnapshot = null;
  state.history = [];
  state.listeners = new Set();
}

// ---------------------------------------------------------------------------
// Trend / delta computation
// ---------------------------------------------------------------------------

function diffSnapshots(prev, next) {
  if (!prev || !next) return null;
  const dtMs = next.epochMs - prev.epochMs;
  return {
    dtMs,
    dtSec: round(dtMs / 1000, 3),
    load1Delta: round(next.cpu.load1 - prev.cpu.load1, 3),
    memUsedDeltaMB: round(next.memory.usedMB - prev.memory.usedMB, 2),
    memUsedPercentDelta: round(next.memory.usedPercent - prev.memory.usedPercent, 2),
    heapUsedDeltaMB: next.heap && prev.heap
      ? round(next.heap.heapUsedMB - prev.heap.heapUsedMB, 2)
      : null,
    eventLoopLagDeltaMs: round(next.eventLoopLagMs - prev.eventLoopLagMs, 3),
    uptimeDeltaSec: round(next.host.uptimeSec - prev.host.uptimeSec, 2),
  };
}

// ---------------------------------------------------------------------------
// Alert evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a snapshot against thresholds, returning an array of alerts.
 *
 * @param {object} snap
 * @param {object} thresholds
 * @returns {Array<{level:string,metric:string,value:number,threshold:number,message:string}>}
 */
function evaluateAlerts(snap, thresholds) {
  const t = Object.assign({}, DEFAULTS.thresholds, thresholds || {});
  const alerts = [];

  if (snap.cpu && snap.cpu.loadPerCore > t.loadPerCore) {
    alerts.push({
      level: 'warning',
      metric: 'cpu.loadPerCore',
      value: snap.cpu.loadPerCore,
      threshold: t.loadPerCore,
      message: 'CPU load per core ' + snap.cpu.loadPerCore +
        ' exceeds ' + t.loadPerCore,
    });
  }

  if (snap.memory && snap.memory.usedPercent > t.memPercent) {
    alerts.push({
      level: 'critical',
      metric: 'memory.usedPercent',
      value: snap.memory.usedPercent,
      threshold: t.memPercent,
      message: 'Memory usage ' + snap.memory.usedPercent + '% exceeds ' +
        t.memPercent + '%',
    });
  }

  if (snap.heap && snap.heap.heapPercent > t.heapPercent) {
    alerts.push({
      level: 'warning',
      metric: 'heap.heapPercent',
      value: snap.heap.heapPercent,
      threshold: t.heapPercent,
      message: 'Heap usage ' + snap.heap.heapPercent + '% exceeds ' +
        t.heapPercent + '%',
    });
  }

  if (typeof snap.eventLoopLagMs === 'number' &&
      snap.eventLoopLagMs > t.eventLoopLagMs) {
    alerts.push({
      level: 'warning',
      metric: 'eventLoop.lagMs',
      value: snap.eventLoopLagMs,
      threshold: t.eventLoopLagMs,
      message: 'Event loop lag ' + snap.eventLoopLagMs + 'ms exceeds ' +
        t.eventLoopLagMs + 'ms',
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Public API: watch()
// ---------------------------------------------------------------------------

/**
 * Start periodic monitoring.
 *
 * @param {number|object} intervalOrOpts interval ms or options object
 * @param {Function} [onSample] callback(snapshot, meta)
 * @param {Function} [onAlert]  callback(alert, snapshot)
 * @returns {{stop:Function, getState:Function, snapshot:Function}}
 */
function watch(intervalOrOpts, onSample, onAlert) {
  let opts;
  if (typeof intervalOrOpts === 'number') {
    opts = Object.assign({}, DEFAULTS, { interval: intervalOrOpts });
  } else {
    opts = Object.assign({}, DEFAULTS, intervalOrOpts || {});
  }
  const interval = Math.max(50, Number(opts.interval) || DEFAULTS.interval);

  if (state.timer) {
    // Already watching — return handle without spawning a second timer.
    return makeHandle();
  }

  resetState();
  state.startedAt = Date.now();

  const tick = () => {
    let snap = null;
    try {
      snap = snapshot({ deep: opts.deep });
    } catch (err) {
      state.failures += 1;
      if (typeof onSample === 'function') {
        safeCall(() => onSample(null, { error: String(err && err.message || err) }));
      }
      return;
    }

    state.previousSnapshot = state.lastSnapshot;
    state.lastSnapshot = snap;
    state.samples += 1;

    const delta = diffSnapshots(state.previousSnapshot, snap);

    state.history.push({ snapshot: snap, delta });
    if (state.history.length > opts.historyLimit) {
      state.history.splice(0, state.history.length - opts.historyLimit);
    }

    const alerts = evaluateAlerts(snap, opts.thresholds);

    const meta = {
      seq: state.samples,
      interval,
      delta,
      alerts,
      uptimeSec: round((Date.now() - state.startedAt) / 1000, 2),
    };

    if (typeof onSample === 'function') {
      safeCall(() => onSample(snap, meta));
    }
    if (typeof onAlert === 'function' && alerts.length) {
      for (const a of alerts) safeCall(() => onAlert(a, snap));
    }

    for (const listener of state.listeners) {
      safeCall(() => listener(snap, meta));
    }
  };

  // First sample immediately, then schedule.
  tick();
  state.timer = setInterval(tick, interval);
  if (state.timer && typeof state.timer.unref === 'function') {
    // Do not keep the process alive solely for monitoring.
    state.timer.unref();
  }

  return makeHandle();
}

function makeHandle() {
  return {
    stop,
    getState,
    snapshot: () => snapshot({ deep: DEFAULTS.deep }),
    onSample: (fn) => {
      if (typeof fn === 'function') state.listeners.add(fn);
      return () => state.listeners.delete(fn);
    },
    alerts: (snapOrOpts) => evaluateAlerts(
      snapOrOpts && snapOrOpts.cpu ? snapOrOpts : snapshot(),
      null
    ),
  };
}

/**
 * Stop a running watch loop and release resources.
 * @returns {number} number of samples collected during the run
 */
function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  const samples = state.samples;
  return samples;
}

/**
 * Inspect current monitoring state.
 * @returns {object}
 */
function getState() {
  return {
    running: !!state.timer,
    startedAt: state.startedAt,
    samples: state.samples,
    failures: state.failures,
    historyLength: state.history.length,
    lastSnapshot: state.lastSnapshot,
    lastDelta: state.history.length
      ? state.history[state.history.length - 1].delta
      : null,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  snapshot,
  watch,
  stop,
  getState,
  evaluateAlerts,
  diffSnapshots,
  DEFAULT_THRESHOLDS: DEFAULTS.thresholds,
  _internals: { percent, round, eventLoopLagMs, resetState },
};

// Allow `node system_monitor.js` to print a one-shot reading.
if (require.main === module) {
  const snap = snapshot();
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(snap, null, 2));
}
