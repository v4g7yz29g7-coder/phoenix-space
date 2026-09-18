// benchmark/scorer.js — fitness агентов по результатам бенчмарков
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ARCHIVE = path.join(__dirname, 'archive');
const FITNESS_FILE = path.join(ROOT, 'memory', 'fitness.json');
const LOG = path.join(ROOT, 'memory', 'benchmark.log');

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

// === Скор одного бенчмарка ===
function scoreBenchmark(bench) {
  const agents = {};  // box → {runs, wins, scores[], times[], ok_count, difficulty_points}

  for (const r of bench.results || []) {
    if (r.error) continue;

    for (const x of r.results || []) {
      const box = x.box;
      if (!agents[box]) {
        agents[box] = {
          runs: 0, wins: 0,
          scores: [], times: [],
          ok_count: 0, difficulty_points: 0,
        };
      }
      agents[box].runs++;
      if (x.ok) agents[box].ok_count++;
      // null score при fail → 0
      agents[box].scores.push(typeof x.score === 'number' ? x.score : 0);
      if (typeof x.time_ms === 'number') agents[box].times.push(x.time_ms);

      // Difficulty weight
      const weight = r.difficulty || 1;
      if (x.ok) agents[box].difficulty_points += weight * (x.score || 0);

      // Win = победитель в этой задаче
      if (r.winner === box) agents[box].wins++;
    }
  }

  // Агрегаты
  const scored = {};
  for (const [box, a] of Object.entries(agents)) {
    const avgScore = a.scores.length ? a.scores.reduce((s, x) => s + x, 0) / a.scores.length : 0;
    const avgTime = a.times.length ? a.times.reduce((s, x) => s + x, 0) / a.times.length : 0;
    const winRate = a.runs ? a.wins / a.runs : 0;
    const okRate = a.runs ? a.ok_count / a.runs : 0;

    // Fitness: 50% score + 25% winRate + 15% okRate + 10% speed
    // Speed: 10000ms = 1.0, 30000ms = 0.3
    const speed = Math.max(0.1, Math.min(1, 10000 / (avgTime || 30000)));
    const fitness = (0.50 * avgScore) + (0.25 * winRate * 10) + (0.15 * okRate * 10) + (0.10 * speed * 10);

    scored[box] = {
      box,
      runs: a.runs,
      wins: a.wins,
      win_rate: +winRate.toFixed(3),
      ok_rate: +okRate.toFixed(3),
      avg_score: +avgScore.toFixed(2),
      avg_time_ms: Math.round(avgTime),
      difficulty_points: +a.difficulty_points.toFixed(1),
      fitness: +fitness.toFixed(3),
    };
  }

  return scored;
}

// === Обновление общего fitness ===
function updateFitness(benchFile) {
  const bench = JSON.parse(fs.readFileSync(benchFile, 'utf8'));
  const benchScores = scoreBenchmark(bench);

  let fitness = { agents: {}, history: [] };
  if (fs.existsSync(FITNESS_FILE)) {
    try { fitness = JSON.parse(fs.readFileSync(FITNESS_FILE, 'utf8')); } catch (e) {}
  }
  fitness.agents = fitness.agents || {};
  fitness.history = fitness.history || [];

  // Обновляем с усреднением (0.7 old + 0.3 new)
  for (const [box, s] of Object.entries(benchScores)) {
    if (!fitness.agents[box]) {
      fitness.agents[box] = { box, fitness: s.fitness, runs_total: s.runs, wins_total: s.wins, last_score_avg: s.avg_score };
    } else {
      const old = fitness.agents[box];
      old.fitness = +(0.7 * old.fitness + 0.3 * s.fitness).toFixed(3);
      old.runs_total = (old.runs_total || 0) + s.runs;
      old.wins_total = (old.wins_total || 0) + s.wins;
      old.last_score_avg = s.avg_score;
      old.last_updated = new Date().toISOString();
    }
  }

  fitness.history.push({
    bench_id: bench.id,
    ts: new Date().toISOString(),
    scores: benchScores,
  });
  // Держим историю в пределах 100 записей
  if (fitness.history.length > 100) fitness.history = fitness.history.slice(-100);

  fitness.updated_at = new Date().toISOString();
  fs.writeFileSync(FITNESS_FILE, JSON.stringify(fitness, null, 2));

  // Отчёт
  log(`📊 Scored benchmark ${bench.id}`);
  const ranked = Object.values(benchScores).sort((a, b) => b.fitness - a.fitness);
  for (const s of ranked) {
    log(`   ${s.box.padEnd(10)} fitness=${s.fitness} score=${s.avg_score} wins=${s.wins}/${s.runs} time=${s.avg_time_ms}ms`);
  }

  // Топ-3 обновлённого fitness
  const allRanked = Object.values(fitness.agents).sort((a, b) => b.fitness - a.fitness);
  log(`\n🏆 Топ-3 по общему fitness:`);
  for (const a of allRanked.slice(0, 3)) {
    log(`   ${a.box}: fitness=${a.fitness} (runs=${a.runs_total}, wins=${a.wins_total})`);
  }

  return { benchScores, fitness };
}

// === CLI ===
if (require.main === module) {
  const args = process.argv.slice(2);
  let file = args[0];

  if (!file) {
    const files = fs.readdirSync(ARCHIVE)
      .filter(f => f.startsWith('bench_') && f.endsWith('.json'))
      .map(f => ({ f, m: fs.statSync(path.join(ARCHIVE, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) {
      console.error('❌ Нет бенчмарков');
      process.exit(1);
    }
    file = path.join(ARCHIVE, files[0].f);
    console.log(`(авто) Беру последний: ${path.basename(file)}`);
  }

  const bench = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!bench.results || bench.results.length === 0) {
    console.error('❌ Бенчмарк без результатов — сначала запусти runner.js');
    process.exit(1);
  }

  updateFitness(file);
}

module.exports = { scoreBenchmark, updateFitness };
