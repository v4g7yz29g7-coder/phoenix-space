'use strict';

/**
 * evolution/generation_report.test.js
 * ============================================================================
 * Самопроверка модуля «Generation Report».
 *
 * Критерии задачи:
 *   - файл `evolution/generation_report.js` существует и содержит >150 строк;
 *   - `node --check evolution/generation_report.js` проходит без ошибок;
 *   - публичный API `report(gen)` экспортирован и работоспособен.
 *
 * Запуск:  node evolution/generation_report.test.js
 * ============================================================================
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HERE = __dirname;
const MODULE = path.join(HERE, 'generation_report.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   - ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${err && err.message ? err.message : err}`);
  }
}

console.log('generation_report.js — self-test');
console.log('--------------------------------------------------');

/* 1. Существование файла и объём ------------------------------------------- */
test('файл generation_report.js существует', () => {
  assert.ok(fs.existsSync(MODULE), 'файл не найден');
});

test('в файле больше 150 строк', () => {
  const src = fs.readFileSync(MODULE, 'utf8');
  const lines = src.split(/\r?\n/).length;
  assert.ok(lines > 150, `строк: ${lines}, ожидалось > 150`);
});

/* 2. Синтаксис -------------------------------------------------------------- */
test('node --check проходит без ошибок', () => {
  execFileSync(process.execPath, ['--check', MODULE], { stdio: 'pipe' });
});

/* 3. Публичный API ----------------------------------------------------------- */
const mod = require(MODULE);

test('экспортируется функция report(gen)', () => {
  assert.strictEqual(typeof mod.report, 'function', 'report — не функция');
});

test('экспортируется formatText', () => {
  assert.strictEqual(typeof mod.formatText, 'function');
});

test('экспортируется CONFIG', () => {
  assert.ok(mod.CONFIG && typeof mod.CONFIG === 'object');
});

/* 4. Поведение report() ------------------------------------------------------ */
test('report() без аргумента возвращает индекс поколений', () => {
  const idx = mod.report();
  assert.strictEqual(idx.ok, true);
  assert.ok(Array.isArray(idx.reports), 'reports — не массив');
  assert.ok(Array.isArray(idx.generations), 'generations — не массив');
});

test('report(gen) возвращает объект с ожидаемыми полями', () => {
  const idx = mod.report();
  const gen = idx.generations.length ? idx.generations[0] : 1;
  const r = mod.report(gen);
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.generation, gen);
  for (const key of ['cycles', 'counts', 'fitness', 'diversity', 'population', 'status', 'verdict']) {
    assert.ok(key in r, `нет поля ${key}`);
  }
});

test('report(gen) принимает номер строкой', () => {
  const idx = mod.report();
  const gen = idx.generations.length ? idx.generations[0] : 1;
  const r = mod.report(String(gen));
  assert.strictEqual(r.generation, gen);
});

test('несуществующее поколение не бросает исключение', () => {
  const r = mod.report(999999);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.found, false);
});

test("report(gen, { format: 'text' }) возвращает строку", () => {
  const idx = mod.report();
  const gen = idx.generations.length ? idx.generations[0] : 1;
  const txt = mod.report(gen, { format: 'text' });
  assert.strictEqual(typeof txt, 'string');
  assert.ok(txt.includes('Generation Report'), 'нет заголовка отчёта');
});

/* 5. Безопасность на «грязных» данных --------------------------------------- */
test('report() устойчив к пустому/битому файлу журнала', () => {
  const tmp = path.join(HERE, '.tmp_generation_report_empty.jsonl');
  fs.writeFileSync(tmp, '{ битый json\n\n{"generation":1}\n', 'utf8');
  try {
    const r = mod.report(1, { file: tmp });
    assert.strictEqual(r.ok, true);
  } finally {
    fs.unlinkSync(tmp);
  }
});

console.log('--------------------------------------------------');
console.log(`Итог: ${passed} ok, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
