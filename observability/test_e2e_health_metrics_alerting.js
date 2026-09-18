'use strict';

/**
 * observability/test_e2e_health_metrics_alerting.js  (standalone E2E)
 * ---------------------------------------------------------------------------
 * Сквозной E2E-тест связки:
 *
 *     agent_health  ->  metrics_collector  ->  alerting
 *     (heartbeat)       (snapshot/query)       (evaluate/dedup)
 *
 * Сценарий:
 *   1. Поднимаем heartbeat-регистр из 3 агентов с возрастом heartbeat
 *      29.9s / 30.1s / 61s  =>  статусы OK / STALE / DEAD (TTL = 30s).
 *   2. Снимаем snapshot здоровья и прогоняем его через metrics_collector
 *      (collect -> query), получая агрегированный snapshot метрик.
 *   3. Маппим snapshot здоровья в snapshot алертинга и вызываем
 *      alerting.evaluate(snapshot) — проверяем генерацию алертов.
 *
 * КРИТЕРИЙ:
 *   - >= 150 assert;
 *   - покрыты статусы OK / STALE / DEAD (TTL 30s: 29.9 OK / 30.1 STALE / 61 DEAD);
 *   - dedup 10 мин: двойной evaluate одного threshold -> 1 алерт;
 *   - пустой регистр НЕ бросает.
 *
 * Запуск:
 *   node --check observability/test_e2e_health_metrics_alerting.js
 *   node observability/test_e2e_health_metrics_alerting.js
 *   -> exit 0, печатает 'PASS: <N>/150'  (N >= 150)
 */

const assert = require('assert');

const health = require('./agent_health');
const metrics = require('./metrics_collector');
const alerting = require('./alerting');

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

const { createCollector } = metrics;

/* ------------------------------------------------------------------------- *
 * Мини-раннер: считает ассерты, изолирует состояние между кейсами
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
function notEq(actual, expected, msg) {
  assertCount += 1;
  assert.notStrictEqual(actual, expected, msg);
}
function deep(actual, expected, msg) {
  assertCount += 1;
  assert.deepStrictEqual(actual, expected, msg);
}
function throws(fn, msg) {
  assertCount += 1;
  assert.throws(fn, msg);
}
function doesNotThrow(fn, msg) {
  assertCount += 1;
  assert.doesNotThrow(fn, msg);
}
function isFn(value, msg) {
  assertCount += 1;
  assert.strictEqual(typeof value, 'function', msg);
}

function test(name, fn) {
  try {
    fn();
    testsPassed += 1;
    process.stdout.write('  \u2713 ' + name + '\n');
  } catch (err) {
    testsFailed += 1;
    process.stdout.write('  \u2717 ' + name + ' -> ' + err.message + '\n');
  }
}

process.stdout.write('observability/test_e2e_health_metrics_alerting.js\n');

/* ------------------------------------------------------------------------- *
 * Константы / детерминированное время
 * ------------------------------------------------------------------------- */

const SEC = 1000;
const MIN = 60 * SEC;
const TTL = 30 * SEC; // 30_000 ms
const T0 = Date.parse('2024-06-01T00:00:00.000Z');
const WINDOW = alerting.SNAPSHOT_DEDUP_WINDOW_MS; // 10 минут

const AGENT_OK = 'agent-ok'; // age 29.9s  -> OK
const AGENT_STALE = 'agent-stale'; // age 30.1s  -> STALE
const AGENT_DEAD = 'agent-dead'; // age 61s    -> DEAD

/* ------------------------------------------------------------------------- *
 * Хелперы пайплайна
 * ------------------------------------------------------------------------- */

/** Сбросить регистр и алертинг, зарегистрировать 3 канонических агента. */
function seedThreeAgents(now = T0) {
  clearRegistry();
  alerting.resetSnapshotState();
  registerAgent({ id: AGENT_OK, name: 'ok', ttlMs: TTL, lastHeartbeat: now - 29_900 });
  registerAgent({ id: AGENT_STALE, name: 'stale', ttlMs: TTL, lastHeartbeat: now - 30_100 });
  registerAgent({ id: AGENT_DEAD, name: 'dead', ttlMs: TTL, lastHeartbeat: now - 61_000 });
}

/** Маппинг snapshot здоровья -> snapshot алертинга (cpu/ram/load/disk). */
function toAlertSnapshot(report, now) {
  return {
    cpu: report.dead > 0 ? 100 : 0,
    ram: report.stale > 0 ? 100 : 0,
    load: report.dead,
    disk: report.total > 0 && report.alive === 0 ? 100 : 0,
    ts: now,
  };
}

