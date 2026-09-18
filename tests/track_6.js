#!/usr/bin/env node
'use strict';

/**
 * tests/track_6.js — Track #6: rolling metrics, rate limiting & histograms.
 * ============================================================================
 * ZERO external dependencies. Runs on a bare Node.js runtime (>= 12) with no
 * jest / mocha / chai installed, and ships its own tiny BDD harness:
 *
 *     describe(name, fn)      group related tests together
 *     it(name, fn)            a single (possibly async) test case
 *     it.skip(name, fn)       mark a test as pending
 *     beforeEach(fn)          per-test setup
 *     afterEach(fn)           per-test teardown
 *     assert.*                a small, self-contained assertion library
 *
 * Units under test (all pure and self-contained):
 *
 *     SlidingWindow       fixed-capacity ring of recent numeric samples
 *     EWMA                exponentially weighted moving average
 *     RateCounter         time-windowed event counter / throughput meter
 *     Histogram           bucketed distribution with summary statistics
 *     AnomalyDetector     z-score outlier flagger built on SlidingWindow
 *     mean / stddev       small numeric helpers
 *
 * Usage:
 *     node tests/track_6.js            # run the whole suite
 *     node --check tests/track_6.js    # syntax check only
 *
 * The process exit code is 0 when every executed test passes and 1 otherwise.
 * ============================================================================
 */

/* ===========================================================================
 * 1. Tiny assertion library
 * ========================================================================= */

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
    this.isAssertionError = true;
  }
}

const assert = {
  fail(message) {
    throw new AssertionError(message || 'assert.fail()');
  },

  ok(value, message) {
    if (!value) {
      throw new AssertionError(message || `expected ${value} to be truthy`);
    }
  },

  equal(actual, expected, message) {
    if (actual != expected) { // eslint-disable-line eqeqeq
      throw new AssertionError(message || `expected ${actual} == ${expected}`);
    }
  },

  strictEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new AssertionError(message || `expected ${actual} === ${expected}`);
    }
  },

  notStrictEqual(actual, expected, message) {
    if (actual === expected) {
      throw new AssertionError(message || `expected ${actual} !== ${expected}`);
    }
  },

  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new AssertionError(message || `expected ${a} to deep-equal ${b}`);
    }
  },

  closeTo(actual, expected, epsilon, message) {
    const tol = epsilon === undefined ? 1e-9 : epsilon;
    if (!(Math.abs(actual - expected) <= tol)) {
      throw new AssertionError(
        message || `expected ${actual} to be within ${tol} of ${expected}`
      );
    }
  },

  isNaN(value, message) {
    if (!Number.isNaN(value)) {
      throw new AssertionError(message || `expected ${value} to be NaN`);
    }
  },

  throws(fn, matcher, message) {
    let threw = false;
    let error = null;
    try {
      fn();
    } catch (err) {
      threw = true;
      error = err;
    }
    if (!threw) {
      throw new AssertionError(message || 'expected function to throw');
    }
    if (matcher instanceof RegExp) {
      if (!matcher.test(String((error && error.message) || error))) {
        throw new AssertionError(
          message || `expected error "${error && error.message}" to match ${matcher}`
        );
      }
    } else if (typeof matcher === 'function' && !(error instanceof matcher)) {
      throw new AssertionError(message || 'error had the wrong type');
    }
    return error;
  },

  doesNotThrow(fn, message) {
    try {
      return fn();
    } catch (err) {
      throw new AssertionError(message || `expected function not to throw: ${err.message}`);
    }
  },

  async rejects(promise, matcher, message) {
    let rejected = false;
    let error = null;
    try {
      await promise;
    } catch (err) {
      rejected = true;
      error = err;
    }
    if (!rejected) {
      throw new AssertionError(message || 'expected promise to reject');
    }
    if (matcher instanceof RegExp && !matcher.test(String(error && error.message))) {
      throw new AssertionError(message || 'rejection did not match');
    }
    return error;
  },
};

/* ===========================================================================
 * 2. Minimal BDD harness
 * ========================================================================= */

const suites = [];
const summary = { passed: 0, failed: 0, skipped: 0, cases: [] };
let current = null;

function makeSuite(name) {
  const suite = { name: name, tests: [], beforeEach: [], afterEach: [] };
  suites.push(suite);
  return suite;
}

