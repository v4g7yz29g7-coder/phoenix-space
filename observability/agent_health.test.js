'use strict';

/**
 * observability/agent_health.test.js
 * ---------------------------------------------------------------------------
 * Тесты для модуля `observability/agent_health.js` (heartbeat-реестр).
 *
 * Фокус критерия:
 *   - TTL по умолчанию = 30 секунд (30_000 мс);
 *   - статусы агента: OK / STALE / DEAD;
 *   - check()  -> { alive, stale, dead, total, byStatus, generatedAt };
 *   - checkAll() -> подробный отчёт ({ total, alive, stale, dead, byStatus, agents });
 *   - границы TTL: 29.9s -> OK, 30.0s -> STALE, 30.1s -> STALE, 61s -> DEAD;
 *   - 5 агентов вперемешку OK/STALE/DEAD;
 *   - повторная регистрация дубля перезаписывает timestamp;
 *   - пустой реестр не бросает.
 *
 * Семантика классификации (agent_health -> agent_registry):
 *        age <  TTL            -> OK
 *        TTL <= age <  2*TTL   -> STALE
 *        age >= 2*TTL          -> DEAD
 *        нет heartbeat          -> DEAD
 *
 * Запуск:
 *   node observability/agent_health.test.js
 *   node tests/runner.js observability/agent_health.test.js   (runner-совместимо)
 */

const assert = require('assert');

// Тестируем именно модуль, названный в задаче.
const health = require('./agent_health');

const {
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
} = health;

const TTL = 30 * 1000; // 30 000 мс
const T0 = 1_700_000_000_000; // детерминированный "сейчас"

let passed = 0;
let failed = 0;
let assertCount = 0;

// Обёртка над assert, считающая количество проверок.
const A = {
  ok: (v, m) => {
    assertCount += 1;
    assert.ok(v, m);
  },
  strictEqual: (a, b, m) => {
    assertCount += 1;
    assert.strictEqual(a, b, m);
  },
  deepStrictEqual: (a, b, m) => {
    assertCount += 1;
    assert.deepStrictEqual(a, b, m);
  },
  notStrictEqual: (a, b, m) => {
    assertCount += 1;
    assert.notStrictEqual(a, b, m);
  },
  throws: (fn, m) => {
    assertCount += 1;
    assert.throws(fn, m);
  },
  doesNotThrow: (fn, m) => {
    assertCount += 1;
    assert.doesNotThrow(fn, m);
  },
};

function test(name, fn) {
  try {
    clearRegistry(); // изоляция между кейсами
    fn();
    passed += 1;
    process.stdout.write(`  ok   - ${name}\n`);
  } catch (err) {
    failed += 1;
    process.stdout.write(`  FAIL - ${name}\n         ${err.message}\n`);
    if (err && err.stack) {
      process.stdout.write(`         ${String(err.stack).split('\n').slice(1, 3).join('\n         ')}\n`);
    }
    process.exitCode = 1;
  } finally {
    clearRegistry();
  }
}

/** Зарегистрировать агента с заданным возрастом heartbeat (мс от T0). */
function reg(id, ageMs, extra) {
  return registerAgent(Object.assign({ id, lastHeartbeat: T0 - ageMs }, extra || {}));
}

process.stdout.write('agent_health.test.js (heartbeat registry, TTL 30s)\n');

/* ------------------------------------------------------------------------- *
 * 1. API surface
 * ------------------------------------------------------------------------- */
test('API: check/registerAgent/heartbeat/statusOf экспортируются как функции', () => {
  A.strictEqual(typeof check, 'function', 'check должен быть функцией');
  A.strictEqual(typeof checkAll, 'function', 'checkAll должен быть функцией');
  A.strictEqual(typeof registerAgent, 'function', 'registerAgent должен быть функцией');
  A.strictEqual(typeof heartbeat, 'function', 'heartbeat должен быть функцией');
  A.strictEqual(typeof unregisterAgent, 'function', 'unregisterAgent должен быть функцией');
  A.strictEqual(typeof statusOf, 'function', 'statusOf должен быть функцией');
  A.strictEqual(typeof clearRegistry, 'function', 'clearRegistry должен быть функцией');
  A.strictEqual(typeof listAgents, 'function', 'listAgents должен быть функцией');
  A.strictEqual(typeof getAgent, 'function', 'getAgent должен быть функцией');
  A.strictEqual(typeof health.checkAgentHealth, 'function', 'checkAgentHealth (scan API)');
  A.strictEqual(typeof health.scanAgents, 'function', 'scanAgents (scan API)');
  A.strictEqual(typeof health.selfTest, 'function', 'selfTest (scan API)');
  A.ok(STATUS && typeof STATUS === 'object', 'STATUS — объект');
  A.strictEqual(typeof DEFAULT_TTL_MS, 'number', 'DEFAULT_TTL_MS — число');
});

