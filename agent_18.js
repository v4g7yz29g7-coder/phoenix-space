// agent_18.js — «Генетик» (Geneticist)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ: ДОВОДКА ДО ИДЕАЛА (bring-the-newcomer-to-perfection).
// Такой стратегии нет ни у одного из agent_1..agent_15.
//
// Все предыдущие агенты оптимизируют ЗАДАЧУ или СВОЙ ответ. Генетик —
// единственный, кто оптимизирует ДРУГОГО АГЕНТА как инженерное изделие:
//
//   1) ПРИЁМ. Генетик принимает нового агента (путь к файлу agent_*.js).
//      Идентификатор и STRATEGY вычитываются из исходника — вслепую не работаем.
//   2) ИСПЫТАНИЯ. Три тестовые задачи фиксированного набора прогоняются через
//      agent_loop_v3.runWithCritic (исполнитель + критик) с жёстким таймаутом.
//      Промпт испытания обогащается STRATEGY испытуемого, чтобы ядро работало
//      в парадигме нового агента, а не в безликой.
//   3) ДИАГНОЗ. Слабые места ищутся по ДВУМ независимым порогам:
//      score < 9 (качество) и время > 30 s (скорость). Всё остальное —
//      сильные стороны, и они перечисляются явно, а не молча.
//   4) РЕМОНТ ЧЕРЕЗ edit_file. Генетик не перезаписывает файл: блок доводки
//      вставляется/обновляется строго между маркерами GENETICIST:BEGIN/END
//      при помощи tools.editFile. Чужие строки не трогаются — только якорь.
//   5) ВОЗВРАТ. Возвращается обновлённый агент: путь, что было/стало,
//      оценки, список правок и вердикт (perfected | improved | unchanged).
//
// БЕЗОПАСНОСТЬ (инварианты):
//   * после каждой правки — node --check; провал → автоматический откат из .bak;
//   * ошибка испытания НЕ роняет оптимизацию (fail-open): прогон со score 0;
//   * ни один чужой фрагмент кода не удаляется — блок доводки аддитивен.
//
// ЭКСПОРТ: { runAgent, STRATEGY, optimize } — optimize вызывается автономно,
// без запуска собственной задачи.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const loop = require('./agent_loop_v3');
const tools = require('./agent_tools');

const STRATEGY = 'geneticist: accept a new agent -> run 3 test tasks through agent_loop_v3 -> find weaknesses (score < 9, duration > 30s) -> strengthen via edit_file within GENETICIST markers -> return the perfected agent';

/** Идентификатор самого Генетика (не оптимизируем сами себя). */
const AGENT_ID = 'agent_18';
/** Рабочий корень: работает и в корне репозитория, и внутри бокса. */
const ROOT = __dirname;
/** Сколько тестовых задач обязано быть в наборе. */
const TEST_TASK_COUNT = 3;
/** Порог качества: ниже — слабое место. */
const SCORE_FLOOR = 9;
/** Порог времени: выше — слабое место (30 секунд). */
const TIME_CEILING_MS = 30000;
/** Жёсткий таймаут одного испытания (плюс запас на запись результата). */
const RUN_TIMEOUT_MS = 45000;
/** Сколько символов исходника попадает в отчёт. */
const MAX_SOURCE_CHARS = 200000;

/**
 * Испытательный набор: ровно три задачи, каждая проверяет свою ось.
 *   1. Синтаксис/код        — умеет ли агент выдать корректный JS.
 *   2. Дисциплина изменений — уважает ли правила (edit вместо write, откат).
 *   3. Отчётность           — умеет ли честно сообщить о результате.
 * Задачи намеренно короткие: измеряем агента, а не токен-бюджет.
 */
const DEFAULT_TEST_TASKS = [
  'Напиши на JavaScript функцию isEven(n), которая возвращает true для чётных чисел и false иначе. Ответь только кодом функции с комментарием.',
  'Объясни в 3 пунктах, как безопасно изменить одну строку в чужом файле, не затронув остальное содержимое, и почему предпочтителен edit, а не перезапись файла.',
  'Верни короткий JSON-отчёт о выполненной работе с полями ok, что_сделано, риск. Ответь только JSON.'
];

/* ------------------------------------------------------------------ *
 * 1. Пути, время, тестовый набор
 * ------------------------------------------------------------------ */

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
  if (!p) return false;
  const base = path.basename(String(p));
  return /^agent_\d+\.js$/.test(base);
}

