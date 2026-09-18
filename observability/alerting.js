'use strict';

/**
 * observability/alerting.js
 * ---------------------------------------------------------------------------
 * Alerting engine for the observability layer.
 *
 * Public API
 *   check(ctx)            -> evaluate every enabled rule, return fired alerts
 *   notify(alert)         -> dispatch a single alert to all registered notifiers
 *
 * Extended API
 *   run(ctx)              -> check() then notify() every fired alert
 *   addRule(rule)         -> register a rule on the default engine
 *   addNotifier(fn)       -> register a notifier on the default engine
 *   summarize(alerts)     -> aggregate severities / counts
 *   installDefaultRules() -> register a sensible default rule set
 *   consoleNotifier(opts) -> notifier factory (stdout/stderr)
 *   bufferNotifier(arr)   -> collecting notifier factory
 *   webhookNotifier(url)  -> HTTP POST notifier factory (global fetch)
 *
 * Design goals
 *   - Node core only, no external dependencies.
 *   - Deterministic behaviour, bounded memory (history + state are capped).
 *   - A broken rule or notifier never takes the process down.
 */

const DEFAULT_SEVERITIES = ['info', 'warning', 'critical'];

const SEVERITY_RANK = Object.freeze({
  info: 0,
  warning: 1,
  critical: 2,
});

const DEFAULT_STATE = Object.freeze({
  firing: false,
  lastValue: null,
  lastFiredAt: null,
  fireCount: 0,
  resolveCount: 0,
});

const DEFAULT_MAX_HISTORY = 1000;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    return String(value);
  }
}

function isSeverity(value) {
  return typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(SEVERITY_RANK, value);
}

function worstSeverity(a, b) {
  return (SEVERITY_RANK[a] || 0) >= (SEVERITY_RANK[b] || 0) ? a : b;
}

/**
 * Normalise a raw alert into a stable shape so downstream consumers do not
 * have to defend against missing fields.
 */
function normalizeAlert(raw) {
  const alert = isPlainObject(raw) ? raw : {};
  const severity = isSeverity(alert.severity) ? alert.severity : 'warning';

  return {
    id: alert.id || `alert_${Math.random().toString(36).slice(2, 10)}`,
    name: alert.name || 'unnamed-alert',
    severity,
    message: alert.message || '',
    value: isNumber(alert.value) ? alert.value : null,
    threshold: isNumber(alert.threshold) ? alert.threshold : null,
    labels: isPlainObject(alert.labels) ? safeClone(alert.labels) : {},
    annotations: isPlainObject(alert.annotations) ? safeClone(alert.annotations) : {},
    firedAt: alert.firedAt || nowIso(),
    resolvedAt: alert.resolvedAt || null,
    source: alert.source || 'alerting.js',
  };
}

/* ------------------------------------------------------------------ *
 * AlertEngine
 * ------------------------------------------------------------------ */

class AlertEngine {
  constructor(options = {}) {
    this.rules = [];
    this.notifiers = [];
    this.history = [];
    this.state = new Map();
    this.maxHistory = isNumber(options.maxHistory) ? options.maxHistory : DEFAULT_MAX_HISTORY;
    this.clock = typeof options.clock === 'function' ? options.clock : nowIso;
    this.logger = typeof options.logger === 'function' ? options.logger : null;
  }

  log(level, msg, meta) {
    if (!this.logger) return;
    try {
      this.logger(level, msg, meta);
    } catch (err) {
      /* never let a broken logger take down alerting */
    }
  }

  /* --------------------------- rules ---------------------------- */