/**
 * Полный E2E-прогон: heartbeat -> health snapshot -> metrics_collector ->
 * alerting snapshot. Возвращает все промежуточные артефакты.
 */
function runPipeline(now = T0) {
  const healthReport = checkAll({ now });

  const collector = createCollector({ clock: () => now, maxSamples: 1000 });
  collector.collect('agent.health.ok', healthReport.alive);
  collector.collect('agent.health.stale', healthReport.stale);
  collector.collect('agent.health.dead', healthReport.dead);
  collector.collect('agent.health.total', healthReport.total);
  for (const a of healthReport.agents) {
    collector.collect('agent.heartbeat.age_ms', a.heartbeatAgeMs, {
      agent: a.id,
      status: a.status,
    });
  }

  const metricsSnapshot = collector.query('10m');
  const alertSnapshot = toAlertSnapshot(healthReport, now);
  const alerts = alerting.evaluate(alertSnapshot);

  return { healthReport, collector, metricsSnapshot, alertSnapshot, alerts };
}

/* ========================================================================= *
 * 1. API-контракт трёх модулей
 * ========================================================================= */

test('API: модули экспортируют нужные функции', () => {
  isFn(check, 'health.check — функция');
  isFn(checkAll, 'health.checkAll — функция');
  isFn(registerAgent, 'health.registerAgent — функция');
  isFn(heartbeat, 'health.heartbeat — функция');
  isFn(statusOf, 'health.statusOf — функция');
  isFn(clearRegistry, 'health.clearRegistry — функция');
  isFn(createCollector, 'metrics.createCollector — функция');
  isFn(metrics.collect, 'metrics.collect — функция');
  isFn(metrics.query, 'metrics.query — функция');
  isFn(alerting.evaluate, 'alerting.evaluate — функция');
  isFn(alerting.configure, 'alerting.configure — функция');
  isFn(alerting.active, 'alerting.active — функция');
  isFn(alerting.history, 'alerting.history — функция');
  isFn(alerting.resetSnapshotState, 'alerting.resetSnapshotState — функция');
});

test('TTL-константы: 30s и статусы OK/STALE/DEAD', () => {
  eq(DEFAULT_TTL_MS, 30_000, 'DEFAULT_TTL_MS == 30000');
  eq(TTL, 30_000, 'локальный TTL == 30000');
  eq(STATUS.OK, 'OK', 'STATUS.OK');
  eq(STATUS.STALE, 'STALE', 'STATUS.STALE');
  eq(STATUS.DEAD, 'DEAD', 'STATUS.DEAD');
  eq(WINDOW, 10 * MIN, 'dedup-окно == 10 минут');
  eq(WINDOW, 600_000, 'dedup-окно == 600000 ms');
  eq(metrics.parseDuration('30s'), 30_000, 'parseDuration(30s)');
  eq(metrics.parseDuration('10m'), 600_000, 'parseDuration(10m)');
});

/* ========================================================================= *
 * 2. Пустой регистр НЕ бросает
 * ========================================================================= */

test('пустой регистр: check()/checkAll() не бросают', () => {
  clearRegistry();
  doesNotThrow(() => check(T0), 'check() на пустом реестре');
  doesNotThrow(() => checkAll({ now: T0 }), 'checkAll() на пустом реестре');
  doesNotThrow(() => listAgents(), 'listAgents() на пустом реестре');
  doesNotThrow(() => statusOf('nope', T0), 'statusOf() неизвестного');

  const c = check(T0);
  eq(c.total, 0, 'пустой check.total == 0');
  eq(c.alive, 0, 'пустой check.alive == 0');
  eq(c.stale, 0, 'пустой check.stale == 0');
  eq(c.dead, 0, 'пустой check.dead == 0');
  eq(c.byStatus.OK, 0, 'byStatus.OK == 0');
  eq(c.byStatus.STALE, 0, 'byStatus.STALE == 0');
  eq(c.byStatus.DEAD, 0, 'byStatus.DEAD == 0');

  const r = checkAll({ now: T0 });
  eq(r.total, 0, 'пустой checkAll.total == 0');
  eq(r.agents.length, 0, 'пустой checkAll.agents == []');
  eq(r.overall, STATUS.DEAD, 'overall пустого реестра == DEAD');
  eq(r.alive, 0, 'checkAll.alive == 0');
  eq(r.stale, 0, 'checkAll.stale == 0');
  eq(r.dead, 0, 'checkAll.dead == 0');
  ok(typeof r.generatedAt === 'string', 'generatedAt — строка');
  ok(Array.isArray(r.agents), 'agents — массив');
  ok(r.host && typeof r.host.hostname === 'string', 'host.hostname — строка');
});

