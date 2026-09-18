'use strict';

/**
 * observability/threshold_alerts.js
 * ---------------------------------------------------------------------------
 * Threshold-based alert evaluation.
 *
 * Public API
 *   evaluate(snapshot)        -> alerts[]  (fired, de-duplicated alerts)
 *   evaluateBatch(snapshots)  -> alerts[]  (flat, de-duplicated across batch)
 *   resetDedup()              -> clears the 10-minute de-duplication window
 *   getDedupState()           -> snapshot of the current de-dup table
 *   RULES                     -> the rule catalogue (rule objects)
 *
 * Rules (threshold alerts)
 *   1. fail_rate_10m > 0.30                     -> WARN
 *   2. any race with timeout > 300s             -> CRIT
 *   3. CPU > 90% sustained for >= 5 minutes     -> WARN
 *
 * De-duplication
 *   Every alert gets a stable `key`. After an alert with a given key fires,
 *   the same key is suppressed for DEDUP_WINDOW_MS (10 minutes). A second
 *   evaluate() inside the window therefore returns no duplicate. The window
 *   is measured against the snapshot timestamp when present, otherwise the
 *   wall clock (or an injected clock).
 *
 * Design goals
 *   - Node core only, zero dependencies.
 *   - Deterministic and side-effect free apart from the bounded de-dup table.
 *   - Never throws on malformed input: unknown months are skipped gracefully.
 */

const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_DEDUP_ENTRIES = 5000;

const SEVERITY = Object.freeze({
  WARN: 'WARN',
  CRIT: 'CRIT',
});

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstNumber(candidates) {
  for (const candidate of candidates) {
    if (isNumber(candidate)) return candidate;
  }
  return null;
}

function firstDefined(candidates) {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return undefined;
}

/**
 * Resolve the evaluation instant (ms since epoch).
 * Priority: snapshot.at / snapshot.timestamp -> injected options.now ->
 * Date.now(). Accepts epoch numbers, ISO strings and Date instances.
 */
function resolveTime(snapshot, options = {}) {
  const raw = firstDefined([
    options.now,
    snapshot && snapshot.at,
    snapshot && snapshot.timestamp,
    snapshot && snapshot.ts,
    snapshot && snapshot.time,
  ]);

  if (isNumber(raw)) return raw;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
}

function clamp01(value) {
  if (!isNumber(value)) return null;
  return value;
}

/* ------------------------------------------------------------------ *
 * Snapshot field extraction
 * ------------------------------------------------------------------ */

function readFailRate(snapshot) {
  if (!isPlainObject(snapshot)) return null;
  const metrics = isPlainObject(snapshot.metrics) ? snapshot.metrics : {};
  return firstNumber([
    snapshot.fail_rate_10m,
    snapshot.failRate10m,
    snapshot.failRate,
    metrics.fail_rate_10m,
    metrics.failRate10m,
  ]);
}

function readRaces(snapshot) {
  if (!isPlainObject(snapshot)) return [];
  const races = firstDefined([snapshot.races, snapshot.race, snapshot.timeouts]);
  if (!Array.isArray(races)) return [];
  return races.filter(isPlainObject);
}

function readRaceTimeout(race) {
  return firstNumber([
    race.timeout_s,
    race.timeoutS,
    race.timeoutSeconds,
    race.timeout,
    race.duration_s,
    race.duration,
  ]);
}

