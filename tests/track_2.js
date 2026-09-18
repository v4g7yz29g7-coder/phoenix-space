#!/usr/bin/env node
'use strict';

/**
 * tests/track_2.js — Track #2: pit strategy, tyre wear, fuel & telemetry.
 * ============================================================================
 * ZERO external dependencies. Runs on a bare Node.js runtime (>= 14) with no
 * jest / mocha / chai installed. Ships its own tiny BDD harness:
 *
 *     describe(name, fn)     group related tests
 *     it(name, fn)           a single (possibly async) test case
 *     it.skip(name, fn)      mark a test as pending
 *     before / after         per-suite setup / teardown
 *     beforeEach / afterEach per-test setup / teardown
 *     assert.*               a small assertion library
 *
 * Track #2 models the *strategy* side of a race circuit: compound selection,
 * stint planning, fuel planning, projected lap times that degrade with tyre
 * wear, automatic pit-window detection and a small telemetry accumulator.
 * The whole model is pure and self-contained, so the suite runs even when the
 * rest of the repository is not wired up.
 *
 * Usage:
 *     node tests/track_2.js            # run the whole suite
 *     node --check tests/track_2.js    # syntax check only
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
  between(value, lo, hi, message) {
    if (!(value >= lo && value <= hi)) {
      throw new AssertionError(message || `expected ${value} to be within [${lo}, ${hi}]`);
    }
  },
  matches(value, regexp, message) {
    if (!regexp.test(String(value))) {
      throw new AssertionError(message || `expected ${value} to match ${regexp}`);
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
let afterHook = null;
let beforeEachHook = null;
let afterEachHook = null;

function before(fn) { beforeHook = fn; }
function after(fn) { afterHook = fn; }
function beforeEach(fn) { beforeEachHook = fn; }
function afterEach(fn) { afterEachHook = fn; }

function collect(suite, prefix, out) {
  const name = prefix ? `${prefix} > ${suite.title}` : suite.title;
  for (const t of suite.tests) out.push({ name: `${name} > ${t.title}`, test: t });
  for (const s of suite.suites) collect(s, name, out);
  return out;
}

async function runHooks(hook) {
  if (typeof hook === 'function') await hook();
}

async function run() {
  const cases = collect(rootSuite, '', []);
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  try {
    await runHooks(beforeHook);
    for (const { name, test } of cases) {
      if (test.skip) {
        skipped += 1;
        console.log(`  - SKIP  ${name}`);
        continue;
      }
      try {
        await runHooks(beforeEachHook);
        await test.fn();
        passed += 1;
        console.log(`  \u2713 PASS  ${name}`);
      } catch (err) {
        failed += 1;
        console.log(`  \u2717 FAIL  ${name}`);
        console.log(`        ${err && err.message ? err.message : err}`);
      } finally {
        await runHooks(afterEachHook);
      }
    }
  } finally {
    await runHooks(afterHook);
  }

  console.log(
    `\n${passed} passed, ${failed} failed, ${skipped} skipped (${cases.length} total)`
  );
  return failed === 0;
}

/* ===========================================================================
 * 3. Track #2 — the model under test
 * ========================================================================= */

/** Available tyre compounds and their characteristics (frozen). */
const COMPOUNDS = Object.freeze({
  soft: Object.freeze({ id: 'soft', grip: 1.15, wearRatePerLap: 0.09, optimalTempC: 95 }),
  medium: Object.freeze({ id: 'medium', grip: 1.0, wearRatePerLap: 0.06, optimalTempC: 100 }),
  hard: Object.freeze({ id: 'hard', grip: 0.92, wearRatePerLap: 0.04, optimalTempC: 105 }),
  wet: Object.freeze({ id: 'wet', grip: 0.8, wearRatePerLap: 0.05, optimalTempC: 70 }),
});

const DEFAULT_COMPOUND = 'medium';
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;

/** Clamp a number into [lo, hi], defending against NaN. */
function clamp(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** Clamp a number into [0, 1]. */
function clamp01(value) {
  return clamp(value, 0, 1);
}

/** Round to `decimals` places, mapping non-finite input to 0. */
function round(value, decimals) {
  const d = decimals == null ? 2 : decimals;
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(d));
}