test('пустой пайплайн: collector/alerting не бросают', () => {
  clearRegistry();
  alerting.resetSnapshotState();

  let pipeline;
  doesNotThrow(() => {
    pipeline = runPipeline(T0);
  }, 'runPipeline() на пустом реестре');

  eq(pipeline.healthReport.total, 0, 'health.total == 0');
  // Пустой реестр -> 4 нулевые серии здоровья (ok/stale/dead/total == 0).
  eq(pipeline.metricsSnapshot.series.length, 4, '4 нулевые серии здоровья');
  eq(pipeline.metricsSnapshot.total, 4, '4 нулевых сэмпла');
  eq(pipeline.alerts.length, 0, 'нет алертов');

  doesNotThrow(() => alerting.evaluate(null), 'evaluate(null)');
  doesNotThrow(() => alerting.evaluate(null, null), 'evaluate(null, null)');
  doesNotThrow(() => alerting.evaluate({}), 'evaluate({})');
  doesNotThrow(() => alerting.evaluate(undefined), 'evaluate(undefined)');
  deep(alerting.evaluate(null), [], 'evaluate(null) -> []');
  deep(alerting.evaluate({}), [], 'evaluate({}) -> []');
  deep(alerting.evaluate(undefined, null), [], 'evaluate(undefined, null) -> []');
  eq(alerting.history().length, 0, 'history пуст');

  const empty = createCollector({ clock: () => T0 });
  doesNotThrow(() => empty.query('10m'), 'empty collect.query()');
  eq(empty.query('10m').series.length, 0, 'empty query.series == []');
  eq(empty.query('10m').total, 0, 'empty query.total == 0');
  eq(empty.names().length, 0, 'empty names() == []');
  eq(empty.health().series, 0, 'empty health.series == 0');
});

/* ========================================================================= *
 * 3. Границы TTL 30s: 29.9 OK / 30.1 STALE / 61 DEAD
 * ========================================================================= */

test('TTL 30s: 29.9s -> OK, 30.1s -> STALE, 61s -> DEAD', () => {
  seedThreeAgents(T0);
  eq(listAgents().length, 3, 'в реестре 3 агента');

  eq(statusOf(AGENT_OK, T0), STATUS.OK, '29.9s -> OK');
  eq(statusOf(AGENT_STALE, T0), STATUS.STALE, '30.1s -> STALE');
  eq(statusOf(AGENT_DEAD, T0), STATUS.DEAD, '61s -> DEAD');

  const c = check(T0);
  eq(c.total, 3, 'check.total == 3');
  eq(c.alive, 1, 'check.alive == 1');
  eq(c.stale, 1, 'check.stale == 1');
  eq(c.dead, 1, 'check.dead == 1');

  const r = checkAll({ now: T0 });
  eq(r.total, 3, 'checkAll.total == 3');
  eq(r.alive, 1, 'checkAll.alive == 1 (OK)');
  eq(r.stale, 1, 'checkAll.stale == 1 (STALE)');
  eq(r.dead, 1, 'checkAll.dead == 1 (DEAD)');
  eq(r.overall, STATUS.DEAD, 'overall == DEAD (самый серьёзный)');

  const byId = Object.create(null);
  for (const a of r.agents) byId[a.id] = a;
  eq(byId[AGENT_OK].status, STATUS.OK, 'per-agent OK');
  eq(byId[AGENT_STALE].status, STATUS.STALE, 'per-agent STALE');
  eq(byId[AGENT_DEAD].status, STATUS.DEAD, 'per-agent DEAD');
  eq(byId[AGENT_OK].heartbeatAgeMs, 29_900, 'age ok == 29900');
  eq(byId[AGENT_STALE].heartbeatAgeMs, 30_100, 'age stale == 30100');
  eq(byId[AGENT_DEAD].heartbeatAgeMs, 61_000, 'age dead == 61000');
  eq(byId[AGENT_OK].ttlMs, TTL, 'ttl ok == 30000');
  eq(byId[AGENT_STALE].ttlMs, TTL, 'ttl stale == 30000');
  eq(byId[AGENT_DEAD].ttlMs, TTL, 'ttl dead == 30000');
});