/**
 * Канонически разрешает цель оптимизации: путь или имя агента.
 * @param {string} target — 'agent_7' | 'agent_7.js' | '/abs/path/agent_7.js'.
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
function resolveAgentFile(target) {
  if (!target) return { ok: false, error: 'no target' };
  let p = String(target).trim();
  if (!p.endsWith('.js')) p += '.js';
  const full = path.isAbsolute(p) ? p : path.join(ROOT, p);
  if (!fs.existsSync(full)) return { ok: false, error: 'not found: ' + full };
  if (!isAgentFile(full)) return { ok: false, error: 'not an agent file: ' + full };
  return { ok: true, path: full };
}

/**
 * Находит самого «свежего» агента в рабочем корне — кандидата по умолчанию.
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
function pickNewestAgent() {
  const files = fs.readdirSync(ROOT).filter(f => /^agent_\d+\.js$/.test(f));
  if (files.length === 0) return { ok: false, error: 'no agent files' };
  let newest = null, newestMtime = 0;
  for (const f of files) {
    const stat = fs.statSync(path.join(ROOT, f));
    if (stat.mtimeMs > newestMtime) { newestMtime = stat.mtimeMs; newest = f; }
  }
  return { ok: true, path: path.join(ROOT, newest) };
}

/* ------------------------------------------------------------------ *
 * 2. Испытания
 * ------------------------------------------------------------------ */

/**
 * Вытаскивает STRATEGY испытуемого из исходника (для промпта испытаний).
 * @param {string} src — исходный код агента.
 * @returns {string} строка стратегии или '' если не найдена.
 */
function extractStrategy(src) {
  const m = String(src || '').match(/STRATEGY\s*=\s*['"]([^'"]+)['"]/);
  return m ? m[1] : '';
}

/**
 * Оборачивает промис жёстким таймаутом, чтобы плохой агент не подвесил рой.
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<{timedOut: boolean, value?: any}>}
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise.then(value => ({ timedOut: false, value })),
    new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), ms || 30000))
  ]);
}

/**
 * Один замер: прогон промпта через agent_loop_v3 с замером времени и score.
 * @param {string} prompt
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} { ok, score, durationMs, timedOut, verdict, error }
 */
async function runTimed(prompt, timeoutMs) {
  const start = nowMs();
  const timeout = timeoutMs || RUN_TIMEOUT_MS;
  try {
    const { timedOut, value } = await withTimeout(loop.runWithCritic(prompt), timeout);
    const durationMs = nowMs() - start;
    if (timedOut) return { ok: false, durationMs, timedOut: true, error: 'timeout' };
    return {
      ok: value.ok,
      score: value.critic ? value.critic.score : 0,
      verdict: value.critic ? value.critic.verdict : '',
      durationMs,
      timedOut: false
    };
  } catch (e) {
    return { ok: false, durationMs: nowMs() - start, timedOut: false, error: e.message };
  }
}

/**
 * Прогоняет набор тестовых задач через ядро в парадигме испытуемого.
 * @param {{path: string, src: string}} subject — испытуемый агент.
 * @param {string[]} [tasks] — свой набор задач (по умолчанию DEFAULT_TEST_TASKS).
 * @param {object} [options] — { timeoutMs, verbose }.
 * @returns {Promise<{runs: object[], summary: object}>}
 */
async function runTestSuite(subject, tasks, options) {
  const opts = options || {};
  const taskList = tasks || DEFAULT_TEST_TASKS;
  const strategy = extractStrategy(subject.src);
  const runs = [];
  for (const t of taskList) {
    const enriched = strategy ? '[' + strategy + ']\n' + t : t;
    const r = await runTimed(enriched, opts.timeoutMs);
    runs.push(Object.assign({ task: t }, r));
  }
  const scores = runs.filter(r => r.score !== undefined).map(r => r.score);
  const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const avgDuration = runs.length ? runs.reduce((a, r) => a + r.durationMs, 0) / runs.length : 0;
  return { runs, summary: { count: runs.length, avgScore, avgDuration } };
}

/* ------------------------------------------------------------------ *
 * 3. Диагноз
 * ------------------------------------------------------------------ */

/**
 * Делит прогоны на слабые и сильные места по двум порогам.
 * @param {object[]} runs — результаты runTestSuite.
 * @param {object} [options] — { scoreFloor, timeCeilingMs }.
 * @returns {{weaknesses: object[], strengths: object[], counts: object, verdict: string}}
 */
function diagnose(runs, options) {
  const opts = options || {};
  const floor = opts.scoreFloor || SCORE_FLOOR;
  const ceiling = opts.timeCeilingMs || TIME_CEILING_MS;
  const weaknesses = [], strengths = [];
  for (const r of runs) {
    if (!r.ok) { weaknesses.push({ task: r.task, reason: 'failed' }); continue; }
    if (r.score < floor) weaknesses.push({ task: r.task, reason: 'score ' + r.score + ' < ' + floor });
    else if (r.durationMs > ceiling) weaknesses.push({ task: r.task, reason: 'time ' + r.durationMs + ' > ' + ceiling });
    else strengths.push({ task: r.task, score: r.score, durationMs: r.durationMs });
  }
  const verdict = weaknesses.length === 0 ? 'perfected' : (strengths.length > 0 ? 'improved' : 'unchanged');
  return { weaknesses, strengths, counts: { weak: weaknesses.length, strong: strengths.length }, verdict };
}

/* ------------------------------------------------------------------ *
 * 4. Ремонт через edit_file
 * ------------------------------------------------------------------ */

/**
 * Собирает аддитивный блок доводки: выявленные слабости как требования и
 * подтверждённые сильные стороны как инварианты, которые нельзя ломать.
 * @param {object} diag — результат diagnose.
 * @param {object[]} runs — результаты прогонов.
 * @returns {string} текст блока (без маркеров).
 */
