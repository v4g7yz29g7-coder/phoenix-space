'use strict';

/**
 * observability/test_alerting.js
 * ---------------------------------------------------------------------------
 * Standalone verification suite for observability/alerting.js
 * (snapshot alerting contract: configure / evaluate / active / history /
 *  clear / resetSnapshotState).
 *
 * Acceptance criterion (task):
 *   >= 50 assertions against evaluate(snapshot):
 *     - CPU / RAM / load thresholds fire at 80.1% but stay silent at 79.9%
 *       (and strictly silent exactly at the threshold).
 *     - 10-minute de-duplication: a repeat at 9:59 is silent, at 10:01 fires.
 *     - cooldown reset (clear() / resetSnapshotState()).
 *     - clear() wipes de-dup state, retained alerts and history.
 *     - no spam across a burst of 100 evaluate() calls.
 *   Verification: the firing counter (history length) is exactly correct.
 *
 * Run: node observability/test_alerting.js
 * Exit code 0 iff every case passes.
 */

const assert = require('assert');
const alerting = require('./alerting');

/* ------------------------------------------------------------------ *
 * Micro test harness with an explicit assertion counter.
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
let assertCount = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write('  \u2713 ' + name + '\n');
  } catch (err) {
    failed += 1;
    process.stdout.write('  \u2717 ' + name + ' -> ' + err.message + '\n');
  }
}

/* Counting assertion helpers so we can prove ">= 50 assertions". */
function eq(actual, expected, msg) {
  assertCount += 1;
  assert.strictEqual(actual, expected, msg);
}
function deq(actual, expected, msg) {
  assertCount += 1;
  assert.deepStrictEqual(actual, expected, msg);
}
function ok(cond, msg) {
  assertCount += 1;
  assert.ok(cond, msg);
}
function throws(fn, type, msg) {
  assertCount += 1;
  assert.throws(fn, type, msg);
}

/* ------------------------------------------------------------------ *
 * Fixtures.
 * ------------------------------------------------------------------ */

const T0 = Date.parse('2024-06-01T00:00:00.000Z');
const SEC = 1000;
const MIN = 60 * SEC;
const WINDOW = 600 * SEC; // 10 minutes
const THR = { cpu: 80, ram: 80, load: 80, disk: 80 };

/** Reset module state and apply thresholds for an isolated case. */
function fresh(thresholds) {
  alerting.resetSnapshotState();
  alerting.configure(thresholds || THR);
  return alerting;
}

/** The firing counter under test: number of emitted alerts == history length. */
function fires() {
  return alerting.history().length;
}

process.stdout.write('observability/test_alerting.js\n');

/* ================================================================== *
 * 1. API surface
 * ================================================================== */

test('01 exposes the full snapshot alerting API', function () {
  eq(typeof alerting.configure, 'function', 'configure');
  eq(typeof alerting.evaluate, 'function', 'evaluate');
  eq(typeof alerting.active, 'function', 'active');
  eq(typeof alerting.history, 'function', 'history');
  eq(typeof alerting.clear, 'function', 'clear');
  eq(typeof alerting.resetSnapshotState, 'function', 'resetSnapshotState');
  eq(alerting.SNAPSHOT_DEDUP_WINDOW_MS, WINDOW, 'dedup window is 10 minutes');
  ok(alerting.SNAPSHOT_METRICS.indexOf('cpu') !== -1, 'cpu metric known');
  ok(alerting.SNAPSHOT_METRICS.indexOf('ram') !== -1, 'ram metric known');
  ok(alerting.SNAPSHOT_METRICS.indexOf('load') !== -1, 'load metric known');
});

/* ================================================================== *
 * 2. CPU threshold boundary: 79.9% silent, 80.1% fires
 * ================================================================== */

test('02 CPU fires at 80.1% but is silent at 79.9% (and at the threshold)', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 79.9 }, { now: T0 }).length, 0, '79.9 -> silent');
  eq(alerting.evaluate({ cpu: 80 }, { now: T0 }).length, 0, 'exactly 80 -> silent (strict >)');
  const alerts = alerting.evaluate({ cpu: 80.1 }, { now: T0 });
  eq(alerts.length, 1, '80.1 -> fires');
  const a = alerts[0];
  eq(a.metric, 'cpu', 'metric');
  eq(a.level, 'warn', 'default level');
  eq(a.value, 80.1, 'value');
  eq(a.threshold, 80, 'threshold');
  eq(a.ts, new Date(T0).toISOString(), 'ts is the evaluation instant as ISO');
  eq(a.timestamp, T0, 'numeric timestamp retained');
});