test('TTL-границы: соседние значения возраста', () => {
  const cases = [
    [0, STATUS.OK],
    [1, STATUS.OK],
    [29_999, STATUS.OK],
    [30_000, STATUS.STALE], // ровно TTL -> STALE
    [30_001, STATUS.STALE],
    [59_999, STATUS.STALE],
    [60_000, STATUS.DEAD], // ровно 2*TTL -> DEAD
    [60_001, STATUS.DEAD],
    [61_000, STATUS.DEAD],
    [120_000, STATUS.DEAD],
  ];

  for (const [age, expected] of cases) {
    clearRegistry();
    registerAgent({ id: 'x', ttlMs: TTL, lastHeartbeat: T0 - age });
    eq(statusOf('x', T0), expected, `age=${age}ms -> ${expected}`);
    eq(check(T0).byStatus[expected] >= 1, true, `check() видит ${expected} при age=${age}`);
  }
});

test('heartbeat() оживляет STALE/DEAD-агента', () => {
  seedThreeAgents(T0);
  eq(statusOf(AGENT_STALE, T0), STATUS.STALE, 'до heartbeat — STALE');
  heartbeat(AGENT_STALE, { at: T0 });
  eq(statusOf(AGENT_STALE, T0), STATUS.OK, 'после heartbeat — OK');
  eq(getAgent(AGENT_STALE).lastHeartbeat, T0, 'lastHeartbeat обновлён');

  eq(statusOf(AGENT_DEAD, T0), STATUS.DEAD, 'до heartbeat — DEAD');
  heartbeat(AGENT_DEAD, { at: T0 });
  eq(statusOf(AGENT_DEAD, T0), STATUS.OK, 'после heartbeat — OK');

  const c = check(T0);
  eq(c.alive, 3, 'все три агента живы после heartbeat');
  eq(c.stale, 0, 'stale == 0');
  eq(c.dead, 0, 'dead == 0');
});

test('register/unregister/get/list/statusOf', () => {
  clearRegistry();
  throws(() => registerAgent({}), 'registerAgent без id бросает');
  throws(() => registerAgent(null), 'registerAgent(null) бросает');
  throws(() => registerAgent({ id: '' }), 'registerAgent c пустым id бросает');

  const a = registerAgent({ id: 'r1', lastHeartbeat: T0 - 1000 });
  eq(a.id, 'r1', 'id нормализован');
  eq(getAgent('r1').id, 'r1', 'getAgent вернул запись');
  eq(getAgent('nope'), null, 'getAgent неизвестного -> null');
  eq(listAgents().length, 1, 'в реестре 1 агент');
  eq(statusOf('r1', T0), STATUS.OK, 'свежий агент OK');
  eq(unregisterAgent('r1'), true, 'unregister существующего -> true');
  eq(unregisterAgent('r1'), false, 'повторный unregister -> false');
  eq(listAgents().length, 0, 'реестр пуст');
  eq(statusOf('r1', T0), null, 'statusOf удалённого -> null');
});

/* ========================================================================= *
 * 4. metrics_collector: snapshot из здоровья 3 агентов
 * ========================================================================= */