function describe(name, fn) {
  const suite = makeSuite(name);
  const previous = current;
  current = suite;
  try {
    fn();
  } finally {
    current = previous;
  }
  return suite;
}

function ensureSuite() {
  if (!current) current = makeSuite('');
  return current;
}

function it(name, fn) {
  ensureSuite().tests.push({ name, fn, skip: false });
}

it.skip = function skip(name, fn) {
  ensureSuite().tests.push({ name, fn, skip: true });
};

function beforeEach(fn) {
  ensureSuite().beforeEach.push(fn);
}

function afterEach(fn) {
  ensureSuite().afterEach.push(fn);
}

async function run() {
  for (const suite of suites) {
    for (const testCase of suite.tests) {
      const label = suite.name ? `${suite.name} > ${testCase.name}` : testCase.name;
      if (testCase.skip) {
        summary.skipped += 1;
        summary.cases.push({ name: label, status: 'skipped' });
        continue;
      }
      try {
        for (const hook of suite.beforeEach) await hook();
        await testCase.fn();
        summary.passed += 1;
        summary.cases.push({ name: label, status: 'passed' });
      } catch (err) {
        summary.failed += 1;
        summary.cases.push({
          name: label,
          status: 'failed',
          error: (err && err.message) || String(err),
        });
      } finally {
        for (const hook of suite.afterEach) {
          try {
            await hook();
          } catch (_ignored) {
            /* teardown errors must not mask the test result */
          }
        }
      }
    }
  }
  return summary.failed === 0;
}

function report() {
  const total = summary.passed + summary.failed;
  const lines = [`track_6: ${summary.passed}/${total} passed (${summary.skipped} skipped)`];
  for (const c of summary.cases) {
    const mark = c.status === 'passed' ? 'ok  ' : c.status === 'skipped' ? 'skip' : 'FAIL';
    lines.push(`  [${mark}] ${c.name}${c.error ? ' -> ' + c.error : ''}`);
  }
  return lines.join('\n');
}

/* ===========================================================================
 * 3. Units under test
 * ========================================================================= */

/** Population mean of a numeric array. */
function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Population standard deviation of a numeric array. */
function stddev(values) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const mu = mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - mu;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

function finiteNumber(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return n;
}

/**
 * Fixed-capacity ring of the most recent numeric samples. Adding beyond the
 * capacity evicts the oldest value, so every statistic reflects a rolling
 * window rather than the whole history.
 */
class SlidingWindow {
  constructor(capacity = 60) {
    if (!(capacity > 0)) {
      throw new RangeError('capacity must be a positive integer');
    }
    this.capacity = Math.floor(capacity);
    this._buffer = [];
  }

  get size() {
    return this._buffer.length;
  }

  add(value) {
    this._buffer.push(finiteNumber(value, 'value'));
    while (this._buffer.length > this.capacity) this._buffer.shift();
    return this;
  }

  toArray() {
    return this._buffer.slice();
  }

  sum() {
    let total = 0;
    for (const v of this._buffer) total += v;
    return total;
  }

  avg() {
    return this._buffer.length ? this.sum() / this._buffer.length : NaN;
  }

  min() {
    return this._buffer.length ? Math.min.apply(null, this._buffer) : NaN;
  }

  max() {
    return this._buffer.length ? Math.max.apply(null, this._buffer) : NaN;
  }

  variance() {
    if (!this._buffer.length) return NaN;
    const mu = this.avg();
    let acc = 0;
    for (const v of this._buffer) {
      const d = v - mu;
      acc += d * d;
    }
    return acc / this._buffer.length;
  }

  stddev() {
    return Math.sqrt(this.variance());
  }

  /**
   * Linear-interpolated percentile. `p` is expressed on a 0..100 scale.
   */
  percentile(p) {
    if (typeof p !== 'number' || p < 0 || p > 100) {
      throw new RangeError('p must be between 0 and 100');
    }
    const n = this._buffer.length;
    if (n === 0) return NaN;
    const sorted = this._buffer.slice().sort((a, b) => a - b);
    if (n === 1) return sorted[0];
    const rank = (p / 100) * (n - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    if (lower === upper) return sorted[lower];
    const weight = rank - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
  }

  clear() {
    this._buffer.length = 0;
    return this;
  }
}

/**
 * Exponentially weighted moving average. The first observation seeds the
 * average; every later observation blends `alpha` of the new sample with the
 * previous average.
 */
class EWMA {
  constructor(alpha = 0.3) {
    if (typeof alpha !== 'number' || !(alpha > 0) || !(alpha <= 1)) {
      throw new RangeError('alpha must be a number in (0, 1]');
    }
    this.alpha = alpha;
    this.value = NaN;
    this.count = 0;
  }

