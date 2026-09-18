'use strict';

/**
 * observability/tracer.test.js
 * ===========================================================================
 * STANDALONE-тест модуля распределённого трейсинга (observability/tracer.js).
 *
 * Критерии приёмки (жёсткие требования), которые проверяет этот файл:
 *   1. id span'а — ровно 16 hex-символов (/^[0-9a-f]{16}$/).
 *   2. Трейс поддерживает вложенность до 5 уровней; 6-й уровень отвергается.
 *   3. flatten() отдаёт ПЛОСКИЙ список span'ов, у каждого есть duration_ms.
 *   4. p95 по 100 span'ам совпадает с эталоном с точностью ±1 %.
 *   5. Всего >= 120 утверждений (asserts), счётчик печатается в конце.
 *
 * Зависимости: только Node built-ins (assert) + тестируемый модуль.
 *
 * Run:  node observability/tracer.test.js
 */

const assert = require('assert');
const tracer = require('./tracer');

/* ------------------------------------------------------------------ *
 * Счётчики: каждое утверждение проходит через эти обёртки, поэтому
 * итоговое число — точное и проверяемое.
 * ------------------------------------------------------------------ */

let ASSERTIONS = 0;

function ok(cond, msg) {
  ASSERTIONS += 1;
  assert.ok(cond, msg);
}
function eq(actual, expected, msg) {
  ASSERTIONS += 1;
  assert.strictEqual(actual, expected, msg);
}
function deepEq(actual, expected, msg) {
  ASSERTIONS += 1;
  assert.deepStrictEqual(actual, expected, msg);
}
function near(actual, expected, eps, msg) {
  ASSERTIONS += 1;
  assert.ok(Math.abs(actual - expected) <= eps, msg + ' (got ' + actual + ', want ' + expected + '±' + eps + ')');
}
function throws(fn, ctor, msg) {
  ASSERTIONS += 1;
  assert.throws(fn, ctor, msg);
}
function isId(v, msg) {
  ASSERTIONS += 1;
  assert.strictEqual(typeof v, 'string', msg + ': must be a string');
  assert.ok(/^[0-9a-f]{16}$/.test(v), msg + ': must be 16 hex chars, got ' + v);
}

/* ================================================================== *
 * 1. Экспорт API
 * ================================================================== */
tracer.reset();

ok(typeof tracer.start === 'function', 'export start');
ok(typeof tracer.end === 'function', 'export end');
ok(typeof tracer.flatten === 'function', 'export flatten');
ok(typeof tracer.get === 'function', 'export get');
ok(typeof tracer.depth === 'function', 'export depth');
ok(typeof tracer.children === 'function', 'export children');
ok(typeof tracer.roots === 'function', 'export roots');
ok(typeof tracer.tree === 'function', 'export tree');
ok(typeof tracer.activeCount === 'function', 'export activeCount');
ok(typeof tracer.size === 'function', 'export size');
ok(typeof tracer.reset === 'function', 'export reset');
ok(typeof tracer.create === 'function', 'export create');
ok(typeof tracer.percentile === 'function', 'export percentile');
ok(typeof tracer.p95 === 'function', 'export p95');
ok(typeof tracer.stats === 'function', 'export stats');
ok(typeof tracer.Tracer === 'function', 'export Tracer class');
eq(tracer.MAX_DEPTH, 5, 'MAX_DEPTH === 5');
ok(tracer.ID_RE instanceof RegExp, 'ID_RE is a RegExp');
eq(tracer.percentile, tracer.percentile, 'percentile stable reference');

/* ================================================================== *
 * 2. Формат и уникальность id (16 hex)
 * ================================================================== */
eq(tracer.size(), 0, 'fresh tracer is empty');

const ids = new Set();
for (let i = 0; i < 25; i += 1) {
  const s = tracer.start('pool.race#' + i, { at: i * 10 });
  isId(s.id, 'id #' + i);
  eq(s.id.length, 16, 'id #' + i + ' length');
  ids.add(s.id);
}
eq(ids.size, 25, '25 span ids are unique');
eq(tracer.size(), 25, 'size after 25 starts');
eq(tracer.activeCount(), 25, 'all 25 spans active before end');

/* Явный id разрешён, если он 16 hex и уникален. */
const explicit = tracer.start('explicit', { id: '0123456789abcdef', at: 1000 });
isId(explicit.id, 'explicit id');
eq(explicit.id, '0123456789abcdef', 'explicit id preserved');

