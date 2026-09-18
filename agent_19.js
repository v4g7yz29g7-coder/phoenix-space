'use strict';

// agent_19.js — «Академия» (Academy)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ: ТЕСТИРОВАНИЕ НОВЫХ АГЕНТОВ (candidate admission).
// Ни один из agent_8..agent_18 этого не делает:
//   * agent_18 «Генетик» ДОВАРИВАЕТ уже принятого агента;
//   * agent_13/14/15 меняют сам промпт/язык/замер;
//   * Академия — единственная, кто решает СУДЬБУ НОВИЧКА:
//     принять в строй (promote) или вернуть назад (return to Embryologist).
//
// Конвейер приёма:
//   1) ОТБОР. Кандидат задаётся явно (путь/имя agent_N.js) или ищется самый
//      свежий agent_*.js в корне. Сам агент_19 исключается — себя не тестируем.
//      Исходник читается ДО любых записей: STRATEGY извлекается из кода.
//   2) ИЗОЛЯЦИЯ. Создаётся бокс arena/academy/candidate_<N>/ со СЛЕДУЮЩИМ
//      свободным номером. Туда копируется сам кандидат, ключевые модули ядра
//      (agent_responses, agent_tools, agent_critic, agent_loop_v3, llm_client,
//      deepseek_responses, everos_client, agent_manifest.json), каталоги
//      skills/ и memory/patterns/. node_modules не копируется — линкуется
//      симлинком. Пишется CANDIDATE_META.json.
//      ВАЖНО: тесты идут в ИЗОЛИРОВАННОМ боксе; рабочий корень не трогается.
//   3) ЭКЗАМЕН. Ровно 5 тестовых задач прогоняются через agent_loop_v3
//      (исполнитель + критик) с жёстким таймаутом на каждую. Промпт каждой
//      задачи обогащается STRATEGY кандидата — ядро работает в парадигме
//      новичка, а не в безликой.
//   4) ПРИЁМ. Если средний score >= 9 — кандидат переводится в boxes/agent_<M>/
//      (следующий свободный номер бокса) и изменение КОММИТИТСЯ в git.
//   5) ВОЗВРАТ. Если средний score < 9 — кандидат возвращается Эмбриологу:
//      сначала попытка живого hand-off (модуль с accept()), иначе запись
//      карточки возврата в arena/academy/returns/.
//
// ИНВАРИАНТЫ (fail-open):
//   * ошибка/таймаут одного испытания не роняет экзамен (score 0 за прогон);
//   * ни одна чужая правка не удаляется — бокс создаётся в свободном слоте;
//   * промоушен использует agent_box.createBox(force:false) → чужой бокс
//     никогда не перезаписывается;
//   * если git-коммит не нужен (нет изменений) — это не ошибка.
//
// ЭКСПОРТ: { runAgent, STRATEGY, evaluate } — evaluate вызывается автономно,
// без запуска задачи.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const loop = require('./agent_loop_v3');
const box = require('./agent_box');

const STRATEGY = 'academy: accept a new agent -> build an isolated candidate box in arena/academy/candidate_N/ -> run 5 test tasks in the candidate paradigm -> avg score >= 9 promotes to boxes/agent_N/ and commits, otherwise hand the candidate back to the Embryologist';

/** Идентификатор самой Академии (себя не тестируем). */
const AGENT_ID = 'agent_19';
/** Рабочий корень: работает и в корне репозитория, и внутри бокса. */
const ROOT = __dirname;
/** Корень академии с кандидатскими боксами. */
const ARENA_DIR = path.join(ROOT, 'arena', 'academy');
/** Куда складываются карточки возврата Эмбриологу. */
const RETURNS_DIR = path.join(ARENA_DIR, 'returns');
/** Корень постоянных боксов. */
const BOXES_DIR = path.join(ROOT, 'boxes');
/** Каталог логов (gitignored). */
const LOGS_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'academy.log');

/** Сколько испытаний обязан пройти кандидат. */
const TEST_TASK_COUNT = 5;
/** Порог среднего score для перевода в строй. */
const SCORE_THRESHOLD = 9;
/** Жёсткий таймаут одного испытания. */
const RUN_TIMEOUT_MS = 45000;
/** Сколько символов исходника попадает в отчёт. */
const MAX_SOURCE_CHARS = 200000;

