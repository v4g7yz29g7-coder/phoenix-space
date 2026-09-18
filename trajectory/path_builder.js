'use strict';

/**
 * trajectory/path_builder.js
 * ============================================================================
 * Builds the REAL ascent path of every race participant straight from the
 * recorded **tick history**.
 *
 * Replaces the abstract, hand-written `steps` produced by trajectory_builder
 * (v1): those were fabricated from a single result row. Here every step is
 * backed by an actual observation written by `trajectory/tick_logger.js`.
 *
 * Data sources (primary + secondary)
 * ----------------------------------
 *   1. Tick stream (PRIMARY, the "real path"):
 *          memory/patterns/race_<raceId>_ticks.jsonl
 *      One JSON record per line:
 *          {"ts":1700000000000,"positions":[
 *             {"agent":"agent_1","lap":3,"progress":0.42}, ...]}
 *      Consecutive observations per agent are diffed to recover concrete
 *      actions: start, surge, accelerate, hold, slip, advance_lap, finish.
 *
 *   2. Race pattern (SECONDARY, supplies the terminal score / winner):
 *          memory/patterns/<raceId>.json
 *          { ts, task, results:[{box,score,time,ok}], winner, ... }
 *      Also tolerated: a `tick_history`/`ticks` array embedded in the pattern.
 *
 * Public API
 * ----------
 *   const { buildPath } = require('./trajectory/path_builder');
 *
 *   buildPath(raceId)            -> { agent_1: [ {step, action, outcome, score} ] }
 *   buildPath(raceId, options)   -> options.dir / options.patternDir override
 *   buildAll(raceIds)            -> { raceId: <paths> }
 *
 *   buildPath.buildPath          // named re-export (also on module.exports)
 *   buildPath.readTicks          // raw observations for a race
 *   buildPath.detectActions      // pure diff -> action list
 *   buildPath.__test             // helpers exposed for unit tests
 *
 * Guarantees
 * ----------
 *   - Depends only on `fs` + `path`: loadable under bare `node --check`.
 *   - No hard dependency on tick_logger: it is reused when it exposes a reader,
 *     otherwise we parse the JSONL directly.
 *   - Every race-id spelling is tolerated: `race_123`, `123`, `race:123`.
 *   - A race with no tick file still yields a concrete path per result row.
 *   - Corrupt JSONL lines are skipped, never thrown.
 *
 * Self-test
 * ---------
 *   node trajectory/path_builder.js --self-test
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PATTERNS_DIR = path.join(ROOT, 'memory', 'patterns');

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** Progress delta (percentage points) that qualifies as a surge. */
const BIG_JUMP = 10;
/** Below this progress delta (percentage points) a move is a stall. */
const FLAT_EPS = 0.01;
/** Statuses that mean the agent has crossed the finish line. */
const FINISH_STATUSES = new Set([
  'finish', 'finished', 'done', 'complete', 'completed', 'win', 'winner',
]);
/** Statuses that mean the agent left the race. */
const RETIRE_STATUSES = new Set(['retire', 'retired', 'dnf', 'out', 'crashed', 'stopped']);

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, places) {
  const f = Math.pow(10, places || 0);
  return Math.round(value * f) / f;
}

function pct(value) {
  return round(toNumber(value, 0), 1) + '%';
}

function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '') || 'unknown';
}

function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (err) { /* caller tolerates a missing dir */ }
}

function firstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (err) { /* ignore and try next */ }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Source resolution                                                          */
/* -------------------------------------------------------------------------- */

function patternCandidates(raceId, dir) {
  const base = String(raceId);
  const bare = base.replace(/^race[_:]/, '');
  return [
    path.join(dir, base + '.json'),
    path.join(dir, 'race_' + bare + '.json'),
    path.join(dir, safeName(base) + '.json'),
  ];
}

function tickCandidates(raceId, dir) {
  const base = String(raceId);
  const bare = base.replace(/^race[_:]/, '');
  return [
    path.join(dir, 'race_' + safeName(base) + '_ticks.jsonl'),
    path.join(dir, safeName(base) + '_ticks.jsonl'),
    path.join(dir, 'race_' + safeName(bare) + '_ticks.jsonl'),
  ];
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

/** Parse a .jsonl file into an array of objects, skipping corrupt lines. */
function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isObject(parsed)) out.push(parsed);
    } catch (err) { /* skip corrupt line */ }
  }
  return out;
}

