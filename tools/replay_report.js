#!/usr/bin/env node
'use strict';

/**
 * CLI-отчёт по реплею траекторий.
 *
 * Читает memory/replay_worker_report.json и печатает агрегат:
 *   {
 *     trajectories: <number>,
 *     avg_score:    <number>,
 *     success_rate: <number>,
 *     top_actions:  [{ action, count, avgScore }],
 *     top_sequence: "старт -> углубился -> сдача"
 *   }
 *
 * Флаги:
 *   --last          взять самый свежий отчёт (история + файл по умолчанию);
 *                   печатает JSON-агрегат
 *   --json          печатать агрегат в формате JSON
 *   --file=<path>   явный путь до отчёта
 *   --top=<N>       ограничить top_actions (по умолчанию все)
 *   --quiet         не печатать предупреждения в stderr
 *   --help          справка
 *
 * Критерий: node tools/replay_report.js --last печатает валидный JSON
 *           с полем trajectories > 0.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT = path.join(ROOT, 'memory', 'replay_worker_report.json');
const HISTORY_DIR = path.join(ROOT, 'memory', 'replay_history');

/* ------------------------------------------------------------------ */
/* Аргументы                                                           */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const flags = { last: false, json: false, help: false, quiet: false, file: null, top: null };
  for (const raw of argv) {
    if (raw === '--last') flags.last = true;
    else if (raw === '--json') flags.json = true;
    else if (raw === '--quiet' || raw === '-q') flags.quiet = true;
    else if (raw === '--help' || raw === '-h') flags.help = true;
    else if (raw.startsWith('--file=')) flags.file = raw.slice('--file='.length);
    else if (raw.startsWith('--top=')) {
      const n = Number(raw.slice('--top='.length));
      if (Number.isFinite(n) && n > 0) flags.top = Math.floor(n);
    }
  }
  return flags;
}

/* ------------------------------------------------------------------ */
/* Чтение                                                              */
/* ------------------------------------------------------------------ */

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

function readReport(file) {
  const p = file ? path.resolve(file) : DEFAULT_REPORT;
  return { path: p, data: readJson(p) };
}

/** Кандидаты на «последний» отчёт: файл по умолчанию + история. */
function discoverReports() {
  const out = [];
  if (fs.existsSync(DEFAULT_REPORT)) out.push(DEFAULT_REPORT);
  try {
    if (fs.existsSync(HISTORY_DIR)) {
      for (const f of fs.readdirSync(HISTORY_DIR)) {
        if (/\.json$/i.test(f)) out.push(path.join(HISTORY_DIR, f));
      }
    }
  } catch (_) {
    /* история недоступна — не критично */
  }
  // Дополнительно: любые memory/replay_worker_report*.json
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'memory'))) {
      if (/^replay_worker_report.*\.json$/i.test(f)) {
        out.push(path.join(ROOT, 'memory', f));
      }
    }
  } catch (_) {
    /* ignore */
  }
  return Array.from(new Set(out));
}

function tsOf(file) {
  try {
    const data = readJson(file);
    const ts = data && (data.ts || data.timestamp || data.generatedAt);
    if (ts) {
      const t = Date.parse(ts);
      if (Number.isFinite(t)) return t;
    }
  } catch (_) {
    /* fall through to mtime */
  }
  try {
    return fs.statSync(file).mtimeMs;
  } catch (_) {
    return 0;
  }
}

/** Выбирает самый свежий отчёт из доступных. */
function pickLatest(files) {
  const list = (files && files.length ? files : discoverReports()).filter((f) => fs.existsSync(f));
  if (!list.length) return null;
  let best = list[0];
  let bestTs = tsOf(best);
  for (const f of list.slice(1)) {
    const t = tsOf(f);
    if (t > bestTs) {
      bestTs = t;
      best = f;
    }
  }
  return best;
}

/**
 * Если в отчёте массив траекторий — берём «последний» (самый свежий) элемент,
 * иначе возвращаем объект как есть.
 */
function selectLast(data) {
  if (Array.isArray(data)) return data[data.length - 1] || {};
  return data || {};
}

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v, digits = 2) {
  const p = Math.pow(10, digits);
  return Math.round(num(v) * p) / p;
}

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/* ------------------------------------------------------------------ */
/* Нормализация                                                        */
/* ------------------------------------------------------------------ */

/** Агрегат из сырого массива траекторий (fallback-формат). */
function aggregateTrajectories(trajectories) {
  const list = trajectories.filter(isPlainObject);
  const n = list.length;

  const byAction = new Map();
  let scoreSum = 0;
  let successes = 0;
  const seqCount = new Map();

  const bumpAction = (action, score) => {
    const key = String(action);
    const cur = byAction.get(key) || { action: key, count: 0, scoreSum: 0 };
    cur.count += 1;
    cur.scoreSum += num(score);
    byAction.set(key, cur);
  };

  for (const t of list) {
    const score = num(t.score != null ? t.score : t.avgScore);
    scoreSum += score;
    if (t.success === true || t.success === 1 || String(t.status || '').toLowerCase() === 'success') {
      successes += 1;
    }

    let actions = [];
    if (Array.isArray(t.actions)) actions = t.actions.map((a) => (isPlainObject(a) ? a.action : a));
    else if (typeof t.sequence === 'string') actions = t.sequence.split('->').map((s) => s.trim()).filter(Boolean);
    else if (typeof t.actions === 'string') actions = t.actions.split('->').map((s) => s.trim()).filter(Boolean);

    for (const a of actions) bumpAction(a, score);

    if (typeof t.sequence === 'string' && t.sequence.trim()) {
      const key = t.sequence.trim();
      seqCount.set(key, (seqCount.get(key) || 0) + 1);
    }
  }

  const top_actions = Array.from(byAction.values())
    .map((a) => ({ action: a.action, count: a.count, avgScore: round(a.scoreSum / a.count) }))
    .sort((a, b) => b.count - a.count || b.avgScore - a.avgScore);

  const top_sequence = Array.from(seqCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([seq]) => seq)[0] || '';

  return {
    trajectories: n,
    avg_score: n ? round(scoreSum / n) : 0,
    success_rate: n ? round(successes / n, 4) : 0,
    top_actions,
    top_sequence,
  };
}

