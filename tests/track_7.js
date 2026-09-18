#!/usr/bin/env node
'use strict';

/**
 * tests/track_7.js — Track #7: pit-stop strategy, fuel/tyre model & championship
 * points.
 * ============================================================================
 * ZERO external dependencies. Runs on a bare Node.js runtime (>= 14) with no
 * jest / mocha / chai installed. Ships its own tiny BDD harness:
 *
 *     describe(name, fn)   group related tests
 *     it(name, fn)         a single (possibly async) test case
 *     it.skip(name, fn)    mark a test as pending
 *     beforeEach(fn)       per-test setup (per suite)
 *     assert.*             a small assertion library
 *
 * The "pit strategy" model is pure and self-contained: a race car burns fuel,
 * wears tyres, serves pit stops and scores championship points against a
 * configurable points table. Nothing outside this file is required, so the
 * suite runs even when the rest of the repository is not wired up.
 *
 * Usage:
 *     node tests/track_7.js            # run the whole suite
 *     node --check tests/track_7.js    # syntax check only
 *
 * Exit code is 0 when every executed test passes, and 1 otherwise.
 * ============================================================================
 */

const assert = require('assert');

/* ===========================================================================
 * 1. Tiny test harness
 * ========================================================================= */

const harness = {
  suites: [],
  current: null,
};

function describe(name, fn) {
  const suite = { name: name, tests: [], beforeEach: [] };
  const parent = harness.current;
  harness.suites.push(suite);
  harness.current = suite;
  try {
    fn();
  } finally {
    harness.current = parent;
  }
}

function it(name, fn) {
  if (!harness.current) {
    // Allow top-level cases by attaching them to an implicit suite.
    describe('(root)', function () {});
  }
  harness.current.tests.push({ name: name, fn: fn, skip: false });
}

it.skip = function (name, fn) {
  if (!harness.current) {
    describe('(root)', function () {});
  }
  harness.current.tests.push({ name: name, fn: fn, skip: true });
};

function beforeEach(fn) {
  if (harness.current) {
    harness.current.beforeEach.push(fn);
  }
}

/* ===========================================================================
 * 2. Pure domain model
 * ========================================================================= */

const Track7 = (function () {
  const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function formatTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) {
      throw new TypeError('formatTime expects a non-negative finite number');
    }
    const totalMs = Math.round(ms);
    const minutes = Math.floor(totalMs / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return (
      minutes +
      ':' +
      String(seconds).padStart(2, '0') +
      '.' +
      String(millis).padStart(3, '0')
    );
  }

  function createCar(options) {
    const opts = options || {};
    const car = {
      driver: opts.driver || 'anon',
      lap: 0,
      fuelLiters: opts.fuelLiters != null ? opts.fuelLiters : 0,
      maxFuelLiters: opts.maxFuelLiters != null ? opts.maxFuelLiters : 100,
      fuelPerLap: opts.fuelPerLap != null ? opts.fuelPerLap : 2,
      tyreWear: opts.tyreWear != null ? opts.tyreWear : 0,
      tyreWearPerLap: opts.tyreWearPerLap != null ? opts.tyreWearPerLap : 0.1,
      pitTimeMs: opts.pitTimeMs != null ? opts.pitTimeMs : 25000,
    };

    car.refuel = function (liters) {
      const room = car.maxFuelLiters - car.fuelLiters;
      const added = clamp(liters, 0, Math.max(0, room));
      car.fuelLiters += added;
      return added;
    };

    car.burn = function () {
      car.lap += 1;
      car.fuelLiters = Math.max(0, car.fuelLiters - car.fuelPerLap);
      car.tyreWear = clamp(car.tyreWear + car.tyreWearPerLap, 0, 1);
      return car;
    };

    car.canFinishLap = function () {
      return car.fuelLiters >= car.fuelPerLap;
    };

    return car;
  }

  function createStrategy(name, options) {
    const opts = options || {};
    const strategy = {
      name: name || 'default',
      stops: [],
      pitWindow: opts.pitWindow != null ? opts.pitWindow : 3,
    };

    strategy.addStop = function (lap, plan) {
      const p = plan || {};
      strategy.stops.push({
        lap: lap,
        refuelLiters: p.refuelLiters != null ? p.refuelLiters : 0,
        newTyres: p.newTyres !== false,
      });
      strategy.stops.sort(function (a, b) { return a.lap - b.lap; });
      return strategy;
    };

    strategy.stopOnLap = function (lap) {
      for (let i = 0; i < strategy.stops.length; i += 1) {
        if (strategy.stops[i].lap === lap) return strategy.stops[i];
      }
      return null;
    };

    strategy.dueOnLap = function (lap) {
      return strategy.stopOnLap(lap) !== null;
    };

    return strategy;
  }

  function simulateRace(car, strategy, laps, lapTimeMs) {
    const baseLap = lapTimeMs != null ? lapTimeMs : 90000;
    let totalTimeMs = 0;
    let pitStops = 0;

    for (let lap = 1; lap <= laps; lap += 1) {
      if (!car.canFinishLap()) {
        // Emergency splash-and-dash: forced stop to get to the line.
        totalTimeMs += car.pitTimeMs;
        pitStops += 1;
        car.refuel(car.maxFuelLiters - car.fuelLiters);
      }

      const stop = strategy.stopOnLap(lap);
      if (stop) {
        totalTimeMs += car.pitTimeMs;
        pitStops += 1;
        if (stop.refuelLiters) car.refuel(stop.refuelLiters);
        if (stop.newTyres) car.tyreWear = 0;
      }

      // Tyre wear slows the car by up to 10% of the base lap time.
      const wearPenalty = baseLap * 0.1 * car.tyreWear;
      totalTimeMs += baseLap + wearPenalty;
      car.burn();
    }

    return {
      car: car,
      summary: {
        driver: car.driver,
        laps: laps,
        pitStops: pitStops,
        totalTimeMs: Math.round(totalTimeMs),
        averageLapMs: Math.round(totalTimeMs / laps),
      },
    };
  }

  function score(pointsTable, position) {
    const table = Array.isArray(pointsTable) ? pointsTable : POINTS;
    if (position < 1 || position > table.length) return 0;
    return table[position - 1];
  }

  function championship(results, pointsTable) {
    const totals = Object.create(null);
    results.forEach(function (r) {
      const key = r.driver;
      const pts = score(pointsTable, r.position);
      totals[key] = (totals[key] || 0) + pts;
    });
    return Object.keys(totals)
      .map(function (driver) { return { driver: driver, points: totals[driver] }; })
      .sort(function (a, b) {
        if (b.points !== a.points) return b.points - a.points;
        return a.driver < b.driver ? -1 : a.driver > b.driver ? 1 : 0;
      });
  }

  return {
    POINTS: POINTS,
    formatTime: formatTime,
    clamp: clamp,
    createCar: createCar,
    createStrategy: createStrategy,
    simulateRace: simulateRace,
    score: score,
    championship: championship,
  };
})();

