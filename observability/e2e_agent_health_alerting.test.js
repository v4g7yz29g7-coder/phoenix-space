'use strict';

/**
 * observability/e2e_agent_health_alerting.test.js
 * ===========================================================================
 * END-TO-END тест связки:  agent_health  ->  metrics_collector  ->  alerting
 * ---------------------------------------------------------------------------
 * Сценарий:
 *   1. Heartbeat-регистр 3 агентов (OK / STALE / DEAD) при TTL = 30s.
 *      Границы:  age 29.9s -> OK,  30.1s -> STALE,  61s -> DEAD.
 *   2. Снимок (snapshot) регистра прогоняется через metrics_collector
 *      (collect + query/get) — метрики здоровья сохраняются и читаются назад.
 *   3. Из прочитанных метрик собирается alert-snapshot и прогоняется через
 *      alerting.evaluate() — проверяется генерация алертов.
 *
 * Жёсткие критерии приёмки:
 *   [1] >= 150 assert'ов (счётчик ASSERTIONS в конце отчёта);
 *   [2] покрыты статусы OK / STALE / DEAD на границах TTL 30s
 *       (29.9 OK / 30.1 STALE / 61 DEAD);
 *   [3] de-dup 10 минут: двойной evaluate одного и того же threshold -> 1 алерт;
 *   [4] пустой регистр не бросает исключений (не throws) на всех трёх стыках.
 *
 * Запуск:  node observability/e2e_agent_health_alerting.test.js
 */

const assert = require('assert');

// --- стык 1: health ---
const health = require('./agent_health');
// --- стык 2: metrics ---
const metrics = require('./metrics_collector');
// --- стык 3: alerting ---
const alerting = require('./alerting');

/* ------------------------------------------------------------------ *
 * Счётчики и помощники assert
 * ------------------------------------------------------------------ */

let ASSERTIONS = 0;
let CASES = 0;

function ok(cond, msg) {
  ASSERTIONS += 1;
  assert.ok(cond, msg);
}
function eq(actual, expected, msg) {
  ASSERTIONS += 1;
  assert.strictEqual(actual, expected, msg);
}
function neq(actual, expected, msg) {
  ASSERTIONS += 1;
  assert.notStrictEqual(actual, expected, msg);
}
function deep(actual, expected, msg) {
  ASSERTIONS += 1;
  assert.deepStrictEqual(actual, expected, msg);
}
function throws(fn, msg) {
  ASSERTIONS += 1;
  assert.throws(fn, msg);
}
function notThrows(fn, msg) {
  ASSERTIONS += 1;
  assert.doesNotThrow(fn, msg);
}
function approx(actual, expected, eps, msg) {
  ASSERTIONS += 1;
  assert.ok(
    typeof actual === 'number' && Math.abs(actual - expected) <= eps,
    `${msg || 'approx'}: ${actual} !~= ${expected} (eps=${eps})`
  );
}

function testCase(name, fn) {
  fn();
  CASES += 1;
  process.stdout.write('  \u2713 ' + name + '\n');
}

process.stdout.write('observability/e2e_agent_health_alerting.test.js\n');
process.stdout.write(
  '  связка: agent_health -> metrics_collector -> alerting\n'
);

/* ------------------------------------------------------------------ *
 * Константы сценария
 * ------------------------------------------------------------------ */

const TTL_MS = 30 * 1000; // 30 секунд
const SEC = 1000;
const MIN = 60 * SEC;
const STALE_BOUNDARY_MS = 2 * TTL_MS; // 60s
const DEDUP_WINDOW = 10 * MIN; // 600 000 ms + de-dup окно alerting
const T0 = Date.parse('2024-06-01T00:00:00.000Z');
const EPS = 1e-6;

/* ------------------------------------------------------------------ *
 * Мост: health-snapshot -> alert-snapshot (cpu/ram/disk/load)
 * ------------------------------------------------------------------ */

