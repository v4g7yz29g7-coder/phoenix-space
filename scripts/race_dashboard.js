#!/usr/bin/env node
'use strict';

/**
 * race_dashboard.js — сводный дашборд гоночных результатов.
 *
 * Читает memory/patterns/race_*.json (последние N=20 файлов, сортировка по mtime),
 * для каждой гонки определяет победителя (max score), его time_ms и число
 * участвовавших агентов. Печатает таблицу
 *   race_id | winner | score | time_ms | agents | verdict
 * и агрегат побед по агентам.
 *
 * Флаг --json печатает машиночитаемый вывод: {races:[...], by_agent:{...}}.
 */

const fs = require('fs');
const path = require('path');

// Не падать, если читатель закрыл пайп раньше (напр. `| head`).
process.stdout.on('error', function (err) {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

const DEFAULT_LIMIT = 20;
const DEFAULT_DIR = path.resolve(__dirname, '..', 'memory', 'patterns');

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function parseArgs(argv) {
  const args = { json: false, limit: DEFAULT_LIMIT, dir: DEFAULT_DIR, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      args.json = true;
    } else if (a === '--limit' || a === '-n') {
      const n = parseInt(argv[++i], 10);
      if (isFinite(n) && n > 0) args.limit = n;
    } else if (a.indexOf('--limit=') === 0) {
      const n = parseInt(a.slice(8), 10);
      if (isFinite(n) && n > 0) args.limit = n;
    } else if (a === '--dir') {
      args.dir = path.resolve(argv[++i] || '');
    } else if (a.indexOf('--dir=') === 0) {
      args.dir = path.resolve(a.slice(6));
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

/** Список race_*.json, отсортированный по mtime (свежие первыми). */
function listRaceFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const name = entries[i];
    if (!/^race_.*\.json$/i.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!st.isFile()) continue;
    files.push({ file: full, name: name, mtime: st.mtimeMs });
  }
  files.sort(function (a, b) {
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
  });
  return files;
}

/** Победитель по max score; тай-брейк — меньшее time. */
function pickWinner(results) {
  const scored = results.filter(function (r) {
    return r && num(r.score) !== null;
  });
  if (scored.length === 0) return null;
  const sorted = scored.slice().sort(function (a, b) {
    if (num(b.score) !== num(a.score)) return num(b.score) - num(a.score);
    const at = num(a.time);
    const bt = num(b.time);
    if (at === null && bt === null) return 0;
    if (at === null) return 1;
    if (bt === null) return -1;
    return at - bt;
  });
  return sorted[0];
}

/** Нормализует запись гонки в строку дашборда. */
function resolveRace(record, fileName) {
  const results = Array.isArray(record.results) ? record.results : [];
  const winnerEntry = pickWinner(results);

  let winner = null;
  let score = null;
  let timeMs = null;
  let ok = null;

  if (winnerEntry) {
    winner = winnerEntry.box != null ? winnerEntry.box : null;
    score = num(winnerEntry.score);
    timeMs = num(winnerEntry.time);
    ok = typeof winnerEntry.ok === 'boolean' ? winnerEntry.ok : null;
  } else if (record.winner != null) {
    // Данных score нет — доверяем явному полю winner.
    winner = record.winner;
    score = num(record.winner_score);
    timeMs = num(record.winner_time);
    for (let i = 0; i < results.length; i++) {
      if (results[i] && results[i].box === winner && typeof results[i].ok === 'boolean') {
        ok = results[i].ok;
        break;
      }
    }
  }

  let agents = results.length;
  if (agents === 0 && Array.isArray(record.boxes)) agents = record.boxes.length;

  const anyFail = results.some(function (r) {
    return r && r.ok === false;
  });

  let verdict;
  if (winner === null) {
    verdict = anyFail ? 'FAILED' : results.length ? 'UNSCORED' : 'EMPTY';
  } else if (ok === false) {
    verdict = 'FAILED';
  } else if (typeof score === 'number') {
    verdict = score >= 9 ? 'WIN' : score >= 7 ? 'PASS' : 'WEAK';
  } else {
    verdict = 'WIN';
  }

  return {
    race_id: record.race_id || fileName.replace(/\.json$/i, ''),
    file: fileName,
    ts: record.ts || null,
    task: typeof record.task === 'string' ? record.task : null,
    winner: winner,
    score: score,
    time_ms: timeMs,
    agents: agents,
    verdict: verdict,
  };
}

function buildDashboard(files, limit) {
  const selected = files.slice(0, limit);
  const races = [];
  for (let i = 0; i < selected.length; i++) {
    let raw;
    try {
      raw = fs.readFileSync(selected[i].file, 'utf8');
    } catch (e) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch (e) {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    races.push(resolveRace(record, selected[i].name));
  }

  const byAgent = {};
  for (let i = 0; i < races.length; i++) {
    const w = races[i].winner;
    if (!w) continue;
    byAgent[w] = (byAgent[w] || 0) + 1;
  }

  return { races: races, by_agent: byAgent };
}

function pad(str, width, right) {
  let s = String(str == null ? '-' : str);
  if (s.length > width) s = s.slice(0, Math.max(0, width - 1)) + '…';
  while (s.length < width) s = right ? ' ' + s : s + ' ';
  return s;
}

function renderTable(dashboard) {
  const lines = [];
  const cols = [
    { key: 'race_id', title: 'race_id', w: 24 },
    { key: 'winner', title: 'winner', w: 10 },
    { key: 'score', title: 'score', w: 6, right: true },
    { key: 'time_ms', title: 'time_ms', w: 9, right: true },
    { key: 'agents', title: 'agents', w: 7, right: true },
    { key: 'verdict', title: 'verdict', w: 9 },
  ];

  lines.push(cols.map(function (c) { return pad(c.title, c.w, c.right); }).join(' | '));
  lines.push(cols.map(function (c) { return '-'.repeat(c.w); }).join('-+-'));

  for (let i = 0; i < dashboard.races.length; i++) {
    const r = dashboard.races[i];
    lines.push(
      cols.map(function (c) { return pad(r[c.key], c.w, c.right); }).join(' | ')
    );
  }

  lines.push('');
  lines.push('Всего гонок: ' + dashboard.races.length);

  const agents = Object.keys(dashboard.by_agent).sort(function (a, b) {
    if (dashboard.by_agent[b] !== dashboard.by_agent[a]) {
      return dashboard.by_agent[b] - dashboard.by_agent[a];
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });

  lines.push('Победы по агентам:');
  if (agents.length === 0) {
    lines.push('  (нет гонок с определённым победителем)');
  } else {
    for (let i = 0; i < agents.length; i++) {
      lines.push('  ' + agents[i] + ': ' + dashboard.by_agent[agents[i]]);
    }
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/race_dashboard.js [--json] [--limit N] [--dir DIR]\n'
    );
    return 0;
  }

  const files = listRaceFiles(args.dir);
  const dashboard = buildDashboard(files, args.limit);

  if (args.json) {
    const payload = {
      races: dashboard.races,
      by_agent: dashboard.by_agent,
      generated_at: new Date().toISOString(),
      count: dashboard.races.length,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(renderTable(dashboard) + '\n');
  }
  return 0;
}

process.exitCode = main();
