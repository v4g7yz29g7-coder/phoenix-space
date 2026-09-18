'use strict';

/**
 * sensors/sensor_fusion.js
 * ============================================================================
 * Multi-sensor data fusion engine for PHOENIX.
 *
 * Public API
 * ----------
 *   fuse(inputs) -> FusionResult
 *
 *   FusionResult = {
 *     ok:         boolean,
 *     strategy:   'scalar' | 'vector' | 'object' | 'gls' | 'none',
 *     value:      number | number[] | { ... } | null,
 *     variance:   number | number[] | { ... },
 *     confidence: number,          // 0..1
 *     details:    Detail[],        // per-sensor contribution
 *     diagnostics:{ ... },
 *     timestamp:  number           // epoch ms
 *   }
 *
 * Each input reading:
 *   {
 *     id:        string,                     // optional id
 *     type:      string,                     // 'gps' | 'imu' | 'lidar' | ...
 *     value:     number | number[] | {x,y,z, ...},
 *     variance:  number | number[] | {x:..,y:..},   // measurement noise
 *     weight:    number,                     // static trust weight
 *     quality:   number,                     // 0..1
 *     timestamp: number                      // epoch ms (optional)
 *   }
 *
 * The module is dependency-free and deterministic for a fixed input
 * (timestamps default to a captured `now` once per call).
 * ============================================================================
 */

const EPSILON = 1e-12;
const DEFAULT_VARIANCE = 1;
const DEFAULT_HALF_LIFE_MS = 5000;
const VERSION = '1.0.0';

/* ==========================================================================
 * 1. Numeric helpers
 * ========================================================================== */

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function clamp(value, lo, hi) {
  if (!isFiniteNumber(value)) return lo;
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function mean(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i += 1) s += arr[i];
  return s / arr.length;
}

function sum(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i += 1) s += arr[i];
  return s;
}

function varianceOf(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const m = mean(arr);
  let acc = 0;
  for (let i = 0; i < arr.length; i += 1) {
    const d = arr[i] - m;
    acc += d * d;
  }
  return acc / arr.length;
}

function stddevOf(arr) {
  return Math.sqrt(varianceOf(arr));
}

function sigmoid(x) {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

function vectorNorm(v) {
  let acc = 0;
  for (let i = 0; i < v.length; i += 1) acc += v[i] * v[i];
  return Math.sqrt(acc);
}

function isArrayLike(v) {
  return Array.isArray(v);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNumericObject(v) {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  for (let i = 0; i < keys.length; i += 1) {
    if (!isFiniteNumber(v[keys[i]])) return false;
  }
  return true;
}

function numericKeys(o) {
  return Object.keys(o).filter(function (k) {
    return isFiniteNumber(o[k]);
  });
}

function toNumberArray(v) {
  if (!isArrayLike(v)) return [];
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i += 1) {
    out[i] = isFiniteNumber(v[i]) ? v[i] : 0;
  }
  return out;
}

function round6(x) {
  return isFiniteNumber(x) ? Number(x.toFixed(6)) : x;
}

/* ==========================================================================
 * 2. Input normalization
 * ========================================================================== */

let _autoIdCounter = 0;

function normalizeInput(raw, index) {
  const r = isPlainObject(raw) ? raw : { value: raw };
  const idx = isFiniteNumber(index) ? index : 0;

  const baseName =
    typeof r.type === 'string' && r.type.length > 0 ? r.type : 'sensor';
  const id =
    typeof r.id === 'string' && r.id.length > 0
      ? r.id
      : baseName + '_' + idx + '_' + (_autoIdCounter += 1);

  let variance = r.variance;
  if (variance === undefined || variance === null || variance === '') {
    variance = DEFAULT_VARIANCE;
  }

  return {
    id: id,
    type: baseName,
    value: r.value,
    variance: variance,
    weight: clamp(isFiniteNumber(r.weight) ? r.weight : 1, 0, 1e6),
    quality: clamp(isFiniteNumber(r.quality) ? r.quality : 1, 0, 1),
    timestamp: isFiniteNumber(r.timestamp) ? r.timestamp : null,
    raw: r,
  };
}

function isUsable(reading) {
  const v = reading.value;
  if (isFiniteNumber(v)) return true;
  if (isArrayLike(v)) return v.length > 0;
  if (isPlainObject(v)) return numericKeys(v).length > 0;
  return false;
}

function normalizeInputs(inputs) {
  if (inputs === undefined || inputs === null) return [];
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const n = normalizeInput(list[i], i);
    if (isUsable(n)) out.push(n);
  }
  return out;
}

