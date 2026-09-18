#!/usr/bin/env node
'use strict';

/**
 * tests/track_4.js — Track #4: pit-stop strategy & race telemetry.
 * ============================================================================
 * ZERO external dependencies. Runs on a bare Node.js runtime (>= 14) with no
 * jest / mocha / chai installed. Ships its own tiny BDD harness and assertion
 * library, so the suite is fully self-contained.
 *
 *     describe(name, fn)   group related tests
 *     it(name, fn)         a single (possibly async) test case
 *     it.skip(name, fn)    mark a test as pending
 *     before / after       per-run setup / teardown
 *     beforeEach           per-test setup
 *     assert.*             a small assertion library
 *
 * The "track #4" model models a race with a fuel tank, tyre wear, pit stops
 * and a simple stint planner. Everything is pure and deterministic so results
 * are reproducible in CI.
 *
 * Usage:
 *     node tests/track_4.js            # run the whole suite
 *     node --check tests/track_4.js    # syntax check only
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
  notOk(value, message) {
    if (value) throw new AssertionError(message || `expected ${value} to be falsy`);
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
  closeTo(actual, expected, tolerance, message) {
    const tol = tolerance == null ? 1e-9 : tolerance;
    if (Math.abs(actual - expected) > tol) {
      throw new AssertionError(
        message || `expected ${actual} to be within ${tol} of ${expected}`
      );
    }
  },
  between(value, min, max, message) {
    if (value < min || value > max) {
      throw new AssertionError(
        message || `expected ${value} to be between ${min} and ${max}`
      );
    }
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

const rootSuite = { title: '(root)', tests: [], suites: [], hooks: {} };
let currentSuite = rootSuite;
const hookStack = [];

function describe(title, fn) {
  const suite = { title, tests: [], suites: [], hooks: {} };
  const parent = currentSuite;
  parent.suites.push(suite);
  currentSuite = suite;
  hookStack.push(suite);
  fn();
  hookStack.pop();
  currentSuite = parent;
}

function it(title, fn) {
  currentSuite.tests.push({ title, fn, skip: false });
}

it.skip = function skip(title, fn) {
  currentSuite.tests.push({ title, fn, skip: true });
};

function registerHook(kind, fn) {
  const suite = hookStack[hookStack.length - 1] || rootSuite;
  if (!suite.hooks[kind]) suite.hooks[kind] = [];
  suite.hooks[kind].push(fn);
}

function before(fn) {
  registerHook('before', fn);
}
function after(fn) {
  registerHook('after', fn);
}
function beforeEach(fn) {
  registerHook('beforeEach', fn);
}
function afterEach(fn) {
  registerHook('afterEach', fn);
}

function collect(suite, prefix, out, inheritedHooks) {
  const name = prefix ? `${prefix} > ${suite.title}` : suite.title;
  const hooks = {
    before: (inheritedHooks.before || []).concat(suite.hooks.before || []),
    beforeEach: (inheritedHooks.beforeEach || []).concat(suite.hooks.beforeEach || []),
    after: (inheritedHooks.after || []).concat(suite.hooks.after || []),
    afterEach: (inheritedHooks.afterEach || []).concat(suite.hooks.afterEach || []),
  };
  for (const t of suite.tests) {
    out.push({ name: `${name} > ${t.title}`, test: t, hooks });
  }
  for (const s of suite.suites) collect(s, name, out, hooks);
  return out;
}

async function runHookList(list) {
  for (const fn of list) await fn();
}

async function run() {
  const cases = collect(rootSuite, '', [], {});
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const { name, test, hooks } of cases) {
    if (test.skip) {
      skipped += 1;
      console.log(`  \u2013 SKIP  ${name}`);
      continue;
    }
    try {
      await runHookList(hooks.before);
      await runHookList(hooks.beforeEach);
      await test.fn();
      await runHookList(hooks.afterEach);
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
  console.log(failed === 0 ? 'OK' : 'FAILURES PRESENT');
  return failed === 0;
}

/* ===========================================================================
 * 3. Track #4 — the model under test
 * ========================================================================= */

const MS_PER_SECOND = 1000;

