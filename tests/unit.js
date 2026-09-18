#!/usr/bin/env node
'use strict';

/**
 * tests/unit.js — Self-contained unit test suite for Phoenix Academy.
 * ============================================================================
 * ZERO external dependencies. Runs on a bare Node.js runtime (>= 14) with no
 * jest / mocha / chai / sinon installed. Ships with its own tiny BDD harness:
 *
 *     describe(name, fn)      group related tests
 *     it(name, fn)            a single (possibly async) test case
 *     it.skip(name, fn)       mark a test as pending
 *     it.only(name, fn)       temporarily run only these tests
 *     before / after          per-suite setup / teardown
 *     beforeEach / afterEach  per-test setup / teardown
 *     assert.*                a small assertion library
 *     expect(value)           a chai-like expectation helper
 *
 * The functions under test are pure and defined locally, so the suite never
 * depends on the rest of the repository being present or wired up.
 *
 * Usage:
 *     node tests/unit.js            # run the whole suite
 *     node --check tests/unit.js    # syntax check only
 *
 * Exit code is 0 when every executed test passes, and 1 otherwise.
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

function inspect(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

function deepEqual(a, b, seen) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const visited = seen || new WeakMap();
  if (visited.get(a) === b) return true;
  visited.set(a, b);

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key], visited)) return false;
  }
  return true;
}

function matchesPattern(actual, expected) {
  if (expected instanceof RegExp) return expected.test(String(actual));
  return actual === expected;
}

const assert = {
  ok(value, message) {
    if (!value) throw new AssertionError(message || `expected ${inspect(value)} to be truthy`);
  },

  fail(message) {
    throw new AssertionError(message || 'assert.fail() was called');
  },

  strictEqual(actual, expected, message) {
    if (!Object.is(actual, expected)) {
      throw new AssertionError(
        message || `expected ${inspect(actual)} to strictly equal ${inspect(expected)}`
      );
    }
  },

  notStrictEqual(actual, expected, message) {
    if (Object.is(actual, expected)) {
      throw new AssertionError(message || `expected ${inspect(actual)} not to equal ${inspect(expected)}`);
    }
  },

  deepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
      throw new AssertionError(
        message || `expected ${inspect(actual)} to deeply equal ${inspect(expected)}`
      );
    }
  },

  notDeepEqual(actual, expected, message) {
    if (deepEqual(actual, expected)) {
      throw new AssertionError(message || `expected values to differ, both were ${inspect(actual)}`);
    }
  },

  throws(fn, expected, message) {
    let thrown = null;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    if (!thrown) throw new AssertionError(message || 'expected function to throw');

    if (expected instanceof RegExp) {
      if (!expected.test(String(thrown && thrown.message))) {
        throw new AssertionError(
          message || `expected thrown message ${inspect(thrown.message)} to match ${expected}`
        );
      }
    } else if (typeof expected === 'function') {
      if (!(thrown instanceof expected)) {
        throw new AssertionError(
          message || `expected thrown error to be instance of ${expected.name}, got ${inspect(thrown)}`
        );
      }
    }
    return thrown;
  },

  async rejects(promise, expected, message) {
    let thrown = null;
    try {
      await promise;
    } catch (err) {
      thrown = err;
    }
    if (!thrown) throw new AssertionError(message || 'expected promise to reject');
    if (expected && !matchesPattern(thrown.message, expected)) {
      throw new AssertionError(
        message || `expected rejection ${inspect(thrown.message)} to match ${expected}`
      );
    }
    return thrown;
  },

  includes(haystack, needle, message) {
    const found = typeof haystack === 'string'
      ? haystack.includes(needle)
      : Array.isArray(haystack) && haystack.some((item) => deepEqual(item, needle));
    if (!found) {
      throw new AssertionError(
        message || `expected ${inspect(haystack)} to include ${inspect(needle)}`
      );
    }
  },

  closeTo(actual, expected, epsilon, message) {
    const tol = typeof epsilon === 'number' ? epsilon : 1e-9;
    if (Math.abs(actual - expected) > tol) {
      throw new AssertionError(
        message || `expected ${inspect(actual)} to be within ${tol} of ${inspect(expected)}`
      );
    }
  },
};

// Convenience aliases mirroring common assertion libraries.
assert.equal = assert.strictEqual;
assert.notEqual = assert.notStrictEqual;

function expect(value) {
  return {
    toBe(expected) {
      assert.strictEqual(value, expected);
      return this;
    },
    toEqual(expected) {
      assert.deepEqual(value, expected);
      return this;
    },
    toBeTruthy() {
      assert.ok(value);
      return this;
    },
    toBeFalsy() {
      assert.ok(!value, `expected ${inspect(value)} to be falsy`);
      return this;
    },
    toBeNull() {
      assert.strictEqual(value, null);
      return this;
    },
    toBeUndefined() {
      assert.strictEqual(value, undefined);
      return this;
    },
    toBeGreaterThan(expected) {
      assert.ok(typeof value === 'number' && value > expected, `expected ${inspect(value)} > ${expected}`);
      return this;
    },
    toBeLessThan(expected) {
      assert.ok(typeof value === 'number' && value < expected, `expected ${inspect(value)} < ${expected}`);
      return this;
    },
    toContain(expected) {
      assert.includes(value, expected);
      return this;
    },
    toHaveLength(expected) {
      assert.strictEqual(value && value.length, expected);
      return this;
    },
    toThrow(expected) {
      assert.throws(value, expected);
      return this;
    },
  };
}

/* ===========================================================================
 * 2. Tiny BDD harness
 * ========================================================================= */