/** Собирает нормализованный агрегат из сырого отчёта. */
function buildAggregate(raw) {
  // Прямой формат отчёта с блоком patterns.
  if (isPlainObject(raw) && isPlainObject(raw.patterns)) {
    const p = raw.patterns;
    const actions = Array.isArray(p.actions) ? p.actions : [];

    const top_actions = actions
      .map((a) => ({
        action: String(a && a.action != null ? a.action : 'unknown'),
        count: num(a && a.count),
        avgScore: round(num(a && a.avgScore)),
      }))
      .filter((a) => a.count > 0)
      .sort((a, b) => b.count - a.count || b.avgScore - a.avgScore);

    const sequences = Array.isArray(p.topSequences) ? p.topSequences : [];
    let top_sequence = '';
    if (sequences.length) {
      const best = sequences.slice().sort((a, b) => num(b && b.count) - num(a && a.count))[0];
      top_sequence = String((best && best.seq) || '');
    }

    return {
      trajectories: num(p.trajectories),
      avg_score: round(num(p.avgScore)),
      success_rate: round(num(p.successRate), 4),
      top_actions,
      top_sequence,
    };
  }

  // Fallback: top-level поля + массив траекторий.
  if (isPlainObject(raw) && Array.isArray(raw.trajectories)) {
    return aggregateTrajectories(raw.trajectories);
  }

  // Fallback: сам отчёт — массив траекторий.
  if (Array.isArray(raw)) {
    return aggregateTrajectories(raw);
  }

  // Совсем пусто — безопасный нулевой агрегат.
  return {
    trajectories: num(raw && raw.trajectories),
    avg_score: round(num(raw && raw.avgScore)),
    success_rate: round(num(raw && raw.successRate), 4),
    top_actions: [],
    top_sequence: '',
  };
}

/* ------------------------------------------------------------------ */
/* Вывод                                                               */
/* ------------------------------------------------------------------ */

function printHuman(agg, meta) {
  const lines = [];
  lines.push('=== Replay Report ===');
  if (meta && meta.path) lines.push(`source: ${meta.path}`);
  lines.push(`trajectories : ${agg.trajectories}`);
  lines.push(`avg_score    : ${agg.avg_score}`);
  lines.push(`success_rate : ${agg.success_rate}`);
  lines.push('top_actions  :');
  for (const a of agg.top_actions) {
    lines.push(`  - ${a.action}: count=${a.count}, avgScore=${a.avgScore}`);
  }
  lines.push(`top_sequence : ${agg.top_sequence}`);
  process.stdout.write(lines.join('\n') + '\n');
}

function limitTop(agg, top) {
  if (!top || top <= 0 || agg.top_actions.length <= top) return agg;
  return Object.assign({}, agg, { top_actions: agg.top_actions.slice(0, top) });
}

const HELP = [
  'Usage: node tools/replay_report.js [--last] [--json] [--file=<path>] [--top=N]',
  '',
  '  --last        взять самый свежий отчёт и напечатать JSON-агрегат',
  '  --json        печатать агрегат в формате JSON',
  '  --file=<path> путь до JSON-отчёта (по умолчанию memory/replay_worker_report.json)',
  '  --top=<N>     ограничить top_actions первыми N действиями',
  '  --quiet       подавить предупреждения в stderr',
  '  --help        эта справка',
  '',
].join('\n');

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function main(argv) {
  const flags = parseArgs(argv == null ? process.argv.slice(2) : argv);

  if (flags.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let reportPath = flags.file;
  if (flags.last && !reportPath) {
    reportPath = pickLatest();
    if (!reportPath) {
      if (!flags.quiet) process.stderr.write('replay_report: no reports found\n');
      // Нулевой, но валидный агрегат вместо падения.
      process.stdout.write(JSON.stringify(buildAggregate({}), null, 2) + '\n');
      return 0;
    }
  }

  let loaded;
  try {
    loaded = readReport(reportPath);
  } catch (err) {
    if (!flags.quiet) process.stderr.write(`replay_report: failed to read report: ${err.message}\n`);
    return 1;
  }

  const raw = flags.last ? selectLast(loaded.data) : loaded.data;
  const aggregate = limitTop(buildAggregate(raw), flags.top);

  // --last и --json печатают машинночитаемый JSON; иначе — человекочитаемый отчёт.
  if (flags.json || flags.last) {
    process.stdout.write(JSON.stringify(aggregate, null, 2) + '\n');
  } else {
    printHuman(aggregate, loaded);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  buildAggregate,
  aggregateTrajectories,
  selectLast,
  readReport,
  discoverReports,
  pickLatest,
  parseArgs,
  main,
};
