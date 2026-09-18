#!/usr/bin/env node
'use strict';

/**
 * tests/track_1.js — Track #1: lap & sector tracking for the Phoenix arena.
 * ============================================================================
 * ZERO external dependencies. Runs on a bare Node.js runtime (>= 14) with no
 * jest / mocha / chai installed. Ships its own tiny BDD harness:
 *
 *     describe(name, fn)   group related tests
 *     it(name, fn)         a single (possibly async) test case
 *     it.skip(name, fn)    mark a test as pending
 *     before / after       per-suite setup / teardown
 *     beforeEach           per-test setup
 *     assert.*             a small assertion library
 *
 * The "track" model below is pure and self-contained: it models a race circuit
 * with drivers, laps and sectors and derives standings, best laps and a
 * consistency score. Nothing outside this file is required, so the suite can
 * run even when the rest of the repository is not wired up.
 *
 * Usage:
 *     node tests/track_1.js            # run the whole suite
 *     node --check tests/track_1.js    # syntax check only
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

function show(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'function') return value.name || '[Function]';
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return String(value);
  }
}

const assert = {
  ok(value, message) {
    if (!value) {
      throw new AssertionError(message || `expected ${show(value)} to be truthy`);
    }
  },

  strictEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new AssertionError(
        message || `expected ${show(actual)} === ${show(expected)}`
      );
    }
  },

  notStrictEqual(actual, expected, message) {
    if (actual === expected) {
      throw new AssertionError(
        message || `expected ${show(actual)} !== ${show(expected)}`
      );
    }
  },

  deepEqual(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new AssertionError(
        message || `expected ${a} to deep-equal ${b}`
      );
    }
  },

  isTrue(value, message) {
    assert.strictEqual(value, true, message);
  },

  isFalse(value, message) {
    assert.strictEqual(value, false, message);
  },

  isArray(value, message) {
    if (!Array.isArray(value)) {
      throw new AssertionError(message || `expected ${show(value)} to be an array`);
    }
  },

  isNumber(value, message) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new AssertionError(message || `expected ${show(value)} to be a number`);
    }
  },

  throws(fn, pattern, message) {
    let threw = false;
    try {
      fn();
    } catch (err) {
      threw = true;
      if (pattern && !pattern.test(String(err && err.message))) {
        throw new AssertionError(
          message || `expected error to match ${pattern}, got ${show(err && err.message)}`
        );
      }
    }
    if (!threw) {
      throw new AssertionError(message || 'expected function to throw');
    }
  },

  async rejects(promise, pattern, message) {
    let rejected = false;
    try {
      await promise;
    } catch (err) {
      rejected = true;
      if (pattern && !pattern.test(String(err && err.message))) {
        throw new AssertionError(
          message || `expected rejection to match ${pattern}`
        );
      }
    }
    if (!rejected) {
      throw new AssertionError(message || 'expected promise to reject');
    }
  },
};

/* ===========================================================================
 * 2. Tiny test registry / runner
 * ========================================================================= */

class Suite {
  constructor(name) {
    this.name = name;
    this.tests = [];
    this.beforeEachFns = [];
    this.afterEachFns = [];
  }
}

const root = new Suite('<root>');
const stack = [root];

function currentSuite() {
  return stack[stack.length - 1];
}

function describe(name, fn) {
  const suite = new Suite(name);
  currentSuite().tests.push(suite);
  stack.push(suite);
  try {
    fn();
  } finally {
    stack.pop();
  }
}

function registerTest(name, fn, skipped) {
  currentSuite().tests.push({ name, fn, skipped: Boolean(skipped) });
}

function it(name, fn) {
  registerTest(name, fn, false);
}

it.skip = function skip(name, fn) {
  registerTest(name, fn, true);
};

function beforeEach(fn) {
  currentSuite().beforeEachFns.push(fn);
}

function afterEach(fn) {
  currentSuite().afterEachFns.push(fn);
}

function before(fn) {
  currentSuite().beforeFns = currentSuite().beforeFns || [];
  currentSuite().beforeFns.push(fn);
}

function after(fn) {
  currentSuite().afterFns = currentSuite().afterFns || [];
  currentSuite().afterFns.push(fn);
}

