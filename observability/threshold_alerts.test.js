'use strict';

/**
 * observability/threshold_alerts.test.js
 * ---------------------------------------------------------------------------
 * Verifies the acceptance criterion:
 *   - the 3 fixture scenarios produce EXACTLY 3 unique alerts
 *   - a second evaluate() inside the 10-minute window does not duplicate
 *   - the 3 individual rules honour their thresholds and severities
 *
 * Run: node observability/threshold_alerts.test.js
 */

const assert = require('assert');
const path = require('path');

const ta = require('./threshold_alerts');
const fixtures = require('./fixtures/threshold_alerts.fixtures.json');

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

process.stdout.write('observability/threshold_alerts.test.js\n');

/* ---- API surface -------------------------------------------------- */

test('exposes evaluate() returning an array', function () {
  ta.resetDedup();
  const out = ta.evaluate({});
  assert.ok(Array.isArray(out));
  assert.strictEqual(out.length, 0);
});

/* ---- individual rules --------------------------------------------- */

test('fail_rate_10m > 0.3 fires exactly one WARN', function () {
  ta.resetDedup();
  const alerts = ta.evaluate({ fail_rate_10m: 0.45 });
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].severity, 'WARN');
  assert.strictEqual(alerts[0].key, 'fail_rate_10m');
});

test('fail_rate_10m == 0.3 does not fire (strict >)', function () {
  ta.resetDedup();
  assert.strictEqual(ta.evaluate({ fail_rate_10m: 0.3 }).length, 0);
});

test('race timeout > 300s fires exactly one CRIT', function () {
  ta.resetDedup();
  const alerts = ta.evaluate({ races: [{ id: 'race-7', timeout_s: 420 }] });
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].severity, 'CRIT');
  assert.strictEqual(alerts[0].key, 'race_timeout:race-7');
});

test('race timeout == 300s does not fire', function () {
  ta.resetDedup();
  assert.strictEqual(ta.evaluate({ races: [{ timeout_s: 300 }] }).length, 0);
});

test('CPU > 90% for 6 min fires exactly one WARN', function () {
  ta.resetDedup();
  const alerts = ta.evaluate({ cpu: { percent: 95, sustained_minutes: 6 } });
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].severity, 'WARN');
  assert.strictEqual(alerts[0].key, 'cpu_sustained');
});

test('CPU > 90% but only 3 min does not fire', function () {
  ta.resetDedup();
  assert.strictEqual(ta.evaluate({ cpu: { percent: 95, sustained_minutes: 3 } }).length, 0);
});

/* ---- acceptance criterion ----------------------------------------- */

test('3 fixture scenarios produce exactly 3 unique alerts', function () {
  ta.resetDedup();
  let fired = 0;
  const keys = new Set();
  for (const scenario of fixtures.scenarios) {
    const alerts = ta.evaluate(scenario.snapshot);
    if (scenario.expect) {
      assert.strictEqual(alerts.length, scenario.expect.count, scenario.name + ' count');
      assert.strictEqual(alerts[0].severity, scenario.expect.severity, scenario.name + ' severity');
      assert.strictEqual(alerts[0].key, scenario.expect.key, scenario.name + ' key');
    }
    for (const a of alerts) {
      fired += 1;
      keys.add(a.key);
    }
  }
  assert.strictEqual(fired, 3, 'expected 3 total alerts');
  assert.strictEqual(keys.size, 3, 'expected 3 unique keys');
});

test('repeat evaluate() inside the window does not duplicate', function () {
  ta.resetDedup();
  const t = Date.parse('2024-01-01T00:00:00.000Z');
  const snapshot = { timestamp: t, fail_rate_10m: 0.9 };
  const first = ta.evaluate(snapshot);
  assert.strictEqual(first.length, 1);
  const second = ta.evaluate({ timestamp: t + 60 * 1000, fail_rate_10m: 0.9 });
  assert.strictEqual(second.length, 0, 'duplicate suppressed inside window');
  const third = ta.evaluate({ timestamp: t + 9 * 60 * 1000, fail_rate_10m: 0.9 });
  assert.strictEqual(third.length, 0, 'still suppressed at 9 min');
});

test('evaluate() fires again after the 10-minute window', function () {
  ta.resetDedup();
  const t = Date.parse('2024-01-01T00:00:00.000Z');
  ta.evaluate({ timestamp: t, fail_rate_10m: 0.9 });
  const after = ta.evaluate({ timestamp: t + 11 * 60 * 1000, fail_rate_10m: 0.9 });
  assert.strictEqual(after.length, 1, 're-fires after window');
});

test('negative fixtures fire nothing', function () {
  ta.resetDedup();
  for (const scenario of fixtures.negative) {
    const alerts = ta.evaluate(scenario.snapshot);
    assert.strictEqual(alerts.length, 0, scenario.name + ' should not fire');
  }
});

test('evaluateBatch shares one dedup window', function () {
  ta.resetDedup();
  const t = Date.parse('2024-01-01T00:00:00.000Z');
  const out = ta.evaluateBatch([
    { timestamp: t, fail_rate_10m: 0.5 },
    { timestamp: t + 1000, fail_rate_10m: 0.6 },
  ]);
  assert.strictEqual(out.length, 1, 'second identical metric suppressed');
});

process.stdout.write(
  `observability/threshold_alerts.test.js: ${passed} passed, ${failed} failed\n`,
);

process.exitCode = failed === 0 ? 0 : 1;
