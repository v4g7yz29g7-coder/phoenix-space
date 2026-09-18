'use strict';

/**
 * observability/alerting.standalone.test.js
 * ===========================================================================
 * STANDALONE verification of the snapshot alerting engine in
 * observability/alerting.js  ->  evaluate(snapshot[, options]).
 *
 * Acceptance criterion (hard requirements):
 *   1. >= 50 assertions exercised against evaluate(snapshot).
 *   2. CPU / RAM / load thresholds fire on the 80% boundary: 79.9% is silent,
 *      80.1% fires.
 *   3. De-duplication window of 10 minutes: a repeat inside the window
 *      (9:59) is silent, a repeat once it has elapsed (10:01) alerts again.
 *   4. clear() resets the cooldown so the next over-threshold snapshot fires.
 *   5. No alert spam across a series of 100 calls.
 *   6. The firing counter is exactly correct (asserted against history()).
 *
 * The suite is self-contained: it needs only `assert` + the module under test.
 * A failing assertion aborts the run with a non-zero exit code; the final line
 * reports the exact number of assertions executed.
 *
 * Run:  node observability/alerting.standalone.test.js
 */

const assert = require('assert');
const path = require('path');

const alerting = require('./alerting');

/* ------------------------------------------------------------------ *
 * Assertion counter – every check funnels through these helpers so the
 * reported number is an auditable, exact count.
 * ------------------------------------------------------------------ */

let ASSERTIONS = 0;
let CASES = 0;

function ok(cond, msg) {
  ASSERTIONS += 1;
  assert.ok(cond, msg);
}
function eq(actual, expected, msg) {
  ASSERTIONS += 1;
  assert.strictEqual(actual, expected, msg);
}
function deep(actual, expected, msg) {
  ASSERTIONS += 1;
  assert.deepStrictEqual(actual, expected, msg);
}

function testCase(name, fn) {
  fn();
  CASES += 1;
  process.stdout.write('  \u2713 ' + name + '\n');
}

process.stdout.write('observability/alerting.standalone.test.js\n');

const T0 = Date.parse('2024-06-01T00:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const WINDOW = 10 * MIN; // 600 000 ms

// Thresholds chosen so the required 80% boundary is exercised directly.
const TH = Object.freeze({ cpu: 80, ram: 80, load: 80 });

function fresh() {
  alerting.clear();
  alerting.configure(TH);
}

/* ================================================================== *
 * A. API surface
 * ================================================================== */

testCase('A. exported surface exposes evaluate/configure/clear/history/active', function () {
  eq(typeof alerting.evaluate, 'function', 'evaluate() exported');
  eq(typeof alerting.configure, 'function', 'configure() exported');
  eq(typeof alerting.clear, 'function', 'clear() exported');
  eq(typeof alerting.history, 'function', 'history() exported');
  eq(typeof alerting.active, 'function', 'active() exported');
  eq(typeof alerting.resetSnapshotState, 'function', 'resetSnapshotState() exported');
  eq(alerting.SNAPSHOT_DEDUP_WINDOW_MS, WINDOW, 'dedup window is 10 minutes');
});

/* ================================================================== *
 * B. CPU boundary — 79.9% silent, 80.1% fires
 * ================================================================== */

testCase('B. CPU fires strictly above 80 (79.9 silent / 80.1 fires)', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 79.9 }, { now: T0 }).length, 0, 'cpu 79.9 silent');
  eq(alerting.history().length, 0, 'no history for sub-threshold cpu');

  const alerts = alerting.evaluate({ cpu: 80.1 }, { now: T0 });
  eq(alerts.length, 1, 'cpu 80.1 fires');
  eq(alerts[0].metric, 'cpu', 'metric is cpu');
  eq(alerts[0].value, 80.1, 'value preserved');
  eq(alerts[0].threshold, 80, 'threshold reported');
  eq(alerts[0].level, 'warn', 'level warn');
  eq(typeof alerts[0].timestamp, 'number', 'numeric timestamp');
  eq(alerting.history().length, 1, 'history has one entry');
});

/* ================================================================== *
 * C. RAM boundary — 79.9% silent, 80.1% fires
 * ================================================================== */

