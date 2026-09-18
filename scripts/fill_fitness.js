#!/usr/bin/env node
// scripts/fill_fitness.js v2 — параллельно 8 гонок за раз
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BOXES_DIR = path.join(ROOT, 'boxes');
const FITNESS_FILE = path.join(ROOT, 'memory', 'fitness.json');
const PARALLEL = 8;

let fitness = { agents: {}, history: [] };
try { fitness = JSON.parse(fs.readFileSync(FITNESS_FILE, 'utf8')); } catch (e) {}
const known = new Set(Object.keys(fitness.agents || {}));

const allBoxes = fs.readdirSync(BOXES_DIR)
  .filter(f => /^agent_\d+$/.test(f))
  .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));

const missing = allBoxes.filter(b => !known.has(b));

console.log(`Всего боксов:     ${allBoxes.length}`);
console.log(`Без fitness:      ${missing.length}`);
console.log(`Параллельно:      ${PARALLEL}`);
console.log('');

if (!missing.length) {
  console.log('✅ Все боксы уже с fitness');
  process.exit(0);
}

const TASK = 'Прочитай package.json и скажи сколько там dependencies. КРИТЕРИЙ: одно число.';

function runRace(box) {
  return new Promise((resolve) => {
    const raceId = `fill_${box}_${Date.now()}`;
    const proc = spawn('node', ['race.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        RACE_TASK: TASK,
        RACE_BOXES: box,
        RACE_ID_DIRECTED: raceId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => out += d.toString());

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, 120000);

    proc.on('close', () => {
      clearTimeout(timer);
      const scoreMatch = out.match(/score:\s*(\d+)/);
      const score = scoreMatch ? parseInt(scoreMatch[1]) : 0;
      resolve({ box, score, raceId });
    });

    proc.on('error', () => resolve({ box, score: 0, error: 'spawn' }));
  });
}

(async () => {
  const start = Date.now();
  let completed = 0;
  const total = missing.length;

  // Батчами по PARALLEL
  for (let i = 0; i < missing.length; i += PARALLEL) {
    const batch = missing.slice(i, i + PARALLEL);
    console.log(`\n═══ Батч ${Math.floor(i / PARALLEL) + 1}: ${batch.join(', ')} ═══`);

    const results = await Promise.all(batch.map(runRace));

    for (const r of results) {
      completed++;
      if (!fitness.agents[r.box]) {
        fitness.agents[r.box] = {
          box: r.box,
          fitness: r.score / 10,
          runs_total: 1,
          wins_total: 0,
          last_score_avg: r.score,
          last_updated: new Date().toISOString(),
        };
      }
      console.log(`  [${completed}/${total}] ✅ ${r.box}: score=${r.score}`);
    }

    fs.writeFileSync(FITNESS_FILE, JSON.stringify(fitness, null, 2));
  }

  const ms = Date.now() - start;
  console.log('');
  console.log('════════════════════════════════════════════');
  console.log(`✅ Заполнено: ${total} боксов за ${Math.round(ms / 1000)} сек`);
  console.log(`📁 fitness.json обновлён`);
  console.log('════════════════════════════════════════════');
})();
