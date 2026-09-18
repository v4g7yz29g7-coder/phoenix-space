// agent_28_auditor.js — АУДИТОР. Проверяет реальное качество работы.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;

// === АУДИТ ФАЙЛА ===
function auditFile(filepath, minBytes = 1000) {
  // Ищем в нескольких местах: корень, arena_lab/src/scene, research, web/public
  const CANDIDATES = [
    path.join(ROOT, filepath),
    path.join(ROOT, 'arena_lab', 'src', 'scene', filepath),
    path.join(ROOT, 'arena_lab', 'src', 'hooks', filepath),
    path.join(ROOT, 'research', filepath),
    path.join(ROOT, 'web', 'public', filepath),
  ];
  for (const full of CANDIDATES) {
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full);
      if (stat.size < minBytes) {
        return { ok: false, reason: `too small: ${stat.size} < ${minBytes}`, path: full };
      }
      return { ok: true, size: stat.size, path: full.replace(ROOT + '/', '') };
    }
  }
  return { ok: false, reason: 'file not found in: ' + CANDIDATES.length + ' paths' };
}

// === АУДИТ TYPESCRIPT ===
function auditTypeScript() {
  try {
    execSync('cd arena_lab && npx tsc --noEmit 2>&1', { encoding: 'utf8', timeout: 60000 });
    return { ok: true, errors: 0 };
  } catch (e) {
    const out = (e.stdout || e.message || '').slice(0, 500);
    const errCount = (out.match(/error TS/g) || []).length;
    return { ok: false, errors: errCount, output: out };
  }
}

// === АУДИТ RESEARCH ===
function auditResearch(filepath) {
  const full = path.join(ROOT, filepath);
  if (!fs.existsSync(full)) return { ok: false, reason: 'not found' };
  const content = fs.readFileSync(full, 'utf8');
  const checks = {
    size: content.length,
    has_sources: /источник|source|github|docs/i.test(content),
    has_code: /```/.test(content),
    has_recommendation: /рекомендац|recommend|TL;DR|итог/i.test(content),
  };
  const ok = checks.size > 3000 && checks.has_sources && checks.has_code;
  return { ok, ...checks };
}

// === АУДИТ ЗАДАЧИ ===
function auditTask(task) {
  const results = {};
  
  if (task.file) {
    const ext = path.extname(task.file);
    if (ext === '.md' && task.file.includes('research/')) {
      results.file = auditResearch(task.file);
    } else {
      results.file = auditFile(task.file);
    }
  }
  
  if (task.file && task.file.endsWith('.tsx')) {
    results.ts = auditTypeScript();
  }
  
  const passed = Object.values(results).every(r => r.ok);
  return { task_id: task.id, passed, checks: results };
}

// === АУДИТ ВСЕГО ROADMAP ===
function auditAll() {
  const roadmap = JSON.parse(fs.readFileSync(path.join(ROOT, 'arena_roadmap.json'), 'utf8'));
  const report = {
    ts: new Date().toISOString(),
    tasks: [],
    summary: { total: 0, passed: 0, failed: 0, fake: 0 },
  };
  
  for (const stage of roadmap.stages) {
    for (const task of stage.tasks) {
      if (task.status !== 'completed') continue;
      report.summary.total++;
      const audit = auditTask(task);
      report.tasks.push(audit);
      if (audit.passed) report.summary.passed++;
      else {
        report.summary.failed++;
        if (audit.checks.file && !audit.checks.file.ok) report.summary.fake++;
      }
    }
  }
  
  return report;
}

module.exports = { auditFile, auditTypeScript, auditResearch, auditTask, auditAll };

// === CLI ===
if (require.main === module) {
  console.log('🎓 АУДИТОР: проверяю completed задачи...\n');
  const report = auditAll();
  
  for (const t of report.tasks) {
    const icon = t.passed ? '✅' : '❌';
    console.log(`${icon} ${t.task_id}`);
    for (const [key, check] of Object.entries(t.checks)) {
      const sub = check.ok ? '✓' : '✗';
      const detail = check.reason || check.size || check.errors || '';
      console.log(`   ${sub} ${key}: ${detail}`);
    }
  }
  
  console.log(`\n=== ИТОГ ===`);
  console.log(`Всего: ${report.summary.total}`);
  console.log(`Прошли аудит: ${report.summary.passed}`);
  console.log(`Провалили: ${report.summary.failed}`);
  console.log(`Фальшивые (нет файла): ${report.summary.fake}`);
  
  fs.writeFileSync(
    path.join(ROOT, 'memory', 'audit_report.json'),
    JSON.stringify(report, null, 2)
  );
  console.log(`\n📋 Отчёт: memory/audit_report.json`);
}
