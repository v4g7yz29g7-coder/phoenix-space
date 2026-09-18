// pattern_cache.js — поиск закэшированного решения по task.
//
// Логика вынесена из race_director.js (коммиты a83148be, a279933a, 85922db3),
// чтобы её можно было тестировать в изоляции на временной директории
// (tests/test_cache_patterns.js), не поднимая весь гоночный директор.
//
// Правила кэша:
//   - читаются только race_*.json
//   - сортировка по mtime DESC (свежие первыми), Top-500
//   - winner_score >= 7 (порог ослаблен с 9)
//   - winner_answer — строка длиной >= 200 (отсекаем короткие заготовки)
//   - task нормализуется: trim + toLowerCase
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, 'memory', 'patterns');
const DEFAULT_MIN_SCORE = 7;        // порог winner_score: 9 → 7
const DEFAULT_MIN_ANSWER_LEN = 200; // минимальная длина winner_answer
const DEFAULT_LIMIT = 500;          // сколько свежих pattern смотреть

// Нормализация task: игнорируем регистр и внешние пробелы.
function normalizeTask(task) {
  return String(task == null ? '' : task).trim().toLowerCase();
}

// Возвращает подходящую pattern (объект) либо null.
// opts.dir          — директория с pattern-файлами (по умолчанию memory/patterns)
// opts.minScore     — минимальный winner_score
// opts.minAnswerLen — минимальная длина winner_answer
// opts.limit        — сколько свежих файлов просматривать
function findCachedSolution(task, opts = {}) {
  try {
    const dir = opts.dir || DEFAULT_DIR;
    const minScore = typeof opts.minScore === 'number' ? opts.minScore : DEFAULT_MIN_SCORE;
    const minLen = typeof opts.minAnswerLen === 'number' ? opts.minAnswerLen : DEFAULT_MIN_ANSWER_LEN;
    const limit = typeof opts.limit === 'number' ? opts.limit : DEFAULT_LIMIT;

    if (!fs.existsSync(dir)) return null;

    // readdirSync возвращает алфавитный порядок — сортируем по mtime DESC,
    // чтобы свежие pattern проверялись первыми.
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f.startsWith('race_'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, limit);

    const normTask = normalizeTask(task);
    if (!normTask) return null;

    for (const { f } of files) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!p.task || !p.winner_answer) continue;
        if (typeof p.winner_answer !== 'string') continue;
        if (p.winner_answer.length < minLen) continue;
        if (normalizeTask(p.task) === normTask && (p.winner_score || 0) >= minScore) {
          return p;
        }
      } catch (e) { /* skip битый файл */ }
    }
  } catch (e) { /* тихо */ }
  return null;
}

module.exports = {
  findCachedSolution,
  normalizeTask,
  DEFAULT_DIR,
  DEFAULT_MIN_SCORE,
  DEFAULT_MIN_ANSWER_LEN,
  DEFAULT_LIMIT,
};
