'use strict';

/**
 * tests/track_5.js
 * ---------------------------------------------------------------------------
 * Track 5 — concurrency & resilience primitives (dependency-free).
 *
 * Units under test:
 *
 *   Semaphore          counting semaphore with FIFO fairness
 *   TaskQueue          bounded-concurrency priority task runner
 *   retry(fn, opts)    exponential backoff + full jitter + retry budget
 *   CircuitBreaker     closed / open / half-open state machine
 *   TokenBucket        token-bucket rate limiter
 *   withTimeout(p,ms)  promise timeout guard
 *   deferred()         external resolve/reject handle
 *   memoizeTTL(fn,ms)  memoization with per-entry expiry
 *
 * Everything is pure Node.js. No external dependencies are required, which
 * keeps this file trivially valid for `node --check` and runnable anywhere.
 *
 * Run:  node tests/track_5.js
 */

const assert = require('assert');

/* ========================================================================== */
/* Minimal test harness                                                        */
/* ========================================================================== */

const results = { passed: 0, failed: 0, cases: [] };
const pending = [];

function pass(name) {
  results.passed += 1;
  results.cases.push({ name, status: 'passed' });
}

function fail(name, err) {
  results.failed += 1;
  results.cases.push({
    name,
    status: 'failed',
    error: (err && err.stack) || (err && err.message) || String(err),
  });
}

function test(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(name, err);
  }
  return fn;
}

function testAsync(name, fn) {
  const p = (async () => {
    try {
      await fn();
      pass(name);
    } catch (err) {
      fail(name, err);
    }
  })();
  pending.push(p);
  return p;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function report() {
  const lines = [];
  lines.push('track_5: ' + results.passed + ' passed, ' + results.failed + ' failed');
  for (const c of results.cases) {
    if (c.status === 'failed') {
      lines.push('  FAIL  ' + c.name);
      if (c.error) lines.push('        ' + String(c.error).split('\n')[0]);
    }
  }
  return lines.join('\n');
}

/* ========================================================================== */
/* Semaphore — counting concurrency gate with FIFO waiters                     */
/* ========================================================================== */

class Semaphore {
  constructor(limit) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError('Semaphore: limit must be a positive integer');
    }
    this.limit = limit;
    this.active = 0;
    this._queue = [];
  }

  get available() {
    return this.limit - this.active;
  }

  get waiting() {
    return this._queue.length;
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this._release.bind(this));
    }
    return new Promise((resolve) => {
      this._queue.push(resolve);
    });
  }

  _release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      // Slot is handed directly to the next waiter; active count is unchanged.
      next(this._release.bind(this));
    } else {
      this.active -= 1;
    }
  }

  async run(fn) {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/* ========================================================================== */
/* TaskQueue — bounded-concurrency, priority-aware task runner                 */
/* ========================================================================== */

class TaskQueue {
  constructor(concurrency) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new TypeError('TaskQueue: concurrency must be a positive integer');
    }
    this.concurrency = concurrency;
    this.running = 0;
    this._queue = [];
    this._seq = 0;
    this._draining = false;
    this._onIdle = [];
  }

  get size() {
    return this._queue.length;
  }

  get pending() {
    return this.running + this._queue.length;
  }

  add(fn, priority) {
    priority = typeof priority === 'number' ? priority : 0;
    return new Promise((resolve, reject) => {
      const task = { fn, priority, seq: this._seq++, resolve, reject };
      this._queue.push(task);
      this._sort();
      this._pump();
    });
  }

  _sort() {
    // Higher priority first; FIFO within equal priority.
    this._queue.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
  }

  _pump() {
    while (this.running < this.concurrency && this._queue.length > 0) {
      const task = this._queue.shift();
      this.running += 1;
      Promise.resolve()
        .then(() => task.fn())
        .then(task.resolve, task.reject)
        .finally(() => {
          this.running -= 1;
          this._pump();
          if (this.pending === 0) this._settle();
        });
    }
    if (this.pending === 0) this._settle();
  }

  onIdle() {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this._onIdle.push(resolve));
  }

  _settle() {
    const waiters = this._onIdle;
    this._onIdle = [];
    for (const w of waiters) w();
  }
}

