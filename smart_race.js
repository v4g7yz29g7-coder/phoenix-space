// smart_race.js — умный production: cache → champion → race с early-stop
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const championTracker = require('./champion_tracker');

const CACHE_FILE = path.join(__dirname, 'memory/task_cache.json');

function fingerprint(task) {
  return crypto.createHash('md5').update(task.toLowerCase().trim()).digest('hex').slice(0, 12);
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function findInCache(task) {
  const cache = loadCache();
  return cache[fingerprint(task)] || null;
}

function saveToCache(task, result) {
  const cache = loadCache();
  cache[fingerprint(task)] = {
    task: task.slice(0, 200),
    answer: result.answer,
    score: result.score,
    box: result.box,
    ts: new Date().toISOString()
  };
  saveCache(cache);
}

function runProduction(task, options = {}) {
  const { maxBoxes = 3, minScore = 8 } = options;

  // 1. Cache
  const cached = findInCache(task);
  if (cached && cached.score >= minScore) {
    console.log('💾 CACHE HIT: ' + cached.box + ' (score ' + cached.score + ')');
    return { source: 'cache', ...cached };
  }

  // 2. Champion + fallback
  const champion = championTracker.getChampion();
  const allBoxes = ['agent_1', 'agent_3', 'agent_7'];
  let boxes = [];
  if (champion && champion.wins_recent >= 5) {
    boxes.push(champion.box);
    console.log('🏆 CHAMPION MODE: ' + champion.box + ' (wins ' + champion.wins_recent + '/' + champion.races_in_window + ')');
  }
  for (const b of allBoxes) {
    if (boxes.length >= maxBoxes) break;
    if (!boxes.includes(b)) boxes.push(b);
  }

  // 3. Race с EARLY_STOP
  const env = {
    ...process.env,
    EARLY_STOP: 'true',
    RACE_BOXES: boxes.join(','),
    RACE_TASK: task
  };
  const output = execSync('node race.js', {
    cwd: __dirname, encoding: 'utf8', timeout: 600000,
    maxBuffer: 50 * 1024 * 1024, env
  });

  // 4. Парсим и кэшируем — вычисляем победителя САМИ, не полагаясь на raceData.winner
  try {
    const m = output.match(/race_\d+\.json/);
    if (!m) return { source: 'race', error: 'race file not found in output', raw: output.slice(-500) };

    const raceFile = m[0];
    const raceData = JSON.parse(fs.readFileSync('memory/races/' + raceFile, 'utf8'));
    const results = raceData.results || [];

    // Вычисляем победителя
    const winnerResult = results
      .filter(r => r.ok && r.score !== undefined && r.score !== null)
      .sort((a, b) => (b.score - a.score) || ((a.duration_ms || 0) - (b.duration_ms || 0)))[0];

    if (!winnerResult) {
      return { source: 'race', error: 'no successful result', raw: output.slice(-500) };
    }

    saveToCache(task, {
      answer: winnerResult.answer || '',
      score: winnerResult.score,
      box: winnerResult.box
    });

    return {
      source: 'race',
      box: winnerResult.box,
      score: winnerResult.score,
      answer: winnerResult.answer,
      race_id: raceData.race_id
    };
  } catch (e) {
    return { source: 'race', error: e.message, raw: output.slice(-500) };
  }
}

module.exports = { runProduction, findInCache, fingerprint };

if (require.main === module) {
  const task = process.argv[2];
  if (!task) { console.log('Usage: node smart_race.js "task text"'); process.exit(1); }
  const r = runProduction(task);
  console.log(JSON.stringify(r, null, 2));
}