/**
 * Прочитать агрегированное значение метрики из metrics_collector.
 * @returns {number|null}
 */
function readMetric(collector, name) {
  const agg = collector.get(name, 60 * MIN);
  return agg ? agg.sum : null;
}

/**
 * Прогнать полный конвейер для заданного момента времени.
 *
 * Зависит от уже наполненного heartbeat-регистра.
 * @param {number} now epoch ms
 * @returns {{health:object, collector:object, metrics:object, snapshot:object}}
 */
function runPipeline(now) {
  // Стык 1: снимок здоровья агентов.
  const snap = health.checkAll({ now });

  // Стык 2: метрики кладутся в коллектор и читаются назад.
  const collector = metrics.createCollector({ clock: () => now });
  collector.collect('agent_health.total', snap.total);
  collector.collect('agent_health.alive', snap.alive);
  collector.collect('agent_health.stale', snap.stale);
  collector.collect('agent_health.dead', snap.dead);

  const readBack = {
    total: readMetric(collector, 'agent_health.total'),
    alive: readMetric(collector, 'agent_health.alive'),
    stale: readMetric(collector, 'agent_health.stale'),
    dead: readMetric(collector, 'agent_health.dead'),
  };

  // Стык 3: alert-snapshot для evaluate().
  const total = readBack.total || 0;
  const pct = (n) => (total > 0 ? (n / total) * 100 : 0);
  const snapshot = {
    cpu: pct(readBack.dead), // доля мёртвых, %
    ram: pct(readBack.stale), // доля протухших, %
    disk: pct(readBack.dead + readBack.stale), // доля нездоровых, %
    load: readBack.dead, // абсолютное число мёртвых
    ts: now,
  };

  return { health: snap, collector, metrics: readBack, snapshot };
}

/** Заполнить heartbeat-регистр тремя агентами с заданными возрастами. */
function seedThree(now, ages) {
  health.clearRegistry();
  health.registerAgent({ id: 'agent_ok', ttlMs: TTL_MS, lastHeartbeat: now - ages.ok });
  health.registerAgent({ id: 'agent_stale', ttlMs: TTL_MS, lastHeartbeat: now - ages.stale });
  health.registerAgent({ id: 'agent_dead', ttlMs: TTL_MS, lastHeartbeat: now - ages.dead });
  return health.listAgents();
}

/* ================================================================== *
 * A. API-поверхность всех трёх стыков
 * ================================================================== */

testCase('A. Экспорт всех трёх модулей связки доступен', function () {
  // Стык 1 — agent_health / heartbeat-регистр.
  eq(typeof health.registerAgent, 'function', 'health.registerAgent');
  eq(typeof health.heartbeat, 'function', 'health.heartbeat');
  eq(typeof health.check, 'function', 'health.check');
  eq(typeof health.checkAll, 'function', 'health.checkAll');
  eq(typeof health.statusOf, 'function', 'health.statusOf');
  eq(typeof health.clearRegistry, 'function', 'health.clearRegistry');
  eq(health.DEFAULT_TTL_MS, TTL_MS, 'TTL по умолчанию = 30000');
  // Статусы.
  eq(health.STATUS.OK, 'OK', 'STATUS.OK');
  eq(health.STATUS.STALE, 'STALE', 'STATUS.STALE');
  eq(health.STATUS.DEAD, 'DEAD', 'STATUS.DEAD');

  // Стык 2 — metrics_collector.
  eq(typeof metrics.createCollector, 'function', 'metrics.createCollector');
  eq(typeof metrics.collect, 'function', 'metrics.collect');
  eq(typeof metrics.query, 'function', 'metrics.query');
  eq(typeof metrics.MetricsCollector, 'function', 'metrics.MetricsCollector');

  // Стык 3 — alerting.
  eq(typeof alerting.evaluate, 'function', 'alerting.evaluate');
  eq(typeof alerting.configure, 'function', 'alerting.configure');
  eq(typeof alerting.clear, 'function', 'alerting.clear');
  eq(typeof alerting.history, 'function', 'alerting.history');
  eq(typeof alerting.active, 'function', 'alerting.active');
  eq(alerting.SNAPSHOT_DEDUP_WINDOW_MS, DEDUP_WINDOW, 'dedup окно = 10 минут');
});