/* ================================================================== *
 * 3. RAM threshold boundary
 * ================================================================== */

test('03 RAM fires at 80.1% but is silent at 79.9%', function () {
  fresh();
  eq(alerting.evaluate({ ram: 79.9 }, { now: T0 }).length, 0, '79.9 -> silent');
  const alerts = alerting.evaluate({ ram: 80.1 }, { now: T0 });
  eq(alerts.length, 1, '80.1 -> fires');
  eq(alerts[0].metric, 'ram', 'metric ram');
  eq(alerts[0].threshold, 80, 'threshold 80');
});

/* ================================================================== *
 * 4. load threshold boundary
 * ================================================================== */

test('04 load fires at 80.1 but is silent at 79.9', function () {
  fresh();
  eq(alerting.evaluate({ load: 79.9 }, { now: T0 }).length, 0, '79.9 -> silent');
  const alerts = alerting.evaluate({ load: 80.1 }, { now: T0 });
  eq(alerts.length, 1, '80.1 -> fires');
  eq(alerts[0].metric, 'load', 'metric load');
});

/* ================================================================== *
 * 5. 10-minute de-duplication: 9:59 silent, 10:01 alert
 * ================================================================== */

test('05 dedup: repeat at 9:59 is silent, at 10:01 fires again', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 99 }, { now: T0 }).length, 1, 'first fire');
  eq(alerting.evaluate({ cpu: 99 }, { now: T0 + 9 * MIN + 59 * SEC }).length, 0, '9:59 -> silent');
  const again = alerting.evaluate({ cpu: 99 }, { now: T0 + 10 * MIN + 1 * SEC });
  eq(again.length, 1, '10:01 -> alert');
  eq(again[0].metric, 'cpu', 'same metric re-fires');
  eq(fires(), 2, 'firing counter exactly 2');
  eq(alerting.history(1)[0].metric, 'cpu', 'latest history entry is the re-fire');
});

/* ================================================================== *
 * 6. Half-open window boundary (exactly 600000 ms)
 * ================================================================== */

test('06 dedup window is half-open: fires again at exactly 600s', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 99 }, { now: T0 }).length, 1, 'first fire');
  eq(alerting.evaluate({ cpu: 99 }, { now: T0 + 599 * SEC }).length, 0, '599s -> suppressed');
  eq(alerting.evaluate({ cpu: 99 }, { now: T0 + 600 * SEC }).length, 1, '600s -> allowed');
});

/* ================================================================== *
 * 7. A fresh alert restarts the dedup window
 * ================================================================== */

test('07 a fresh alert restarts the 600s window', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1, 'fire @T0');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + 601 * SEC }).length, 1, 're-fire @+601s');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + 1200 * SEC }).length, 0, '+1200s still inside new window');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + 1202 * SEC }).length, 1, '+1202s past new window');
  eq(fires(), 3, 'firing counter exactly 3');
});

/* ================================================================== *
 * 8. cooldown reset / clear()
 * ================================================================== */

test('08 clear() resets de-dup state, active set and history', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1, 'fire');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + SEC }).length, 0, 'suppressed inside window');
  eq(alerting.active({ now: T0 + SEC }).length, 1, 'active before clear');
  alerting.clear();
  eq(alerting.active({ now: T0 + SEC }).length, 0, 'active empty after clear');
  eq(alerting.history().length, 0, 'history empty after clear');
  eq(fires(), 0, 'firing counter reset to 0');
  // Cooldown gone -> the very next breach fires immediately.
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + SEC }).length, 1, 'fires straight after clear');
  eq(fires(), 1, 'one fire after clear');
});

/* ================================================================== *
 * 9. clear() restores default thresholds; resetSnapshotState is equivalent
 * ================================================================== */

test('09 clear() restores defaults and resetSnapshotState() behaves the same', function () {
  fresh({ cpu: 80, ram: 80, load: 80, disk: 80 });
  alerting.clear(); // defaults: cpu 85, ram 90, load 4, disk 85
  eq(alerting.evaluate({ cpu: 84 }, { now: T0 }).length, 0, '84 below default cpu 85');
  const a = alerting.evaluate({ cpu: 86 }, { now: T0 });
  eq(a.length, 1, '86 above default cpu 85');
  eq(a[0].threshold, 85, 'default threshold restored');

  alerting.resetSnapshotState();
  eq(alerting.active({ now: T0 }).length, 0, 'resetSnapshotState clears active');
  eq(alerting.history().length, 0, 'resetSnapshotState clears history');
});

