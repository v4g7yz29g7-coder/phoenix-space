// replay_worker.js — Реплей-воркер (Nature 2024)
// Ночной перезапуск топ-100 траекторий из memory/trajectories/.
// Извлекает паттерны путей и генерирует 5 задач для Архитектора
// (пишет в tasks_night_pool.json под group='replay_worker' через pool_lock).
//
// Управление: pm2 (резидент --guard) + cron 02:00 (--once).
//
// Режимы:
//   node replay_worker.js --once      одноразовый прогон (для cron), с дневным guard
//   node replay_worker.js --guard     резидент: сам срабатывает в 02:00 каждый день (для pm2)
//   node replay_worker.js --dry-run   без записи задач в пул
//   node replay_worker.js --force     игнорировать дневной guard
//
// КРИТЕРИЙ: node --check OK.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TRAJ_DIR = path.join(ROOT, 'memory', 'trajectories');
const POOL_FILE = path.join(ROOT, 'tasks_night_pool.json');
const REPORT_FILE = path.join(ROOT, 'memory', 'replay_worker_report.json');
const STATE_FILE = path.join(ROOT, 'memory', 'replay_worker_state.json');
const PATTERNS_DIR = path.join(ROOT, 'memory', 'patterns');
const LOG_FILE = path.join(ROOT, 'memory', 'replay_worker.log');

const TOP_N = 100;          // сколько траекторий перезапускаем/анализируем
const TASKS_PER_RUN = 5;    // сколько задач ставим Архитектору
const RUN_HOUR = 2;         // 02:00 — ночное окно

let pool_lock = null;
try { pool_lock = require('./memory/pool_lock'); } catch (e) { pool_lock = null; }

