'use strict';

/**
 * observability/metrics_collector.js
 *
 * Lightweight, dependency-free metrics collector for the Phoenix project.
 *
 * Public API:
 *   const collector = require('./observability/metrics_collector');
 *   collector.collect(name, value, tags)   -> void
 *   collector.query(range)                 -> aggregated snapshot
 *
 * A `range` can be expressed as:
 *   - a number (milliseconds back from "now")
 *   - a string like "5m", "1h", "2d", "30s"
 *   - an object { from: Date|number|string, to: Date|number|string }
 *
 * The collector keeps a bounded, in-memory ring buffer of samples and
 * computes count / sum / min / max / avg / p50 / p90 / p95 / p99 per metric.
 */

const DEFAULT_MAX_SAMPLES = 10000;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const UNIT_MS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

/**
 * Normalize a single number or numeric string into a finite number.
 * Returns null when the value cannot be interpreted as a number.
 */
function toNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse a duration token such as "500ms", "30s", "5m", "2h", "1d"
 * into milliseconds. Bare numbers are treated as milliseconds.
 */
function parseDuration(input) {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === 'string') {
    const match = input.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
    if (match) {
      const amount = Number(match[1]);
      const unit = (match[2] || 'ms').toLowerCase();
      const factor = UNIT_MS[unit] || 1;
      return amount * factor;
    }
  }
  return null;
}

/**
 * Resolve an arbitrary timestamp representation into epoch milliseconds.
 */
