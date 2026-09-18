// benchmark/loop.js — цикл: generate → run → score каждые N минут
'use strict';

// 14.09: загрузка .env (loop запускается из nohup без env)
try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch (e) {}

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(ROOT, 'memory', 'benchmark_loop.log');
const INTERVAL_MIN = parseInt(process.env.BENCH_INTERVAL_MIN || "120", 10);
const TIMEOUT_TASK = parseInt(process.env.BENCH_TASK_TIMEOUT || '120', 10);

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

function runNode(script, args = [], timeoutMs = 600000) {
  return new Promise((resolve) => {
    const p = spawn('node', [script, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });

    const timer = setTimeout(() => {
      log(`   ⏰ timeout ${timeoutMs}ms — убиваю ${script}`);
      try { p.kill('SIGKILL'); } catch (e) {}
    }, timeoutMs);

    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

function latestBench() {
  const dir = path.join(__dirname, 'archive');
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('bench_') && f.endsWith('.json'))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(dir, files[0].f) : null;
}

async function cycle(n) {
  log(`\n══════ ЦИКЛ #${n} ══════`);

  // 1. GENERATE
  log('🧠 [1/3] generate — Архитектор ставит задачи');
  const gen = await runNode('benchmark/generator.js', [], 180000);
  if (gen.code !== 0) {
    log(`   ❌ generate fail (code=${gen.code})`);
    log(`   stderr: ${gen.err.slice(-300)}`);
    return;
  }
  const benchFile = latestBench();
  log(`   ✅ Бенчмарк: ${path.basename(benchFile)}`);

  // 2. RUN
  log('🏁 [2/3] run — race по задачам');
  const run = await runNode('benchmark/runner.js', [benchFile], 1800000);
  if (run.code !== 0) {
    log(`   ⚠️ runner exit=${run.code} (может быть timeout — продолжаем)`);
  } else {
    log('   ✅ run завершён');
  }

  // Cleanup orphans
  try { execSync('pkill -9 -f "vite build" 2>/dev/null || true'); } catch (e) {}
  try { execSync('pkill -9 -f "npm run build" 2>/dev/null || true'); } catch (e) {}

  // 3. SCORE
  log('📊 [3/3] score — fitness агентов');
  const score = await runNode('benchmark/scorer.js', [benchFile], 60000);
  if (score.code !== 0) {
    log(`   ❌ scorer fail (code=${score.code})`);
    log(`   stderr: ${score.err.slice(-300)}`);
    return;
  }
  // Печатаем топ из вывода scorer
  const tail = score.out.split('\n').slice(-10).join('\n');
  log(tail);

  log(`══════ ЦИКЛ #${n} ЗАВЕРШЁН ══════`);
}

async function main() {
  log(`🚀 benchmark/loop.js запущен | интервал=${INTERVAL_MIN}мин | task_timeout=${TIMEOUT_TASK}s`);

  let n = 0;
  const once = process.argv.includes('--once');

  while (true) {
    n++;
    try {
      await cycle(n);
    } catch (e) {
      log(`❌ Цикл #${n} упал: ${e.message}`);
    }

    if (once) {
      log('(--once) — выходим');
      process.exit(0);
    }

    log(`😴 Следующий цикл через ${INTERVAL_MIN} мин...`);
    await new Promise(r => setTimeout(r, INTERVAL_MIN * 60 * 1000));
  }
}

if (require.main === module) {
  main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
}

module.exports = { cycle };