function createRace(config) {
  const cfg = config || {};
  return {
    name: cfg.name || 'Track #4',
    lapLengthKm: cfg.lapLengthKm || 5.0,
    totalLaps: cfg.totalLaps || 50,
    tankCapacityL: cfg.tankCapacityL || 110,
    fuelPerLapL: cfg.fuelPerLapL || 1.9,
    pitLossMs: cfg.pitLossMs || 22000,
    tyreLifeLaps: cfg.tyreLifeLaps || 18,
    laps: [],
    pitStops: [],
  };
}

function fuelBurn(race, laps) {
  return round3(laps * race.fuelPerLapL);
}

function createCar(driver, race) {
  return {
    driver: driver,
    race: race,
    fuelL: race.tankCapacityL,
    fuelStartL: race.tankCapacityL,
    tyreAgeLaps: 0,
    stints: [],
    pitCount: 0,
    stopped: false,
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function clampFuel(car) {
  if (car.fuelL > car.race.tankCapacityL) car.fuelL = car.race.tankCapacityL;
  if (car.fuelL < 0) car.fuelL = 0;
  return car.fuelL;
}

/**
 * Run one flying lap. Returns the lap record and mutates the car state.
 * Throws when the car has no fuel left.
 */
function runLap(car, lap) {
  const race = car.race;
  const lapNo = lap == null ? car.race.laps.length + 1 : lap;
  if (car.fuelL <= 0) throw new Error('runLap: out of fuel');
  if (car.stopped) throw new Error('runLap: car is stopped');

  const burn = race.fuelPerLapL;
  car.fuelL = round3(car.fuelL - burn);
  clampFuel(car);
  car.tyreAgeLaps += 1;

  // Degradation is quadratic-ish: fresh tyres are fastest.
  const age = car.tyreAgeLaps;
  const wearPenaltyMs = Math.min(age, race.tyreLifeLaps) * 120 + age * age * 4;
  const fuelPenaltyMs = car.fuelL * 30;
  const baseLapMs = 90000;
  const lapTimeMs = Math.round(baseLapMs + wearPenaltyMs + fuelPenaltyMs);

  const record = {
    lap: lapNo,
    driver: car.driver,
    lapTimeMs: lapTimeMs,
    fuelL: car.fuelL,
    tyreAgeLaps: car.tyreAgeLaps,
    pitted: false,
  };
  race.laps.push(record);
  return record;
}

function pitStop(car, options) {
  const opts = options || {};
  const race = car.race;
  const refuelL = opts.refuelL == null ? race.tankCapacityL - car.fuelL : opts.refuelL;
  const freshTyres = opts.freshTyres !== false;

  const prevAge = car.tyreAgeLaps;
  car.fuelL = round3(car.fuelL + refuelL);
  clampFuel(car);
  if (freshTyres) car.tyreAgeLaps = 0;
  car.pitCount += 1;

  const stop = {
    lap: race.laps.length,
    driver: car.driver,
    refuelL: round3(refuelL),
    freshTyres: freshTyres,
    lossMs: race.pitLossMs,
    tyreAgeBefore: prevAge,
  };
  race.pitStops.push(stop);
  car.stints.push({ startLap: race.laps.length + 1, endLap: null, laps: 0 });
  return stop;
}

function lapsByDriver(race, driver) {
  return race.laps.filter((l) => l.driver === driver);
}

function bestLap(race, driver) {
  const laps = driver ? lapsByDriver(race, driver) : race.laps;
  if (laps.length === 0) return null;
  return laps.reduce((b, l) => (l.lapTimeMs < b.lapTimeMs ? l : b), laps[0]);
}

function worstLap(race, driver) {
  const laps = driver ? lapsByDriver(race, driver) : race.laps;
  if (laps.length === 0) return null;
  return laps.reduce((w, l) => (l.lapTimeMs > w.lapTimeMs ? l : w), laps[0]);
}

function averageLapMs(race, driver) {
  const laps = driver ? lapsByDriver(race, driver) : race.laps;
  if (laps.length === 0) return null;
  return laps.reduce((s, l) => s + l.lapTimeMs, 0) / laps.length;
}

function totalTimeMs(race, driver) {
  const laps = driver ? lapsByDriver(race, driver) : race.laps;
  if (laps.length === 0) return null;
  return laps.reduce((s, l) => s + l.lapTimeMs, 0);
}

function standardDeviation(values) {
  if (!values || values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length;
  return Math.sqrt(variance);
}

function consistency(race, driver) {
  const laps = lapsByDriver(race, driver);
  if (laps.length < 2) return 1;
  const times = laps.map((l) => l.lapTimeMs);
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const cv = standardDeviation(times) / mean;
  return round3(Math.max(0, 1 - cv));
}

/**
 * Plans the minimum number of pit stops required to finish the race given the
 * fuel tank, per-lap burn and tyre life. Pure helper, never mutates anything.
 */
function planStints(race) {
  if (race.fuelPerLapL <= 0) throw new Error('planStints: fuelPerLapL must be > 0');
  const rangeLaps = Math.floor(race.tankCapacityL / race.fuelPerLapL);
  const stintLength = Math.max(1, Math.min(rangeLaps, race.tyreLifeLaps));
  const stints = [];
  let remaining = race.totalLaps;
  while (remaining > 0) {
    const laps = Math.min(stintLength, remaining);
    stints.push({ laps: laps });
    remaining -= laps;
  }
  return {
    stintLength: stintLength,
    fuelRangeLaps: rangeLaps,
    stops: Math.max(0, stints.length - 1),
    stints: stints,
  };
}

function simulate(race, driver) {
  const car = createCar(driver, race);
  const plan = planStints(race);
  let stintsDone = 0;
  for (let lap = 1; lap <= race.totalLaps; lap += 1) {
    const needed = race.totalLaps - lap + 1;
    const fuelLapsLeft = car.fuelL / race.fuelPerLapL;
    const mustPit =
      fuelLapsLeft < 1.0001 ||
      car.tyreAgeLaps >= race.tyreLifeLaps ||
      (fuelLapsLeft < needed && race.laps.length + 1 < race.totalLaps && mustRefuel(race, car, needed));
    if (mustPit && lap > 1) {
      pitStop(car, {});
      stintsDone += 1;
    }
    runLap(car, lap);
  }
  return { car: car, plan: plan, stintsDone: stintsDone };
}

function mustRefuel(race, car, lapsLeft) {
  const lapsPossible = Math.floor(car.fuelL / race.fuelPerLapL);
  return lapsPossible < lapsLeft;
}

function fuelAtLap(race, driver, lap) {
  const laps = lapsByDriver(race, driver);
  const rec = laps.find((l) => l.lap === lap);
  return rec ? rec.fuelL : null;
}

function fuelCurve(race, driver) {
  return lapsByDriver(race, driver).map((l) => ({ lap: l.lap, fuelL: l.fuelL }));
}

function pitStopCount(race, driver) {
  return race.pitStops.filter((p) => p.driver === driver).length;
}

function averagePitLossMs(race) {
  if (race.pitStops.length === 0) return 0;
  return race.pitStops.reduce((s, p) => s + p.lossMs, 0) / race.pitStops.length;
}

/* ===========================================================================
 * 4. Test suites
 * ========================================================================= */

describe('Track #4 > race configuration', function () {
  it('applies sane defaults', function () {
    const race = createRace();
    assert.strictEqual(race.name, 'Track #4');
    assert.strictEqual(race.totalLaps, 50);
    assert.ok(race.tankCapacityL > 0);
    assert.ok(race.fuelPerLapL > 0);
  });

  it('honours overrides', function () {
    const race = createRace({ name: 'Monza', totalLaps: 53, fuelPerLapL: 2.1 });
    assert.strictEqual(race.name, 'Monza');
    assert.strictEqual(race.totalLaps, 53);
    assert.strictEqual(race.fuelPerLapL, 2.1);
  });
});

describe('Track #4 > fuel model', function () {
  it('burns the configured amount per lap', function () {
    const race = createRace({ fuelPerLapL: 2.0, tankCapacityL: 100 });
    const car = createCar('VER', race);
    runLap(car, 1);
    assert.closeTo(car.fuelL, 98, 1e-9);
  });

  it('never drops below zero', function () {
    const race = createRace({ fuelPerLapL: 10, tankCapacityL: 20 });
    const car = createCar('VER', race);
    runLap(car, 1);
    runLap(car, 2);
    assert.strictEqual(car.fuelL, 0);
  });

  it('throws when driving on an empty tank', function () {
    const race = createRace({ fuelPerLapL: 10, tankCapacityL: 10 });
    const car = createCar('HAM', race);
    runLap(car, 1);
    assert.throws(() => runLap(car, 2), 'expected out-of-fuel error');
  });

  it('computes the fuel curve', function () {
    const race = createRace({ fuelPerLapL: 2, tankCapacityL: 100 });
    const car = createCar('NOR', race);
    runLap(car, 1);
    runLap(car, 2);
    const curve = fuelCurve(race, 'NOR');
    assert.strictEqual(curve.length, 2);
    assert.strictEqual(curve[0].lap, 1);
    assert.closeTo(curve[1].fuelL, 96, 1e-9);
  });
});

describe('Track #4 > tyre degradation', function () {
  it('slows the car as the tyres age', function () {
    const race = createRace({ fuelPerLapL: 0.1, tankCapacityL: 100 });
    const car = createCar('LEC', race);
    const lap1 = runLap(car, 1);
    const lap2 = runLap(car, 2);
    assert.ok(lap2.lapTimeMs > lap1.lapTimeMs, 'lap 2 should be slower than lap 1');
  });

  it('resets tyre age on a fresh-tyre pit stop', function () {
    const race = createRace({ fuelPerLapL: 1, tankCapacityL: 100 });
    const car = createCar('SAI', race);
    runLap(car, 1);
    runLap(car, 2);
    assert.strictEqual(car.tyreAgeLaps, 2);
    pitStop(car, {});
    assert.strictEqual(car.tyreAgeLaps, 0);
  });

  it('keeps tyre age when staying out on used tyres', function () {
    const race = createRace({ fuelPerLapL: 1, tankCapacityL: 100 });
    const car = createCar('SAI', race);
    runLap(car, 1);
    pitStop(car, { freshTyres: false });
    assert.strictEqual(car.tyreAgeLaps, 1);
  });
});

describe('Track #4 > pit strategy', function () {
  it('plans at least one pit stop for a long race', function () {
    const race = createRace({
      totalLaps: 60,
      tankCapacityL: 50,
      fuelPerLapL: 2,
      tyreLifeLaps: 20,
    });
    const plan = planStints(race);
    assert.ok(plan.stops >= 1, 'long race should require fuel stops');
    assert.strictEqual(plan.fuelRangeLaps, 25);
  });

  it('produces stints that cover every lap exactly once', function () {
    const race = createRace({
      totalLaps: 57,
      tankCapacityL: 40,
      fuelPerLapL: 3,
      tyreLifeLaps: 15,
    });
    const plan = planStints(race);
    const covered = plan.stints.reduce((s, st) => s + st.laps, 0);
    assert.strictEqual(covered, 57);
    assert.ok(plan.stints.every((st) => st.laps > 0));
  });

  it('rejects an impossible zero-burn configuration', function () {
    const race = createRace({ fuelPerLapL: 0 });
    assert.throws(() => planStints(race));
  });

  it('refuels and counts pit stops', function () {
    const race = createRace({ fuelPerLapL: 1, tankCapacityL: 50 });
    const car = createCar('RUS', race);
    runLap(car, 1);
    runLap(car, 2);
    const before = car.fuelL;
    pitStop(car, {});
    assert.strictEqual(car.fuelL, 50);
    assert.ok(car.fuelL > before);
    assert.strictEqual(pitStopCount(race, 'RUS'), 1);
  });

  it('records the tyre age before the stop', function () {
    const race = createRace({ fuelPerLapL: 1, tankCapacityL: 50 });
    const car = createCar('PIA', race);
    runLap(car, 1);
    runLap(car, 2);
    runLap(car, 3);
    const stop = pitStop(car, {});
    assert.strictEqual(stop.tyreAgeBefore, 3);
    assert.strictEqual(stop.freshTyres, true);
  });
});

describe('Track #4 > lap statistics', function () {
  let race;
  beforeEach(function () {
    race = createRace({ fuelPerLapL: 1, tankCapacityL: 100 });
    const car = createCar('ALO', race);
    runLap(car, 1);
    runLap(car, 2);
    runLap(car, 3);
  });

  it('finds the best lap', function () {
    const best = bestLap(race, 'ALO');
    assert.strictEqual(best.lap, 1, 'first lap is fastest with fresh tyres');
  });

  it('finds the worst lap', function () {
    const worst = worstLap(race, 'ALO');
    assert.strictEqual(worst.lap, 3);
  });

  it('computes the average lap time', function () {
    const avg = averageLapMs(race, 'ALO');
    assert.ok(avg > 0);
    assert.ok(avg >= bestLap(race, 'ALO').lapTimeMs);
  });

  it('computes the total time', function () {
    const total = totalTimeMs(race, 'ALO');
    const avg = averageLapMs(race, 'ALO');
    assert.closeTo(total / 3, avg, 1e-9);
  });

  it('returns null for an unknown driver', function () {
    assert.strictEqual(bestLap(race, 'NOBODY'), null);
    assert.strictEqual(averageLapMs(race, 'NOBODY'), null);
    assert.strictEqual(totalTimeMs(race, 'NOBODY'), null);
  });

  it('reports a consistency score in [0, 1]', function () {
    const c = consistency(race, 'ALO');
    assert.between(c, 0, 1);
    assert.ok(c > 0.5, 'a clean stint should be consistent');
  });

  it('returns perfect consistency with fewer than two laps', function () {
    const solo = createRace({ fuelPerLapL: 1, tankCapacityL: 100 });
    const car = createCar('GAS', solo);
    runLap(car, 1);
    assert.strictEqual(consistency(solo, 'GAS'), 1);
  });
});

describe('Track #4 > full race simulation', function () {
  it('completes every scheduled lap', function () {
    const race = createRace({
      totalLaps: 20,
      fuelPerLapL: 2,
      tankCapacityL: 30,
      tyreLifeLaps: 8,
    });
    const result = simulate(race, 'BOT');
    assert.strictEqual(lapsByDriver(race, 'BOT').length, 20);
    assert.ok(result.stintsDone >= 2, 'fuel + tyres should force multiple stops');
  });

  it('never runs the tank dry during a simulated race', function () {
    const race = createRace({
      totalLaps: 30,
      fuelPerLapL: 3,
      tankCapacityL: 40,
      tyreLifeLaps: 10,
    });
    simulate(race, 'OCO');
    const curve = fuelCurve(race, 'OCO');
    assert.ok(curve.every((p) => p.fuelL >= 0));
  });

  it('is deterministic across identical runs', function () {
    const spec = { totalLaps: 12, fuelPerLapL: 2, tankCapacityL: 30, tyreLifeLaps: 6 };
    const r1 = createRace(spec);
    const r2 = createRace(spec);
    simulate(r1, 'TSU');
    simulate(r2, 'TSU');
    assert.deepEqual(totalTimeMs(r1, 'TSU'), totalTimeMs(r2, 'TSU'));
    assert.deepEqual(fuelCurve(r1, 'TSU'), fuelCurve(r2, 'TSU'));
  });

  it('averages the pit losses', function () {
    const race = createRace({
      totalLaps: 25,
      fuelPerLapL: 3,
      tankCapacityL: 30,
      tyreLifeLaps: 8,
      pitLossMs: 21000,
    });
    simulate(race, 'STR');
    assert.ok(pitStopCount(race, 'STR') >= 1);
    assert.strictEqual(averagePitLossMs(race), 21000);
  });
});

describe('Track #4 > edge cases', function () {
  it('stops a car that cannot run', function () {
    const race = createRace({ fuelPerLapL: 1, tankCapacityL: 5 });
    const car = createCar('MAG', race);
    car.stopped = true;
    assert.throws(() => runLap(car, 1), 'stopped car must not lap');
  });

  it('keeps fuel within capacity after refuelling', function () {
    const race = createRace({ fuelPerLapL: 1, tankCapacityL: 50 });
    const car = createCar('HUL', race);
    pitStop(car, { refuelL: 999 });
    assert.strictEqual(car.fuelL, 50);
  });

  it.skip('models safety-car fuel saving (not implemented yet)', function () {
    assert.ok(true);
  });

  it('zero pit stops means zero average loss', function () {
    const race = createRace();
    assert.strictEqual(averagePitLossMs(race), 0);
  });
});

/* ===========================================================================
 * 5. Entry point
 * ========================================================================= */

if (require.main === module) {
  run().then((ok) => {
    process.exitCode = ok ? 0 : 1;
  });
}

module.exports = {
  assert,
  createRace,
  createCar,
  runLap,
  pitStop,
  planStints,
  simulate,
  bestLap,
  worstLap,
  averageLapMs,
  totalTimeMs,
  consistency,
  fuelCurve,
  pitStopCount,
  averagePitLossMs,
  run,
};
