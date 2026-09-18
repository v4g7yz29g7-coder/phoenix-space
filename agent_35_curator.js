// agent_35_curator.js — Knowledge Curator. Собирает решённые кейсы в базу знаний.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ROADMAP = path.join(ROOT, 'arena_roadmap.json');
const RESEARCH = path.join(ROOT, 'arena_research.json');
const KB = path.join(ROOT, 'memory', 'knowledge_base.json');
const RACES_DIR = path.join(ROOT, 'memory', 'races');

// === ЗАГРУЗКА ===
function loadKB() {
  if (!fs.existsSync(KB)) {
    return { solved_cases: [], failed_cases: [], patterns: [], lessons: [], updated_at: null };
  }
  return JSON.parse(fs.readFileSync(KB, 'utf8'));
}

function saveKB(kb) {
  kb.updated_at = new Date().toISOString();
  fs.writeFileSync(KB, JSON.stringify(kb, null, 2));
}

// === ИЗВЛЕЧЕНИЕ КЕЙСОВ ИЗ ROADMAP ===
function extractFromRoadmap(kb) {
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  const existingIds = new Set(kb.solved_cases.map(c => c.id));
  
  let added = 0;
  for (const stage of d.stages) {
    for (const task of stage.tasks) {
      if (task.status !== 'completed') continue;
      if (existingIds.has(task.id)) continue;
      
      // Проверяем что файл существует
      const filePath = task.file ? findFile(task.file) : null;
      if (task.file && !filePath) continue;
      
      kb.solved_cases.push({
        id: task.id,
        title: task.title,
        stage: stage.name,
        file: task.file,
        file_size: filePath ? fs.statSync(filePath).size : 0,
        completed_at: task.completed_at,
        winner: task.winner,
        type: classifyTask(task),
      });
      added++;
    }
  }
  return added;
}

// === ИЗВЛЕЧЕНИЕ RESEARCH ===
function extractFromResearch(kb) {
  if (!fs.existsSync(RESEARCH)) return 0;
  const r = JSON.parse(fs.readFileSync(RESEARCH, 'utf8'));
  const existingIds = new Set(kb.solved_cases.map(c => c.id));
  
  let added = 0;
  for (const task of r.tasks) {
    if (task.status !== 'completed' || existingIds.has(task.id)) continue;
    const full = path.join(ROOT, task.file);
    if (!fs.existsSync(full)) continue;
    
    kb.solved_cases.push({
      id: task.id,
      title: task.title,
      type: 'research',
      file: task.file,
      file_size: fs.statSync(full).size,
      completed_at: task.completed_at,
    });
    added++;
  }
  return added;
}

// === ПАТТЕРНЫ (что чаще решается) ===
function extractPatterns(kb) {
  const byType = {};
  for (const c of kb.solved_cases) {
    byType[c.type] = (byType[c.type] || 0) + 1;
  }
  kb.patterns = Object.entries(byType)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  return kb.patterns.length;
}

// === УРОКИ (что проваливается) ===
function extractLessons(kb) {
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  const lessons = [];
  
  for (const stage of d.stages) {
    for (const task of stage.tasks) {
      if (task.status === 'failed' && task.error) {
        lessons.push({
          id: task.id,
          error: task.error.slice(0, 200),
          retry_count: task.retry_count || 0,
        });
      }
    }
  }
  kb.lessons = lessons;
  return lessons.length;
}

// === КЛАССИФИКАЦИЯ ===
function classifyTask(task) {
  const title = (task.title || '').toLowerCase();
  if (title.includes('research') || task.id.startsWith('R.')) return 'research';
  if (title.includes('схема') || title.includes('бд') || title.includes('database')) return 'database';
  if (title.includes('api')) return 'api';
  if (title.includes('ui') || title.includes('панель') || title.includes('каталог')) return 'ui';
  if (title.includes('регистрац') || title.includes('логин') || title.includes('jwt')) return 'auth';
  if (title.includes('агент')) return 'agent';
  if (title.includes('гонк') || title.includes('race')) return 'race';
  if (title.includes('3d') || title.includes('.tsx')) return '3d';
  return 'other';
}

// === ПОИСК ФАЙЛА ===
function findFile(name) {
  const paths = [
    path.join(ROOT, name),
    path.join(ROOT, 'arena_lab', 'src', 'scene', name),
    path.join(ROOT, 'arena_lab', 'src', 'hooks', name),
    path.join(ROOT, 'research', name),
    path.join(ROOT, 'web', 'public', name),
  ];
  for (const p of paths) if (fs.existsSync(p)) return p;
  return null;
}

// === ГЛАВНЫЙ ЦИКЛ ===
function curate() {
  console.log(`\n🎓 CURATOR — сбор базы знаний`);
  
  const kb = loadKB();
  const before = kb.solved_cases.length;
  
  const fromRoadmap = extractFromRoadmap(kb);
  const fromResearch = extractFromResearch(kb);
  const patternsCount = extractPatterns(kb);
  const lessonsCount = extractLessons(kb);
  
  saveKB(kb);
  
  console.log(`   ✅ solved_cases: ${before} → ${kb.solved_cases.length} (+${fromRoadmap + fromResearch})`);
  console.log(`   📊 patterns: ${patternsCount} типов`);
  console.log(`   ⚠️ lessons: ${lessonsCount}`);
  console.log(`   📋 База: memory/knowledge_base.json`);
  
  return kb;
}

module.exports = { curate, loadKB, saveKB };

// === CLI ===
if (require.main === module) {
  const loop = process.argv[2] === '--loop';
  curate();
  if (loop) {
    console.log('\n🔄 Следующий цикл через 30 минут...');
    setInterval(curate, 30 * 60 * 1000);
  }
}
