'use strict';

/**
 * observability/metrics_rollup.standalone.test.js
 * ===========================================================================
 * STANDALONE-проверка модуля агрегации метрик за окно:
 *   observability/metrics_rollup.js  ->  rollup(samples, window_sec, agg)
 *
 * Жёсткие критерии приёмки, которые здесь проверяются:
 *   1. ≥ 35 assert'ов (фактически больше).
 *   2. Корректный p95 на 100 точках: percentile([1..100], 95) === 95.05
 *      (и то же число через aggregate(..., 'p95') и через rollup()).
 *   3. Поддержка окон 60 / 300 / 900 секунд (группировка + значения).
 *   4. Результат экспортирует toJSON() и JSON-сериализуем.
 *   5. ПУСТОЙ вход НЕ бросает исключение ([] / null / мусор) — count=0,
 *      value=null, buckets=[].
 *
 * Тест самодостаточен: только `assert` + тестируемый модуль. Запуск:
 *   node observability/metrics_rollup.standalone.test.js
 */

const assert = require('assert');
const mr = require('./metrics_rollup');

const { rollup, rollupAll, aggregate, percentile, normalizeAgg, normalizeSamples } = mr;

/* ------------------------------------------------------------------ *
 * Счётчик assert'ов — каждое утверждение проходит через хелперы,
 * поэтому итоговое число точное и проверяемое.
 * ------------------------------------------------------------------ */