/* ========================================================================== */
/* retry — exponential backoff with full jitter and retry budget               */
/* ========================================================================== */

function defaultIsRetryable(err) {
  return !(err && err.retryable === false);
}

async function retry(fn, opts) {
  opts = opts || {};
  const retries = opts.retries == null ? 3 : opts.retries;
  const base = opts.base == null ? 10 : opts.base;
  const maxDelay = opts.maxDelay == null ? 1000 : opts.maxDelay;
  const factor = opts.factor == null ? 2 : opts.factor;
  const jitter = opts.jitter == null ? true : opts.jitter;
  const isRetryable = opts.isRetryable || defaultIsRetryable;
  const onRetry = opts.onRetry;

  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isRetryable(err)) throw err;
      const exp = Math.min(maxDelay, base * Math.pow(factor, attempt));
      const delay = jitter ? Math.random() * exp : exp;
      attempt += 1;
      if (typeof onRetry === 'function') onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/* ========================================================================== */
/* CircuitBreaker — closed / open / half-open state machine                    */
/* ========================================================================== */

const BREAKER_STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half-open' };

class CircuitBreaker {
  constructor(opts) {
    opts = opts || {};
    this.threshold = opts.threshold == null ? 3 : opts.threshold;
    this.timeout = opts.timeout == null ? 50 : opts.timeout;
    this.halfOpenMax = opts.halfOpenMax == null ? 1 : opts.halfOpenMax;
    this._now = opts.now || (() => Date.now());

    this.state = BREAKER_STATES.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this._openedAt = 0;
    this._halfOpenInFlight = 0;
  }

  get isOpen() {
    return this.state === BREAKER_STATES.OPEN;
  }

  async exec(fn) {
    this._maybeHalfOpen();

    if (this.state === BREAKER_STATES.OPEN) {
      const err = new Error('CircuitBreaker is open');
      err.code = 'ECIRCUITOPEN';
      err.retryable = false;
      throw err;
    }

    if (this.state === BREAKER_STATES.HALF_OPEN) {
      if (this._halfOpenInFlight >= this.halfOpenMax) {
        const err = new Error('CircuitBreaker half-open is saturated');
        err.code = 'ECIRCUITHALFOPEN';
        err.retryable = false;
        throw err;
      }
      this._halfOpenInFlight += 1;
    }

    try {
      const out = await fn();
      this._onSuccess();
      return out;
    } catch (err) {
      this._onFailure();
      throw err;
    } finally {
      if (this.state === BREAKER_STATES.HALF_OPEN) this._halfOpenInFlight -= 1;
    }
  }

  _maybeHalfOpen() {
    if (
      this.state === BREAKER_STATES.OPEN &&
      this._now() - this._openedAt >= this.timeout
    ) {
      this.state = BREAKER_STATES.HALF_OPEN;
      this.successes = 0;
      this._halfOpenInFlight = 0;
    }
  }

  _onSuccess() {
    if (this.state === BREAKER_STATES.HALF_OPEN) {
      this.state = BREAKER_STATES.CLOSED;
      this.failures = 0;
      this.successes = 0;
      return;
    }
    this.failures = 0;
  }

  _onFailure() {
    if (this.state === BREAKER_STATES.HALF_OPEN) {
      this._trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.threshold) this._trip();
  }

  _trip() {
    this.state = BREAKER_STATES.OPEN;
    this._openedAt = this._now();
  }
}

/* ========================================================================== */
/* TokenBucket — classic rate limiter                                          */
/* ========================================================================== */

class TokenBucket {
  constructor(opts) {
    opts = opts || {};
    this.capacity = opts.capacity == null ? 10 : opts.capacity;
    this.refillRate = opts.refillRate == null ? 1 : opts.refillRate; // tokens/sec
    this._now = opts.now || (() => Date.now());
    this.tokens = this.capacity;
    this._last = this._now();
  }