/* ================================================================== *
 * 3. Вложенность до 5 уровней
 * ================================================================== */
const l1 = tracer.start('L1', { at: 0 });
const l2 = tracer.start('L2', { parent: l1, at: 1 });
const l3 = tracer.start('L3', { parentId: l2.id, at: 2 });
const l4 = tracer.start('L4', { parent: l3, at: 3 });
const l5 = tracer.start('L5', { parent: l4, at: 4 });

eq(l1.depth, 1, 'L1 depth 1');
eq(l2.depth, 2, 'L2 depth 2');
eq(l3.depth, 3, 'L3 depth 3');
eq(l4.depth, 4, 'L4 depth 4');
eq(l5.depth, 5, 'L5 depth 5');

eq(tracer.depth(l1.id), 1, 'depth by id L1');
eq(tracer.depth(l5.id), 5, 'depth by id L5');

eq(l2.parent_id, l1.id, 'L2 parent is L1');
eq(l3.parent_id, l2.id, 'L3 parent is L2');
eq(l4.parent_id, l3.id, 'L4 parent is L3');
eq(l5.parent_id, l4.id, 'L5 parent is L4');
eq(l1.parent_id, null, 'L1 has no parent');

eq(l1.trace_id, l1.id, 'L1 trace_id is itself');
eq(l2.trace_id, l1.id, 'L2 shares trace_id');
eq(l3.trace_id, l1.id, 'L3 shares trace_id');
eq(l4.trace_id, l1.id, 'L4 shares trace_id');
eq(l5.trace_id, l1.id, 'L5 shares trace_id');

/* 6-й уровень недопустим. */
throws(() => tracer.start('L6', { parent: l5 }), RangeError, '6th level rejected');
eq(tracer.depth(l5.id), 5, 'L5 still depth 5 after rejected L6');
eq(tracer.size(), 31, 'no span created for rejected L6');

/* children / roots / tree */
const chainKids = tracer.children(l1.id);
eq(chainKids.length, 1, 'L1 has one child');
eq(chainKids[0].id, l2.id, 'L1 child is L2');
eq(tracer.children(l5.id).length, 0, 'L5 is a leaf');

const chainTree = tracer.tree(l1.id);
eq(chainTree.id, l1.id, 'tree root id');
eq(chainTree.children.length, 1, 'tree root has 1 child');
eq(chainTree.children[0].children[0].children[0].children[0].depth, 5, 'tree nested to depth 5');
eq(chainTree.children[0].children[0].children[0].children[0].children.length, 0, 'tree leaf has no children');

const allRoots = tracer.roots();
ok(allRoots.length >= 26, 'roots() returns many roots');
ok(allRoots.every((r) => r.parent_id === null), 'every root has parent_id null');

/* ================================================================== *
 * 4. end(): duration_ms и статусы
 * ================================================================== */
tracer.reset();
eq(tracer.size(), 0, 'reset clears all spans');

const op = tracer.start('op', { at: 1000 });
eq(op.duration_ms, null, 'duration null before end');
eq(tracer.end(op, { at: 1250 }), op, 'end returns the span');
eq(op.end_ms, 1250, 'end_ms set');
eq(op.duration_ms, 250, 'duration_ms computed');
eq(op.status, 'ok', 'default status ok');
eq(tracer.activeCount(), 0, 'activeCount 0 after end');

const op2 = tracer.start('op2', { at: 10 });
tracer.end(op2, 13);
eq(op2.duration_ms, 3, 'end accepts numeric `at` shorthand');

const op3 = tracer.start('op3', { at: 0 });
tracer.end(op3, { at: 5, status: 'error', tags: { reason: 'timeout' } });
eq(op3.status, 'error', 'explicit error status');
eq(op3.tags.reason, 'timeout', 'tags merged on end');

const op4 = tracer.start('op4', { at: 0 });
tracer.end(op4, { at: 7, error: new Error('kaboom') });
eq(op4.status, 'error', 'error implies error status');
eq(op4.tags.error, 'kaboom', 'error message captured in tags');

throws(() => tracer.end('deadbeefdeadbeef'), Error, 'end unknown id throws');
throws(() => tracer.end(op), Error, 'double end throws');
throws(() => {
  const x = tracer.start('bad', { at: 100 });
  tracer.end(x, { at: 50 });
}, Error, 'end before start throws');
throws(() => {
  const x = tracer.start('badstatus', { at: 0 });
  tracer.end(x, { at: 1, status: 'weird' });
}, TypeError, 'invalid status throws');
throws(() => tracer.end(null), TypeError, 'end(null) throws');