  /**
   * Register a rule.
   * rule = {
   *   name: string,
   *   severity: 'info'|'warning'|'critical',
   *   evaluate: (ctx) => number | { value:number },
   *   threshold: number,
   *   comparator: 'gt'|'gte'|'lt'|'lte'|'eq'|'neq'   (default 'gt'),
   *   message: (value, ctx) => string,
   *   for: number,   // consecutive breaches required before firing
   *   labels: object,
   *   enabled: boolean,
   * }
   */
  addRule(rule) {
    if (!isPlainObject(rule)) {
      throw new TypeError('rule must be an object');
    }
    if (typeof rule.evaluate !== 'function') {
      throw new TypeError('rule.evaluate must be a function');
    }
    const normalized = {
      name: rule.name || `rule_${this.rules.length}`,
      severity: isSeverity(rule.severity) ? rule.severity : 'warning',
      evaluate: rule.evaluate,
      threshold: isNumber(rule.threshold) ? rule.threshold : 0,
      comparator: rule.comparator || 'gt',
      message: typeof rule.message === 'function' ? rule.message : null,
      for: isNumber(rule.for) && rule.for > 0 ? Math.floor(rule.for) : 1,
      labels: isPlainObject(rule.labels) ? safeClone(rule.labels) : {},
      enabled: rule.enabled !== false,
    };
    this.rules.push(normalized);
    this.state.set(normalized.name, Object.assign({}, DEFAULT_STATE, { breaches: 0 }));
    this.log('debug', 'rule added', { name: normalized.name });
    return normalized;
  }

  removeRule(name) {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.name !== name);
    this.state.delete(name);
    return before !== this.rules.length;
  }

  getRule(name) {
    return this.rules.find((r) => r.name === name) || null;
  }

  getRules() {
    return this.rules.slice();
  }

  clearRules() {
    const n = this.rules.length;
    this.rules = [];
    this.state.clear();
    return n;
  }

  /* -------------------------- compare --------------------------- */

  compare(value, threshold, comparator) {
    switch (comparator) {
      case 'gt': return value > threshold;
      case 'gte': return value >= threshold;
      case 'lt': return value < threshold;
      case 'lte': return value <= threshold;
      case 'eq': return value === threshold;
      case 'neq': return value !== threshold;
      default: return value > threshold;
    }
  }

  /* --------------------------- check ---------------------------- */

  /**
   * Evaluate every enabled rule.
   * @param {object} ctx optional evaluation context passed to evaluate().
   * @returns {Array} list of fired / resolved alerts.
   */
  check(ctx = {}) {
    const fired = [];
    const at = this.clock();

    for (const rule of this.rules) {
      if (!rule.enabled) continue;

      let raw;
      try {
        raw = rule.evaluate(ctx);
      } catch (err) {
        this.log('error', 'rule evaluate threw', { name: rule.name, error: String(err) });
        continue;
      }

      const value = raw && typeof raw === 'object' ? raw.value : raw;
      if (!isNumber(value)) {
        this.log('debug', 'rule produced non-numeric value', { name: rule.name, value });
        continue;
      }

      const s = this.state.get(rule.name) ||
        Object.assign({}, DEFAULT_STATE, { breaches: 0 });
      s.lastValue = value;

      if (this.compare(value, rule.threshold, rule.comparator)) {
        s.breaches = (s.breaches || 0) + 1;
      } else {
        s.breaches = 0;
      }

      const shouldFire = s.breaches >= rule.for;

      if (shouldFire && !s.firing) {
        s.firing = true;
        s.lastFiredAt = at;
        s.fireCount += 1;
        const message = rule.message
          ? rule.message(value, ctx)
          : `${rule.name}: ${value} ${rule.comparator} ${rule.threshold}`;
        const alert = normalizeAlert({
          id: `${rule.name}:${s.fireCount}`,
          name: rule.name,
          severity: rule.severity,
          message,
          value,
          threshold: rule.threshold,
          labels: rule.labels,
          firedAt: at,
        });
        this.record(alert);
        fired.push(alert);
        this.log('warn', 'alert fired', { name: rule.name, value });
      } else if (!shouldFire && s.firing) {
        s.firing = false;
        s.resolveCount += 1;
        const resolved = normalizeAlert({
          id: `${rule.name}:resolved:${s.resolveCount}`,
          name: rule.name,
          severity: rule.severity,
          message: `${rule.name} resolved (value=${value})`,
          value,
          threshold: rule.threshold,
          labels: rule.labels,
          resolvedAt: at,
        });
        this.record(resolved);
        fired.push(resolved);
        this.log('info', 'alert resolved', { name: rule.name, value });
      }

      this.state.set(rule.name, s);
    }

    return fired;
  }

  /* --------------------------- notify --------------------------- */

  /**
   * Dispatch a single alert to every registered notifier.
   * A failing notifier never blocks the others.
   * @param {object} alert
   * @returns {Array} per-notifier results.
   */
  notify(alert) {
    const norm = normalizeAlert(alert);
    const results = [];

    for (const notifier of this.notifiers) {
      try {
        const out = notifier(norm);
        results.push({ notifier: notifier.name || 'anonymous', ok: true, result: out });
      } catch (err) {
        this.log('error', 'notifier failed', {
          notifier: notifier.name || 'anonymous',
          error: String(err),
        });
        results.push({
          notifier: notifier.name || 'anonymous',
          ok: false,
          error: String(err),
        });
      }
    }

    if (results.length === 0) {
      this.log('debug', 'no notifiers registered; alert dropped', { id: norm.id });
    }

    return results;
  }

  addNotifier(fn) {
    if (typeof fn !== 'function') throw new TypeError('notifier must be a function');
    this.notifiers.push(fn);
    return fn;
  }

  removeNotifier(fn) {
    const before = this.notifiers.length;
    this.notifiers = this.notifiers.filter((n) => n !== fn);
    return before !== this.notifiers.length;
  }

  /* --------------------------- run ------------------------------ */

  /**
   * Evaluate rules and dispatch every alert that fired or resolved.
   * @returns {Promise<Array>} flattened per-alert notifier results.
   */
  async run(ctx = {}) {
    const alerts = this.check(ctx);
    const dispatched = [];
    for (const alert of alerts) {
      dispatched.push({ alert, results: this.notify(alert) });
    }
    return dispatched;
  }

  /* --------------------------- history -------------------------- */

  record(alert) {
    this.history.push(alert);
    if (this.history.length > this.maxHistory) {
      this.history.splice(0, this.history.length - this.maxHistory);
    }
  }

  getHistory(filter = {}) {
    return this.history.filter((a) => {
      if (filter.severity && a.severity !== filter.severity) return false;
      if (filter.name && a.name !== filter.name) return false;
      if (filter.since && new Date(a.firedAt) < new Date(filter.since)) return false;
      return true;
    });
  }

  clearHistory() {
    const n = this.history.length;
    this.history = [];
    return n;
  }

  snapshot() {
    const rules = {};
    for (const [name, s] of this.state.entries()) {
      rules[name] = safeClone(s);
    }
    return {
      rules,
      ruleCount: this.rules.length,
      notifierCount: this.notifiers.length,
      historySize: this.history.length,
      at: this.clock(),
    };
  }

  reset() {
    this.clearRules();
    this.clearHistory();
    this.notifiers = [];
    return this;
  }
}

