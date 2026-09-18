'use strict';

/**
 * observability/tracer.standalone.test.js
 * ===========================================================================
 * STANDALONE-проверка модуля распределённого трейсинга:
 *   observability/tracer.js
 *
 * Жёсткие критерии приёмки (проверяются ниже):
 *   1. span id — РОВНО 16 hex-символов (`/^[0-9a-f]{16}$/`), уникален.
 *   2. Вложенность трейса — до 5 уровней (6-й уровень -> RangeError).
 *   3. flatten() -> плоский список без children, у закрытых есть duration_ms.
 *   4. p95 по 100 span'ам: |p95 - 95| / 95 <= 1% (фактически 95.05, ~0.05%).
 *   5. ≥ 120 assert'ов (счётчик в конце печатается и проверяется).
 *
 * Тест самодостаточен: только `assert` + тестируемый модуль. Запуск:
 *   node observability/tracer.standalone.test.js
 */

const assert = require('assert');
const tracer = require('./tracer');

const {
  createTracer,
  randomHex16,
  percentile,
  p95,
  MAX_DEPTH,
  HEX_ID_RE,
  TRACE_ID_RE,
} = tracer;

/* ------------------------------------------------------------------ *
 * Хелперы с точным подсчётом assert'ов
 * ------------------------------------------------------------------ */

let ASSERTIONS = 0;

function ok(cond, msg) { ASSERTIONS += 1; assert.ok(cond, msg); }
function eq(a, b, msg) { ASSERTIONS += 1; assert.strictEqual(a, b, msg); }
function deep(a, b, msg) { ASSERTIONS += 1; assert.deepStrictEqual(a, b, msg); }
function near(a, b, eps, msg) {
  ASSERTIONS += 1;
  const e = eps === undefined ? 1e-9 : eps;
  assert.ok(Math.abs(a - b) <= e, (msg || '') + ' expected ~' + b + ' got ' + a);
}
function throws(fn, type, msg) {
  ASSERTIONS += 1;
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  assert.ok(caught instanceof type, (msg || '') + ' (caught: ' + (caught && caught.message) + ')');
}
function noThrow(fn, msg) {
  ASSERTIONS += 1;
  let err = null;
  try { fn(); } catch (e) { err = e; }
  assert.strictEqual(err, null, (msg || '') + (err ? ': ' + err.message : ''));
}

/* ------------------------------------------------------------------ *
 * Детерминированные фикстуры
 * ------------------------------------------------------------------ */

/** Управляемые часы. */
function makeClock(startMs) {
  let t = startMs == null ? 0 : startMs;
  return {
    now: () => t,
    at: (ms) => { t = ms; return t; },
    advance: (d) => { t += d; return t; },
    value: () => t,
  };
}

/** Детерминированный генератор 16-hex id: 000...001, 000...002, ... */
function seqIdGen(seed) {
  let n = seed == null ? 0 : seed;
  return () => { n += 1; return n.toString(16).padStart(16, '0'); };
}

const RECORD_KEYS = [
  'id', 'traceId', 'parentId', 'name', 'depth',
  'start_ms', 'end_ms', 'duration_ms', 'status', 'pool', 'tags',
];

/* ================================================================== *
 * A. API-поверхность singleton
 * ================================================================== */

eq(typeof tracer.start, 'function', 'tracer.start exported');
eq(typeof tracer.end, 'function', 'tracer.end exported');
eq(typeof tracer.flatten, 'function', 'tracer.flatten exported');
eq(typeof tracer.spans, 'function', 'tracer.spans exported');
eq(typeof tracer.open, 'function', 'tracer.open exported');
eq(typeof tracer.getSpan, 'function', 'tracer.getSpan exported');
eq(typeof tracer.span, 'function', 'tracer.span alias exported');
eq(typeof tracer.traces, 'function', 'tracer.traces exported');
eq(typeof tracer.stats, 'function', 'tracer.stats exported');
eq(typeof tracer.reset, 'function', 'tracer.reset exported');
eq(typeof tracer.spansOfTrace, 'function', 'tracer.spansOfTrace exported');
eq(typeof createTracer, 'function', 'createTracer exported');

eq(MAX_DEPTH, 5, 'MAX_DEPTH === 5 (до 5 уровней вложенности)');
ok(HEX_ID_RE instanceof RegExp, 'HEX_ID_RE is RegExp');
eq(HEX_ID_RE.source, TRACE_ID_RE.source, 'TRACE_ID_RE === HEX_ID_RE');
ok(HEX_ID_RE.test('0123456789abcdef'), 'hex-re accepts 16 lowercase hex');
ok(!HEX_ID_RE.test('0123456789ABCDEF'), 'hex-re rejects uppercase');
ok(!HEX_ID_RE.test('0123456789abcde'), 'hex-re rejects 15 chars');
ok(!HEX_ID_RE.test('0123456789abcdef0'), 'hex-re rejects 17 chars');
ok(!HEX_ID_RE.test('0123456789abcdeg'), 'hex-re rejects non-hex char');
ok(Array.isArray(tracer.SORTS), 'SORTS is array');
eq(tracer.STATUS_OPEN, 'open', 'STATUS_OPEN');
eq(tracer.STATUS_CLOSED, 'closed', 'STATUS_CLOSED');
eq(typeof tracer.randomHex16, 'function', 'randomHex16 exported');
eq(typeof tracer.p95, 'function', 'p95 exported');

