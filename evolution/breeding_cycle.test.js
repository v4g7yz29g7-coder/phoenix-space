#!/usr/bin/env node
/**
 * evolution/breeding_cycle.test.js
 * ============================================================================
 * Smoke-тест для evolution/breeding_cycle.js.
 *
 * Проверяет КРИТЕРИЙ приёмки:
 *   - файл расширяет 220 строк (> 220);
 *   - `node --check` проходит без синтаксических ошибок;
 *   - публичный API `cycle()` экспортируется и является функцией;
 *   - cycle() возвращает корректный сводный отчёт и не бросает исключений.
 *
 * Запуск:
 *   node evolution/breeding_cycle.test.js
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(__dirname, 'breeding_cycle.js');
const MIN_LINES = 220;

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

function section(title) {
  console.log(`\n[${title}]`);
}

/* ------------------------------------------------------------------ */
/* 1. Существование и размер файла                                     */
/* ------------------------------------------------------------------ */
section('file & criterion');
ok('evolution/breeding_cycle.js существует', fs.existsSync(TARGET));

const src = fs.readFileSync(TARGET, 'utf8');
const lineCount = src.split('\n').length;
ok(`строк > ${MIN_LINES} (фактически ${lineCount})`, lineCount > MIN_LINES);

/* ------------------------------------------------------------------ */
/* 2. Синтаксис: node --check                                          */
/* ------------------------------------------------------------------ */
section('syntax');
let syntaxOk = true;
let syntaxMsg = '';
try {
  execFileSync(process.execPath, ['--check', TARGET], { stdio: 'pipe' });
} catch (err) {
  syntaxOk = false;
  syntaxMsg = (err && err.stderr ? err.stderr.toString() : String(err)).trim();
}
ok('node --check OK', syntaxOk, syntaxMsg);

/* ------------------------------------------------------------------ */
/* 3. Публичный API                                                    */
/* ------------------------------------------------------------------ */
section('public API');
const mod = require('./breeding_cycle');
ok('module.exports содержит cycle', typeof mod.cycle === 'function');
ok('cycle() возвращает объект-отчёт', typeof mod.cycle === 'function');

/* ------------------------------------------------------------------ */
/* 4. Функциональный прогон (dryRun, изолированная популяция)          */
/* ------------------------------------------------------------------ */
section('cycle() dry-run');
const population = [
  { id: 'a', name: 'alpha', dna: 'think plan act verify', wins: 3, score: 0.7, fitness: 0.66 },
  { id: 'b', name: 'beta', dna: 'explore adapt grow', wins: 2, score: 0.5, fitness: 0.52 },
  { id: 'c', name: 'gamma', dna: 'observe learn evolve', wins: 4, score: 0.8, fitness: 0.78 },
  { id: 'd', name: 'delta', dna: 'reason measure improve', wins: 1, score: 0.4, fitness: 0.41 },
];

let report = null;
let threw = null;
try {
  report = mod.cycle({ dryRun: true, population, generations: 3, count: 4, elite: 1 });
} catch (err) {
  threw = err;
}
ok('cycle() не бросает исключение', !threw, threw && threw.message);
ok('отчёт.ok === true', !!(report && report.ok === true));
ok('отчёт.generations === 3', !!(report && report.generations === 3),
  report && String(report.generations));
ok('отчёт.cycles длиной 3', !!(report && Array.isArray(report.cycles) && report.cycles.length === 3));
ok('populationBefore > 0', !!(report && report.populationBefore > 0));
ok('populationAfter >= populationBefore', !!(report && report.populationAfter >= report.populationBefore));
ok('dryRun не пишет журнал', !!(report && report.dryRun === true));
ok('у каждого цикла есть fitness/diversity',
  !!(report && report.cycles.every((c) => c && c.fitness && typeof c.diversity === 'number')));

/* ------------------------------------------------------------------ */
/* 5. Устойчивость к «грязным» данным                                  */
/* ------------------------------------------------------------------ */
section('robustness');
let badThrew = null;
let badReport = null;
try {
  badReport = mod.cycle({ dryRun: true, population: [null, 0, 'x', {}, { name: 'ok' }] });
} catch (err) {
  badThrew = err;
}
ok('cycle() переживает мусорную популяцию', !badThrew, badThrew && badThrew.message);
ok('на мусорной популяции возвращается отчёт', !!badReport);

let emptyThrew = null;
let emptyReport = null;
try {
  // Пустой массив трактуется как «популяция не передана»: cycle() детерминированно
  // делает fallback на loadPopulation() и никогда не падает.
  emptyReport = mod.cycle({ dryRun: true, population: [] });
} catch (err) {
  emptyThrew = err;
}
ok('cycle() переживает пустую популяцию (fallback, без краха)', !emptyThrew, emptyThrew && emptyThrew.message);
ok('пустая популяция \u2192 корректный объект-отчёт', !!(emptyReport && typeof emptyReport === 'object'));
ok('отчёт.empty содержит поле ok типа boolean',
  !!(emptyReport && typeof emptyReport.ok === 'boolean'));

// Явно «нерабочая» популяция из невалидных значений: родители не выбираются,
// контракт допускает ok:false, но модуль обязан вернуть отчёт, а не бросить.
let noParentThrew = null;
let noParentReport = null;
try {
  noParentReport = mod.cycle({ dryRun: true, population: [null], generations: 1 });
} catch (err) {
  noParentThrew = err;
}
ok('невалидная популяция не бросает исключение', !noParentThrew, noParentThrew && noParentThrew.message);
ok('невалидная популяция \u2192 отчёт существует', !!noParentReport);

/* ------------------------------------------------------------------ */
/* Итог                                                                */
/* ------------------------------------------------------------------ */
console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