test('collector: collects агрегирует здоровье 3 агентов', () => {
  seedThreeAgents(T0);
  alerting.resetSnapshotState();
  const { collector, metricsSnapshot } = runPipeline(T0);

  const names = collector.names();
  for (const n of ['agent.health.ok', 'agent.health.stale', 'agent.health.dead', 'agent.health.total', 'agent.heartbeat.age_ms']) {
    ok(names.indexOf(n) >= 0, `collector знает метрику ${n}`);
  }
  eq(metricsSnapshot.series.length, 7, '7 серий (4 health + 3 age/агент)');
  eq(metricsSnapshot.total, 7, '7 сэмплов всего (4 + 3)');

  const okAgg = collector.get('agent.health.ok', '10m');
  const staleAgg = collector.get('agent.health.stale', '10m');
  const deadAgg = collector.get('agent.health.dead', '10m');
  const totalAgg = collector.get('agent.health.total', '10m');

  eq(okAgg.count, 1, 'ok count == 1');
  eq(okAgg.sum, 1, 'ok sum == 1');
  eq(okAgg.avg, 1, 'ok avg == 1');
  eq(okAgg.min, 1, 'ok min == 1');
  eq(okAgg.max, 1, 'ok max == 1');

  eq(staleAgg.count, 1, 'stale count == 1');
  eq(staleAgg.sum, 1, 'stale sum == 1');
  eq(deadAgg.count, 1, 'dead count == 1');
  eq(deadAgg.sum, 1, 'dead sum == 1');
  eq(totalAgg.count, 1, 'total count == 1');
  eq(totalAgg.sum, 3, 'total sum == 3');

  const ageSeries = metricsSnapshot.series.filter((s) => s.name === 'agent.heartbeat.age_ms');
  eq(ageSeries.length, 3, '3 серии age (по агенту)');
  let ageCount = 0;
  let ageSum = 0;
  let ageMin = Infinity;
  let ageMax = -Infinity;
  for (const s of ageSeries) {
    ageCount += s.count;
    ageSum += s.sum;
    if (s.min < ageMin) ageMin = s.min;
    if (s.max > ageMax) ageMax = s.max;
  }
  eq(ageCount, 3, 'age count == 3');
  eq(ageSum, 29_900 + 30_100 + 61_000, 'age sum == 121000');
  eq(ageMin, 29_900, 'age min == 29900');
  eq(ageMax, 61_000, 'age max == 61000');
  eq(Math.round(ageSum / ageCount), Math.round(121_000 / 3), 'age avg');

  const h = collector.health();
  eq(h.series, 7, 'health.series == 7');
  eq(h.samples, 7, 'health.samples == 7');
  eq(h.collected, 7, 'health.collected == 7');
  eq(h.rejected, 0, 'health.rejected == 0');
  eq(h.queries, 1, 'health.queries == 1');
});

test('collector: валидация, reset, tags-фильтр', () => {
  const c = createCollector({ clock: () => T0 });
  eq(c.collect('m', 5), true, 'collect валидного -> true');
  eq(c.collect('m', 7), true, 'collect второго -> true');
  eq(c.collect('m', 6), true, 'collect третьего -> true');
  eq(c.collect('', 1), false, 'пустое имя -> false');
  eq(c.collect(null, 1), false, 'null имя -> false');
  eq(c.collect('m', 'nope'), false, 'нечисловое значение -> false');
  eq(c.collect('m', null), false, 'null значение -> false');
  eq(c.health().rejected, 4, 'rejected == 4');

  c.collect('svc.latency', 10, { host: 'a' });
  c.collect('svc.latency', 20, { host: 'b' });
  const a = c.get('svc.latency', '10m', { tag: { host: 'a' } });
  eq(a.count, 1, 'tag-фильтр host=a -> 1 сэмпл');
  eq(a.avg, 10, 'tag-фильтр host=a avg == 10');

  const m = c.get('m', '10m');
  eq(m.count, 3, 'm count == 3');
  eq(m.sum, 18, 'm sum == 18');
  eq(m.avg, 6, 'm avg == 6');
  eq(m.min, 5, 'm min == 5');
  eq(m.max, 7, 'm max == 7');

  c.reset('m');
  eq(c.get('m', '10m'), null, 'после reset(m) -> null');
  ok(c.get('svc.latency', '10m') !== null, 'другие метрики сохранены');
  c.reset();
  eq(c.names().length, 0, 'после reset() пусто');
});

/* ========================================================================= *
 * 5. E2E: snapshot -> evaluate() -> генерация алерта
 * ========================================================================= */