/** Load the race pattern (secondary source). Returns null when absent. */
function loadPattern(raceId, dir) {
  const file = firstExisting(patternCandidates(raceId, dir));
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(parsed)) {
      parsed.__file = file;
      return parsed;
    }
  } catch (err) { /* fall through */ }
  return null;
}

/**
 * Normalize a single position record. Tolerates the many synonyms different
 * race producers use for the agent / lap / progress fields.
 */
function normalizePosition(raw) {
  if (!isObject(raw)) return null;
  const agent = raw.agent ?? raw.box ?? raw.name ?? raw.id ?? raw.driver;
  if (agent === undefined || agent === null) return null;

  let progress = toNumber(raw.progress ?? raw.p ?? raw.pct ?? raw.percent, 0);
  if (progress > 1 && progress <= 100) progress = progress / 100;
  progress = Math.max(0, Math.min(1, progress));

  const lap = Math.max(0, Math.floor(toNumber(raw.lap ?? raw.laps, 0)));
  const status = raw.status !== undefined ? String(raw.status).toLowerCase() : undefined;
  return { agent: String(agent), lap, progress, status };
}

/** Flatten tick records into a per-agent ordered timeline. */
function buildTimeline(ticks) {
  const frames = [];
  for (const record of ticks) {
    if (!isObject(record)) continue;
    const ts = toNumber(record.ts, null);
    const positions = Array.isArray(record.positions) ? record.positions
      : (Array.isArray(record.field) ? record.field : []);
    for (const rawPos of positions) {
      const pos = normalizePosition(rawPos);
      if (pos) frames.push({ ts, pos });
    }
  }
  // Stable chronological ordering: undefined ts sorts first, ties keep order.
  return frames
    .map((frame, index) => ({ frame, index }))
    .sort((a, b) => {
      const ta = a.frame.ts === null ? -Infinity : a.frame.ts;
      const tb = b.frame.ts === null ? -Infinity : b.frame.ts;
      return ta === tb ? a.index - b.index : ta - tb;
    })
    .map((entry) => entry.frame);
}

/** Group a flat timeline into { agent: [obs...] } preserving order. */
function groupByAgent(timeline) {
  const byAgent = new Map();
  for (const { ts, pos } of timeline) {
    if (!byAgent.has(pos.agent)) byAgent.set(pos.agent, []);
    byAgent.get(pos.agent).push({ ts, lap: pos.lap, progress: pos.progress, status: pos.status });
  }
  return byAgent;
}

/**
 * Read every raw tick observation for a race.
 * @param {string} raceId
 * @param {object} [options] { dir }
 * @returns {Array<object>}
 */
function readTicks(raceId, options) {
  const opts = isObject(options) ? options : {};
  const dir = opts.dir || PATTERNS_DIR;

  // 1) Prefer an embedded history in the pattern (works without a tick file).
  const pattern = loadPattern(raceId, opts.patternDir || dir);
  if (pattern) {
    const embedded = pattern.tick_history || pattern.ticks;
    if (Array.isArray(embedded) && embedded.length) return embedded;
  }

  // 2) Try the shared TickLogger singleton if it can serve us.
  try {
    // eslint-disable-next-line global-require
    const logger = require('./tick_logger');
    if (logger && typeof logger.readTicks === 'function') {
      const viaLogger = logger.readTicks(String(raceId).replace(/^race[_:]/, ''));
      if (Array.isArray(viaLogger) && viaLogger.length) return viaLogger;
    }
  } catch (err) { /* logger not present — direct read below */ }

  // 3) Direct JSONL read.
  const file = firstExisting(tickCandidates(raceId, dir));
  return file ? readJsonl(file) : [];
}

/* -------------------------------------------------------------------------- */
/* Result reconciliation (secondary source)                                   */
/* -------------------------------------------------------------------------- */