/** Resolve a compound definition; throws on unknown names. */
function compoundOf(name) {
  const key = name == null ? DEFAULT_COMPOUND : String(name);
  const compound = COMPOUNDS[key];
  if (!compound) throw new Error(`unknown compound: ${key}`);
  return compound;
}

/** Create a strategy session. */
function createSession(name, spec) {
  const s = spec || {};
  return {
    name: name || 'Track #2',
    totalLaps: s.totalLaps || 50,
    lapLengthM: s.lapLengthM || 5000,
    fuelPerLapL: s.fuelPerLapL || 2.5,
    baseLapMs: s.baseLapMs || 90000,
    pitLossMs: s.pitLossMs || 20000,
    stints: [],
    telemetry: createTelemetry(),
  };
}

/* ---- stints ----------------------------------------------------------- */

/** Open a new stint on the session; returns the created entry. */
function startStint(session, opts) {
  const o = opts || {};
  if (!o.compound) throw new Error('startStint: compound is required');
  compoundOf(o.compound); // validates the name
  if (!(o.startLap > 0)) throw new Error('startStint: startLap must be positive');
  if (o.startFuelL != null && o.startFuelL < 0) {
    throw new Error('startStint: startFuelL must not be negative');
  }
  const open = session.stints.find((st) => st.endLap === null);
  if (open) throw new Error('startStint: a stint is already open');

  const entry = {
    index: session.stints.length + 1,
    compound: String(o.compound),
    startLap: Math.floor(o.startLap),
    startFuelL: o.startFuelL == null ? 0 : Number(o.startFuelL),
    endLap: null,
    laps: 0,
    wearPct: 0,
  };
  session.stints.push(entry);
  return entry;
}

/** Close the currently open stint; returns the closed entry. */
function endStint(session, opts) {
  const o = opts || {};
  const open = session.stints.find((st) => st.endLap === null);
  if (!open) throw new Error('endStint: no open stint');
  if (!(o.endLap > open.startLap)) {
    throw new Error('endStint: endLap must be greater than startLap');
  }
  open.endLap = Math.floor(o.endLap);
  open.laps = open.endLap - open.startLap + 1;
  open.wearPct = tyreWearPct(open.compound, open.laps);
  return open;
}

/** Completed (closed) stints only. */
function completedStints(session) {
  return session.stints.filter((st) => st.endLap !== null);
}

/** Total number of laps covered by completed stints. */
function lapsCompleted(session) {
  return completedStints(session).reduce((sum, st) => sum + st.laps, 0);
}

/** Number of pit stops = completed stints minus one (never below zero). */
function pitStops(session) {
  return Math.max(0, completedStints(session).length - 1);
}

/* ---- tyres & fuel ----------------------------------------------------- */

/** Tyre wear after `laps` laps, expressed as an integer percentage 0..100. */
function tyreWearPct(compound, laps) {
  const c = compoundOf(compound);
  const n = Number(laps);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(clamp01(n * c.wearRatePerLap) * 100);
}

/** Fuel burned over `laps` laps at `fuelPerLapL` litres/lap. */
function fuelBurn(fuelPerLapL, laps) {
  const perLap = Number(fuelPerLapL);
  const n = Number(laps);
  if (!Number.isFinite(perLap) || !Number.isFinite(n) || perLap <= 0 || n <= 0) return 0;
  return round(perLap * n, 3);
}

/** Fuel needed for `laps` laps including a safety margin in percent. */
function fuelForLaps(laps, fuelPerLapL, marginPct) {
  const margin = Number.isFinite(Number(marginPct)) ? Number(marginPct) : 5;
  return round(fuelBurn(fuelPerLapL, laps) * (1 + margin / 100), 3);
}

/* ---- lap-time projection --------------------------------------------- */

/**
 * Project a lap time given the current wear and fuel load.
 *   - more grip  => lower time
 *   - more wear  => additive penalty proportional to wear fraction
 *   - more fuel  => 30 ms per litre of onboard fuel
 */
