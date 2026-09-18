'use strict';

/**
 * observability/alerting.dedup.test.js
 * ---------------------------------------------------------------------------
 * Focused suite for the snapshot alerting contract of observability/alerting.js:
 *
 *   configure(thresholds), evaluate(snapshot[, options]), active(), history(),
 *   resetSnapshotState()
 *
 * What is locked down (acceptance criterion):
 *   - >= 10 cases, every metric has its own threshold.
 *   - A second alert for the SAME metric inside the 600s window is suppressed.
 *   - The alert is allowed again at t + 601s (just past the window).
 *   - Different thresholds / metrics do NOT mute each other.
 *   - evaluate(null) is a no-op: returns [] and never throws.
 *
 * Run: node observability/alerting.dedup.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const alerting = require('./alerting');

let passed = 0;
let failed = 0;

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

process.stdout.write('observability/alerting.dedup.test.js\n');

const T0 = Date.parse('2024-06-01T00:00:00.000Z');
const SEC = 1000;
const WINDOW = 600 * SEC; // 10 minutes

const DEFAULTS = { cpu: 85, ram: 90, load: 4, disk: 85 };

function reset(thresholds) {
  alerting.resetSnapshotState();
  alerting.configure(thresholds || DEFAULTS);
}

/* ================================================================== *
 * 1. API surface
 * ================================================================== */

test('01 exports the snapshot alerting API', function () {
  assert.strictEqual(typeof alerting.configure, 'function');
  assert.strictEqual(typeof alerting.evaluate, 'function');
  assert.strictEqual(typeof alerting.active, 'function');
  assert.strictEqual(typeof alerting.history, 'function');
  assert.strictEqual(typeof alerting.resetSnapshotState, 'function');
});

/* ================================================================== *
 * 2. Thresholds
 * ================================================================== */

test('02 evaluate(snapshot) fires above threshold with full alert shape', function () {
  reset();
  const alerts = alerting.evaluate({ cpu: 90 }, { now: T0 });
  assert.strictEqual(alerts.length, 1);
  const a = alerts[0];
  assert.strictEqual(a.metric, 'cpu');
  assert.strictEqual(a.value, 90);
  assert.strictEqual(a.threshold, 85);
  assert.strictEqual(a.level, 'warn');
  assert.ok(a.ts, 'ts present');
});

test('03 value equal to the threshold does not fire (strict >)', function () {
  reset();
  assert.strictEqual(
    alerting.evaluate({ cpu: 85, ram: 90, load: 4, disk: 85 }, { now: T0 }).length,
    0,
  );
});

test('04 configure() overrides thresholds per metric', function () {
  alerting.resetSnapshotState();
  const cfg = alerting.configure({ cpu: 50, ram: 99, load: 1, disk: 10 });
  assert.strictEqual(cfg.thresholds.cpu, 50);
  assert.strictEqual(cfg.thresholds.ram, 99);
  const alerts = alerting.evaluate({ cpu: 60, ram: 90 }, { now: T0 });
  assert.deepStrictEqual(alerts.map((a) => a.metric), ['cpu']);
  assert.strictEqual(alerts[0].threshold, 50);
});

test('05 missing / non-numeric metrics are ignored', function () {
  reset();
  assert.strictEqual(alerting.evaluate({}, { now: T0 }).length, 0);
  assert.strictEqual(alerting.evaluate({ cpu: 'n/a', ram: null }, { now: T0 }).length, 0);
});

/* ================================================================== *
 * 3. 10-minute de-duplication (600s window)
 * ================================================================== */

test('06 second alert for the same metric inside 600s is suppressed', function () {
  reset();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  assert.strictEqual(alerting.evaluate({ cpu: 95 }, { now: T0 + 300 * SEC }).length, 0);
});

test('07 alert still suppressed at 599s (just inside the window)', function () {
  reset();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  assert.strictEqual(alerting.evaluate({ cpu: 99 }, { now: T0 + 599 * SEC }).length, 0);
});

test('08 alert is allowed again at 601s (just past the window)', function () {
  reset();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  const again = alerting.evaluate({ cpu: 91 }, { now: T0 + 601 * SEC });
  assert.strictEqual(again.length, 1);
  assert.strictEqual(again[0].metric, 'cpu');
  assert.strictEqual(again[0].value, 91);
});

test('09 de-duplication window is exactly 600000ms', function () {
  assert.strictEqual(alerting.SNAPSHOT_DEDUP_WINDOW_MS, 600 * 1000);
});

test('10 a fresh alert restarts the 600s window', function () {
  reset();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  // re-fires at +601s, so the window now starts there ...
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 601 * SEC }).length, 1);
  // ... and the next value at +601s + 599s is suppressed again.
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 1200 * SEC }).length, 0);
  // ... but at +601s + 601s it is allowed.
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 1202 * SEC }).length, 1);
});

/* ================================================================== *
 * 4. Different thresholds / metrics must not mute each other
 * ================================================================== */

test('11 cpu and ram keep independent de-dup windows', function () {
  reset();
  const first = alerting.evaluate({ cpu: 90, ram: 95 }, { now: T0 });
  assert.deepStrictEqual(first.map((a) => a.metric).sort(), ['cpu', 'ram']);
  // Within the window nothing re-fires ...
  assert.strictEqual(alerting.evaluate({ cpu: 90, ram: 95 }, { now: T0 + 60 * SEC }).length, 0);
  // ... yet a metric that has NOT fired yet still fires now.
  assert.strictEqual(alerting.evaluate({ disk: 90 }, { now: T0 + 60 * SEC }).length, 1);
});