/* ================================================================== *
 * B. Стык 1 — heartbeat-регистр 3 агентов, границы TTL 30s
 * ================================================================== */

testCase('B. Регистр 3 агентов: 29.9s OK / 30.1s STALE / 61s DEAD', function () {
  const now = T0;
  seedThree(now, { ok: 29.9 * SEC, stale: 30.1 * SEC, dead: 61 * SEC });

  // Три агента зарегистрированы.
  eq(health.listAgents().length, 3, '3 агента в регистре');
  ok(health.getAgent('agent_ok') !== null, 'agent_ok найден');
  ok(health.getAgent('agent_stale') !== null, 'agent_stale найден');
  ok(health.getAgent('agent_dead') !== null, 'agent_dead найден');
  eq(health.getAgent('agent_ok').ttlMs, TTL_MS, 'agent_ok.ttlMs = 30000');

  // Границы статусов КРИТИЧЕСКОГО критерия.
  eq(health.statusOf('agent_ok', now), 'OK', '29.9s -> OK');
  eq(health.statusOf('agent_stale', now), 'STALE', '30.1s -> STALE');
  eq(health.statusOf('agent_dead', now), 'DEAD', '61s -> DEAD');

  // Агрегат.
  const snap = health.check(now);
  eq(snap.alive, 1, 'check.alive = 1');
  eq(snap.stale, 1, 'check.stale = 1');
  eq(snap.dead, 1, 'check.dead = 1');
  eq(snap.total, 3, 'check.total = 3');
  eq(snap.byStatus.OK, 1, 'byStatus.OK = 1');
  eq(snap.byStatus.STALE, 1, 'byStatus.STALE = 1');
  eq(snap.byStatus.DEAD, 1, 'byStatus.DEAD = 1');
  eq(snap.generatedAt, '2024-06-01T00:00:00.000Z', 'generatedAt корректна');

  // Детальный снимок checkAll.
  const detail = health.checkAll({ now });
  eq(detail.total, 3, 'checkAll.total = 3');
  eq(detail.agents.length, 3, 'checkAll.agents.length = 3');
  eq(detail.alive, 1, 'checkAll.alive = 1');
  eq(detail.stale, 1, 'checkAll.stale = 1');
  eq(detail.dead, 1, 'checkAll.dead = 1');

  const byId = {};
  for (const a of detail.agents) byId[a.id] = a;
  eq(byId.agent_ok.status, 'OK', 'detail agent_ok = OK');
  eq(byId.agent_stale.status, 'STALE', 'detail agent_stale = STALE');
  eq(byId.agent_dead.status, 'DEAD', 'detail agent_dead = DEAD');
  eq(byId.agent_ok.heartbeatAgeMs, 29.9 * SEC, 'age agent_ok = 29900ms');
  eq(byId.agent_stale.heartbeatAgeMs, 30.1 * SEC, 'age agent_stale = 30100ms');
  eq(byId.agent_dead.heartbeatAgeMs, 61 * SEC, 'age agent_dead = 61000ms');
});

