'use strict';

/**
 * observability/metrics_exporter.js
 *
 * Dependency-free exporter that renders in-memory metrics using the
 * Prometheus text exposition format (text/plain; version=0.0.4).
 *
 * Public API:
 *   const MetricsExporter = require('./observability/metrics_exporter');
 *   const exp = new MetricsExporter();
 *
 *   exp.counter('http_requests_total', 'Total HTTP requests');
 *   exp.gauge('queue_depth', 'Current queue depth');
 *
 *   exp.set('http_requests_total', 5);              // counter (monotonic)
 *   exp.set('queue_depth', 42);                     // gauge (any value)
 *   exp.set('http_requests_total', 6, { code: '200', method: 'GET' });
 *   exp.inc('http_requests_total', 1, { code: '200' });
 *
 *   exp.render();                                   // -> exposition string
 *   exp.contentType;                                // -> "text/plain; version=0.0.4; charset=utf-8"
 *
 * Format guarantees:
 *   - `# HELP <name> <escaped help>` and `# TYPE <name> <type>` headers.
 *   - Label values are escaped per the exposition spec (\\, \n, \").
 *   - Counters are monotonic: a lower value (e.g. -1) is a no-op.
 *   - Rendering an empty exporter yields a valid (empty) payload.
 */

const CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

const VALID_TYPES = new Set(['counter', 'gauge']);

/** Escape a HELP string: backslash and newline must be escaped. */
function escapeHelp(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n');
}

/** Escape a label value: backslash, double quote and newline. */
function escapeLabelValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/** Render a `{a="b",c="d"}` block, or '' when there are no labels. */
function formatLabels(labels) {
  const keys = Object.keys(labels || {}).sort();
  if (keys.length === 0) return '';
  const body = keys
    .map((k) => `${k}="${escapeLabelValue(labels[k])}"`)
    .join(',');
  return `{${body}}`;
}

/** Canonical, order-independent key for a label set. */
function labelKey(labels) {
  const keys = Object.keys(labels || {}).sort();
  return keys.map((k) => `${k}=${JSON.stringify(String(labels[k]))}`).join(',');
}