test('E2E: DEAD-агент -> cpu/ram алерты', () => {
  seedThreeAgents(T0);
  const { healthReport, alertSnapshot, alerts } = runPipeline(T0);

  eq(healthReport.dead, 1, 'один DEAD-агент');
  eq(healthReport.stale, 1, 'один STALE-агент');
  eq(healthReport.alive, 1, 'один OK-агент');

  eq(alertSnapshot.cpu, 100, 'cpu snapshot == 100');
  eq(alertSnapshot.ram, 100, 'ram snapshot == 100');
  eq(alertSnapshot.load, 1, 'load snapshot == 1');
  eq(alertSnapshot.ts, T0, 'ts snapshot == T0');

  eq(alerts.length, 2, 'сгенерировано 2 алерта (cpu, ram)');
  const metricsFired = alerts.map((a) => a.metric).sort();
  deep(metricsFired, ['cpu', 'ram'], 'алерты по cpu и ram');

  for (const al of alerts) {
    ok(typeof al.level === 'string', `alert(${al.metric}).level — строка`);
    eq(al.level, 'warn', `alert(${al.metric}).level == warn`);
    ok(typeof al.value === 'number', `alert(${al.metric}).value — число`);
    ok(typeof al.threshold === 'number', `alert(${al.metric}).threshold — число`);
    ok(typeof al.ts === 'string', `alert(${al.metric}).ts — ISO-строка`);
    eq(al.timestamp, T0, `alert(${al.metric}).timestamp == T0`);
  }

  const cpu = alerts.find((a) => a.metric === 'cpu');
  const ram = alerts.find((a) => a.metric === 'ram');
  eq(cpu.value, 100, 'cpu alert value == 100');
  eq(cpu.threshold, 85, 'cpu alert threshold == 85');
  ok(cpu.value > cpu.threshold, 'cpu value > threshold');
  eq(ram.value, 100, 'ram alert value == 100');
  eq(ram.threshold, 90, 'ram alert threshold == 90');
  ok(ram.value > ram.threshold, 'ram value > threshold');

  eq(alerting.history().length, 2, 'history содержит 2 алерта');
  eq(alerting.active({ now: T0 + 1_000 }).length, 2, 'active внутри окна содержит 2 алерта');
  eq(alerting.active({ now: T0 + WINDOW }).length, 0, 'active вне окна пуст');
});

test('E2E: только DEAD-агент (без stale) -> только cpu-алерт', () => {
  clearRegistry();
  alerting.resetSnapshotState();
  registerAgent({ id: AGENT_OK, ttlMs: TTL, lastHeartbeat: T0 - 5_000 });
  registerAgent({ id: AGENT_DEAD, ttlMs: TTL, lastHeartbeat: T0 - 61_000 });

  const { alertSnapshot, alerts } = runPipeline(T0);
  eq(alertSnapshot.cpu, 100, 'cpu == 100');
  eq(alertSnapshot.ram, 0, 'ram == 0 (нет stale)');
  eq(alertSnapshot.load, 1, 'load == 1 (< 4, не срабатывает)');
  eq(alerts.length, 1, 'ровно 1 алерт');
  eq(alerts[0].metric, 'cpu', 'алерт по cpu');
});

test('E2E: все агенты OK -> нет алертов, overall OK', () => {
  clearRegistry();
  alerting.resetSnapshotState();
  registerAgent({ id: 'a1', ttlMs: TTL, lastHeartbeat: T0 - 1_000 });
  registerAgent({ id: 'a2', ttlMs: TTL, lastHeartbeat: T0 - 2_000 });
  registerAgent({ id: 'a3', ttlMs: TTL, lastHeartbeat: T0 - 3_000 });

  const { healthReport, alertSnapshot, alerts } = runPipeline(T0);
  eq(healthReport.alive, 3, 'все 3 OK');
  eq(healthReport.overall, STATUS.OK, 'overall == OK');
  eq(alertSnapshot.cpu, 0, 'cpu == 0');
  eq(alertSnapshot.ram, 0, 'ram == 0');
  eq(alerts.length, 0, 'алертов нет');
});

test('E2E: все агенты DEAD -> disk-алерт (alive == 0)', () => {
  clearRegistry();
  alerting.resetSnapshotState();
  registerAgent({ id: 'd1', ttlMs: TTL, lastHeartbeat: T0 - 61_000 });
  registerAgent({ id: 'd2', ttlMs: TTL, lastHeartbeat: T0 - 90_000 });

  const { healthReport, alertSnapshot, alerts } = runPipeline(T0);
  eq(healthReport.dead, 2, 'двое DEAD');
  eq(healthReport.alive, 0, 'нет живых');
  eq(alertSnapshot.disk, 100, 'disk == 100');
  ok(alerts.some((a) => a.metric === 'disk'), 'есть disk-алерт');
  ok(alerts.some((a) => a.metric === 'cpu'), 'есть cpu-алерт');
});

/* ========================================================================= *
 * 6. dedup 10 минут: двойной evaluate того же threshold -> 1 алерт
 * ========================================================================= */