function createSuite(title, parent) {
  return {
    title,
    parent: parent || null,
    tests: [],
    suites: [],
    before: [],
    after: [],
    beforeEach: [],
    afterEach: [],
  };
}

const rootSuite = createSuite('(root)', null);
let currentSuite = rootSuite;

function describe(title, fn) {
  const suite = createSuite(title, currentSuite);
  currentSuite.suites.push(suite);
  const previous = currentSuite;
  currentSuite = suite;
  try {
    fn();
  } finally {
    currentSuite = previous;
  }
  return suite;
}

function it(title, fn) {
  currentSuite.tests.push({ title, fn, skip: false, only: false, suite: currentSuite });
}

it.skip = function skip(title, fn) {
  currentSuite.tests.push({ title, fn: fn || function noop() {}, skip: true, only: false, suite: currentSuite });
};

it.only = function only(title, fn) {
  currentSuite.tests.push({ title, fn, skip: false, only: true, suite: currentSuite });
};

const test = it;

function before(fn) {
  currentSuite.before.push(fn);
}
function after(fn) {
  currentSuite.after.push(fn);
}
function beforeEach(fn) {
  currentSuite.beforeEach.push(fn);
}
function afterEach(fn) {
  currentSuite.afterEach.push(fn);
}

function suiteHasOnly(suite) {
  if (suite.tests.some((t) => t.only)) return true;
  return suite.suites.some(suiteHasOnly);
}

async function runSuite(suite, lineage, stats, onlyMode) {
  const ancestors = lineage.concat([suite]);
  const path = ancestors
    .filter((s) => s !== rootSuite && s.title !== '(root)')
    .map((s) => s.title)
    .join(' > ');

  for (const hook of suite.before) await hook();

  for (const item of suite.tests) {
    const fullTitle = (path ? path + ' > ' : '') + item.title;

    if (item.skip) {
      stats.skipped += 1;
      process.stdout.write(`  - ${fullTitle} (skipped)\n`);
      continue;
    }
    if (onlyMode && !item.only) {
      stats.skipped += 1;
      continue;
    }

    for (const hook of suite.beforeEach) await hook();
    const startedAt = Date.now();
    try {
      await item.fn();
      stats.passed += 1;
      process.stdout.write(`  \u2713 ${fullTitle} (${Date.now() - startedAt}ms)\n`);
    } catch (err) {
      stats.failed += 1;
      stats.failures.push({ title: fullTitle, error: err });
      process.stdout.write(`  \u2717 ${fullTitle}\n`);
      process.stdout.write(`      ${(err && err.stack) || err}\n`);
    } finally {
      for (const hook of suite.afterEach) await hook();
    }
  }

  for (const child of suite.suites) await runSuite(child, ancestors, stats, onlyMode);
  for (const hook of suite.after) await hook();
}