test('API: TTL по умолчанию = 30s, статусы = OK/STALE/DEAD', () => {
  A.strictEqual(DEFAULT_TTL_MS, 30 * 1000, 'DEFAULT_TTL_MS должен быть 30000');
  A.strictEqual(DEFAULT_TTL_MS, TTL, 'TTL === 30000');
  A.strictEqual(STATUS.OK, 'OK', 'STATUS.OK');
  A.strictEqual(STATUS.STALE, 'STALE', 'STATUS.STALE');
  A.strictEqual(STATUS.DEAD, 'DEAD', 'STATUS.DEAD');
  A.strictEqual(Object.keys(STATUS).length, 3, 'ровно 3 статуса');
  A.ok(Object.isFrozen(STATUS), 'STATUS заморожен');
});

/* ------------------------------------------------------------------------- *
 * 2. Границы TTL: 29.9s / 30.0s / 30.1s / 61s  (КРИТЕРИЙ)
 * ------------------------------------------------------------------------- */
const BOUNDARIES = [
  { ageMs: 29_900, label: '29.9s', expected: STATUS.OK },
  { ageMs: 30_000, label: '30.0s', expected: STATUS.STALE },
  { ageMs: 30_100, label: '30.1s', expected: STATUS.STALE },
  { ageMs: 61_000, label: '61s', expected: STATUS.DEAD },
];

test('КРИТЕРИЙ границы TTL: 29.9s -> OK, 30.0s/30.1s -> STALE, 61s -> DEAD', () => {
  for (const b of BOUNDARIES) reg(`b-${b.label}`, b.ageMs);

  for (const b of BOUNDARIES) {
    A.strictEqual(statusOf(`b-${b.label}`, T0), b.expected, `${b.label} -> ${b.expected}`);
    A.notStrictEqual(statusOf(`b-${b.label}`, T0), null, `${b.label} зарегистрирован`);
  }

  const res = check(T0);
  A.strictEqual(res.alive, 1, 'alive=1 (только 29.9s)');
  A.strictEqual(res.stale, 2, 'stale=2 (30.0s и 30.1s)');
  A.strictEqual(res.dead, 1, 'dead=1 (61s)');
  A.strictEqual(res.total, 4, 'total=4');
});

const SWEEP = [
  { ageMs: TTL - 1, expected: STATUS.OK },
  { ageMs: TTL, expected: STATUS.STALE },
  { ageMs: TTL + 1, expected: STATUS.STALE },
  { ageMs: 2 * TTL - 1, expected: STATUS.STALE },
  { ageMs: 2 * TTL, expected: STATUS.DEAD },
  { ageMs: 2 * TTL + 1, expected: STATUS.DEAD },
];

test('точные пороги TTL-1/TTL/TTL+1 и 2*TTL-1/2*TTL/2*TTL+1', () => {
  for (const s of SWEEP) {
    reg(`s-${s.ageMs}`, s.ageMs);
    A.strictEqual(statusOf(`s-${s.ageMs}`, T0), s.expected, `age=${s.ageMs} -> ${s.expected}`);
  }
  const res = check(T0);
  A.strictEqual(res.alive, 1, 'alive=1 (TTL-1)');
  A.strictEqual(res.stale, 3, 'stale=3 (TTL, TTL+1, 2TTL-1)');
  A.strictEqual(res.dead, 2, 'dead=2 (2TTL, 2TTL+1)');
  A.strictEqual(res.total, 6, 'total=6');
});