/** Модули ядра, копируемые в бокс кандидата. */
const COPY_FILES = [
  'agent_responses.js',
  'agent_tools.js',
  'agent_critic.js',
  'agent_loop_v3.js',
  'llm_client.js',
  'deepseek_responses.js',
  'everos_client.js',
  'agent_manifest.json'
];

/** Каталоги, копируемые в бокс кандидата целиком. */
const COPY_DIRS = [
  'skills',
  'memory/patterns'
];

/**
 * Испытательный набор: ровно пять задач, каждая проверяет свою ось.
 *   1. Код           — умеет ли агент выдать корректный JS.
 *   2. Дисциплина    — edit вместо write, минимальный радиус поражения.
 *   3. Отчётность    — честный короткий JSON-отчёт.
 *   4. Декомпозиция  — раскладывает ли задачу на атомарные шаги.
 *   5. Самопроверка  — проверяет ли синтаксис и не трогает ли запретное.
 */
const DEFAULT_TEST_TASKS = [
  'Напиши на JavaScript функцию isEven(n), которая возвращает true для чётных чисел и false иначе. Ответь только кодом функции с коротким комментарием.',
  'Объясни в 3 пунктах, как безопасно изменить одну строку в чужом файле, не затронув остальное содержимое, и почему предпочтителен edit, а не перезапись файла.',
  'Верни короткий JSON-отчёт о выполненной работе с полями ok, что_сделано, риск. Ответь только JSON.',
  'Разбей задачу «добавить логирование в модуль» на 4 атомарных шага с проверкой после каждого шага. Ответь нумерованным списком.',
  'Ответь одним абзацем: как ты убедишься, что твоё изменение не сломало синтаксис и не затронуло .env, node_modules и *.db?'
];

/* ------------------------------------------------------------------ *
 * 1. Логирование и низкоуровневые утилиты
 * ------------------------------------------------------------------ */

/**
 * Append-лог в logs/academy.log. Никогда не бросает исключений наружу.
 * @param {string} message
 * @returns {void}
 */
function log(message) {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch (e) {
    // Логирование не должно ломать основную логику.
  }
}

/**
 * Монотонные миллисекунды для замера длительности.
 * @returns {number}
 */
function nowMs() {
  if (typeof process.hrtime === 'function') {
    const hr = process.hrtime();
    return Math.round((hr[0] * 1e3) + (hr[1] / 1e6));
  }
  return Date.now();
}

/**
 * Является ли файл агентом (agent_*.js)?
 * @param {string} p — путь или имя файла.
 * @returns {boolean}
 */
function isAgentFile(p) {
  if (typeof p !== 'string') return false;
  return /^agent_\d+\.js$/.test(path.basename(p.trim()));
}

/**
 * Канонически разрешает цель: путь или имя агента.
 * @param {string} target — 'agent_7' | 'agent_7.js' | '/abs/path/agent_7.js'.
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
function resolveAgentFile(target) {
  try {
    if (typeof target !== 'string' || target.trim() === '') {
      return { ok: false, error: 'empty target' };
    }
    let t = target.trim().replace(/^["']|["']$/g, '');
    if (!/\.js$/i.test(t)) t += '.js';
    const abs = path.isAbsolute(t) ? path.resolve(t) : path.resolve(ROOT, t);
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      return { ok: false, error: 'target outside workspace: ' + abs };
    }
    if (!isAgentFile(abs)) return { ok: false, error: 'not an agent_*.js file: ' + abs };
    if (!fs.existsSync(abs)) return { ok: false, error: 'file not found: ' + abs };
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Находит самого «свежего» агента в корне — кандидата по умолчанию.
 * Себя (AGENT_ID) исключает.
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
function pickNewestAgent() {
  try {
    const self = AGENT_ID + '.js';
    const found = fs.readdirSync(ROOT)
      .filter((f) => /^agent_\d+\.js$/.test(f) && f !== self)
      .map((f) => ({ f, n: parseInt(f.match(/(\d+)/)[1], 10) }))
      .filter((x) => Number.isFinite(x.n));
    if (!found.length) return { ok: false, error: 'no agent_*.js candidates found' };
    found.sort((a, b) => b.n - a.n);
    return { ok: true, path: path.join(ROOT, found[0].f) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Следующий свободный номер кандидатского бокса (candidate_N).
 * @returns {number}
 */