testCase('C. RAM fires strictly above 80 (79.9 silent / 80.1 fires)', function () {
  fresh();
  eq(alerting.evaluate({ ram: 79.9 }, { now: T0 }).length, 0, 'ram 79.9 silent');
  const alerts = alerting.evaluate({ ram: 80.1 }, { now: T0 });
  eq(alerts.length, 1, 'ram 80.1 fires');
  eq(alerts[0].metric, 'ram', 'metric is ram');
  eq(alerts[0].value, 80.1, 'value preserved');
  eq(alerts[0].threshold, 80, 'threshold reported');
});

/* ================================================================== *
 * D. load boundary — 79.9 silent, 80.1 fires
 * ================================================================== */

testCase('D. load fires strictly above 80 (79.9 silent / 80.1 fires)', function () {
  fresh();
  eq(alerting.evaluate({ load: 79.9 }, { now: T0 }).length, 0, 'load 79.9 silent');
  const alerts = alerting.evaluate({ load: 80.1 }, { now: T0 });
  eq(alerts.length, 1, 'load 80.1 fires');
  eq(alerts[0].metric, 'load', 'metric is load');
  eq(alerts[0].value, 80.1, 'value preserved');
});

/* ================================================================== *
 * E. 10-minute de-duplication (9:59 silent, 10:01 alert)
 * ================================================================== */

testCase('E. 10-minute de-dup: repeat at 9:59 silent, at 10:01 alerts', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 95 }, { now: T0 }).length, 1, 'first fires');

  eq(alerting.evaluate({ cpu: 95 }, { now: T0 + 9 * MIN }).length, 0, '9:00 silent');
  eq(alerting.evaluate({ cpu: 95 }, { now: T0 + 9 * MIN + 59 * SEC }).length, 0, '9:59 silent');
  eq(alerting.history().length, 1, 'still exactly one alert in history');

  const after = alerting.evaluate({ cpu: 95 }, { now: T0 + 10 * MIN + SEC });
  eq(after.length, 1, '10:01 alerts again');
  eq(alerting.history().length, 2, 'history grew to two');
  eq(alerting.history(1)[0].timestamp, T0 + 10 * MIN + SEC, 'new alert carries new ts');
  eq(alerting.active({ now: T0 + 10 * MIN + SEC }).length, 1, 'metric active again');
});

testCase('E2. exact 600 s boundary is outside the half-open window', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 95 }, { now: T0 }).length, 1, 'first fires');
  eq(alerting.evaluate({ cpu: 95 }, { now: T0 + WINDOW - SEC }).length, 0, '599 s silent');
  eq(alerting.evaluate({ cpu: 95 }, { now: T0 + WINDOW }).length, 1, '600 s re-fires');
});

/* ================================================================== *
 * F. clear() resets the cooldown and the state
 * ================================================================== */

testCase('F. clear() resets cooldown, history and active set', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 95 }, { now: T0 }).length, 1, 'first fires');
  eq(alerting.evaluate({ cpu: 95 }, { now: T0 + 60 * SEC }).length, 0, 'suppressed in window');
  eq(alerting.history().length, 1, 'history before clear');
  eq(alerting.active({ now: T0 + 60 * SEC }).length, 1, 'active before clear');

  alerting.clear();

  eq(alerting.history().length, 0, 'clear() empties history');
  eq(alerting.active({ now: T0 + 60 * SEC }).length, 0, 'clear() drops active windows');
  eq(alerting.evaluate({ cpu: 95 }, { now: T0 + 60 * SEC }).length, 1, 'cooldown reset -> fires');
  eq(alerting.history().length, 1, 'history re-populated after clear');
});

/* ================================================================== *
 * G. No spam: 100 calls inside one window -> exactly one alert
 * ================================================================== */

testCase('G. 100 calls inside the window produce exactly 1 alert (no spam)', function () {
  fresh();
  const THRESHOLDS = TH;
  const CPU = 100;

  let totalFired = 0;
  let nonEmptyCalls = 0;
  for (let i = 0; i < 100; i += 1) {
    const now = T0 + i * SEC; // 0 s .. 99 s, all within the 10-min window
    const alerts = alerting.evaluate({ cpu: CPU }, { now });
    ok(Array.isArray(alerts), 'evaluate always returns an array');
    ok(alerts.length === 0 || alerts.length === 1, 'at most one alert per metric');
    totalFired += alerts.length;
    if (alerts.length > 0) nonEmptyCalls += 1;
  }

  eq(totalFired, 1, 'exactly one alert across 100 calls');
  eq(nonEmptyCalls, 1, 'only the first call alerted');
  eq(alerting.history().length, 1, 'history holds exactly one alert');
  eq(alerting.active({ now: T0 + 99 * SEC }).length, 1, 'metric still active');
  eq(alerting.history()[0].metric, 'cpu', 'the single alert is cpu');
  ok(THRESHOLDS.cpu === 80, 'threshold config untouched by spam');
});