/* ================================================================== *
 * 10. no spam across a burst of 100 evaluate() calls
 * ================================================================== */

test('10 100 calls inside the window produce exactly one alert (no spam)', function () {
  fresh();
  let total = 0;
  for (let i = 0; i < 100; i += 1) {
    total += alerting.evaluate({ cpu: 90 + i * 0.01 }, { now: T0 + i * SEC }).length;
  }
  eq(total, 1, 'exactly one fire across 100 calls');
  eq(fires(), 1, 'firing counter == 1');
  eq(alerting.active({ now: T0 + 99 * SEC }).length, 1, 'single active alert');
});

/* ================================================================== *
 * 11. independent metrics do not mute each other
 * ================================================================== */

test('11 metrics keep independent dedup windows', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 90, ram: 95, load: 90 }, { now: T0 }).length, 3, 'three metrics fire');
  eq(fires(), 3, 'counter 3');
  eq(alerting.evaluate({ cpu: 90, ram: 95, load: 90 }, { now: T0 + 60 * SEC }).length, 0, 'all suppressed in window');
  eq(alerting.evaluate({ disk: 90 }, { now: T0 + 60 * SEC }).length, 1, 'untouched metric still fires');
});

/* ================================================================== *
 * 12. snapshot-embedded time source
 * ================================================================== */

test('12 evaluation instant can come from snapshot.ts / timestamp', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 90, ts: T0 }).length, 1, 'fires using snapshot.ts');
  eq(alerting.evaluate({ cpu: 90, ts: T0 + 5 * MIN }).length, 0, 'suppressed using snapshot.ts');
  eq(alerting.evaluate({ cpu: 90, timestamp: T0 + 10 * MIN + SEC }).length, 1, 're-fires using snapshot.timestamp');
});

/* ================================================================== *
 * 13. null / empty snapshots are total no-ops
 * ================================================================== */

test('13 null / empty / malformed snapshots never throw and return []', function () {
  fresh();
  deq(alerting.evaluate(null, { now: T0 }), [], 'null snapshot');
  deq(alerting.evaluate(undefined, { now: T0 }), [], 'undefined snapshot');
  deq(alerting.evaluate({}, { now: T0 }), [], 'empty snapshot');
  deq(alerting.evaluate(null, null), [], 'null snapshot + null options');
  deq(alerting.evaluate([], 'nonsense'), [], 'array snapshot + bad options');
});

/* ================================================================== *
 * 14. numeric coercion / rejection of junk
 * ================================================================== */

test('14 non-numeric values ignored, numeric strings accepted', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 'n/a' }, { now: T0 }).length, 0, 'junk string ignored');
  eq(alerting.evaluate({ ram: null }, { now: T0 }).length, 0, 'null ignored');
  const a = alerting.evaluate({ cpu: '90' }, { now: T0 });
  eq(a.length, 1, 'numeric string accepted');
  eq(a[0].value, 90, 'coerced to number');
});

/* ================================================================== *
 * 15. aliases and nested containers
 * ================================================================== */

test('15 metric aliases and nested containers are resolved', function () {
  // Each alias/nesting case is checked on freshly reset state so the
  // per-metric de-duplication window cannot mask a later sub-case.
  fresh();
  eq(alerting.evaluate({ cpu_percent: 90 }, { now: T0 })[0].metric, 'cpu', 'cpu_percent alias');
  fresh();
  eq(alerting.evaluate({ memory: 95 }, { now: T0 })[0].metric, 'ram', 'memory alias -> ram');
  fresh();
  eq(alerting.evaluate({ metrics: { load: 90, cpu: 10, ram: 10, disk: 10 } }, { now: T0 })[0].metric, 'load', 'nested metrics.load');
  fresh();
  eq(alerting.evaluate({ system: { ram: 90 } }, { now: T0 })[0].metric, 'ram', 'nested system.ram');
  fresh();
  eq(alerting.evaluate({ stats: { disk: 90 } }, { now: T0 })[0].metric, 'disk', 'nested stats.disk');
});

/* ================================================================== *
 * 16. nested 0..1 ratios are normalised to percent
 * ================================================================== */

