'use strict';

/**
 * observability/agent_registry.test.js
 * ---------------------------------------------------------------------------
 * Тест heartbeat-мониторинга: 3 агента с разными timestamp.
 *
 * Сценарий (TTL = 30s):
 *   agent-alive : heartbeat  5s назад            -> OK
 *   agent-stale : heartbeat 45s назад (TTL..2TTL)-> STALE
 *   agent-dead  : heartbeat 120s назад (>2*TTL)  -> DEAD
 *
 * Проверяем, что check() возвращает {alive, stale, dead} с числами
 * {alive:1, stale:1, dead:1}.
 *
 * Run:  node observability/agent_registry.test.js
 */

const assert = require('assert');
const reg = require('./agent_registry');

const {
  STATUS,
  DEFAULT_TTL_MS,
  registerAgent,
  heartbeat,
  unregisterAgent,
  listAgents,
  clearRegistry,
  statusOf,
  check,
  checkAll,
} = reg;

function test(name, fn) {
  try {
    fn();
    process.stdout.write(`  ok - ${name}\n`);
  } catch (err) {
    process.stdout.write(`  NOT OK - ${name}\n    ${err.message}\n`);
    process.exitCode = 1;
    throw err;
  }
}

function main() {
  process.stdout.write('agent_registry.test.js\n');

  test('API surface', () => {
    assert.strictEqual(typeof registerAgent, 'function');
    assert.strictEqual(typeof heartbeat, 'function');
    assert.strictEqual(typeof check, 'function');
    assert.strictEqual(typeof checkAll, 'function');
    assert.strictEqual(typeof statusOf, 'function');
    assert.strictEqual(DEFAULT_TTL_MS, 30000);
    assert.strictEqual(STATUS.OK, 'OK');
    assert.strictEqual(STATUS.STALE, 'STALE');
    assert.strictEqual(STATUS.DEAD, 'DEAD');
  });

  test('3 агента с разными timestamp — check() = {alive:1, stale:1, dead:1}', () => {
    clearRegistry();
    const t0 = Date.now();

    registerAgent({ id: 'agent-alive', lastHeartbeat: t0 - 5 * 1000 });
    registerAgent({ id: 'agent-stale', lastHeartbeat: t0 - 45 * 1000 });
    registerAgent({ id: 'agent-dead', lastHeartbeat: t0 - 120 * 1000 });

    assert.strictEqual(listAgents().length, 3, 'должно быть 3 агента');

    const res = check(t0);
    assert.strictEqual(typeof res.alive, 'number', 'alive должен быть числом');
    assert.strictEqual(typeof res.stale, 'number', 'stale должен быть числом');
    assert.strictEqual(typeof res.dead, 'number', 'dead должен быть числом');
    assert.strictEqual(res.alive, 1, 'alive');
    assert.strictEqual(res.stale, 1, 'stale');
    assert.strictEqual(res.dead, 1, 'dead');
    assert.strictEqual(res.total, 3, 'total');

    assert.strictEqual(statusOf('agent-alive', t0), STATUS.OK);
    assert.strictEqual(statusOf('agent-stale', t0), STATUS.STALE);
    assert.strictEqual(statusOf('agent-dead', t0), STATUS.DEAD);
  });

  test('границы TTL (30s / 60s)', () => {
    clearRegistry();
    const t0 = 1_700_000_000_000;
    registerAgent({ id: 'edge-ok', lastHeartbeat: t0 - 29_999 });
    registerAgent({ id: 'edge-stale-lo', lastHeartbeat: t0 - 30_000 });
    registerAgent({ id: 'edge-stale-hi', lastHeartbeat: t0 - 59_999 });
    registerAgent({ id: 'edge-dead', lastHeartbeat: t0 - 60_000 });

    assert.strictEqual(statusOf('edge-ok', t0), 'OK');
    assert.strictEqual(statusOf('edge-stale-lo', t0), 'STALE');
    assert.strictEqual(statusOf('edge-stale-hi', t0), 'STALE');
    assert.strictEqual(statusOf('edge-dead', t0), 'DEAD');

    const res = check(t0);
    assert.strictEqual(res.alive, 1);
    assert.strictEqual(res.stale, 2);
    assert.strictEqual(res.dead, 1);
  });

  test('heartbeat() оживляет агента', () => {
    clearRegistry();
    const t0 = Date.now();
    registerAgent({ id: 'revive', lastHeartbeat: t0 - 120 * 1000 });
    assert.strictEqual(statusOf('revive', t0), 'DEAD');

    heartbeat('revive', { at: t0 });
    assert.strictEqual(statusOf('revive', t0), 'OK');

    const res = check(t0);
    assert.strictEqual(res.alive, 1);
    assert.strictEqual(res.dead, 0);
  });

  test('агент без heartbeat считается DEAD', () => {
    clearRegistry();
    const t0 = Date.now();
    registerAgent({ id: 'no-hb', lastHeartbeat: undefined });
    // Принудительно обнуляем.
    reg.getAgent('no-hb').lastHeartbeat = null;
    assert.strictEqual(statusOf('no-hb', t0), 'DEAD');
    assert.strictEqual(check(t0).dead, 1);
  });

  test('checkAll() отдаёт подробный отчёт и byStatus', () => {
    clearRegistry();
    const t0 = 1_700_000_000_000;
    registerAgent({ id: 'r-ok', lastHeartbeat: t0 - 1000 });
    registerAgent({ id: 'r-stale', lastHeartbeat: t0 - 40_000 });
    registerAgent({ id: 'r-dead', lastHeartbeat: t0 - 90_000 });

    const report = checkAll({ now: t0 });
    assert.strictEqual(report.total, 3);
    assert.strictEqual(report.alive, 1);
    assert.strictEqual(report.stale, 1);
    assert.strictEqual(report.dead, 1);
    assert.strictEqual(report.byStatus.OK, 1);
    assert.strictEqual(report.byStatus.STALE, 1);
    assert.strictEqual(report.byStatus.DEAD, 1);
    assert.strictEqual(report.agents.length, 3);
    assert.ok(typeof report.generatedAt === 'string');
  });

  test('unregisterAgent удаляет из реестра', () => {
    clearRegistry();
    const t0 = Date.now();
    registerAgent({ id: 'gone', lastHeartbeat: t0 });
    assert.strictEqual(reg.listAgents().length, 1);
    assert.strictEqual(unregisterAgent('gone'), true);
    assert.strictEqual(reg.listAgents().length, 0);
    assert.strictEqual(statusOf('gone', t0), null);
  });

  clearRegistry();
  process.stdout.write('agent_registry.test.js: PASS\n');
}

main();