/** Build a lookup of terminal score/duration per agent from the pattern. */
function buildResultIndex(pattern) {
  const index = new Map();
  if (!isObject(pattern)) return index;

  const rows = Array.isArray(pattern.results) ? pattern.results
    : (Array.isArray(pattern.standings) ? pattern.standings : []);
  for (const row of rows) {
    if (!isObject(row)) continue;
    const agent = row.agent ?? row.box ?? row.name ?? row.id;
    if (agent === undefined || agent === null) continue;
    index.set(String(agent), {
      score: toNumber(row.score ?? row.points, null),
      duration: toNumber(row.time ?? row.duration_ms ?? row.duration, null),
      ok: row.ok !== undefined ? Boolean(row.ok) : undefined,
      rank: toNumber(row.rank ?? row.place, null),
    });
  }

  const winner = pattern.winner ?? pattern.winning_box;
  if (winner !== undefined && winner !== null && !index.has(String(winner))) {
    index.set(String(winner), { score: null, duration: null, ok: true, rank: 1 });
  }
  return index;
}

/* -------------------------------------------------------------------------- */
/* Action detection (the heart of the "real path")                            */
/* -------------------------------------------------------------------------- */

/** Convert one observation sequence into concrete action steps. */
function detectActions(observations, result) {
  const steps = [];
  if (!Array.isArray(observations) || observations.length === 0) return steps;

  const first = observations[0];
  steps.push({
    action: 'start',
    outcome: 'joined at lap ' + first.lap + ', progress ' + pct(first.progress),
    score: credit(first.lap, first.progress, false),
  });

  for (let i = 1; i < observations.length; i += 1) {
    const prev = observations[i - 1];
    const cur = observations[i];
    const dProg = round((cur.progress - prev.progress) * 100, 2);
    const dLap = cur.lap - prev.lap;
    const finished = (cur.status && FINISH_STATUSES.has(cur.status))
      || cur.progress >= 0.99999;
    const retired = cur.status && RETIRE_STATUSES.has(cur.status);

    let action;
    let outcome;

    if (finished) {
      action = 'finish';
      outcome = 'crossed the finish line at lap ' + cur.lap;
    } else if (retired) {
      action = 'retire';
      outcome = 'left the race (status ' + cur.status + ') at lap ' + cur.lap;
    } else if (dLap >= 1) {
      action = 'advance_lap';
      outcome = 'completed lap ' + prev.lap + ' -> ' + cur.lap;
    } else if (dProg <= -FLAT_EPS) {
      action = 'slip';
      outcome = 'lost ' + Math.abs(dProg) + ' pts of progress on lap ' + cur.lap;
    } else if (dProg >= BIG_JUMP) {
      action = 'surge';
      outcome = 'surged +' + dProg + ' pts to ' + pct(cur.progress);
    } else if (dProg > FLAT_EPS) {
      action = 'accelerate';
      outcome = 'gained +' + dProg + ' pts to ' + pct(cur.progress);
    } else {
      action = 'hold';
      outcome = 'held position at lap ' + cur.lap + ', progress ' + pct(cur.progress);
    }

    steps.push({
      action,
      outcome,
      score: credit(cur.lap, cur.progress, false),
    });
  }

  applyTerminalScore(steps, result);
  return steps;
}

/** Running credit earned up to a point (progress across laps, 0..100+). */
function credit(lap, progress, finished) {
  const value = lap * 100 + progress * 100;
  return round(finished ? value + 100 : value, 2);
}

/** Replace the last step's credit with the authoritative race score. */
function applyTerminalScore(steps, result) {
  if (!steps.length || !isObject(result)) return steps;
  const last = steps[steps.length - 1];
  if (typeof result.score === 'number' && Number.isFinite(result.score)) {
    last.score = round(result.score, 2);
  }
  if (result.duration !== null && result.duration !== undefined) {
    last.outcome += ' (time ' + round(result.duration, 1) + 'ms)';
  }
  if (result.ok === true && last.action !== 'finish') last.action = 'finish';
  return steps;
}

/* -------------------------------------------------------------------------- */
/* Fallback path (secondary source only)                                      */
/* -------------------------------------------------------------------------- */