test('16 nested ratios are normalised (0.9 -> 90%)', function () {
  fresh();
  const a = alerting.evaluate({ cpu: { ratio: 0.9 } }, { now: T0 });
  eq(a.length, 1, 'ratio 0.9 fires');
  eq(a[0].value, 90, 'ratio normalised to 90');
  const b = alerting.evaluate({ ram: { percent: 0.85 } }, { now: T0 + SEC });
  eq(b.length, 1, 'percent 0.85 fires');
  eq(b[0].value, 85, 'percent normalised to 85');
  eq(alerting.evaluate({ cpu: { ratio: 0.5 } }, { now: T0 + 2 * SEC }).length, 0, 'ratio 0.5 silent');
});

/* ================================================================== *
 * 17. force bypasses the cooldown
 * ================================================================== */

test('17 force:true bypasses de-duplication', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1, 'fire');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + SEC }).length, 0, 'normally suppressed');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + SEC, force: true }).length, 1, 'forced fire');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + 2 * SEC }).length, 0, 'window restarted by forced fire');
  eq(fires(), 2, 'counter == 2');
});

/* ================================================================== *
 * 18. configurable windowMs / levels / maxHistory
 * ================================================================== */

test('18 configure overrides windowMs', function () {
  alerting.resetSnapshotState();
  const cfg = alerting.configure({ thresholds: { cpu: 80 }, windowMs: 1000 });
  eq(cfg.windowMs, 1000, 'effective windowMs');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1, 'fire');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + 999 }).length, 0, 'suppressed at 999ms');
  eq(alerting.evaluate({ cpu: 90 }, { now: T0 + 1000 }).length, 1, 'allowed at 1000ms');
});

test('19 configure overrides severity levels', function () {
  alerting.resetSnapshotState();
  alerting.configure({ thresholds: { cpu: 80 }, levels: { cpu: 'critical' } });
  const a = alerting.evaluate({ cpu: 90 }, { now: T0 });
  eq(a.length, 1, 'fire');
  eq(a[0].level, 'critical', 'custom level applied');
});

test('20 maxHistory bounds the retained history', function () {
  alerting.resetSnapshotState();
  alerting.configure({ thresholds: { cpu: 80 }, maxHistory: 2 });
  alerting.evaluate({ cpu: 90 }, { now: T0, force: true });
  alerting.evaluate({ cpu: 90 }, { now: T0 + SEC, force: true });
  alerting.evaluate({ cpu: 90 }, { now: T0 + 2 * SEC, force: true });
  eq(alerting.history().length, 2, 'history capped at maxHistory');
  eq(alerting.history(1).length, 1, 'history(n) slices');
});

test('21 configure returns the effective configuration', function () {
  alerting.resetSnapshotState();
  const cfg = alerting.configure({ cpu: 50, ram: 99, load: 1, disk: 10 });
  eq(cfg.thresholds.cpu, 50, 'cpu');
  eq(cfg.thresholds.ram, 99, 'ram');
  eq(cfg.thresholds.load, 1, 'load');
  eq(cfg.windowMs, WINDOW, 'default window preserved');
  ok(cfg.levels && typeof cfg.levels === 'object', 'levels present');
});

test('22 configure rejects non-object input', function () {
  throws(function () { alerting.configure(null); }, TypeError, 'null rejected');
  throws(function () { alerting.configure(42); }, TypeError, 'number rejected');
});

/* ================================================================== *
 * 23. history() semantics
 * ================================================================== */

test('23 history() returns emitted alerts in order', function () {
  fresh();
  alerting.evaluate({ cpu: 90, ram: 95 }, { now: T0 });
  eq(alerting.history().length, 2, 'two recorded');
  eq(alerting.history(1)[0].metric, 'ram', 'history(1) is the latest');
  eq(alerting.history(0).length, 0, 'history(0) is empty');
  eq(alerting.history(-1).length, 2, 'history(-1) returns all');
  eq(alerting.history()[0].metric, 'cpu', 'chronological order preserved');
});

/* ================================================================== *
 * 24. verification: the firing counter is exactly correct
 * ================================================================== */