test('нижняя граница stale-окна: 29.999s -> OK, 30.001s -> STALE', () => {
  reg('just-under', 29_999);
  reg('just-over', 30_001);
  A.strictEqual(statusOf('just-under', T0), STATUS.OK, '29.999s -> OK');
  A.strictEqual(statusOf('just-over', T0), STATUS.STALE, '30.001s -> STALE');
});

/* ------------------------------------------------------------------------- *
 * 3. 5 агентов вперемешку OK/STALE/DEAD  (КРИТЕРИЙ)
 * ------------------------------------------------------------------------- */
test('КРИТЕРИЙ 5 агентов вперемешку OK/STALE/DEAD', () => {
  reg('mix-ok-1', 1_000); //    1s -> OK
  reg('mix-ok-2', 29_900); //  29.9s -> OK
  reg('mix-stale-1', 30_100); // 30.1s -> STALE
  reg('mix-dead-1', 60_000); //  60s -> DEAD
  reg('mix-dead-2', 600_000); // 600s -> DEAD

  A.strictEqual(listAgents().length, 5, 'ровно 5 агентов');
  A.strictEqual(statusOf('mix-ok-1', T0), STATUS.OK, 'mix-ok-1 -> OK');
  A.strictEqual(statusOf('mix-ok-2', T0), STATUS.OK, 'mix-ok-2 -> OK');
  A.strictEqual(statusOf('mix-stale-1', T0), STATUS.STALE, 'mix-stale-1 -> STALE');
  A.strictEqual(statusOf('mix-dead-1', T0), STATUS.DEAD, 'mix-dead-1 -> DEAD');
  A.strictEqual(statusOf('mix-dead-2', T0), STATUS.DEAD, 'mix-dead-2 -> DEAD');

  const res = check(T0);
  A.strictEqual(res.alive, 2, 'alive=2');
  A.strictEqual(res.stale, 1, 'stale=1');
  A.strictEqual(res.dead, 2, 'dead=2');
  A.strictEqual(res.total, 5, 'total=5');
  A.strictEqual(res.alive + res.stale + res.dead, res.total, 'сумма = total');
  A.strictEqual(res.byStatus.OK, 2, 'byStatus.OK=2');
  A.strictEqual(res.byStatus.STALE, 1, 'byStatus.STALE=1');
  A.strictEqual(res.byStatus.DEAD, 2, 'byStatus.DEAD=2');

  const report = checkAll({ now: T0 });
  A.strictEqual(report.total, 5, 'report.total=5');
  A.strictEqual(report.agents.length, 5, 'report.agents=5');
  A.strictEqual(report.alive, 2, 'report.alive=2');
  A.strictEqual(report.stale, 1, 'report.stale=1');
  A.strictEqual(report.dead, 2, 'report.dead=2');
  A.strictEqual(report.overall, STATUS.DEAD, 'overall = худший статус = DEAD');
});

test('check() считает несколько агентов в каждом статусе (2/2/2)', () => {
  reg('ok-1', 1_000);
  reg('ok-2', 20_000);
  reg('stale-1', 35_000);
  reg('stale-2', 59_000);
  reg('dead-1', 90_000);
  reg('dead-2', 600_000);

  const res = check(T0);
  A.strictEqual(res.alive, 2, 'alive=2');
  A.strictEqual(res.stale, 2, 'stale=2');
  A.strictEqual(res.dead, 2, 'dead=2');
  A.strictEqual(res.total, 6, 'total=6');
  A.strictEqual(res.alive + res.stale + res.dead, res.total, 'сумма статусов = total');
});

/* ------------------------------------------------------------------------- *
 * 4. Регистрация дубля перезаписывает timestamp  (КРИТЕРИЙ)
 * ------------------------------------------------------------------------- */