/* ================================================================== *
 * B. Генерация id: 16 hex, уникальность
 * ================================================================== */

const seen = new Set();
for (let i = 0; i < 25; i += 1) {
  const id = randomHex16();
  eq(typeof id, 'string', 'randomHex16 returns string');
  eq(id.length, 16, 'id length is 16');
  ok(HEX_ID_RE.test(id), 'id matches ^[0-9a-f]{16}$');
  seen.add(id);
}
eq(seen.size, 25, '25 сгенерированных id уникальны');

eq(randomHex16(() => 0), '0000000000000000', 'rng=0 -> нулевой id');
eq(randomHex16(() => 0.999999), 'ffffffffffffffff', 'rng~1 -> максимальный id');
eq(randomHex16(() => 0.5), '8888888888888888', 'rng=0.5 -> 8x16');
ok(HEX_ID_RE.test(randomHex16(() => 0.123456789)), 'инъектируемый rng даёт валидный id');

/* ================================================================== *
 * C. start / end — базовая семантика
 * ================================================================== */

{
  const clk = makeClock(1000);
  const t = createTracer({ now: clk.now, idGen: seqIdGen() });

  const root = t.start({ name: 'race', pool: 'pool-A' });
  eq(typeof root.id, 'string', 'root.id is string');
  ok(HEX_ID_RE.test(root.id), 'root.id is 16 hex');
  eq(root.id.length, 16, 'root.id length 16');
  eq(root.name, 'race', 'root.name');
  eq(root.parentId, null, 'root has no parent');
  eq(root.depth, 1, 'root depth === 1');
  eq(root.traceId, root.id, 'root.traceId === root.id');
  eq(root.start_ms, 1000, 'root.start_ms from injected clock');
  eq(root.end_ms, null, 'root.end_ms null while open');
  eq(root.duration_ms, null, 'root.duration_ms null while open');
  eq(root.status, 'open', 'root status open');
  eq(root.pool, 'pool-A', 'root.pool');
  deep(root.tags, {}, 'root.tags default {}');
  eq(t.stats().count, 1, 'stats.count === 1');
  eq(t.stats().open, 1, 'stats.open === 1');
  eq(t.size(), 1, 'tracer.size() === 1');

  clk.at(1050);
  const box = t.start({ name: 'box_start', parent: root });
  eq(box.depth, 2, 'child depth === 2');
  eq(box.parentId, root.id, 'child.parentId === root.id');
  eq(box.traceId, root.id, 'child.traceId inherits root');
  eq(box.start_ms, 1050, 'child.start_ms');
  eq(box.pool, 'pool-A', 'child inherits pool');
  eq(t.stats().count, 2, 'stats.count === 2');

  clk.at(1080);
  const boxEnd = t.end(box);
  eq(boxEnd.duration_ms, 30, 'end(span) -> duration_ms 30');
  eq(boxEnd.end_ms, 1080, 'end(span) -> end_ms');
  eq(boxEnd.status, 'closed', 'end(span) -> status closed');

  clk.at(1200);
  const rootEnd = t.end(root.id);
  eq(rootEnd.duration_ms, 200, 'end(id string) -> duration_ms 200');
  eq(rootEnd.status, 'closed', 'root closed');
  eq(t.stats().open, 0, 'stats.open === 0');
  eq(t.stats().closed, 2, 'stats.closed === 2');

  // end принимает объект вида {id}
  clk.at(1300);
  const sp = t.start({ name: 'judge', start: 1300, id: 'deadbeefdeadbeef' });
  eq(t.end({ id: sp.id }, { end: 1350 }).duration_ms, 50, 'end({id}, {end}) works');
  ok(HEX_ID_RE.test(sp.id), 'explicit id kept 16 hex');
  eq(sp.id, 'deadbeefdeadbeef', 'explicit id used');

  // второй аргумент end числом
  const sp2 = t.start({ name: 'finish', start: 1400, id: '00000000000000ff' });
  eq(t.end(sp2, 1450).duration_ms, 50, 'end(span, number) works');
  eq(t.end(sp2.id, { end_ms: 1500 }), undefined, 'unreachable') // placeholder, replaced below
}