async function run() {
  const stats = { passed: 0, failed: 0, skipped: 0, failures: [] };
  const onlyMode = suiteHasOnly(rootSuite);
  const startedAt = Date.now();

  process.stdout.write('\nunit.js \u2014 running test suite\n\n');
  await runSuite(rootSuite, [], stats, onlyMode);

  const elapsed = Date.now() - startedAt;
  process.stdout.write('\n' + '-'.repeat(60) + '\n');
  process.stdout.write(
    `  passed: ${stats.passed}  failed: ${stats.failed}  skipped: ${stats.skipped}  time: ${elapsed}ms\n`
  );
  process.stdout.write('-'.repeat(60) + '\n\n');

  if (stats.failures.length) {
    process.stdout.write('Failures:\n');
    for (const failure of stats.failures) {
      process.stdout.write(`  \u2717 ${failure.title}\n`);
      process.stdout.write(`      ${(failure.error && failure.error.message) || failure.error}\n`);
    }
    process.stdout.write('\n');
  }

  return stats;
}

/* ===========================================================================
 * 3. Subjects under test — pure utilities
 * ========================================================================= */

function clamp(n, min, max) {
  if (min > max) throw new RangeError('min must be <= max');
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function sum(values) {
  return values.reduce((acc, n) => acc + n, 0);
}

function average(values) {
  if (!values.length) return 0;
  return sum(values) / values.length;
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function flatten(values, depth) {
  const limit = depth === undefined ? Infinity : depth;
  const out = [];
  const walk = (list, level) => {
    for (const item of list) {
      if (Array.isArray(item) && level < limit) walk(item, level + 1);
      else out.push(item);
    }
  };
  walk(values, 0);
  return out;
}

function chunk(values, size) {
  if (size <= 0) throw new RangeError('size must be > 0');
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

function capitalize(text) {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function truncate(text, max, suffix) {
  const tail = suffix === undefined ? '\u2026' : suffix;
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - tail.length)) + tail;
}

function isPalindrome(text) {
  const normalized = String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === normalized.split('').reverse().join('');
}

function wordCount(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function groupBy(values, keyFn) {
  const out = {};
  for (const value of values) {
    const key = String(keyFn(value));
    if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = [];
    out[key].push(value);
  }
  return out;
}

function range(start, end, step) {
  let from = start;
  let to = end;
  let by = step === undefined ? 1 : step;
  if (to === undefined) {
    to = start;
    from = 0;
  }
  if (by === 0) throw new RangeError('step must not be 0');
  const out = [];
  if (by > 0) for (let i = from; i < to; i += by) out.push(i);
  else for (let i = from; i > to; i += by) out.push(i);
  return out;
}

function fibonacci(n) {
  if (n < 0) throw new RangeError('n must be >= 0');
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i += 1) {
    const next = a + b;
    a = b;
    b = next;
  }
  return a;
}

function factorial(n) {
  if (n < 0) throw new RangeError('n must be >= 0');
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

function isPrime(n) {
  if (!Number.isInteger(n) || n < 2) return false;
  if (n % 2 === 0) return n === 2;
  for (let i = 3; i * i <= n; i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}

function parseQuery(queryString) {
  const out = {};
  if (!queryString) return out;
  const raw = queryString.charAt(0) === '?' ? queryString.slice(1) : queryString;
  if (!raw) return out;
  for (const pair of raw.split('&')) {
    if (!pair) continue;
    const index = pair.indexOf('=');
    const rawKey = index === -1 ? pair : pair.slice(0, index);
    const rawValue = index === -1 ? '' : pair.slice(index + 1);
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    const value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = Array.isArray(out[key]) ? out[key].concat(value) : [out[key], value];
    } else {
      out[key] = value;
    }
  }
  return out;
}

function buildQuery(params) {
  const parts = [];
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}

function memoize(fn) {
  const cache = new Map();
  return function memoized(...args) {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const value = fn.apply(this, args);
    cache.set(key, value);
    return value;
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retry(fn, attempts, waitMs) {
  const limit = attempts === undefined ? 3 : attempts;
  let lastError;
  for (let attempt = 0; attempt < limit; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (waitMs) await delay(waitMs);
    }
  }
  throw lastError;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map((item) => deepClone(item));
  const out = {};
  for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
  return out;
}

function mergeDeep(...sources) {
  const target = {};
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const key of Object.keys(source)) {
      const current = target[key];
      const incoming = source[key];
      if (isPlainObject(current) && isPlainObject(incoming)) target[key] = mergeDeep(current, incoming);
      else if (Array.isArray(incoming)) target[key] = incoming.slice();
      else if (isPlainObject(incoming)) target[key] = mergeDeep(incoming);
      else target[key] = incoming;
    }
  }
  return target;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateEmail(email) {
  return EMAIL_RE.test(String(email || '').trim());
}

function validatePassword(password) {
  const value = String(password || '');
  return value.length >= 8 && /[0-9]/.test(value) && /[a-zA-Z]/.test(value);
}

class Emitter {
  constructor() {
    this._handlers = new Map();
  }
  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, []);
    this._handlers.get(event).push(fn);
    return this;
  }
  off(event, fn) {
    const list = this._handlers.get(event);
    if (!list) return this;
    this._handlers.set(event, list.filter((handler) => handler !== fn));
    return this;
  }
  emit(event, payload) {
    const list = this._handlers.get(event) || [];
    for (const handler of list.slice()) handler(payload);
    return list.length;
  }
}

class LRU {
  constructor(capacity) {
    if (capacity <= 0) throw new RangeError('capacity must be > 0');
    this.capacity = capacity;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    return this;
  }
  has(key) {
    return this.map.has(key);
  }
  get size() {
    return this.map.size;
  }
}

/* ===========================================================================
 * 4. Test cases (30+)
 * ========================================================================= */

describe('number utilities', () => {
  it('clamp returns the value when in range', () => {
    assert.strictEqual(clamp(5, 0, 10), 5);
  });

  it('clamp applies the lower bound', () => {
    assert.strictEqual(clamp(-3, 0, 10), 0);
  });

  it('clamp applies the upper bound', () => {
    assert.strictEqual(clamp(99, 0, 10), 10);
  });

  it('clamp rejects an inverted range', () => {
    assert.throws(() => clamp(1, 10, 0), RangeError);
  });

  it('lerp interpolates at t=0, 0.5 and 1', () => {
    assert.strictEqual(lerp(10, 20, 0), 10);
    assert.strictEqual(lerp(10, 20, 0.5), 15);
    assert.strictEqual(lerp(10, 20, 1), 20);
  });

  it('sum and average handle non-empty arrays', () => {
    assert.strictEqual(sum([1, 2, 3, 4]), 10);
    assert.strictEqual(average([2, 4, 6]), 4);
  });

  it('average of an empty array is 0', () => {
    assert.strictEqual(average([]), 0);
  });

  it('gcd computes the greatest common divisor', () => {
    assert.strictEqual(gcd(48, 18), 6);
    assert.strictEqual(gcd(0, 5), 5);
    assert.strictEqual(gcd(-12, 8), 4);
  });

  it('factorial computes n! and rejects negatives', () => {
    assert.strictEqual(factorial(0), 1);
    assert.strictEqual(factorial(5), 120);
    assert.throws(() => factorial(-1), RangeError);
  });

  it('fibonacci produces the expected sequence', () => {
    assert.strictEqual(fibonacci(0), 0);
    assert.strictEqual(fibonacci(1), 1);
    assert.strictEqual(fibonacci(10), 55);
  });

  it('isPrime detects primes', () => {
    assert.strictEqual(isPrime(2), true);
    assert.strictEqual(isPrime(17), true);
    assert.strictEqual(isPrime(1), false);
    assert.strictEqual(isPrime(18), false);
    assert.strictEqual(isPrime(0), false);
  });

  it('range supports positive, stepped and descending ranges', () => {
    assert.deepEqual(range(4), [0, 1, 2, 3]);
    assert.deepEqual(range(1, 4), [1, 2, 3]);
    assert.deepEqual(range(0, 10, 5), [0, 5]);
    assert.deepEqual(range(5, 0, -1), [5, 4, 3, 2, 1]);
  });

  it('range rejects a zero step', () => {
    assert.throws(() => range(0, 10, 0), RangeError);
  });
});

describe('array utilities', () => {
  it('unique removes duplicates while preserving order', () => {
    assert.deepEqual(unique([1, 1, 2, 3, 3, 3]), [1, 2, 3]);
    assert.deepEqual(unique(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
  });

  it('flatten supports unlimited and bounded depth', () => {
    assert.deepEqual(flatten([1, [2, [3, [4]]]]), [1, 2, 3, 4]);
    assert.deepEqual(flatten([1, [2, [3, [4]]]], 1), [1, 2, [3, [4]]]);
  });

  it('chunk splits arrays into fixed-size groups', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it('chunk rejects a non-positive size', () => {
    assert.throws(() => chunk([1], 0), RangeError);
  });

  it('groupBy groups values by a selector key', () => {
    const grouped = groupBy([1, 2, 3, 4, 5], (n) => n % 2);
    assert.deepEqual(grouped, { 0: [2, 4], 1: [1, 3, 5] });
  });
});

describe('string utilities', () => {
  it('capitalize upper-cases the first letter', () => {
    assert.strictEqual(capitalize('hello'), 'Hello');
    assert.strictEqual(capitalize(''), '');
  });

  it('slugify normalizes punctuation and spacing', () => {
    assert.strictEqual(slugify('Hello, World!'), 'hello-world');
    assert.strictEqual(slugify('  Foo   Bar  '), 'foo-bar');
  });

  it('truncate respects the max length and suffix', () => {
    assert.strictEqual(truncate('Hello World', 20), 'Hello World');
    const shortened = truncate('Hello World', 8);
    assert.strictEqual(shortened.length, 8);
    assert.strictEqual(shortened, 'Hello W\u2026');
  });

  it('isPalindrome ignores case and punctuation', () => {
    assert.strictEqual(isPalindrome('A man, a plan, a canal: Panama'), true);
    assert.strictEqual(isPalindrome('hello'), false);
  });

  it('wordCount counts whitespace-separated words', () => {
    assert.strictEqual(wordCount('  hello   world  '), 2);
    assert.strictEqual(wordCount('   '), 0);
  });
});

describe('query-string helpers', () => {
  it('parseQuery decodes simple pairs', () => {
    assert.deepEqual(parseQuery('?name=John+Doe&age=30'), { name: 'John Doe', age: '30' });
  });

  it('parseQuery collects repeated keys into an array', () => {
    assert.deepEqual(parseQuery('a=1&b=2&b=3'), { a: '1', b: ['2', '3'] });
  });

  it('buildQuery encodes values and expands arrays', () => {
    assert.strictEqual(buildQuery({ a: 1, b: 'x y' }), 'a=1&b=x%20y');
    assert.strictEqual(buildQuery({ tag: ['a', 'b'] }), 'tag=a&tag=b');
  });

  it('parseQuery and buildQuery round-trip', () => {
    const params = { a: '1', b: '2', c: 'hello world' };
    assert.deepEqual(parseQuery(buildQuery(params)), params);
  });
});

describe('caching and control flow', () => {
  it('memoize caches results by arguments', () => {
    let calls = 0;
    const square = memoize((n) => {
      calls += 1;
      return n * n;
    });
    assert.strictEqual(square(4), 16);
    assert.strictEqual(square(4), 16);
    assert.strictEqual(calls, 1);
  });

  it('retry eventually resolves after transient failures', async () => {
    let attempts = 0;
    const value = await retry(async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return 'ok';
    }, 5);
    assert.strictEqual(value, 'ok');
    assert.strictEqual(attempts, 3);
  });

  it('retry rejects after exhausting attempts', async () => {
    await assert.rejects(
      retry(async () => {
        throw new Error('always fails');
      }, 2),
      /always fails/
    );
  });

  it('delay resolves after the given timeout', async () => {
    const startedAt = Date.now();
    await delay(20);
    assert.ok(Date.now() - startedAt >= 15);
  });
});

describe('object utilities', () => {
  it('deepClone produces an independent copy', () => {
    const source = { a: 1, nested: { b: [1, 2, 3] } };
    const copy = deepClone(source);
    copy.nested.b.push(4);
    assert.deepEqual(source.nested.b, [1, 2, 3]);
    assert.deepEqual(copy.nested.b, [1, 2, 3, 4]);
    assert.notStrictEqual(copy, source);
  });

  it('mergeDeep merges nested objects without mutating inputs', () => {
    const base = { a: { x: 1 }, list: [1, 2] };
    const extra = { a: { y: 2 }, list: [3] };
    const merged = mergeDeep(base, extra);
    assert.deepEqual(merged, { a: { x: 1, y: 2 }, list: [3] });
    assert.deepEqual(base, { a: { x: 1 }, list: [1, 2] });
  });
});

describe('validation helpers', () => {
  it('validateEmail accepts well-formed addresses', () => {
    assert.strictEqual(validateEmail('user@example.com'), true);
    assert.strictEqual(validateEmail('a.b+c@sub.domain.io'), true);
  });

  it('validateEmail rejects malformed addresses', () => {
    assert.strictEqual(validateEmail('not-an-email'), false);
    assert.strictEqual(validateEmail('user@com'), false);
    assert.strictEqual(validateEmail(''), false);
  });

  it('validatePassword enforces length and character classes', () => {
    assert.strictEqual(validatePassword('secret12'), true);
    assert.strictEqual(validatePassword('short1'), false);
    assert.strictEqual(validatePassword('nodigitshere'), false);
    assert.strictEqual(validatePassword('12345678'), false);
  });
});

describe('Emitter', () => {
  it('invokes handlers with the emitted payload', () => {
    const emitter = new Emitter();
    let received = null;
    emitter.on('ping', (payload) => {
      received = payload;
    });
    emitter.emit('ping', 42);
    assert.strictEqual(received, 42);
  });

  it('returns the number of notified handlers', () => {
    const emitter = new Emitter();
    emitter.on('x', () => {});
    emitter.on('x', () => {});
    assert.strictEqual(emitter.emit('x'), 2);
  });

  it('off removes a previously registered handler', () => {
    const emitter = new Emitter();
    let count = 0;
    const handler = () => {
      count += 1;
    };
    emitter.on('x', handler);
    emitter.off('x', handler);
    emitter.emit('x');
    assert.strictEqual(count, 0);
  });

  it('keeps events independent', () => {
    const emitter = new Emitter();
    const hits = [];
    emitter.on('a', () => hits.push('a'));
    emitter.on('b', () => hits.push('b'));
    emitter.emit('a');
    emitter.emit('b');
    assert.deepEqual(hits, ['a', 'b']);
  });
});

describe('LRU cache', () => {
  it('stores and retrieves values', () => {
    const lru = new LRU(2);
    lru.set('a', 1);
    assert.strictEqual(lru.get('a'), 1);
    assert.strictEqual(lru.size, 1);
  });

  it('evicts the least recently used entry', () => {
    const lru = new LRU(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a');
    lru.set('c', 3);
    assert.strictEqual(lru.has('a'), true);
    assert.strictEqual(lru.has('b'), false);
    assert.strictEqual(lru.has('c'), true);
  });

  it('rejects a non-positive capacity', () => {
    assert.throws(() => new LRU(0), RangeError);
  });
});

describe('harness self-checks', () => {
  it('assert.closeTo tolerates tiny floating point drift', () => {
    assert.closeTo(0.1 + 0.2, 0.3, 1e-9);
  });

  it('expect() supports chained matchers', () => {
    expect([1, 2, 3]).toHaveLength(3);
    expect('phoenix').toContain('oen');
    expect(5).toBeGreaterThan(4).toBeLessThan(6);
  });

  it.skip('pending example \u2014 intentionally skipped', () => {
    assert.fail('this test must not run');
  });
});

/* ===========================================================================
 * 5. Runner wiring
 * ========================================================================= */

async function main() {
  const stats = await run();
  return stats.failed === 0 ? 0 : 1;
}

module.exports = {
  // harness
  describe,
  it,
  test,
  before,
  after,
  beforeEach,
  afterEach,
  run,
  main,
  // assertions
  assert,
  expect,
  AssertionError,
  deepEqual,
  // subjects
  clamp,
  lerp,
  sum,
  average,
  unique,
  flatten,
  chunk,
  capitalize,
  slugify,
  truncate,
  isPalindrome,
  wordCount,
  groupBy,
  range,
  fibonacci,
  factorial,
  gcd,
  isPrime,
  parseQuery,
  buildQuery,
  memoize,
  delay,
  retry,
  deepClone,
  mergeDeep,
  validateEmail,
  validatePassword,
  Emitter,
  LRU,
};

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write('unit.js crashed: ' + ((err && err.stack) || err) + '\n');
      process.exitCode = 1;
    });
}
