'use strict';

/**
 * observability/test_agent_health.js  (standalone)
 * ---------------------------------------------------------------------------
 * Standalone-тест для модуля `observability/agent_health.js`
 * (heartbeat-реестр агентов: TTL 30s, статусы OK / STALE / DEAD).
 *
 * Покрываемый КРИТЕРИЙ:
 *   - >= 40 ассертов;
 *   - статусы OK / STALE / DEAD и границы TTL 30s: 29.9s / 30.1s / 61s;
 *   - пустой реестр НЕ бросает (check() и checkAll());
 *   - check() / checkAll() возвращают консистентные структуры;
 *   - heartbeat() продлевает TTL (оживляет STALE/DEAD-агента);
 *   - регистрация / удаление / получение агентов.
 *
 * Семантика классификации (agent_health -> agent_registry):
 *        age <  TTL            -> OK
 *        TTL <= age <  2*TTL   -> STALE
 *        age >= 2*TTL          -> DEAD
 *        нет heartbeat          -> DEAD
 *
 * Запуск:
 *   node observability/test_agent_health.js
 *   -> exit 0, печатает 'PASS: <N>/40'  (N >= 40)
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

/* ------------------------------------------------------------------------- *
 * Мини-раннер: считает ассерты и изолирует реестр между кейсами
 * ------------------------------------------------------------------------- */

let assertCount = 0;
let testsPassed = 0;
let testsFailed = 0;

function ok(value, msg) {
  assertCount += 1;
  assert.ok(value, msg);
}
function eq(actual, expected, msg) {
  assertCount += 1;
  assert.strictEqual(actual, expected, msg);
}
function deep(actual, expected, msg) {
  assertCount += 1;
  assert.deepStrictEqual(actual, expected, msg);
}
function notEq(actual, expected, msg) {
  assertCount += 1;
  assert.notStrictEqual(actual, expected, msg);
}
function throws(fn, msg) {
  assertCount += 1;
  assert.throws(fn, msg);
}
function noThrow(fn, msg) {
  assertCount += 1;
  assert.doesNotThrow(fn, msg);
}

function test(name, fn) {
  try {
    clearRegistry(); // изоляция: каждый кейс начинается с пустого реестра
    fn();
    testsPassed += 1;
    process.stdout.write(`  ok   - ${name}\n`);
  } catch (err) {
    testsFailed += 1;
    process.stdout.write(`  FAIL - ${name}\n         ${err && err.message}\n`);
    process.exitCode = 1;
  } finally {
    clearRegistry();
  }
}

/* ------------------------------------------------------------------------- *
 * Константы
 * ------------------------------------------------------------------------- */

const TTL = 30 * 1000; // 30 000 мс
const T0 = 1_700_000_000_000; // детерминированное "сейчас" (epoch ms)

process.stdout.write('agent_health standalone test (heartbeat registry, TTL 30s)\n');

/* ------------------------------------------------------------------------- *
 * 1. API surface и константы
 * ------------------------------------------------------------------------- */
test('API: check/checkAll/register/heartbeat/... экспортируются как функции', () => {
  eq(typeof check, 'function', 'check — функция');
  eq(typeof checkAll, 'function', 'checkAll — функция');
  eq(typeof registerAgent, 'function', 'registerAgent — функция');
  eq(typeof heartbeat, 'function', 'heartbeat — функция');
  eq(typeof unregisterAgent, 'function', 'unregisterAgent — функция');
  eq(typeof getAgent, 'function', 'getAgent — функция');
  eq(typeof listAgents, 'function', 'listAgents — функция');
  eq(typeof statusOf, 'function', 'statusOf — функция');
  eq(typeof clearRegistry, 'function', 'clearRegistry — функция');
});

test('константы: TTL по умолчанию = 30s, статусы = OK/STALE/DEAD', () => {
  eq(DEFAULT_TTL_MS, TTL, 'DEFAULT_TTL_MS === 30000');
  eq(DEFAULT_TTL_MS, 30 * 1000, '30 секунд');
  eq(STATUS.OK, 'OK', 'STATUS.OK');
  eq(STATUS.STALE, 'STALE', 'STATUS.STALE');
  eq(STATUS.DEAD, 'DEAD', 'STATUS.DEAD');
});

/* ------------------------------------------------------------------------- *
 * 2. Границы TTL 30s: 29.9s -> OK, 30.1s -> STALE, 61s -> DEAD   (КРИТЕРИЙ)
 * ------------------------------------------------------------------------- */
