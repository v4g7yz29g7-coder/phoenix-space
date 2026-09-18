'use strict';

/**
 * Тесты для evolution/fitness_normalize.js
 * Запуск: node evolution/fitness_normalize.test.js
 */

const assert = require('assert');
const { normalize, normalizeWithStats } = require('./fitness_normalize');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('fitness_normalize tests');

// --- Главный критерий -------------------------------------------------------
check('критерий: max -> 1.0, два минимума -> ~0', () => {
  const out = normalize([6.1252, 5.8684, 5.8484]);
  assert.strictEqual(out.length, 3);
  assert.strictEqual(out[0], 1.0, 'max должен быть ровно 1.0');
  assert.ok(out[1] < 0.1, 'среднее значение близко к 0, получено ' + out[1]);
  assert.strictEqual(out[2], 0, 'min должен быть ровно 0');
});

check('порядок значений сохраняется', () => {
  const out = normalize([1, 2, 3, 4, 5]);
  for (let i = 1; i < out.length; i += 1) assert.ok(out[i] >= out[i - 1]);
  assert.strictEqual(out[0], 0);
  assert.strictEqual(out[4], 1);
});

// --- NaN / inf --------------------------------------------------------------
check('NaN-элемент -> -1', () => {
  const out = normalize([10, NaN, 20, 30]);
  assert.strictEqual(out[1], -1);
  assert.strictEqual(out[2], 0.5);
  assert.strictEqual(out[3], 1);
  assert.strictEqual(out[0], 0);
});

check('скаляр NaN -> -1', () => {
  assert.strictEqual(normalize(NaN), -1);
});

check('+Infinity -> 1, -Infinity -> 0', () => {
  const out = normalize([5, Infinity, -Infinity, 10]);
  assert.strictEqual(out[1], 1);
  assert.strictEqual(out[2], 0);
});

check('только невалидные значения не ломают функцию', () => {
  const out = normalize([NaN, NaN]);
  assert.deepStrictEqual(out, [-1, -1]);
});

// --- Краевые случаи ---------------------------------------------------------
check('пустой массив -> []', () => {
  assert.deepStrictEqual(normalize([]), []);
});

check('не-массив (null/undefined) -> -1', () => {
  assert.strictEqual(normalize(null), -1);
  assert.strictEqual(normalize(undefined), -1);
});

check('все значения равны -> 0 (вырожденная популяция)', () => {
  assert.deepStrictEqual(normalize([7, 7, 7]), [0, 0, 0]);
});

check('значения всегда в [0,1] или -1 (маркер)', () => {
  const out = normalize([-1000, 0, 1000]);
  for (const v of out) assert.ok(v === -1 || (v >= 0 && v <= 1), 'out-of-range: ' + v);
});

check('строки-числа парсятся', () => {
  const out = normalize(['1', '2', '3']);
  assert.strictEqual(out[0], 0);
  assert.strictEqual(out[2], 1);
});

// --- Stats ------------------------------------------------------------------
check('normalizeWithStats возвращает min/max/range', () => {
  const s = normalizeWithStats([6.1252, 5.8684, 5.8484]);
  assert.strictEqual(s.count, 3);
  assert.strictEqual(s.valid, 3);
  assert.ok(Math.abs(s.max - 6.1252) < 1e-9);
  assert.ok(Math.abs(s.min - 5.8484) < 1e-9);
  assert.ok(s.range > 0);
});

check('normalizeWithStats на пустом входе', () => {
  const s = normalizeWithStats([]);
  assert.deepStrictEqual(s.values, []);
  assert.strictEqual(s.min, null);
  assert.strictEqual(s.max, null);
  assert.strictEqual(s.range, null);
});

console.log('\n' + passed + ' tests passed ✅');