testCase('B2. Классификация на всех границах TTL (данные-driven)', function () {
  const table = [
    [0, 'OK'],
    [1, 'OK'],
    [29 * SEC, 'OK'],
    [29.9 * SEC, 'OK'],
    [29999, 'OK'],
    [TTL_MS, 'STALE'], // ровно 30.0s -> STALE (age < ttl строго)
    [30001, 'STALE'],
    [30.1 * SEC, 'STALE'],
    [45 * SEC, 'STALE'],
    [59999, 'STALE'],
    [STALE_BOUNDARY_MS, 'DEAD'], // ровно 60s -> DEAD
    [60001, 'DEAD'],
    [61 * SEC, 'DEAD'],
    [120 * SEC, 'DEAD'],
  ];
  for (const [ageMs, expected] of table) {
    health.clearRegistry();
    health.registerAgent({ id: 'x', ttlMs: TTL_MS, lastHeartbeat: T0 - ageMs });
    eq(health.statusOf('x', T0), expected, `age=${ageMs}ms -> ${expected}`);
  }
  // Будущий heartbeat (age < 0) трактуется как живой.
  health.clearRegistry();
  health.registerAgent({ id: 'future', ttlMs: TTL_MS, lastHeartbeat: T0 + 5000 });
  eq(health.statusOf('future', T0), 'OK', 'будущий heartbeat -> OK');
});

testCase('B3. heartbeat() продлевает TTL и переводит DEAD -> OK', function () {
  health.clearRegistry();
  health.registerAgent({ id: 'revive', ttlMs: TTL_MS, lastHeartbeat: T0 - 120 * SEC });
  eq(health.statusOf('revive', T0), 'DEAD', 'до beat -> DEAD');
  const rec = health.heartbeat('revive', { at: T0 - 1000 });
  ok(rec !== null, 'heartbeat вернул запись');
  eq(rec.lastHeartbeat, T0 - 1000, 'lastHeartbeat обновлён');
  eq(health.statusOf('revive', T0), 'OK', 'после beat -> OK');
  // heartbeat по неизвестному id -> null, без исключений.
  eq(health.heartbeat('nope', { at: T0 }), null, 'heartbeat(unknown) = null');
});

/* ================================================================== *
 * C. Стык 2 — metrics_collector: запись и чтение метрик здоровья
 * ================================================================== */

testCase('C. metrics_collector сохраняет и агрегирует метрики здоровья', function () {
  const collector = metrics.createCollector({ clock: () => T0 });

  // Запись значений снимка.
  eq(collector.collect('agent_health.total', 3), true, 'collect total');
  eq(collector.collect('agent_health.alive', 1), true, 'collect alive');
  eq(collector.collect('agent_health.stale', 1), true, 'collect stale');
  eq(collector.collect('agent_health.dead', 1), true, 'collect dead');

  // Отклонение мусора.
  eq(collector.collect('agent_health.dead', 'abc'), false, 'reject нечисло');
  eq(collector.collect('', 1), false, 'reject пустое имя');
  eq(collector.collect(null, 1), false, 'reject null имя');

  // Чтение агрегатов.
  const dead = collector.get('agent_health.dead', 60 * MIN);
  ok(dead !== null, 'aggregate dead найден');
  eq(dead.count, 1, 'count = 1');
  eq(dead.sum, 1, 'sum = 1');
  eq(dead.avg, 1, 'avg = 1');
  eq(dead.min, 1, 'min = 1');
  eq(dead.max, 1, 'max = 1');

  // Несколько сэмплов -> sum/avg.
  const c2 = metrics.createCollector({ clock: () => T0 });
  c2.collect('agent_health.dead', 2);
  c2.collect('agent_health.dead', 4);
  const agg2 = c2.get('agent_health.dead', 60 * MIN);
  eq(agg2.count, 2, 'count = 2');
  eq(agg2.sum, 6, 'sum = 6');
  eq(agg2.avg, 3, 'avg = 3');
  eq(agg2.min, 2, 'min = 2');
  eq(agg2.max, 4, 'max = 4');

  // Имена метрик и счётчики.
  eq(collector.names().includes('agent_health.total'), true, 'names содержит total');
  eq(collector.names().length, 4, '4 серии метрик');
  eq(collector.health().collected, 4, 'collected = 4');
  eq(collector.health().rejected, 3, 'rejected = 3');

  // query отдаёт серии.
  const q = collector.query(60 * MIN);
  eq(q.series.length, 4, 'query вернул 4 серии');
  eq(q.total, 4, 'query total = 4');
});