async function runSuite(suite, path, stats, ancestors) {
  const label = path.length ? path.join(' > ') : suite.name;
  if (path.length) {
    process.stdout.write(`\n${label}\n`);
  }

  const inheritedBefore = ancestors.beforeEachFns || [];
  const inheritedAfter = ancestors.afterEachFns || [];
  const beforeEachFns = inheritedBefore.concat(suite.beforeEachFns || []);
  const afterEachFns = (suite.afterEachFns || []).concat(inheritedAfter);

  const childAncestors = { beforeEachFns, afterEachFns };

  if (suite.beforeFns) {
    for (const fn of suite.beforeFns) {
      await fn();
    }
  }

  for (const entry of suite.tests) {
    if (entry instanceof Suite) {
      await runSuite(entry, path.concat(entry.name), stats, childAncestors);
      continue;
    }
    if (entry.skipped) {
      stats.skipped += 1;
      process.stdout.write(`  - ${entry.name} (skipped)\n`);
      continue;
    }
    try {
      for (const fn of beforeEachFns) await fn();
      await entry.fn();
      for (const fn of afterEachFns) await fn();
      stats.passed += 1;
      process.stdout.write(`  \u2713 ${entry.name}\n`);
    } catch (err) {
      stats.failed += 1;
      stats.failures.push({ name: `${label} > ${entry.name}`, error: err });
      process.stdout.write(`  \u2717 ${entry.name}\n`);
      process.stdout.write(`      ${err && err.message ? err.message : err}\n`);
    }
  }

  if (suite.afterFns) {
    for (const fn of suite.afterFns) {
      await fn();
    }
  }
}

async function run() {
  const stats = { passed: 0, failed: 0, skipped: 0, failures: [] };
  await runSuite(root, [], stats, { beforeEachFns: [], afterEachFns: [] });

  process.stdout.write(
    `\n${stats.passed} passed, ${stats.failed} failed, ${stats.skipped} skipped\n`
  );
  if (stats.failed > 0) {
    process.stdout.write('\nFailures:\n');
    for (const failure of stats.failures) {
      process.stdout.write(`  - ${failure.name}: ${failure.error && failure.error.message}\n`);
    }
  }
  return stats.failed === 0;
}

/* ===========================================================================
 * 3. Track model (pure, dependency-free)
 * ========================================================================= */

