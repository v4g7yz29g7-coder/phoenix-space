'use strict';

/**
 * observability/alerting.test.js
 * Minimal dependency-free test harness for observability/alerting.js.
 * Run: node observability/alerting.test.js
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

process.stdout.write('observability/alerting.test.js\n');

/* ---- API surface -------------------------------------------------- */

test('exposes check() and notify() functions', function () {
  assert.strictEqual(typeof alerting.check, 'function');
  assert.strictEqual(typeof alerting.notify, 'function');
});

test('check() returns an array', function () {
  alerting.resetState();
  const out = alerting.check({ cpu: { usage: 0.1 } }, { force: true });
  assert.ok(Array.isArray(out));
});

/* ---- check() behaviour -------------------------------------------- */

test('check() fires critical CPU alert above 0.9', function () {
  alerting.resetState();
  const alerts = alerting.check({ cpu: { usage: 0.95 } }, { force: true });
  const ids = alerts.map(function (a) { return a.id; });
  assert.ok(ids.indexOf('cpu.usage.high') !== -1, 'expected cpu.usage.high');
});

test('check() ignores missing metrics', function () {
  alerting.resetState();
  const alerts = alerting.check({}, { force: true });
  assert.strictEqual(alerts.length, 0);
});

test('check() output is sorted most-severe first', function () {
  alerting.resetState();
  const alerts = alerting.check(
    { cpu: { usage: 0.95 }, memory: { ratio: 0.85 } },
    { force: true }
  );
  assert.ok(alerts.length >= 2);
  assert.strictEqual(alerts[0].severity, 'critical');
});

test('check() throttles repeats unless force is set', function () {
  alerting.resetState();
  const first = alerting.check({ cpu: { usage: 0.99 } }, { now: 1000 });
  const second = alerting.check({ cpu: { usage: 0.99 } }, { now: 1500 });
  const forced = alerting.check({ cpu: { usage: 0.99 } }, { now: 1500, force: true });
  assert.ok(first.length > 0);
  assert.strictEqual(second.length, 0);
  assert.ok(forced.length > 0);
});

/* ---- notify() behaviour ------------------------------------------- */

test('notify() delivers through built-in channels', function () {
  alerting.resetState();
  const alerts = alerting.check({ cpu: { usage: 0.95 } }, { force: true });
  const result = alerting.notify(alerts[0]);
  assert.ok(Array.isArray(result.delivered));
  assert.ok(result.delivered.indexOf('journal') !== -1);
});

test('notify() throws on non-object input', function () {
  assert.throws(function () { alerting.notify(null); }, TypeError);
});

test('notify() enriches missing fields', function () {
  alerting.resetState();
  const before = alerting.getJournal().length;
  alerting.notify({ id: 'custom', severity: 'warning', message: 'x' });
  assert.strictEqual(alerting.getJournal().length, before + 1);
});

/* ---- registration -------------------------------------------------- */

test('registerRule() adds a custom rule', function () {
  alerting.resetState();
  alerting.registerRule({
    id: 'custom.load',
    metric: 'custom.load',
    operator: '>',
    threshold: 5,
    severity: 'warning',
  });
  const alerts = alerting.check({ custom: { load: 9 } }, { force: true });
  const ids = alerts.map(function (a) { return a.id; });
  assert.ok(ids.indexOf('custom.load') !== -1);
  alerting.unregisterRule('custom.load');
});

test('registerRule() rejects bad operators', function () {
  assert.throws(function () {
    alerting.registerRule({ id: 'bad', metric: 'x', operator: '??', threshold: 1 });
  }, TypeError);
});

/* ---- helpers ------------------------------------------------------- */

test('summarize() counts severities', function () {
  alerting.resetState();
  const alerts = alerting.check(
    { cpu: { usage: 0.95 }, memory: { ratio: 0.85 } },
    { force: true }
  );
  const summary = alerting.summarize(alerts);
  assert.strictEqual(summary.total, alerts.length);
  assert.strictEqual(summary.worst, 'critical');
});

/* ---- file hygiene -------------------------------------------------- */

test('alerting.js exists and exceeds 150 lines', function () {
  const src = fs.readFileSync(path.resolve(__dirname, 'alerting.js'), 'utf8');
  const lines = src.split('\n').length;
  assert.ok(lines > 150, 'expected > 150 lines, got ' + lines);
});

process.stdout.write(
  '\n' + passed + ' passed, ' + failed + ' failed\n'
);
process.exit(failed === 0 ? 0 : 1);
