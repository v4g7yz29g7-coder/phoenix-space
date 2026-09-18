'use strict';
// moat_inject.js — подключение Рва к агенту
// Логика: если Ров знает решение по файлу — отдаём его БЕЗ вызова LLM
// Если файл уже создан в ФС — задача решена, отдаём сразу

const fs = require('fs');
const path = require('path');
const moat = require('./moat_search');

const ROOT = __dirname;

// Извлекаем блок кода из ответа (``` ... ```)
function extractCode(answer) {
  if (!answer) return null;
  const m = answer.match(/```(?:javascript|js|typescript|ts|json|md)?\n([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

// Проверяем, что файл существует в проекте
function fileExists(file) {
  if (!file) return false;
  const abs = path.join(ROOT, file);
  return fs.existsSync(abs) && fs.statSync(abs).size > 0;
}

// Главный API: пробует решить задачу через Ров
// Возвращает:
//   { solved: true, source: 'fs', file, answer } — файл уже есть
//   { solved: true, source: 'moat', file, answer, winner, score } — нашли в Рве
//   null — не нашли, идём к LLM
function trySolve(task) {
  if (!task || !task.prompt) return null;

  const fileMatch = task.prompt.match(/[a-zA-Z0-9_\-/]+\.(js|md|json|ts)/);
  const file = task.file || (fileMatch ? fileMatch[0] : null);

  // 1. Файл уже создан — задача решена
  if (file && fileExists(file)) {
    return {
      solved: true,
      source: 'fs',
      file,
      answer: `Файл ${file} уже существует в проекте. Решение не требуется.`,
    };
  }

  // 2. Ищем в Рве
  const found = moat.find({ file, prompt: task.prompt });
  if (!found) return null;

  // 3. Проверяем, что answer содержит код
  const code = extractCode(found.answer);
  if (!code) {
    // answer — это отчёт без кода. Не используем.
    return null;
  }

  return {
    solved: true,
    source: 'moat',
    file,
    answer: found.answer,
    code,
    winner: found.winner,
    score: found.score,
    match_type: found.match_type,
  };
}

if (require.main === module) {
  const file = process.argv[2];
  const prompt = process.argv[3] || '';
  const r = trySolve({ file, prompt });
  console.log(JSON.stringify(r, null, 2));
}

module.exports = { trySolve, extractCode, fileExists };