function log(m) {
  const line = `[REPLAY ${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* тихо */ }
}

// ============ 1. ЧТЕНИЕ ТРАЕКТОРИЙ ============
function parseDurationMs(outcome) {
  const m = /(\d+)\s*ms/.exec(String(outcome || ''));
  return m ? parseInt(m[1], 10) : null;
}

function loadTrajectory(file) {
  try {
    const raw = fs.readFileSync(path.join(TRAJ_DIR, file), 'utf8');
    const j = JSON.parse(raw);
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
  } catch (e) {
    return null;
  }
}

function rankTrajectories(limit) {
  let files = [];
  try {
    files = fs.readdirSync(TRAJ_DIR).filter(f => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
  const trajs = [];
  for (const f of files) {
    const t = loadTrajectory(f);
    if (t) trajs.push(t);
  }
  trajs.sort((a, b) =>
    (b.score - a.score) ||
    ((a.durationMs == null ? 1e9 : a.durationMs) - (b.durationMs == null ? 1e9 : b.durationMs)) ||
    String(b.file).localeCompare(String(a.file))
  );
  return trajs.slice(0, limit || TOP_N);
}

// ============ 2. ИЗВЛЕЧЕНИЕ ПАТТЕРНОВ ============
function extractPatterns(trajs) {
  const actionStats = {};
  const sequences = {};
  const outcomeTokens = {};
  let scoreSum = 0, durSum = 0, durN = 0, okCount = 0;

  for (const t of trajs) {
    scoreSum += t.score;
    if (t.durationMs != null) { durSum += t.durationMs; durN++; }
    if (t.ok) okCount++;

    const seq = t.actions.join(' -> ');
    if (seq) sequences[seq] = (sequences[seq] || 0) + 1;

    for (const s of t.steps) {
      const a = s.action || 'unknown';
      const st = actionStats[a] || (actionStats[a] = { count: 0, scoreSum: 0, msSum: 0, msN: 0 });
      st.count++;
      if (typeof s.score === 'number') st.scoreSum += s.score;
      const ms = parseDurationMs(s.outcome);
      if (ms != null) { st.msSum += ms; st.msN++; }
    }
    for (const o of t.outcomes) {
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
    slowestAction: slowest ? { action: slowest.action, avgMs: slowest.avgMs } : null,
    actions,
    topSequences,
    topOutcomeTokens,
  };
}

// ============ 3. СИНТЕЗ 5 ЗАДАЧ ДЛЯ АРХИТЕКТОРА ============
function synthesizeTasks(patterns, seed) {
  const stamp = (seed || Date.now()).toString(36);
  const avg = patterns.avgScore;
  const seq = (patterns.topSequences[0] && patterns.topSequences[0].seq) || 'старт -> сдача';
  const slow = patterns.slowestAction ? `${patterns.slowestAction.action} (${patterns.slowestAction.avgMs}ms)` : '—';

  const tasks = [
    {
      file: 'tools/replay_report.js',
      min_lines: 120,
      prompt: `CLI-отчёт по реплею траекторий. Читает memory/replay_worker_report.json (сейчас ${patterns.trajectories} траекторий, avgScore ${avg}). Печатает агрегат {trajectories, avg_score, success_rate, top_actions:[{action,count,avgScore}], top_sequence}. Поддержать флаги --last и --json. Топ-последовательность на данных: "${seq}". КРИТЕРИЙ: node --check OK; node tools/replay_report.js --last печатает валидный JSON с полем trajectories > 0.`,
    },
    {
      file: 'replay/pattern_miner.js',
      min_lines: 150,
      prompt: `Вынеси извлечение паттернов из replay_worker.js в переиспользуемый модуль replay/pattern_miner.js. API: mine(dirOrFiles) -> {trajectories, avgScore, successRate, actions, topSequences}. Битые/пустые файлы игнорировать без падения. Самый медленный шаг в данных: ${slow}. КРИТЕРИЙ: node --check OK; require('./replay/pattern_miner').mine('memory/trajectories') возвращает объект, где Array.isArray(actions) === true и actions.length > 0.`,
    },
    {
      file: 'test/replay_worker.test.js',
      min_lines: 150,
      prompt: `Контрактные тесты replay_worker: ранжирование top-N по score (невозрастание), извлечение паттернов на синтетических траекториях, синтез ровно 5 задач с уникальными id. КРИТЕРИЙ: node --check OK; тест ассертит rankTrajectories(100).length <= 100, extractPatterns([...]).actions.length > 0 и synthesizeTasks(patterns).length === 5.`,
    },
    {
      file: 'replay/task_synthesizer.js',
      min_lines: 130,
      prompt: `Модуль синтеза задач Архитектора из паттернов. API: synthesize(patterns, n=5) -> массив {id, group:'replay_worker', file, min_lines, prompt, status:'pending'}. Уникальные id, каждый prompt содержит 'КРИТЕРИЙ:'. КРИТЕРИЙ: node --check OK; synthesize({avgScore:${avg}, topSequences:[]}, 5) даёт ровно 5 уникальных id.`,
    },
    {
      file: 'tools/replay_cron_check.js',
      min_lines: 100,
      prompt: `Проверка расписания реплея: pm2-процесс replay_worker online + cron-строка '0 2 * * *' запускает replay_worker.js --once. Читает crontab и ecosystem/pm2, печатает JSON {pm2:bool, cron:bool, state_last}. Дневной guard держит state в memory/replay_worker_state.json. КРИТЕРИЙ: node --check OK; запуск печатает JSON с полями pm2, cron, state_last.`,
    },
  ];

  return tasks.map((t, i) => ({
    id: `RP-${stamp}-${i + 1}`,
    group: 'replay_worker',
    file: t.file,
    min_lines: t.min_lines,
    prompt: t.prompt,
  })).slice(0, TASKS_PER_RUN);
}

// ============ 4. ДОБАВЛЕНИЕ В ПУЛ (через pool_lock) ============
function appendToPool(tasks) {
  const doIt = () => {
    const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    pool.tasks = pool.tasks || [];
    const ids = new Set(pool.tasks.map(t => t.id));
    const added = [];
    for (const t of tasks) {
      let id = t.id;
      let n = 1;
      while (ids.has(id)) id = `${t.id}-r${++n}`;
      ids.add(id);
      added.push({
        ...t,
        id,
        status: 'pending',
        created_by: 'replay_worker',
        created_at: new Date().toISOString(),
      });
    }
    pool.tasks = pool.tasks.concat(added);
    pool.updated_at = new Date().toISOString();
    fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
    return added;
  };
  if (pool_lock && typeof pool_lock.withLock === 'function') return pool_lock.withLock(doIt);
  return doIt();
}

// ============ 5. ПРОГОН РЕПЛЕЯ ============
function runReplay(opts) {
  opts = opts || {};
  const t0 = Date.now();
  const top = rankTrajectories(TOP_N);
  if (!top.length) {
    log('нет траекторий в ' + TRAJ_DIR);
    return { ok: false, reason: 'no_trajectories' };
  }

  const patterns = extractPatterns(top);
  const tasks = synthesizeTasks(patterns, Date.now());

  const report = {
    ts: new Date().toISOString(),
    mode: 'replay',
    top: TOP_N,
    patterns,
    planned: tasks.map(t => ({ id: t.id, file: t.file })),
    added: [],
    ms: 0,
  };

  try { fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2)); } catch (e) { /* тихо */ }
  try {
    fs.mkdirSync(PATTERNS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PATTERNS_DIR, `replay_${Date.now()}.json`),
      JSON.stringify({ ts: report.ts, patterns }, null, 2)
    );
  } catch (e) { /* тихо */ }

  let added = [];
  if (!opts.dryRun) {
    try {
      added = appendToPool(tasks);
      log(`Архитектору добавлено задач: ${added.length}`);
    } catch (e) {
      log('append fail: ' + e.message);
    }
  } else {
    log('dry-run: задачи не записаны в пул');
  }

  report.added = added.map(t => ({ id: t.id, file: t.file }));
  report.ms = Date.now() - t0;
  try { fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2)); } catch (e) { /* тихо */ }

  log(`топ-${top.length} | avgScore ${patterns.avgScore} | successRate ${patterns.successRate} | actions ${patterns.actions.length} | added ${report.added.length}`);
  return { ok: true, report, added };
}

// ============ 6. ДНЕВНОЙ GUARD + ПЛАНИРОВЩИК ============
function today() { return new Date().toISOString().slice(0, 10); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { /* тихо */ }
}

function alreadyRanToday() {
  const s = loadState();
  return s.lastRunDate === today();
}

function runOnce(opts) {
  opts = opts || {};
  if (!opts.force && alreadyRanToday()) {
    log('уже запускался сегодня — пропуск (--force чтобы повторить)');
    return { skipped: true, reason: 'already_ran_today' };
  }
  let res;
  try {
    res = runReplay(opts);
  } catch (e) {
    log('FATAL runReplay: ' + e.message);
    return { ok: false, reason: e.message };
  }
  if (res.ok) {
    const s = loadState();
    s.lastRunDate = today();
    s.lastRunTs = new Date().toISOString();
    s.trajectories = res.report.patterns.trajectories;
    s.avgScore = res.report.patterns.avgScore;
    s.addedTasks = (res.added || []).length;
    saveState(s);
  }
  return res;
}

function guard() {
  log(`guard запущен: сработаю ежедневно в ${String(RUN_HOUR).padStart(2, '0')}:00`);
  const check = () => {
    try {
      if (new Date().getHours() === RUN_HOUR && !alreadyRanToday()) runOnce({});
    } catch (e) {
      log('guard loop error: ' + e.message);
    }
  };
  check();
  // держим процесс живым и проверяем раз в минуту
  setInterval(check, 60 * 1000);
}

// ============ CLI ============
function main() {
  const args = process.argv.slice(2);
  const opts = {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
  };
  if (args.includes('--guard')) return guard();
  if (args.includes('--loop')) {
    const r = () => { try { runOnce(opts); } catch (e) { log('loop error: ' + e.message); } };
    r();
    setInterval(r, 24 * 60 * 60 * 1000);
    return undefined;
  }
  return runOnce(opts);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    log('FATAL: ' + e.message);
    process.exit(1);
  }
}

module.exports = {
  parseDurationMs,
  loadTrajectory,
  rankTrajectories,
  extractPatterns,
  synthesizeTasks,
  appendToPool,
  runReplay,
  runOnce,
  loadState,
  TOP_N,
  TASKS_PER_RUN,
};