  _refill() {
    const now = this._now();
    const elapsed = (now - this._last) / 1000;
    this._last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
  }

  tryTake(n) {
    n = n == null ? 1 : n;
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  async take(n) {
    n = n == null ? 1 : n;
    while (!this.tryTake(n)) {
      const deficit = n - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.refillRate) * 1000));
      await sleep(waitMs);
    }
  }
}

/* ========================================================================== */
/* withTimeout — promise timeout guard                                         */
/* ========================================================================== */

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(message || ('withTimeout: exceeded ' + ms + 'ms'));
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ========================================================================== */
/* deferred — external resolve/reject handle                                   */
/* ========================================================================== */

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/* ========================================================================== */
/* memoizeTTL — memoization with per-entry expiry                              */
/* ========================================================================== */

function memoizeTTL(fn, ttlMs, opts) {
  opts = opts || {};
  const now = opts.now || (() => Date.now());
  const maxSize = opts.maxSize == null ? 1000 : opts.maxSize;
  const cache = new Map();

  function memoized(key, ...rest) {
    const entry = cache.get(key);
    const t = now();
    if (entry && entry.expires > t) return entry.value;
    const value = fn(key, ...rest);
    cache.set(key, { value, expires: t + ttlMs });
    if (cache.size > maxSize) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    return value;
  }

  memoized.invalidate = (key) => cache.delete(key);
  memoized.clear = () => cache.clear();
  memoized.size = () => cache.size;
  return memoized;
}

/* ========================================================================== */
/* Tests                                                                       */
/* ========================================================================== */

/* --- Semaphore ------------------------------------------------------------ */

test('Semaphore rejects invalid limit', () => {
  assert.throws(() => new Semaphore(0), TypeError);
  assert.throws(() => new Semaphore(-1), TypeError);
  assert.throws(() => new Semaphore(1.5), TypeError);
});

testAsync('Semaphore never exceeds its limit', async () => {
  const sem = new Semaphore(3);
  let live = 0;
  let peak = 0;
  const jobs = [];
  for (let i = 0; i < 20; i += 1) {
    jobs.push(
      sem.run(async () => {
        live += 1;
        peak = Math.max(peak, live);
        await sleep(2);
        live -= 1;
      })
    );
  }
  await Promise.all(jobs);
  assert.strictEqual(peak, 3, 'peak concurrency should equal limit');
  assert.strictEqual(sem.active, 0);
  assert.strictEqual(sem.waiting, 0);
});

testAsync('Semaphore serves waiters in FIFO order', async () => {
  const sem = new Semaphore(1);
  const order = [];
  const release = await sem.acquire();
  const p1 = sem.run(async () => order.push('a'));
  const p2 = sem.run(async () => order.push('b'));
  const p3 = sem.run(async () => order.push('c'));
  release();
  await Promise.all([p1, p2, p3]);
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
});

/* --- TaskQueue ------------------------------------------------------------ */

testAsync('TaskQueue respects concurrency ceiling', async () => {
  const q = new TaskQueue(2);
  let live = 0;
  let peak = 0;
  const tasks = [];
  for (let i = 0; i < 8; i += 1) {
    tasks.push(q.add(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await sleep(3);
      live -= 1;
      return i;
    }));
  }
  const out = await Promise.all(tasks);
  assert.strictEqual(peak, 2);
  assert.deepStrictEqual(out, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.strictEqual(q.pending, 0);
});

testAsync('TaskQueue honors priority ordering', async () => {
  const q = new TaskQueue(1);
  const order = [];
  let gate = deferred();
  // Occupy the single worker so subsequent tasks queue up.
  const blocker = q.add(async () => {
    await gate.promise;
  });
  const low = q.add(async () => order.push('low'), 1);
  const mid = q.add(async () => order.push('mid'), 5);
  const high = q.add(async () => order.push('high'), 10);
  gate.resolve();
  await Promise.all([blocker, low, mid, high]);
  assert.deepStrictEqual(order, ['high', 'mid', 'low']);
});

