// replay/pattern_miner.js — переиспользуемый извлекатель паттернов из траекторий.
// Вынесено из replay_worker.js (см. memory/patterns/replay_*.json).
//
// API:
//   mine(dirOrFiles) -> {
//     trajectories,   // число валидных траекторий
//     avgScore,       // средний score
//     successRate,    // доля ok-траекторий (0..1)
//     actions,        // [{action, count, avgScore, avgMs}] (по убыванию count)
//     topSequences,   // [{seq, count}] (топ-10)
//     // дополнительно:
//     avgDurationMs, slowestAction, topOutcomeTokens
//   }
//
// dirOrFiles: путь к каталогу с *.json, путь к одному файлу, либо массив путей.
// Битые/пустые (невалидный JSON, нет path) файлы молча игнорируются — без падений.
//
// КРИТЕРИЙ: node --check OK; require('./replay/pattern_miner')
//   .mine('memory/trajectories') -> object, Array.isArray(actions) === true,
//   actions.length > 0.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = path.join(ROOT, 'memory', 'trajectories');

// "29744ms" -> 29744
function parseDurationMs(outcome) {
  const m = /(\d+)\s*ms/.exec(String(outcome || ''));
  return m ? parseInt(m[1], 10) : null;
}

// Разбирает содержимое траектории (уже распарсенный JSON). null если пусто/бито.
function parseTrajectory(j, file) {
  if (!j || typeof j !== 'object') return null;
  const pathObj = j.path || {};
  const agents = Object.keys(pathObj);
  if (!agents.length) return null;

  let best = null;
  for (const a of agents) {
    const steps = Array.isArray(pathObj[a]) ? pathObj[a] : [];
    const scores = steps.map(s => (typeof s.score === 'number' ? s.score : 0));
    const maxScore = scores.length ? Math.max(...scores) : 0;
    const last = steps.length ? steps[steps.length - 1] : null;
    const finalScore = last && typeof last.score === 'number' ? last.score : maxScore;
    const durs = steps.map(s => parseDurationMs(s.outcome)).filter(x => x != null);
    const cand = {
      agent: a, steps, maxScore, finalScore,
      durationMs: durs.length ? Math.min(...durs) : null,
    };
    if (!best || cand.maxScore > best.maxScore) best = cand;
  }
  if (!best) return null;

  return {
    file,
    race_id: j.race_id || file,
    task: j.task || '',
    winner: j.winner || best.agent,
    agentCount: agents.length,
    score: best.maxScore,
    finalScore: best.finalScore,
    durationMs: best.durationMs,
    steps: best.steps,
    actions: best.steps.map(s => s.action).filter(Boolean),
    outcomes: best.steps.map(s => s.outcome).filter(Boolean),
    ok: /ok/i.test(best.steps.map(s => s.outcome || '').join(' ')),
  };
}

// Читает один файл траектории по абсолютному/относительному пути.
function loadTrajectory(file) {
  try {
    const abs = path.isAbsolute(file)
      ? file
      : (fs.existsSync(file) ? path.resolve(process.cwd(), file) : path.resolve(DEFAULT_DIR, file));
    const raw = fs.readFileSync(abs, 'utf8');
    if (!raw || !raw.trim()) return null;
    return parseTrajectory(JSON.parse(raw), path.basename(abs));
  } catch (e) {
    return null;
  }
}

// Приводит dirOrFiles к списку абсолютных путей *.json.
function resolveInput(dirOrFiles) {
  if (dirOrFiles == null) dirOrFiles = DEFAULT_DIR;
  const list = Array.isArray(dirOrFiles) ? dirOrFiles : [dirOrFiles];
  const files = [];

  for (const item of list) {
    if (typeof item !== 'string' || !item) continue;
    const candidates = path.isAbsolute(item)
      ? [item]
      : [path.resolve(process.cwd(), item), path.resolve(ROOT, item)];
    let resolved = null;
    for (const c of candidates) {
      try { if (fs.existsSync(c)) { resolved = c; break; } } catch (e) { /* тихо */ }
    }
    if (!resolved) continue;

    let st = null;
    try { st = fs.statSync(resolved); } catch (e) { continue; }
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(resolved); } catch (e) { continue; }
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        const abs = path.join(resolved, n);
        let isFile = false;
        try { isFile = fs.statSync(abs).isFile(); } catch (e) { isFile = false; }
        if (isFile) files.push(abs);
      }
    } else if (st.isFile()) {
      files.push(resolved);
    }
  }
  return files;
}