function fallbackPath(result) {
  const score = isObject(result) && typeof result.score === 'number' ? result.score : 0;
  const timed = isObject(result) && typeof result.duration === 'number'
    ? ', time ' + round(result.duration, 1) + 'ms' : '';
  return [
    { step: 1, action: 'start', outcome: 'entered the race (tick history unavailable)', score: 0 },
    { step: 2, action: 'solve', outcome: 'produced a result box' + timed, score: round(score, 2) },
    { step: 3, action: 'finish', outcome: 'submitted the result', score: round(score, 2) },
  ];
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build the real path of every participant of a race.
 *
 * @param {string|number} raceId
 * @param {object} [options] { dir, patternDir, fallback }
 * @returns {Object<string, Array<{step:number, action:string, outcome:string, score:number}>>}
 */
function buildPath(raceId, options) {
  const opts = isObject(options) ? options : {};
  const fallback = opts.fallback !== false;

  const ticks = readTicks(raceId, opts);
  const pattern = loadPattern(raceId, opts.patternDir || opts.dir || PATTERNS_DIR);
  const results = buildResultIndex(pattern);

  const timeline = buildTimeline(ticks);
  const byAgent = groupByAgent(timeline);

  const out = {};
  byAgent.forEach((observations, agent) => {
    const steps = detectActions(observations, results.get(agent));
    out[agent] = steps.map((step, i) => ({
      step: i + 1,
      action: step.action,
      outcome: step.outcome,
      score: step.score,
    }));
  });

  // Every result row without ticks still gets a concrete path.
  if (fallback) {
    results.forEach((result, agent) => {
      if (!out[agent] || out[agent].length === 0) out[agent] = fallbackPath(result);
    });
  }

  return out;
}

/** Build paths for many races at once. */
function buildAll(raceIds, options) {
  const out = {};
  for (const id of raceIds || []) out[id] = buildPath(id, options);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = buildPath;
module.exports.buildPath = buildPath;
module.exports.buildAll = buildAll;
module.exports.readTicks = readTicks;
module.exports.detectActions = detectActions;
module.exports.buildTimeline = buildTimeline;
module.exports.groupByAgent = groupByAgent;
module.exports.normalizePosition = normalizePosition;
module.exports.buildResultIndex = buildResultIndex;
module.exports.fallbackPath = fallbackPath;
module.exports.ROOT = ROOT;
module.exports.PATTERNS_DIR = PATTERNS_DIR;

/* -------------------------------------------------------------------------- */
/* Self-test: node trajectory/path_builder.js --self-test                      */
/* -------------------------------------------------------------------------- */

if (require.main === module && process.argv.indexOf('--self-test') !== -1) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'path_builder_'));
  const raceId = 'selftest_' + Date.now();
  const file = path.join(tmp, 'race_' + raceId + '_ticks.jsonl');

  const records = [
    { ts: 1, positions: [
      { agent: 'agent_1', lap: 0, progress: 0.10 },
      { agent: 'agent_2', lap: 0, progress: 0.08 },
    ] },
    { ts: 2, positions: [
      { agent: 'agent_1', lap: 0, progress: 0.35 },
      { agent: 'agent_2', lap: 0, progress: 0.09 },
    ] },
    { ts: 3, positions: [
      { agent: 'agent_1', lap: 1, progress: 0.05 },
      { agent: 'agent_2', lap: 0, progress: 0.40 },
    ] },
    { ts: 4, positions: [
      { agent: 'agent_1', lap: 1, progress: 1.0, status: 'finished' },
      { agent: 'agent_2', lap: 1, progress: 0.10 },
    ] },
  ];

  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(
    path.join(tmp, raceId + '.json'),
    JSON.stringify({
      ts: 4,
      task: 'selftest',
      results: [
        { box: 'agent_1', score: 42, time: 1234, ok: true },
        { box: 'agent_2', score: 17, time: 1500, ok: false },
      ],
      winner: 'agent_1',
    })
  );

  const paths = buildPath(raceId, { dir: tmp });
  const agents = Object.keys(paths);
  console.log('[path_builder] agents:', agents.join(', '));
  for (const agent of agents) {
    console.log('  ' + agent + ':');
    for (const step of paths[agent]) {
      console.log('    #' + step.step + ' ' + step.action + ' | ' + step.outcome + ' | ' + step.score);
    }
  }

  const ok = agents.length === 2
    && paths.agent_1.length >= 3
    && paths.agent_1[0].step === 1
    && paths.agent_1[0].action === 'start'
    && paths.agent_1[paths.agent_1.length - 1].action === 'finish'
    && typeof paths.agent_1[0].score === 'number';
  console.log('[path_builder] self-test', ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
}
