#!/usr/bin/env node
/**
 * evolution/fitness_normalizer.test.js
 * ============================================================================
 * Smoke-тест для evolution/fitness_normalizer.js.
 *
 * Проверяет КРИТЕРИЙ приёмки задачи «Нормализация fitness метрик»:
 *   - normalize([6.1252, 5.8684, 5.8484]) -> [1.0, ~0, ~0];
 *   - normalize(NaN) -> -1;
 *   - normalize([])  -> [];
 *   - устойчивость к NaN / Infinity внутри популяции;
 *   - `node --check` проходит без синтаксических ошибок.
 *
 * Запуск:
 *   node evolution/fitness_normalizer.test.js
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET = path.join(__dirname, 'fitness_normalizer.js');
const mod = require('./fitness_normalizer');

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`);
  }
}

function approx(a, b, eps = 1e-3) {
  return Math.abs(a - b) <= eps;
}

console.log('evolution/fitness_normalizer.test.js');

/* --- 1. Критерий: max -> 1.0, остальные ~0 -------------------------------- */
{
  const out = mod.normalize([6.1252, 5.8684, 5.8484]);
  ok('возвращает массив той же длины', Array.isArray(out) && out.length === 3);
  ok('максимум нормализуется в 1.0', out[0] === 1.0, `got ${out[0]}`);
  ok('второе значение ~0', out[1] < 0.1, `got ${out[1]}`);
  ok('минимум нормализуется в 0', out[2] === 0, `got ${out[2]}`);
}

/* --- 2. NaN -> -1 --------------------------------------------------------- */
{
  ok('normalize(NaN) === -1', mod.normalize(NaN) === -1);
  ok('normalize(Infinity) === -1', mod.normalize(Infinity) === -1);
  ok('normalize(-Infinity) === -1', mod.normalize(-Infinity) === -1);
  const arr = mod.normalize([1, 2, NaN]);
  ok('NaN внутри массива -> -1', arr[2] === -1, `got ${arr[2]}`);
  ok('NaN не ломает диапазон', arr[0] === 0 && arr[1] === 1, `got ${JSON.stringify(arr)}`);
}

/* --- 3. Пустой массив -> [] ----------------------------------------------- */
{
  const out = mod.normalize([]);
  ok('normalize([]) -> []', Array.isArray(out) && out.length === 0);
}

/* --- 4. Устойчивость к inf / null / строкам ------------------------------- */
{
  const allBad = mod.normalize([NaN, Infinity, null, undefined, '', 'abc']);
  ok('все нефинитные -> все -1', allBad.every((v) => v === -1), JSON.stringify(allBad));

  const mixed = mod.normalize(['1', '2', '3']);
  ok('числовые строки нормализуются', JSON.stringify(mixed) === JSON.stringify([0, 0.5, 1]), JSON.stringify(mixed));
}

/* --- 5. Вырожденные случаи ------------------------------------------------ */
{
  ok('нулевой разброс -> 0 по умолчанию', JSON.stringify(mod.normalize([5, 5, 5])) === '[0,0,0]');
  ok('constantValue переопределяем', JSON.stringify(mod.normalize([5, 5, 5], { constantValue: 1 })) === '[1,1,1]');
  ok('normalizePopulation(NaN) -> [-1]', JSON.stringify(mod.normalizePopulation(NaN)) === '[-1]');
  ok('normalizePopulation([]) -> []', JSON.stringify(mod.normalizePopulation([])) === '[]');
}

/* --- 6. minMax / stats / denormalize -------------------------------------- */
{
  const mm = mod.minMax([1, NaN, 3, Infinity]);
  ok('minMax.min === 1', mm.min === 1);
  ok('minMax.max === 3', mm.max === 3);
  ok('minMax.finite === 2', mm.finite === 2);
  ok('minMax.missing === 2', mm.missing === 2);
  ok('denormalize инвертирует min-max', approx(mod.denormalize(1, 5, 6.1252), 6.1252, 1e-9));
}

/* --- 7. node --check ------------------------------------------------------ */
{
  let syntaxOk = true;
  let detail = '';
  try {
    execFileSync(process.execPath, ['--check', TARGET], { stdio: 'pipe' });
  } catch (err) {
    syntaxOk = false;
    detail = String(err.stderr || err.message);
  }
  ok('node --check проходит', syntaxOk, detail);
  ok('файл существует', fs.existsSync(TARGET));
}

console.log('');
console.log(`  passed: ${passed}, failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
console.log('SMOKE_OK');