function effectiveLapMs(baseLapMs, opts) {
  const o = opts || {};
  const base = Number(baseLapMs);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const compound = compoundOf(o.compound);
  const wearPct = clamp(Number(o.wearPct) || 0, 0, 100);
  const fuelL = Math.max(0, Number(o.fuelL) || 0);

  const timeFactor = 1 / compound.grip;
  const wearPenalty = wearPct / 100;
  const fuelPenaltyMs = fuelL * 30;

  return round(base * timeFactor * (1 + wearPenalty) + fuelPenaltyMs, 0);
}

/** Project the lap time of the nth lap of a stint. */
function projectStintLapMs(session, compound, lapInStint, startFuelL) {
  const wearPct = tyreWearPct(compound, lapInStint);
  const fuelL = Math.max(0, (Number(startFuelL) || 0) - session.fuelPerLapL * (lapInStint - 1));
  return effectiveLapMs(session.baseLapMs, { wearPct, fuelL, compound });
}

/* ---- strategy planning ------------------------------------------------ */

/**
 * Split `totalLaps` into the given stint lengths.
 *   planStints(50, [15, 20, 15], ['soft', 'medium', 'hard'])
 * A single compound name is broadcast across every stint.
 */
function planStints(totalLaps, lengths, compounds) {
  const total = Number(totalLaps);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('planStints: totalLaps must be positive');
  }
  if (!Array.isArray(lengths) || lengths.length === 0) {
    throw new Error('planStints: lengths must be a non-empty array');
  }
  const sum = lengths.reduce((acc, n) => acc + n, 0);
  if (sum !== total) {
    throw new Error(`planStints: lengths sum to ${sum}, expected ${total}`);
  }
  const pick = (i) => {
    if (Array.isArray(compounds)) return compounds[i] || compounds[compounds.length - 1];
    return compounds || DEFAULT_COMPOUND;
  };

  let cursor = 1;
  return lengths.map((n, i) => {
    const fromLap = cursor;
    const toLap = cursor + n - 1;
    cursor = toLap + 1;
    return { index: i + 1, compound: String(pick(i)), fromLap, toLap, laps: n };
  });
}

/**
 * Detect the first lap of a stint on which staying out costs more than the
 * pit loss, i.e. the recommended pit window. Returns null when the whole run
 * is safe to complete on the current rubber.
 */
function detectPitWindow(session, compound, startFuelL, maxLaps) {
  const horizon = Number.isFinite(Number(maxLaps))
    ? Math.floor(maxLaps)
    : session.totalLaps;
  const dropOff = session.baseLapMs + session.pitLossMs;

  for (let lap = 1; lap <= horizon; lap += 1) {
    const projected = projectStintLapMs(session, compound, lap, startFuelL);
    if (projected >= dropOff) {
      return { lap, lapMs: projected, thresholdMs: dropOff };
    }
  }
  return null;
}

/* ---- telemetry -------------------------------------------------------- */

/** Create an empty telemetry accumulator. */
function createTelemetry() {
  return { samples: [] };
}

/** Append a telemetry sample. */
function pushSample(telemetry, sample) {
  const s = sample || {};
  if (!(s.lap > 0)) throw new Error('pushSample: lap must be positive');
  if (!(s.speedKph >= 0)) throw new Error('pushSample: speedKph must be >= 0');
  const entry = {
    lap: Math.floor(s.lap),
    speedKph: Number(s.speedKph),
    throttlePct: clamp(Number(s.throttlePct) || 0, 0, 100),
    brakePct: clamp(Number(s.brakePct) || 0, 0, 100),
  };
  telemetry.samples.push(entry);
  return entry;
}

/** Mean speed across all samples (0 when empty). */
function avgSpeed(telemetry) {
  const list = telemetry.samples;
  if (list.length === 0) return 0;
  const sum = list.reduce((acc, s) => acc + s.speedKph, 0);
  return round(sum / list.length, 2);
}

/** Maximum recorded speed (0 when empty). */
function maxSpeed(telemetry) {
  const list = telemetry.samples;
  if (list.length === 0) return 0;
  return list.reduce((best, s) => (s.speedKph > best ? s.speedKph : best), 0);
}

/** Fraction of samples with a positive throttle input, 0..1. */
function throttleRatio(telemetry) {
  const list = telemetry.samples;
  if (list.length === 0) return 0;
  const on = list.filter((s) => s.throttlePct > 0).length;
  return round(on / list.length, 4);
}

