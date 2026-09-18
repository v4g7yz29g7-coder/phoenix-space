// champion_tracker.js — ведёт статистику побед за последние N гонок
const fs = require('fs');
const path = require('path');

const STATS_FILE = path.join(__dirname, 'memory/champions.json');
const WINDOW = 10;

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch (e) { return { races: [], champions: {}, last_updated: null }; }
}

function saveStats(stats) {
  fs.mkdirSync(path.dirname(STATS_FILE), { recursive: true });
  stats.last_updated = new Date().toISOString();
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function computeChampions(races) {
  const recent = races.slice(-WINDOW);
  const wins = {}, scores = {}, times = {};

  for (const race of recent) {
    for (const r of (race.results || [])) {
      if (r.ok && r.score !== undefined) {
        (scores[r.box] = scores[r.box] || []).push(r.score);
        if (r.time) (times[r.box] = times[r.box] || []).push(r.time);
      }
    }
    const winner = (race.results || [])
      .filter(r => r.ok && r.score)
      .sort((a, b) => (b.score - a.score) || (a.time - b.time))[0];
    if (winner) wins[winner.box] = (wins[winner.box] || 0) + 1;
  }

  const champions = {};
  for (const box of Object.keys(scores)) {
    champions[box] = {
      wins_recent: wins[box] || 0,
      avg_score: +(scores[box].reduce((a, b) => a + b, 0) / scores[box].length).toFixed(2),
      avg_time_ms: times[box] ? Math.round(times[box].reduce((a, b) => a + b, 0) / times[box].length) : null,
      races_in_window: scores[box].length
    };
  }
  return champions;
}

function recordRace(raceResult) {
  const stats = loadStats();
  stats.races.push({
    ts: new Date().toISOString(),
    race_id: raceResult.race_id,
    task: (raceResult.task || '').slice(0, 100),
    results: (raceResult.results || []).map(r => ({
      box: r.box, ok: r.ok, score: r.score, time: r.duration_ms
    }))
  });
  if (stats.races.length > WINDOW * 3) stats.races = stats.races.slice(-WINDOW * 3);
  stats.champions = computeChampions(stats.races);
  saveStats(stats);
  return stats.champions;
}

function getChampion() {
  const stats = loadStats();
  const champions = stats.champions || {};
  const list = Object.entries(champions).map(([box, s]) => ({ box, ...s }));
  list.sort((a, b) => (b.wins_recent - a.wins_recent) || (b.avg_score - a.avg_score));
  return list[0] || null;
}

// CLI: пересчитать champions из всех race-паттернов
if (require.main === module) {
  const glob = require('fs').readdirSync('memory/patterns').filter(f => f.startsWith('race_'));
  const races = glob.map(f => {
    try { return JSON.parse(fs.readFileSync('memory/patterns/' + f, 'utf8')); }
    catch (e) { return null; }
  }).filter(Boolean);

  const champions = computeChampions(races);
  saveStats({ races: races.slice(-30), champions });
  console.log('✅ Champions updated from', races.length, 'races');
  console.log(JSON.stringify(champions, null, 2));
  console.log('🏆 Champion:', JSON.stringify(getChampion()));
}

module.exports = { recordRace, getChampion, loadStats, computeChampions };