test('КРИТЕРИЙ регистрация дубля перезаписывает timestamp', () => {
  registerAgent({ id: 'dup', lastHeartbeat: T0 - 120_000 });
  A.strictEqual(statusOf('dup', T0), STATUS.DEAD, 'сначала DEAD');
  A.strictEqual(getAgent('dup').lastHeartbeat, T0 - 120_000, 'исходный timestamp');

  registerAgent({ id: 'dup', lastHeartbeat: T0 - 1_000 });
  A.strictEqual(listAgents().length, 1, 'дубль не создаёт вторую запись');
  A.strictEqual(getAgent('dup').lastHeartbeat, T0 - 1_000, 'timestamp перезаписан');
  A.strictEqual(statusOf('dup', T0), STATUS.OK, 'статус обновлён DEAD -> OK');
  A.strictEqual(check(T0).total, 1, 'total=1');
  A.strictEqual(check(T0).alive, 1, 'alive=1');
  A.strictEqual(check(T0).dead, 0, 'dead=0');

  // Ещё одна перезапись тем же id -> снова DEAD, но всё ещё одна запись.
  registerAgent({ id: 'dup', lastHeartbeat: T0 - 90_000 });
  A.strictEqual(listAgents().length, 1, 'всё ещё 1 запись');
  A.strictEqual(getAgent('dup').lastHeartbeat, T0 - 90_000, 'timestamp снова перезаписан');
  A.strictEqual(statusOf('dup', T0), STATUS.DEAD, 'статус снова DEAD');
});

/* ------------------------------------------------------------------------- *
 * 5. Пустой реестр -> пустой ответ без throw  (КРИТЕРИЙ)
 * ------------------------------------------------------------------------- */
test('КРИТЕРИЙ пустой реестр не бросает', () => {
  let res;
  A.doesNotThrow(() => {
    res = check(T0);
  }, 'check(T0) на пустом реестре');
  A.strictEqual(res.alive, 0, 'alive=0');
  A.strictEqual(res.stale, 0, 'stale=0');
  A.strictEqual(res.dead, 0, 'dead=0');
  A.strictEqual(res.total, 0, 'total=0');

  let res2;
  A.doesNotThrow(() => {
    res2 = check();
  }, 'check() без now');
  A.strictEqual(res2.total, 0, 'check() без now -> total=0');

  let report;
  A.doesNotThrow(() => {
    report = checkAll({ now: T0 });
  }, 'checkAll({now}) на пустом реестре');
  A.strictEqual(report.total, 0, 'report.total=0');
  A.strictEqual(report.agents.length, 0, 'report.agents пуст');
  A.strictEqual(report.alive, 0, 'report.alive=0');
  A.strictEqual(report.stale, 0, 'report.stale=0');
  A.strictEqual(report.dead, 0, 'report.dead=0');
  A.strictEqual(report.overall, STATUS.DEAD, 'overall пустого реестра = DEAD');

  A.doesNotThrow(() => statusOf('ghost', T0), 'statusOf неизвестного не бросает');
  A.strictEqual(statusOf('ghost', T0), null, 'statusOf неизвестного -> null');
  A.strictEqual(listAgents().length, 0, 'listAgents пуст');
  A.strictEqual(getAgent('ghost'), null, 'getAgent неизвестного -> null');
  A.strictEqual(unregisterAgent('ghost'), false, 'unregister неизвестного -> false');
});

/* ------------------------------------------------------------------------- *
 * 6. Форма ответа check()/checkAll()
 * ------------------------------------------------------------------------- */
test('check()/checkAll() форма ответа', () => {
  reg('shape-ok', 1_000);
  reg('shape-stale', 45_000);
  reg('shape-dead', 120_000);

  const res = check(T0);
  A.strictEqual(typeof res.alive, 'number', 'alive — число');
  A.strictEqual(typeof res.stale, 'number', 'stale — число');
  A.strictEqual(typeof res.dead, 'number', 'dead — число');
  A.strictEqual(typeof res.total, 'number', 'total — число');
  A.ok(res.byStatus && typeof res.byStatus === 'object', 'byStatus — объект');
  A.strictEqual(typeof res.generatedAt, 'string', 'generatedAt — строка');
  A.ok(!Number.isNaN(Date.parse(res.generatedAt)), 'generatedAt — валидная дата');
  A.strictEqual(res.generatedAt, new Date(T0).toISOString(), 'generatedAt = now ISO');

  const report = checkAll({ now: T0 });
  A.strictEqual(typeof report.generatedAt, 'string', 'report.generatedAt — строка');
  A.ok(Array.isArray(report.agents), 'report.agents — массив');
  A.ok(report.host && typeof report.host === 'object', 'report.host — объект');
  A.strictEqual(report.agents.length, 3, 'report.agents.length=3');
  for (const a of report.agents) {
    A.ok(typeof a.id === 'string', 'agent.id — строка');
    A.ok(typeof a.status === 'string', 'agent.status — строка');
    A.ok(Number.isFinite(a.ttlMs), 'agent.ttlMs — число');
  }
});

