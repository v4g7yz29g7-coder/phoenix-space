// race_engineer.js — Race Engineer: builds enriched prompts for Aeon tasks.
//
// buildPrompt(task, type) returns a single enriched prompt string containing:
//   1) the chosen execution strategy (fast | safe | balanced)
//   2) relevant RAG context pulled from EverOS (~/.everos, read-only grep)
//   3) recommended tools for the task
//
// Design notes / evidence (read-only inventory, 2026-09-12):
//   - Tool names are taken from agent_responses.js TOOLS_SPEC:
//     read, write, edit, exec, commit, search_code, git_diff, send_telegram, web_search.
//   - RAG access reuses rag_context.findRelevantContext() -> everos_client.searchGrep()
//     (synchronous, read-only; never writes to EverOS or disk).
//   - memory/patterns/*.json holds 80 race records with winners only.
//     They do NOT record which strategy was used per task outcome, so pickStrategy()
//     below is an explicit heuristic (risk markers + task type), not a proven mapping.
//
// This module is pure: it performs no writes, no git operations, no network calls
// beyond the read-only EverOS grep done by rag_context.

'use strict';

const rag = require('./rag_context');

// ---------------------------------------------------------------------------
// Strategy definitions
// ---------------------------------------------------------------------------

const STRATEGIES = {
  fast: {
    name: 'fast',
    title: 'FAST — minimum steps, speed over exhaustive verification',
    max_steps: 6,
    verify: 'node --check only if code was changed',
    rules: [
      'Aim for <= 3 tool calls per task.',
      'Prefer exec (grep/find) over multiple reads.',
      'Report a partial result rather than looping.'
    ]
  },
  balanced: {
    name: 'balanced',
    title: 'BALANCED — gather evidence, then act',
    max_steps: 10,
    verify: 'node --check + git diff before commit',
    rules: [
      'Read/search enough context to be sure, then act.',
      'Explain the plan briefly before the first write.',
      'Commit after a verified change.'
    ]
  },
  safe: {
    name: 'safe',
    title: 'SAFE — read-only first, minimum blast radius',
    max_steps: 12,
    verify: 'node --check + git diff + re-read task before done',
    rules: [
      'Never modify .env, node_modules, *.db.',
      'Prefer edit over write; make the smallest possible change.',
      'Verify every change before the next step; when in doubt, stop and report.'
    ]
  }
};

const TASK_TYPES = {
  read: 'inspect/answer questions about existing code or files, no mutation',
  write: 'create or modify files (code, config, docs)',
  analyze: 'aggregate/compare/audit existing data and draw a conclusion'
};

// Risk markers that force the safe strategy on any task type.
const SAFE_MARKERS = [
  'не менять', 'не меняй', 'ничего не менять', 'ничего не меняй', 'без изменений',
  'только прочит', 'read-only', 'read only', 'осторожн',
  'delete', 'удали', 'drop ', 'migrat', 'миграц', 'refactor', 'перепис',
  'schema', 'схем', 'deploy', 'деплой', 'restore', 'восстанов', 'production', 'прод'
];

// Markers of a cheap, single-lookup read task.
const FAST_MARKERS = ['быстро', 'quick', 'кратко', 'вкратце', 'сколько строк', 'одной командой'];

function normalizeType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TASK_TYPES, t)) return t;
  return 'analyze'; // conservative default for unknown types
}

// Heuristic strategy pick (see header note: race data stores winners, not per-strategy
// outcomes, so this is an explicit rule set, not a statistically proven mapping).
function pickStrategy(task, type) {
  const t = String(task || '').toLowerCase();
  const ty = normalizeType(type);

  // 1) Explicit constraints and risk always win.
  for (const m of SAFE_MARKERS) {
    if (t.includes(m)) return 'safe';
  }

  // 2) Mutating tasks default to safe unless the task is explicitly trivial.
  if (ty === 'write') return t.length < 80 ? 'balanced' : 'safe';

  // 3) Analysis wants evidence first.
  if (ty === 'analyze') return 'balanced';

  // 4) Reads: fast for simple lookups, balanced otherwise.
  if (ty === 'read') {
    for (const m of FAST_MARKERS) {
      if (t.includes(m)) return 'fast';
    }
    return t.length < 60 ? 'fast' : 'balanced';
  }

  return 'balanced';
}
// ---------------------------------------------------------------------------
// Tool recommendation
// ---------------------------------------------------------------------------