/* ==========================================================================
 * 3. Variance handling
 * ========================================================================== */

function scalarVariance(reading) {
  const v = reading.variance;
  if (isFiniteNumber(v)) return Math.max(v, EPSILON);
  if (isArrayLike(v) && v.length > 0) {
    let acc = 0;
    for (let i = 0; i < v.length; i += 1) {
      acc += isFiniteNumber(v[i]) ? v[i] : DEFAULT_VARIANCE;
    }
    return Math.max(acc / v.length, EPSILON);
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return DEFAULT_VARIANCE;
    let acc = 0;
    for (let i = 0; i < keys.length; i += 1) {
      acc += isFiniteNumber(v[keys[i]]) ? v[keys[i]] : DEFAULT_VARIANCE;
    }
    return Math.max(acc / keys.length, EPSILON);
  }
  return DEFAULT_VARIANCE;
}

function varianceVector(dim, variance) {
  const out = new Array(dim);
  if (isFiniteNumber(variance)) {
    for (let i = 0; i < dim; i += 1) out[i] = Math.max(variance, EPSILON);
    return out;
  }
  if (isArrayLike(variance)) {
    for (let i = 0; i < dim; i += 1) {
      out[i] = Math.max(isFiniteNumber(variance[i]) ? variance[i] : 1, EPSILON);
    }
    return out;
  }
  for (let i = 0; i < dim; i += 1) out[i] = DEFAULT_VARIANCE;
  return out;
}

/* ==========================================================================
 * 4. Strategy detection
 * ========================================================================== */

function detectStrategy(readings) {
  let scalar = 0;
  let vector = 0;
  let object = 0;
  let covarianceMatrix = false;

  for (let i = 0; i < readings.length; i += 1) {
    const v = readings[i].value;
    if (isFiniteNumber(v)) scalar += 1;
    else if (isArrayLike(v)) vector += 1;
    else if (isPlainObject(v)) object += 1;

    const varv = readings[i].variance;
    if (isArrayLike(varv) && varv.length > 0 && Array.isArray(varv[0])) {
      covarianceMatrix = true;
    }
  }

  if (readings.length === 0) return 'none';
  if (covarianceMatrix && vector > 0) return 'gls';
  if (object >= vector && object > 0) return 'object';
  if (vector > 0) return 'vector';
  return 'scalar';
}

/* ==========================================================================
 * 5. Effective weights & confidence
 * ========================================================================== */

function freshnessWeight(reading, nowMs) {
  if (!isFiniteNumber(reading.timestamp)) return 1;
  const age = Math.max(0, nowMs - reading.timestamp);
  return Math.pow(0.5, age / DEFAULT_HALF_LIFE_MS);
}

function effectiveWeight(reading, variance, nowMs) {
  const v = Math.max(isFiniteNumber(variance) ? variance : DEFAULT_VARIANCE, EPSILON);
  const precision = 1 / v;
  return reading.weight * precision * reading.quality *
    freshnessWeight(reading, nowMs);
}

function computeConfidence(totalPrecision, dispersion) {
  const base = 1 / (1 + 1 / Math.max(totalPrecision, EPSILON));
  const penalty = 1 / (1 + Math.max(dispersion, 0));
  return clamp(base * penalty, 0, 1);
}

/* ==========================================================================
 * 6. Outlier detection (modified z-score with MAD)
 * ========================================================================== */

function detectOutliers(readings, values) {
  const flags = new Array(readings.length).fill(false);
  if (!Array.isArray(values) || values.length < 3) return flags;
  const med = median(values);
  const deviations = values.map(function (v) {
    return Math.abs(v - med);
  });
  const mad = median(deviations);
  if (mad < EPSILON) return flags;
  for (let i = 0; i < values.length; i += 1) {
    const score = (0.6745 * (values[i] - med)) / mad;
    flags[i] = Math.abs(score) > 3.5;
  }
  return flags;
}

