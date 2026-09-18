// patrol_loop.js — Прапорщик + Аудитор, автономный режим
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sergeant = require('./agent_29_sergeant');

const AUDIT_FILE = path.join(__dirname, 'memory', 'audit_report.json');
const AUDIT_INTERVAL_MS = 30 * 60 * 1000;

function tick() {
  console.log(`\n[PATROL ${new Date().toISOString()}]`);

  const patrol = sergeant.patrol();
  console.log(`🎖️ Дисциплина: ${patrol.passed}/4`);
  if (!patrol.checks.completed.ok) {
    console.log(`   ⚠️ Без completed_at: ${patrol.checks.completed.without_completed_at.join(', ')}`);
  }
  if (!patrol.checks.stuck.ok) {
    console.log(`   ⚠️ Застряли: ${patrol.checks.stuck.stuck.map(s => s.id).join(', ')}`);
  }
  if (!patrol.checks.fake.ok) {
    console.log(`   ⚠️ Фальшивые: ${patrol.checks.fake.fake.map(f => f.id).join(', ')}`);
  }

  let lastAudit = 0;
  if (fs.existsSync(AUDIT_FILE)) {
    try {
      lastAudit = new Date(JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')).ts).getTime();
    } catch (e) { /* нет отчёта — ок */ }
  }
  if (Date.now() - lastAudit > AUDIT_INTERVAL_MS) {
    console.log('🎓 Аудитор: запускаю аудит...');
    try {
      execSync('node agent_28_auditor.js', { stdio: 'inherit', cwd: __dirname });
    } catch (e) {
      console.log('   ⚠️', String(e.message).slice(0, 100));
    }
  }
}

tick();
setInterval(tick, 5 * 60 * 1000);