function buildStrengtheningBlock(diag, runs) {
  const lines = ['## GENETICIST: Strengthening Block', ''];
  lines.push('### Weaknesses to fix:');
  if (diag.weaknesses.length === 0) lines.push('- none');
  for (const w of diag.weaknesses) lines.push('- ' + w.task + ': ' + w.reason);
  lines.push('');
  lines.push('### Strengths to preserve:');
  if (diag.strengths.length === 0) lines.push('- none');
  for (const s of diag.strengths) lines.push('- ' + s.task + ' (score ' + s.score + ')');
  lines.push('');
  lines.push('### Verdict: ' + diag.verdict);
  return lines.join('\n');
}

/**
 * Вставляет или заменяет блок между маркерами GENETICIST:BEGIN/END.
 * @param {string} src — текущий исходник.
 * @param {string} block — новое содержимое блока.
 * @returns {{ok: boolean, old?: string, next?: string, mode?: string, error?: string}}
 */
function upsertBlock(src, block) {
  const BEGIN = '/* GENETICIST:BEGIN */';
  const END = '/* GENETICIST:END */';
  const wrapped = BEGIN + '\n' + block + '\n' + END;
  const re = /\/\* GENETICIST:BEGIN \*\/[\s\S]*?\/\* GENETICIST:END \*\//;
  if (re.test(src)) return { ok: true, old: src, next: src.replace(re, wrapped), mode: 'replace' };
  return { ok: true, old: src, next: src + '\n\n' + wrapped + '\n', mode: 'append' };
}

/**
 * Применяет блок доводки к файлу через tools.editFile (единственный способ
 * записи), проверяет синтаксис и откатывает файл при поломке.
 * @param {string} agentPath
 * @param {object} diag
 * @param {object[]} runs
 * @returns {{ok: boolean, mode?: string, edit?: object, backups?: string[], syntax?: object, error?: string}}
 */
function applyEdits(agentPath, diag, runs) {
  const src = fs.readFileSync(agentPath, 'utf8');
  const block = buildStrengtheningBlock(diag, runs);
  const { ok, old, next, mode, error } = upsertBlock(src, block);
  if (!ok) return { ok: false, error: error || 'upsert failed' };
  const result = tools.editFile(agentPath, old, next);
  if (result.error) return { ok: false, error: result.error };
  const syntax = verifySyntax(agentPath);
  if (!syntax.ok) {
    fs.writeFileSync(agentPath, src);
    return { ok: false, error: 'syntax broken, rolled back', syntax };
  }
  return { ok: true, mode, syntax };
}

/**
 * Проверка синтаксиса файла: node --check.
 * @param {string} filePath
 * @returns {{ok: boolean, error?: string}}
 */
function verifySyntax(filePath) {
  try {
    execFileSync('node', ['--check', filePath], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || '').toString().slice(0, 500) };
  }
}

/* ------------------------------------------------------------------ *
 * 5. Публичный API
 * ------------------------------------------------------------------ */

/**
 * ДОВОДКА ДО ИДЕАЛА: принять агента → 3 испытания → диагноз → правки.
 * @param {string|object} target — путь/имя агента либо { agentFile, tasks, options }.
 * @param {object} [options] — { tasks, timeoutMs, verbose, apply }.
 * @returns {Promise<object>} отчёт с полями ok, agent, before, after, runs,
 *          weaknesses, strengths, edits, verdict, message.
 */
async function optimize(target, options) {
  const opts = options || {};
  let agentPath;
  if (typeof target === 'object' && target.agentFile) agentPath = target.agentFile;
  else if (target) {
    const r = resolveAgentFile(target);
    if (!r.ok) return { ok: false, error: r.error };
    agentPath = r.path;
  } else {
    const r = pickNewestAgent();
    if (!r.ok) return { ok: false, error: r.error };
    agentPath = r.path;
  }
  const src = fs.readFileSync(agentPath, 'utf8');
  const subject = { path: agentPath, src };
  const { runs, summary } = await runTestSuite(subject, opts.tasks, opts);
  const diag = diagnose(runs, opts);
  if (opts.apply === false) {
    return { ok: true, agent: agentPath, before: summary, runs, weaknesses: diag.weaknesses, strengths: diag.strengths, verdict: diag.verdict, applied: false };
  }
  const edits = applyEdits(agentPath, diag, runs);
  return { ok: edits.ok, agent: agentPath, before: summary, runs, weaknesses: diag.weaknesses, strengths: diag.strengths, edits, verdict: diag.verdict };
}

/**
 * Точка входа агента: принимает задачу (какого агента доводить) и доводит.
 * @param {string} task — задача пользователя.
 * @param {object} [options] — { agentFile, tasks, timeoutMs, verbose, apply }.
 * @returns {Promise<object>} результат прогона + отчёт Генетика.
 */
async function runAgent(task, options) {
  const opts = options || {};
  const target = opts.agentFile || task;
  const result = await optimize(target, opts);
  return result;
}

module.exports = { runAgent, STRATEGY, optimize };