test('12 different thresholds do not mute each other (separate fires)', function () {
  reset();
  // cpu fires first, ram is still healthy.
  assert.deepStrictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).map((a) => a.metric), ['cpu']);
  // ram breaches *its own* threshold within the cpu window -> must still fire.
  assert.deepStrictEqual(
    alerting.evaluate({ ram: 95 }, { now: T0 + 10 * SEC }).map((a) => a.metric),
    ['ram'],
  );
  // cpu stays suppressed by its own window, ram stays suppressed by its own.
  assert.strictEqual(alerting.evaluate({ cpu: 99, ram: 99 }, { now: T0 + 20 * SEC }).length, 0);
});

test('13 a healthy metric never resets another metric\'s window', function () {
  reset();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  // cpu is fine here, ram is fine too -> no alerts, cpu window untouched.
  assert.strictEqual(alerting.evaluate({ cpu: 10, ram: 10 }, { now: T0 + 30 * SEC }).length, 0);
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 100 * SEC }).length, 0);
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 601 * SEC }).length, 1);
});

/* ================================================================== *
 * 5. snapshot = null / undefined -> no-op
 * ================================================================== */

test('14 evaluate(null) is a no-op and does not throw', function () {
  reset();
  assert.deepStrictEqual(alerting.evaluate(null, { now: T0 }), []);
});

test('15 evaluate(undefined) is a no-op and does not throw', function () {
  reset();
  assert.deepStrictEqual(alerting.evaluate(undefined, { now: T0 }), []);
});

test('16 a null snapshot does not disturb an existing de-dup window', function () {
  reset();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  assert.deepStrictEqual(alerting.evaluate(null, { now: T0 + 30 * SEC }), []);
  // window still honoured after the null evaluation
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 60 * SEC }).length, 0);
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 601 * SEC }).length, 1);
});

/* ================================================================== *
 * 5b. null / malformed options, force override, full metric set
 * ================================================================== */

test('17 evaluate(snapshot, null) tolerates null options and never throws', function () {
  reset();
  let out;
  assert.doesNotThrow(function () {
    out = alerting.evaluate({ cpu: 90 }, null);
  });
  assert.strictEqual(out.length, 1);
  // de-dup still applies even when options are null
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, null).length, 0);
});

test('18 evaluate(null) and evaluate() are safe no-ops', function () {
  reset();
  assert.doesNotThrow(function () {
    assert.deepStrictEqual(alerting.evaluate(null), []);
  });
  assert.doesNotThrow(function () {
    assert.deepStrictEqual(alerting.evaluate(), []);
  });
  assert.doesNotThrow(function () {
    assert.deepStrictEqual(alerting.evaluate(null, null), []);
  });
});

test('19 force:true bypasses the 600s de-dup window', function () {
  reset();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 30 * SEC }).length, 0);
  assert.strictEqual(
    alerting.evaluate({ cpu: 90 }, { now: T0 + 30 * SEC, force: true }).length,
    1,
  );
});

test('20 all four metrics keep independent thresholds and windows', function () {
  reset();
  const first = alerting.evaluate({ cpu: 90, ram: 95, load: 5, disk: 90 }, { now: T0 });
  assert.deepStrictEqual(first.map((a) => a.metric).sort(), ['cpu', 'disk', 'load', 'ram']);
  // every metric is now inside its own window -> nothing re-fires
  assert.strictEqual(
    alerting.evaluate({ cpu: 99, ram: 99, load: 99, disk: 99 }, { now: T0 + 60 * SEC }).length,
    0,
  );
  // once past the window a single breaching metric fires on its own
  assert.deepStrictEqual(
    alerting.evaluate({ cpu: 90 }, { now: T0 + 601 * SEC }).map((a) => a.metric),
    ['cpu'],
  );
});

/* ================================================================== *
 * 6. active() / history()
 * ================================================================== */

test('21 active() reports metrics inside the window and drops them after', function () {
  reset();
  alerting.evaluate({ cpu: 90, ram: 95 }, { now: T0 });
  assert.strictEqual(alerting.active({ now: T0 + SEC }).length, 2);
  assert.strictEqual(alerting.active({ now: T0 + 601 * SEC }).length, 0);
});

test('22 history() records emitted alerts and ignores suppressed ones', function () {
  reset();
  alerting.evaluate({ cpu: 90 }, { now: T0 });
  alerting.evaluate({ cpu: 95 }, { now: T0 + 60 * SEC }); // suppressed
  alerting.evaluate({ ram: 95 }, { now: T0 + 61 * SEC });
  assert.strictEqual(alerting.history().length, 2);
  assert.deepStrictEqual(alerting.history().map((a) => a.metric), ['cpu', 'ram']);
});

/* ================================================================== *
 * 7. File hygiene
 * ================================================================== */

test('23 alerting.js still exceeds 150 lines', function () {
  const src = fs.readFileSync(path.resolve(__dirname, 'alerting.js'), 'utf8');
  assert.ok(src.split('\n').length > 150);
});

/* ------------------------------------------------------------------ */

process.stdout.write(
  '\nobservability/alerting.dedup.test.js: ' + passed + ' passed, ' + failed + ' failed\n',
);

process.exitCode = failed === 0 ? 0 : 1;