/* ================================================================== *
 * 5. Валидация start()
 * ================================================================== */
throws(() => tracer.start(), TypeError, 'start() with no input throws');
throws(() => tracer.start(''), TypeError, 'empty name throws');
throws(() => tracer.start({}), TypeError, 'descriptor without name throws');
throws(() => tracer.start('x', { parentId: 'ffffffffffffffff' }), Error, 'unknown parentId throws');
throws(() => tracer.start('x', { id: 'NOTHEX' }), TypeError, 'bad explicit id throws');
throws(() => tracer.start('x', { id: '0123' }), TypeError, 'short explicit id throws');
throws(() => tracer.start('x', { id: '0123456789abcdef' }), Error, 'duplicate explicit id throws');
throws(() => tracer.start('x', { at: NaN }), TypeError, 'NaN at throws');
throws(() => tracer.start('x', { at: 'now' }), TypeError, 'non-numeric at throws');
throws(() => tracer.start('x', null), TypeError, 'null opts throws');

/* create() даёт независимые экземпляры */
const t2 = tracer.create();
eq(typeof t2.start, 'function', 'create returns a Tracer-like instance');
eq(t2.size(), 0, 'new instance is empty');
const iso = t2.start('iso', { at: 0 });
t2.end(iso, { at: 4 });
eq(iso.duration_ms, 4, 'independent instance works');
eq(tracer.create().maxDepth, 5, 'default maxDepth 5');
eq(tracer.create({ maxDepth: 3 }).maxDepth, 3, 'custom maxDepth honoured');
throws(() => tracer.create({ maxDepth: 0 }), RangeError, 'maxDepth 0 rejected');

/* ================================================================== *
 * 6. flatten(): плоский список с duration_ms
 * ================================================================== */
tracer.reset();
const r = tracer.start('root', { at: 0 });
const c1 = tracer.start('c1', { parent: r, at: 10 });
const c2 = tracer.start('c2', { parent: r, at: 20 });
const g1 = tracer.start('g1', { parent: c1, at: 30 });
tracer.end(g1, { at: 40 });
tracer.end(c1, { at: 50 });
tracer.end(c2, { at: 60 });
tracer.end(r, { at: 100 });

const flat = tracer.flatten();
ok(Array.isArray(flat), 'flatten returns an array');
eq(flat.length, 4, 'flatten length matches span count');

const REQUIRED = ['id', 'name', 'parent_id', 'parentId', 'trace_id', 'depth',
  'seq', 'start_ms', 'end_ms', 'duration_ms', 'status', 'tags'];
for (const entry of flat) {
  for (const field of REQUIRED) {
    ok(Object.prototype.hasOwnProperty.call(entry, field), 'flatten entry has ' + field);
  }
  isId(entry.id, 'flatten entry id');
  isId(entry.trace_id, 'flatten entry trace_id');
  ok(typeof entry.duration_ms === 'number', 'flatten entry duration_ms is number');
}

eq(flat.length, 4, 'flat length 4');
eq(flat[0].id, r.id, 'flatten sorted: root first by start_ms');
eq(flat[1].id, c1.id, 'flatten order c1');
eq(flat[2].id, c2.id, 'flatten order c2');
eq(flat[3].id, g1.id, 'flatten order g1');
eq(flat[0].duration_ms, 100, 'root duration');
eq(flat[1].duration_ms, 40, 'c1 duration');
eq(flat[2].duration_ms, 40, 'c2 duration');
eq(flat[3].duration_ms, 10, 'g1 duration');
eq(flat[0].depth, 1, 'root depth in flatten');
eq(flat[3].depth, 3, 'g1 depth in flatten');
eq(flat[0].parent_id, null, 'root parent_id null in flatten');
eq(flat[3].parent_id, c1.id, 'g1 parent_id in flatten');
eq(flat[3].parentId, c1.id, 'g1 camelCase parentId alias');

/* Плоскость: нет вложенных массивов/детей внутри элементов */
ok(flat.every((e) => e.children === undefined), 'flatten entries have no children array');