function toTimestamp(value) {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== '') {
      return numeric;
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Normalize a range descriptor into an inclusive { from, to } window.
 */
function normalizeRange(range, now) {
  const current = typeof now === 'number' ? now : Date.now();

  if (range === undefined || range === null) {
    return { from: current - DEFAULT_MAX_AGE_MS, to: current };
  }

  if (typeof range === 'number' || typeof range === 'string') {
    const span = parseDuration(range);
    if (span === null) {
      return { from: current - DEFAULT_MAX_AGE_MS, to: current };
    }
    return { from: current - Math.abs(span), to: current };
  }

  if (typeof range === 'object') {
    let to = range.to !== undefined ? toTimestamp(range.to) : current;
    let from = range.from !== undefined ? toTimestamp(range.from) : null;

    if (to === null) {
      to = current;
    }
    if (from === null) {
      const span = parseDuration(range.span);
      from = span === null ? to - DEFAULT_MAX_AGE_MS : to - Math.abs(span);
    }
    if (from > to) {
      const swap = from;
      from = to;
      to = swap;
    }
    return { from, to };
  }

  return { from: current - DEFAULT_MAX_AGE_MS, to: current };
}

/**
 * Compute the q-th percentile (0..1) of an already-sorted numeric array.
 */
function percentile(sorted, q) {
  if (!sorted.length) {
    return null;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = q * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Shallow, cycle-safe tag serializer used as part of the series key.
 */
function serializeTags(tags) {
  if (!tags || typeof tags !== 'object') {
    return '';
  }
  const keys = Object.keys(tags).sort();
  const parts = [];
  for (const key of keys) {
    const value = tags[key];
    if (value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'object') {
      parts.push(`${key}=${JSON.stringify(value)}`);
    } else {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(',');
}

class MetricsCollector {
  constructor(options = {}) {
    this.maxSamples = Number.isFinite(options.maxSamples)
      ? Math.max(1, options.maxSamples)
      : DEFAULT_MAX_SAMPLES;
    this.maxAgeMs = Number.isFinite(options.maxAgeMs)
      ? Math.max(0, options.maxAgeMs)
      : DEFAULT_MAX_AGE_MS;
    this.clock = typeof options.clock === 'function' ? options.clock : Date.now;
    this.series = new Map();
    this.stats = { collected: 0, rejected: 0, evicted: 0, queries: 0 };
  }

  /**
   * Record a single metric sample.
   *
   * @param {string} name   Metric name, e.g. "http.request.duration".
   * @param {number} value  Numeric observation.
   * @param {object} [tags] Optional dimension tags.
   * @returns {boolean} true when the sample was stored.
   */
  collect(name, value, tags) {
    const numeric = toNumber(value);
    if (typeof name !== 'string' || name.trim() === '' || numeric === null) {
      this.stats.rejected += 1;
      return false;
    }

    const metricName = name.trim();
    const tagKey = serializeTags(tags);
    const key = tagKey ? `${metricName}{${tagKey}}` : metricName;
    const now = this.clock();

    let entry = this.series.get(key);
    if (!entry) {
      entry = { name: metricName, tags: tags || {}, samples: [] };
      this.series.set(key, entry);
    }

    entry.samples.push({ t: now, v: numeric });
    this.stats.collected += 1;
    this.evict(entry);
    return true;
  }

  /**
   * Drop expired and overflow samples for a single series.
   */
  evict(entry) {
    const cutoff = this.clock() - this.maxAgeMs;
    let removed = 0;

    if (this.maxAgeMs > 0) {
      let idx = 0;
      while (idx < entry.samples.length && entry.samples[idx].t < cutoff) {
        idx += 1;
      }
      if (idx > 0) {
        entry.samples.splice(0, idx);
        removed += idx;
      }
    }

    const overflow = entry.samples.length - this.maxSamples;
    if (overflow > 0) {
      entry.samples.splice(0, overflow);
      removed += overflow;
    }

    this.stats.evicted += removed;
  }

  /**
   * Explicitly flush all samples, optionally only for one metric name.
   */
  reset(name) {
    if (name === undefined) {
      this.series.clear();
      return;
    }
    for (const [key, entry] of this.series.entries()) {
      if (entry.name === name) {
        this.series.delete(key);
      }
    }
  }

  /**
   * Query samples within a time range and return aggregated results.
   *
   * @param {number|string|object} [range]
   * @param {object} [filter] Optional { name, tag: {k:v} } filter.
   * @returns {{ range: object, series: Array, total: number }}
   */
  query(range, filter) {
    this.stats.queries += 1;
    const now = this.clock();
    const window = normalizeRange(range, now);
    const nameFilter = filter && filter.name ? filter.name : null;
    const tagFilter = filter && filter.tag ? filter.tag : null;

    const results = [];
    let total = 0;

    for (const entry of this.series.values()) {
      if (nameFilter && entry.name !== nameFilter) {
        continue;
      }
      if (tagFilter && !matchesTags(entry.tags, tagFilter)) {
        continue;
      }

      const values = [];
      let minT = null;
      let maxT = null;

      for (const sample of entry.samples) {
        if (sample.t < window.from || sample.t > window.to) {
          continue;
        }
        values.push(sample.v);
        if (minT === null || sample.t < minT) {
          minT = sample.t;
        }
        if (maxT === null || sample.t > maxT) {
          maxT = sample.t;
        }
      }

      if (!values.length) {
        continue;
      }

      results.push(buildAggregate(entry, values, minT, maxT));
      total += values.length;
    }

    results.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { range: window, series: results, total };
  }

  /**
   * Convenience lookup for a single metric name.
   */
  get(name, range, filter) {
    const merged = Object.assign({}, filter || {}, { name });
    const out = this.query(range, merged);
    return out.series.length ? out.series[0] : null;
  }

  /**
   * Introspection helper: list known metric names.
   */
  names() {
    const set = new Set();
    for (const entry of this.series.values()) {
      set.add(entry.name);
    }
    return Array.from(set).sort();
  }

  /**
   * Internal counters describing collector health.
   */
  health() {
    let samples = 0;
    for (const entry of this.series.values()) {
      samples += entry.samples.length;
    }
    return {
      series: this.series.size,
      samples,
      collected: this.stats.collected,
      rejected: this.stats.rejected,
      evicted: this.stats.evicted,
      queries: this.stats.queries,
      maxSamples: this.maxSamples,
      maxAgeMs: this.maxAgeMs,
    };
  }
}

/**
 * Determine whether `tags` contains every key/value pair in `expected`.
 */
function matchesTags(tags, expected) {
  if (!tags || !expected) {
    return true;
  }
  for (const key of Object.keys(expected)) {
    if (tags[key] !== expected[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Build the aggregate descriptor for one series.
 */
function buildAggregate(entry, values, minT, maxT) {
  const sorted = values.slice().sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) {
    sum += v;
  }
  const count = sorted.length;
  const avg = count ? sum / count : null;

  return {
    name: entry.name,
    tags: entry.tags,
    count,
    sum,
    avg,
    min: sorted[0],
    max: sorted[count - 1],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    first: minT,
    last: maxT,
  };
}

/**
 * Convenience factory so callers can own an isolated collector instance.
 */
function createCollector(options) {
  return new MetricsCollector(options);
}

const defaultCollector = new MetricsCollector();

module.exports = defaultCollector;
module.exports.MetricsCollector = MetricsCollector;
module.exports.createCollector = createCollector;
module.exports.collect = defaultCollector.collect.bind(defaultCollector);
module.exports.query = defaultCollector.query.bind(defaultCollector);
module.exports.get = defaultCollector.get.bind(defaultCollector);
module.exports.reset = defaultCollector.reset.bind(defaultCollector);
module.exports.names = defaultCollector.names.bind(defaultCollector);
module.exports.health = defaultCollector.health.bind(defaultCollector);
module.exports.parseDuration = parseDuration;
module.exports.normalizeRange = normalizeRange;
module.exports.percentile = percentile;
module.exports.toNumber = toNumber;