/** Number of samples with a positive brake input. */
function brakeCount(telemetry) {
  return telemetry.samples.filter((s) => s.brakePct > 0).length;
}

/* ---- formatting & summary -------------------------------------------- */

/** Format a signed lap delta as +s.mmm / -s.mmm. */
function formatDelta(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '--.---';
  const sign = n < 0 ? '-' : '+';
  return sign + (Math.abs(n) / MS_PER_SECOND).toFixed(3);
}

/** Format a lap time in milliseconds as m:ss.mmm. */
function formatLap(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '--:--.---';
  const minutes = Math.floor(n / (MS_PER_SECOND * SECONDS_PER_MINUTE));
  const seconds = Math.floor((n % (MS_PER_SECOND * SECONDS_PER_MINUTE)) / MS_PER_SECOND);
  const millis = Math.floor(n % MS_PER_SECOND);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** High-level summary of a session. */
function summarize(session) {
  const done = completedStints(session);
  const laps = lapsCompleted(session);
  const fuelUsedL = round(session.fuelPerLapL * laps, 3);
  return {
    name: session.name,
    stints: done.length,
    laps,
    pitStops: Math.max(0, done.length - 1),
    fuelUsedL,
    avgStintLaps: done.length === 0 ? 0 : round(laps / done.length, 2),
  };
}

/* ===========================================================================
 * 4. Public surface
 * ========================================================================= */

const Track2 = {
  version: '2.0.0',
  COMPOUNDS,
  DEFAULT_COMPOUND,
  clamp,
  clamp01,
  round,
  compoundOf,
  createSession,
  startStint,
  endStint,
  completedStints,
  lapsCompleted,
  pitStops,
  tyreWearPct,
  fuelBurn,
  fuelForLaps,
  effectiveLapMs,
  projectStintLapMs,
  planStints,
  detectPitWindow,
  createTelemetry,
  pushSample,
  avgSpeed,
  maxSpeed,
  throttleRatio,
  brakeCount,
  formatDelta,
  formatLap,
  summarize,
};

/* ===========================================================================
 * 5. Test suites
 * ========================================================================= */

describe('track_2 helpers', () => {
  it('clamps values into range', () => {
    assert.strictEqual(Track2.clamp(5, 0, 10), 5);
    assert.strictEqual(Track2.clamp(-5, 0, 10), 0);
    assert.strictEqual(Track2.clamp(50, 0, 10), 10);
    assert.strictEqual(Track2.clamp('nope', 0, 10), 0);
    assert.strictEqual(Track2.clamp01(1.7), 1);
    assert.strictEqual(Track2.clamp01(-1), 0);
  });

  it('rounds without throwing on bad input', () => {
    assert.strictEqual(Track2.round(1.2345, 2), 1.23);
    assert.strictEqual(Track2.round(NaN), 0);
    assert.strictEqual(Track2.round(Infinity), 0);
  });

  it('exposes tyre compounds', () => {
    assert.deepEqual(Object.keys(COMPOUNDS), ['soft', 'medium', 'hard', 'wet']);
    assert.strictEqual(Track2.compoundOf('soft').grip, 1.15);
    assert.strictEqual(Track2.compoundOf(undefined).id, 'medium');
    assert.throws(() => Track2.compoundOf('banana'), /unknown compound/);
  });

  it('formats lap times as m:ss.mmm', () => {
    assert.strictEqual(Track2.formatLap(0), '0:00.000');
    assert.strictEqual(Track2.formatLap(1234), '0:01.234');
    assert.strictEqual(Track2.formatLap(83456), '1:23.456');
    assert.strictEqual(Track2.formatLap(-1), '--:--.---');
    assert.strictEqual(Track2.formatLap(undefined), '--:--.---');
  });

  it('formats signed deltas', () => {
    assert.strictEqual(Track2.formatDelta(1234), '+1.234');
    assert.strictEqual(Track2.formatDelta(-500), '-0.500');
    assert.strictEqual(Track2.formatDelta('x'), '--.---');
  });
});

describe('track_2 tyres & fuel', () => {
  it('computes wear percentages per compound', () => {
    assert.strictEqual(Track2.tyreWearPct('soft', 5), 45);
    assert.strictEqual(Track2.tyreWearPct('medium', 5), 30);
    assert.strictEqual(Track2.tyreWearPct('hard', 5), 20);
    assert.strictEqual(Track2.tyreWearPct('soft', 0), 0);
  });

  it('never exceeds 100% wear', () => {
    assert.strictEqual(Track2.tyreWearPct('soft', 1000), 100);
    assert.strictEqual(Track2.tyreWearPct('hard', 1000), 100);
  });

  it('hard tyres last longer than softs', () => {
    assert.ok(
      Track2.tyreWearPct('hard', 10) < Track2.tyreWearPct('soft', 10),
      'hard compound should wear slower'
    );
  });

  it('burns fuel proportionally to laps', () => {
    assert.strictEqual(Track2.fuelBurn(2.5, 10), 25);
    assert.strictEqual(Track2.fuelBurn(2, 1), 2);
    assert.strictEqual(Track2.fuelBurn(0, 10), 0);
    assert.strictEqual(Track2.fuelBurn(2.5, -3), 0);
  });

  it('adds a safety margin when planning fuel', () => {
    assert.strictEqual(Track2.fuelForLaps(10, 2.5, 10), 27.5);
    assert.strictEqual(Track2.fuelForLaps(10, 2.5, 0), 25);
    assert.strictEqual(Track2.fuelForLaps(10, 2.5), 26.25); // default 5%
  });
});

describe('track_2 lap-time projection', () => {
  it('returns the base time for a fresh medium on empty fuel', () => {
    assert.strictEqual(
      Track2.effectiveLapMs(90000, { wearPct: 0, fuelL: 0, compound: 'medium' }),
      90000
    );
  });

  it('adds 30 ms per litre of fuel', () => {
    assert.strictEqual(
      Track2.effectiveLapMs(90000, { wearPct: 0, fuelL: 10, compound: 'medium' }),
      90300
    );
  });

  it('penalises wear as a fraction of the base lap', () => {
    assert.strictEqual(
      Track2.effectiveLapMs(90000, { wearPct: 10, fuelL: 0, compound: 'medium' }),
      99000
    );
  });

  it('softs are quicker than hards when fresh and empty', () => {
    const soft = Track2.effectiveLapMs(90000, { wearPct: 0, fuelL: 0, compound: 'soft' });
    const hard = Track2.effectiveLapMs(90000, { wearPct: 0, fuelL: 0, compound: 'hard' });
    assert.ok(soft < hard, `expected soft (${soft}) < hard (${hard})`);
  });

  it('guards against invalid base times', () => {
    assert.strictEqual(Track2.effectiveLapMs(0, { compound: 'soft' }), 0);
    assert.strictEqual(Track2.effectiveLapMs(-5, { compound: 'soft' }), 0);
  });
});

describe('track_2 stint lifecycle', () => {
  let session;

  beforeEach(() => {
    session = createSession('Circuit Two', { totalLaps: 50, fuelPerLapL: 2.5 });
  });

  it('creates a session with sensible defaults', () => {
    const s = createSession();
    assert.strictEqual(s.name, 'Track #2');
    assert.strictEqual(s.totalLaps, 50);
    assert.strictEqual(s.baseLapMs, 90000);
    assert.strictEqual(s.pitLossMs, 20000);
    assert.deepEqual(s.stints, []);
    assert.deepEqual(s.telemetry.samples, []);
  });

  it('opens and closes a stint', () => {
    const open = Track2.startStint(session, { compound: 'soft', startLap: 1, startFuelL: 60 });
    assert.strictEqual(open.index, 1);
    assert.strictEqual(open.endLap, null);
    assert.strictEqual(session.stints.length, 1);

    const closed = Track2.endStint(session, { endLap: 15 });
    assert.strictEqual(closed.laps, 15);
    assert.strictEqual(closed.wearPct, Track2.tyreWearPct('soft', 15));
    assert.strictEqual(Track2.completedStints(session).length, 1);
    assert.strictEqual(Track2.lapsCompleted(session), 15);
  });

  it('rejects a second open stint', () => {
    Track2.startStint(session, { compound: 'medium', startLap: 1 });
    assert.throws(
      () => Track2.startStint(session, { compound: 'hard', startLap: 2 }),
      /already open/
    );
  });

  it('validates stint inputs', () => {
    assert.throws(() => Track2.startStint(session, { startLap: 1 }), /compound/);
    assert.throws(() => Track2.startStint(session, { compound: 'soft', startLap: 0 }), /startLap/);
    assert.throws(
      () => Track2.startStint(session, { compound: 'soft', startLap: 1, startFuelL: -1 }),
      /negative/
    );
    assert.throws(() => Track2.endStint(session, { endLap: 5 }), /no open stint/);
  });

  it('rejects an endLap before the stint start', () => {
    Track2.startStint(session, { compound: 'soft', startLap: 10 });
    assert.throws(() => Track2.endStint(session, { endLap: 10 }), /greater than startLap/);
    assert.throws(() => Track2.endStint(session, { endLap: 4 }), /greater than startLap/);
  });

  it('counts pit stops between stints', () => {
    Track2.startStint(session, { compound: 'soft', startLap: 1 });
    Track2.endStint(session, { endLap: 15 });
    assert.strictEqual(Track2.pitStops(session), 0);

    Track2.startStint(session, { compound: 'hard', startLap: 16 });
    Track2.endStint(session, { endLap: 50 });
    assert.strictEqual(Track2.pitStops(session), 1);
    assert.strictEqual(Track2.lapsCompleted(session), 50);
  });

  it('summarizes a two-stop race', () => {
    Track2.startStint(session, { compound: 'soft', startLap: 1 });
    Track2.endStint(session, { endLap: 30 });
    Track2.startStint(session, { compound: 'hard', startLap: 31 });
    Track2.endStint(session, { endLap: 50 });

    const summary = Track2.summarize(session);
    assert.deepEqual(summary, {
      name: 'Circuit Two',
      stints: 2,
      laps: 50,
      pitStops: 1,
      fuelUsedL: 125,
      avgStintLaps: 25,
    });
  });

  it('summarizes an empty session safely', () => {
    const summary = Track2.summarize(session);
    assert.strictEqual(summary.stints, 0);
    assert.strictEqual(summary.laps, 0);
    assert.strictEqual(summary.pitStops, 0);
    assert.strictEqual(summary.avgStintLaps, 0);
  });
});

describe('track_2 strategy planning', () => {
  it('splits a race into ordered stints', () => {
    const plan = Track2.planStints(50, [15, 20, 15], ['soft', 'medium', 'hard']);
    assert.deepEqual(plan, [
      { index: 1, compound: 'soft', fromLap: 1, toLap: 15, laps: 15 },
      { index: 2, compound: 'medium', fromLap: 16, toLap: 35, laps: 20 },
      { index: 3, compound: 'hard', fromLap: 36, toLap: 50, laps: 15 },
    ]);
  });

  it('broadcasts a single compound across all stints', () => {
    const plan = Track2.planStints(20, [10, 10], 'soft');
    assert.deepEqual(plan.map((p) => p.compound), ['soft', 'soft']);
  });

  it('rejects plans that do not cover the race distance', () => {
    assert.throws(() => Track2.planStints(50, [10, 10], 'soft'), /sum to 20/);
    assert.throws(() => Track2.planStints(0, [1], 'soft'), /totalLaps/);
    assert.throws(() => Track2.planStints(50, [], 'soft'), /non-empty/);
  });

  it('detects the pit window when wear outweighs the pit loss', () => {
    const session = createSession('Window', { baseLapMs: 90000, pitLossMs: 20000 });
    const window = Track2.detectPitWindow(session, 'soft', 60, 40);
    assert.ok(window, 'expected a pit window');
    assert.strictEqual(window.lap, 5);
    assert.ok(window.lapMs >= window.thresholdMs, 'projected lap should cross the threshold');
  });

  it('returns null when the run fits on one set of tyres', () => {
    const session = createSession('Sprint', { baseLapMs: 90000, pitLossMs: 900000 });
    assert.strictEqual(Track2.detectPitWindow(session, 'hard', 40, 5), null);
  });
});

describe('track_2 telemetry', () => {
  let telemetry;

  beforeEach(() => {
    telemetry = createTelemetry();
  });

  it('records and clamps samples', () => {
    const entry = Track2.pushSample(telemetry, {
      lap: 1,
      speedKph: 250,
      throttlePct: 120,
      brakePct: -5,
    });
    assert.deepEqual(entry, { lap: 1, speedKph: 250, throttlePct: 100, brakePct: 0 });
    assert.strictEqual(telemetry.samples.length, 1);
  });

  it('validates samples', () => {
    assert.throws(() => Track2.pushSample(telemetry, { speedKph: 200 }), /lap/);
    assert.throws(() => Track2.pushSample(telemetry, { lap: 1, speedKph: -1 }), /speedKph/);
  });

  it('computes speed statistics', () => {
    Track2.pushSample(telemetry, { lap: 1, speedKph: 200, throttlePct: 50 });
    Track2.pushSample(telemetry, { lap: 2, speedKph: 300, throttlePct: 0 });
    Track2.pushSample(telemetry, { lap: 3, speedKph: 250, throttlePct: 100, brakePct: 20 });

    assert.strictEqual(Track2.avgSpeed(telemetry), 250);
    assert.strictEqual(Track2.maxSpeed(telemetry), 300);
    assert.strictEqual(Track2.throttleRatio(telemetry), 0.6667);
    assert.strictEqual(Track2.brakeCount(telemetry), 1);
  });

  it('is safe on empty telemetry', () => {
    assert.strictEqual(Track2.avgSpeed(telemetry), 0);
    assert.strictEqual(Track2.maxSpeed(telemetry), 0);
    assert.strictEqual(Track2.throttleRatio(telemetry), 0);
    assert.strictEqual(Track2.brakeCount(telemetry), 0);
  });
});

describe('track_2 integration', () => {
  it('models a full two-stop race end to end', () => {
    const session = createSession('Grand Prix', {
      totalLaps: 50,
      fuelPerLapL: 2.4,
      baseLapMs: 88000,
      pitLossMs: 21000,
    });

    const plan = Track2.planStints(50, [15, 20, 15], ['soft', 'medium', 'hard']);
    let fuel = Track2.fuelForLaps(plan[0].laps, session.fuelPerLapL, 8);

    Track2.startStint(session, { compound: plan[0].compound, startLap: plan[0].fromLap, startFuelL: fuel });
    Track2.endStint(session, { endLap: plan[0].toLap });

    const window = Track2.detectPitWindow(session, plan[0].compound, fuel, 20);
    assert.ok(window, 'soft stint should trigger a pit window');
    assert.ok(window.lap <= plan[0].laps + 5);

    Track2.startStint(session, { compound: plan[1].compound, startLap: plan[1].fromLap });
    Track2.endStint(session, { endLap: plan[1].toLap });
    Track2.startStint(session, { compound: plan[2].compound, startLap: plan[2].fromLap });
    Track2.endStint(session, { endLap: plan[2].toLap });

    const summary = Track2.summarize(session);
    assert.strictEqual(summary.laps, 50);
    assert.strictEqual(summary.stints, 3);
    assert.strictEqual(summary.pitStops, 2);
    assert.strictEqual(summary.fuelUsedL, 120);

    Track2.pushSample(session.telemetry, { lap: 1, speedKph: 240, throttlePct: 90 });
    Track2.pushSample(session.telemetry, { lap: 2, speedKph: 260, throttlePct: 80, brakePct: 40 });
    assert.strictEqual(Track2.avgSpeed(session.telemetry), 250);
    assert.strictEqual(Track2.brakeCount(session.telemetry), 1);
  });

  it('supports async assertions', async () => {
    await assert.rejects(Promise.reject(new Error('crash')), /crash/);
    assert.strictEqual(Track2.formatDelta(2000), '+2.000');
    assert.matches(Track2.formatLap(65000), /^1:05\.000$/);
  });
});

/* ===========================================================================
 * 6. Entry point
 * ========================================================================= */

if (require.main === module) {
  run()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err) => {
      console.error('track_2: fatal error', err);
      process.exitCode = 1;
    });
}

module.exports = { Track2, run };