test('dedup: двойной evaluate одного threshold -> 1 алерт', () => {
  alerting.resetSnapshotState();
  alerting.configure({ cpu: 85 });
  const snap = { cpu: 100, ts: T0 };

  const first = alerting.evaluate(snap);
  eq(first.length, 1, 'первый evaluate -> 1 алерт');
  eq(first[0].metric, 'cpu', 'алерт по cpu');

  const second = alerting.evaluate({ cpu: 100, ts: T0 + 1_000 });
  eq(second.length, 0, 'второй evaluate (через 1s) -> 0 алертов');
  eq(alerting.history().length, 1, 'в history ровно 1 алерт');

  const third = alerting.evaluate({ cpu: 100, ts: T0 + 599_000 });
  eq(third.length, 0, 'внутри окна (599s) -> 0 алертов');
  eq(alerting.history().length, 1, 'history всё ещё 1 алерт');

  const fourth = alerting.evaluate({ cpu: 100, ts: T0 + 600_000 });
  eq(fourth.length, 1, 'по истечении 600s -> снова 1 алерт');
  eq(alerting.history().length, 2, 'history == 2 алерта');
});

test('dedup: точная граница окна (WINDOW-1 vs WINDOW)', () => {
  alerting.resetSnapshotState();
  alerting.configure({ load: 4 });
  eq(alerting.evaluate({ load: 9, ts: T0 }).length, 1, 't=0 -> алерт');
  eq(alerting.evaluate({ load: 9, ts: T0 + WINDOW - 1 }).length, 0, 't=WINDOW-1 -> подавлен');
  eq(alerting.evaluate({ load: 9, ts: T0 + WINDOW }).length, 1, 't=WINDOW -> алерт снова');
});

test('dedup: force=true игнорирует окно', () => {
  alerting.resetSnapshotState();
  alerting.configure({ cpu: 85 });
  eq(alerting.evaluate({ cpu: 99, ts: T0 }).length, 1, 'обычный -> 1');
  eq(alerting.evaluate({ cpu: 99, ts: T0 + 1 }, { force: true }).length, 1, 'force -> 1');
  eq(alerting.evaluate({ cpu: 99, ts: T0 + 2 }, { force: true }).length, 1, 'force -> 1');
  eq(alerting.history().length, 3, 'history == 3 (3 срабатывания)');
});

test('dedup: разные threshold не глушат друг друга', () => {
  alerting.resetSnapshotState();
  alerting.configure({ cpu: 85, ram: 90, load: 4, disk: 85 });
  const first = alerting.evaluate({ cpu: 100, ram: 95, load: 9, disk: 95, ts: T0 });
  eq(first.length, 4, 'первый evaluate -> 4 алерта');

  const second = alerting.evaluate({ cpu: 100, ram: 95, load: 9, disk: 95, ts: T0 + 1_000 });
  eq(second.length, 0, 'все 4 метрики подавлены');

  // CPU-окно истекает раньше остальных.
  const third = alerting.evaluate({ cpu: 100, ram: 95, load: 9, disk: 95, ts: T0 + WINDOW });
  eq(third.length, 4, 'по истечении окна все 4 снова срабатывают');
});

test('dedup: resetSnapshotState() сбрасывает окно', () => {
  alerting.resetSnapshotState();
  alerting.configure({ cpu: 85 });
  eq(alerting.evaluate({ cpu: 100, ts: T0 }).length, 1, 'первый -> 1');
  eq(alerting.evaluate({ cpu: 100, ts: T0 + 1 }).length, 0, 'повтор -> 0');
  alerting.resetSnapshotState();
  eq(alerting.history().length, 0, 'history очищен');
  eq(alerting.evaluate({ cpu: 100, ts: T0 + 2 }).length, 1, 'после reset -> снова 1');
});

test('dedup: health-пайплайн дважды -> алерты не дублируются', () => {
  seedThreeAgents(T0);
  const p1 = runPipeline(T0);
  eq(p1.alerts.length, 2, 'первый pipeline -> 2 алерта');

  // Тот же snapshot здоровья (T0), но повторный evaluate через 1s — dedup.
  const snap2 = toAlertSnapshot(checkAll({ now: T0 }), T0 + SEC);
  const alerts2 = alerting.evaluate(snap2);
  eq(alerts2.length, 0, 'повтор того же snapshot -> 0 новых алертов');
  eq(alerting.history().length, 2, 'history == 2 (без дублей)');
});

/* ========================================================================= *
 * 7. Согласованность: health snapshot <-> metrics snapshot
 * ========================================================================= */