/* ===========================================================================
 * 3. Runner
 * ========================================================================= */

async function run() {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const suite of harness.suites) {
    console.log('\n' + suite.name);
    for (const test of suite.tests) {
      if (test.skip) {
        skipped += 1;
        console.log('  - ' + test.name + ' (skipped)');
        continue;
      }
      for (const setup of suite.beforeEach) {
        await setup();
      }
      try {
        await test.fn();
        passed += 1;
        console.log('  \u2713 ' + test.name);
      } catch (err) {
        failed += 1;
        console.log('  \u2717 ' + test.name);
        console.log('      ' + (err && err.message ? err.message : err));
      }
    }
  }

  console.log(
    '\n' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped'
  );
  return failed === 0;
}

/* ===========================================================================
 * 4. Tests
 * ========================================================================= */

describe('Track7.formatTime', function () {
  it('formats sub-minute times with padded seconds and millis', function () {
    assert.strictEqual(Track7.formatTime(0), '0:00.000');
    assert.strictEqual(Track7.formatTime(1500), '0:01.500');
    assert.strictEqual(Track7.formatTime(59999), '0:59.999');
  });

  it('formats multi-minute times', function () {
    assert.strictEqual(Track7.formatTime(90000), '1:30.000');
    assert.strictEqual(Track7.formatTime(3661234), '61:01.234');
  });

  it('rejects invalid input', function () {
    assert.throws(function () { Track7.formatTime(-1); }, TypeError);
    assert.throws(function () { Track7.formatTime('nope'); }, TypeError);
    assert.throws(function () { Track7.formatTime(Infinity); }, TypeError);
  });
});

