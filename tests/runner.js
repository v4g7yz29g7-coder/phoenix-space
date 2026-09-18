#!/usr/bin/env node
'use strict';

/**
 * tests/runner.js — a small, zero-dependency test runner for Node.js.
 * ---------------------------------------------------------------------------
 * Supports two authoring styles:
 *
 *   1) Registration style (Mocha-like):
 *        const { describe, it, beforeEach, expect, assert } = require('./runner.js');
 *        describe('math', () => {
 *          it('adds', () => { expect(1 + 1).toBe(2); });
 *          it.skip('later', () => {});
 *        });
 *
 *   2) Export-object style:
 *        const { assertEqual } = require('./runner.js');
 *        module.exports = {
 *          'adds numbers'() { assertEqual(1 + 1, 2); },
 *          async 'resolves later'() { await Promise.resolve(); },
 *        };
 *
 * CLI:
 *   node tests/runner.js [options] [files-or-globs...]
 *
 * Options:
 *   --grep <text>       Only run tests whose full name contains <text>
 *   --bail              Stop after the first failing test
 *   --timeout <ms>      Default per-test timeout (default 5000)
 *   --reporter <name>   spec | tap | dot | json  (default spec)
 *   --help              Show usage
 *
 * Exit code is 0 when every executed test passes, 1 otherwise.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

// ---------------------------------------------------------------------------
// Internal registry
// ---------------------------------------------------------------------------

function createSuite(title, parent) {
  return {
    title,
    tests: [],
    suites: [],
    before: [],
    after: [],
    beforeEach: [],
    afterEach: [],
    parent: parent || null,
  };
}

const rootSuite = createSuite('(root)', null);
let currentSuite = rootSuite;
let onlyMode = false;

function resetRegistry() {
  rootSuite.tests.length = 0;
  rootSuite.suites.length = 0;
  rootSuite.before.length = 0;
  rootSuite.after.length = 0;
  rootSuite.beforeEach.length = 0;
  rootSuite.afterEach.length = 0;
  currentSuite = rootSuite;
  onlyMode = false;
}

function containsOnly(suite) {
  if (suite.tests.some((t) => t.only)) return true;
  return suite.suites.some(containsOnly);
}

// ---------------------------------------------------------------------------
// Registration API
// ---------------------------------------------------------------------------

function describe(title, fn) {
  const suite = createSuite(title, currentSuite);
  currentSuite.suites.push(suite);
  const prev = currentSuite;
  currentSuite = suite;
  try {
    fn();
  } finally {
    currentSuite = prev;
  }
  return suite;
}

function it(title, fn, options) {
  const opts = options || {};
  currentSuite.tests.push({
    title,
    fn,
    timeout: opts.timeout || 0,
    skip: !!opts.skip,
    only: !!opts.only,
  });
}

function test(title, fn, options) {
  return it(title, fn, options);
}

it.skip = function (title, fn) {
  return it(title, fn, { skip: true });
};

it.only = function (title, fn) {
  onlyMode = true;
  return it(title, fn, { only: true });
};

test.skip = it.skip;
test.only = it.only;

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

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function fail(message) {
  throw new AssertionError(message);
}

function stringify(value) {
  return util.inspect(value, { depth: 6, colors: false, breakLength: 100 });
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;
  if (aIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function expect(actual) {
  const api = {
    toBe(expected) {
      if (!Object.is(actual, expected)) {
        fail(`Expected ${stringify(expected)} but received ${stringify(actual)}`);
      }
    },
    toEqual(expected) {
      if (!deepEqual(actual, expected)) {
        fail(
          `Expected deep equality:\n  expected: ${stringify(expected)}\n  actual:   ${stringify(actual)}`
        );
      }
    },
    toBeTruthy() {
      if (!actual) fail(`Expected truthy value but received ${stringify(actual)}`);
    },
    toBeFalsy() {
      if (actual) fail(`Expected falsy value but received ${stringify(actual)}`);
    },
    toBeDefined() {
      if (actual === undefined) fail('Expected value to be defined');
    },
    toBeNull() {
      if (actual !== null) fail(`Expected null but received ${stringify(actual)}`);
    },
    toBeType(type) {
      if (typeof actual !== type) fail(`Expected type ${type} but received ${typeof actual}`);
    },
    toBeInstanceOf(ctor) {
      if (!(actual instanceof ctor)) fail(`Expected instance of ${ctor && ctor.name}`);
    },
    toContain(needle) {
      const ok =
        (typeof actual === 'string' && actual.indexOf(needle) !== -1) ||
        (Array.isArray(actual) && actual.some((x) => deepEqual(x, needle)));
      if (!ok) fail(`Expected ${stringify(actual)} to contain ${stringify(needle)}`);
    },
    toHaveLength(len) {
      if (!actual || actual.length !== len) {
        fail(`Expected length ${len} but received ${actual && actual.length}`);
      }
    },
    toBeGreaterThan(n) {
      if (!(actual > n)) fail(`Expected ${stringify(actual)} > ${stringify(n)}`);
    },
    toBeLessThan(n) {
      if (!(actual < n)) fail(`Expected ${stringify(actual)} < ${stringify(n)}`);
    },
    toThrow(matcher) {
      if (typeof actual !== 'function') fail('toThrow expects a function');
      let threw = false;
      let error = null;
      try {
        actual();
      } catch (e) {
        threw = true;
        error = e;
      }
      if (!threw) fail('Expected function to throw, but it did not');
      if (typeof matcher === 'string') {
        if (!String(error.message).includes(matcher)) {
          fail(`Expected error message to contain "${matcher}" but got "${error.message}"`);
        }
      } else if (matcher instanceof RegExp) {
        if (!matcher.test(error.message)) {
          fail(`Expected error message to match ${matcher} but got "${error.message}"`);
        }
      } else if (typeof matcher === 'function') {
        if (!(error instanceof matcher)) {
          fail('Expected thrown error to be instance of provided constructor');
        }
      }
    },
    not: null,
  };

  api.not = {
    toBe(expected) {
      if (Object.is(actual, expected)) fail(`Expected value NOT to be ${stringify(expected)}`);
    },
    toEqual(expected) {
      if (deepEqual(actual, expected)) {
        fail(`Expected values NOT to be deeply equal: ${stringify(actual)}`);
      }
    },
    toBeTruthy() {
      if (actual) fail(`Expected falsy value but received ${stringify(actual)}`);
    },
    toBeFalsy() {
      if (!actual) fail(`Expected truthy value but received ${stringify(actual)}`);
    },
    toContain(needle) {
      if (typeof actual === 'string' && actual.includes(needle)) {
        fail(`Expected ${stringify(actual)} NOT to contain ${stringify(needle)}`);
      }
    },
  };

  return api;
}

const assert = {
  ok(value, message) {
    if (!value) fail(message || `Expected truthy value but received ${stringify(value)}`);
  },
  equal(actual, expected, message) {
    if (!Object.is(actual, expected)) {
      fail(message || `Expected ${stringify(expected)} but received ${stringify(actual)}`);
    }
  },
  strictEqual(actual, expected, message) {
    return assert.equal(actual, expected, message);
  },
  notEqual(actual, expected, message) {
    if (Object.is(actual, expected)) fail(message || `Expected values to differ`);
  },
  deepEqual(actual, expected, message) {
    if (!deepEqual(actual, expected)) {
      fail(message || `Expected deep equality ${stringify(expected)} vs ${stringify(actual)}`);
    }
  },
  deepStrictEqual(actual, expected, message) {
    return assert.deepEqual(actual, expected, message);
  },
  fail(message) {
    fail(message || 'assert.fail() was called');
  },
  throws(fn, matcher, message) {
    return expect(fn).toThrow(matcher || undefined, message);
  },
  async rejects(promise, matcher, message) {
    let error = null;
    try {
      await promise;
    } catch (e) {
      error = e;
    }
    if (!error) fail(message || 'Expected promise to reject, but it resolved');
    if (matcher instanceof RegExp && !matcher.test(String(error.message))) {
      fail(`Rejected with "${error.message}" which does not match ${matcher}`);
    }
    return error;
  },
};

function assertEqual(actual, expected, message) {
  return assert.deepEqual(actual, expected, message);
}
function assertOk(value, message) {
  return assert.ok(value, message);
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, title) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timeout of ${ms}ms exceeded in "${title}"`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function collectHookChain(suite, kind) {
  const chain = [];
  let node = suite;
  while (node) {
    chain.unshift.apply(chain, node[kind]);
    node = node.parent;
  }
  return chain;
}

function fullName(suite, title) {
  const parts = [];
  let node = suite;
  while (node && node !== rootSuite) {
    parts.unshift(node.title);
    node = node.parent;
  }
  parts.push(title);
  return parts.join(' > ');
}

async function runSuite(suite, results, opts, ancestors) {
  const chain = ancestors.concat([suite]);

  for (const hook of suite.before) {
    await hook();
  }

  for (const t of suite.tests) {
    const name = fullName(suite, t.title);

    if (opts.grep && name.indexOf(opts.grep) === -1) {
      results.skipped.push(name);
      continue;
    }
    if (t.skip || (opts.onlyMode && !t.only)) {
      results.skipped.push(name);
      continue;
    }

    const start = Date.now();
    try {
      for (const hook of collectHookChain(suite, 'beforeEach')) {
        await hook();
      }
      const timeout = t.timeout || opts.timeout;
      await withTimeout(Promise.resolve().then(() => t.fn()), timeout, name);
      for (const hook of collectHookChain(suite, 'afterEach')) {
        await hook();
      }
      results.passed.push({ name, duration: Date.now() - start });
      opts.onPass && opts.onPass(name, Date.now() - start);
    } catch (err) {
      results.failed.push({ name, error: err, duration: Date.now() - start });
      opts.onFail && opts.onFail(name, err);
      if (opts.bail) {
        results.bailed = true;
        break;
      }
    }
  }

  if (!results.bailed) {
    for (const child of suite.suites) {
      await runSuite(child, results, opts, chain);
      if (results.bailed) break;
    }
  }

  for (const hook of suite.after) {
    await hook();
  }

  return results;
}

async function runSuiteCompat(suite, opts) {
  const options = Object.assign(
    { timeout: 5000, bail: false, grep: null, onlyMode: containsOnly(rootSuite) },
    opts || {}
  );
  const results = { passed: [], failed: [], skipped: [], bailed: false };
  await runSuite(suite || rootSuite, results, options, []);
  return results;
}

// ---------------------------------------------------------------------------
// Reporters
// ---------------------------------------------------------------------------

function specReporter(results) {
  const lines = [];
  for (const t of results.passed) {
    lines.push(`  \u2713 ${t.name} (${t.duration}ms)`);
  }
  for (const name of results.skipped) {
    lines.push(`  - ${name} (skipped)`);
  }
  for (const t of results.failed) {
    lines.push(`  \u2717 ${t.name}`);
    lines.push(`      ${(t.error && t.error.message) || t.error}`);
  }
  lines.push('');
  lines.push(
    `  ${results.passed.length} passed, ${results.failed.length} failed, ` +
      `${results.skipped.length} skipped`
  );
  if (results.bailed) lines.push('  (bailed after first failure)');
  return lines.join('\n');
}

function tapReporter(results) {
  const lines = ['TAP version 13', `1..${results.passed.length + results.failed.length}`];
  let n = 0;
  for (const t of results.passed) {
    n += 1;
    lines.push(`ok ${n} - ${t.name}`);
  }
  for (const t of results.failed) {
    n += 1;
    lines.push(`not ok ${n} - ${t.name}`);
    lines.push(`  ---`);
    lines.push(`  message: ${JSON.stringify((t.error && t.error.message) || String(t.error))}`);
    lines.push(`  ---`);
  }
  return lines.join('\n');
}

function dotReporter(results) {
  let out = '';
  for (const _ of results.passed) out += '.';
  for (const _ of results.failed) out += 'F';
  for (const _ of results.skipped) out += '-';
  return `${out}\n\n${results.passed.length} passed, ${results.failed.length} failed`;
}

function jsonReporter(results) {
  return JSON.stringify(
    {
      passed: results.passed.length,
      failed: results.failed.length,
      skipped: results.skipped.length,
      tests: results.passed.concat(
        results.failed.map((t) => ({ name: t.name, error: String(t.error && t.error.message) }))
      ),
    },
    null,
    2
  );
}

function getReporter(name) {
  switch (name) {
    case 'tap':
      return tapReporter;
    case 'dot':
      return dotReporter;
    case 'json':
      return jsonReporter;
    case 'spec':
    default:
      return specReporter;
  }
}

function printReport(results, reporter) {
  const fn = typeof reporter === 'function' ? reporter : getReporter(reporter);
  const text = fn(results);
  process.stdout.write(text + '\n');
  return text;
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { files: [], grep: null, bail: false, timeout: 5000, reporter: 'spec' };
  const args = argv.slice();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--bail') {
      opts.bail = true;
    } else if (arg === '--grep') {
      opts.grep = args[++i];
    } else if (arg.indexOf('--grep=') === 0) {
      opts.grep = arg.slice('--grep='.length);
    } else if (arg === '--timeout') {
      opts.timeout = parseInt(args[++i], 10) || 5000;
    } else if (arg.indexOf('--timeout=') === 0) {
      opts.timeout = parseInt(arg.slice('--timeout='.length), 10) || 5000;
    } else if (arg === '--reporter') {
      opts.reporter = args[++i] || 'spec';
    } else if (arg.indexOf('--reporter=') === 0) {
      opts.reporter = arg.slice('--reporter='.length);
    } else if (arg.indexOf('--') !== 0) {
      opts.files.push(arg);
    }
  }
  return opts;
}

function usage() {
  return [
    'Usage: node tests/runner.js [options] [files...]',
    '',
    'Options:',
    '  --grep <text>        Only run tests whose full name contains <text>',
    '  --bail               Stop after the first failing test',
    '  --timeout <ms>       Default per-test timeout in milliseconds',
    '  --reporter <name>    spec | tap | dot | json (default: spec)',
    '  --help               Show this message',
    '',
    'When no files are given, ./tests/**/*.test.js files are discovered.',
  ].join('\n');
}

