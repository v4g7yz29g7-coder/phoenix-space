'use strict';

/**
 * tests/agent_health.test.js
 * ---------------------------------------------------------------------------
 * Тесты модуля `observability/agent_health.js`.
 *
 * Фокус: heartbeat-реестр агентов (TTL 30s, статусы OK/STALE/DEAD, метод
 * check()), который agent_health.js реэкспортирует из ./agent_registry:
 *
 *   registerAgent / heartbeat / unregisterAgent / statusOf / check / checkAll
 *
 * Плюс нативное ядро agent_health: checkAgentHealth()/scanAgents()/selfTest()
 * (healthy/degraded/dead по status.json).
 *
 * Детерминированность: часы передаются явно (BASE), поэтому границы TTL
 * проверяются точно на 29.9s / 30.1s / 61s без опоры на wall-clock.
 *
 * Запуск:
 *   node tests/runner.js tests/agent_health.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { describe, it, beforeEach, assert } = require('./runner.js');

// ВАЖНО: цель теста — именно модуль agent_health.js.
const health = require('../observability/agent_health.js');

const {
  // heartbeat-реестр (реэкспорт)
  check,
  checkAll,
  registerAgent,
  heartbeat,
  unregisterAgent,
  getAgent,
  listAgents,
  statusOf,
  clearRegistry,
  STATUS,
  DEFAULT_TTL_MS,
  // нативное ядро agent_health
  checkAgentHealth,
  scanAgents,
  selfTest,
  toEpochMs,
  classify,
  THRESHOLDS,
  STATES,
} = health;

// Фиксированная эпоха в мс (>1e11, чтобы не трактовалась как секунды).
const BASE = 1_700_000_000_000;
const TTL = 30 * 1000; // 30_000 ms
const S = (sec) => sec * 1000;

/* ========================================================================= *
 * 1. Heartbeat-реестр: константы и пустой реестр
 * ========================================================================= */

