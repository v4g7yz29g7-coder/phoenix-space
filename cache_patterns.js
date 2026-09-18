// cache_patterns.js — ядро кэша решений (patterns).
//
// Выделено из race_director.js::findCachedSolution (коммиты a83148be,
// a279933a, 85922db3), чтобы логику можно было покрыть тестами без
// поднятия socket.io / оракула / радио.
//
// Правила кэша:
//   1) файлы только race_*.json из memory/patterns;
//   2) сортировка по mtime DESC — самая свежая запись побеждает
//      (readdirSync даёт алфавитный порядок, а не хронологический);
//   3) нормализация task — trim + lowercase + схлопывание пробелов,
//      чтобы «Собери  Отчёт» и «  собери отчёт » давали один ключ;
//   4) порог winner_score >= 7 (было 9 — критика ставит 7-8);
//   5) answer — строка, длина >= MIN_ANSWER_LEN (отсечь короткие заглушки).
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_SCORE = 7;         // порог 9 → 7 (85922db3)
const DEFAULT_MIN_ANSWER_LEN = 200;  // отсечь короткие заготовки (85922db3)
const DEFAULT_MAX_FILES = 500;       // топ-500 свежих (a279933a)

// Нормализация задачи: trim + lowercase + схлопывание внутренних пробелов.
function normalizeTask(task) {
  return String(task == null ? '' : task)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Список pattern-файлов, отсортированных по mtime DESC (свежие первыми).
function listPatternFiles(dir, maxFiles) {
  const limit = maxFiles == null ? DEFAULT_MAX_FILES : maxFiles;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f.startsWith('race_'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, limit);
}

// Поиск кэш-решения по task. Возвращает pattern-объект или null.
// opts.minScore / opts.minAnswerLen / opts.maxFiles — для тестов/настройки.
function findCachedSolution(dir, task, opts) {
  const o = opts || {};
  const minScore = o.minScore == null ? DEFAULT_MIN_SCORE : o.minScore;
  const minAnswerLen = o.minAnswerLen == null ? DEFAULT_MIN_ANSWER_LEN : o.minAnswerLen;
  const maxFiles = o.maxFiles == null ? DEFAULT_MAX_FILES : o.maxFiles;

  const normTask = normalizeTask(task);
  if (!normTask) return null;

  for (const { f } of listPatternFiles(dir, maxFiles)) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!p.task || !p.winner_answer) continue;
      if (typeof p.winner_answer !== 'string') continue;
      if (p.winner_answer.length < minAnswerLen) continue;
      if (normalizeTask(p.task) === normTask && (p.winner_score || 0) >= minScore) {
        return p;
      }
    } catch (e) { /* повреждённый/битый json — пропускаем */ }
  }
  return null;
}

module.exports = {
  normalizeTask,
  listPatternFiles,
  findCachedSolution,
  DEFAULT_MIN_SCORE,
  DEFAULT_MIN_ANSWER_LEN,
  DEFAULT_MAX_FILES,
};
