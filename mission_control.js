// mission_control.js — агрегатор метрик проекта.
// Источники: memory/patterns/*.json, memory/task_cache.json,
//            memory/champions.json, skills/, boxes/, logs/usage.log
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PATTERNS_DIR = path.join(ROOT, 'memory', 'patterns');
const CACHE_FILE = path.join(ROOT, 'memory', 'task_cache.json');
const CHAMPIONS_FILE = path.join(ROOT, 'memory', 'champions.json');
const USAGE_LOG = path.join(ROOT, 'logs', 'usage.log');
const SKILLS_DIR = path.join(ROOT, 'skills');
const BOXES_DIR = path.join(ROOT, 'boxes');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

// memory/patterns/races_total + победитель по числу побед (tie-break: avg score)
function collectRaces() {
  let files = [];
  try { files = fs.readdirSync(PATTERNS_DIR); } catch (e) { return { races_total: 0, champion: null }; }

  let races_total = 0;
  const boxes = new Map(); // box -> { wins, scoreSum, scored }

  for (const f of files) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const d = readJson(path.join(PATTERNS_DIR, f));
    if (!d || d.type !== 'race' || !Array.isArray(d.results)) continue;
    races_total++;

    for (const r of d.results) {
      if (!r || !r.box) continue;
      const b = boxes.get(r.box) || { wins: 0, scoreSum: 0, scored: 0 };
      if (typeof r.score === 'number') { b.scoreSum += r.score; b.scored++; }
      if (d.winner === r.box) b.wins++;
      boxes.set(r.box, b);
    }
  }

  let champion = null;
  let best = null;
  for (const [box, b] of boxes) {
    const avg_score = b.scored ? +(b.scoreSum / b.scored).toFixed(2) : 0;
    if (!best || b.wins > best.wins || (b.wins === best.wins && avg_score > best.avg_score)) {
      best = { box, wins: b.wins, avg_score };
      champion = box;
    }
  }

  // fallback: memory/champions.json (окно последних гонок)
  if (!champion) {
    const s = readJson(CHAMPIONS_FILE) || {};
    const list = Object.entries(s.champions || {}).map(([box, v]) => ({ box, ...v }));
    list.sort((a, b) => (b.wins_recent || 0) - (a.wins_recent || 0) || (b.avg_score || 0) - (a.avg_score || 0));
    if (list.length) champion = list[0].box;
  }

  return { races_total, champion, race_stats: best };
}

// cache_size — число записей в memory/task_cache.json,
// cache_hit_rate — % попаданий (logs/usage.log, при отсутствии — счётчики в кэше)
function readCache() {
  const cache = readJson(CACHE_FILE);
  let cache_size = 0;
  let hits = 0;
  let misses = 0;

  if (cache && typeof cache === 'object') {
    const keys = Object.keys(cache);
    cache_size = keys.length;
    for (const k of keys) {
      const e = cache[k];
      if (e && typeof e === 'object') {
        if (typeof e.hits === 'number') hits += e.hits;
        if (typeof e.misses === 'number') misses += e.misses;
      }
    }
  }

  if (hits + misses > 0) {
    return { cache_size, cache_hit_rate: Math.round(hits / (hits + misses) * 100) };
  }

  let totalIn = 0, totalCached = 0;
  try {
    const raw = fs.readFileSync(USAGE_LOG, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/in=(\d+)\s+cached=(\d+)/);
      if (!m) continue;
      totalIn += parseInt(m[1], 10);
      totalCached += parseInt(m[2], 10);
    }
  } catch (e) { /* лог недоступен */ }

  return {
    cache_size,
    cache_hit_rate: totalIn > 0 ? Math.round(totalCached / totalIn * 100) : 0
  };
}

function countSkills() {
  let n = 0;
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) n++;
    }
  })(SKILLS_DIR);
  return n;
}

function countActiveBoxes() {
  let dirs;
  try { dirs = fs.readdirSync(BOXES_DIR, { withFileTypes: true }); } catch (e) { return 0; }
  let active = 0;
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith('agent_')) continue;
    active++;
  }
  return active;
}