function median(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const s = arr.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/* ==========================================================================
 * 7. Scalar fusion (inverse-variance weighted average)
 * ========================================================================== */

function fuseScalar(readings, nowMs) {
  const weights = [];
  const values = [];
  const details = [];

  for (let i = 0; i < readings.length; i += 1) {
    const r = readings[i];
    const value = isFiniteNumber(r.value) ? r.value : 0;
    const variance = scalarVariance(r);
    const w = effectiveWeight(r, variance, nowMs);
    weights.push(w);
    values.push(value);
    details.push({
      id: r.id,
      type: r.type,
      value: round6(value),
      variance: round6(variance),
      weight: round6(w),
    });
  }

  const outliers = detectOutliers(readings, values);
  let totalW = 0;
  let acc = 0;
  for (let i = 0; i < readings.length; i += 1) {
    acc += values[i] * weights[i];
    totalW += weights[i];
  }
  if (totalW <= EPSILON) {
    return { ok: false, value: null, variance: 0, confidence: 0,
      details: details, outliers: outliers, fusedVariance: 0 };
  }
  const value = acc / totalW;
  const fusedVariance = 1 / totalW;

  let disp = 0;
  for (let i = 0; i < readings.length; i += 1) {
    const d = values[i] - value;
    disp += weights[i] * d * d;
  }
  disp = Math.sqrt(disp / totalW);

  return {
    ok: true,
    value: value,
    fusedVariance: fusedVariance,
    variance: fusedVariance,
    confidence: computeConfidence(totalW, disp),
    details: details,
    outliers: outliers,
  };
}

/* ==========================================================================
 * 8. Vector fusion (component-wise inverse-variance weighting)
 * ========================================================================== */

function fuseVector(readings, nowMs) {
  let dim = 0;
  for (let i = 0; i < readings.length; i += 1) {
    if (isArrayLike(readings[i].value)) {
      dim = Math.max(dim, readings[i].value.length);
    }
  }
  if (dim === 0) {
    return { ok: false, value: null, variance: null, confidence: 0,
      details: [], outliers: [], strategy: 'vector' };
  }

  const num = new Array(dim).fill(0);
  const den = new Array(dim).fill(0);
  const details = [];

  for (let i = 0; i < readings.length; i += 1) {
    const r = readings[i];
    if (!isArrayLike(r.value)) continue;
    const comps = toNumberArray(r.value);
    const vars = varianceVector(dim, r.variance);
    const w = effectiveWeight(r, mean(vars), nowMs);
    for (let d = 0; d < dim; d += 1) {
      const precision = (1 / vars[d]) * r.quality * freshnessWeight(r, nowMs) * r.weight;
      num[d] += (comps[d] || 0) * precision;
      den[d] += precision;
    }
    details.push({ id: r.id, type: r.type, value: comps, weight: round6(w) });
  }

  const value = new Array(dim);
  const variance = new Array(dim);
  let precisionSum = 0;
  let dispSum = 0;
  for (let d = 0; d < dim; d += 1) {
    if (den[d] <= EPSILON) {
      value[d] = 0;
      variance[d] = Infinity;
    } else {
      value[d] = num[d] / den[d];
      variance[d] = 1 / den[d];
      precisionSum += den[d];
    }
  }
  for (let i = 0; i < details.length; i += 1) {
    dispSum += Math.abs(vectorNorm(details[i].value) - vectorNorm(value));
  }

  return {
    ok: true,
    value: value,
    variance: variance,
    confidence: computeConfidence(precisionSum, dispSum / Math.max(details.length, 1)),
    details: details,
    outliers: new Array(details.length).fill(false),
    strategy: 'vector',
  };
}

/* ==========================================================================
 * 9. Object fusion ({x,y,z,...}: per-coordinate weighting)
 * ========================================================================== */

function fuseObject(readings, nowMs) {
  const keySet = {};
  for (let i = 0; i < readings.length; i += 1) {
    if (!isPlainObject(readings[i].value)) continue;
    const keys = numericKeys(readings[i].value);
    for (let k = 0; k < keys.length; k += 1) keySet[keys[k]] = true;
  }
  const keys = Object.keys(keySet);
  if (keys.length === 0) {
    return { ok: false, value: null, variance: null, confidence: 0,
      details: [], outliers: [], strategy: 'object' };
  }

  const num = {};
  const den = {};
  for (let k = 0; k < keys.length; k += 1) {
    num[keys[k]] = 0;
    den[keys[k]] = 0;
  }

  const details = [];
  for (let i = 0; i < readings.length; i += 1) {
    const r = readings[i];
    if (!isPlainObject(r.value)) continue;
    const vars = isPlainObject(r.variance) ? r.variance : {};
    const comps = {};
    for (let k = 0; k < keys.length; k += 1) {
      const key = keys[k];
      if (!isFiniteNumber(r.value[key])) continue;
      const v = isFiniteNumber(vars[key]) ? Math.max(vars[key], EPSILON) : DEFAULT_VARIANCE;
      const precision = (1 / v) * r.quality * freshnessWeight(r, nowMs) * r.weight;
      num[key] += r.value[key] * precision;
      den[key] += precision;
      comps[key] = r.value[key];
    }
    details.push({ id: r.id, type: r.type, value: comps,
      weight: round6(effectiveWeight(r, DEFAULT_VARIANCE, nowMs)) });
  }

  const value = {};
  const variance = {};
  let precisionSum = 0;
  for (let k = 0; k < keys.length; k += 1) {
    const key = keys[k];
    if (den[key] <= EPSILON) {
      value[key] = 0;
      variance[key] = Infinity;
    } else {
      value[key] = num[key] / den[key];
      variance[key] = 1 / den[key];
      precisionSum += den[key];
    }
  }

  return {
    ok: true,
    value: value,
    variance: variance,
    confidence: computeConfidence(precisionSum, 0),
    details: details,
    outliers: new Array(details.length).fill(false),
    strategy: 'object',
  };
}

/* ==========================================================================
 * 10. GLS fusion (generalized least squares, variance from covariance matrix)
 * ========================================================================== */

function fuseGLS(readings, nowMs) {
  if (readings.length === 0) {
    return { ok: false, value: null, confidence: 0, details: [], strategy: 'gls' };
  }
  let dim = 0;
  for (let i = 0; i < readings.length; i += 1) {
    if (isArrayLike(readings[i].value)) dim = Math.max(dim, readings[i].value.length);
  }
  if (dim === 0) return fuseVector(readings, nowMs);

  const precision = new Array(dim).fill(0);
  const num = new Array(dim).fill(0);
  const details = [];

  for (let i = 0; i < readings.length; i += 1) {
    const r = readings[i];
    if (!isArrayLike(r.value)) continue;
    const comps = toNumberArray(r.value);
    let vars = null;
    if (isArrayLike(r.variance) && isArrayLike(r.variance[0])) {
      vars = new Array(dim);
      for (let d = 0; d < dim; d += 1) {
        const row = r.variance[d];
        vars[d] = isArrayLike(row) && isFiniteNumber(row[d]) ? row[d] : DEFAULT_VARIANCE;
      }
    } else {
      vars = varianceVector(dim, r.variance);
    }
    const q = r.quality * freshnessWeight(r, nowMs) * r.weight;
    for (let d = 0; d < dim; d += 1) {
      const p = (1 / Math.max(vars[d], EPSILON)) * q;
      num[d] += comps[d] * p;
      precision[d] += p;
    }
    details.push({ id: r.id, type: r.type, value: comps, weight: round6(q) });
  }

  const value = new Array(dim);
  let precisionSum = 0;
  for (let d = 0; d < dim; d += 1) {
    value[d] = precision[d] > EPSILON ? num[d] / precision[d] : 0;
    precisionSum += precision[d];
  }
  return {
    ok: true,
    value: value,
    variance: precision.map(function (p) { return p > EPSILON ? 1 / p : Infinity; }),
    confidence: computeConfidence(precisionSum, 0),
    details: details,
    outliers: new Array(details.length).fill(false),
    strategy: 'gls',
  };
}

/* ==========================================================================
 * 11. Public fuse()
 * ========================================================================== */

function fuse(inputs, options) {
  const capturedNow = Date.now();
  const opts = isPlainObject(options) ? options : {};
  const strategyOverride =
    typeof opts.strategy === 'string' ? opts.strategy : null;

  const readings = normalizeInputs(inputs);

  if (readings.length === 0) {
    return {
      ok: false,
      strategy: 'none',
      value: null,
      variance: null,
      confidence: 0,
      details: [],
      diagnostics: { count: 0, outliers: [], message: 'no usable readings' },
      timestamp: capturedNow,
    };
  }

  const strategy = strategyOverride || detectStrategy(readings);

  let core;
  if (strategy === 'gls') core = fuseGLS(readings, capturedNow);
  else if (strategy === 'object') core = fuseObject(readings, capturedNow);
  else if (strategy === 'vector') core = fuseVector(readings, capturedNow);
  else core = fuseScalar(readings, capturedNow);

  if (!core.ok) {
    return {
      ok: false,
      strategy: strategy,
      value: null,
      variance: null,
      confidence: 0,
      details: core.details || [],
      diagnostics: { count: readings.length, outliers: core.outliers || [] },
      timestamp: capturedNow,
    };
  }

  return {
    ok: true,
    strategy: strategy,
    value: core.value,
    variance: core.variance,
    confidence: clamp(core.confidence, 0, 1),
    details: core.details,
    diagnostics: {
      count: readings.length,
      outliers: core.outliers || new Array(readings.length).fill(false),
      version: VERSION,
      strategy: strategy,
    },
    timestamp: capturedNow,
  };
}

/* ==========================================================================
 * 12. Windowed / streaming helper
 * ========================================================================== */

function fuseWindowed(history, windowSize, options) {
  const size = isFiniteNumber(windowSize) && windowSize > 0 ? windowSize : 10;
  const all = Array.isArray(history) ? history : [];
  const recent = all.slice(Math.max(0, all.length - size));
  return fuse(recent, options);
}

/* ==========================================================================
 * 13. Self-test & health
 * ========================================================================== */

function selfTest() {
  const checks = {};

  const scalar = fuse([
    { id: 'a', value: 10, variance: 1 },
    { id: 'b', value: 12, variance: 1 },
  ]);
  checks.scalarOk = scalar.ok === true;
  checks.scalarMean = Math.abs(scalar.value - 11) < 1e-9;

  const vector = fuse([
    { id: 'v1', value: [1, 2, 3], variance: [1, 1, 1] },
    { id: 'v2', value: [1.1, 2.2, 2.9], variance: [0.5, 0.5, 0.5] },
  ]);
  checks.vectorOk = vector.ok === true && vector.strategy === 'vector';
  checks.vectorDim = Array.isArray(vector.value) && vector.value.length === 3;

  const object = fuse([
    { id: 'o1', value: { x: 1, y: 2 }, variance: { x: 1, y: 1 } },
    { id: 'o2', value: { x: 3, y: 4 }, variance: { x: 1, y: 1 } },
  ]);
  checks.objectOk = object.ok === true && object.strategy === 'object';
  checks.objectX = Math.abs(object.value.x - 2) < 1e-9;

  const empty = fuse([]);
  checks.emptySafe = empty.ok === false;

  const robust = fuse([null, undefined, { value: 5, variance: 1 }, { value: null }]);
  checks.robustOk = robust.ok === true && Math.abs(robust.value - 5) < 1e-9;

  const d1 = fuse([{ value: 3, variance: 2 }, { value: 7, variance: 2 }]);
  const d2 = fuse([{ value: 3, variance: 2 }, { value: 7, variance: 2 }]);
  checks.deterministic = d1.value === d2.value;

  let allOk = true;
  const keys = Object.keys(checks);
  for (let i = 0; i < keys.length; i += 1) {
    if (checks[keys[i]] !== true) allOk = false;
  }

  return {
    ok: allOk,
    version: VERSION,
    checks: checks,
  };
}

function health() {
  const st = selfTest();
  return {
    ok: st.ok,
    version: VERSION,
    strategies: ['scalar', 'vector', 'object', 'gls'],
    selfTestPassed: st.ok,
    checks: st.checks,
  };
}

/* ==========================================================================
 * 14. Exports
 * ========================================================================== */

const SensorFusion = {
  fuse: fuse,
  fuseScalar: fuseScalar,
  fuseVector: fuseVector,
  fuseObject: fuseObject,
  fuseGLS: fuseGLS,
  fuseWindowed: fuseWindowed,
  detectStrategy: detectStrategy,
  detectOutliers: detectOutliers,
  normalizeInputs: normalizeInputs,
  normalizeInput: normalizeInput,
  computeConfidence: computeConfidence,
  selfTest: selfTest,
  health: health,
  VERSION: VERSION,
  _internals: {
    isFiniteNumber: isFiniteNumber,
    isPlainObject: isPlainObject,
    isNumericObject: isNumericObject,
    clamp: clamp,
    mean: mean,
    sum: sum,
    median: median,
    varianceOf: varianceOf,
    stddevOf: stddevOf,
    sigmoid: sigmoid,
    dot: dot,
    vectorNorm: vectorNorm,
    toNumberArray: toNumberArray,
    EPSILON: EPSILON,
  },
};

module.exports = SensorFusion;
module.exports.fuse = fuse;
module.exports.default = fuse;

if (typeof globalThis !== 'undefined') {
  globalThis.SensorFusion = SensorFusion;
}
