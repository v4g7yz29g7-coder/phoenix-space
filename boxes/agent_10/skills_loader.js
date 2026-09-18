// skills_loader.js — Skills Graph для Phoenix + совместимость со старым API
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
  path.join(__dirname, 'skills_graph'),
  path.join(__dirname, 'skills'),
  path.join(__dirname, 'skills_hub', 'skills'),
];

function findSkillsDir() {
  for (const d of CANDIDATES) {
    if (fs.existsSync(d)) return d;
  }
  return null;
}

// === Новый API (для TB и Skills Graph) ===
function loadSkills(instruction, history = '') {
  const dir = path.join(__dirname, 'skills_graph');
  if (!fs.existsSync(dir)) return [];
  const text = (instruction + ' ' + history).toLowerCase();
  const skills = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
    try {
      const sk = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const patternHit = (sk.trigger_patterns || []).some(p => text.includes(p.toLowerCase()));
      const kwHits = (sk.trigger_keywords || []).filter(k => text.includes(k.toLowerCase())).length;
      if (patternHit || kwHits >= 1) skills.push(sk);
    } catch (e) {}
  }
  return skills;
}

function formatSkillsBlock(skills) {
  if (!skills.length) return '';
  const lines = ['\nAVAILABLE RECIPES:'];
  for (const sk of skills.slice(0, 3)) {
    lines.push(`\n▶ ${sk.name} (conf=${sk.confidence || 0.5})`);
    if (sk.reasoning) lines.push(`  WHY: ${sk.reasoning}`);
    for (const c of (sk.recipe_commands || []).slice(0, 8)) {
      lines.push(`  - ${c}`);
    }
  }
  return lines.join('\n');
}

// === Старый API (для agent_responses.js) ===
function buildSkillsPrompt() {
  const dir = findSkillsDir();
  if (!dir) return '';
  // Если это skills_graph/*.json — форматируем их
  if (dir.endsWith('skills_graph')) {
    const all = [];
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json'))) {
      try {
        const sk = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        all.push(formatSkillsBlock([sk]));
      } catch (e) {}
    }
    return all.join('\n');
  }
  // Fallback: читаем как .md файлы (старый формат)
  let out = '';
  try {
    const list = fs.readdirSync(dir).filter(x => x.endsWith('.md')).slice(0, 20);
    for (const f of list) {
      out += '\n=== ' + f + ' ===\n' + fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 500) + '\n';
    }
  } catch (e) {}
  return out;
}

module.exports = { loadSkills, formatSkillsBlock, buildSkillsPrompt };