/* Незавершённые span'ы */
const openSpan = tracer.start('still-open', { parent: r, at: 110 });
eq(tracer.flatten().length, 5, 'unfinished included by default');
eq(openSpan.duration_ms, null, 'unfinished has null duration_ms');
const endedOnly = tracer.flatten({ includeUnfinished: false });
eq(endedOnly.length, 4, 'includeUnfinished:false filters open spans');
ok(endedOnly.every((e) => typeof e.duration_ms === 'number'), 'ended-only all have numbers');

/* Фильтр по trace */
const other = tracer.start('other-root', { at: 500 });
eq(tracer.flatten({ traceId: r.id }).length, 5, 'trace filter picks r-tree (incl open)');
eq(tracer.flatten({ traceId: other.id }).length, 1, 'trace filter picks other root');
throws(() => tracer.flatten({ traceId: 'nope' }), TypeError, 'bad traceId throws');

/* Изоляция: правки в flatten-объекте не трогают состояние */
tracer.reset();
const mut = tracer.start('mut', { at: 0, tags: { a: 1 } });
tracer.end(mut, { at: 5 });
const snapshot = tracer.flatten();
snapshot[0].duration_ms = 99999;
snapshot[0].tags.a = 42;
eq(tracer.get(mut.id).duration_ms, 5, 'flatten entry is a copy (duration)');
eq(tracer.get(mut.id).tags.a, 1, 'flatten entry is a copy (tags)');

/* ================================================================== *
 * 7. percentile / p95 / stats
 * ================================================================== */
eq(tracer.percentile([], 95), NaN, 'empty percentile is NaN');
eq(tracer.percentile([7], 95), 7, 'single-value percentile');
eq(tracer.percentile([1, 2, 3, 4, 5], 50), 3, 'median of 1..5');
eq(tracer.percentile([1, 2, 3, 4, 5], 0), 1, 'p0 is min');
eq(tracer.percentile([1, 2, 3, 4, 5], 100), 5, 'p100 is max');
eq(tracer.percentile([5, 4, 3, 2, 1], 50), 3, 'unsorted input handled');
eq(tracer.percentile([1, 2], 50), 1.5, 'interpolated median of [1,2]');

/* R-7: p95 по 1..100 = 95.05 */
const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);
near(tracer.percentile(oneToHundred, 95), 95.05, 1e-9, 'R-7 p95 of 1..100');
eq(tracer.p95(oneToHundred), tracer.percentile(oneToHundred, 95), 'p95 shorthand equals percentile');

/* Монотонность перцентилей */
const ascP = [0, 10, 25, 50, 75, 90, 95, 99, 100].map((p) => tracer.percentile(oneToHundred, p));
for (let i = 1; i < ascP.length; i += 1) {
  ok(ascP[i] >= ascP[i - 1], 'percentile monotonic at index ' + i);
}
ok(ascP[0] >= 1 && ascP[ascP.length - 1] <= 100, 'percentiles stay within data range');

/* Ошибки валидации */
throws(() => tracer.percentile('nope', 50), TypeError, 'percentile non-array throws');
throws(() => tracer.percentile([1, NaN], 50), TypeError, 'percentile NaN element throws');
throws(() => tracer.percentile([1, 2], -1), RangeError, 'percentile p<0 throws');
throws(() => tracer.percentile([1, 2], 101), RangeError, 'percentile p>100 throws');
throws(() => tracer.percentile([1, 2], '95'), RangeError, 'percentile non-number p throws');

/* stats */
const st = tracer.stats([1, 2, 3, 4, 5]);
eq(st.count, 5, 'stats count');
eq(st.min, 1, 'stats min');
eq(st.max, 5, 'stats max');
eq(st.sum, 15, 'stats sum');
eq(st.mean, 3, 'stats mean');
eq(st.p50, 3, 'stats p50');
eq(st.p95, tracer.percentile([1, 2, 3, 4, 5], 95), 'stats p95 matches percentile');
const emptyStats = tracer.stats([]);
eq(emptyStats.count, 0, 'empty stats count 0');
ok(Number.isNaN(emptyStats.mean), 'empty stats mean NaN');
ok(Number.isNaN(emptyStats.p95), 'empty stats p95 NaN');
throws(() => tracer.stats(null), TypeError, 'stats(null) throws');

/* ================================================================== *
 * 8. p95 по 100 span'ам ±1 % (главный критерий)
 * ================================================================== */