describe('agent_health :: heartbeat registry (TTL 30s)', () => {
  beforeEach(() => clearRegistry());

  it('TTL по умолчанию = 30s, статусы OK/STALE/DEAD', () => {
    assert.strictEqual(DEFAULT_TTL_MS, 30 * 1000);
    assert.strictEqual(STATUS.OK, 'OK');
    assert.strictEqual(STATUS.STALE, 'STALE');
    assert.strictEqual(STATUS.DEAD, 'DEAD');
  });

  it('пустой реестр → пустой ответ без throw', () => {
    // Не должно бросать исключение.
    const r = check(BASE);
    assert.ok(r && typeof r === 'object');
    assert.strictEqual(r.alive, 0);
    assert.strictEqual(r.stale, 0);
    assert.strictEqual(r.dead, 0);
    assert.strictEqual(r.total, 0);
    assert.strictEqual(listAgents().length, 0);

    // checkAll() на пустом реестре тоже не бросает.
    const all = checkAll({ now: BASE });
    assert.strictEqual(all.total, 0);
    assert.strictEqual(all.alive, 0);
    assert.strictEqual(all.stale, 0);
    assert.strictEqual(all.dead, 0);
    assert.ok(Array.isArray(all.agents));
    assert.strictEqual(all.agents.length, 0);
  });

  /* --------------------------------------------------------------------- *
   * 2. Границы TTL
   * --------------------------------------------------------------------- */

  it('граница TTL: 29.9s → OK', () => {
    registerAgent({ id: 'b_ok', lastHeartbeat: BASE - S(29.9) });
    assert.strictEqual(statusOf('b_ok', BASE), STATUS.OK);
    const r = check(BASE);
    assert.strictEqual(r.alive, 1);
    assert.strictEqual(r.stale, 0);
    assert.strictEqual(r.dead, 0);
  });

  it('граница TTL: ровно 30s → STALE (TTL включается в stale-окно)', () => {
    registerAgent({ id: 'b_30', lastHeartbeat: BASE - TTL });
    assert.strictEqual(statusOf('b_30', BASE), STATUS.STALE);
  });

  it('граница TTL: 30.1s → STALE', () => {
    registerAgent({ id: 'b_stale', lastHeartbeat: BASE - S(30.1) });
    assert.strictEqual(statusOf('b_stale', BASE), STATUS.STALE);
    const r = check(BASE);
    assert.strictEqual(r.stale, 1);
    assert.strictEqual(r.alive, 0);
    assert.strictEqual(r.dead, 0);
  });

  it('граница TTL: 59.9s → STALE (ещё в окне 2·TTL)', () => {
    registerAgent({ id: 'b_599', lastHeartbeat: BASE - S(59.9) });
    assert.strictEqual(statusOf('b_599', BASE), STATUS.STALE);
  });

  it('граница TTL: 61s → DEAD', () => {
    registerAgent({ id: 'b_dead', lastHeartbeat: BASE - S(61) });
    assert.strictEqual(statusOf('b_dead', BASE), STATUS.DEAD);
    const r = check(BASE);
    assert.strictEqual(r.dead, 1);
    assert.strictEqual(r.alive, 0);
    assert.strictEqual(r.stale, 0);
  });

  it('смешанный набор: check() даёт {alive:1, stale:1, dead:1}', () => {
    registerAgent({ id: 'mix_ok', lastHeartbeat: BASE - S(5) });
    registerAgent({ id: 'mix_stale', lastHeartbeat: BASE - S(45) });
    registerAgent({ id: 'mix_dead', lastHeartbeat: BASE - S(120) });

    const r = check(BASE);
    assert.strictEqual(r.alive, 1);
    assert.strictEqual(r.stale, 1);
    assert.strictEqual(r.dead, 1);
    assert.strictEqual(r.total, 3);
    assert.deepEqual(r.byStatus, { OK: 1, STALE: 1, DEAD: 1 });
  });

  /* --------------------------------------------------------------------- *
   * 3. Мутации реестра
   * --------------------------------------------------------------------- */

  it('heartbeat() в окне STALE обновляет статус до OK', () => {
    registerAgent({ id: 'refresh', lastHeartbeat: BASE - S(45) });
    assert.strictEqual(statusOf('refresh', BASE), STATUS.STALE);

    const rec = heartbeat('refresh', { at: BASE });
    assert.ok(rec && rec.id === 'refresh');
    assert.strictEqual(statusOf('refresh', BASE), STATUS.OK);
  });

  it('unregisterAgent() удаляет агента и обнуляет счётчик', () => {
    registerAgent({ id: 'doomed', lastHeartbeat: BASE - S(120) });
    assert.strictEqual(check(BASE).dead, 1);

    assert.strictEqual(unregisterAgent('doomed'), true);
    assert.strictEqual(getAgent('doomed'), null);
    assert.strictEqual(check(BASE).dead, 0);
    assert.strictEqual(check(BASE).total, 0);
  });

  it('registerAgent() без id бросает ошибку', () => {
    assert.throws(() => registerAgent({}), /id/i);
    assert.throws(() => registerAgent(null), /id|agent/i);
  });

  it('статус/ heartbeat неизвестного id → null (без throw)', () => {
    assert.strictEqual(statusOf('nope', BASE), null);
    assert.strictEqual(heartbeat('nope', { at: BASE }), null);
    assert.strictEqual(getAgent('nope'), null);
  });

  /* --------------------------------------------------------------------- *
   * 4. checkAll(): подробный отчёт по каждому агенту
   * --------------------------------------------------------------------- */

  it('checkAll() возвращает по-агентные статусы и checks[]', () => {
    registerAgent({ id: 'ca_ok', lastHeartbeat: BASE - S(5) });
    registerAgent({ id: 'ca_stale', lastHeartbeat: BASE - S(45) });
    registerAgent({ id: 'ca_dead', lastHeartbeat: BASE - S(120) });

    const rep = checkAll({ now: BASE });
    assert.strictEqual(rep.total, 3);
    assert.strictEqual(rep.agents.length, 3);
    assert.strictEqual(rep.alive, 1);
    assert.strictEqual(rep.stale, 1);
    assert.strictEqual(rep.dead, 1);

    const map = {};
    for (const a of rep.agents) map[a.id] = a;
    assert.strictEqual(map.ca_ok.status, STATUS.OK);
    assert.strictEqual(map.ca_stale.status, STATUS.STALE);
    assert.strictEqual(map.ca_dead.status, STATUS.DEAD);
    assert.ok(Array.isArray(map.ca_ok.checks) && map.ca_ok.checks.length > 0);
    assert.ok(Number.isFinite(map.ca_stale.heartbeatAgeMs));
  });

  /* --------------------------------------------------------------------- *
   * 5. Нормализация времени
   * --------------------------------------------------------------------- */

  it('toEpochMs() разбирает ms, секунды и ISO-строку', () => {
    assert.strictEqual(toEpochMs(BASE), BASE);
    assert.strictEqual(toEpochMs(Math.floor(BASE / 1000)), (Math.floor(BASE / 1000)) * 1000);
    assert.strictEqual(toEpochMs(new Date(BASE).toISOString()), BASE);
    assert.strictEqual(toEpochMs(null), null);
    assert.strictEqual(toEpochMs('not-a-date'), null);
  });

  it('числовой timestamp в секундах классифицируется корректно', () => {
    registerAgent({ id: 'sec_ok', lastHeartbeat: Math.floor((BASE - S(3)) / 1000) });
    registerAgent({ id: 'sec_stale', lastHeartbeat: Math.floor((BASE - S(45)) / 1000) });
    assert.strictEqual(statusOf('sec_ok', BASE), STATUS.OK);
    assert.strictEqual(statusOf('sec_stale', BASE), STATUS.STALE);
  });
});