/* ================================================================== *
 * H. Firing counter is exactly correct across many windows
 * ================================================================== */

testCase('H. 100 calls one window apart -> counter exactly 100', function () {
  fresh();
  const gaps = 100;
  const firedIndexes = [];

  for (let i = 0; i < 100; i += 1) {
    const now = T0 + i * (WINDOW + SEC); // 601 s apart -> every call re-fires
    const alerts = alerting.evaluate({ cpu: 99 }, { now });
    if (alerts.length > 0) firedIndexes.push(i);
  }

  eq(firedIndexes.length, 100, 'all 100 re-fires happened');
  eq(firedIndexes[0], 0, 'first call fired');
  eq(firedIndexes[99], 99, 'last call fired');
  eq(alerting.history().length, 100, 'history counter matches exactly');
  ok(
    alerting.history().every((a) => a.metric === 'cpu'),
    'every recorded alert is cpu',
  );
  eq(alerting.history(1)[0].timestamp, T0 + 99 * (WINDOW + SEC), 'last ts correct');

  let monotonic = true;
  const hist = alerting.history();
  for (let i = 1; i < hist.length; i += 1) {
    if (hist[i].timestamp <= hist[i - 1].timestamp) monotonic = false;
  }
  ok(monotonic, 'history timestamps strictly increasing');
  void gaps;
});

testCase('H2. counter is deterministic across two identical runs', function () {
  let first = 0;
  fresh();
  for (let i = 0; i < 20; i += 1) {
    first += alerting.evaluate({ cpu: 99 }, { now: T0 + i * (WINDOW + SEC) }).length;
  }
  let second = 0;
  fresh();
  for (let i = 0; i < 20; i += 1) {
    second += alerting.evaluate({ cpu: 99 }, { now: T0 + i * (WINDOW + SEC) }).length;
  }
  eq(first, 20, 'first run fires 20 times');
  eq(second, 20, 'second run fires 20 times');
  eq(first, second, 'counts are identical');
});

/* ================================================================== *
 * I. Metrics are de-duplicated independently
 * ================================================================== */

testCase('I. metrics carry independent windows (ram fires while cpu muted)', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1, 'cpu fires');
  const second = alerting.evaluate({ cpu: 90, ram: 90 }, { now: T0 + SEC });
  eq(second.length, 1, 'only ram fires while cpu is muted');
  eq(second[0].metric, 'ram', 'the new alert is ram');
  const third = alerting.evaluate({ cpu: 90, ram: 90, load: 90 }, { now: T0 + 2 * SEC });
  eq(third.length, 1, 'only load fires next');
  eq(third[0].metric, 'load', 'the new alert is load');
  eq(alerting.evaluate({ cpu: 90, ram: 90, load: 90 }, { now: T0 + 3 * SEC }).length, 0, 'all muted');
  eq(alerting.history().length, 3, 'three distinct alerts recorded');
});

/* ================================================================== *
 * J. force escape hatch + equality does not fire
 * ================================================================== */

testCase('J. force:true bypasses the window; equality does not fire', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1, 'initial fire');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + SEC }).length, 0, 'muted');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + SEC, force: true }).length, 1, 'force fires');
  eq(alerting.history().length, 2, 'force appended to history');

  fresh();
  eq(alerting.evaluate({ cpu: 80, ram: 80, load: 80 }, { now: T0 }).length, 0, 'equality silent');
  eq(alerting.evaluate({ cpu: 79.9, ram: 79.9, load: 79.9 }, { now: T0 }).length, 0, 'below silent');
  eq(alerting.history().length, 0, 'nothing recorded');
});

/* ================================================================== *
 * K. Final tally
 * ================================================================== */

process.stdout.write(
  '\nobservability/alerting.standalone.test.js: ' +
    CASES +
    ' cases, ' +
    ASSERTIONS +
    ' assertions, all passed\n',
);

if (ASSERTIONS < 50) {
  process.stdout.write(
    'FAIL: expected >= 50 assertions, got ' + ASSERTIONS + '\n',
  );
  process.exitCode = 1;
} else {
  process.stdout.write('STANDALONE_OK\n');
  process.exitCode = 0;
}

void path;
