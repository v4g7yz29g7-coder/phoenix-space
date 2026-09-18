'use strict';

/**
 * anomaly_detector.js
 * Lightweight, dependency-free anomaly detection toolkit.
 *
 * Public API:
 *   detect(data, options) -> { anomalies, scores, stats, method }
 *
 * Supported methods (auto-selected when omitted):
 *   - 'zscore'   : standard / modified Z-score using MAD
 *   - 'iqr'      : Tukey fences
 *   - 'mad'      : median absolute deviation
 *   - 'percentile': top/bottom tail trimming
 *   - 'ewma'     : exponentially weighted moving average residuals
 */

const DEFAULTS = {
  method: 'auto',
  threshold: 3,
  alpha: 0.3,      // EWMA smoothing factor
  minSamples: 8,
  returnScores: true,
};

/* ----------------------------- math helpers ----------------------------- */

function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i];
  return s / xs.length;
}

function variance(xs, mu) {
  if (xs.length < 2) return 0;
  const m = mu === undefined ? mean(xs) : mu;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += (xs[i] - m) ** 2;
  return s / (xs.length - 1);
}

function stddev(xs, mu) {
  return Math.sqrt(variance(xs, mu));
}

function median(xs) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(xs, q) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (s[base + 1] !== undefined) {
    return s[base] + rest * (s[base + 1] - s[base]);
  }
  return s[base];
}

function mad(xs, med) {
  const m = med === undefined ? median(xs) : med;
  return median(xs.map((x) => Math.abs(x - m)));
}

/* ------------------------------ validators ------------------------------ */

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Accepts an array of numbers, or an array of objects with a value field.
 */
function extractValues(data, field) {
  if (!Array.isArray(data)) throw new TypeError('data must be an array');
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    let v;
    if (isNumber(item)) {
      v = item;
    } else if (item && typeof item === 'object') {
      v = field ? item[field] : item.value;
    }
    if (!isNumber(v)) {
      out.push(NaN);
    } else {
      out.push(v);
    }
  }
  return out;
}

/* ------------------------------ detectors ------------------------------- */

function detectZScore(values, opts) {
  const clean = values.filter(isNumber);
  const mu = mean(clean);
  const sd = stddev(clean, mu);
  const scores = values.map((v) => (isNumber(v) && sd > 0 ? (v - mu) / sd : 0));
  const anomalies = scores.map((s) => Math.abs(s) > opts.threshold);
  const med = median(clean);
  const md = mad(clean, med);
  const robust = values.map((v) =>
    isNumber(v) && md > 0 ? (0.6745 * (v - med)) / md : 0
  );
  return {
    scores,
    robust,
    anomalies,
    center: mu,
    spread: sd,
    method: 'zscore',
  };
}

function detectIQR(values, opts) {
  const clean = values.filter(isNumber);
  const q1 = quantile(clean, 0.25);
  const q3 = quantile(clean, 0.75);
  const iqr = q3 - q1;
  const k = opts.threshold;
  const lo = q1 - k * iqr;
  const hi = q3 + k * iqr;
  const scores = values.map((v) => {
    if (!isNumber(v)) return 0;
    if (v < lo) return (v - lo) / (iqr || 1);
    if (v > hi) return (v - hi) / (iqr || 1);
    return 0;
  });
  return {
    scores,
    anomalies: values.map((v) => isNumber(v) && (v < lo || v > hi)),
    center: median(clean),
    spread: iqr,
    bounds: { lo, hi },
    method: 'iqr',
  };
}

function detectMAD(values, opts) {
  const clean = values.filter(isNumber);
  const med = median(clean);
  const md = mad(clean, med);
  const scores = values.map((v) =>
    isNumber(v) && md > 0 ? Math.abs(v - med) / md : 0
  );
  return {
    scores,
    anomalies: scores.map((s) => s > opts.threshold),
    center: med,
    spread: md,
    method: 'mad',
  };
}

function detectPercentile(values, opts) {
  const clean = values.filter(isNumber);
  const lo = quantile(clean, 0.01);
  const hi = quantile(clean, 0.99);
  return {
    scores: values.map((v) =>
      isNumber(v) ? Math.max(0, v - hi, lo - v) : 0
    ),
    anomalies: values.map((v) => isNumber(v) && (v < lo || v > hi)),
    center: median(clean),
    spread: hi - lo,
    bounds: { lo, hi },
    method: 'percentile',
  };
}

function detectEWMA(values, opts) {
  const a = opts.alpha;
  let prev = null;
  const scores = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isNumber(v)) {
      scores.push(0);
      continue;
    }
    if (prev === null) {
      prev = v;
      scores.push(0);
      continue;
    }
    const pred = prev;
    const resid = v - pred;
    scores.push(Math.abs(resid));
    prev = a * v + (1 - a) * pred;
  }
  const clean = scores.filter(isNumber);
  const mu = mean(clean);
  const sd = stddev(clean, mu);
  const norm = scores.map((s) => (sd > 0 ? (s - mu) / sd : 0));
  return {
    scores: norm,
    anomalies: norm.map((s) => Math.abs(s) > opts.threshold),
    center: mu,
    spread: sd,
    method: 'ewma',
  };
}

/* --------------------------------- core --------------------------------- */

function autoSelect(values, opts) {
  const clean = values.filter(isNumber);
  if (clean.length < opts.minSamples) return 'mad';
  const md = mad(clean);
  const sd = stddev(clean);
  // Heavy tails inflate std -> prefer robust MAD.
  if (sd > 0 && md > 0 && sd / md > 1.6) return 'mad';
  return 'zscore';
}

function summarize(values, result) {
  const clean = values.filter(isNumber);
  return {
    count: values.length,
    valid: clean.length,
    missing: values.length - clean.length,
    min: clean.length ? Math.min(...clean) : null,
    max: clean.length ? Math.max(...clean) : null,
    mean: mean(clean),
    median: median(clean),
    stddev: stddev(clean),
    anomalies: result.anomalies.filter(Boolean).length,
  };
}

/**
 * Main entry point.
 * @param {Array} data
 * @param {Object} [options]
 * @returns {Object}
 */
function detect(data, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const field = opts.field;
  const values = extractValues(data, field);

  let method = opts.method;
  if (method === 'auto') method = autoSelect(values, opts);

  let result;
  switch (method) {
    case 'iqr':
      result = detectIQR(values, opts);
      break;
    case 'mad':
      result = detectMAD(values, opts);
      break;
    case 'percentile':
      result = detectPercentile(values, opts);
      break;
    case 'ewma':
      result = detectEWMA(values, opts);
      break;
    case 'zscore':
      result = detectZScore(values, opts);
      break;
    default:
      result = detectZScore(values, opts);
  }

  const indices = [];
  for (let i = 0; i < result.anomalies.length; i++) {
    if (result.anomalies[i]) indices.push(i);
  }

  const out = {
    method: result.method,
    indices,
    anomalies: indices.map((i) => data[i]),
    values: indices.map((i) => values[i]),
    stats: summarize(values, result),
  };
  if (opts.returnScores) out.scores = result.scores;
  return out;
}

module.exports = { detect };
module.exports.detect = detect;