describe('Track7.createCar', function () {
  it('applies sensible defaults', function () {
    const car = Track7.createCar();
    assert.strictEqual(car.driver, 'anon');
    assert.strictEqual(car.lap, 0);
    assert.strictEqual(car.tyreWear, 0);
    assert.strictEqual(car.canFinishLap(), true);
  });

  it('burns fuel and wears tyres per lap', function () {
    const car = Track7.createCar({ fuelLiters: 10, fuelPerLap: 2.5, tyreWearPerLap: 0.2 });
    car.burn().burn();
    assert.strictEqual(car.lap, 2);
    assert.strictEqual(car.fuelLiters, 5);
    assert.ok(Math.abs(car.tyreWear - 0.4) < 1e-9);
  });

  it('clamps refuelling to the tank capacity', function () {
    const car = Track7.createCar({ fuelLiters: 90, maxFuelLiters: 100 });
    const added = car.refuel(50);
    assert.strictEqual(added, 10);
    assert.strictEqual(car.fuelLiters, 100);
  });

  it('detects an empty tank', function () {
    const car = Track7.createCar({ fuelLiters: 1, fuelPerLap: 2 });
    assert.strictEqual(car.canFinishLap(), false);
  });
});

describe('Track7.createStrategy', function () {
  it('sorts stops by lap and reports them as due', function () {
    const strategy = Track7.createStrategy('mid-race')
      .addStop(15, { refuelLiters: 20 })
      .addStop(5, { refuelLiters: 10 });
    assert.strictEqual(strategy.stops[0].lap, 5);
    assert.strictEqual(strategy.stops[1].lap, 15);
    assert.strictEqual(strategy.dueOnLap(5), true);
    assert.strictEqual(strategy.dueOnLap(6), false);
  });

  it('defaults newTyres to true', function () {
    const strategy = Track7.createStrategy().addStop(3);
    assert.strictEqual(strategy.stopOnLap(3).newTyres, true);
  });
});

describe('Track7.simulateRace', function () {
  it('records pit stops and tyre reset', function () {
    const car = Track7.createCar({
      driver: 'ada',
      fuelLiters: 40,
      fuelPerLap: 2.5,
      tyreWearPerLap: 0.2,
      maxFuelLiters: 60,
    });
    const strategy = Track7.createStrategy('mid-race').addStop(2, { refuelLiters: 20 });
    const result = Track7.simulateRace(car, strategy, 4, 90000);
    assert.strictEqual(result.summary.laps, 4);
    assert.strictEqual(result.summary.pitStops, 1);
    assert.ok(result.summary.totalTimeMs > 4 * 90000);
    assert.strictEqual(car.tyreWear, 0.4);
  });

  it('forces an emergency stop when the tank runs dry', function () {
    const car = Track7.createCar({ fuelLiters: 3, fuelPerLap: 2 });
    const strategy = Track7.createStrategy('no-stops');
    const result = Track7.simulateRace(car, strategy, 3, 60000);
    assert.ok(result.summary.pitStops >= 1);
  });
});

describe('Track7.championship', function () {
  it('scores standard points and sorts the standings', function () {
    const standings = Track7.championship([
      { driver: 'ada', position: 1 },
      { driver: 'bob', position: 2 },
      { driver: 'cy', position: 3 },
      { driver: 'ada', position: 4 },
    ]);
    assert.deepStrictEqual(standings, [
      { driver: 'ada', points: 37 },
      { driver: 'bob', points: 18 },
      { driver: 'cy', points: 15 },
    ]);
  });

  it('honours a custom points table', function () {
    assert.strictEqual(Track7.score([3, 2, 1], 1), 3);
    assert.strictEqual(Track7.score([3, 2, 1], 9), 0);
    assert.strictEqual(Track7.score([3, 2, 1], 0), 0);
  });
});

describe('Track7 integration', function () {
  it('runs a full race and produces a consistent summary', function () {
    const car = Track7.createCar({
      driver: 'max',
      fuelLiters: 30,
      fuelPerLap: 2,
      tyreWearPerLap: 0.05,
      maxFuelLiters: 60,
    });
    const strategy = Track7.createStrategy('one-stop').addStop(8, { refuelLiters: 25 });
    const result = Track7.simulateRace(car, strategy, 10, 85000);
    assert.strictEqual(result.summary.laps, 10);
    assert.strictEqual(result.summary.pitStops, 1);
    assert.strictEqual(
      result.summary.averageLapMs,
      Math.round(result.summary.totalTimeMs / 10)
    );
    assert.strictEqual(result.car.lap, 10);
  });

  it('supports async assertions', async function () {
    await assert.rejects(Promise.reject(new Error('crash')), /crash/);
    assert.strictEqual(Track7.formatTime(1500), '0:01.500');
  });
});

/* ===========================================================================
 * 5. Entry point
 * ========================================================================= */

if (require.main === module) {
  run()
    .then(function (ok) {
      process.exitCode = ok ? 0 : 1;
    })
    .catch(function (err) {
      console.error('track_7: fatal error', err);
      process.exitCode = 1;
    });
}

module.exports = { Track7: Track7, run: run };
