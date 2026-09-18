// agent_16.js — «Селекционер» (Selector)
//
// Селекционер — отбор лучших генов.
//
// СКЕЛЕТ. Реализация отсутствует намеренно: функции объявлены пустыми,
// чтобы структура модуля и контракт экспорта были зафиксированы заранее.

const fs = require('fs');
const path = require('path');

const STRATEGY = 'selector: отбирает лучшие гены (решения/фрагменты) по приспособленности и передаёт их дальше в эволюцию';

const ROOT = __dirname;
const CHAMPIONS_FILE = path.join(ROOT, 'memory', 'champions.json');
const BOXES_DIR = path.join(ROOT, 'boxes');

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

// Читает промпт агента из boxes/<box>/prompts/<box>.md
// Если файла нет — берёт первый .md из папки prompts, иначе пустую строку.
function readPrompt(boxName) {
  const promptsDir = path.join(BOXES_DIR, boxName, 'prompts');
  const canonical = path.join(promptsDir, `${boxName}.md`);

  try {
    return fs.readFileSync(canonical, 'utf8').trim();
  } catch (e) {
    try {
      const md = fs
        .readdirSync(promptsDir)
        .filter((f) => f.endsWith('.md'))
        .sort()[0];
      return md ? fs.readFileSync(path.join(promptsDir, md), 'utf8').trim() : '';
    } catch (e2) {
      return '';
    }
  }
}

/**
 * Отбор родителей для следующего поколения.
 * 1) читает memory/champions.json;
 * 2) берёт топ-2 агента по wins_recent;
 * 3) подтягивает промпт каждого из boxes/agent_N/prompts/agent_N.md;
 * 4) возвращает { parents: [{ name, prompt, wins, score }], rationale }.
 */
function selectParents(task) {
  const data = readJsonSafe(CHAMPIONS_FILE, {});
  const champions = (data && data.champions) || {};

  const ranked = Object.entries(champions)
    .map(([name, s]) => ({
      name,
      wins: Number(s && s.wins_recent) || 0,
      score: Number(s && s.avg_score) || 0,
    }))
    .sort((a, b) => b.wins - a.wins || b.score - a.score)
    .slice(0, 2);

  const parents = ranked.map((p) => ({ ...p, prompt: readPrompt(p.name) }));

  const taskNote = task
    ? ` Задача: ${String(task).slice(0, 120)}`
    : '';
  const rationale = parents.length
    ? `Отобраны топ-2 агента по wins_recent: ${parents
        .map((p) => `${p.name} (wins=${p.wins}, score=${p.score})`)
        .join(', ')}.${taskNote}`
    : `Нет данных в memory/champions.json — родители не выбраны.${taskNote}`;

  return { parents, rationale };
}

/**
 * Точка входа агента.
 */
function runAgent(task) {
  const selected = selectParents(task);
  return { ...selected, strategy: STRATEGY };
}

module.exports = { runAgent, STRATEGY, selectParents };