/* ========================================================================= *
 * 6. Нативное ядро agent_health: checkAgentHealth / scanAgents / selfTest
 * ========================================================================= */

describe('agent_health :: checkAgentHealth/scanAgents (healthy/degraded/dead)', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent_health_test_'));
  });

  function makeBox(name, ageSec, { now = BASE } = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'status.json'),
      JSON.stringify({ timestamp: now - ageSec * 1000, state: 'busy' }),
    );
    return dir;
  }

  it('классифицирует 5s→healthy, 300s→degraded, 700s→dead', () => {
    const hDir = makeBox('agent_h', 5);
    const dDir = makeBox('agent_d', 300);
    const xDir = makeBox('agent_x', 700);

    assert.strictEqual(checkAgentHealth(hDir, { now: BASE }).state, 'healthy');
    assert.strictEqual(checkAgentHealth(dDir, { now: BASE }).state, 'degraded');
    assert.strictEqual(checkAgentHealth(xDir, { now: BASE }).state, 'dead');

    // Пороговые константы модуля.
    assert.strictEqual(THRESHOLDS.HEALTHY_MS, 120 * 1000);
    assert.strictEqual(THRESHOLDS.DEGRADED_MS, 600 * 1000);
    assert.deepEqual(STATES, ['healthy', 'degraded', 'dead']);
  });

  it('scanAgents() сканирует только каталоги agent_*', () => {
    makeBox('agent_1', 5);
    makeBox('agent_2', 300);
    fs.mkdirSync(path.join(root, 'not_an_agent'), { recursive: true });

    const results = scanAgents(root, { now: BASE });
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.id.startsWith('agent_')));
    assert.ok(results.some((r) => r.state === 'healthy'));
    assert.ok(results.some((r) => r.state === 'degraded'));
  });

  it('пустой каталог → [], без throw', () => {
    const results = scanAgents(root, { now: BASE });
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
    // Несуществующий каталог тоже не бросает.
    assert.deepEqual(scanAgents(path.join(root, 'does-not-exist'), { now: BASE }), []);
  });

  it('selfTest() прогоняет песочницу из 25 боксов', () => {
    const rep = selfTest();
    assert.strictEqual(rep.ok, true);
    assert.strictEqual(rep.total, 25);
    assert.strictEqual(rep.valid_states, true);
    assert.strictEqual(rep.summary.counts.healthy + rep.summary.counts.degraded + rep.summary.counts.dead, 25);
  });
});
