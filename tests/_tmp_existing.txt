'use strict';

/**
 * tests/heartbeat_registry.test.js
 * ---------------------------------------------------------------------------
 * Runner-compatible тест heartbeat-реестра агентов (TTL 30s, OK/STALE/DEAD).
 *
 * Запуск:
 *   node tests/runner.js tests/heartbeat_registry.test.js
 */

const { describe, it, assert } = require('./runner.js');
const {
  check,
  HeartbeatRegistry,
  selfTest,
  STATUS,
  DEFAULT_TTL_MS,
} = require('../observability/heartbeat_registry.js');

describe('heartbeat_registry (TTL 30s)', () => {
  it('TTL по умолчанию равен 30 секундам', () => {
    assert.strictEqual(DEFAULT_TTL_MS, 30 * 1000);
  });

  it('check() возвращает {alive, stale, dead} с числами для 3 агентов', () => {
    const now = Date.now();
    const r = check(
      [
        { id: 'agent_ok', timestamp: now - 5 * 1000 }, //   5s  -> OK
        { id: 'agent_stale', timestamp: now - 45 * 1000 }, //  45s  -> STALE
        { id: 'agent_dead', timestamp: now - 120 * 1000 }, // 120s  -> DEAD
      ],
      { ttl: 30 * 1000, now: () => now }
    );

    assert.strictEqual(typeof r.alive, 'number');
    assert.strictEqual(typeof r.stale, 'number');
    assert.strictEqual(typeof r.dead, 'number');
    assert.strictEqual(r.alive, 1);
    assert.strictEqual(r.stale, 1);
    assert.strictEqual(r.dead, 1);
  });

  it('границы TTL: 30s -> OK, 30s+1ms -> STALE, 60s+1ms -> DEAD', () => {
    const now = 1_000_000_000_000;
    const r = check(
      {
        a: now - 30 * 1000, //        ровно TTL -> OK
        b: now - (30 * 1000 + 1), //  чуть больше -> STALE
        c: now - (60 * 1000 + 1), //  больше 2*TTL -> DEAD
      },
      { ttl: 30 * 1000, now: () => now }
    );
    assert.strictEqual(r.alive, 1);
    assert.strictEqual(r.stale, 1);
    assert.strictEqual(r.dead, 1);
  });

  it('HeartbeatRegistry классифицирует и удаляет боксы', () => {
    const now = 2_000_000_000_000;
    const reg = new HeartbeatRegistry({ ttl: 30 * 1000, now: () => now });
    reg.beat('live', now - 1_000);
    reg.beat('aging', now - 40_000);
    reg.beat('gone', new Date(now - 300_000).toISOString());

    assert.strictEqual(reg.status('live'), STATUS.OK);
    assert.strictEqual(reg.status('aging'), STATUS.STALE);
    assert.strictEqual(reg.status('gone'), STATUS.DEAD);

    const r = reg.check();
    assert.strictEqual(r.alive, 1);
    assert.strictEqual(r.stale, 1);
    assert.strictEqual(r.dead, 1);

    reg.remove('gone');
    assert.strictEqual(reg.check().dead, 0);
    assert.strictEqual(reg.check().total, 2);
  });

  it('распознаёт timestamp в секундах и ISO-строке', () => {
    const now = 1_700_000_000_000;
    const r = check(
      [
        ['sec_ok', Math.floor(now / 1000) - 3],
        ['iso_stale', new Date(now - 45_000).toISOString()],
      ],
      { ttl: 30 * 1000, now: () => now }
    );
    assert.strictEqual(r.alive, 1);
    assert.strictEqual(r.stale, 1);
    assert.strictEqual(r.dead, 0);
  });

  it('встроенный selfTest() проходит', () => {
    const r = selfTest();
    assert.strictEqual(r.pass, true);
    assert.strictEqual(r.result.alive, 1);
    assert.strictEqual(r.result.stale, 1);
    assert.strictEqual(r.result.dead, 1);
  });
});