let ASSERTIONS = 0;
function ok(cond, msg) { ASSERTIONS += 1; assert.ok(cond, msg); }
function eq(a, b, msg) { ASSERTIONS += 1; assert.strictEqual(a, b, msg); }
function deep(a, b, msg) { ASSERTIONS += 1; assert.deepStrictEqual(a, b, msg); }
function near(a, b, msg, eps) {
  ASSERTIONS += 1;
  assert.ok(Math.abs(a - b) <= (eps === undefined ? 1e-9 : eps), (msg || '') + ' expected~' + b + ' got ' + a);
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
 * Фикстуры
 * ------------------------------------------------------------------ */

// 1..100 — «сто точек», на которых проверяется p95.
const P100 = [];
for (let i = 1; i <= 100; i += 1) P100.push(i);

// 900 точек: t = 0..899 c, value = 1..900. Ровно ложится в окна 60/300/900.
const S900 = [];
for (let i = 0; i < 900; i += 1) S900.push({ t: i, value: i + 1 });

/* ================================================================== *
 * A. API-поверхность
 * ================================================================== */
eq(typeof rollup, 'function', 'rollup exported');
eq(typeof rollupAll, 'function', 'rollupAll exported');
eq(typeof aggregate, 'function', 'aggregate exported');
eq(typeof percentile, 'function', 'percentile exported');
eq(typeof mr.RollupResult, 'function', 'RollupResult exported');
ok(Array.isArray(mr.WINDOWS), 'WINDOWS is array');
ok(mr.WINDOWS.indexOf(60) >= 0, 'WINDOWS has 60');
ok(mr.WINDOWS.indexOf(300) >= 0, 'WINDOWS has 300');
ok(mr.WINDOWS.indexOf(900) >= 0, 'WINDOWS has 900');
deep(mr.AGGS.slice().sort(), ['avg', 'max', 'min', 'p95'], 'AGGS = avg/max/min/p95');

/* ================================================================== *
 * B. p95 на 100 точках — ГЛАВНЫЙ КРИТЕРИЙ
 * ================================================================== */
near(percentile(P100, 95), 95.05, 'percentile([1..100],95)');
eq(Math.round(percentile(P100, 95) * 100) / 100, 95.05, 'p95(100) rounds to 95.05');
near(aggregate(P100, 'p95'), 95.05, 'aggregate([1..100],p95)');
near(percentile([1, 2, 3, 4], 95), 3.85, 'p95 of 4 points = 3.85');
eq(percentile([1], 95), 1, 'p95 of single point');
eq(percentile([], 95), null, 'p95 of empty = null');
eq(percentile([5, 5, 5, 5], 95), 5, 'p95 of constant series');

// p95 через rollup: все 100 точек в одном 60-секундном окне.
const r100 = rollup(P100, 60, 'p95');
eq(r100.count, 100, 'rollup count = 100');
near(r100.value, 95.05, 'rollup(P100,60,p95).value');
eq(r100.buckets.length, 2, 'P100 spans 2 buckets of 60s (t=1..100c)');
eq(r100.buckets[0].count, 59, 'P100 bucket0 = 59 (t=1..59c)');
eq(r100.buckets[1].count, 41, 'P100 bucket1 = 41 (t=60..100c)');

/* ================================================================== *
 * C. ПУСТОЙ ВХОД / мусор — НЕ бросает (критерий)
 * ================================================================== */
noThrow(() => rollup([], 60, 'avg'), 'rollup([],60,avg) no throw');
const empty = rollup([], 60, 'avg');
eq(empty.count, 0, 'empty.count = 0');
eq(empty.value, null, 'empty.value = null');
deep(empty.buckets, [], 'empty.buckets = []');
eq(empty.toJSON().count, 0, 'empty toJSON count 0');

noThrow(() => rollup(null, 60, 'p95'), 'rollup(null) no throw');
eq(rollup(null, 60, 'p95').value, null, 'null input -> null value');
noThrow(() => rollup(undefined, 300, 'max'), 'rollup(undefined) no throw');
eq(rollup(undefined, 300, 'max').count, 0, 'undefined input -> count 0');
noThrow(() => rollup([null, undefined, NaN, {}, [null]], 900, 'min'), 'garbage input no throw');
eq(rollup([null, undefined, NaN, {}, [null]], 900, 'min').count, 0, 'garbage -> count 0');
noThrow(() => rollupAll([], 900), 'rollupAll([]) no throw');
const emptyAll = rollupAll([], 900).value;
deep(emptyAll, { avg: null, max: null, min: null, p95: null }, 'empty all -> all nulls');

/* ================================================================== *
 * D. Базовые агрегаты avg / max / min
 * ================================================================== */
eq(aggregate([1, 2, 3, 4], 'avg'), 2.5, 'avg 1..4');
eq(aggregate([1, 2, 3, 4], 'max'), 4, 'max 1..4');
eq(aggregate([1, 2, 3, 4], 'min'), 1, 'min 1..4');
eq(aggregate([], 'avg'), null, 'avg of empty = null');
eq(aggregate([-3, -1, -2], 'max'), -1, 'max of negatives');
eq(aggregate([-3, -1, -2], 'min'), -3, 'min of negatives');
eq(normalizeAgg('MEAN'), 'avg', 'alias MEAN -> avg');
eq(normalizeAgg('P95'), 'p95', 'uppercase P95');
eq(normalizeAgg('pct95'), 'p95', 'alias pct95');
eq(normalizeAgg('maximum'), 'max', 'alias maximum');
throws(() => rollup([1], 60, 'bogus'), TypeError, 'unknown agg throws TypeError');

/* ================================================================== *
 * E. Окна 60 / 300 / 900
 * ================================================================== */
const w60 = rollup(S900, 60, 'avg');
const w300 = rollup(S900, 300, 'avg');
const w900 = rollup(S900, 900, 'avg');

eq(w60.window_sec, 60, 'w60 window_sec');
eq(w300.window_sec, 300, 'w300 window_sec');
eq(w900.window_sec, 900, 'w900 window_sec');

eq(w60.buckets.length, 15, 'window 60 -> 15 buckets');
eq(w300.buckets.length, 3, 'window 300 -> 3 buckets');
eq(w900.buckets.length, 1, 'window 900 -> 1 bucket');

// Границы окна: t=60 попадает в СЛЕДУЮЩЕЕ окно (start=60000).
eq(w60.buckets[0].count, 60, 'w60 bucket0 [0,60) has 60 samples (t=0..59)');
eq(w60.buckets[0].start, 0, 'w60 bucket0 start = 0');
eq(w60.buckets[0].end, 60000, 'w60 bucket0 end = 60000');
eq(w60.buckets[1].start, 60000, 'w60 bucket1 start = 60000 (boundary)');
eq(w60.buckets[1].count, 60, 'w60 bucket1 has 60 samples');
eq(w60.buckets[w60.buckets.length - 1].count, 60, 'w60 last bucket has 60 samples');

near(w60.buckets[0].value, 30.5, 'w60 bucket0 avg = 30.5');
near(w300.buckets[0].value, 150.5, 'w300 bucket0 avg = 150.5');
near(w300.buckets[1].value, 450.5, 'w300 bucket1 avg = 450.5');
near(w300.buckets[2].value, 750.5, 'w300 bucket2 avg = 750.5');
near(w900.value, 450.5, 'w900 overall avg = 450.5');

// Сумма count по окнам = числу валидных samples.
const total60 = w60.buckets.reduce((s, b) => s + b.count, 0);
eq(total60, 900, 'w60 counts sum to 900');
eq(w300.buckets.reduce((s, b) => s + b.count, 0), 900, 'w300 counts sum to 900');
eq(w900.buckets[0].count, 900, 'w900 single bucket has 900');

// окно 900 ровно покрывает диапазон
eq(w900.from, 0, 'w900 from = first ts (0ms)');
eq(w900.to, 899000, 'w900 to = last ts (899000ms)');

// p95 для окна 900 на значениях 1..900 = 855.05
near(rollup(S900, 900, 'p95').value, 855.05, 'p95 over 1..900 = 855.05');

// max/min по окну 300
near(rollup(S900, 300, 'max').buckets[0].value, 300, 'w300 bucket0 max = 300');
near(rollup(S900, 300, 'min').buckets[0].value, 1, 'w300 bucket0 min = 1');

/* ================================================================== *
 * F. Форматы samples
 * ================================================================== */
const objT = rollup([{ t: 1000, value: 10 }, { t: 2000, value: 20 }], 60, 'max');
eq(objT.count, 2, 'object {t,value} parsed');
eq(objT.value, 20, 'object {t,value} max');

eq(rollup([{ ts: 1, v: 7 }], 60, 'max').value, 7, 'object {ts,v} parsed');
eq(rollup([{ timestamp: 1, val: 8 }], 60, 'max').value, 8, 'object {timestamp,val} parsed');
eq(rollup([[1, 9]], 60, 'max').value, 9, 'tuple [t,v] parsed');
eq(rollup([9], 60, 'max').value, 9, 'bare number parsed');
eq(rollup(['5'], 60, 'max').value, 5, 'numeric string coerced');
eq(rollup([new Date(60000), 3], 60, 'max').value, 3, 'Date timestamp accepted');

// мусор отбрасывается, валидные остаются
const mixed = rollup([{ t: 1, value: 1 }, null, { t: 2, value: 'x' }, { t: 3, value: 3 }], 60, 'avg');
eq(mixed.count, 2, 'mixed: invalid dropped -> count 2');
eq(mixed.value, 2, 'mixed avg of 1 and 3 = 2');

// ms-таймстампы не умножаются повторно (>=1e11)
const msSample = rollup([{ t: 1700000000000, value: 1 }], 60, 'max');
eq(msSample.from, 1700000000000, 'ms timestamp kept as-is');
eq(msSample.buckets.length, 1, 'ms timestamp one bucket');

// сортировка: несортированный вход группируется правильно
const unsorted = rollup([{ t: 90, value: 9 }, { t: 10, value: 1 }, { t: 30, value: 3 }], 60, 'avg');
eq(unsorted.from, 10000, 'unsorted: from = min ts');
eq(unsorted.to, 90000, 'unsorted: to = max ts');
eq(unsorted.buckets.length, 2, 'unsorted: 2 windows (10/30 in [0,60), 90 in [60,120))');

eq(normalizeSamples(null).length, 0, 'normalizeSamples(null) = []');
eq(normalizeSamples([1, null, 2]).length, 2, 'normalizeSamples filters null');

/* ================================================================== *
 * G. toJSON() + сериализация (критерий)
 * ================================================================== */
const r = rollup(S900, 300, 'all');
eq(typeof r.toJSON, 'function', 'result.toJSON is function');
const json = r.toJSON();
eq(json.window_sec, 300, 'toJSON window_sec');
eq(json.count, 900, 'toJSON count');
deep(json.agg, ['avg', 'max', 'min', 'p95'], 'toJSON agg list for all');
eq(json.buckets.length, 3, 'toJSON buckets length');
eq(typeof json.buckets[0].value.avg, 'number', 'bucket value.avg numeric');
eq(json.buckets[0].value.max, 300, 'bucket value.max = 300');
near(json.value.avg, 450.5, 'toJSON overall avg');
near(json.value.p95, 855.05, 'toJSON overall p95');

const roundTrip = JSON.parse(JSON.stringify(r));
eq(roundTrip.window_sec, 300, 'JSON.stringify round-trip window_sec');
eq(roundTrip.count, 900, 'JSON.stringify round-trip count');
near(roundTrip.value.p95, 855.05, 'JSON.stringify round-trip p95');

eq(r.size(), 3, 'RollupResult.size() = 3');
near(r.get(0).avg, 150.5, 'RollupResult.get(0).avg = 150.5');
eq(r.get(999999), null, 'get(unknown) = null');

const single = rollup(P100, 60, 'avg');
eq(typeof single.value, 'number', 'single-agg value is scalar');
eq(single.agg, 'avg', 'single-agg name stored');

const multi = rollup(P100, 60, ['avg', 'max', 'min', 'p95']);
eq(multi.value.avg, 50.5, 'array agg avg = 50.5');
eq(multi.value.max, 100, 'array agg max = 100');
eq(multi.value.min, 1, 'array agg min = 1');
near(multi.value.p95, 95.05, 'array agg p95 = 95.05');

/* ================================================================== *
 * H. Невалидное окно
 * ================================================================== */
throws(() => rollup(S900, 0, 'avg'), RangeError, 'window 0 throws RangeError');
throws(() => rollup(S900, -5, 'avg'), RangeError, 'negative window throws');
throws(() => rollup(S900, 'abc', 'avg'), RangeError, 'non-numeric window throws');

/* ================================================================== *
 * I. Самоконтроль критерия ≥ 35 assert
 * ================================================================== */
ok(ASSERTIONS >= 35, 'at least 35 assertions (actual=' + ASSERTIONS + ')');

console.log('metrics_rollup standalone: ' + ASSERTIONS + ' assertions passed');
console.log('p95([1..100]) = ' + percentile(P100, 95));
console.log('STANDALONE_OK');