/* ================================================================== *
 * D. Стык 3 — alerting.evaluate(): генерация алертов из метрик здоровья
 * ================================================================== */

testCase('D. Все агенты DEAD -> evaluate() генерирует алерты cpu/disk', function () {
  const now = T0;
  seedThree(now, { ok: 120 * SEC, stale: 130 * SEC, dead: 61 * SEC });
  // Все три мертвы.
  eq(health.check(now).dead, 3, 'все три DEAD');

  const { snapshot, metrics: m } = runPipeline(now);
  eq(m.total, 3, 'metrics.total = 3');
  eq(m.dead, 3, 'metrics.dead = 3');
  eq(m.alive, 0, 'metrics.alive = 0');
  eq(snapshot.cpu, 100, 'snapshot.cpu = 100%');
  eq(snapshot.ram, 0, 'snapshot.ram = 0%');
  eq(snapshot.disk, 100, 'snapshot.disk = 100%');
  eq(snapshot.load, 3, 'snapshot.load = 3');

  alerting.clear();
  alerting.configure({ cpu: 85, ram: 90, disk: 85, load: 4 });
  const alerts = alerting.evaluate(snapshot, { now });

  eq(alerts.length, 2, 'ровно 2 алерта (cpu, disk)');
  const byMetric = {};
  for (const a of alerts) byMetric[a.metric] = a;
  ok(byMetric.cpu, 'алерт по cpu есть');
  ok(byMetric.disk, 'алерт по disk есть');
  eq(byMetric.cpu.value, 100, 'cpu.value = 100');
  eq(byMetric.cpu.threshold, 85, 'cpu.threshold = 85');
  eq(byMetric.cpu.level, 'warn', 'cpu.level = warn');
  eq(byMetric.cpu.ts, new Date(now).toISOString(), 'cpu.ts = T0 ISO');
  eq(byMetric.disk.value, 100, 'disk.value = 100');
  eq(byMetric.disk.threshold, 85, 'disk.threshold = 85');
  eq(alerting.history().length, 2, 'history = 2');
  eq(alerting.active({ now }).length, 2, 'active = 2');
});

testCase('D2. Смешанный регистр (OK/STALE/DEAD) -> 4 алерта', function () {
  const now = T0;
  seedThree(now, { ok: 29.9 * SEC, stale: 30.1 * SEC, dead: 61 * SEC });

  const { snapshot, health: snap } = runPipeline(now);
  eq(snap.alive, 1, 'alive = 1');
  eq(snap.stale, 1, 'stale = 1');
  eq(snap.dead, 1, 'dead = 1');
  approx(snapshot.cpu, (1 / 3) * 100, EPS, 'cpu ~ 33.33');
  approx(snapshot.ram, (1 / 3) * 100, EPS, 'ram ~ 33.33');
  approx(snapshot.disk, (2 / 3) * 100, EPS, 'disk ~ 66.67');
  eq(snapshot.load, 1, 'load = 1');

  alerting.clear();
  alerting.configure({ cpu: 30, ram: 30, disk: 60, load: 0 });
  const alerts = alerting.evaluate(snapshot, { now });

  eq(alerts.length, 4, '4 алерта (cpu/ram/disk/load)');
  const got = alerts.map((a) => a.metric).sort();
  deep(got, ['cpu', 'disk', 'load', 'ram'], 'набор метрик алертов');
  const byMetric = {};
  for (const a of alerts) byMetric[a.metric] = a;
  approx(byMetric.cpu.value, (1 / 3) * 100, EPS, 'cpu value ~33.33');
  approx(byMetric.ram.value, (1 / 3) * 100, EPS, 'ram value ~33.33');
  approx(byMetric.disk.value, (2 / 3) * 100, EPS, 'disk value ~66.67');
  eq(byMetric.load.value, 1, 'load value = 1');
  eq(byMetric.load.threshold, 0, 'load threshold = 0');
  eq(alerting.history().length, 4, 'history = 4');
});