function readCpu(snapshot) {
  if (!isPlainObject(snapshot)) return null;
  const metrics = isPlainObject(snapshot.metrics) ? snapshot.metrics : {};

  let percent = null;
  let sustainedMinutes = null;

  const cpu = firstDefined([snapshot.cpu, metrics.cpu]);
  if (isNumber(cpu)) {
    percent = cpu;
  } else if (isPlainObject(cpu)) {
    percent = firstNumber([cpu.percent, cpu.usage, cpu.usagePercent, cpu.value]);
    if (isNumber(percent) && percent <= 1) percent = percent * 100;
    sustainedMinutes = firstNumber([
      cpu.sustained_minutes,
      cpu.sustainedMinutes,
      cpu.duration_min,
      cpu.minutes,
      cpu.forMinutes,
    ]);
  }

  if (percent === null) {
    percent = firstNumber([snapshot.cpu_percent, snapshot.cpuPercent, metrics.cpu_percent]);
    if (isNumber(percent) && percent <= 1) percent = percent * 100;
  }
  if (sustainedMinutes === null) {
    sustainedMinutes = firstNumber([
      snapshot.cpu_sustained_min,
      snapshot.cpuSustainedMinutes,
      metrics.cpu_sustained_min,
    ]);
  }
  // A plain cpu sample with an explicit `window_min` / `windowMinutes` also
  // counts as sustained over that window.
  if (sustainedMinutes === null) {
    sustainedMinutes = firstNumber([
      snapshot.window_min,
      snapshot.windowMinutes,
      snapshot.interval_min,
      metrics.window_min,
    ]);
  }

  return { percent: clamp01(percent), sustainedMinutes };
}

/* ------------------------------------------------------------------ *
 * Rule catalogue
 * ------------------------------------------------------------------ */

const RULES = Object.freeze([
  {
    id: 'fail_rate_10m',
    severity: SEVERITY.WARN,
    threshold: 0.3,
    comparator: 'gt',
    description: 'fail_rate_10m > 0.3 -> WARN',
    evaluate(snapshot) {
      const value = readFailRate(snapshot);
      if (value === null) return [];
      if (value > this.threshold) {
        return [{
          key: 'fail_rate_10m',
          rule: this.id,
          severity: this.severity,
          metric: 'fail_rate_10m',
          value,
          threshold: this.threshold,
          comparator: this.comparator,
          message: `fail_rate_10m=${value} exceeds ${this.threshold} (WARN)`,
        }];
      }
      return [];
    },
  },
  {
    id: 'race_timeout',
    severity: SEVERITY.CRIT,
    threshold: 300,
    comparator: 'gt',
    description: 'any race timeout > 300s -> CRIT',
    evaluate(snapshot) {
      const races = readRaces(snapshot);
      const breached = [];
      races.forEach((race, index) => {
        const timeout = readRaceTimeout(race);
        if (timeout === null || timeout <= this.threshold) return;
        const identity = firstDefined([race.id, race.name, race.key]);
        const label = identity !== undefined ? String(identity) : `#${index}`;
        breached.push({
          key: `race_timeout:${label}`,
          rule: this.id,
          severity: this.severity,
          metric: 'race_timeout_s',
          value: timeout,
          threshold: this.threshold,
          comparator: this.comparator,
          labels: identity !== undefined ? { race: String(identity) } : { raceIndex: index },
          message: `race ${label} timeout=${timeout}s exceeds ${this.threshold}s (CRIT)`,
        });
      });
      return breached;
    },
  },
  {
    id: 'cpu_sustained',
    severity: SEVERITY.WARN,
    threshold: 90,
    minMinutes: 5,
    comparator: 'gt',
    description: 'CPU > 90% sustained for 5 min -> WARN',
    evaluate(snapshot) {
      const cpu = readCpu(snapshot);
      if (!cpu || cpu.percent === null) return [];
      if (cpu.percent <= this.threshold) return [];
      if (!isNumber(cpu.sustainedMinutes) || cpu.sustainedMinutes < this.minMinutes) return [];
      return [{
        key: 'cpu_sustained',
        rule: this.id,
        severity: this.severity,
        metric: 'cpu_percent',
        value: cpu.percent,
        threshold: this.threshold,
        sustainedMinutes: cpu.sustainedMinutes,
        comparator: this.comparator,
        message: `CPU=${cpu.percent}% above ${this.threshold}% for ${cpu.sustainedMinutes}min (WARN)`,
      }];
    },
  },
]);

/* ------------------------------------------------------------------ *
 * De-duplication table
 * ------------------------------------------------------------------ */