test('24 firing counter is exactly correct across a mixed sequence', function () {
  fresh();
  let counter = 0;
  counter += alerting.evaluate({ cpu: 90 }, { now: T0 }).length;                 // +1
  counter += alerting.evaluate({ cpu: 90 }, { now: T0 + 9 * MIN + 59 * SEC }).length; // +0
  counter += alerting.evaluate({ cpu: 90 }, { now: T0 + 10 * MIN + 1 * SEC }).length; // +1
  counter += alerting.evaluate({ cpu: 90 }, { now: T0 + 20 * MIN }).length;       // +0
  counter += alerting.evaluate({ cpu: 90 }, { now: T0 + 20 * MIN + 2 * SEC }).length; // +1
  eq(counter, 3, 'manually counted fires');
  eq(fires(), counter, 'history length matches the manual counter exactly');
  eq(alerting.history().length, 3, 'exactly three recorded alerts');
  eq(alerting.history().filter(function (x) { return x.metric === 'cpu'; }).length, 3, 'all three are cpu');
});

/* ================================================================== *
 * 25. independent thresholds don't mute each other
 * ================================================================== */

test('25 separate thresholds fire independently', function () {
  fresh();
  eq(alerting.evaluate({ cpu: 81 }, { now: T0 })[0].metric, 'cpu', 'cpu fires first');
  eq(alerting.evaluate({ ram: 81 }, { now: T0 + 10 * SEC })[0].metric, 'ram', 'ram fires in cpu window');
  eq(alerting.evaluate({ cpu: 99, ram: 99 }, { now: T0 + 20 * SEC }).length, 0, 'both now suppressed');
});

/* ================================================================== *
 * 26. active() reflects the live window
 * ================================================================== */

test('26 active() reports alerts inside their window only', function () {
  fresh();
  alerting.evaluate({ cpu: 90 }, { now: T0 });
  eq(alerting.active({ now: T0 + SEC }).length, 1, 'active just after fire');
  eq(alerting.active({ now: T0 + 599 * SEC }).length, 1, 'still active at 599s');
  eq(alerting.active({ now: T0 + 600 * SEC }).length, 0, 'no longer active at 600s');
});

/* ================================================================== *
 * 27-29. Hardening (adversarial pass): non-finite values, a 100-call
 *       multi-metric burst, and an exact per-metric multi-window counter.
 * ================================================================== */

test('27 NaN / Infinity / undefined metrics are inert', function () {
  fresh();
  eq(alerting.evaluate({ cpu: NaN }, { now: T0 }).length, 0, 'NaN silent');
  eq(alerting.evaluate({ cpu: Infinity }, { now: T0 }).length, 0, 'Infinity silent');
  eq(alerting.evaluate({ cpu: -Infinity }, { now: T0 }).length, 0, '-Infinity silent');
  eq(alerting.evaluate({ cpu: undefined }, { now: T0 }).length, 0, 'undefined silent');
  eq(fires(), 0, 'nothing recorded');
});

test('28 100-call burst over cpu+ram+load -> exactly one alert per metric', function () {
  fresh();
  let total = 0;
  for (let i = 0; i < 100; i += 1) {
    total += alerting.evaluate({ cpu: 99, ram: 99, load: 99 }, { now: T0 + i * SEC }).length;
  }
  eq(total, 3, 'exactly three fires across 100 calls');
  eq(fires(), 3, 'firing counter == 3');
  const per = { cpu: 0, ram: 0, load: 0 };
  alerting.history().forEach(function (a) { per[a.metric] += 1; });
  eq(per.cpu, 1, 'cpu fired exactly once');
  eq(per.ram, 1, 'ram fired exactly once');
  eq(per.load, 1, 'load fired exactly once');
});

test('29 exact counter across four dedup windows, per metric', function () {
  fresh();
  const high = { cpu: 99, ram: 99, load: 99 };
  let counter = 0;
  [0, 599000, 600000, 1199000, 1200000, 1800000].forEach(function (d) {
    counter += alerting.evaluate(high, { now: T0 + d }).length;
  });
  eq(counter, 12, 'counter is exactly 12');
  eq(fires(), 12, 'history length is exactly 12');
  const per = { cpu: 0, ram: 0, load: 0 };
  alerting.history().forEach(function (a) { per[a.metric] += 1; });
  eq(per.cpu, 4, 'cpu exactly 4');
  eq(per.ram, 4, 'ram exactly 4');
  eq(per.load, 4, 'load exactly 4');
  eq(per.cpu + per.ram + per.load, 12, 'per-metric counters sum to 12');
});

/* ================================================================== *
 * Summary
 * ================================================================== */

ok(assertCount >= 50, 'suite contains at least 50 assertions (got ' + assertCount + ')');

const total = passed + failed;
process.stdout.write('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ' ' + passed + '/' + total +
  ' | assertions=' + assertCount + '\n');

if (failed > 0) {
  process.exitCode = 1;
}