testCase('D3. Все агенты OK -> evaluate() молчит', function () {
  const now = T0;
  seedThree(now, { ok: 1 * SEC, stale: 2 * SEC, dead: 3 * SEC });

  const { snapshot } = runPipeline(now);
  eq(health.check(now).alive, 3, 'все три OK');
  eq(snapshot.cpu, 0, 'cpu = 0');
  eq(snapshot.ram, 0, 'ram = 0');
  eq(snapshot.disk, 0, 'disk = 0');
  eq(snapshot.load, 0, 'load = 0');

  alerting.clear();
  alerting.configure({ cpu: 85, ram: 90, disk: 85, load: 4 });
  const alerts = alerting.evaluate(snapshot, { now });
  eq(alerts.length, 0, 'нет алертов при здоровом регистре');
  eq(alerting.history().length, 0, 'пустая history');
  eq(alerting.active({ now }).length, 0, 'пустой active');
});

/* ================================================================== *
 * E. De-dup 10 минут — двойной evaluate одного threshold -> 1 алерт
 * ================================================================== */

testCase('E. Двойной evaluate одного threshold -> ровно 1 алерт', function () {
  alerting.clear();
  alerting.configure({ cpu: 50 });
  const snap = { cpu: 100 };

  const first = alerting.evaluate(snap, { now: T0 });
  eq(first.length, 1, 'первый evaluate -> 1 алерт');

  const second = alerting.evaluate(snap, { now: T0 });
  eq(second.length, 0, 'двойной evaluate -> 0 (подавлен)');

  const third = alerting.evaluate(snap, { now: T0 + SEC });
  eq(third.length, 0, 'третий в окне -> 0');

  eq(alerting.history().length, 1, 'history = 1 после дублей');
  eq(alerting.active({ now: T0 }).length, 1, 'active = 1');
});

testCase('E2. Окно 10 минут: 9:59 молчит, 10:01 снова алертит', function () {
  alerting.clear();
  alerting.configure({ cpu: 50 });
  const snap = { cpu: 100 };

  eq(alerting.evaluate(snap, { now: T0 }).length, 1, 'T0 -> 1');
  eq(alerting.evaluate(snap, { now: T0 + 5 * MIN }).length, 0, '5:00 -> 0');
  eq(alerting.evaluate(snap, { now: T0 + 9 * MIN + 59 * SEC }).length, 0, '9:59 -> 0');
  eq(alerting.history().length, 1, 'history всё ещё 1');

  eq(alerting.evaluate(snap, { now: T0 + 10 * MIN + SEC }).length, 1, '10:01 -> 1');
  eq(alerting.history().length, 2, 'history = 2');

  // Точная граница окна (half-open) проверяется на чистом состоянии.
  alerting.clear();
  alerting.configure({ cpu: 50 });
  eq(alerting.evaluate(snap, { now: T0 }).length, 1, 'fresh T0 -> 1');
  eq(alerting.evaluate(snap, { now: T0 + DEDUP_WINDOW - SEC }).length, 0, '599s -> 0');
  eq(alerting.evaluate(snap, { now: T0 + DEDUP_WINDOW }).length, 1, 'ровно 600s -> 1');
  eq(alerting.history().length, 2, 'fresh history = 2');
});

testCase('E3. Разные метрики дедуплицируются независимо', function () {
  alerting.clear();
  alerting.configure({ cpu: 50, ram: 50 });

  const first = alerting.evaluate({ cpu: 100, ram: 100 }, { now: T0 });
  eq(first.length, 2, 'первый -> 2 алерта (cpu+ram)');

  const second = alerting.evaluate({ cpu: 100, ram: 100 }, { now: T0 + MIN });
  eq(second.length, 0, 'в окне -> 0');
  eq(alerting.history().length, 2, 'history = 2');
  eq(alerting.active({ now: T0 + MIN }).length, 2, 'active = 2');
});

