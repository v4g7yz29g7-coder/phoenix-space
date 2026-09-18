require('dotenv').config({ path: __dirname + '/.env' });
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const LOG = path.join(ROOT, 'logs', 'tournament_v2.log');

const LEAGUES = {
  A: ['agent_1', 'agent_7', 'agent_3', 'agent_14', 'agent_8'],
  B: ['agent_4', 'agent_5', 'agent_9', 'agent_10', 'agent_13'],
  C: ['agent_23', 'agent_24', 'agent_25', 'agent_12', 'agent_15'],
  D: ['agent_20', 'agent_21', 'agent_22', 'agent_11', 'agent_2'],
  E: ['agent_6', 'agent_17', 'agent_18', 'agent_19', 'agent_16']
};

const TASKS = [
  'Прочитай README.md и перечисли разделы в 5 пунктах. Ничего не меняй.',
  'Найди все TODO ТОЛЬКО в файлах agent_*.js в корне проекта (не заходи в node_modules). Верни список: файл:строка.',
  'Создай файл test_hybrid.md с тремя пунктами о гибридных стратегиях агентов. Используй инструмент write.'
];

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

async function runLeague(leagueName, boxes) {
  log(`\n=== ЛИГА ${leagueName}: ${boxes.join(', ')} ===\n`);
  const results = { league: leagueName, boxes, tasks: [] };

  for (let t = 0; t < TASKS.length; t++) {
    const task = TASKS[t];
    log(`  Задача ${t + 1}/${TASKS.length}: ${task.slice(0, 70)}...`);

    try {
      const output = execSync('node race.js', {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 1800000,
        maxBuffer: 50 * 1024 * 1024,
        env: {
          ...process.env,
          EARLY_STOP: 'true',
          RACE_BOXES: boxes.join(','),
          RACE_TASK: task
        }
      });

      const raceMatch = output.match(/race_\d+/);
      let raceData = null;
      if (raceMatch) {
        const f = path.join(ROOT, 'memory', 'races', raceMatch[0] + '.json');
        if (fs.existsSync(f)) raceData = JSON.parse(fs.readFileSync(f, 'utf8'));
      }

      const winner = raceData ? raceData.winner : null;
      results.tasks.push({ task: task.slice(0, 70), winner, results: raceData ? raceData.results : [] });
      log(`    🥇 Победитель: ${winner}`);
    } catch (e) {
      log(`    ❌ Ошибка: ${e.message.slice(0, 200)}`);
      results.tasks.push({ task: task.slice(0, 70), error: e.message.slice(0, 300) });
    }
  }

  const wins = {};
  for (const t of results.tasks) if (t.winner) wins[t.winner] = (wins[t.winner] || 0) + 1;
  const champion = Object.entries(wins).sort((a, b) => b[1] - a[1])[0];
  results.champion = champion ? champion[0] : null;
  results.champion_wins = champion ? champion[1] : 0;

  log(`\n  🏆 ЧЕМПИОН ЛИГИ ${leagueName}: ${results.champion} (${results.champion_wins}/${TASKS.length})`);
  return results;
}

async function main() {
  const start = Date.now();
  log('🏁 ТУРНИР v2 — 25 АГЕНТОВ\n');

  const allResults = [];
  for (const [name, boxes] of Object.entries(LEAGUES)) {
    allResults.push(await runLeague(name, boxes));
  }

  const protocol = {
    ts: new Date().toISOString(),
    duration_min: ((Date.now() - start) / 60000).toFixed(1),
    leagues: allResults
  };
  fs.writeFileSync(path.join(ROOT, 'memory', 'tournament_v2_protocol.json'), JSON.stringify(protocol, null, 2));

  log('\n=== ИТОГИ ТУРНИРА v2 ===\n');
  for (const r of allResults) log(`  ${r.league}: 🏆 ${r.champion} (${r.champion_wins}/${TASKS.length})`);

  const allWins = {};
  for (const r of allResults) {
    if (r.champion) allWins[r.champion] = (allWins[r.champion] || 0) + (r.champion_wins || 0);
  }
  const absolute = Object.entries(allWins).sort((a, b) => b[1] - a[1])[0];
  log(`\n🏆 АБСОЛЮТНЫЙ ЧЕМПИОН: ${absolute[0]} (${absolute[1]} побед)`);
  log(`\n📋 Протокол: memory/tournament_v2_protocol.json`);
  log(`⏱️  Длительность: ${protocol.duration_min} мин`);
}

main().catch(e => { log('FATAL: ' + e.message); process.exit(1); });