/* ------------------------------------------------------------------ *
 * Aggregate helpers
 * ------------------------------------------------------------------ */

/**
 * Summarise a list of alerts: totals, per-severity counts and the worst
 * severity present.
 * @param {Array} alerts
 * @returns {object}
 */
function summarize(alerts) {
  const list = Array.isArray(alerts) ? alerts : [];
  const bySeverity = { info: 0, warning: 0, critical: 0 };
  const byName = {};
  let worst = null;

  for (const raw of list) {
    const alert = normalizeAlert(raw);
    if (Object.prototype.hasOwnProperty.call(bySeverity, alert.severity)) {
      bySeverity[alert.severity] += 1;
    }
    byName[alert.name] = (byName[alert.name] || 0) + 1;
    worst = worst === null ? alert.severity : worstSeverity(worst, alert.severity);
  }

  return { total: list.length, bySeverity, byName, worst };
}

/* ------------------------------------------------------------------ *
 * Notifier factories
 * ------------------------------------------------------------------ */

/**
 * Human-readable console notifier. Writes warning/info to stdout and
 * critical to stderr.
 */
function consoleNotifier(options = {}) {
  const prefix = options.prefix || '[alert]';
  const fn = (alert) => {
    const line = `${prefix} [${alert.severity}] ${alert.name}: ${alert.message}`;
    /* eslint-disable no-console */
    if (alert.severity === 'critical') {
      console.error(line);
    } else {
      console.log(line);
    }
    /* eslint-enable no-console */
    return line;
  };
  Object.defineProperty(fn, 'name', { value: 'consoleNotifier', configurable: true });
  return fn;
}