testCase('E4. Прогон пайплайна дважды подряд -> 1 алерт на метрику', function () {
  const now = T0;
  seedThree(now, { ok: 120 * SEC, stale: 130 * SEC, dead: 61 * SEC });

  alerting.clear();
  alerting.configure({ cpu: 85, disk: 85, ram: 101, load: 99 });

  const p1 = runPipeline(now);
  const a1 = alerting.evaluate(p1.snapshot, { now });
  eq(a1.length, 2, 'первый пайплайн -> 2 (cpu, disk)');

  const p2 = runPipeline(now + 60 * SEC); // тот же регистр через минуту
  const a2 = alerting.evaluate(p2.snapshot, { now: now + 60 * SEC });
  eq(a2.length, 0, 'второй пайплайн в окне -> 0');
  eq(alerting.history().length, 2, 'в сумме 2 алерта, без спама');
});

testCase('E5. force:true обходит дедупликацию', function () {
  alerting.clear();
  alerting.configure({ cpu: 50 });
  eq(alerting.evaluate({ cpu: 100 }, { now: T0 }).length, 1, 'обычный -> 1');
  eq(alerting.evaluate({ cpu: 100 }, { now: T0 + MIN }).length, 0, 'в окне -> 0');
  eq(alerting.evaluate({ cpu: 100 }, { now: T0 + MIN, force: true }).length, 1, 'force -> 1');
  eq(alerting.history().length, 2, 'history = 2');
});

/* ================================================================== *
 * F. Пустой регистр: ни один стык не бросает исключений
 * ================================================================== */

testCase('F. Пустой регистр не бросает исключений (все 3 стыка)', function () {
  health.clearRegistry();
  eq(health.listAgents().length, 0, 'регистр пуст');

  // Стык 1 — не throws.
  let snap;
  notThrows(() => { snap = health.check(T0); }, 'check() пустого регистра');
  notThrows(() => { health.checkAll({ now: T0 }); }, 'checkAll() пустого регистра');
  eq(snap.alive, 0, 'empty alive = 0');
  eq(snap.stale, 0, 'empty stale = 0');
  eq(snap.dead, 0, 'empty dead = 0');
  eq(snap.total, 0, 'empty total = 0');
  eq(snap.byStatus.OK, 0, 'empty byStatus.OK = 0');
  eq(snap.byStatus.STALE, 0, 'empty byStatus.STALE = 0');
  eq(snap.byStatus.DEAD, 0, 'empty byStatus.DEAD = 0');

  const detail = health.checkAll({ now: T0 });
  eq(detail.total, 0, 'empty checkAll.total = 0');
  eq(detail.agents.length, 0, 'empty checkAll.agents = []');
  eq(health.statusOf('ghost', T0), null, 'statusOf(unknown) = null');
  eq(health.getAgent('ghost'), null, 'getAgent(unknown) = null');

  // Стык 2 — пустой конвейер.
  let pipe;
  notThrows(() => { pipe = runPipeline(T0); }, 'runPipeline() пустого регистра');
  eq(pipe.metrics.total, 0, 'metrics.total = 0');
  eq(pipe.metrics.dead, 0, 'metrics.dead = 0');

  // Стык 3 — evaluate() пустого/нулевого snapshot не throws.
  alerting.clear();
  alerting.configure({ cpu: 85, ram: 90, disk: 85, load: 4 });
  let alerts;
  notThrows(() => { alerts = alerting.evaluate(pipe.snapshot, { now: T0 }); }, 'evaluate(empty snapshot)');
  eq(alerts.length, 0, 'пустой snapshot -> 0 алертов');
  notThrows(() => { alerting.evaluate({}, { now: T0 }); }, 'evaluate({})');
  notThrows(() => { alerting.evaluate(null, null); }, 'evaluate(null, null)');
  notThrows(() => { alerting.evaluate(undefined, undefined); }, 'evaluate(undefined, undefined)');
  notThrows(() => { alerting.evaluate(42, { now: T0 }); }, 'evaluate(42)');
  eq(alerting.history().length, 0, 'history пуста');
});