test('checkAll() отдаёт byStatus и overall', () => {
  reg('r-ok', 1_000);
  reg('r-stale', 40_000);
  A.strictEqual(checkAll({ now: T0 }).byStatus.OK, 1, 'byStatus.OK=1');
  A.strictEqual(checkAll({ now: T0 }).byStatus.STALE, 1, 'byStatus.STALE=1');
  A.strictEqual(checkAll({ now: T0 }).byStatus.DEAD, 0, 'byStatus.DEAD=0');
  A.strictEqual(checkAll({ now: T0 }).overall, STATUS.STALE, 'overall=STALE');
  A.strictEqual(checkAll({ now: T0 }).total, 2, 'total=2');
});

test('checkAll(number) эквивалентен checkAll({now})', () => {
  reg('n-ok', 1_000);
  reg('n-dead', 90_000);
  const a = checkAll(T0);
  const b = checkAll({ now: T0 });
  A.strictEqual(a.total, b.total, 'total совпадает');
  A.strictEqual(a.alive, b.alive, 'alive совпадает');
  A.strictEqual(a.dead, b.dead, 'dead совпадает');
  A.strictEqual(a.overall, b.overall, 'overall совпадает');
});

/* ------------------------------------------------------------------------- *
 * 7. heartbeat() / регистрация / удаление
 * ------------------------------------------------------------------------- */
test('heartbeat() оживляет DEAD-агента -> OK', () => {
  reg('revive', 120_000);
  A.strictEqual(statusOf('revive', T0), STATUS.DEAD, 'до heartbeat — DEAD');

  const r = heartbeat('revive', { at: T0 });
  A.ok(r && r.id === 'revive', 'heartbeat вернул запись агента');
  A.strictEqual(getAgent('revive').lastHeartbeat, T0, 'lastHeartbeat = T0');
  A.strictEqual(statusOf('revive', T0), STATUS.OK, 'после heartbeat — OK');
  A.strictEqual(check(T0).alive, 1, 'alive=1');
  A.strictEqual(check(T0).dead, 0, 'dead=0');

  // heartbeat без явного at -> now (свежий).
  heartbeat('revive');
  A.ok(Number.isFinite(getAgent('revive').lastHeartbeat), 'lastHeartbeat стал числом');
  A.strictEqual(statusOf('revive'), STATUS.OK, 'свежий heartbeat -> OK');

  A.strictEqual(heartbeat('nope', { at: T0 }), null, 'heartbeat неизвестного -> null');
});

test('unregisterAgent/getAgent/listAgents работают', () => {
  reg('u1', 0);
  reg('u2', 0);
  A.strictEqual(listAgents().length, 2, '2 агента');
  A.ok(getAgent('u1') && getAgent('u1').id === 'u1', 'getAgent вернул u1');
  A.strictEqual(getAgent('missing'), null, 'getAgent неизвестного -> null');
  A.strictEqual(unregisterAgent('u1'), true, 'unregister u1 -> true');
  A.strictEqual(getAgent('u1'), null, 'u1 удалён');
  A.strictEqual(listAgents().length, 1, 'остался 1 агент');
  A.strictEqual(statusOf('u1', T0), null, 'статус удалённого -> null');
  A.strictEqual(unregisterAgent('u1'), false, 'повторное удаление -> false');
  clearRegistry();
  A.strictEqual(listAgents().length, 0, 'после clearRegistry пусто');
  A.strictEqual(check(T0).total, 0, 'total=0');
});

test('registerAgent без id бросает', () => {
  A.throws(() => registerAgent({}), /id/, '{} без id');
  A.throws(() => registerAgent({ id: '' }), /id/, "id=''");
  A.throws(() => registerAgent(), /id/, 'undefined');
  A.throws(() => registerAgent(null), /id/, 'null');
});

