// agent_29_sergeant.js — ПРАПОРЩИК. Следит за порядком и дисциплиной.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ROADMAP = path.join(ROOT, 'arena_roadmap.json');

// === ПРОВЕРКИ ДИСЦИПЛИНЫ ===

// 1. Не потеряны ли completed?
function checkCompleted() {
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  const completed = d.stages.flatMap(s => s.tasks).filter(t => t.status === 'completed');
  const withoutDate = completed.filter(t => !t.completed_at);
  return {
    ok: withoutDate.length === 0,
    total: completed.length,
    without_completed_at: withoutDate.map(t => t.id),
  };
}

// 2. Нет ли stuck > 1 час?
function checkStuck() {
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  const now = Date.now();
  const stuck = [];
  for (const stage of d.stages) {
    for (const task of stage.tasks) {
      if (task.status === 'in_progress' && task.started_at) {
        const h = (now - new Date(task.started_at).getTime()) / 3600000;
        if (h > 1) stuck.push({ id: task.id, hours: h.toFixed(1) });
      }
    }
  }
  return { ok: stuck.length === 0, stuck };
}

// 3. Нет ли фальшивых completed (нет файла)?
function checkFakeCompleted() {
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  const fake = [];
  const CANDIDATES = [
    (f) => path.join(ROOT, f),
    (f) => path.join(ROOT, 'arena_lab', 'src', 'scene', f),
    (f) => path.join(ROOT, 'arena_lab', 'src', 'hooks', f),
    (f) => path.join(ROOT, 'research', f),
    (f) => path.join(ROOT, 'web', 'public', f),
  ];
  for (const stage of d.stages) {
    for (const task of stage.tasks) {
      if (task.status !== 'completed' || !task.file) continue;
      const found = CANDIDATES.some(fn => {
        const full = fn(task.file);
        return fs.existsSync(full) && fs.statSync(full).size >= 1000;
      });
      if (!found) {
        fake.push({ id: task.id, file: task.file });
      }
    }
  }
  return { ok: fake.length === 0, fake };
}

// 4. Нет ли orphan процессов?
function checkProcesses() {
  try {
    const { execSync } = require('child_process');
    const ps = execSync('ps aux | grep -E "arena_worker|research_worker|oracle_loop" | grep -v grep', { encoding: 'utf8' });
    const count = ps.trim().split('\n').filter(Boolean).length;
    return { ok: count <= 6, count, processes: ps.slice(0, 500) };
  } catch (e) {
    return { ok: true, count: 0 };
  }
}

// === ГЛАВНАЯ ПРОВЕРКА ===
function patrol() {
  const report = {
    ts: new Date().toISOString(),
    checks: {},
    passed: 0,
    failed: 0,
  };
  
  report.checks.completed = checkCompleted();
  report.checks.stuck = checkStuck();
  report.checks.fake = checkFakeCompleted();
  report.checks.processes = checkProcesses();
  
  for (const [name, check] of Object.entries(report.checks)) {
    if (check.ok) report.passed++;
    else report.failed++;
  }
  
  return report;
}

module.exports = { patrol, checkCompleted, checkStuck, checkFakeCompleted, checkProcesses };

// === CLI ===
if (require.main === module) {
  console.log('🎖️ ПРАПОРЩИК: проверяю дисциплину...\n');
  const report = patrol();
  
  for (const [name, check] of Object.entries(report.checks)) {
    const icon = check.ok ? '✅' : '❌';
    console.log(`${icon} ${name}: ${JSON.stringify(check).slice(0, 200)}`);
  }
  
  console.log(`\n=== ИТОГ ===`);
  console.log(`Пройдено: ${report.passed}/4`);
  console.log(`Провалено: ${report.failed}/4`);
  
  fs.writeFileSync(
    path.join(ROOT, 'memory', 'patrol_report.json'),
    JSON.stringify(report, null, 2)
  );
  console.log(`\n📋 Отчёт: memory/patrol_report.json`);
}