/** Render a numeric sample value the way Prometheus expects it. */
function formatValue(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '+Inf';
  if (n === -Infinity) return '-Inf';
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

class MetricsExporter {
  constructor(options = {}) {
    this._metrics = new Map(); // name -> { name, help, type, samples: Map<key,{labels,value}> }
    this.prefix = options.prefix || '';
  }

  /** Build the internal metric name (applies optional namespace prefix). */
  _qualified(name) {
    if (!name && name !== 0) {
      throw new TypeError('metric name is required');
    }
    const n = String(name);
    return this.prefix ? `${this.prefix}${n}` : n;
  }

  /**
   * Declare a counter. Counters only ever increase; setting a lower value is
   * ignored (no-op). Returns the (possibly qualified) metric name.
   */
  counter(name, help) {
    return this._declare(name, help, 'counter');
  }

  /** Declare a gauge. Gauges may go up and down freely. */
  gauge(name, help) {
    return this._declare(name, help, 'gauge');
  }

  _declare(name, help, type) {
    if (!VALID_TYPES.has(type)) {
      throw new TypeError(`unsupported metric type: ${type}`);
    }
    const qualified = this._qualified(name);
    let metric = this._metrics.get(qualified);
    if (!metric) {
      metric = { name: qualified, help: help === undefined ? '' : String(help), type, samples: new Map() };
      if (type === 'counter') {
        // Counters start at 0 so an attempted negative write stays a no-op
        // (the counter simply remains at its baseline).
        metric.samples.set('', { labels: {}, value: 0, baseline: true });
      }
      this._metrics.set(qualified, metric);
    } else if (help !== undefined && metric.help === '') {
      metric.help = String(help);
    }
    return qualified;
  }

  /**
   * Set the value of a metric sample.
   *
   * For counters the write is monotonic: a value below the current value
   * (or any negative value when unset) is a no-op. For gauges any numeric
   * value is accepted. If the metric was never declared it is auto-created
   * as a gauge.
   */
  set(name, value, labels) {
    const qualified = this._qualified(name);
    let metric = this._metrics.get(qualified);
    if (!metric) {
      metric = { name: qualified, help: '', type: 'gauge', samples: new Map() };
      this._metrics.set(qualified, metric);
    }

    const numeric = typeof value === 'number' ? value : Number(value);
    const key = labelKey(labels);
    const prev = metric.samples.get(key);

    if (metric.type === 'counter') {
      // Monotonic: ignore NaN, decreases and negatives entirely (no-op).
      if (Number.isNaN(numeric)) return this;
      const current = prev ? prev.value : 0;
      if (numeric < current) return this; // e.g. -1 on a fresh counter -> no-op
      // A labeled sample supersedes the auto-created 0 baseline.
      const baseline = metric.samples.get('');
      if (key !== '' && baseline && baseline.baseline && baseline.value === 0) {
        metric.samples.delete('');
      }
    }

    metric.samples.set(key, { labels: Object.assign({}, labels), value: numeric, baseline: false });
    return this;
  }

  /**
   * Increment a counter by `amount` (default 1). Negative or NaN deltas are
   * no-ops, guaranteeing a counter never decreases.
   */
  inc(name, amount, labels) {
    const delta = amount === undefined ? 1 : amount;
    const n = typeof delta === 'number' ? delta : Number(delta);
    if (!Number.isFinite(n) || n < 0) return this; // negative increment -> no-op
    const qualified = this._qualified(name);
    const metric = this._metrics.get(qualified);
    const current = metric ? (metric.samples.get(labelKey(labels)) || { value: 0 }).value : 0;
    return this.set(qualified, current + n, labels);
  }

  /** Read the current value of a sample, or undefined when absent. */
  get(name, labels) {
    const metric = this._metrics.get(this._qualified(name));
    if (!metric) return undefined;
    const sample = metric.samples.get(labelKey(labels));
    if (sample) return sample.value;
    // An unset counter still conceptually holds its baseline (0).
    return metric.type === 'counter' ? 0 : undefined;
  }

  /** True when the metric has been declared. */
  has(name) {
    return this._metrics.has(this._qualified(name));
  }

  /** Remove all samples (and declaration) for a metric. */
  remove(name) {
    return this._metrics.delete(this._qualified(name));
  }

  /** Drop every metric. */
  clear() {
    this._metrics.clear();
    return this;
  }

  /** Plain snapshot of the registered metrics (useful for tests/JSON). */
  snapshot() {
    const out = {};
    for (const metric of this._metrics.values()) {
      out[metric.name] = {
        type: metric.type,
        help: metric.help,
        samples: Array.from(metric.samples.values()).map((s) => ({
          labels: Object.assign({}, s.labels),
          value: s.value,
        })),
      };
    }
    return out;
  }

  /**
   * Render all metrics in the Prometheus text exposition format.
   * An empty exporter renders to an empty string, which is a valid payload.
   */
  render() {
    const names = Array.from(this._metrics.keys()).sort();
    const lines = [];

    for (const name of names) {
      const metric = this._metrics.get(name);
      const help = metric.help === undefined ? '' : metric.help;
      lines.push(`# HELP ${name} ${escapeHelp(help)}`);
      lines.push(`# TYPE ${name} ${metric.type}`);

      const samples = Array.from(metric.samples.entries())
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

      for (const [, sample] of samples) {
        lines.push(`${name}${formatLabels(sample.labels)} ${formatValue(sample.value)}`);
      }
    }

    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  }

  /** Alias so `String(exp)` / template literals produce the payload. */
  toString() {
    return this.render();
  }
}

MetricsExporter.CONTENT_TYPE = CONTENT_TYPE;
MetricsExporter.escapeHelp = escapeHelp;
MetricsExporter.escapeLabelValue = escapeLabelValue;
MetricsExporter.formatLabels = formatLabels;
MetricsExporter.formatValue = formatValue;
MetricsExporter.labelKey = labelKey;

module.exports = MetricsExporter;
module.exports.MetricsExporter = MetricsExporter;
module.exports.CONTENT_TYPE = CONTENT_TYPE;
module.exports.escapeHelp = escapeHelp;
module.exports.escapeLabelValue = escapeLabelValue;
module.exports.formatLabels = formatLabels;
module.exports.formatValue = formatValue;

// Allow `node observability/metrics_exporter.js` to print a demo payload.
if (require.main === module) {
  const exp = new MetricsExporter();
  exp.counter('demo_requests_total', 'Demo counter');
  exp.gauge('demo_temperature_celsius', 'Demo gauge');
  exp.inc('demo_requests_total', 3, { route: '/api', method: 'GET' });
  exp.set('demo_temperature_celsius', 21.5);
  /* eslint-disable no-console */
  console.log(exp.render());
  /* eslint-enable no-console */
}
