'use strict';

/**
 * observability/arena_health.test.js
 * ---------------------------------------------------------------------------
 * Unit-тесты health-check агентов арены.
 *
 * Запуск: node observability/arena_health.test.js
 *
 * Фикстура — временный каталог с race_*.json, детерминированное время `now`,
 * три агента в трёх статусах (alive / stale / dead) + окно fails_10.
 * ---------------------------------------------------------------------------
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  checkAgent,
  checkAll,
  checkArena,
  DEFAULT_AGENTS,
  ALIVE_SEC,
  STALE_SEC,
} = require('./arena_health');

const NOW = 1_700_000_000_000; // фиксированное «сейчас», мс
const iso = (ms) => new Date(ms).toISOString();
const ago = (sec) => NOW - sec * 1000;

let dir;
let passed = 0;

function sourceRace(ms, participants) {
  const race = {
    race_id: 'race_' + ms,
    ts: iso(ms),
    task: 'fixture',
    winner: null,
    results: participants,
  };
  fs.writeFileSync(
    path.join(dir, 'race_' + ms + '.json'),
    JSON.stringify(race, null, 2),
  );
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS ' + name);
  } catch (err) {
    console.error('  FAIL ' + name + ' -> ' + err.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Фикстура
// ---------------------------------------------------------------------------

dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena_health_'));

// Свежая гонка: только agent_1 (100с назад) -> alive.
sourceRace(ago(100), [
  { box: 'agent_1', ok: true, duration_ms: 1000 },
]);

// 1000с назад: agent_2 последний раз был -> stale.
sourceRace(ago(1000), [
  { box: 'agent_2', ok: true, duration_ms: 1500 },
]);

// 3000с назад: последнее появление agent_3 -> dead.
sourceRace(ago(3000), [
  { box: 'agent_2', ok: false, duration_ms: 500 },
  { box: 'agent_3', ok: true, duration_ms: 700 },
]);

// 4000с назад: ещё один провал agent_3 (проверка окна).
sourceRace(ago(4000), [
  { box: 'agent_3', ok: false, duration_ms: 300 },
]);

// 12 заездов agent_4 с чередованием: окно последних 10 должно дать fails_10 = 5.
for (let i = 0; i < 12; i += 1) {
  sourceRace(ago(200 + (12 - i) * 20), [
    { box: 'agent_4', ok: i % 2 === 0, duration_ms: 100 },
  ]);
}

const opts = { dir, now: NOW };

console.log('\n[arena_health] unit tests');

// ---------------------------------------------------------------------------
// 1. три статуса на фикстуре
// ---------------------------------------------------------------------------

test('alive: последнее появление < 300с', () => {
  const h = checkAgent('agent_1', opts);
  assert.strictEqual(h.status, 'alive');
  assert.ok(h.last_seen_sec < ALIVE_SEC, 'last_seen_sec ' + h.last_seen_sec);
  assert.strictEqual(h.fails_10, 0);
  assert.strictEqual(h.ok_rate, 1);
});

test('stale: 300с <= последнее появление < 1800с', () => {
  const h = checkAgent('agent_2', opts);
  assert.strictEqual(h.status, 'stale');
  assert.ok(h.last_seen_sec >= ALIVE_SEC && h.last_seen_sec < STALE_SEC);
  // appearances agent_2: fail(3000с), ok(1000с) -> окно 2, ok=1
  assert.strictEqual(h.fails_10, 1);
  assert.strictEqual(h.ok_rate, 0.5);
});

test('dead: последнее появление >= 1800с', () => {
  const h = checkAgent('agent_3', opts);
  assert.strictEqual(h.status, 'dead');
  assert.ok(h.last_seen_sec >= STALE_SEC, 'last_seen_sec ' + h.last_seen_sec);
  // appearances agent_3: fail(4000с), ok(3000с) -> окно 2, ok=1
  assert.strictEqual(h.fails_10, 1);
  assert.strictEqual(h.ok_rate, 0.5);
});

test('dead: агент без данных -> last_seen_sec null', () => {
  const h = checkAgent('agent_99', opts);
  assert.deepStrictEqual(h, {
    status: 'dead',
    last_seen_sec: null,
    fails_10: 0,
    ok_rate: 0,
  });
});

// ---------------------------------------------------------------------------
// 2. окно fails_10
// ---------------------------------------------------------------------------

test('fails_10 учитывает только последние 10 заездов', () => {
  const h = checkAgent('agent_4', opts);
  assert.strictEqual(h.status, 'alive');
  assert.strictEqual(h.fails_10, 5);
  assert.strictEqual(h.ok_rate, 0.5);
});

// ---------------------------------------------------------------------------
// 3. checkAll + 25 боксов + JSON
// ---------------------------------------------------------------------------

test('checkAll возвращает запись для каждого из 25 боксов', () => {
  const map = checkAll(DEFAULT_AGENTS, opts);
  assert.strictEqual(Object.keys(map).length, 25);
  for (const id of DEFAULT_AGENTS) {
    assert.ok(map[id], 'нет отчёта по ' + id);
    assert.ok(['alive', 'stale', 'dead'].includes(map[id].status));
  }
  assert.strictEqual(map.agent_1.status, 'alive');
  assert.strictEqual(map.agent_3.status, 'dead');
});

test('checkArena даёт полный отчёт со сводкой', () => {
  const report = checkArena(opts);
  assert.strictEqual(report.total, 25);
  assert.strictEqual(Object.keys(report.agents).length, 25);
  assert.strictEqual(
    report.counts.alive + report.counts.stale + report.counts.dead,
    25,
  );
});

test('результат JSON-сериализуем и восстанавливается без потерь', () => {
  const map = checkAll(['agent_1', 'agent_2', 'agent_3', 'agent_99'], opts);
  const json = JSON.stringify(map);
  assert.ok(typeof json === 'string' && json.length > 0);
  assert.deepStrictEqual(JSON.parse(json), map);
  const report = checkArena(opts);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(report)), report);
});

// ---------------------------------------------------------------------------
// 4. устойчивость
// ---------------------------------------------------------------------------

test('битые файлы и чужой каталог не роняют checkAgent', () => {
  fs.writeFileSync(path.join(dir, 'race_999_broken.json'), '{not json');
  const h = checkAgent('agent_1', { dir, now: NOW });
  assert.strictEqual(h.status, 'alive');
  const none = checkAgent('agent_1', { dir: path.join(dir, 'nope'), now: NOW });
  assert.strictEqual(none.status, 'dead');
});

test('checkAgent без id бросает TypeError; checkAll без массива тоже', () => {
  assert.throws(() => checkAgent(), TypeError);
  assert.throws(() => checkAll('agent_1'), TypeError);
});

// ---------------------------------------------------------------------------

console.log('\n[arena_health] passed ' + passed + '/10');
if (process.exitCode) {
  console.error('[arena_health] FAILED');
} else {
  console.log('[arena_health] OK');
}