  update(sample) {
    const x = finiteNumber(sample, 'sample');
    this.count += 1;
    this.value = this.count === 1 ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }

  peek() {
    return this.value;
  }

  reset() {
    this.value = NaN;
    this.count = 0;
    return this;
  }
}

/**
 * Counts events inside a sliding time window. A pluggable `clock` keeps the
 * counter deterministic in tests.
 */
class RateCounter {
  constructor(windowMs = 1000, clock = Date.now) {
    if (!(windowMs > 0)) {
      throw new RangeError('windowMs must be greater than zero');
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function returning a timestamp');
    }
    this.windowMs = windowMs;
    this.clock = clock;
    this._events = [];
  }

  _prune(now) {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this._events.length && this._events[drop] <= cutoff) drop += 1;
    if (drop) this._events.splice(0, drop);
  }

  hit(timestamp) {
    const ts = timestamp === undefined
      ? finiteNumber(this.clock(), 'clock()')
      : finiteNumber(timestamp, 'timestamp');
    this._events.push(ts);
    this._prune(ts);
    return this;
  }

  count() {
    this._prune(finiteNumber(this.clock(), 'clock()'));
    return this._events.length;
  }

  /** Events per second inside the configured window. */
  rate() {
    return this.count() / (this.windowMs / 1000);
  }

  reset() {
    this._events.length = 0;
    return this;
  }
}

/**
 * Bucketed distribution. `bounds` are the inclusive upper edges of each
 * bucket; the final overflow bucket collects everything above the last bound.
 */
class Histogram {
  constructor(bounds = []) {
    if (!Array.isArray(bounds)) {
      throw new TypeError('bounds must be an array');
    }
    for (let i = 0; i < bounds.length; i += 1) {
      const b = finiteNumber(bounds[i], 'bound');
      if (i > 0 && b <= bounds[i - 1]) {
        throw new RangeError('bounds must be strictly increasing');
      }
    }
    this.bounds = bounds.slice();
    this.counts = new Array(bounds.length + 1).fill(0);
    this.total = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
  }

  _bucketFor(value) {
    for (let i = 0; i < this.bounds.length; i += 1) {
      if (value <= this.bounds[i]) return i;
    }
    return this.bounds.length;
  }

  observe(value) {
    const n = finiteNumber(value, 'value');
    const bucket = this._bucketFor(n);
    this.counts[bucket] += 1;
    this.total += 1;
    this._sum += n;
    if (n < this._min) this._min = n;
    if (n > this._max) this._max = n;
    return bucket;
  }

  bucketCount(index) {
    if (index < 0 || index >= this.counts.length) return 0;
    return this.counts[index];
  }

  sum() {
    return this._sum;
  }

  mean() {
    return this.total ? this._sum / this.total : NaN;
  }

  min() {
    return this.total ? this._min : NaN;
  }

  max() {
    return this.total ? this._max : NaN;
  }

  reset() {
    this.counts = new Array(this.bounds.length + 1).fill(0);
    this.total = 0;
    this._sum = 0;
    this._min = Infinity;
    this._max = -Infinity;
    return this;
  }

  snapshot() {
    return {
      bounds: this.bounds.slice(),
      counts: this.counts.slice(),
      total: this.total,
      sum: this._sum,
      mean: this.mean(),
      min: this.min(),
      max: this.max(),
    };
  }
}

/**
 * Flags samples whose z-score against the preceding window exceeds a
 * threshold. The incoming sample is scored against history *before* it is
 * folded into the window, so a single spike cannot hide itself.
 */
class AnomalyDetector {
  constructor(windowSize = 30, threshold = 3) {
    if (!(threshold > 0)) {
      throw new RangeError('threshold must be greater than zero');
    }
    this.threshold = threshold;
    this.window = new SlidingWindow(windowSize);
  }

  observe(sample) {
    const n = finiteNumber(sample, 'sample');
    let z = 0;
    let anomaly = false;
    if (this.window.size >= 2) {
      const sd = this.window.stddev();
      if (sd > 0) {
        z = (n - this.window.avg()) / sd;
        anomaly = Math.abs(z) > this.threshold;
      }
    }
    this.window.add(n);
    return { value: n, z, anomaly };
  }

