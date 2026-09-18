'use strict';

/**
 * observability/alerting.snapshot.test.js
 * ---------------------------------------------------------------------------
 * Locks the snapshot alerting contract of observability/alerting.js:
 *   configure(thresholds), evaluate(snapshot), active(), history(n)
 *
 * Acceptance criterion:
 *   evaluate({ cpu: 90 })            -> 1 alert, level 'warn'
 *   repeat within 10 minutes         -> 0 alerts (de-duplicated)
 *   repeat after 11 minutes          -> 1 alert again
 *
 * Run: node observability/alerting.snapshot.test.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

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

process.stdout.write('observability/alerting.snapshot.test.js\n');

const T0 = Date.parse('2024-06-01T00:00:00.000Z');
const MIN = 60 * 1000;

/* ---- API surface --------------------------------------------------- */

test('exports configure/evaluate/active/history', function () {
  assert.strictEqual(typeof alerting.configure, 'function');
  assert.strictEqual(typeof alerting.evaluate, 'function');
  assert.strictEqual(typeof alerting.active, 'function');
  assert.strictEqual(typeof alerting.history, 'function');
});

/* ---- acceptance criterion ------------------------------------------ */

test('evaluate({cpu:90}) -> 1 warn alert', function () {
  alerting.resetSnapshotState();
  alerting.configure({ cpu: 85, ram: 90, load: 4, disk: 85 });
  const alerts = alerting.evaluate({ cpu: 90 }, { now: T0 });
  assert.strictEqual(alerts.length, 1);
  const a = alerts[0];
  assert.strictEqual(a.level, 'warn');
  assert.strictEqual(a.metric, 'cpu');
  assert.strictEqual(a.value, 90);
  assert.strictEqual(a.threshold, 85);
  assert.ok(a.ts, 'ts present');
});

test('repeat within 10 minutes -> 0 alerts', function () {
  alerting.resetSnapshotState();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  assert.strictEqual(alerting.evaluate({ cpu: 95 }, { now: T0 + MIN }).length, 0);
  assert.strictEqual(alerting.evaluate({ cpu: 95 }, { now: T0 + 9 * MIN }).length, 0);
});

test('after 11 minutes -> 1 alert again', function () {
  alerting.resetSnapshotState();
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 }).length, 1);
  assert.strictEqual(alerting.evaluate({ cpu: 90 }, { now: T0 + 11 * MIN }).length, 1);
});

test('timestamp may be taken from the snapshot itself', function () {
  alerting.resetSnapshotState();
  assert.strictEqual(alerting.evaluate({ cpu: 90, ts: T0 }).length, 1);
  assert.strictEqual(alerting.evaluate({ cpu: 90, ts: T0 + MIN }).length, 0);
  assert.strictEqual(alerting.evaluate({ cpu: 90, ts: T0 + 11 * MIN }).length, 1);
});

/* ---- thresholds ---------------------------------------------------- */

test('all four metrics respect their default thresholds', function () {
  alerting.resetSnapshotState();
  const alerts = alerting.evaluate({ cpu: 86, ram: 91, load: 4.1, disk: 90 }, { now: T0 });
  assert.deepStrictEqual(alerts.map((a) => a.metric).sort(), ['cpu', 'disk', 'load', 'ram']);
  assert.ok(alerts.every((a) => a.level === 'warn'));
});

test('values equal to threshold do not fire (strict >)', function () {
  alerting.resetSnapshotState();
  assert.strictEqual(
    alerting.evaluate({ cpu: 85, ram: 90, load: 4, disk: 85 }, { now: T0 }).length,
    0,
  );
});

test('missing / non-numeric metrics are ignored', function () {
  alerting.resetSnapshotState();
  assert.strictEqual(alerting.evaluate({}, { now: T0 }).length, 0);
  assert.strictEqual(alerting.evaluate({ cpu: 'n/a' }, { now: T0 }).length, 0);
});

test('numeric strings are coerced', function () {
  alerting.resetSnapshotState();
  assert.strictEqual(alerting.evaluate({ cpu: '90' }, { now: T0 }).length, 1);
  assert.strictEqual(alerting.evaluate({ cpu: '90' }, { now: T0 + MIN }).length, 0);
});

test('0..1 ratios are normalised to percent', function () {
  alerting.resetSnapshotState();
  const alerts = alerting.evaluate({ cpu: { usage: 0.9 } }, { now: T0 });
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].value, 90);
});

test('configure(thresholds) overrides defaults', function () {
  alerting.resetSnapshotState();
  const cfg = alerting.configure({ cpu: 50 });
  assert.strictEqual(cfg.thresholds.cpu, 50);
  assert.strictEqual(alerting.evaluate({ cpu: 60 }, { now: T0 }).length, 1);
  alerting.configure({ thresholds: { cpu: 85, ram: 90, load: 4, disk: 85 } });
});

/* ---- active() / history() ------------------------------------------ */

test('active() reports metrics inside their de-dup window', function () {
  alerting.resetSnapshotState();
  alerting.evaluate({ cpu: 90, ram: 95 }, { now: T0 });
  assert.strictEqual(alerting.active({ now: T0 + MIN }).length, 2);
  assert.strictEqual(alerting.active({ now: T0 + 11 * MIN }).length, 0);
});

test('history(n) returns the most recent n alerts', function () {
  alerting.resetSnapshotState();
  alerting.evaluate({ cpu: 90 }, { now: T0 });
  alerting.evaluate({ ram: 95 }, { now: T0 + MIN });
  assert.strictEqual(alerting.history().length, 2);
  assert.strictEqual(alerting.history(1).length, 1);
  assert.strictEqual(alerting.history(1)[0].metric, 'ram');
  assert.strictEqual(alerting.history(0).length, 0);
});

/* ---- file hygiene -------------------------------------------------- */

test('alerting.js still exceeds 150 lines', function () {
  const src = fs.readFileSync(path.resolve(__dirname, 'alerting.js'), 'utf8');
  assert.ok(src.split('\n').length > 150);
});

process.stdout.write(
  '\nobservability/alerting.snapshot.test.js: ' + passed + ' passed, ' + failed + ' failed\n',
);

process.exitCode = failed === 0 ? 0 : 1;
