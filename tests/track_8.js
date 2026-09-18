#!/usr/bin/env node
'use strict';

/**
 * tests/track_8.js — Track #8: race strategy & pit-stop planning for the Phoenix
 * arena.
 * ============================================================================
 * ZERO external dependencies. Runs on a bare Node.js runtime (>= 14) with no
 * jest / mocha / chai installed. Ships its own tiny BDD harness:
 *
 *     describe(name, fn)   group related tests
 *     it(name, fn)         a single (possibly async) test case
 *     it.skip(name, fn)    mark a test as pending
 *     before / beforeEach  setup hooks
 *     assert.*             a small assertion library
 *
 * The "race strategy" model below is pure and self-contained: it models a race
 * distance, a driver's fuel and tyre characteristics, and the cost of a stint
 * and of a pit stop. From that it derives the optimal pit plan, the feasible
 * pit window and driver standings. Nothing outside this file is required, so
 * the suite can run even when the rest of the repository is not wired up.
 *
 * Cost model (all in milliseconds):
 *   - every lap costs driver.baseLapMs;
 *   - carrying fuel is penalised: a stint of n laps pays
 *       fuelEffectMsPerLap * (0 + 1 + ... + n)   [fuel burnt every lap];
 *   - tyre degradation is penalised: a stint of n laps pays
 *       tyreDegradeMsPerLap * (0 + 1 + ... + (n - 1));
 *   - every pit stop adds driver.pitLossMs.
 *
 * Usage:
 *     node tests/track_8.js            # run the whole suite
 *     node --check tests/track_8.js    # syntax check only
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

const assert = {
  fail(message) {
    throw new AssertionError(message || 'assert.fail()');
  },
  ok(value, message) {
    if (!value) throw new AssertionError(message || `expected ${value} to be truthy`);
  },
  equal(actual, expected, message) {
    if (actual != expected) {
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
    if (a !== b) throw new AssertionError(message || `expected ${a} deep-equal ${b}`);
  },
  throws(fn, message) {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
    }
    if (!threw) throw new AssertionError(message || 'expected function to throw');
  },
  rejects(promise, message) {
    return Promise.resolve(promise).then(
      () => {
        throw new AssertionError(message || 'expected promise to reject');
      },
      () => undefined
    );
  },
};

/* ===========================================================================
 * 2. Tiny BDD harness
 * ========================================================================= */

const rootSuite = { title: '(root)', tests: [], suites: [] };
let currentSuite = rootSuite;

function describe(title, fn) {
  const suite = { title, tests: [], suites: [] };
  const parent = currentSuite;
  parent.suites.push(suite);
  currentSuite = suite;
  fn();
  currentSuite = parent;
}

function it(title, fn) {
  currentSuite.tests.push({ title, fn, skip: false });
}

it.skip = function skip(title, fn) {
  currentSuite.tests.push({ title, fn, skip: true });
};

let beforeHook = null;
let beforeEachHook = null;

function before(fn) {
  beforeHook = fn;
}
function beforeEach(fn) {
  beforeEachHook = fn;
}

function collect(suite, prefix, out) {
  const name = prefix ? `${prefix} > ${suite.title}` : suite.title;
  for (const t of suite.tests) out.push({ name: `${name} > ${t.title}`, test: t });
  for (const s of suite.suites) collect(s, name, out);
  return out;
}