const MAX_RECOMMENDED_TOOLS = 6;

function recommendTools(task, type) {
  const t = String(task || '').toLowerCase();
  const ty = normalizeType(type);
  const pick = [];
  const add = (name) => {
    if (pick.indexOf(name) === -1 && pick.length < MAX_RECOMMENDED_TOOLS) pick.push(name);
  };

  // Base toolset per task type.
  if (ty === 'read') {
    add('read'); add('search_code');
  } else if (ty === 'analyze') {
    add('read'); add('search_code'); add('git_diff');
  } else { // write
    add('read'); add('edit'); add('exec'); add('commit');
  }

  // Keyword-driven additions.
  if (/(найди|найти|поиск|посчитай|сколько|grep|find|list|список)/.test(t)) add('exec');
  if (/(diff|изменени|что менял|git status|history|истори[яю])/.test(t)) add('git_diff');
  if (/(создай|создать|новый файл|new file|напиши файл)/.test(t)) add('write');
  if (/(провер|тест|test|node --check|валидац|синтаксис)/.test(t)) add('exec');
  if (/(доку|интернет|актуальн|web|search the|api reference)/.test(t)) add('web_search');
  if (/(уведом|сообщи|telegram|телеграм)/.test(t)) add('send_telegram');
  if (ty === 'write') add('commit');

  return pick;
}
// ---------------------------------------------------------------------------
// RAG section
// ---------------------------------------------------------------------------
// rag.findRelevantContext() is synchronous and read-only (EverOS grep). It
// returns '' when nothing matches or when anything throws, so we guard anyway
// and never let a memory lookup break prompt building.
function buildRagSection(task) {
  let ctx = '';
  try {
    ctx = rag.findRelevantContext(String(task || ''), 3) || '';
  } catch (e) {
    ctx = '';
  }
  ctx = String(ctx).trim();
  if (!ctx) return 'RAG CONTEXT: (no relevant EverOS memory found for this task)';
  return 'RAG CONTEXT (read-only, from EverOS memory):\n' + ctx;
}

// ---------------------------------------------------------------------------
// Prompt parts
// ---------------------------------------------------------------------------
// Returns the structured pieces so callers (and tests) can inspect the choice
// without parsing the final string.
function buildPromptParts(task, type) {
  const text = String(task || '');
  const ty = normalizeType(type);
  const strategyName = pickStrategy(text, ty);

  return {
    task: text,
    type: ty,
    typeNote: TASK_TYPES[ty],
    strategy: strategyName,
    strategyDef: STRATEGIES[strategyName],
    tools: recommendTools(text, ty),
    rag: buildRagSection(text)
  };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------
function buildPrompt(task, type) {
  const p = buildPromptParts(task, type);
  const s = p.strategyDef;
  const out = [];

  out.push('=== RACE ENGINEER CONTEXT ===');
  out.push('TASK TYPE: ' + p.type + ' — ' + p.typeNote);
  out.push('');
  out.push('STRATEGY: ' + s.title);
  out.push('STEP BUDGET: <= ' + s.max_steps + ' tool calls');
  out.push('VERIFICATION: ' + s.verify);
  out.push('RULES:');
  for (const r of s.rules) out.push('  - ' + r);
  out.push('');
  out.push('RECOMMENDED TOOLS: ' + (p.tools.length ? p.tools.join(', ') : 'none'));
  out.push('');
  out.push(p.rag);
  out.push('');
  out.push('=== TASK ===');
  out.push(p.task);

  return out.join('\n');
}

module.exports = { buildPrompt };
