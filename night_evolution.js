// night_evolution.js — крутит задачи из tasks_night_pool.json через race.js
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const pool_lock = require('./memory/pool_lock');

const ROOT = __dirname;
const POOL_FILE = path.join(ROOT, 'tasks_night_pool.json');
const REPORT_FILE = path.join(ROOT, 'memory', 'night_evolution_report.json');

const RACERS = process.env.NIGHT_BOXES
  ? process.env.NIGHT_BOXES.split(',')
  : ['agent_1', 'agent_4', 'agent_7'];

function loadPool() {
  return JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
}
function savePool(d) {
  pool_lock.withLock(() => {
    fs.writeFileSync(POOL_FILE, JSON.stringify(d, null, 2));
  });
}
function log(m) { console.log(`[NIGHT ${new Date().toISOString().slice(11,19)}] ${m}`); }

function runRace(task) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      RACE_BOXES: RACERS.join(','),
      RACE_TASK: task.prompt,
      RACE_NO_P2P: '1',
      RACE_TRAJECTORY: '1',
    };
    log(`🚀 ${task.id} → ${task.file}`);
    const proc = spawn('node', ['race.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('close', (code) => resolve({ code, out }));
  });
}

function verifyTask(task) {
  const full = path.join(ROOT, task.file);
  if (!fs.existsSync(full)) return { ok: false, reason: 'file not found' };
  const content = fs.readFileSync(full, 'utf8');
  const lines = content.split('\n').length;
  const ext = path.extname(full).toLowerCase();
  const minLines = task.min_lines || 100;
  const { execSync } = require('child_process');

  const checks = { exists: true, lines, min_lines: lines >= minLines, extension: ext };

  // .js — node --check + module.exports
  if (ext === '.js') {
    try {
      execSync('node --check ' + JSON.stringify(full), { stdio: 'pipe' });
      checks.node_check = true;
    } catch (e) {
      checks.node_check = false;
      return { ok: false, reason: 'node --check failed', checks };
    }
    checks.has_module_exports = content.includes('module.exports');
    return { ok: checks.min_lines && checks.has_module_exports && checks.node_check, checks };
  }

  // .json — валидный JSON
  if (ext === '.json') {
    try { JSON.parse(content); checks.valid_json = true; }
    catch (e) { checks.valid_json = false; return { ok: false, reason: 'invalid JSON', checks }; }
    return { ok: checks.min_lines && checks.valid_json, checks };
  }

  // .md — есть заголовки и структура
  if (ext === '.md') {
    checks.has_headers = /^#{1,3}\s/m.test(content);
    checks.has_sections = (content.match(/^#{1,3}\s/gm) || []).length >= 3;
    return { ok: checks.min_lines && checks.has_headers, checks };
  }

  // .html — есть <html> или <body> или <div
  if (ext === '.html') {
    checks.has_html = /<(html|body|div|section|main)/i.test(content);
    return { ok: checks.min_lines && checks.has_html, checks };
  }

  // .sql — есть CREATE или INSERT
  if (ext === '.sql') {
    checks.has_sql = /(CREATE|INSERT|ALTER)\s/i.test(content);
    return { ok: checks.min_lines && checks.has_sql, checks };
  }

  // Прочее — только min_lines
  return { ok: checks.min_lines, checks };
}

async function loop() {
  while (true) {
    const pool = loadPool();
    const task = pool.tasks.find(t => t.status === 'pending' || !t.status);
    if (!task) {
      log('🎉 Все задачи выполнены');
      // Обнуляем — на новый прогон
      pool.tasks.forEach(t => { delete t.status; delete t.result; });
      savePool(pool);
      log('🔄 Пул обнулён, начинаю заново');
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    task.status = 'in_progress';
    task.started_at = new Date().toISOString();
    savePool(pool);

    const { code, out } = await runRace(task);
    const verify = verifyTask(task);

    task.status = verify.ok ? 'completed' : 'failed';
    task.completed_at = new Date().toISOString();
    task.result = {
      exit_code: code,
      verify,
      log_tail: out.slice(-500),
    };
    savePool(pool);

    log(`${verify.ok ? '✅' : '❌'} ${task.id} → ${task.file} (${verify.checks?.lines || 0} lines)`);

    await new Promise(r => setTimeout(r, 5000));
  }
}

// Отчёт каждые 5 минут
setInterval(() => {
  const pool = loadPool();
  const stats = pool.tasks.reduce((a, t) => {
    const s = t.status || 'pending';
    a[s] = (a[s] || 0) + 1;
    return a;
  }, {});
  const report = { ts: new Date().toISOString(), stats, tasks: pool.tasks.map(t => ({id: t.id, status: t.status, file: t.file})) };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
}, 5 * 60 * 1000);

log('🌙 Ночная эволюция запущена');
log(`   Пул: ${loadPool().tasks.length} задач`);
log(`   Боксы: ${RACERS.join(', ')}`);
loop().catch(e => { console.error('FATAL:', e); process.exit(1); });