testCase('F2. metrics_collector переваривает нулевые метрики пустого регистра', function () {
  const collector = metrics.createCollector({ clock: () => T0 });
  eq(collector.collect('agent_health.total', 0), true, 'collect 0 -> true');
  eq(collector.collect('agent_health.dead', 0), true, 'collect dead 0 -> true');
  const agg = collector.get('agent_health.dead', 60 * MIN);
  eq(agg.count, 1, 'count = 1');
  eq(agg.sum, 0, 'sum = 0');
  eq(agg.avg, 0, 'avg = 0');
  eq(agg.min, 0, 'min = 0');
  eq(agg.max, 0, 'max = 0');
  eq(collector.health().rejected, 0, 'rejected = 0');
});

/* ================================================================== *
 * G. Нет спама: множество evaluate внутри окна -> 1 алерт
 * ================================================================== */

testCase('G. 50 evaluate внутри окна -> 1 алерт (нет спама)', function () {
  alerting.clear();
  alerting.configure({ cpu: 50 });
  let total = 0;
  for (let i = 0; i < 50; i += 1) {
    total += alerting.evaluate({ cpu: 99 }, { now: T0 + i * SEC }).length;
  }
  eq(total, 1, 'суммарно 1 алерт за 50 вызовов');
  eq(alerting.history().length, 1, 'history = 1');
});

/* ================================================================== *
 * H. Итоговый E2E-прогон + отчёт
 * ================================================================== */

testCase('H. Полный E2E-прогон возвращает согласованный результат', function () {
  const now = T0;
  // 40s -> STALE, 90s -> DEAD, 200s -> DEAD:  все трое нездоровы.
  seedThree(now, { ok: 40 * SEC, stale: 90 * SEC, dead: 200 * SEC });
  const { health: snap, metrics: m, snapshot } = runPipeline(now);

  // Согласованность трёх стыков.
  eq(snap.total, m.total, 'health.total == metrics.total');
  eq(snap.alive, m.alive, 'health.alive == metrics.alive');
  eq(snap.stale, m.stale, 'health.stale == metrics.stale');
  eq(snap.dead, m.dead, 'health.dead == metrics.dead');
  eq(snap.total, 3, 'total = 3');
  eq(snap.alive, 0, 'alive = 0 (все нездоровы)');
  eq(snap.stale, 1, 'stale = 1');
  eq(snap.dead, 2, 'dead = 2');
  approx(snapshot.cpu, (2 / 3) * 100, EPS, 'cpu ~ 66.67');
  approx(snapshot.disk, 100, EPS, 'все нездоровы -> disk 100');

  alerting.clear();
  alerting.configure({ cpu: 85, ram: 90, disk: 85, load: 4 });
  const alerts = alerting.evaluate(snapshot, { now });
  eq(alerts.length, 1, 'cpu 66.7 < 85 -> нет cpu; нездоровых 100 -> disk');
  eq(alerts[0].metric, 'disk', 'единственный алерт по disk');
  eq(alerts[0].value, 100, 'disk.value = 100');
});

/* ================================================================== *
 * Отчёт
 * ================================================================== */

process.stdout.write(
  `\nobservability/e2e_agent_health_alerting: ${CASES} кейсов, ` +
    `${ASSERTIONS} assert'ов — OK\n`
);

// Жёсткая проверка критерия [1]: >= 150 assert'ов.
if (ASSERTIONS < 150) {
  process.stderr.write(
    `FAIL: ожидалось >= 150 assert'ов, выполнено ${ASSERTIONS}\n`
  );
  process.exitCode = 1;
}