/** Collecting notifier: pushes every normalised alert into an array. */
function bufferNotifier(target = []) {
  const fn = (alert) => {
    target.push(alert);
    return target.length;
  };
  Object.defineProperty(fn, 'name', { value: 'bufferNotifier', configurable: true });
  return fn;
}

/**
 * HTTP POST notifier using the global fetch (Node >= 18).
 * Throws when no fetch is available so the engine records a failed result.
 */
function webhookNotifier(url, options = {}) {
  const timeoutMs = isNumber(options.timeoutMs) ? options.timeoutMs : 5000;
  const headers = Object.assign(
    { 'content-type': 'application/json' },
    isPlainObject(options.headers) ? options.headers : {},
  );
  const fn = async (alert) => {
    if (typeof fetch !== 'function') {
      throw new Error('global fetch is not available');
    }
    const controller = typeof AbortController === 'function'
      ? new AbortController()
      : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(alert),
        signal: controller ? controller.signal : undefined,
      });
      return { status: res.status, ok: res.ok };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  Object.defineProperty(fn, 'name', { value: 'webhookNotifier', configurable: true });
  return fn;
}

/* ------------------------------------------------------------------ *
 * Default singleton + convenience API
 * ------------------------------------------------------------------ */

const defaultEngine = new AlertEngine();

/** check() — evaluates the default engine's rules. */
function check(ctx) {
  return defaultEngine.check(ctx);
}

/** notify(alert) — dispatches an alert via the default engine. */
function notify(alert) {
  return defaultEngine.notify(alert);
}

/** run(ctx) — check() + notify() on the default engine. */
function run(ctx) {
  return defaultEngine.run(ctx);
}

/** addRule(rule) on the default engine. */
function addRule(rule) {
  return defaultEngine.addRule(rule);
}

/** addNotifier(fn) on the default engine. */
function addNotifier(fn) {
  return defaultEngine.addNotifier(fn);
}

/**
 * Register a sensible default rule set on the supplied engine
 * (defaults to the module singleton).
 */
function installDefaultRules(engine = defaultEngine) {
  const rules = [
    {
      name: 'cpu.high',
      severity: 'warning',
      threshold: 0.85,
      comparator: 'gt',
      evaluate: (ctx) => (isNumber(ctx.cpu) ? ctx.cpu : null),
      message: (v) => `CPU usage high: ${(v * 100).toFixed(1)}%`,
      for: 2,
    },
    {
      name: 'cpu.critical',
      severity: 'critical',
      threshold: 0.95,
      comparator: 'gt',
      evaluate: (ctx) => (isNumber(ctx.cpu) ? ctx.cpu : null),
      message: (v) => `CPU usage critical: ${(v * 100).toFixed(1)}%`,
    },
    {
      name: 'memory.high',
      severity: 'warning',
      threshold: 0.9,
      comparator: 'gt',
      evaluate: (ctx) => (isNumber(ctx.memory) ? ctx.memory : null),
      message: (v) => `Memory usage high: ${(v * 100).toFixed(1)}%`,
    },
    {
      name: 'disk.high',
      severity: 'critical',
      threshold: 0.9,
      comparator: 'gt',
      evaluate: (ctx) => (isNumber(ctx.disk) ? ctx.disk : null),
      message: (v) => `Disk usage critical: ${(v * 100).toFixed(1)}%`,
    },
    {
      name: 'errorRate.high',
      severity: 'critical',
      threshold: 0.05,
      comparator: 'gt',
      evaluate: (ctx) => (isNumber(ctx.errorRate) ? ctx.errorRate : null),
      message: (v) => `Error rate elevated: ${(v * 100).toFixed(2)}%`,
    },
    {
      name: 'latency.high',
      severity: 'warning',
      threshold: 2000,
      comparator: 'gt',
      evaluate: (ctx) => (isNumber(ctx.latencyP95) ? ctx.latencyP95 : null),
      message: (v) => `p95 latency high: ${v}ms`,
    },
    {
      name: 'queue.backlog',
      severity: 'warning',
      threshold: 1000,
      comparator: 'gt',
      evaluate: (ctx) => {
        if (isNumber(ctx.queueDepth)) return ctx.queueDepth;
        if (isPlainObject(ctx.queue) && isNumber(ctx.queue.depth)) return ctx.queue.depth;
        return null;
      },
      message: (v) => `Queue depth growing: ${v}`,
    },
  ];

  for (const rule of rules) {
    if (!engine.getRule(rule.name)) engine.addRule(rule);
  }
  return engine.getRules();
}

