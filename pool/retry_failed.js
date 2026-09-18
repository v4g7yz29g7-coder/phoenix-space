#!/usr/bin/env node
'use strict';

/**
 * pool/retry_failed.js
 * ---------------------------------------------------------------------------
 * Планировщик ретраев для failed-задач ночного пула с exponential backoff.
 *
 *   attempts = 3
 *   base     = 30s
 *   factor   = 2
 *   cap      = 600s (10 min)
 *   schedule = 30s, 60s, 120s (attempt 1..3), далее упираемся в cap
 *
 * State хранится в pool/retry_state.json, ключ — task_id (НЕ индекс):
 *
 *   {
 *     "version": 1,
 *     "updated_at": "…",
 *     "tasks": {
 *       "P5-OBS-2": {
 *         "attempts": 1,
 *         "last_attempt_at": "…",
 *         "next_attempt_at": "…",
 *         "backoff_seconds": 30,
 *         "status": "scheduled",
 *         "task_status_at_schedule": "failed"
 *       }
 *     }
 *   }
 *
 * Правила (инварианты):
 *   • Задачи со status=completed / in_progress никогда не трогаем.
 *   • Ретраим только status=failed.
 *   • После `attempts >= maxAttempts` задача считается исчерпанной (exhausted)
 *     и больше не eligible.
 *   • Пока now < next_attempt_at — задача ждёт backoff (не eligible).
 *   • Повторный запуск без новых failures идемпотентен: количество попыток
 *     НЕ растёт (ждите backoff / exhausted), размер state не растёт.
 *
 * CLI:
 *   node pool/retry_failed.js --dry-run      # только спланировать, state НЕ пишем
 *   node pool/retry_failed.js                # применить план и записать state
 *   node pool/retry_failed.js --json         # машиночитаемый вывод
 *
 * Печатает строку: `eligible: N`  (N ≤ числу failed-задач).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_POOL = path.join(ROOT, 'tasks_night_pool.json');
const DEFAULT_STATE = path.join(__dirname, 'retry_state.json');

const DEFAULTS = Object.freeze({
  maxAttempts: 3,
  base: 30,
  multiplier: 2,
  cap: 600,
  // Статусы, которые категорически НЕ трогаем.
  skipStatuses: Object.freeze(['completed', 'in_progress']),
  retryStatus: 'failed',
});

/* ========================================================================= *
 * Backoff
 * ========================================================================= */

/**
 * Задержка для конкретной попытки (1-based).
 *   computeBackoff(1) -> 30
 *   computeBackoff(2) -> 60
 *   computeBackoff(3) -> 120
 *   computeBackoff(6) -> 600 (cap)
 */
function computeBackoff(attempt, opts = {}) {
  const base = numOr(opts.base, DEFAULTS.base);
  const multiplier = numOr(opts.multiplier, DEFAULTS.multiplier);
  const cap = numOr(opts.cap, DEFAULTS.cap);
  const a = Math.max(1, Math.floor(numOr(attempt, 1)));
  const raw = base * Math.pow(multiplier, a - 1);
  return Math.min(cap, raw);
}

/** Полное расписание задержек для `attempts` попыток. */
function backoffSchedule(attempts, opts = {}) {
  const n = Math.max(0, Math.floor(numOr(attempts, DEFAULTS.maxAttempts)));
  const out = [];
  for (let i = 1; i <= n; i += 1) out.push(computeBackoff(i, opts));
  return out;
}

/* ========================================================================= *
 * State helpers
 * ========================================================================= */

function emptyState() {
  return { version: 1, updated_at: null, tasks: {} };
}

function normalizeState(state) {
  const s = state && typeof state === 'object' ? state : {};
  if (!s.tasks || typeof s.tasks !== 'object' || Array.isArray(s.tasks)) s.tasks = {};
  if (!s.version) s.version = 1;
  return s;
}

function loadState(file = DEFAULT_STATE) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return emptyState();
    return normalizeState(JSON.parse(raw));
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyState();
    throw new Error(`retry_state unreadable (${file}): ${err.message}`);
  }
}