// Все race-паттерны, отсортированные по ts (новые первыми).
function collectRaceList() {
  let files = [];
  try { files = fs.readdirSync(PATTERNS_DIR); } catch (e) { return []; }

  const races = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith('.json')) continue;
    const d = readJson(path.join(PATTERNS_DIR, f));
    if (!d || d.type !== 'race') continue;
    races.push(d);
  }
  races.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
  return races;
}

// Время гонки в мс: winner_time, иначе время победившего бокса, иначе максимум по results.
function raceTimeMs(r) {
  if (typeof r.winner_time === 'number') return r.winner_time;
  const res = Array.isArray(r.results) ? r.results : [];
  const w = res.find(x => x && x.box === r.winner);
  if (w && typeof w.time === 'number') return w.time;
  const times = res.map(x => x && x.time).filter(t => typeof t === 'number');
  return times.length ? Math.max.apply(null, times) : null;
}

// Гонка считается провальной, если нет ни одного ok-результата
// либо победитель завершился с ok === false.
function raceFailed(r) {
  const res = Array.isArray(r.results) ? r.results : [];
  if (!res.length) return true;
  if (!res.some(x => x && x.ok === true)) return true;
  const w = res.find(x => x && x.box === r.winner);
  return !!w && w.ok === false;
}

// Последние n гонок в виде краткой сводки.
function getRecentRaces(n) {
  const limit = (typeof n === 'number' && isFinite(n) && n > 0) ? Math.floor(n) : 10;
  return collectRaceList().slice(0, limit).map(r => ({
    race_id: r.race_id || null,
    winner: r.winner || null,
    task: typeof r.task === 'string' ? r.task : null,
    time_ms: raceTimeMs(r)
  }));
}

// Аномалии: >20% провалов в последних 10 гонках, гонка дольше 5 минут,
// либо слишком маленький кэш (cache_size < 5).
function getAlerts() {
  const alerts = [];
  const last10 = collectRaceList().slice(0, 10);

  if (last10.length) {
    const failures = last10.filter(raceFailed).length;
    const failRate = failures / last10.length;
    if (failRate > 0.2) {
      alerts.push({
        type: 'race_failures',
        severity: 'high',
        races: last10.length,
        failures,
        fail_rate_pct: Math.round(failRate * 100),
        message: `Провалов ${failures}/${last10.length} (${Math.round(failRate * 100)}% > 20%)`
      });
    }

    const slow = last10.filter(r => {
      const t = raceTimeMs(r);
      return typeof t === 'number' && t > 300000;
    });
    if (slow.length) {
      const worst = slow.reduce((a, b) => (raceTimeMs(a) >= raceTimeMs(b) ? a : b));
      alerts.push({
        type: 'slow_race',
        severity: 'medium',
        races: slow.length,
        worst_race_id: worst.race_id || null,
        worst_time_ms: raceTimeMs(worst),
        message: `Медленных гонок ${slow.length} (> 300000 мс), худшая ${worst.race_id || 'n/a'}`
      });
    }
  }

  const { cache_size } = readCache();
  if (cache_size < 5) {
    alerts.push({
      type: 'cache_size_low',
      severity: 'medium',
      cache_size,
      threshold: 5,
      message: `cache_size=${cache_size} < 5`
    });
  }

  return alerts;
}

function getStats() {
  const { races_total, champion } = collectRaces();
  const { cache_size, cache_hit_rate } = readCache();
  return {
    races_total,
    cache_size,
    cache_hit_rate,
    champion,
    skills_count: countSkills(),
    boxes_active: countActiveBoxes()
  };
}

// Сводный отчёт: статистика + последние 10 гонок + алерты + метка времени.
function generateReport() {
  return {
    stats: getStats(),
    recent: getRecentRaces(10),
    alerts: getAlerts(),
    generated_at: new Date().toISOString()
  };
}

module.exports = { getStats, getRecentRaces, getAlerts, generateReport };