/* ------------------------------------------------------------------ *
 * Legacy threshold catalogue (fail_rate / race / cpu-sustained rules)
 * ------------------------------------------------------------------ */

const thresholdAlerts = require('./threshold_alerts');

/**
 * evaluateThresholds(snapshot) -> alerts[]
 * Entry point for the legacy rule catalogue: fail_rate_10m > 0.3 (WARN),
 * race timeout > 300s (CRIT), CPU > 90% sustained 5 min (WARN).
 */
function evaluateThresholds(snapshot, options) {
  return thresholdAlerts.evaluate(snapshot, options);
}

/* ------------------------------------------------------------------ *
 * Snapshot alerting API: configure / evaluate / active / history
 * ------------------------------------------------------------------ *
 * evaluate(snapshot) compares { cpu, ram, load, disk } against thresholds
 * (CPU > 85%, RAM > 90%, load > 4, disk > 85%) and returns
 * [{ level, metric, value, threshold, ts }].
 *
 * De-duplication: once a metric fires, the SAME metric is suppressed for
 * SNAPSHOT_DEDUP_WINDOW_MS (10 minutes). After the window elapses it fires
 * again. The evaluation instant is taken from snapshot.ts / timestamp / at
 * when present, otherwise from the (injectable) clock.
 */

const SNAPSHOT_DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const SNAPSHOT_METRICS = Object.freeze(['cpu', 'ram', 'load', 'disk']);

const SNAPSHOT_THRESHOLD_DEFAULTS = Object.freeze({
  cpu: 85,
  ram: 90,
  load: 4,
  disk: 85,
});

const SNAPSHOT_LEVEL_DEFAULTS = Object.freeze({
  cpu: 'warn',
  ram: 'warn',
  load: 'warn',
  disk: 'warn',
});

// Accepted snapshot field aliases for each canonical metric.
const SNAPSHOT_ALIASES = Object.freeze({
  cpu: ['cpu', 'cpu_percent', 'cpuPercent', 'cpu_usage', 'cpuUsage'],
  ram: ['ram', 'ram_percent', 'ramPercent', 'memory', 'memory_percent', 'memoryPercent'],
  load: ['load', 'load_avg', 'loadAvg', 'load_average', 'loadAverage'],
  disk: ['disk', 'disk_percent', 'diskPercent', 'disk_usage', 'diskUsage'],
});