function saveState(file, state) {
  const normalized = normalizeState(state);
  normalized.updated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2) + '\n');
  return normalized;
}

function loadPool(file = DEFAULT_POOL) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  return Array.isArray(parsed.tasks) ? parsed.tasks : [];
}

/* ========================================================================= *
 * Eligibility
 * ========================================================================= */

function isTerminalStatus(status, opts = {}) {
  const skip = opts.skipStatuses || DEFAULTS.skipStatuses;
  return skip.indexOf(status) !== -1;
}

/**
 * Детальный разбор одной задачи.
 * @returns {{eligible:boolean, reason:string, task_id:string, attempts:number,
 *            nextAttempt:number, delay:number}}
 */
function inspect(task, state, now, opts = {}) {
  const o = mergeOpts(opts);
  const tasks = normalizeState(state).tasks;
  const id = task && (task.id || task.task_id);
  const status = (task && task.status) || 'pending';
  const rec = id != null ? tasks[id] : undefined;
  const attempts = rec && Number.isFinite(rec.attempts) ? rec.attempts : 0;
  const base = { task_id: id, attempts, nextAttempt: attempts + 1 };

  if (id == null || id === '') return { eligible: false, reason: 'no_id', ...base };
  if (isTerminalStatus(status, o)) return { eligible: false, reason: `skip_status:${status}`, ...base };
  if (status !== o.retryStatus) return { eligible: false, reason: `not_failed:${status}`, ...base };
  if (attempts >= o.maxAttempts) return { eligible: false, reason: 'exhausted', ...base };

  if (rec && rec.next_attempt_at) {
    const nextTs = Date.parse(rec.next_attempt_at);
    if (Number.isFinite(nextTs) && nextTs > now.getTime()) {
      return { eligible: false, reason: 'backoff_wait', ...base, next_attempt_at: rec.next_attempt_at };
    }
  }

  return {
    eligible: true,
    reason: 'ok',
    ...base,
    delay: computeBackoff(attempts + 1, o),
  };
}

/** Список eligible-задач (в порядке пула). */
function planEligible(tasks, state, now, opts = {}) {
  const nowDate = toDate(now);
  return (tasks || [])
    .map((t) => ({ task: t, ...inspect(t, state, nowDate, opts) }))
    .filter((r) => r.eligible);
}

function inspectAll(tasks, state, now, opts = {}) {
  const nowDate = toDate(now);
  return (tasks || []).map((t) => ({ task: t, ...inspect(t, state, nowDate, opts) }));
}

/* ========================================================================= *
 * Apply (идемпотентно)
 * ========================================================================= */

/**
 * Применяет план ретраев к state. Возвращает {changed, skipped, exhausted,
 * eligible, results}. Повторный вызов с тем же `now` НЕ меняет state.
 */
function applyRetries(tasks, state, now, opts = {}) {
  const o = mergeOpts(opts);
  const nowDate = toDate(now);
  const s = normalizeState(state);
  const results = [];
  let changed = 0;
  let skipped = 0;
  let exhausted = 0;

  for (const task of tasks || []) {
    const info = inspect(task, s, nowDate, o);
    results.push(info);
    if (!info.eligible) {
      if (info.reason === 'exhausted') exhausted += 1;
      else skipped += 1;
      continue;
    }

    const prev = s.tasks[info.task_id] || { attempts: 0 };
    const attemptNo = (Number.isFinite(prev.attempts) ? prev.attempts : 0) + 1;
    const delay = computeBackoff(attemptNo, o);
    s.tasks[info.task_id] = {
      attempts: attemptNo,
      last_attempt_at: nowDate.toISOString(),
      next_attempt_at: new Date(nowDate.getTime() + delay * 1000).toISOString(),
      backoff_seconds: delay,
      status: attemptNo >= o.maxAttempts ? 'exhausted' : 'scheduled',
      task_status_at_schedule: task.status || 'failed',
    };
    changed += 1;
  }

  return {
    eligible: results.filter((r) => r.eligible).length,
    changed,
    skipped,
    exhausted,
    results,
    state: s,
  };
}

