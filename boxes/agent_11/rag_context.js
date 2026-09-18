// RAG: перед задачей ищем похожие в EverOS и добавляем в контекст.
const { searchGrep } = require('./everos_client');
const fs = require('fs');

const EVEROS_ROOT = '/home/ishidin/.everos';

// Поиск релевантного контекста через grep по EverOS + ключевые слова из задачи
function findRelevantContext(task, maxResults = 3) {
  try {
    // 1. Извлекаем ключевые слова из задачи (простые: слова > 4 символов)
    const keywords = task
      .toLowerCase()
      .replace(/[^а-яa-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 4)
      .slice(0, 5);

    if (keywords.length === 0) return '';

    // 2. Ищем по EverOS (grep)
    const results = [];
    for (const kw of keywords) {
      const r = searchGrep(kw, 5);
      if (r && r.ok && r.results) {
        for (const item of r.results) {
          if (item.preview && item.preview.length > 20) {
            results.push({ keyword: kw, preview: item.preview.slice(0, 400) });
          }
        }
      }
      if (results.length >= maxResults * 2) break;
    }

    if (results.length === 0) return '';

    // 3. Компонуем в контекст
    let ctx = '\n\n[RELEVANT CONTEXT FROM EVEROS MEMORY]\n';
    const seen = new Set();
    let count = 0;
    for (const r of results) {
      const key = r.preview.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      ctx += '--- [' + r.keyword + '] ---\n' + r.preview + '\n';
      count++;
      if (count >= maxResults) break;
    }
    return ctx;
  } catch (e) {
    return '';
  }
}

// Обогащение промпта: задача + RAG-контекст
function enrichPrompt(task) {
  const ctx = findRelevantContext(task, 3);
  if (!ctx) return task;
  return task + ctx;
}

module.exports = { findRelevantContext, enrichPrompt };