function firstDefined(candidates) {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

function createSnapshotState() {
  return {
    thresholds: Object.assign({}, SNAPSHOT_THRESHOLD_DEFAULTS),
    levels: Object.assign({}, SNAPSHOT_LEVEL_DEFAULTS),
    windowMs: SNAPSHOT_DEDUP_WINDOW_MS,
    maxHistory: 1000,
    lastFiredAt: new Map(), // metric -> ms timestamp of last emission
    lastAlert: new Map(), // metric -> most recent alert object
    history: [], // bounded, chronological list of every emitted alert
    clock: () => Date.now(),
  };
}

const snapshotState = createSnapshotState();

/**
 * Resolve the evaluation instant (ms since epoch).
 * Priority: options.now / options.ts -> snapshot.ts / timestamp / at / time
 * -> injected clock -> Date.now(). Accepts numbers, ISO strings, Dates.
 */
function resolveSnapshotTime(snapshot, options = {}) {
  const raw = firstDefined([
    options && options.now,
    options && options.ts,
    snapshot && snapshot.ts,
    snapshot && snapshot.timestamp,
    snapshot && snapshot.at,
    snapshot && snapshot.time,
  ]);

  if (isNumber(raw)) return raw;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return snapshotState.clock();
}

/**
 * Read a numeric metric value from a snapshot, honouring aliases and nested
 * containers. cpu/ram/disk given as a 0..1 ratio are normalised to percent.
 */
function readSnapshotMetric(snapshot, metric) {
  if (!isPlainObject(snapshot)) return null;
  const percentMetric = metric === 'cpu' || metric === 'ram' || metric === 'disk';
  const aliases = SNAPSHOT_ALIASES[metric] || [metric];

  for (const key of aliases) {
    const raw = snapshot[key];
    const direct = toNumber(raw);
    if (direct !== null) return direct;
    if (isPlainObject(raw)) {
      for (const nestedKey of ['percent', 'usage', 'ratio', 'value', 'current']) {
        const nested = toNumber(raw[nestedKey]);
        if (nested !== null) {
          return percentMetric && nested <= 1 ? nested * 100 : nested;
        }
      }
    }
  }

  for (const container of [snapshot.metrics, snapshot.system, snapshot.stats]) {
    if (isPlainObject(container)) {
      for (const key of aliases) {
        const nested = toNumber(container[key]);
        if (nested !== null) return nested;
      }
    }
  }
  return null;
}

/** Coerce a value to a finite number, accepting numeric strings. */
function toNumber(value) {
  if (isNumber(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function recordSnapshotAlert(alert) {
  snapshotState.history.push(alert);
  if (snapshotState.history.length > snapshotState.maxHistory) {
    snapshotState.history.splice(0, snapshotState.history.length - snapshotState.maxHistory);
  }
}

/**
 * configure(options) -> effective configuration
 * Accepts either a flat thresholds object `{ cpu: 80, ram: 95, ... }` or an
 * options object `{ thresholds, windowMs, levels, maxHistory, clock }`.
 * Only known metric keys are applied; unknown keys are ignored.
 */
function configure(options = {}) {
  if (!isPlainObject(options)) {
    throw new TypeError('configure(options) expects an object');
  }

  let thresholds = options;
  if (isPlainObject(options.thresholds)) {
    thresholds = options.thresholds;
    if (isNumber(options.windowMs) && options.windowMs >= 0) {
      snapshotState.windowMs = options.windowMs;
    }
    if (isPlainObject(options.levels)) {
      Object.assign(snapshotState.levels, options.levels);
    }
    if (isNumber(options.maxHistory) && options.maxHistory > 0) {
      snapshotState.maxHistory = Math.floor(options.maxHistory);
    }
    if (typeof options.clock === 'function') {
      snapshotState.clock = options.clock;
    }
  }

  for (const metric of SNAPSHOT_METRICS) {
    if (isNumber(thresholds[metric])) {
      snapshotState.thresholds[metric] = thresholds[metric];
    }
  }

  return {
    thresholds: Object.assign({}, snapshotState.thresholds),
    levels: Object.assign({}, snapshotState.levels),
    windowMs: snapshotState.windowMs,
  };
}

/**
 * evaluate(snapshot, options) -> alerts[]
 * @param {object} snapshot  { cpu, ram, load, disk } (+ optional ts/timestamp).
 * @param {object} [options] { now, force }. A null / non-object options value
 *   is tolerated and treated as {} so `evaluate(null, null)` never throws.
 * @returns {Array<{level:string, metric:string, value:number,
 *                  threshold:number, ts:string}>}
 */
function evaluate(snapshot, options = {}) {
  const snap = isPlainObject(snapshot) ? snapshot : {};
  // Tolerate null / non-object options so a null snapshot is always a no-op.
  const opts = isPlainObject(options) ? options : {};
  const now = resolveSnapshotTime(snap, opts);
  const force = opts.force === true;
  const fired = [];

  for (const metric of SNAPSHOT_METRICS) {
    const threshold = snapshotState.thresholds[metric];
    if (!isNumber(threshold)) continue;

    const value = readSnapshotMetric(snap, metric);
    if (!isNumber(value) || !(value > threshold)) continue;

    const last = snapshotState.lastFiredAt.get(metric);
    const suppressed = !force && isNumber(last) && (now - last) < snapshotState.windowMs;

    if (suppressed) {
      // Still active: refresh the latest value but do not re-emit an alert.
      const existing = snapshotState.lastAlert.get(metric);
      if (existing) {
        existing.value = value;
        existing.timestamp = now;
      }
      continue;
    }

    snapshotState.lastFiredAt.set(metric, now);
    const alert = {
      level: snapshotState.levels[metric] || 'warn',
      metric,
      value,
      threshold,
      ts: new Date(now).toISOString(),
      timestamp: now,
    };
    snapshotState.lastAlert.set(metric, alert);
    recordSnapshotAlert(alert);
    fired.push(alert);
  }

  return fired;
}

/**
 * active(options) -> alerts[] currently inside their de-duplication window.
 * Optionally resolves "now" from options.now / the injected clock.
 */
function active(options = {}) {
  const now = resolveSnapshotTime({}, options);
  const out = [];
  for (const metric of SNAPSHOT_METRICS) {
    const at = snapshotState.lastFiredAt.get(metric);
    if (!isNumber(at) || (now - at) >= snapshotState.windowMs) continue;
    const alert = snapshotState.lastAlert.get(metric);
    if (alert) out.push(Object.assign({}, alert));
  }
  return out;
}

/**
 * history(n) -> the most recent n emitted alerts (all when n is omitted).
 */
function history(n) {
  const all = snapshotState.history.map((a) => Object.assign({}, a));
  if (n === 0) return [];
  if (!isNumber(n) || n < 0) return all;
  return all.slice(-Math.floor(n));
}

/**
 * resetSnapshotState() -> clears de-dup + history and restores defaults.
 * Handy for deterministic tests; not required by the public contract.
 */
function resetSnapshotState() {
  snapshotState.lastFiredAt.clear();
  snapshotState.lastAlert.clear();
  snapshotState.history = [];
  snapshotState.thresholds = Object.assign({}, SNAPSHOT_THRESHOLD_DEFAULTS);
  snapshotState.levels = Object.assign({}, SNAPSHOT_LEVEL_DEFAULTS);
  snapshotState.windowMs = SNAPSHOT_DEDUP_WINDOW_MS;
  snapshotState.maxHistory = 1000;
  snapshotState.clock = () => Date.now();
  return snapshotState;
}

/**
 * clear() -> public state-reset entry point.
 * Alias of resetSnapshotState(): drops every de-dup window (cooldown), the
 * retained alerts and the history, and restores the default configuration.
 * After clear() the very next over-threshold snapshot fires immediately.
 */
function clear() {
  return resetSnapshotState();
}

/* ------------------------------------------------------------------ *
 * Exports
 * ------------------------------------------------------------------ */

module.exports = {
  AlertEngine,
  // Snapshot alerting API (configure / evaluate / active / history)
  configure,
  evaluate,
  active,
  history,
  resetSnapshotState,
  clear,
  // Legacy threshold catalogue
  evaluateThresholds,
  thresholdAlerts,
  check,
  notify,
  run,
  addRule,
  addNotifier,
  summarize,
  installDefaultRules,
  normalizeAlert,
  consoleNotifier,
  bufferNotifier,
  webhookNotifier,
  DEFAULT_SEVERITIES,
  SEVERITY_RANK,
  isSeverity,
  worstSeverity,
  defaultEngine,
  SNAPSHOT_DEDUP_WINDOW_MS,
  SNAPSHOT_METRICS,
  SNAPSHOT_THRESHOLD_DEFAULTS,
};

/* ------------------------------------------------------------------ *
 * Self-test when executed directly: `node observability/alerting.js`
 * ------------------------------------------------------------------ */

if (require.main === module) {
  installDefaultRules();
  addNotifier(consoleNotifier());
  addNotifier(bufferNotifier());

  run({
    cpu: 0.97,
    memory: 0.95,
    disk: 0.97,
    errorRate: 0.2,
    latencyP95: 5000,
    queueDepth: 1500,
  })
    .then((dispatched) => {
      /* eslint-disable no-console */
      console.log(`dispatched ${dispatched.length} alert(s)`);
      console.log('summary:', JSON.stringify(summarize(dispatched.map((d) => d.alert))));
      /* eslint-enable no-console */
    })
    .catch((err) => {
      /* eslint-disable no-console */
      console.error(err);
      /* eslint-enable no-console */
      process.exitCode = 1;
    });
}