/* ========================================================================= *
 * CLI
 * ========================================================================= */

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, pool: DEFAULT_POOL, state: DEFAULT_STATE, now: new Date(), help: false };
  for (const arg of argv || []) {
    if (arg === '--dry-run' || arg === '-n') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--pool=')) opts.pool = arg.slice('--pool='.length);
    else if (arg.startsWith('--state=')) opts.state = arg.slice('--state='.length);
    else if (arg.startsWith('--now=')) opts.now = toDate(arg.slice('--now='.length));
    else if (arg === '--apply') opts.dryRun = false;
  }
  return opts;
}

function runCli(argv = process.argv.slice(2)) {
  const cli = parseArgs(argv);
  if (cli.help) {
    process.stdout.write(
      'pool/retry_failed.js — ретрай failed-задач (backoff 30/60/120s, cap 600s)\n' +
        '  --dry-run        спланировать без записи state\n' +
        '  --json           машиночитаемый вывод\n' +
        '  --pool=<path>    путь к пулу (default tasks_night_pool.json)\n' +
        '  --state=<path>   путь к state (default pool/retry_state.json)\n' +
        '  --now=<iso|ms>   смоделировать время\n'
    );
    return 0;
  }

  const tasks = loadPool(cli.pool);
  const state = loadState(cli.state);
  const opts = { ...DEFAULTS };

  if (cli.dryRun) {
    const eligible = planEligible(tasks, state, cli.now, opts);
    if (cli.json) {
      process.stdout.write(
        JSON.stringify({ mode: 'dry-run', eligible: eligible.length, task_ids: eligible.map((e) => e.task_id), total: tasks.length }, null, 2) + '\n'
      );
    } else {
      process.stdout.write(`eligible: ${eligible.length}\n`);
      process.stdout.write(`mode: dry-run (state not written)\n`);
      process.stdout.write(`total: ${tasks.length}\n`);
    }
    return 0;
  }

  const result = applyRetries(tasks, state, cli.now, opts);
  const saved = saveState(cli.state, result.state);
  if (cli.json) {
    process.stdout.write(
      JSON.stringify({ mode: 'apply', eligible: result.eligible, changed: result.changed, skipped: result.skipped, exhausted: result.exhausted, scheduled: Object.keys(saved.tasks).length }, null, 2) + '\n'
    );
  } else {
    process.stdout.write(`eligible: ${result.eligible}\n`);
    process.stdout.write(`mode: apply\n`);
    process.stdout.write(`scheduled: ${result.changed}\n`);
    process.stdout.write(`exhausted: ${result.exhausted}\n`);
    process.stdout.write(`state: ${cli.state}\n`);
  }
  return 0;
}

/* ========================================================================= *
 * utils
 * ========================================================================= */

function mergeOpts(opts = {}) {
  return {
    maxAttempts: numOr(opts.maxAttempts, DEFAULTS.maxAttempts),
    base: numOr(opts.base, DEFAULTS.base),
    multiplier: numOr(opts.multiplier, DEFAULTS.multiplier),
    cap: numOr(opts.cap, DEFAULTS.cap),
    skipStatuses: opts.skipStatuses || DEFAULTS.skipStatuses,
    retryStatus: opts.retryStatus || DEFAULTS.retryStatus,
  };
}

function numOr(v, dflt) {
  return Number.isFinite(v) ? v : dflt;
}

function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string' && v) return new Date(v);
  return new Date();
}

module.exports = {
  DEFAULTS,
  DEFAULT_POOL,
  DEFAULT_STATE,
  computeBackoff,
  backoffSchedule,
  emptyState,
  normalizeState,
  loadState,
  saveState,
  loadPool,
  isTerminalStatus,
  inspect,
  inspectAll,
  planEligible,
  applyRetries,
  parseArgs,
  runCli,
  mergeOpts,
};

if (require.main === module) {
  try {
    process.exitCode = runCli();
  } catch (err) {
    process.stderr.write(`retry_failed: ${(err && err.stack) || err}\n`);
    process.exitCode = 1;
  }
}