testAsync('TaskQueue propagates task errors', async () => {
  const q = new TaskQueue(2);
  const bad = q.add(async () => {
    throw new Error('boom');
  });
  await assert.rejects(bad, /boom/);
  const ok = await q.add(async () => 42);
  assert.strictEqual(ok, 42);
});

testAsync('TaskQueue onIdle resolves once drained', async () => {
  const q = new TaskQueue(2);
  for (let i = 0; i < 5; i += 1) q.add(async () => sleep(1));
  await q.onIdle();
  assert.strictEqual(q.pending, 0);
});

/* --- retry ---------------------------------------------------------------- */

testAsync('retry succeeds after transient failures', async () => {
  let calls = 0;
  const out = await retry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    },
    { retries: 5, base: 1, maxDelay: 4 }
  );
  assert.strictEqual(out, 'ok');
  assert.strictEqual(calls, 3);
});

testAsync('retry stops immediately when non-retryable', async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        const err = new Error('fatal');
        err.retryable = false;
        throw err;
      },
      { retries: 5, base: 1 }
    ),
    /fatal/
  );
  assert.strictEqual(calls, 1);
});

testAsync('retry exhausts budget and rethrows last error', async () => {
  let calls = 0;
  await assert.rejects(
    retry(
      async () => {
        calls += 1;
        throw new Error('always ' + calls);
      },
      { retries: 3, base: 1, maxDelay: 2 }
    ),
    /always 4/
  );
  assert.strictEqual(calls, 4); // initial attempt + 3 retries
});

testAsync('retry invokes onRetry hook with attempt metadata', async () => {
  const seen = [];
  await retry(
    async (attempt) => {
      if (attempt < 2) throw new Error('x');
      return attempt;
    },
    {
      retries: 4,
      base: 1,
      maxDelay: 2,
      onRetry: (err, attempt, delay) => seen.push({ attempt, delay }),
    }
  );
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].attempt, 1);
  assert.strictEqual(seen[1].attempt, 2);
  assert.ok(seen.every((s) => s.delay >= 0));
});

/* --- CircuitBreaker ------------------------------------------------------- */

testAsync('CircuitBreaker opens after threshold failures', async () => {
  const cb = new CircuitBreaker({ threshold: 2, timeout: 50, now: () => 0 });
  const boom = async () => {
    throw new Error('down');
  };
  await assert.rejects(cb.exec(boom));
  await assert.rejects(cb.exec(boom));
  assert.strictEqual(cb.state, 'open');
  await assert.rejects(cb.exec(async () => 'never'), /open/);
});

testAsync('CircuitBreaker transitions to half-open then closed', async () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 1, timeout: 10, now: () => t });
  await assert.rejects(cb.exec(async () => {
    throw new Error('x');
  }));
  assert.strictEqual(cb.state, 'open');

  t = 20; // past timeout
  const ok = await cb.exec(async () => 'recovered');
  assert.strictEqual(ok, 'recovered');
  assert.strictEqual(cb.state, 'closed');
});

testAsync('CircuitBreaker re-opens when half-open probe fails', async () => {
  let t = 0;
  const cb = new CircuitBreaker({ threshold: 1, timeout: 10, now: () => t });
  await assert.rejects(cb.exec(async () => {
    throw new Error('x');
  }));
  t = 20;
  await assert.rejects(cb.exec(async () => {
    throw new Error('still broken');
  }));
  assert.strictEqual(cb.state, 'open');
});

testAsync('CircuitBreaker resets failure count on success', async () => {
  const cb = new CircuitBreaker({ threshold: 3 });
  await assert.rejects(cb.exec(async () => {
    throw new Error('x');
  }));
  await cb.exec(async () => 'ok');
  assert.strictEqual(cb.failures, 0);
  await assert.rejects(cb.exec(async () => {
    throw new Error('x');
  }));
  await assert.rejects(cb.exec(async () => {
    throw new Error('x');
  }));
  assert.strictEqual(cb.state, 'closed'); // still below threshold
});

/* --- TokenBucket ---------------------------------------------------------- */