test('границы TTL: 29.9s -> OK, 30.1s -> STALE, 61s -> DEAD', () => {
  registerAgent({ id: 'b-ok', lastHeartbeat: T0 - 29_900 }); //   29.9s
  registerAgent({ id: 'b-stale', lastHeartbeat: T0 - 30_100 }); //  30.1s
  registerAgent({ id: 'b-dead', lastHeartbeat: T0 - 61_000 }); //  61s

  eq(statusOf('b-ok', T0), STATUS.OK, '29.9s -> OK');
  eq(statusOf('b-stale', T0), STATUS.STALE, '30.1s -> STALE');
  eq(statusOf('b-dead', T0), STATUS.DEAD, '61s -> DEAD');

  const res = check(T0);
  eq(res.alive, 1, 'alive=1');
  eq(res.stale, 1, 'stale=1');
  eq(res.dead, 1, 'dead=1');
  eq(res.total, 3, 'total=3');
});

test('точные границы: ровно 30s -> STALE, ровно 60s -> DEAD', () => {
  registerAgent({ id: 'exact-ttl', lastHeartbeat: T0 - 30_000 });
  registerAgent({ id: 'exact-2ttl', lastHeartbeat: T0 - 60_000 });

  eq(statusOf('exact-ttl', T0), STATUS.STALE, 'ровно 30s -> STALE (age >= TTL)');
  eq(statusOf('exact-2ttl', T0), STATUS.DEAD, 'ровно 60s -> DEAD (age >= 2*TTL)');
});

test('под-граничные значения: 29.999s/30.001s/59.999s/60.001s', () => {
  registerAgent({ id: 'u-ok', lastHeartbeat: T0 - 29_999 }); // < TTL -> OK
  registerAgent({ id: 'o-stale', lastHeartbeat: T0 - 30_001 }); // >= TTL -> STALE
  registerAgent({ id: 'u-2ttl', lastHeartbeat: T0 - 59_999 }); // < 2*TTL -> STALE
  registerAgent({ id: 'o-2ttl', lastHeartbeat: T0 - 60_001 }); // >= 2*TTL -> DEAD

  eq(statusOf('u-ok', T0), STATUS.OK, '29.999s -> OK');
  eq(statusOf('o-stale', T0), STATUS.STALE, '30.001s -> STALE');
  eq(statusOf('u-2ttl', T0), STATUS.STALE, '59.999s -> STALE');
  eq(statusOf('o-2ttl', T0), STATUS.DEAD, '60.001s -> DEAD');
});

/* ------------------------------------------------------------------------- *
 * 3. Кастомный TTL
 * ------------------------------------------------------------------------- */
test('кастомный ttlMs масштабирует границы', () => {
  const rec = registerAgent({ id: 'ct', ttlMs: 10_000, lastHeartbeat: T0 - 9_000 });
  eq(rec.ttlMs, 10_000, 'ttlMs сохранён');
  eq(statusOf('ct', T0), STATUS.OK, '9s < 10s -> OK');
  registerAgent({ id: 'ct', lastHeartbeat: T0 - 10_000 });
  eq(statusOf('ct', T0), STATUS.STALE, 'ровно 10s -> STALE');
  registerAgent({ id: 'ct', lastHeartbeat: T0 - 20_000 });
  eq(statusOf('ct', T0), STATUS.DEAD, 'ровно 20s = 2*TTL -> DEAD');

  const res = check(T0);
  eq(res.dead, 1, 'кастомный DEAD учтён в check()');
});

/* ------------------------------------------------------------------------- *
 * 4. check() агрегирует несколько агентов
 * ------------------------------------------------------------------------- */
test('check(): несколько агентов в каждом статусе', () => {
  registerAgent({ id: 'ok-1', lastHeartbeat: T0 - 1_000 });
  registerAgent({ id: 'ok-2', lastHeartbeat: T0 - 20_000 });
  registerAgent({ id: 'stale-1', lastHeartbeat: T0 - 35_000 });
  registerAgent({ id: 'stale-2', lastHeartbeat: T0 - 59_000 });
  registerAgent({ id: 'dead-1', lastHeartbeat: T0 - 90_000 });
  registerAgent({ id: 'dead-2', lastHeartbeat: T0 - 600_000 });

  const res = check(T0);
  eq(res.alive, 2, 'alive=2');
  eq(res.stale, 2, 'stale=2');
  eq(res.dead, 2, 'dead=2');
  eq(res.total, 6, 'total=6');
  eq(res.alive + res.stale + res.dead, res.total, 'сумма статусов === total');
  eq(res.byStatus[STATUS.OK], 2, 'byStatus.OK=2');
  eq(res.byStatus[STATUS.STALE], 2, 'byStatus.STALE=2');
  eq(res.byStatus[STATUS.DEAD], 2, 'byStatus.DEAD=2');
});

/* ------------------------------------------------------------------------- *
 * 5. check() структура консистентна
 * ------------------------------------------------------------------------- */