// Агрегация паттернов по массиву валидных траекторий.
function extractPatterns(trajs) {
  trajs = Array.isArray(trajs) ? trajs : [];
  const actionStats = {};
  const sequences = {};
  const outcomeTokens = {};
  let scoreSum = 0, durSum = 0, durN = 0, okCount = 0;

  for (const t of trajs) {
    scoreSum += (typeof t.score === 'number' ? t.score : 0);
    if (t.durationMs != null) { durSum += t.durationMs; durN++; }
    if (t.ok) okCount++;

    const seq = (t.actions || []).join(' -> ');
    if (seq) sequences[seq] = (sequences[seq] || 0) + 1;

    for (const s of (t.steps || [])) {
      const a = s.action || 'unknown';
      const st = actionStats[a] || (actionStats[a] = { count: 0, scoreSum: 0, msSum: 0, msN: 0 });
      st.count++;
      if (typeof s.score === 'number') st.scoreSum += s.score;
      const ms = parseDurationMs(s.outcome);
      if (ms != null) { st.msSum += ms; st.msN++; }
    }
    for (const o of (t.outcomes || [])) {
      const words = String(o).toLowerCase().replace(/[^\wа-яё0-9]+/gi, ' ').split(/\s+/);
      for (const w of words) {
        if (w && w.length > 2 && !/^\d+$/.test(w)) outcomeTokens[w] = (outcomeTokens[w] || 0) + 1;
      }
    }
  }

  const n = trajs.length || 1;
  const actions = Object.entries(actionStats).map(([action, s]) => ({
    action,
    count: s.count,
    avgScore: +(s.scoreSum / s.count).toFixed(2),
    avgMs: s.msN ? Math.round(s.msSum / s.msN) : null,
  })).sort((a, b) => b.count - a.count);

  const topSequences = Object.entries(sequences).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([seq, count]) => ({ seq, count }));

  const topOutcomeTokens = Object.entries(outcomeTokens).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([token, count]) => ({ token, count }));

  const slowest = actions.slice().sort((a, b) => (b.avgMs || 0) - (a.avgMs || 0))[0] || null;

  return {
    trajectories: trajs.length,
    avgScore: +(scoreSum / n).toFixed(2),
    avgDurationMs: durN ? Math.round(durSum / durN) : null,
    successRate: +(okCount / n).toFixed(2),
    slowestAction: slowest && slowest.avgMs != null
      ? { action: slowest.action, avgMs: slowest.avgMs }
      : null,
    actions,
    topSequences,
    topOutcomeTokens,
  };
}

// Главный вход: mine(dirOrFiles) -> агрегированные паттерны.
function mine(dirOrFiles) {
  const files = resolveInput(dirOrFiles);
  const trajs = [];
  for (const f of files) {
    const t = loadTrajectory(f);
    if (t) trajs.push(t);
  }
  const patterns = extractPatterns(trajs);
  return {
    trajectories: patterns.trajectories,
    avgScore: patterns.avgScore,
    successRate: patterns.successRate,
    actions: patterns.actions,
    topSequences: patterns.topSequences,
    // расширения (совместимость с replay_worker.extractPatterns):
    avgDurationMs: patterns.avgDurationMs,
    slowestAction: patterns.slowestAction,
    topOutcomeTokens: patterns.topOutcomeTokens,
  };
}

module.exports = {
  mine,
  parseDurationMs,
  parseTrajectory,
  loadTrajectory,
  resolveInput,
  extractPatterns,
  DEFAULT_DIR,
};
