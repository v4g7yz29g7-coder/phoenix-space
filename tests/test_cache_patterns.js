#!/usr/bin/env node
'use strict';
/**
 * tests/test_cache_patterns.js
 *
 * Тесты для кэша решений (коммиты a83148be, a279933a, 85922db3):
 *   - patterns собирают answers (winner_answer);
 *   - порог winner_score 9 → 7;
 *   - сортировка patterns по mtime DESC (самая свежая побеждает);
 *   - нормализация task (trim + lowercase).
 *
 * Тест работает с временной директорией и чистит за собой.
 * Критерий: `node tests/test_cache_patterns.js` → exit 0, stdout 'PASS 4/4'.
 *
 * Каждый кейс имеет собственный assert и отдельное message.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findCachedSolution } = require('../pattern_cache');

// --- временная песочница (удаляется в конце) ---
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'cache_patterns_'));
let caseSeq = 0;
function freshDir() {
  caseSeq += 1;
  return fs.mkdtempSync(path.join(SANDBOX, 'case_' + caseSeq + '_'));
}

// Валидный answer кэша — строка длиной >= 200.
const LONG_ANSWER = 'A'.repeat(250);
const OLD_ANSWER = 'O'.repeat(250);
const NEW_ANSWER = 'N'.repeat(250);
const SHORT_ANSWER = 'short'; // 5 символов — кэшировать нельзя

// Пишем pattern-файл; mtimeMs задаём явно, чтобы управлять свежестью.
function writePattern(dir, name, data, mtimeMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
  if (typeof mtimeMs === 'number') {
    const secs = mtimeMs / 1000;
    fs.utimesSync(p, secs, secs);
  }
  return p;
}

let passed = 0;
const failures = [];

function runCase(title, fn) {
  try {
    fn();
    passed += 1;
    process.stderr.write('ok - ' + title + '\n');
  } catch (err) {
    failures.push({ title, message: err.message });
    process.stderr.write('not ok - ' + title + ': ' + err.message + '\n');
  }
}

// (1) Два одинаковых task после нормализации дают cache-hit.
runCase('1) identical task → cache-hit', () => {
  const dir = freshDir();
  writePattern(dir, 'race_1.json', {
    task: 'Build The Cache',
    winner: 'agent_1',
    winner_answer: LONG_ANSWER,
    winner_score: 8,
  });

  const first = findCachedSolution('Build The Cache', { dir });
  assert.ok(first, 'первый одинаковый task должен дать cache-hit');

  const second = findCachedSolution('Build The Cache', { dir });
  assert.ok(second, 'второй одинаковый task должен дать cache-hit');
  assert.strictEqual(
    second.winner_answer,
    LONG_ANSWER,
    'cache-hit должен вернуть сохранённый winner_answer'
  );
});

// (2) answer короче 7 символов не кэшируется.
runCase('2) short answer → not cached', () => {
  const dir = freshDir();
  writePattern(dir, 'race_1.json', {
    task: 'do a tiny thing',
    winner: 'agent_2',
    winner_answer: SHORT_ANSWER, // 5 < 7 — кэш не должен отдавать
    winner_score: 9,
  });

  const hit = findCachedSolution('do a tiny thing', { dir });
  assert.strictEqual(
    hit,
    null,
    'answer короче 7 символов не должен попадать в кэш'
  );
});

// (3) При двух записях с разным mtime выбирается самая свежая.
runCase('3) newest mtime wins', () => {
  const dir = freshDir();
  const now = Date.now();

  writePattern(dir, 'race_old.json', {
    task: 'same task',
    winner: 'agent_old',
    winner_answer: OLD_ANSWER,
    winner_score: 8,
  }, now - 60 * 60 * 1000); // час назад

  writePattern(dir, 'race_new.json', {
    task: 'same task',
    winner: 'agent_new',
    winner_answer: NEW_ANSWER,
    winner_score: 8,
  }, now);

  const hit = findCachedSolution('same task', { dir });
  assert.ok(hit, 'должна найтись хотя бы одна подходящая pattern');
  assert.strictEqual(
    hit.winner_answer,
    NEW_ANSWER,
    'при разных mtime должна выбираться самая свежая pattern'
  );
});

// (4) task с разным регистром/пробелами коллизится в один ключ.
runCase('4) case/space insensitive collision', () => {
  const dir = freshDir();
  writePattern(dir, 'race_1.json', {
    task: 'Deploy The Cache',
    winner: 'agent_4',
    winner_answer: LONG_ANSWER,
    winner_score: 7,
  });

  const variants = [
    'deploy the cache',
    'DEPLOY THE CACHE',
    'deploy THE cache',
    '   Deploy The Cache   ', // внешние пробелы игнорируются (trim)
  ];

  for (const v of variants) {
    const hit = findCachedSolution(v, { dir });
    assert.ok(hit, 'вариант "' + v + '" должен коллизиться в один ключ');
    assert.strictEqual(
      hit.winner_answer,
      LONG_ANSWER,
      'нормализованный task должен возвращать ту же pattern'
    );
  }
});

// --- уборка временной директории ---
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
} catch (e) { /* тихо */ }

if (failures.length === 0 && passed === 4) {
  process.stdout.write('PASS ' + passed + '/4\n');
  process.exit(0);
}

for (const f of failures) {
  process.stderr.write('FAIL ' + f.title + ': ' + f.message + '\n');
}
process.stdout.write('FAIL ' + passed + '/4\n');
process.exit(1);
