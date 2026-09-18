// parallel_race_director.js — 8 трасс × 3 бокса
// Запускает 8 гонок параллельно, каждая — своя тройка агентов
'use strict';

const fs = require('fs');
const path = require('path');
const raceDirector = require('./race_director');

const ROOT = __dirname;
const LOG = path.join(ROOT, 'memory', 'parallel_race.log');

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

// Распределение 25 боксов по 8 трассам по 3 (24 работают, 1 спит)
function distributeTracks(boxes) {
  const tracks = [];
  for (let i = 0; i < 8; i++) {
    const group = [];
    for (let j = 0; j < 3; j++) {
      const idx = i * 3 + j;
      if (idx < boxes.length) group.push(boxes[idx]);
    }
    if (group.length) tracks.push(group);
  }
  return tracks;
}

// Пул задач: берём pending из tasks_night_pool.json
function getPendingTasks(limit = 8) {
  try {
    const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'tasks_night_pool.json'), 'utf8'));
    return (pool.tasks || [])
      .filter(t => t.status === 'pending')
      .slice(0, limit)
      .map(t => ({
        id: t.id,
        task: t.prompt || `Создай файл ${t.file}. КРИТЕРИЙ: >${t.min_lines || 100} строк, node --check OK.`,
      }));
  } catch (e) {
    return [];
  }
}

async function runParallel({ maxTracks = 8, timeout_sec = 180 } = {}) {
  // 1. Все боксы (25)
  const boxes = fs.readdirSync(path.join(ROOT, 'boxes'))
    .filter(f => /^agent_(\d+|g2_[a-f0-9]+)$/.test(f))
    .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));

  if (boxes.length < 3) {
    log(`⚠️  Мало боксов: ${boxes.length}`);
    return { ok: false, error: 'not enough boxes' };
  }

  // 2. 8 трасс × 3 бокса
  const tracks = distributeTracks(boxes);
  log(`🎯 Трасс: ${tracks.length}`);
  for (const [i, t] of tracks.entries()) {
    log(`   Track ${i + 1}: ${t.join(', ')}`);
  }

  // 3. Задачи (по 1 на трассу)
  const tasks = getPendingTasks(maxTracks);
  if (tasks.length < tracks.length) {
    log(`⚠️  Pending задач: ${tasks.length}, трасс: ${tracks.length} — будем переиспользовать`);
  }

  // 4. Формируем 8 гонок
  const races = tracks.map((group, i) => ({
    boxes: group,
    task: tasks[i] ? tasks[i].task : 'Создай tests/track_' + (i + 1) + '.js. КРИТЕРИЙ: node --check OK.',
    id: tasks[i] ? tasks[i].id : `TRACK-${i + 1}`,
  }));

  log(`🏁 Запускаю ${races.length} гонок параллельно`);

  // 5. Promise.all
  const startAll = Date.now();
  const results = await Promise.all(races.map(async (r) => {
    try {
      const t0 = Date.now();
      const res = await raceDirector.startRace({
        boxes: r.boxes,
        task: r.task,
        timeout_sec,
      });
      const ms = Date.now() - t0;
      log(`✅ Track ${r.id}: winner=${res.winner} за ${Math.round(ms / 1000)}s`);
      return { ...r, result: res, ms };
    } catch (e) {
      log(`❌ Track ${r.id}: ${e.message.slice(0, 100)}`);
      return { ...r, error: e.message };
    }
  }));

  const totalMs = Date.now() - startAll;
  const ok = results.filter(r => r.result && r.result.winner).length;

  log(`════════════════════════════`);
  log(`✅ Завершено: ${ok}/${results.length} гонок, время ${Math.round(totalMs / 1000)}s`);
  log(`════════════════════════════`);

  return { ok: true, results, totalMs };
}

if (require.main === module) {
  const once = process.argv.includes('--once');
  const loop = process.argv.includes('--loop');
  const interval = 60 * 1000;  // 60 сек между циклами

  (async () => {
    let cycle = 0;
    while (true) {
      cycle++;
      log(`\n══════ ЦИКЛ #${cycle} ══════`);
      try {
        await runParallel({ maxTracks: 8, timeout_sec: 180 });
      } catch (e) {
        log(`❌ Цикл #${cycle} упал: ${e.message}`);
      }
      if (once) break;
      if (!loop) break;
      log(`😴 Следующий цикл через ${interval / 1000}с`);
      await new Promise(r => setTimeout(r, interval));
    }
  })().catch(e => log('FATAL: ' + e.message));
}

module.exports = { runParallel, distributeTracks, getPendingTasks };