function findTestFiles(dir) {
  const base = dir || path.join(process.cwd(), 'tests');
  const found = [];
  if (!fs.existsSync(base)) return found;
  const visit = (p) => {
    let entries;
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (/\.test\.js$/.test(entry.name)) {
        found.push(full);
      }
    }
  };
  visit(base);
  return found.sort();
}

function registerExportedObject(obj, prefix) {
  const label = prefix || '';
  for (const key of Object.keys(obj || {})) {
    const value = obj[key];
    if (typeof value !== 'function') continue;
    const name = label ? label + ' > ' + key : key;
    it(name, value);
  }
}

function loadTestFile(file) {
  const abs = path.resolve(file);
  const mod = require(abs);
  if (mod && typeof mod === 'object' && typeof mod.default === 'function' && !Object.keys(mod).some((k) => typeof mod[k] === 'function')) {
    it(path.basename(abs), mod.default);
  } else if (mod && typeof mod === 'object') {
    registerExportedObject(mod);
  }
  return mod;
}

async function main(argv) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(usage() + '\n');
    return { code: 0 };
  }

  const files = opts.files.length ? opts.files : findTestFiles(opts.testsDir);
  for (const file of files) {
    try {
      loadTestFile(file);
    } catch (err) {
      process.stderr.write(`Failed to load ${file}: ${(err && err.stack) || err}\n`);
      return { code: 1 };
    }
  }

  opts.onlyMode = containsOnly(rootSuite);
  const results = await runSuiteCompat(rootSuite, opts);
  printReport(results, opts.reporter);

  return { code: results.failed.length === 0 ? 0 : 1, results };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // registration API
  describe,
  it,
  test,
  suite: describe,
  before,
  after,
  beforeEach,
  afterEach,
  // assertions
  assert,
  expect,
  AssertionError,
  assertEqual,
  assertOk,
  // internals / tooling
  createSuite,
  resetRegistry,
  containsOnly,
  runSuite: runSuiteCompat,
  withTimeout,
  deepEqual,
  // reporters
  getReporter,
  printReport,
  specReporter,
  tapReporter,
  dotReporter,
  jsonReporter,
  // CLI
  parseArgs,
  usage,
  findTestFiles,
  loadTestFile,
  registerExportedObject,
  main,
};

if (require.main === module) {
  main()
    .then((result) => {
      process.exitCode = result && typeof result.code === 'number' ? result.code : 0;
    })
    .catch((err) => {
      process.stderr.write('Runner crashed: ' + ((err && err.stack) || err) + '\n');
      process.exitCode = 1;
    });
}
