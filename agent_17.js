// Эмбриолог — скрещивание генов.
// Агент, который комбинирует «гены» (черты/модули) других агентов,
// порождая новые гибридные стратегии.

const fs = require('fs');
const path = require('path');
const { askDeepSeekChat } = require('./llm_client');

const ROOT = __dirname;

const STRATEGY = 'embryologist: crossbreed genes of agents into new hybrids';

/**
 * Скрещивает двух родителей в нового агента.
 * @param {Array} parents — массив из 2 объектов { name, prompt, wins, score }
 * @returns {Promise<{ok: boolean, newAgent?: string, strategy?: string, error?: string}>}
 */
async function crossbreed(parents, options) {
  const opts = options || {};
  const newAgentName = opts.name || 'agent_20.js';

  if (!Array.isArray(parents) || parents.length < 2) {
    return { ok: false, error: 'нужно минимум 2 родителя' };
  }

  const [a, b] = parents;

  const systemPrompt = 'Ты — Эмбриолог. Скрести двух агентов, объедини их лучшие стратегии, создай нового агента с уникальной гибридной стратегией. Ответь СТРОГО JSON: {"strategy": "краткое описание", "code": "полный JS-код нового агента"}.';

  const userPrompt = 'Родитель A: ' + (a.name || 'agent_A') + '\nСтратегия A: ' + (a.prompt || a.strategy || '') + '\n\n' +
                     'Родитель B: ' + (b.name || 'agent_B') + '\nСтратегия B: ' + (b.prompt || b.strategy || '') + '\n\n' +
                     'Создай нового агента с гибридной стратегией. Код должен экспортировать { runAgent, STRATEGY }, использовать agent_loop_v3.';

  let answer;
  try {
    answer = await askDeepSeekChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ], 3000);
  } catch (e) {
    return { ok: false, error: 'LLM error: ' + e.message };
  }

  // Извлекаем JSON
  let parsed = null;
  const cleaned = answer.split('```json').join('').split('```').join('').trim();
  let depth = 0, start = -1;
  for (let k = 0; k < cleaned.length; k++) {
    if (cleaned[k] === '{') { if (depth === 0) start = k; depth++; }
    else if (cleaned[k] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try { parsed = JSON.parse(cleaned.slice(start, k + 1)); } catch (e) {}
        break;
      }
    }
  }

  if (!parsed || !parsed.code) {
    return { ok: false, error: 'no code in response', raw: answer.slice(0, 300) };
  }

  // Записываем нового агента
  const newAgentPath = path.join(ROOT, newAgentName);
  try {
    fs.writeFileSync(newAgentPath, parsed.code, 'utf8');
  } catch (e) {
    return { ok: false, error: 'write failed: ' + e.message };
  }

  // Проверяем синтаксис
  const { execFileSync } = require('child_process');
  try {
    execFileSync('node', ['--check', newAgentPath], { stdio: 'pipe' });
  } catch (e) {
    fs.unlinkSync(newAgentPath);
    return { ok: false, error: 'syntax broken, rolled back', stderr: (e.stderr || '').toString().slice(0, 300) };
  }

  return {
    ok: true,
    newAgent: newAgentName,
    strategy: parsed.strategy || '',
    path: newAgentPath
  };
}

/**
 * Точка входа: принимает задачу, возвращает результат скрещивания.
 * @param {string} task
 * @returns {Promise<object>}
 */
async function runAgent(task) {
  // По умолчанию — топ-2 из champions
  let champions = { champions: {} };
  try {
    champions = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'champions.json'), 'utf8'));
  } catch (e) {}

  const list = Object.entries(champions.champions || {})
    .map(([name, data]) => ({ name, ...data }))
    .sort((a, b) => (b.wins_recent || 0) - (a.wins_recent || 0))
    .slice(0, 2);

  if (list.length < 2) {
    return { ok: false, error: 'нужно минимум 2 родителя в champions.json' };
  }

  // Читаем промпты родителей
  const parents = list.map(p => {
    let prompt = '';
    try {
      const promptFile = path.join(ROOT, 'boxes', p.name, 'prompts', p.name + '.md');
      if (fs.existsSync(promptFile)) prompt = fs.readFileSync(promptFile, 'utf8');
    } catch (e) {}
    return { name: p.name, wins: p.wins_recent, score: p.avg_score, prompt };
  });

  const result = await crossbreed(parents);
  return { ok: result.ok, parents: parents.map(p => p.name), ...result };
}

module.exports = { runAgent, STRATEGY, crossbreed };