  reset() {
    this.window.clear();
    return this;
  }
}

/* ===========================================================================
 * 4. Tests
 * ========================================================================= */

describe('numeric helpers', () => {
  it('computes the mean of a sample', () => {
    assert.strictEqual(mean([1, 2, 3, 4]), 2.5);
    assert.isNaN(mean([]));
  });

  it('computes the population standard deviation', () => {
    assert.closeTo(stddev([2, 4, 4, 4, 5, 5, 7, 9]), 2, 1e-12);
    assert.isNaN(stddev([]));
  });
});

describe('SlidingWindow', () => {
  it('evicts the oldest value past capacity', () => {
    const w = new SlidingWindow(3);
    w.add(1).add(2).add(3).add(4);
    assert.deepEqual(w.toArray(), [2, 3, 4]);
    assert.strictEqual(w.size, 3);
    assert.strictEqual(w.sum(), 9);
  });

  it('reports average, min and max', () => {
    const w = new SlidingWindow(5);
    [1, 2, 3].forEach((v) => w.add(v));
    assert.strictEqual(w.avg(), 2);
    assert.strictEqual(w.min(), 1);
    assert.strictEqual(w.max(), 3);
  });

  it('returns NaN statistics for an empty window', () => {
    const w = new SlidingWindow(4);
    assert.isNaN(w.avg());
    assert.isNaN(w.min());
    assert.isNaN(w.max());
    assert.isNaN(w.percentile(50));
  });

  it('interpolates percentiles linearly', () => {
    const w = new SlidingWindow(10);
    [1, 2, 3, 4].forEach((v) => w.add(v));
    assert.strictEqual(w.percentile(0), 1);
    assert.strictEqual(w.percentile(100), 4);
    assert.strictEqual(w.percentile(50), 2.5);
    assert.closeTo(w.percentile(25), 1.75, 1e-12);
  });

  it('computes variance and standard deviation', () => {
    const w = new SlidingWindow(10);
    [1, 2, 3, 4, 5].forEach((v) => w.add(v));
    assert.closeTo(w.variance(), 2, 1e-12);
    assert.closeTo(w.stddev(), Math.sqrt(2), 1e-12);
  });

  it('can be cleared', () => {
    const w = new SlidingWindow(2);
    w.add(7);
    assert.strictEqual(w.clear().size, 0);
  });

  it('rejects invalid construction and samples', () => {
    assert.throws(() => new SlidingWindow(0), /positive/);
    const w = new SlidingWindow(2);
    assert.throws(() => w.add(NaN), /finite/);
    assert.throws(() => w.add('abc'), /finite/);
    assert.throws(() => w.percentile(101), /between 0 and 100/);
  });
});

describe('EWMA', () => {
  it('seeds on the first sample and blends afterwards', () => {
    const e = new EWMA(0.5);
    assert.strictEqual(e.update(10), 10);
    assert.strictEqual(e.update(20), 15);
    assert.strictEqual(e.update(30), 22.5);
    assert.strictEqual(e.count, 3);
  });

  it('honours the configured alpha', () => {
    const e = new EWMA(0.25);
    e.update(100);
    assert.strictEqual(e.update(0), 75);
    assert.strictEqual(e.peek(), 75);
  });

  it('validates alpha and samples', () => {
    assert.throws(() => new EWMA(0), /alpha/);
    assert.throws(() => new EWMA(1.5), /alpha/);
    const e = new EWMA();
    assert.throws(() => e.update(Infinity), /finite/);
  });

  it('resets to an empty state', () => {
    const e = new EWMA(0.5);
    e.update(42);
    e.reset();
    assert.isNaN(e.peek());
    assert.strictEqual(e.count, 0);
  });
});