/* ------------------------------------------------------------------------- *
 * 8. Форматы timestamp и ttlMs
 * ------------------------------------------------------------------------- */
test('timestamp: секунды / ISO / Date / числовая строка', () => {
  registerAgent({ id: 'sec', lastHeartbeat: (T0 - 1_000) / 1000 });
  A.strictEqual(getAgent('sec').lastHeartbeat, T0 - 1_000, 'секунды -> ms');
  A.strictEqual(statusOf('sec', T0), STATUS.OK, 'свежие секунды -> OK');

  registerAgent({ id: 'iso', lastHeartbeat: new Date(T0 - 45_000).toISOString() });
  A.strictEqual(getAgent('iso').lastHeartbeat, T0 - 45_000, 'ISO -> ms');
  A.strictEqual(statusOf('iso', T0), STATUS.STALE, 'ISO 45s -> STALE');

  registerAgent({ id: 'date', lastHeartbeat: new Date(T0 - 120_000) });
  A.strictEqual(getAgent('date').lastHeartbeat, T0 - 120_000, 'Date -> ms');
  A.strictEqual(statusOf('date', T0), STATUS.DEAD, 'Date 120s -> DEAD');

  registerAgent({ id: 'numstr', lastHeartbeat: String(T0 - 1_000) });
  A.strictEqual(getAgent('numstr').lastHeartbeat, T0 - 1_000, 'числовая строка (ms) -> ms');
  A.strictEqual(statusOf('numstr', T0), STATUS.OK, 'числовая строка ms -> OK');

  registerAgent({ id: 'secstr', lastHeartbeat: String((T0 - 45_000) / 1000) });
  A.strictEqual(getAgent('secstr').lastHeartbeat, T0 - 45_000, 'числовая строка (s) -> ms');
  A.strictEqual(statusOf('secstr', T0), STATUS.STALE, 'числовая строка s -> STALE');
});

test('ttlMs переопределяет TTL (10s)', () => {
  registerAgent({ id: 't-ok', ttlMs: 10_000, lastHeartbeat: T0 - 9_999 });
  registerAgent({ id: 't-stale', ttlMs: 10_000, lastHeartbeat: T0 - 10_000 });
  registerAgent({ id: 't-dead', ttlMs: 10_000, lastHeartbeat: T0 - 20_000 });

  A.strictEqual(statusOf('t-ok', T0), STATUS.OK, '9.999s < 10s -> OK');
  A.strictEqual(statusOf('t-stale', T0), STATUS.STALE, 'ровно 10s -> STALE');
  A.strictEqual(statusOf('t-dead', T0), STATUS.DEAD, '20s -> DEAD');
  const res = check(T0);
  A.strictEqual(res.alive, 1, 'alive=1');
  A.strictEqual(res.stale, 1, 'stale=1');
  A.strictEqual(res.dead, 1, 'dead=1');
  A.strictEqual(getAgent('t-ok').ttlMs, 10_000, 'ttlMs сохранён');
});

test('нет heartbeat -> DEAD; будущий heartbeat -> OK', () => {
  registerAgent({ id: 'no-hb' });
  getAgent('no-hb').lastHeartbeat = null; // эмулируем пропавший сигнал
  A.strictEqual(statusOf('no-hb', T0), STATUS.DEAD, 'нет heartbeat -> DEAD');
  A.strictEqual(check(T0).dead, 1, 'dead=1');

  registerAgent({ id: 'future', lastHeartbeat: T0 + 60_000 });
  A.strictEqual(statusOf('future', T0), STATUS.OK, 'будущий heartbeat -> OK');
  A.strictEqual(check(T0).alive, 1, 'alive=1');
});

/* ------------------------------------------------------------------------- *
 * Итоги
 * ------------------------------------------------------------------------- */
process.stdout.write(`\n${passed} passed, ${failed} failed, ${assertCount} asserts\n`);
process.stdout.write(`TOTAL_ASSERTS=${assertCount}\n`);
if (assertCount < 120) {
  process.stdout.write(`FAIL: требуется не менее 120 asserts, получено ${assertCount}\n`);
  process.exitCode = 1;
}
if (failed > 0) process.exitCode = 1;