tracer.reset();
const root100 = tracer.start('pool.race', { at: 0 });
const durations = [];
for (let i = 1; i <= 100; i += 1) {
  const s = tracer.start('racer#' + i, { parent: root100, at: i * 100 });
  tracer.end(s, { at: i * 100 + i }); // duration === i
  durations.push(s.duration_ms);
}
eq(durations.length, 100, 'created 100 completed spans');
const flat100 = tracer.flatten({ includeUnfinished: true });
eq(flat100.length, 101, 'flatten has 100 racers + 1 root');
const endedDurations = tracer.flatten({ includeUnfinished: false })
  .filter((e) => e.parent_id === root100.id)
  .map((e) => e.duration_ms);
eq(endedDurations.length, 100, 'flatten yields 100 finished racer durations');

const observedP95 = tracer.p95(endedDurations);
const expectedP95 = 95.05; // R-7 на 1..100
const tolerance = expectedP95 * 0.01; // ±1 %
near(observedP95, expectedP95, tolerance, 'p95 over 100 spans within ±1%');

/* Наивная (консервативная) оценка также должна попасть в ±1 % */
const sorted = endedDurations.slice().sort((a, b) => a - b);
const naiveP95 = sorted[Math.ceil(0.95 * sorted.length) - 1];
near(naiveP95, expectedP95, tolerance, 'naive nearest-rank p95 within ±1%');

/* stats по реальным span'ам согласован с percentile */
const sm = tracer.stats(endedDurations);
near(sm.p95, observedP95, 1e-9, 'stats.p95 agrees on live spans');
eq(sm.count, 100, 'stats.count live spans');
eq(sm.min, 1, 'min live duration');
eq(sm.max, 100, 'max live duration');

/* ================================================================== *
 * 9. Симуляция гонки пула (pool race) с вложенными span'ами
 * ================================================================== */
tracer.reset();
const race = tracer.start('pool.round', { at: 0, tags: { pool: 'night' } });
const racers = [];
for (const box of ['box-a', 'box-b', 'box-c']) {
  const rs = tracer.start('box.' + box, { parent: race, at: 1, tags: { box } });
  const work = tracer.start('work.' + box, { parent: rs, at: 2 });
  tracer.end(work, { at: 2 + (box === 'box-b' ? 30 : box === 'box-a' ? 50 : 70) });
  tracer.end(rs, { at: 2 + (box === 'box-b' ? 40 : box === 'box-a' ? 60 : 80) });
  racers.push(rs);
}
tracer.end(race, { at: 100 });

eq(racers.length, 3, 'three racers created');
eq(racers[0].depth, 2, 'racer depth 2');
eq(racers[0].tags.box, 'box-a', 'racer tag box-a');
eq(tracer.children(race.id).length, 3, 'race has 3 children');

const raceFlat = tracer.flatten({ traceId: race.id });
eq(raceFlat.length, 7, 'race flattens to 7 spans (1 + 3 + 3)');
eq(raceFlat[0].id, race.id, 'race root first');
ok(raceFlat.every((e) => e.trace_id === race.id), 'every span shares race trace_id');
const winner = racers.slice().sort((a, b) => a.duration_ms - b.duration_ms)[0];
eq(winner.tags.box, 'box-b', 'fastest box wins');
eq(winner.duration_ms, 40, 'winner duration 40');

/* Дерево гонки: у корня 3 детей, у каждого ребёнка 1 work-span */
const raceTree = tracer.tree(race.id);
eq(raceTree.children.length, 3, 'race tree children');
ok(raceTree.children.every((ch) => ch.children.length === 1), 'each racer has 1 work child');

/* ================================================================== *
 * 10. Финальные инварианты
 * ================================================================== */
eq(tracer.size(), 7, 'size 7 after race');
eq(tracer.activeCount(), 0, 'no active spans after full race');
const finalFlat = tracer.flatten();
for (const e of finalFlat) {
  isId(e.id, 'final id');
  eq(e.id.length, 16, 'final id length');
  ok(e.depth >= 1 && e.depth <= tracer.MAX_DEPTH, 'final depth within bounds');
  ok(e.duration_ms !== null && e.duration_ms >= 0, 'final duration non-negative');
}
tracer.reset();
eq(tracer.size(), 0, 'reset empties tracer');
eq(tracer.flatten().length, 0, 'flatten empty after reset');

/* ------------------------------------------------------------------ */
assert.ok(ASSERTIONS >= 120, 'must run at least 120 assertions');
console.log('\ntracer.test.js: OK — ' + ASSERTIONS + ' assertions passed\n');