test('TokenBucket allows burst up to capacity', () => {
  let t = 0;
  const tb = new TokenBucket({ capacity: 3, refillRate: 1, now: () => t });
  assert.strictEqual(tb.tryTake(), true);
  assert.strictEqual(tb.tryTake(), true);
  assert.strictEqual(tb.tryTake(), true);
  assert.strictEqual(tb.tryTake(), false);
});

test('TokenBucket refills over time', () => {
  let t = 0;
  const tb = new TokenBucket({ capacity: 2, refillRate: 2, now: () => t });
  tb.tryTake(2);
  assert.strictEqual(tb.tryTake(), false);
  t = 500; // 0.5s * 2 tokens/s = 1 token
  assert.strictEqual(tb.tryTake(1), true);
});

testAsync('TokenBucket take waits for refill', async () => {
  // Uses the real clock so tokens actually accrue while awaiting.
  const tb = new TokenBucket({ capacity: 1, refillRate: 100000 });
  assert.strictEqual(tb.tryTake(1), true, 'initial token should be available');
  assert.strictEqual(tb.tryTake(1), false, 'bucket should now be empty');
  const started = Date.now();
  await tb.take(1); // ~1ms wait at 100000 tokens/s
  assert.ok(Date.now() - started < 500, 'refill wait should be short');
});

/* --- withTimeout ---------------------------------------------------------- */

testAsync('withTimeout resolves when under budget', async () => {
  const out = await withTimeout(sleep(1).then(() => 'fast'), 100);
  assert.strictEqual(out, 'fast');
});

testAsync('withTimeout rejects when exceeded', async () => {
  await assert.rejects(
    withTimeout(sleep(50).then(() => 'slow'), 5),
    (err) => err.code === 'ETIMEDOUT'
  );
});

/* --- deferred ------------------------------------------------------------- */

testAsync('deferred resolves externally', async () => {
  const d = deferred();
  d.resolve(7);
  assert.strictEqual(await d.promise, 7);
});

testAsync('deferred rejects externally', async () => {
  const d = deferred();
  d.reject(new Error('nope'));
  await assert.rejects(d.promise, /nope/);
});

/* --- memoizeTTL ----------------------------------------------------------- */

test('memoizeTTL caches within TTL', () => {
  let t = 0;
  let calls = 0;
  const fn = memoizeTTL((k) => {
    calls += 1;
    return k * 2;
  }, 100, { now: () => t });

  assert.strictEqual(fn(2), 4);
  assert.strictEqual(fn(2), 4);
  assert.strictEqual(calls, 1);
  t = 150;
  assert.strictEqual(fn(2), 4);
  assert.strictEqual(calls, 2);
});

test('memoizeTTL evicts oldest beyond maxSize', () => {
  let t = 0;
  const fn = memoizeTTL((k) => k, 1000, { now: () => t, maxSize: 2 });
  fn('a');
  fn('b');
  fn('c');
  assert.strictEqual(fn.size(), 2);
});

test('memoizeTTL invalidate and clear', () => {
  const fn = memoizeTTL((k) => k, 1000);
  fn('x');
  assert.strictEqual(fn.size(), 1);
  fn.invalidate('x');
  assert.strictEqual(fn.size(), 0);
  fn('y');
  fn.clear();
  assert.strictEqual(fn.size(), 0);
});

/* ========================================================================== */
/* Entry point                                                                 */
/* ========================================================================== */

async function main() {
  await Promise.all(pending);
  await sleep(1);
  const output = report();
  if (typeof process !== 'undefined' && process.stdout) {
    process.stdout.write(output + '\n');
  }
  if (results.failed > 0 && typeof process !== 'undefined') {
    process.exitCode = 1;
  }
  return results;
}

if (require.main === module) {
  main();
}

module.exports = {
  Semaphore,
  TaskQueue,
  CircuitBreaker,
  BREAKER_STATES,
  TokenBucket,
  retry,
  withTimeout,
  deferred,
  memoizeTTL,
  sleep,
  test,
  testAsync,
  report,
  main,
  results,
};