const Track1 = {
  /**
   * Create an empty track for a circuit with `sectorCount` sectors per lap.
   */
  createTrack({ name = 'unnamed', sectorCount = 3 } = {}) {
    if (!Number.isInteger(sectorCount) || sectorCount < 1) {
      throw new RangeError('sectorCount must be a positive integer');
    }
    return {
      name,
      sectorCount,
      laps: [],
      sectors: Object.create(null),
    };
  },

  /**
   * Format milliseconds as m:ss.mmm.
   */
  formatLap(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`invalid lap time: ${ms}`);
    }
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const millis = Math.round(ms % 1000);
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${minutes}:${pad(seconds, 2)}.${pad(millis, 3)}`;
  },

  /**
   * Record a completed lap for a driver. Returns the immutable lap record.
   */
  recordLap(track, { driver, lapTimeMs, sectors = [] } = {}) {
    if (!driver || typeof driver !== 'string') {
      throw new TypeError('driver is required');
    }
    if (typeof lapTimeMs !== 'number' || !Number.isFinite(lapTimeMs) || lapTimeMs <= 0) {
      throw new RangeError('lapTimeMs must be a positive number');
    }
    if (sectors.length > 0 && sectors.length !== track.sectorCount) {
      throw new RangeError(
        `expected ${track.sectorCount} sector times, got ${sectors.length}`
      );
    }

    const lap = {
      index: track.laps.length + 1,
      driver,
      lapTimeMs,
      sectors: sectors.slice(),
      fastestSector: sectors.length ? Math.min(...sectors) : null,
    };
    track.laps.push(lap);

    if (sectors.length) {
      const bucket = track.sectors[driver] || (track.sectors[driver] = []);
      sectors.forEach((time, i) => {
        if (bucket[i] === undefined || time < bucket[i]) bucket[i] = time;
      });
    }
    return Object.freeze({ ...lap, sectors: Object.freeze(lap.sectors.slice()) });
  },

  /**
   * Aggregate standings: laps, best lap and total time per driver.
   */
  standings(track) {
    const byDriver = new Map();
    for (const lap of track.laps) {
      const row = byDriver.get(lap.driver) || {
        driver: lap.driver,
        laps: 0,
        totalMs: 0,
        bestMs: Infinity,
      };
      row.laps += 1;
      row.totalMs += lap.lapTimeMs;
      if (lap.lapTimeMs < row.bestMs) row.bestMs = lap.lapTimeMs;
      byDriver.set(lap.driver, row);
    }
    const rows = Array.from(byDriver.values()).map((row) => ({
      driver: row.driver,
      laps: row.laps,
      totalMs: row.totalMs,
      bestMs: row.bestMs === Infinity ? null : row.bestMs,
      bestLap: row.bestMs === Infinity ? null : Track1.formatLap(row.bestMs),
      averageMs: Math.round(row.totalMs / row.laps),
    }));
    rows.sort((a, b) => {
      if (a.bestMs === null) return 1;
      if (b.bestMs === null) return -1;
      if (a.bestMs !== b.bestMs) return a.bestMs - b.bestMs;
      return a.driver.localeCompare(b.driver);
    });
    return rows;
  },

  /**
   * Consistency = 1 - (stddev / mean), clamped to [0, 1]. Higher is steadier.
   */
  consistency(track, driver) {
    const times = track.laps.filter((l) => l.driver === driver).map((l) => l.lapTimeMs);
    if (times.length < 2) return null;
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const variance =
      times.reduce((acc, t) => acc + (t - mean) ** 2, 0) / times.length;
    const stddev = Math.sqrt(variance);
    if (mean === 0) return 1;
    const score = 1 - stddev / mean;
    return Math.max(0, Math.min(1, score));
  },

  /**
   * High-level summary used by the dashboard.
   */
  summarize(track) {
    const table = Track1.standings(track);
    const best = table.reduce((acc, row) => {
      if (row.bestMs === null) return acc;
      if (acc === null || row.bestMs < acc.bestMs) return row;
      return acc;
    }, null);

    return {
      circuit: track.name,
      laps: track.laps.length,
      drivers: table.length,
      leader: best ? best.driver : null,
      bestLap: best ? best.bestLap : null,
      bestLapMs: best ? best.bestMs : null,
      standings: table,
    };
  },

  bestSector(track, driver, sectorIndex) {
    const bucket = track.sectors[driver];
    if (!bucket || bucket[sectorIndex] === undefined) return null;
    return bucket[sectorIndex];
  },
};

/* ===========================================================================
 * 4. Test suites
 * ========================================================================= */

describe('Track1.formatLap', () => {
  it('formats sub-minute times', () => {
    assert.strictEqual(Track1.formatLap(1500), '0:01.500');
  });

  it('formats minute times with zero padding', () => {
    assert.strictEqual(Track1.formatLap(60500), '1:00.500');
    assert.strictEqual(Track1.formatLap(83456), '1:23.456');
  });

  it('rejects invalid input', () => {
    assert.throws(() => Track1.formatLap(-1), /invalid lap time/);
    assert.throws(() => Track1.formatLap(NaN), /invalid lap time/);
  });
});

describe('createTrack', () => {
  it('creates an empty circuit', () => {
    const track = Track1.createTrack({ name: 'phoenix', sectorCount: 3 });
    assert.strictEqual(track.name, 'phoenix');
    assert.strictEqual(track.sectorCount, 3);
    assert.deepEqual(track.laps, []);
    assert.strictEqual(track.laps.length, 0);
  });

  it('validates sectorCount', () => {
    assert.throws(() => Track1.createTrack({ sectorCount: 0 }), /positive integer/);
    assert.throws(() => Track1.createTrack({ sectorCount: 1.5 }), /positive integer/);
  });
});

describe('recordLap', () => {
  let track;
  beforeEach(() => {
    track = Track1.createTrack({ name: 'phoenix', sectorCount: 3 });
  });

  it('appends laps with sequential indexes', () => {
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60000 });
    const second = Track1.recordLap(track, { driver: 'ada', lapTimeMs: 59000 });
    assert.strictEqual(track.laps.length, 2);
    assert.strictEqual(second.index, 2);
  });

  it('tracks best sector times per driver', () => {
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60000, sectors: [20000, 21000, 19000] });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 61000, sectors: [19500, 22000, 20500] });
    assert.strictEqual(Track1.bestSector(track, 'ada', 0), 19500);
    assert.strictEqual(Track1.bestSector(track, 'ada', 2), 19000);
  });

  it('requires a driver and a positive lap time', () => {
    assert.throws(() => Track1.recordLap(track, { lapTimeMs: 1000 }), /driver is required/);
    assert.throws(() => Track1.recordLap(track, { driver: 'ada', lapTimeMs: 0 }), /positive number/);
  });

  it('validates sector count when provided', () => {
    assert.throws(
      () => Track1.recordLap(track, { driver: 'ada', lapTimeMs: 1000, sectors: [1, 2] }),
      /expected 3 sector times/
    );
  });

  it('returns a frozen snapshot', () => {
    const lap = Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60000 });
    assert.isTrue(Object.isFrozen(lap));
  });
});

describe('standings & summarize', () => {
  it('orders drivers by best lap', () => {
    const track = Track1.createTrack({ name: 'phoenix', sectorCount: 3 });
    Track1.recordLap(track, { driver: 'grace', lapTimeMs: 61000 });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60500 });
    const table = Track1.standings(track);
    assert.strictEqual(table[0].driver, 'ada');
    assert.strictEqual(table[0].bestLap, '1:00.500');
    assert.strictEqual(table[1].driver, 'grace');
  });

  it('computes per-driver aggregates', () => {
    const track = Track1.createTrack({ name: 'phoenix', sectorCount: 3 });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60000 });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 62000 });
    const row = Track1.standings(track)[0];
    assert.strictEqual(row.laps, 2);
    assert.strictEqual(row.totalMs, 122000);
    assert.strictEqual(row.averageMs, 61000);
  });

  it('summarizes a populated track', () => {
    const track = Track1.createTrack({ name: 'phoenix', sectorCount: 3 });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60500 });
    Track1.recordLap(track, { driver: 'grace', lapTimeMs: 61000 });
    const summary = Track1.summarize(track);
    assert.strictEqual(summary.leader, 'ada');
    assert.strictEqual(summary.bestLap, '1:00.500');
    assert.strictEqual(summary.laps, 2);
    assert.strictEqual(summary.drivers, 2);
  });

  it('handles an empty track', () => {
    const track = Track1.createTrack({ name: 'phoenix' });
    const summary = Track1.summarize(track);
    assert.strictEqual(summary.leader, null);
    assert.strictEqual(summary.laps, 0);
  });
});

describe('consistency', () => {
  it('returns null with fewer than two laps', () => {
    const track = Track1.createTrack({ name: 'phoenix' });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60000 });
    assert.strictEqual(Track1.consistency(track, 'ada'), null);
  });

  it('scores a perfectly consistent driver at 1', () => {
    const track = Track1.createTrack({ name: 'phoenix' });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60000 });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 60000 });
    assert.strictEqual(Track1.consistency(track, 'ada'), 1);
  });

  it('drops the score for volatile drivers', () => {
    const track = Track1.createTrack({ name: 'phoenix' });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 50000 });
    Track1.recordLap(track, { driver: 'ada', lapTimeMs: 90000 });
    const score = Track1.consistency(track, 'ada');
    assert.isNumber(score);
    assert.ok(score < 1, 'volatile driver should score below 1');
    assert.ok(score >= 0, 'score must be clamped at 0');
  });
});

describe('async harness', () => {
  it('supports async assertions', async () => {
    await assert.rejects(Promise.reject(new Error('crash')), /crash/);
    assert.strictEqual(Track1.formatLap(1500), '0:01.500');
  });

  it.skip('is intentionally pending', () => {
    throw new Error('should never run');
  });
});

/* ===========================================================================
 * 5. Entry point
 * ========================================================================= */

if (require.main === module) {
  run()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err) => {
      console.error('track_1: fatal error', err);
      process.exitCode = 1;
    });
}

module.exports = { Track1, run };