test('согласованность health <-> collector', () => {
  seedThreeAgents(T0);
  alerting.resetSnapshotState();
  const { healthReport, collector } = runPipeline(T0);

  const okAgg = collector.get('agent.health.ok', '10m');
  const staleAgg = collector.get('agent.health.stale', '10m');
  const deadAgg = collector.get('agent.health.dead', '10m');
  const totalAgg = collector.get('agent.health.total', '10m');

  eq(okAgg.sum, healthReport.alive, 'ok sum == health.alive');
  eq(staleAgg.sum, healthReport.stale, 'stale sum == health.stale');
  eq(deadAgg.sum, healthReport.dead, 'dead sum == health.dead');
  eq(totalAgg.sum, healthReport.total, 'total sum == health.total');
  eq(okAgg.sum + staleAgg.sum + deadAgg.sum, totalAgg.sum, 'сумма статусов == total');
  eq(healthReport.total, listAgents().length, 'health.total == размер реестра');
});

test('согласованность: per-agent возраст в collector', () => {
  seedThreeAgents(T0);
  const { collector, healthReport } = runPipeline(T0);
  const byId = Object.create(null);
  for (const a of healthReport.agents) byId[a.id] = a;

  for (const id of [AGENT_OK, AGENT_STALE, AGENT_DEAD]) {
    const agg = collector.get('agent.heartbeat.age_ms', '10m', { tag: { agent: id } });
    ok(agg !== null, `есть серия age для ${id}`);
    eq(agg.count, 1, `${id}: count == 1`);
    eq(agg.avg, byId[id].heartbeatAgeMs, `${id}: avg == heartbeatAgeMs`);
    eq(agg.min, byId[id].heartbeatAgeMs, `${id}: min == heartbeatAgeMs`);
    eq(agg.max, byId[id].heartbeatAgeMs, `${id}: max == heartbeatAgeMs`);
    eq(agg.tags.status, byId[id].status, `${id}: tag status согласован`);
  }
});

/* ========================================================================= *
 * 8. Полный сценарий «3 агента -> snapshot -> alert()»
 * ========================================================================= */

test('полный сценарий: артефакты и выход пайплайна', () => {
  seedThreeAgents(T0);
  const p = runPipeline(T0);

  ok(p.healthReport && typeof p.healthReport === 'object', 'healthReport — объект');
  ok(p.collector && typeof p.collector.query === 'function', 'collector — объект');
  ok(p.metricsSnapshot && Array.isArray(p.metricsSnapshot.series), 'metricsSnapshot.series — массив');
  ok(p.alertSnapshot && typeof p.alertSnapshot === 'object', 'alertSnapshot — объект');
  ok(Array.isArray(p.alerts), 'alerts — массив');
  eq(p.alerts.length, 2, 'итог: 2 алерта');
  eq(p.healthReport.total, 3, 'итог: 3 агента');
  eq(p.healthReport.byStatus.OK, 1, 'итог: 1 OK');
  eq(p.healthReport.byStatus.STALE, 1, 'итог: 1 STALE');
  eq(p.healthReport.byStatus.DEAD, 1, 'итог: 1 DEAD');
  eq(p.metricsSnapshot.series.length, 7, 'итог: 7 серий метрик');

  const levels = p.alerts.map((a) => a.level);
  for (const l of levels) eq(l, 'warn', `alert level ${l} == warn`);
  const ids = p.alerts.map((a) => a.metric).sort();
  deep(ids, ['cpu', 'ram'], 'сработали cpu и ram');
});

test('стабильность: повторный seed даёт идентичный результат', () => {
  seedThreeAgents(T0);
  const a = runPipeline(T0);
  const b = runPipeline(T0); // тот же snapshot — dedup, но health/metrics идентичны
  eq(a.healthReport.total, b.healthReport.total, 'total идентичен');
  eq(a.healthReport.alive, b.healthReport.alive, 'alive идентичен');
  eq(a.healthReport.stale, b.healthReport.stale, 'stale идентичен');
  eq(a.healthReport.dead, b.healthReport.dead, 'dead идентичен');
  deep(a.alertSnapshot, b.alertSnapshot, 'alertSnapshot идентичен');
  eq(a.metricsSnapshot.series.length, b.metricsSnapshot.series.length, 'число серий идентично');
  eq(b.alerts.length, 0, 'второй прогон без новых алертов (dedup)');
});

/* ========================================================================= *
 * Итог
 * ========================================================================= */

const REQUIRED = 150;

if (testsFailed === 0 && assertCount >= REQUIRED) {
  process.stdout.write(`\nPASS: ${assertCount}/${REQUIRED} (tests: ${testsPassed})\n`);
  process.exitCode = 0;
} else {
  process.stdout.write(
    `\nFAIL: ${assertCount}/${REQUIRED} (tests passed: ${testsPassed}, failed: ${testsFailed})\n`,
  );
  process.exitCode = 1;
}
