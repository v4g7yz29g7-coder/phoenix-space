// benchmark/runner.js — прогон бенчмарка через race_director
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const raceDirector = require(path.join(ROOT, 'race_director'));
const LOG = path.join(ROOT, 'memory', 'benchmark.log');

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}


// === Убийство дочерних процессов после задачи ===
const { execSync } = require('child_process');
function cleanupOrphans() {
  const patterns = [
    'vite build',
    'npm run build',
    'npm install',
    'node race.js',
    'find / -',                    // 14.09: агенты запускают find / — I/O-бомба
    'grep -rn',                    // 14.09: рекурсивный grep тоже
    'grep -r --',
  ];
  for (const p of patterns) {
    try {
      execSync(`pkill -9 -f "${p}" 2>/dev/null || true`);
    } catch (e) {}
  }
}

// === ТОП-3 агентов по champions.json ===
function topAgents(n = 3) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'champions.json'), 'utf8'));
    const ch = d.champions || {};
    const sorted = Object.entries(ch)
      .sort((a, b) => (b[1].wins_recent || 0) - (a[1].wins_recent || 0))
      .slice(0, n)
      .map(([name]) => name);
    return sorted.length ? sorted : ['agent_1', 'agent_7', 'agent_3'];
  } catch (e) {
    return ['agent_1', 'agent_7', 'agent_3'];
  }
}

async function runBenchmark(benchFile, opts = {}) {
  const bench = JSON.parse(fs.readFileSync(benchFile, 'utf8'));
  const boxes = opts.boxes || topAgents(3);
  const timeoutSec = opts.timeout_sec || 120;

  log(`🏁 Бенчмарк ${bench.id}`);
  log(`   Задач: ${bench.tasks.length} | Боксы: ${boxes.join(', ')}`);

  bench.runner = {
    started_at: new Date().toISOString(),
    boxes,
    timeout_sec: timeoutSec,
  };
  bench.results = bench.results || [];

  for (let i = 0; i < bench.tasks.length; i++) {
    const task = bench.tasks[i];
    log(`\n[${i + 1}/${bench.tasks.length}] ${task.id} (D${task.difficulty}): ${task.task.slice(0, 70)}`);

    try {
      const t0 = Date.now();
      const result = await raceDirector.startRace({
        boxes,
        task: task.task,
        timeout_sec: timeoutSec,
      });
      const ms = Date.now() - t0;

      bench.results.push({
        task_id: task.id,
        difficulty: task.difficulty,
        race_id: result.race_id,
        winner: result.winner,
        duration_sec: result.duration_sec,
        duration_ms: ms,
        results: (result.results || []).map(r => ({
          box: r.box,
          score: r.score,
          time_ms: r.duration_ms,
          ok: r.ok,
          verdict: r.verdict,
        })),
      });

      log(`   ✅ Winner: ${result.winner} | ${ms}ms`);
      for (const r of (result.results || [])) {
        log(`      ${r.box}: score=${r.score ?? '—'} time=${r.duration_ms ?? '—'}ms ok=${r.ok}`);
      }
    } catch (e) {
      log(`   ❌ ${e.message}`);
      bench.results.push({
        task_id: task.id,
        difficulty: task.difficulty,
        error: e.message.slice(0, 200),
      });
    }

    // Убиваем orphan-процессы после задачи
    cleanupOrphans();
    await new Promise(r => setTimeout(r, 2000));

    // Сохраняем после каждой задачи — устойчивость к падениям
    fs.writeFileSync(benchFile, JSON.stringify(bench, null, 2));
  }

  bench.runner.finished_at = new Date().toISOString();
  fs.writeFileSync(benchFile, JSON.stringify(bench, null, 2));

  log(`\n✅ Бенчмарк завершён: ${benchFile}`);
  log(`   Результатов: ${bench.results.length}`);

  return bench;
}

// === CLI ===
if (require.main === module) {
  const args = process.argv.slice(2);
  let file = args[0];

  if (!file) {
    // Берём последний бенчмарк
    const archive = path.join(__dirname, 'archive');
    const files = fs.readdirSync(archive)
      .filter(f => f.startsWith('bench_') && f.endsWith('.json'))
      .sort();
    if (!files.length) {
      console.error('❌ Нет бенчмарков в benchmark/archive/');
      process.exit(1);
    }
    file = path.join(archive, files[files.length - 1]);
    console.log(`(авто) Беру последний: ${path.basename(file)}`);
  }

  if (!fs.existsSync(file)) {
    console.error('❌ Файл не найден:', file);
    process.exit(1);
  }

  runBenchmark(file)
    .then(() => process.exit(0))
    .catch(e => { console.error('❌ FATAL:', e.message); process.exit(1); });
}

module.exports = { runBenchmark, topAgents };