async function run() {
  const cases = collect(rootSuite, '', []);
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const { name, test } of cases) {
    if (test.skip) {
      skipped += 1;
      console.log(`  - SKIP  ${name}`);
      continue;
    }
    try {
      if (beforeHook) await beforeHook();
      if (beforeEachHook) await beforeEachHook();
      await test.fn();
      passed += 1;
      console.log(`  \u2713 PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.log(`  \u2717 FAIL  ${name}`);
      console.log(`        ${err && err.message ? err.message : err}`);
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed, ${skipped} skipped (${cases.length} total)`
  );
  return failed === 0;
}

/* ===========================================================================
 * 3. Track #8 — the model under test
 * ========================================================================= */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

function clamp(value, lo, hi) {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}

function formatLapTime(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
    throw new Error('formatLapTime: ms must be a non-negative finite number');
  }
  const totalMs = Math.round(ms);
  const minutes = Math.floor(totalMs / MS_PER_MINUTE);
  const seconds = Math.floor((totalMs % MS_PER_MINUTE) / MS_PER_SECOND);
  const millis = totalMs % MS_PER_SECOND;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function createDriver(id, opts) {
  const o = opts || {};
  return {
    id: String(id),
    baseLapMs: o.baseLapMs != null ? o.baseLapMs : 60000,
    fuelEffectMsPerLap: o.fuelEffectMsPerLap != null ? o.fuelEffectMsPerLap : 30,
    tyreDegradeMsPerLap: o.tyreDegradeMsPerLap != null ? o.tyreDegradeMsPerLap : 80,
    fuelCapacityLaps: o.fuelCapacityLaps != null ? o.fuelCapacityLaps : 16,
    tyreLifeLaps: o.tyreLifeLaps != null ? o.tyreLifeLaps : 14,
    pitLossMs: o.pitLossMs != null ? o.pitLossMs : 20000,
  };
}

function createRace(spec) {
  const s = spec || {};
  return {
    name: s.name || 'Track #8',
    totalLaps: s.totalLaps != null ? s.totalLaps : 30,
    drivers: [],
  };
}

function addDriver(race, id, opts) {
  if (!race || !Array.isArray(race.drivers)) throw new Error('addDriver: race is required');
  if (race.drivers.some((d) => d.id === String(id))) {
    throw new Error(`addDriver: driver "${id}" already registered`);
  }
  const driver = createDriver(id, opts);
  race.drivers.push(driver);
  return driver;
}

function getDriver(race, id) {
  const found = race.drivers.find((d) => d.id === String(id));
  return found || null;
}

function maxStintLaps(race, driver) {
  return Math.max(1, Math.min(driver.fuelCapacityLaps, driver.tyreLifeLaps, race.totalLaps));
}

function fuelPenalty(driver, laps) {
  return driver.fuelEffectMsPerLap * ((laps * (laps + 1)) / 2);
}

function tyrePenalty(driver, laps) {
  return driver.tyreDegradeMsPerLap * ((laps * (laps - 1)) / 2);
}

function stintCost(driver, laps) {
  if (!Number.isInteger(laps) || laps < 1) {
    throw new Error('stintCost: laps must be a positive integer');
  }
  return laps * driver.baseLapMs + fuelPenalty(driver, laps) + tyrePenalty(driver, laps);
}

function stintBreakdown(driver, laps) {
  const base = laps * driver.baseLapMs;
  const fuel = fuelPenalty(driver, laps);
  const tyre = tyrePenalty(driver, laps);
  return { base, fuel, tyre, total: base + fuel + tyre };
}

function stintsFromStops(race, stops) {
  if (!Array.isArray(stops)) throw new Error('stintsFromStops: stops must be an array');
  let prev = 0;
  for (const stop of stops) {
    if (!Number.isInteger(stop) || stop < 1 || stop > race.totalLaps - 1) {
      throw new Error(`stintsFromStops: invalid stop lap ${stop}`);
    }
    if (stop <= prev) throw new Error('stintsFromStops: stops must be strictly increasing');
    prev = stop;
  }
  const stints = [];
  let cursor = 0;
  for (const stop of stops) {
    stints.push(stop - cursor);
    cursor = stop;
  }
  stints.push(race.totalLaps - cursor);
  return stints;
}

function strategyCost(race, driver, stops) {
  const stints = stintsFromStops(race, stops);
  const limit = maxStintLaps(race, driver);
  let cost = 0;
  for (const len of stints) {
    if (len > limit) {
      throw new Error(`strategyCost: stint of ${len} laps exceeds limit of ${limit}`);
    }
    cost += stintCost(driver, len);
  }
  return cost + stops.length * driver.pitLossMs;
}

function planStrategy(race, driver) {
  const n = race.totalLaps;
  const limit = maxStintLaps(race, driver);
  const dp = new Array(n + 1).fill(Infinity);
  const choice = new Array(n + 1).fill(0);
  dp[0] = 0;

  for (let i = 1; i <= n; i += 1) {
    for (let len = 1; len <= limit && len <= i; len += 1) {
      const pit = i - len > 0 ? driver.pitLossMs : 0;
      const candidate = dp[i - len] + stintCost(driver, len) + pit;
      if (candidate < dp[i]) {
        dp[i] = candidate;
        choice[i] = len;
      }
    }
  }

  const stints = [];
  let i = n;
  while (i > 0) {
    stints.unshift(choice[i]);
    i -= choice[i];
  }
  const stops = [];
  let acc = 0;
  for (let k = 0; k < stints.length - 1; k += 1) {
    acc += stints[k];
    stops.push(acc);
  }
  return { stops, stints, cost: dp[n] };
}

function pitWindow(race, driver) {
  const limit = maxStintLaps(race, driver);
  if (race.totalLaps <= limit) return null; // no stop required
  if (race.totalLaps > 2 * limit) return null; // a single stop cannot cover it
  return { earliest: race.totalLaps - limit, latest: limit };
}

function rankDrivers(race) {
  return race.drivers
    .map((driver) => {
      const plan = planStrategy(race, driver);
      return { id: driver.id, stops: plan.stops.length, cost: plan.cost };
    })
    .sort((a, b) => a.cost - b.cost);
}

/* ===========================================================================
 * 4. Test suites
 * ========================================================================= */

describe('formatLapTime', () => {
  it('formats sub-minute times', () => {
    assert.strictEqual(formatLapTime(1500), '0:01.500');
    assert.strictEqual(formatLapTime(0), '0:00.000');
  });

  it('formats minute times', () => {
    assert.strictEqual(formatLapTime(61500), '1:01.500');
    assert.strictEqual(formatLapTime(60000), '1:00.000');
  });

  it('rejects invalid input', () => {
    assert.throws(() => formatLapTime(-1));
    assert.throws(() => formatLapTime('fast'));
  });
});

describe('clamp', () => {
  it('keeps values inside the range', () => {
    assert.strictEqual(clamp(5, 1, 10), 5);
    assert.strictEqual(clamp(0, 1, 10), 1);
    assert.strictEqual(clamp(99, 1, 10), 10);
  });
});

describe('race setup', () => {
  it('creates a race with defaults', () => {
    const race = createRace();
    assert.strictEqual(race.name, 'Track #8');
    assert.strictEqual(race.totalLaps, 30);
    assert.deepEqual(race.drivers, []);
  });

  it('registers and finds drivers', () => {
    const race = createRace({ totalLaps: 12 });
    const driver = addDriver(race, 'ada', { baseLapMs: 59000 });
    assert.strictEqual(driver.id, 'ada');
    assert.strictEqual(getDriver(race, 'ada'), driver);
    assert.strictEqual(getDriver(race, 'nobody'), null);
  });

  it('rejects duplicate drivers', () => {
    const race = createRace();
    addDriver(race, 'ada');
    assert.throws(() => addDriver(race, 'ada'));
  });
});

describe('stint cost model', () => {
  const driver = createDriver('ref');

  it('charges base time for a one-lap stint', () => {
    assert.strictEqual(stintCost(driver, 1), 60000 + 30 * 1);
  });

  it('matches the closed-form breakdown', () => {
    const parts = stintBreakdown(driver, 5);
    assert.strictEqual(parts.base, 300000);
    assert.strictEqual(parts.fuel, 30 * 15);
    assert.strictEqual(parts.tyre, 80 * 10);
    assert.strictEqual(parts.total, 301250);
  });

  it('grows tyre penalty super-linearly with stint length', () => {
    assert.ok(tyrePenalty(driver, 4) > 2 * tyrePenalty(driver, 2));
  });

  it('rejects invalid stint lengths', () => {
    assert.throws(() => stintCost(driver, 0));
    assert.throws(() => stintCost(driver, 2.5));
  });
});

describe('strategy planning', () => {
  const race = createRace({ totalLaps: 30 });
  const driver = addDriver(race, 'ada');

  it('produces stints that cover the race distance', () => {
    const plan = planStrategy(race, driver);
    const sum = plan.stints.reduce((a, b) => a + b, 0);
    assert.strictEqual(sum, race.totalLaps);
  });

  it('never exceeds the fuel/tyre stint limit', () => {
    const plan = planStrategy(race, driver);
    const limit = maxStintLaps(race, driver);
    for (const len of plan.stints) assert.ok(len <= limit, `stint ${len} > ${limit}`);
  });

  it('is consistent with strategyCost', () => {
    const plan = planStrategy(race, driver);
    assert.strictEqual(strategyCost(race, driver, plan.stops), plan.cost);
  });

  it('is optimal among all feasible strategies', () => {
    const small = createRace({ totalLaps: 12 });
    const d = addDriver(small, 'ada');
    const limit = maxStintLaps(small, d);
    const plans = [];
    (function enumerate(start, stints) {
      const remaining = small.totalLaps - start;
      if (remaining === 0) {
        plans.push(stints.slice());
        return;
      }
      for (let len = 1; len <= Math.min(limit, remaining); len += 1) {
        enumerate(start + len, stints.concat([len]));
      }
    })(0, []);
    let best = Infinity;
    for (const stints of plans) {
      const stops = [];
      let acc = 0;
      for (let k = 0; k < stints.length - 1; k += 1) {
        acc += stints[k];
        stops.push(acc);
      }
      best = Math.min(best, strategyCost(small, d, stops));
    }
    assert.strictEqual(planStrategy(small, d).cost, best);
  });

  it('rejects a stint that exceeds the limit', () => {
    assert.throws(() => strategyCost(race, driver, [29]));
  });

  it('rejects malformed stop lists', () => {
    assert.throws(() => strategyCost(race, driver, [10, 10]));
    assert.throws(() => strategyCost(race, driver, [31]));
  });
});

describe('pit window', () => {
  it('is null when no stop is needed', () => {
    const race = createRace({ totalLaps: 12 });
    const driver = addDriver(race, 'ada');
    assert.strictEqual(pitWindow(race, driver), null);
  });

  it('reports a feasible one-stop window', () => {
    const race = createRace({ totalLaps: 20 });
    const driver = addDriver(race, 'ada');
    assert.deepEqual(pitWindow(race, driver), { earliest: 6, latest: 14 });
  });

  it('is null when one stop cannot cover the distance', () => {
    const race = createRace({ totalLaps: 30 });
    const driver = addDriver(race, 'ada');
    assert.strictEqual(pitWindow(race, driver), null);
  });
});

describe('driver ranking', () => {
  it('orders the fastest driver first', () => {
    const race = createRace({ totalLaps: 24 });
    addDriver(race, 'slow', { baseLapMs: 62000 });
    addDriver(race, 'fast', { baseLapMs: 59000 });
    const ranking = rankDrivers(race);
    assert.strictEqual(ranking.length, 2);
    assert.strictEqual(ranking[0].id, 'fast');
    assert.strictEqual(ranking[1].id, 'slow');
    assert.ok(ranking[0].cost < ranking[1].cost);
  });
});

describe('async behaviour', () => {
  it('supports async assertions', async () => {
    await assert.rejects(Promise.reject(new Error('crash')), /crash/);
    const race = createRace({ totalLaps: 10 });
    const driver = addDriver(race, 'ada');
    assert.ok(planStrategy(race, driver).cost > 0);
  });

  it.skip('is pending by design', () => {
    assert.fail('should never run');
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
      console.error('track_8: fatal error', err);
      process.exitCode = 1;
    });
}

module.exports = {
  Track8: {
    createRace,
    addDriver,
    getDriver,
    maxStintLaps,
    stintCost,
    stintBreakdown,
    strategyCost,
    planStrategy,
    pitWindow,
    rankDrivers,
    formatLapTime,
    clamp,
  },
  run,
};
