'use strict';

/**
 * observability/heartbeat_registry.test.js
 * ---------------------------------------------------------------------------
 * Тест критерия: экспорт check() возвращает {alive, stale, dead} с числами,
 * а 3 агента с разными timestamp классифицируются правильно
 * (TTL=30s -> OK/STALE/DEAD).
 *
 * Запуск:
 *   node observability/heartbeat_registry.test.js
 */

const assert = require('assert');
const {
  check,
  HeartbeatRegistry,
  selfTest,
  STATUS,
  DEFAULT_TTL_MS,
} = require('./heartbeat_registry');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`  ok   - ${name}`);
  } catch (err) {
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`  FAIL - ${name}\n        ${err.message}`);
  }
}

// eslint-disable-next-line no-console
console.log('heartbeat_registry.test.js');

test('TTL по умолчанию = 30с', () => {
  assert.strictEqual(DEFAULT_TTL_MS, 30 * 1000);
});

test('check() возвращает {alive, stale, dead} числами для 3 агентов', () => {
  const now = Date.now();
  const result = check(
    [
      { id: 'agent_ok', timestamp: now - 5 * 1000 }, //   5s -> OK
      { id: 'agent_stale', timestamp: now - 45 * 1000 }, //  45s -> STALE
      { id: 'agent_dead', timestamp: now - 120 * 1000 }, // 120s -> DEAD
    ],
    { ttl: 30 * 1000, now: () => now }
  );

  assert.strictEqual(typeof result.alive, 'number', 'alive должен быть числом');
  assert.strictEqual(typeof result.stale, 'number', 'stale должен быть числом');
  assert.strictEqual(typeof result.dead, 'number', 'dead должен быть числом');
  assert.strictEqual(result.alive, 1);
  assert.strictEqual(result.stale, 1);
  assert.strictEqual(result.dead, 1);
});

test('границы TTL: ровно 30s -> OK, 30s+1ms -> STALE, 60s+1ms -> DEAD', () => {
  const now = 1_000_000_000_000;
  const r = check(
    {
      a: now - 30 * 1000, // на границе -> OK
      b: now - (30 * 1000 + 1), // чуть больше -> STALE
      c: now - (60 * 1000 + 1), // больше 2*TTL -> DEAD
    },
    { ttl: 30 * 1000, now: () => now }
  );
  assert.strictEqual(r.alive, 1);
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(r.dead, 1);
});

test('HeartbeatRegistry: beat/touch/remove/check', () => {
  const now = 2_000_000_000_000;
  const reg = new HeartbeatRegistry({ ttl: 30 * 1000, now: () => now });
  reg.beat('live', now - 1_000);
  reg.beat('aging', now - 40_000);
  reg.beat('gone', new Date(now - 300_000).toISOString());
  assert.strictEqual(reg.status('live'), STATUS.OK);
  assert.strictEqual(reg.status('aging'), STATUS.STALE);
  assert.strictEqual(reg.status('gone'), STATUS.DEAD);

  const r = reg.check();
  assert.deepStrictEqual(
    { alive: r.alive, stale: r.stale, dead: r.dead },
    { alive: 1, stale: 1, dead: 1 }
  );

  reg.remove('gone');
  assert.strictEqual(reg.check().dead, 0);
  assert.strictEqual(reg.check().total, 2);
});

test('timestamp в секундах и ISO-строке распознаётся', () => {
  const now = 1_700_000_000_000;
  const secsNow = Math.floor(now / 1000);
  const r = check(
    [
      ['sec_ok', secsNow - 3], // секунды
      ['iso_stale', new Date(now - 45_000).toISOString()], // ISO
    ],
    { ttl: 30 * 1000, now: () => now }
  );
  assert.strictEqual(r.alive, 1);
  assert.strictEqual(r.stale, 1);
  assert.strictEqual(r.dead, 0);
});

test('пустой реестр даёт нули без ошибок', () => {
  const r = check([], { ttl: 30 * 1000 });
  assert.deepStrictEqual({ alive: r.alive, stale: r.stale, dead: r.dead }, { alive: 0, stale: 0, dead: 0 });
});

test('встроенный selfTest() проходит', () => {
  const r = selfTest();
  assert.strictEqual(r.pass, true, r.failures.join('; '));
  assert.strictEqual(r.result.alive, 1);
  assert.strictEqual(r.result.stale, 1);
  assert.strictEqual(r.result.dead, 1);
});

// eslint-disable-next-line no-console
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