const dedup = new Map(); // key -> lastFiredAt (ms)

function pruneDedup(now) {
  for (const [key, at] of dedup.entries()) {
    if (now - at >= DEDUP_WINDOW_MS) dedup.delete(key);
  }
  // Hard cap so long-running processes cannot grow unbounded.
  if (dedup.size > MAX_DEDUP_ENTRIES) {
    const sorted = [...dedup.entries()].sort((a, b) => a[1] - b[1]);
    const excess = dedup.size - MAX_DEDUP_ENTRIES;
    for (let i = 0; i < excess; i += 1) dedup.delete(sorted[i][0]);
  }
}

function isDuplicate(key, now) {
  const last = dedup.get(key);
  if (last === undefined) return false;
  return now - last < DEDUP_WINDOW_MS;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Evaluate a snapshot against every threshold rule.
 *
 * @param {object} snapshot  Metric snapshot. Recognised fields include
 *                           fail_rate_10m, races[].timeout_s, cpu.percent +
 *                           cpu.sustained_minutes (aliases supported).
 * @param {object} [options] { now:number, reset:boolean, raw:boolean }
 *                           - now   force the evaluation instant (ms)
 *                           - reset clear the de-dup table first
 *                           - raw   skip de-duplication entirely
 * @returns {Array} fired alerts, most-severe first, de-duplicated by key.
 */
function evaluate(snapshot, options = {}) {
  if (options.reset) dedup.clear();

  const at = resolveTime(snapshot, options);
  pruneDedup(at);

  const fired = [];
  for (const rule of RULES) {
    let candidates;
    try {
      candidates = rule.evaluate(snapshot) || [];
    } catch (err) {
      // A malformed snapshot must never take the evaluator down.
      candidates = [];
    }
    for (const candidate of candidates) {
      if (!options.raw && isDuplicate(candidate.key, at)) continue;
      fired.push(candidate);
    }
  }

  // Record the keys we are actually emitting so repeats are suppressed.
  if (!options.raw) {
    for (const alert of fired) {
      dedup.set(alert.key, at);
    }
  }

  fired.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return fired.map((alert) => finalize(alert, at));
}

/**
 * Evaluate an array of snapshots in order, sharing one de-dup window.
 * Useful for replaying fixtures.
 */
function evaluateBatch(snapshots, options = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [snapshots];
  const out = [];
  list.forEach((snap, index) => {
    const alerts = evaluate(snap, Object.assign({}, options, {
      reset: index === 0 && options.reset === true,
    }));
    for (const alert of alerts) out.push(alert);
  });
  return out;
}

function severityRank(severity) {
  if (severity === SEVERITY.CRIT) return 2;
  if (severity === SEVERITY.WARN) return 1;
  return 0;
}

function finalize(alert, at) {
  return {
    id: alert.id || `alert:${alert.key}`,
    key: alert.key,
    rule: alert.rule,
    severity: alert.severity,
    metric: alert.metric,
    value: alert.value,
    threshold: alert.threshold,
    comparator: alert.comparator || 'gt',
    labels: alert.labels || {},
    message: alert.message,
    firedAt: new Date(at).toISOString(),
    dedupWindowMs: DEDUP_WINDOW_MS,
  };
}

/** Clear the 10-minute de-duplication window (useful in tests). */
function resetDedup() {
  dedup.clear();
  return true;
}

/** Inspect the de-duplication table. */
function getDedupState() {
  return {
    size: dedup.size,
    windowMs: DEDUP_WINDOW_MS,
    entries: [...dedup.entries()].map(([key, at]) => ({
      key,
      lastFiredAt: new Date(at).toISOString(),
    })),
  };
}

module.exports = {
  evaluate,
  evaluateBatch,
  resetDedup,
  getDedupState,
  RULES,
  SEVERITY,
  DEDUP_WINDOW_MS,
  // Extracted helpers (handy for tests / callers building snapshots)
  readFailRate,
  readRaces,
  readCpu,
};
