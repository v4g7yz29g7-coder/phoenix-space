'use strict';

/**
 * evolution/academy_threshold.test.js
 * ---------------------------------------------------------------------------
 * Тесты порога отправки пилотов в академию.
 *
 * Проверяет:
 *   - shouldSendToAcademy() — критерий avg_score < 7 ИЛИ stuck_rate > 30%;
 *   - checkAll() — обход каталога и выбор «слабых» пилотов;
 *   - устойчивость к разным форматам гонок и отсутствию данных.
 *
 * Запуск: node evolution/academy_threshold.test.js
 * ---------------------------------------------------------------------------
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  shouldSendToAcademy,
  checkAll,
  computeMetrics,
  analyzePilot,
  loadPilotFile,
  DEFAULT_CONFIG,
} = require('./academy_threshold');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS ' + name);
  } catch (err) {
    failed += 1;
    console.error('  FAIL ' + name + ' -> ' + err.message);
  }
}

console.log('\n[academy_threshold] unit tests');

// --- shouldSendToAcademy ----------------------------------------------------

test('returns false for empty races', function () {
  assert.strictEqual(shouldSendToAcademy('a', []), false);
});

test('returns false for null/undefined races', function () {
  assert.strictEqual(shouldSendToAcademy('a', null), false);
  assert.strictEqual(shouldSendToAcademy('a', undefined), false);
});

test('returns false for strong pilot', function () {
  assert.strictEqual(shouldSendToAcademy('a', [8, 9, 7.5, 8.2, 9.1]), false);
});

test('returns true for avg_score < 7', function () {
  assert.strictEqual(shouldSendToAcademy('a', [5, 6, 6.5, 4, 7.9]), true);
});

test('returns true for stuck_rate > 30%', function () {
  const races = [
    { score: 8, status: 'finished' },
    { status: 'dnf' },
    { status: 'stuck' },
    { score: 9, status: 'finished' },
  ];
  assert.strictEqual(shouldSendToAcademy('a', races), true);
});

test('window uses only last 5 races', function () {
  // Хорошие старые гонки + 5 плохих новых → должен быть слабым.
  const races = [9, 9, 9, 9, 9, 5, 5, 5, 5, 5];
  assert.strictEqual(shouldSendToAcademy('a', races), true);
});

test('custom thresholds respected', function () {
  const races = [7.5, 7.5, 7.5, 7.5, 7.5];
  assert.strictEqual(shouldSendToAcademy('a', races), false);
  assert.strictEqual(
    shouldSendToAcademy('a', races, { avgScoreThreshold: 8 }),
    true
  );
});

// --- computeMetrics ---------------------------------------------------------

test('computeMetrics avgScore rounded to 2 digits', function () {
  const m = computeMetrics([8, 9, 7.5, 8.2, 9.1]);
  assert.strictEqual(m.avgScore, 8.34);
  assert.strictEqual(m.raceCount, 5);
});

test('computeMetrics stuckRate is a fraction', function () {
  const m = computeMetrics([
    { status: 'dnf' },
    { status: 'finished' },
    { status: 'stuck' },
    { status: 'ok' },
  ]);
  assert.strictEqual(m.stuckRate, 0.5);
});

test('computeMetrics handles non-numeric races', function () {
  const m = computeMetrics([null, undefined, {}, 'x']);
  assert.strictEqual(m.stuckRate, 0);
  assert.strictEqual(m.avgScore, null);
});

// --- analyzePilot -----------------------------------------------------------

test('analyzePilot returns reasons', function () {
  const a = analyzePilot({ agentId: 'x', races: [5, 6, 6, 5, 6] });
  assert.strictEqual(a.agentId, 'x');
  assert.strictEqual(a.sendToAcademy, true);
  assert.ok(a.reasons.length >= 1);
});

// --- checkAll ---------------------------------------------------------------

test('checkAll scans directory and finds weak pilots', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'strong.json'),
      JSON.stringify({ agentId: 'strong', races: [9, 9, 8, 9, 8] })
    );
    fs.writeFileSync(
      path.join(dir, 'weak.json'),
      JSON.stringify({ agentId: 'weak', races: [4, 5, 6, 5, 4] })
    );
    fs.writeFileSync(
      path.join(dir, 'stuck.json'),
      JSON.stringify([
        { score: 9, status: 'finished' },
        { status: 'dnf' },
        { status: 'stuck' },
        { score: 8, status: 'finished' },
      ])
    );

    const weak = checkAll(dir);
    const ids = weak.map(function (w) { return w.agentId; });
    assert.ok(ids.indexOf('weak') !== -1, 'weak pilot expected');
    assert.ok(ids.indexOf('strong') === -1, 'strong pilot must be excluded');
    // Отсортировано от худшего к лучшему.
    assert.strictEqual(weak[0].agentId, 'weak');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAll returns [] for missing directory', function () {
  assert.deepStrictEqual(checkAll('/no/such/dir/at/all'), []);
});

test('checkAll supports packet { pilots: [...] }', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-pkt-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'packet.json'),
      JSON.stringify({
        pilots: [
          { agentId: 'p1', races: [3, 4, 3, 4, 3] },
          { agentId: 'p2', races: [9, 9, 9, 9, 9] },
        ],
      })
    );
    const weak = checkAll(dir);
    assert.strictEqual(weak.length, 1);
    assert.strictEqual(weak[0].agentId, 'p1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- loadPilotFile ----------------------------------------------------------

test('loadPilotFile tolerates broken json', function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'academy-bad-'));
  const file = path.join(dir, 'bad.json');
  try {
    fs.writeFileSync(file, '{ not valid json ');
    assert.deepStrictEqual(loadPilotFile(file), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- defaults ---------------------------------------------------------------

test('default config matches spec', function () {
  assert.strictEqual(DEFAULT_CONFIG.windowSize, 5);
  assert.strictEqual(DEFAULT_CONFIG.avgScoreThreshold, 7);
  assert.strictEqual(DEFAULT_CONFIG.stuckRateThreshold, 0.3);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