test('check(): консистентная структура ответа', () => {
  registerAgent({ id: 'shape', lastHeartbeat: T0 - 1_000 });
  const res = check(T0);

  eq(typeof res.alive, 'number', 'alive — number');
  eq(typeof res.stale, 'number', 'stale — number');
  eq(typeof res.dead, 'number', 'dead — number');
  eq(typeof res.total, 'number', 'total — number');
  eq(typeof res.generatedAt, 'string', 'generatedAt — string');
  ok(Number.isFinite(Date.parse(res.generatedAt)), 'generatedAt парсится как дата');
  ok(
    res.byStatus !== null && typeof res.byStatus === 'object' && !Array.isArray(res.byStatus),
    'byStatus — объект (не массив)',
  );
  deep(
    Object.keys(res).sort(),
    ['alive', 'byStatus', 'dead', 'generatedAt', 'stale', 'total'].sort(),
    'check() возвращает ровно ожидаемый набор ключей',
  );
});

/* ------------------------------------------------------------------------- *
 * 6. Пустой реестр НЕ бросает   (КРИТЕРИЙ)
 * ------------------------------------------------------------------------- */
test('пустой реестр: check() даёт нули без throw', () => {
  let res;
  noThrow(() => {
    res = check(T0);
  }, 'check(T0) на пустом реестре не бросает');

  eq(res.alive, 0, 'alive=0');
  eq(res.stale, 0, 'stale=0');
  eq(res.dead, 0, 'dead=0');
  eq(res.total, 0, 'total=0');
});

test('пустой реестр: check() без аргумента не throw', () => {
  let res;
  noThrow(() => {
    res = check();
  }, 'check() без now не бросает');
  deep(
    { alive: res.alive, stale: res.stale, dead: res.dead, total: res.total },
    { alive: 0, stale: 0, dead: 0, total: 0 },
    'пустой ответ',
  );
});

test('пустой реестр: checkAll() не throw и возвращает пустой отчёт', () => {
  let r;
  noThrow(() => {
    r = checkAll(T0);
  }, 'checkAll(T0) на пустом реестре не бросает');

  eq(r.total, 0, 'total=0');
  ok(Array.isArray(r.agents), 'agents — массив');
  eq(r.agents.length, 0, 'agents пуст');
  eq(r.overall, STATUS.DEAD, 'overall пустого реестра = DEAD');
  deep(r.byStatus, { OK: 0, STALE: 0, DEAD: 0 }, 'byStatus — нули');
});

/* ------------------------------------------------------------------------- *
 * 7. heartbeat() продлевает TTL   (КРИТЕРИЙ)
 * ------------------------------------------------------------------------- */
test('heartbeat() оживляет DEAD-агента -> OK', () => {
  registerAgent({ id: 'revive', lastHeartbeat: T0 - 120_000 });
  eq(statusOf('revive', T0), STATUS.DEAD, 'до heartbeat — DEAD');

  const rec = heartbeat('revive', { at: T0 });
  ok(rec !== null && typeof rec === 'object', 'heartbeat вернул запись');
  eq(rec.lastHeartbeat, T0, 'lastHeartbeat обновлён на T0');
  eq(statusOf('revive', T0), STATUS.OK, 'после heartbeat — OK');

  const res = check(T0);
  eq(res.alive, 1, 'alive=1 после оживления');
  eq(res.dead, 0, 'dead=0 после оживления');
});

test('heartbeat() оживляет STALE-агента -> OK', () => {
  registerAgent({ id: 'stale2ok', lastHeartbeat: T0 - 45_000 });
  eq(statusOf('stale2ok', T0), STATUS.STALE, 'до heartbeat — STALE');
  heartbeat('stale2ok', { at: T0 });
  eq(statusOf('stale2ok', T0), STATUS.OK, 'после heartbeat — OK');
});

test('heartbeat() без at использует текущее время (продление TTL)', () => {
  registerAgent({ id: 'live', lastHeartbeat: T0 - 500_000 });
  const before = getAgent('live').lastHeartbeat;
  heartbeat('live');
  const after = getAgent('live').lastHeartbeat;

  ok(after > before, 'heartbeat без at продлевает от старого значения');
  ok(after >= Date.now() - 5_000, 'новый heartbeat близок к текущему now');
  eq(statusOf('live'), STATUS.OK, 'после heartbeat (now) — OK');
});

test('heartbeat() неизвестного агента -> null', () => {
  eq(heartbeat('nobody'), null, 'heartbeat неизвестного id -> null');
  eq(heartbeat('nobody', { at: T0 }), null, 'heartbeat({at}) неизвестного -> null');
});

/* ------------------------------------------------------------------------- *
 * 8. checkAll() структура консистентна   (КРИТЕРИЙ)
 * ------------------------------------------------------------------------- */