describe('RateCounter', () => {
  let clock;
  let counter;

  beforeEach(() => {
    clock = 0;
    counter = new RateCounter(1000, () => clock);
  });

  it('counts events inside the window', () => {
    counter.hit();          // t = 0
    clock = 400;
    counter.hit();          // t = 400
    assert.strictEqual(counter.count(), 2);
    assert.strictEqual(counter.rate(), 2);
  });

  it('drops events older than the window', () => {
    counter.hit();          // t = 0
    clock = 400;
    counter.hit();          // t = 400
    clock = 1200;
    assert.strictEqual(counter.count(), 1);
    assert.strictEqual(counter.rate(), 1);
    clock = 2000;
    assert.strictEqual(counter.count(), 0);
  });

  it('scales the rate by the window length', () => {
    const fast = new RateCounter(500, () => clock);
    fast.hit();
    clock = 100;
    fast.hit();
    assert.strictEqual(fast.rate(), 4); // 2 events / 0.5s
  });

  it('accepts explicit timestamps', () => {
    const c = new RateCounter(1000, () => 5000);
    c.hit(4500).hit(4800);
    assert.strictEqual(c.count(), 2);
  });

  it('validates configuration', () => {
    assert.throws(() => new RateCounter(0), /greater than zero/);
    assert.throws(() => new RateCounter(1000, null), /clock/);
  });
});

describe('Histogram', () => {
  let h;

  beforeEach(() => {
    h = new Histogram([10, 20, 30]);
  });

  it('assigns values to the correct buckets', () => {
    assert.strictEqual(h.observe(5), 0);
    assert.strictEqual(h.observe(10), 0); // inclusive upper edge
    assert.strictEqual(h.observe(15), 1);
    assert.strictEqual(h.observe(25), 2);
    assert.strictEqual(h.observe(35), 3); // overflow bucket
    assert.deepEqual(h.counts, [2, 1, 1, 1]);
  });

  it('tracks summary statistics', () => {
    [5, 15, 25, 35].forEach((v) => h.observe(v));
    assert.strictEqual(h.total, 4);
    assert.strictEqual(h.sum(), 80);
    assert.strictEqual(h.mean(), 20);
    assert.strictEqual(h.min(), 5);
    assert.strictEqual(h.max(), 35);
  });

  it('exposes out-of-range bucket queries as zero', () => {
    h.observe(5);
    assert.strictEqual(h.bucketCount(99), 0);
    assert.strictEqual(h.bucketCount(-1), 0);
  });

  it('produces a snapshot that is safe to mutate', () => {
    h.observe(5);
    const snap = h.snapshot();
    snap.counts[0] = 999;
    assert.strictEqual(h.counts[0], 1);
    assert.deepEqual(snap.bounds, [10, 20, 30]);
  });

  it('can be reset', () => {
    h.observe(5);
    h.observe(15);
    h.reset();
    assert.strictEqual(h.total, 0);
    assert.isNaN(h.mean());
    assert.strictEqual(h.bucketCount(0), 0);
  });

  it('validates bounds and samples', () => {
    assert.throws(() => new Histogram([10, 5]), /increasing/);
    assert.throws(() => new Histogram('nope'), /array/);
    assert.throws(() => h.observe('abc'), /finite/);
  });
});

describe('AnomalyDetector', () => {
  it('flags a value that is several deviations out', () => {
    const d = new AnomalyDetector(10, 2);
    // A low-variance history so the z-score of the spike is meaningful.
    [10, 11, 10, 11, 10].forEach((v) => d.observe(v));
    const spike = d.observe(20);
    assert.strictEqual(spike.anomaly, true);
    assert.ok(spike.z > 2);
  });

  it('does not flag a value near the running mean', () => {
    const d = new AnomalyDetector(10, 2);
    [10, 11, 10, 11, 10].forEach((v) => d.observe(v));
    const steady = d.observe(10);
    assert.strictEqual(steady.anomaly, false);
    assert.ok(Math.abs(steady.z) < 1);
  });

  it('stays quiet until it has enough history', () => {
    const d = new AnomalyDetector(10, 2);
    assert.strictEqual(d.observe(1000).anomaly, false);
    assert.strictEqual(d.observe(-1000).anomaly, false);
  });

  it('validates its configuration', () => {
    assert.throws(() => new AnomalyDetector(10, 0), /threshold/);
  });
});

/* ===========================================================================
 * 5. Entry point
 * ========================================================================= */

if (require.main === module) {
  run()
    .then((ok) => {
      process.stdout.write(report() + '\n');
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err) => {
      process.stderr.write('track_6: fatal error\n' + (err && err.stack ? err.stack : err) + '\n');
      process.exitCode = 1;
    });
}

module.exports = {
  SlidingWindow,
  EWMA,
  RateCounter,
  Histogram,
  AnomalyDetector,
  mean,
  stddev,
  describe,
  it,
  beforeEach,
  afterEach,
  run,
  report,
  summary,
  assert,
};