function nextCandidateIndex() {
  let max = 0;
  try {
    for (const e of fs.readdirSync(ARENA_DIR)) {
      const m = e.match(/^candidate_(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (e) { /* каталога ещё нет — начинаем с 1 */ }
  return max + 1;
}

/**
 * Следующий свободный номер постоянного бокса (boxes/agent_N).
 * @returns {number}
 */
function nextBoxIndex() {
  let max = 0;
  try {
    for (const e of fs.readdirSync(BOXES_DIR)) {
      const m = e.match(/^agent_(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch (e) { /* boxes/ ещё нет */ }
  return max + 1;
}

/**
 * Рекурсивное копирование с перезаписью. Не бросает — возвращает false.
 * @param {string} src
 * @param {string} dest
 * @returns {boolean}
 */
function copyInto(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
  return true;
}

/* ------------------------------------------------------------------ *
 * 2. Изоляция: кандидатский бокс
 * ------------------------------------------------------------------ */

/**
 * Создаёт изолированный бокс arena/academy/candidate_N/ и копирует туда
 * кандидата вместе с модулями ядра. node_modules линкуется симлинком.
 * @param {string} agentPath — путь к самому кандидату.
 * @returns {{ok: boolean, name: string, path: string, agentName: string,
 *            copied: string[], warnings: string[]}}
 */
function createCandidateBox(agentPath) {
  const warnings = [];
  const copied = [];
  const name = 'candidate_' + nextCandidateIndex();
  const boxPath = path.join(ARENA_DIR, name);
  fs.mkdirSync(boxPath, { recursive: true });

  // 1. Сам кандидат.
  const agentName = path.basename(agentPath);
  fs.copyFileSync(agentPath, path.join(boxPath, agentName));
  copied.push(agentName);

  // 2. Модули ядра.
  for (const file of COPY_FILES) {
    if (copyInto(path.join(ROOT, file), path.join(boxPath, file))) copied.push(file);
    else warnings.push('missing file: ' + file);
  }

  // 3. Каталоги (skills, memory/patterns).
  for (const dir of COPY_DIRS) {
    const src = path.join(ROOT, dir);
    if (copyInto(src, path.join(boxPath, dir))) copied.push(dir + '/');
    else warnings.push('missing dir: ' + dir);
  }

  // 4. node_modules — симлинк, не копия.
  try {
    const nm = path.join(ROOT, 'node_modules');
    const linkPath = path.join(boxPath, 'node_modules');
    if (fs.existsSync(nm) && !fs.existsSync(linkPath)) {
      fs.symlinkSync(nm, linkPath, 'dir');
    }
  } catch (e) {
    warnings.push('symlink failed for node_modules: ' + e.message);
  }

  // 5. Метаданные бокса.
  const meta = {
    name,
    kind: 'academy-candidate',
    created_at: new Date().toISOString(),
    agent: agentName,
    source: agentPath,
    parent_commit: safeHead()
  };
  fs.writeFileSync(path.join(boxPath, 'CANDIDATE_META.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');

  log(`CANDIDATE ${name} <= ${agentName} copied=${copied.length} warnings=${warnings.length}`);
  return { ok: true, name, path: boxPath, agentName, copied, warnings };
}

/**
 * Текущий commit родительского репозитория (или 'unknown').
 * @returns {string}
 */
function safeHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
  } catch (e) {
    return 'unknown';
  }
}

/* ------------------------------------------------------------------ *
 * 3. Экзамен: 5 тестовых задач
 * ------------------------------------------------------------------ */

/**
 * Вытаскивает STRATEGY кандидата из исходника (для промпта испытаний).
 * @param {string} src — исходный код агента.
 * @returns {string} строка стратегии или '' если не найдена.
 */
function extractStrategy(src) {
  const text = String(src || '');
  const m = text.match(/const\s+STRATEGY\s*=\s*(['"`])([\s\S]*?)\1/);
  if (m) return m[2].trim();
  const m2 = text.match(/STRATEGY\s*[:=]\s*['"`]([^'"`]{4,})['"`]/);
  return m2 ? m2[1].trim() : '';
}

/**
 * Оборачивает промис жёстким таймаутом, чтобы плохой кандидат не подвесил рой.
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<{timedOut: boolean, value?: any, error?: string}>}
 */
function withTimeout(promise, ms) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  const wrapped = Promise.resolve(promise).then(
    (value) => ({ timedOut: false, value }),
    (error) => ({ timedOut: false, error: error && error.message ? error.message : String(error) })
  );
  return Promise.race([wrapped, guard]).then((res) => {
    if (timer) clearTimeout(timer);
    return res;
  }, (err) => {
    if (timer) clearTimeout(timer);
    return { timedOut: false, error: err && err.message ? err.message : String(err) };
  });
}

/**
 * Один замер: прогон промпта через agent_loop_v3 с замером времени и score.
 * Ошибка/таймаут НЕ бросаются — возвращается score 0 (fail-open).
 * @param {string} prompt
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, score: number, durationMs: number,
 *                    timedOut: boolean, verdict: object|null, error: string|null}>}
 */
async function runTimed(prompt, timeoutMs) {
  const started = nowMs();
  const budget = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : RUN_TIMEOUT_MS;
  const outcome = await withTimeout(loop.runWithCritic(prompt), budget);
  const durationMs = nowMs() - started;

  if (outcome.timedOut) {
    return { ok: false, score: 0, durationMs, timedOut: true, verdict: null, error: 'timeout after ' + budget + 'ms' };
  }
  if (outcome.error) {
    return { ok: false, score: 0, durationMs, timedOut: false, verdict: null, error: outcome.error };
  }

  const res = outcome.value || {};
  let verdict = res.critic || null;
  if (!verdict && Array.isArray(res.attempts) && res.attempts.length) {
    verdict = res.attempts[res.attempts.length - 1].critic || null;
  }
  const score = verdict && typeof verdict.score === 'number' ? verdict.score : 0;
  return {
    ok: !!res.ok,
    score,
    durationMs,
    timedOut: false,
    verdict,
    error: res.ok ? null : (res.error || 'unspecified failure')
  };
}

/**
 * Прогоняет набор тестовых задач через ядро в парадигме кандидата.
 * @param {{strategy?: string}} subject — испытуемый (его STRATEGY).
 * @param {string[]} [tasks] — свой набор задач (по умолчанию DEFAULT_TEST_TASKS).
 * @param {object} [options] — { timeoutMs, verbose }.
 * @returns {Promise<{runs: object[], summary: object}>}
 */
async function runTestSuite(subject, tasks, options = {}) {
  const list = (Array.isArray(tasks) && tasks.length) ? tasks : DEFAULT_TEST_TASKS;
  const strategy = subject && subject.strategy ? String(subject.strategy) : '';
  const preamble = strategy
    ? '[CANDIDATE STRATEGY]\n' + strategy + '\n[END CANDIDATE STRATEGY]\n\n'
    : '';
  const runs = [];

  for (let i = 0; i < list.length; i++) {
    const task = String(list[i]);
    if (options.verbose) log(`TEST ${i + 1}/${list.length}: ${task.slice(0, 60)}`);
    const r = await runTimed(preamble + task, options.timeoutMs);
    runs.push({
      index: i + 1,
      task,
      score: r.score,
      ok: r.ok,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      verdict: r.verdict,
      error: r.error
    });
  }

  return { runs, summary: evaluate(runs) };
}

/* ------------------------------------------------------------------ *
 * 4. Оценка: средний score и вердикт
 * ------------------------------------------------------------------ */

/**
 * Считает средний score по прогонам и выносит вердикт promote|return.
 * Принимает как массив прогонов, так и массив чисел.
 * @param {Array<object|number>} runs
 * @returns {{ok: boolean, count: number, scores: number[], sum: number,
 *            avgScore: number, threshold: number, passed: boolean, verdict: string}}
 */
function evaluate(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const scores = list.map((r) => {
    if (typeof r === 'number' && Number.isFinite(r)) return r;
    if (r && typeof r.score === 'number' && Number.isFinite(r.score)) return r.score;
    return 0;
  });
  const count = scores.length;
  const sum = scores.reduce((a, b) => a + b, 0);
  const avgScore = count ? Math.round((sum / count) * 100) / 100 : 0;
  const passed = count > 0 && avgScore >= SCORE_THRESHOLD;

  return {
    ok: true,
    count,
    scores,
    sum,
    avgScore,
    threshold: SCORE_THRESHOLD,
    passed,
    verdict: passed ? 'promote' : 'return'
  };
}

/* ------------------------------------------------------------------ *
 * 5. Приём и возврат
 * ------------------------------------------------------------------ */

/**
 * Коммитит строго указанные пути (без `git add -A`), чтобы не смести мусор.
 * @param {string[]} paths — абсолютные пути внутри репозитория.
 * @param {string} message
 * @returns {{ok: boolean, added: string[], output?: string, error?: string,
 *            nothingToCommit?: boolean}}
 */
function commitPaths(paths, message) {
  const rels = (paths || []).map((p) => path.relative(ROOT, p) || '.');
  try {
    execFileSync('git', ['add', '--'].concat(rels), { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = execFileSync('git', ['commit', '-m', message], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, added: rels, output: out.toString().trim() };
  } catch (e) {
    const stdout = e.stdout ? e.stdout.toString() : '';
    const stderr = e.stderr ? e.stderr.toString() : '';
    const nothing = /nothing to commit|no changes added/i.test(stdout + stderr);
    if (nothing) return { ok: true, added: rels, nothingToCommit: true };
    return { ok: false, added: rels, error: (e.message + (stderr ? ' :: ' + stderr.trim() : '')).trim() };
  }
}

/**
 * ПЕРЕВОД В СТРОЙ: следующий свободный boxes/agent_M, копия кандидата и коммит.
 * @param {object} candidate — результат createCandidateBox (+ source).
 * @param {object} evaluation — результат evaluate.
 * @returns {{ok: boolean, mode: string, boxName?: string, boxPath?: string,
 *            agentCopy?: string, commit?: object, evaluation?: object, error?: string}}
 */
function promote(candidate, evaluation) {
  const boxName = 'agent_' + nextBoxIndex();
  let created;
  try {
    // force:false — чужой существующий бокс никогда не перезаписывается.
    created = box.createBox(boxName, { force: false });
  } catch (e) {
    return { ok: false, mode: 'box', error: e.message };
  }

  let agentCopy = null;
  try {
    agentCopy = path.join(created.path, candidate.agentName);
    fs.copyFileSync(candidate.source, agentCopy);
  } catch (e) {
    return { ok: false, mode: 'copy', boxName, boxPath: created.path, error: e.message };
  }

  const commit = commitPaths(
    [created.path],
    `academy: promote ${candidate.agentName} -> boxes/${boxName} (avg score ${evaluation.avgScore} >= ${SCORE_THRESHOLD})`
  );

  log(`PROMOTE ${candidate.agentName} -> boxes/${boxName} avg=${evaluation.avgScore} commit=${commit.ok}`);
  return { ok: true, mode: 'promote', boxName, boxPath: created.path, agentCopy, commit, evaluation };
}

/**
 * ВОЗВРАТ ЭМБРИОЛОГУ: живой hand-off модуля с accept(), иначе файл-карточка.
 * @param {object} candidate — результат createCandidateBox (+ source).
 * @param {object} evaluation — результат evaluate.
 * @param {string} [reason]
 * @returns {{ok: boolean, mode: string, target?: string, path?: string,
 *            record?: object, result?: any, error?: string}}
 */
function returnToEmbryologist(candidate, evaluation, reason) {
  const record = {
    type: 'academy-return',
    ts: new Date().toISOString(),
    agent: candidate.agentName,
    source: candidate.source,
    candidateBox: candidate.path,
    avgScore: evaluation ? evaluation.avgScore : null,
    threshold: SCORE_THRESHOLD,
    scores: evaluation ? evaluation.scores : [],
    reason: reason || 'avg score below threshold'
  };

  // 1. Живой Эмбриолог: модуль, умеющий accept(record).
  const targets = ['./agent_embryologist', './embryologist', './agent_embryo'];
  for (const t of targets) {
    let mod = null;
    try { mod = require(t); } catch (e) { mod = null; }
    if (mod && typeof mod.accept === 'function') {
      try {
        const result = mod.accept(record);
        log(`RETURN ${candidate.agentName} -> embryologist module ${t}`);
        return { ok: true, mode: 'module', target: t, record, result };
      } catch (e) { /* падаем в файл-передачу */ }
    }
  }

  // 2. Файл-карточка возврата (fail-open фолбэк).
  try {
    fs.mkdirSync(RETURNS_DIR, { recursive: true });
    const base = path.basename(candidate.agentName, '.js');
    let file = path.join(RETURNS_DIR, base + '.return.json');
    if (fs.existsSync(file)) file = path.join(RETURNS_DIR, base + '.' + Date.now() + '.return.json');
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
    log(`RETURN ${candidate.agentName} -> embryologist file handoff ${file}`);
    return { ok: true, mode: 'file-handoff', path: file, record };
  } catch (e) {
    return { ok: false, mode: 'none', error: e.message, record };
  }
}

/* ------------------------------------------------------------------ *
 * 6. Публичный API
 * ------------------------------------------------------------------ */

/**
 * ТОЧКА ВХОДА: принять новичка → изолировать → экзаменовать → принять/вернуть.
 * @param {string} task — задача (может содержать имя/путь кандидата agent_N).
 * @param {object} [options] — { agentFile, tasks, timeoutMs, verbose }.
 * @returns {Promise<object>} отчёт: ok, agent, candidate, evaluation, runs,
 *          promotion, handoff, message.
 */
async function runAgent(task, options = {}) {
  const report = {
    ok: false,
    agent: null,
    candidate: null,
    evaluation: null,
    runs: [],
    promotion: null,
    handoff: null,
    message: ''
  };

  // 1. Отбор кандидата.
  let resolved = null;
  if (options.agentFile) resolved = resolveAgentFile(options.agentFile);
  if ((!resolved || !resolved.ok) && typeof task === 'string') {
    const m = task.match(/agent[_\s-]?(\d+)/i);
    if (m) resolved = resolveAgentFile('agent_' + m[1]);
  }
  if (!resolved || !resolved.ok) resolved = pickNewestAgent();
  if (!resolved || !resolved.ok) {
    report.message = 'Кандидат не найден: ' + ((resolved && resolved.error) || 'unknown');
    return report;
  }

  const agentPath = resolved.path;
  const agentName = path.basename(agentPath);
  report.agent = { name: agentName, path: agentPath };

  let src;
  try {
    src = fs.readFileSync(agentPath, 'utf8').slice(0, MAX_SOURCE_CHARS);
  } catch (e) {
    report.message = 'Не удалось прочитать кандидата: ' + e.message;
    return report;
  }
  if (!/runAgent|STRATEGY/.test(src) || !/module\.exports/.test(src)) {
    report.message = agentName + ' не похож на агента (нет runAgent/STRATEGY/module.exports)';
    return report;
  }
  const strategy = extractStrategy(src);

  // 2. Изолированный бокс.
  let candidate;
  try {
    candidate = createCandidateBox(agentPath);
  } catch (e) {
    report.message = 'Не удалось создать бокс кандидата: ' + e.message;
    return report;
  }
  candidate.source = agentPath;
  candidate.strategy = strategy;
  report.candidate = { name: candidate.name, path: candidate.path, warnings: candidate.warnings };

  // 3. Экзамен: ровно 5 задач (по умолчанию).
  const suite = await runTestSuite({ strategy }, options.tasks, {
    timeoutMs: options.timeoutMs,
    verbose: options.verbose
  });
  report.runs = suite.runs;
  report.evaluation = suite.summary;

  // 4/5. Приём или возврат.
  if (report.evaluation.passed) {
    const promotion = promote(candidate, report.evaluation);
    report.promotion = promotion;
    report.ok = !!promotion.ok;
    report.message = promotion.ok
      ? `${agentName}: средний score ${report.evaluation.avgScore} >= ${SCORE_THRESHOLD} — переведён в boxes/${promotion.boxName} и закоммичен`
      : `${agentName}: порог пройден, но перевод не удался: ${promotion.error}`;
  } else {
    const handoff = returnToEmbryologist(
      candidate,
      report.evaluation,
      'avg score ' + report.evaluation.avgScore + ' < ' + SCORE_THRESHOLD
    );
    report.handoff = handoff;
    report.ok = !!handoff.ok;
    report.message = `${agentName}: средний score ${report.evaluation.avgScore} < ${SCORE_THRESHOLD} — возвращён Эмбриологу (${handoff.mode})`;
  }

  log(`ACADEMY ${agentName} avg=${report.evaluation.avgScore} verdict=${report.evaluation.verdict} ok=${report.ok}`);
  return report;
}

module.exports = { runAgent, STRATEGY, evaluate };