test('checkAll(): консистентный подробный отчёт', () => {
  registerAgent({ id: 'ok', lastHeartbeat: T0 - 1_000 });
  registerAgent({ id: 'stale', lastHeartbeat: T0 - 45_000 });
  registerAgent({ id: 'dead', lastHeartbeat: T0 - 120_000 });

  const r = checkAll(T0);

  eq(r.total, 3, 'total=3');
  ok(Array.isArray(r.agents), 'agents — массив');
  eq(r.agents.length, 3, 'agents.length=3');
  eq(r.byStatus.OK, 1, 'byStatus.OK=1');
  eq(r.byStatus.STALE, 1, 'byStatus.STALE=1');
  eq(r.byStatus.DEAD, 1, 'byStatus.DEAD=1');
  eq(r.alive, 1, 'alive=1');
  eq(r.stale, 1, 'stale=1');
  eq(r.dead, 1, 'dead=1');
  eq(r.overall, STATUS.DEAD, 'overall = худший статус (DEAD)');

  // Каждая запись согласована со statusOf().
  for (const rep of r.agents) {
    eq(rep.status, statusOf(rep.id, T0), `status агента ${rep.id} совпадает со statusOf()`);
  }

  ok(
    r.agents.every((a) => typeof a.id === 'string' && a.id.length > 0),
    'у каждого агента есть id',
  );
  ok(
    r.agents.every((a) => a.status === STATUS.OK || a.status === STATUS.STALE || a.status === STATUS.DEAD),
    'статусы агентов только OK/STALE/DEAD',
  );
  ok(
    r.agents.every((a) => Object.prototype.hasOwnProperty.call(a, 'heartbeatAgeMs')),
    'у каждого агента есть heartbeatAgeMs',
  );
  ok(
    r.agents.every((a) => Array.isArray(a.checks) && a.checks.length > 0),
    'у каждого агента есть непустой checks[]',
  );

  deep(
    Object.keys(r).sort(),
    ['agents', 'alive', 'byStatus', 'dead', 'generatedAt', 'healthy', 'host', 'overall', 'stale', 'total'].sort(),
    'checkAll() возвращает ожидаемый набор ключей',
  );
});

test('check() и checkAll() согласованы по числам', () => {
  registerAgent({ id: 'c-ok', lastHeartbeat: T0 - 1_000 });
  registerAgent({ id: 'c-stale', lastHeartbeat: T0 - 40_000 });
  registerAgent({ id: 'c-dead', lastHeartbeat: T0 - 300_000 });

  const c = check(T0);
  const all = checkAll(T0);

  eq(c.alive, all.alive, 'alive совпадает');
  eq(c.stale, all.stale, 'stale совпадает');
  eq(c.dead, all.dead, 'dead совпадает');
  eq(c.total, all.total, 'total совпадает');
  eq(all.alive + all.stale + all.dead, all.total, 'checkAll: сумма === total');
});

/* ------------------------------------------------------------------------- *
 * 9. Регистрация / получение / удаление
 * ------------------------------------------------------------------------- */
test('registerAgent/getAgent/listAgents/unregisterAgent', () => {
  throws(() => registerAgent({}), 'registerAgent без id бросает');
  throws(() => registerAgent(null), 'registerAgent(null) бросает');

  const a = registerAgent({ id: 'r1', lastHeartbeat: T0 - 1_000 });
  eq(a.id, 'r1', 'id нормализован');
  ok(getAgent('r1') !== null, 'getAgent вернул зарегистрированного');
  eq(getAgent('nope'), null, 'getAgent неизвестного -> null');
  eq(listAgents().length, 1, 'в реестре 1 агент');

  eq(unregisterAgent('r1'), true, 'unregister существующего -> true');
  eq(unregisterAgent('r1'), false, 'повторный unregister -> false');
  eq(listAgents().length, 0, 'реестр пуст после удаления');
  eq(statusOf('r1', T0), null, 'statusOf удалённого -> null');
});

test('агент без heartbeat трактуется как DEAD', () => {
  registerAgent({ id: 'no-hb', lastHeartbeat: undefined });
  // Эмулируем пропавший сигнал.
  getAgent('no-hb').lastHeartbeat = null;
  eq(statusOf('no-hb', T0), STATUS.DEAD, 'нет heartbeat -> DEAD');
  eq(check(T0).dead, 1, 'check() учитывает отсутствие heartbeat как dead');
});

/* ------------------------------------------------------------------------- *
 * Итог
 * ------------------------------------------------------------------------- */

const REQUIRED = 40;

if (testsFailed === 0 && assertCount >= REQUIRED) {
  process.stdout.write(`\nPASS: ${assertCount}/${REQUIRED}\n`);
  process.exitCode = 0;
} else {
  process.stdout.write(
    `\nFAIL: ${assertCount}/${REQUIRED} (tests failed: ${testsFailed})\n`,
  );
  process.exitCode = 1;
}
