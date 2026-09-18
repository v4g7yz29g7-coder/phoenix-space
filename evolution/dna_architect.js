// evolution/dna_architect.js
// ─────────────────────────────────────────────────────────────────────────────
// DNA Architect — LLM-модуль «мутации» промптов агентов.
//
// Идея: «ДНК агента» = его системный промпт + рабочая стратегия. Когда агент
// слаб (низкий fitness, серия провалов, повторяющиеся issues), Архитектор ДНК
// читает его паттерны и предлагает ХИРУРГИЧЕСКИЙ патч в промпт, а не
// переписывает промпт целиком.
//
// Публичный API:
//     proposeChanges(agentId) -> { action, target, patch, reasoning, risk }
//
// Режим: DRY-RUN ПО УМОЛЧАНИЮ. Реальная запись в промпт включается только
//         явными флагами окружения (см. resolveDryRun ниже).
//
// Зависимости: только Node core (fs, path, https). axios/llm_client —
//               опциональные ускорители, если присутствуют в проекте.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ─────────────────────────────────────────────────────────────────────────────
// Конфигурация
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.env.PHOENIX_ROOT || path.resolve(__dirname, '..');
const MEMORY_DIR = process.env.DNA_MEMORY_DIR || path.join(ROOT, 'memory');
const PATTERNS_DIR = path.join(MEMORY_DIR, 'patterns');
const FITNESS_FILE = path.join(MEMORY_DIR, 'fitness.json');
const PROPOSALS_FILE = path.join(MEMORY_DIR, 'architect_proposals.json');
const PROMPTS_DIR = path.join(ROOT, 'prompts');

const DEEPSEEK_URL = process.env.DEEPSEEK_URL || 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

// Порог слабости: агент считается слабым, если fitness ниже порога
// ИЛИ если у него >= 2 запусков и ни одной победы.
const WEAK_FITNESS_THRESHOLD = Number(process.env.DNA_WEAK_THRESHOLD || 1.5);

// Сколько паттернов максимум отправлять в LLM.
const MAX_PATTERNS = Number(process.env.DNA_MAX_PATTERNS || 25);

// Ограничения на длину, чтобы не раздувать запрос и JSON-лог.
const MAX_PREVIEW = 480;
const MAX_PROMPT_CHARS = 24000;
const MAX_LOG_ENTRIES = 500;

/**
 * Dry-run включён по умолчанию.
 * Отключить запись можно только явно:
 *   DNA_ARCHITECT_APPLY=1            -> apply (принудительно)
 *   DNA_ARCHITECT_DRY_RUN=false      -> apply
 * Любое другое значение (или отсутствие env) -> dry-run.
 */
function resolveDryRun() {
  if (String(process.env.DNA_ARCHITECT_APPLY) === '1') return false;
  if (String(process.env.DNA_ARCHITECT_DRY_RUN) === 'false') return false;
  return true;
}

const DRY_RUN = resolveDryRun();

// Канонический набор действий архиектора.
const ACTIONS = Object.freeze({
  STRENGTHEN: 'strengthen_prompt',   // усилить существующее правило
  ADD_CONSTRAINT: 'add_constraint',  // добавить отсутствующий запрет
  CLARIFY: 'clarify_instruction',    // уточнить неоднозначный пункт
  ADD_SKILL: 'add_skill',            // добавить требование использовать инструмент
  REPLACE: 'replace_section',        // заменить целый блок промпта
  NOOP: 'noop',                      // менять нечего
});

const ACTION_VALUES = Object.freeze(Object.values(ACTIONS));

// ─────────────────────────────────────────────────────────────────────────────
// Системная инструкция для LLM
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_INSTRUCTIONS = `You are DNA Architect, a prompt-evolution engine for autonomous agents.
A weak agent's failures were analyzed. Propose ONE surgical patch to its system prompt that most increases its win-rate.

Reply ONLY with a single JSON object, no markdown fences:
{
  "action": "strengthen_prompt | add_constraint | clarify_instruction | add_skill | replace_section | noop",
  "target": "path or symbolic target, e.g. prompts/agent_4.md#strategies",
  "patch": "the exact text to insert or the replacement block (concise, imperative)",
  "reasoning": "why this fixes the observed failure pattern (cite evidence)",
  "risk": 0
}

Rules:
- risk is an integer 0..10 (10 = may break working behavior).
- Prefer the smallest patch that addresses the dominant failure cause.
- Base reasoning ONLY on the supplied patterns and fitness data.
- If the agent is not actually weak, return action "noop" with a short patch "".`;

// ─────────────────────────────────────────────────────────────────────────────
// Мелкие хелперы
// ─────────────────────────────────────────────────────────────────────────────

function safeReadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function safeWriteJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

function truncate(str, n) {
  const s = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function nowIso() {
  return new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Загрузка агента (fitness)
// ─────────────────────────────────────────────────────────────────────────────

function loadFitness() {
  const data = safeReadJson(FITNESS_FILE, { agents: {} });
  if (data && data.agents && typeof data.agents === 'object') return data.agents;
  // Допускаем плоский формат { "agent_1": {...} }.
  if (data && typeof data === 'object' && !Array.isArray(data)) return data;
  return {};
}

function getAgentRecord(agentId) {
  const agents = loadFitness();
  if (agents[agentId]) return agents[agentId];
  // Иногда ключ хранится без префикса agent_ / с префиксом.
  const norm = (k) => String(k).replace(/^agent[_/-]/, '').toLowerCase();
  const alt = Object.keys(agents).find((k) => norm(k) === norm(agentId));
  return alt ? agents[alt] : null;
}

function isWeakAgent(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const fitness = Number(rec.fitness || 0);
  const runs = Number(rec.runs_total || rec.runs || 0);
  const wins = Number(rec.wins_total || rec.wins || 0);
  const winRate = runs > 0 ? wins / runs : 0;
  if (fitness < WEAK_FITNESS_THRESHOLD) return true;
  if (runs >= 2 && winRate === 0) return true;
  return false;
}

function listWeakAgents() {
  const agents = loadFitness();
  return Object.keys(agents)
    .filter((id) => isWeakAgent(agents[id]))
    .map((id) => ({
      id,
      fitness: Number((agents[id] || {}).fitness || 0),
      runs_total: Number((agents[id] || {}).runs_total || 0),
      wins_total: Number((agents[id] || {}).wins_total || 0),
    }))
    .sort((a, b) => a.fitness - b.fitness);
}

// ─────────────────────────────────────────────────────────────────────────────
// Загрузка паттернов агента
// ─────────────────────────────────────────────────────────────────────────────

function readAllPatterns() {
  let files = [];
  try {
    files = fs.readdirSync(PATTERNS_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
  return files
    .map((f) => {
      const data = safeReadJson(path.join(PATTERNS_DIR, f), null);
      if (!data || typeof data !== 'object') return null;
      data._file = f;
      return data;
    })
    .filter(Boolean);
}

function patternBlob(p) {
  return [
    p.agent, p.agent_id, p.prompt, p.task, p.answer_preview, p.answer,
    JSON.stringify(p.issues || []),
    JSON.stringify(p.tools_used || []),
  ]
    .join(' ')
    .toLowerCase();
}

function isPatternFailure(p) {
  return p.ok === false || p.winner === null || p.success === false;
}

function loadAgentPatterns(agentId, limit = MAX_PATTERNS) {
  const all = readAllPatterns();
  const needle = String(agentId).toLowerCase();

  const own = all.filter((p) => patternBlob(p).includes(needle));

  const sortFn = (a, b) =>
    String(b.ts || b.timestamp || b._file).localeCompare(String(a.ts || a.timestamp || a._file));

  const failures = own.filter(isPatternFailure).sort(sortFn);
  const rest = own.filter((p) => !isPatternFailure(p)).sort(sortFn);

  let selected = failures.concat(rest);
  if (selected.length === 0) {
    // Fallback: у агента нет явных паттернов — берём свежие системные провалы.
    selected = all.filter(isPatternFailure).sort(sortFn);
  }
  return selected.slice(0, limit);
}

function summarizePatterns(patterns) {
  const issues = {};
  let failures = 0;

  for (const p of patterns) {
    if (isPatternFailure(p)) failures++;
    for (const issue of p.issues || []) {
      const key = truncate(issue, 140);
      if (!key) continue;
      issues[key] = (issues[key] || 0) + 1;
    }
  }

  const topIssues = Object.entries(issues)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([issue, count]) => ({ issue, count }));

  return {
    total: patterns.length,
    failures,
    topIssues,
    samples: patterns.slice(0, 8).map((p) => ({
      file: p._file,
      ok: p.ok,
      agent: p.agent || p.agent_id || null,
      prompt: truncate(p.prompt || p.task, MAX_PREVIEW),
      answer: truncate(p.answer_preview || p.answer, MAX_PREVIEW),
      issues: (p.issues || []).slice(0, 3),
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Транспорт: HTTP POST JSON на Node core (https)
// ─────────────────────────────────────────────────────────────────────────────

function httpsPostJson(url, bodyObj, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error('invalid DeepSeek URL: ' + url));
    }
    const payload = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: (u.pathname || '/') + (u.search || ''),
        method: 'POST',
        headers: Object.assign(
          {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          headers || {}
        ),
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('DeepSeek returned non-JSON: ' + data.slice(0, 200)));
            }
          } else {
            reject(new Error('DeepSeek HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('DeepSeek request timeout')));
    req.write(payload);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Вызов LLM (DeepSeek)
// ─────────────────────────────────────────────────────────────────────────────

async function callDeepSeek(userPrompt) {
  // 1) Переиспользуем общий клиент проекта, если он есть.
  try {
    const client = require(path.join(ROOT, 'llm_client.js'));
    if (client && typeof client.askDeepSeek === 'function') {
      const out = await client.askDeepSeek(SYSTEM_INSTRUCTIONS, userPrompt, 1200);
      if (out) return String(out).trim();
    }
  } catch (e) {
    /* нет клиента — идём напрямую */
  }

  // 2) Прямой вызов DeepSeek API.
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const res = await httpsPostJson(
    DEEPSEEK_URL,
    {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTIONS },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 1200,
      temperature: 0.4,
      stream: false,
    },
    { Authorization: 'Bearer ' + apiKey }
  );

  const choice = res && res.choices && res.choices[0];
  return String((choice && choice.message && choice.message.content) || '').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Разбор и нормализация ответа LLM
// ─────────────────────────────────────────────────────────────────────────────

function extractJsonObject(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  let depth = 0;
  let start = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch (e) {
          start = -1;
        }
      }
    }
  }
  return null;
}

function normalizeProposal(obj, agentId) {
  const src = obj && typeof obj === 'object' ? obj : {};

  const riskRaw = Number(src.risk);
  const risk = Number.isFinite(riskRaw) ? Math.max(0, Math.min(10, Math.round(riskRaw))) : 5;

  let action = String(src.action || ACTIONS.NOOP).trim().toLowerCase();
  if (!ACTION_VALUES.includes(action)) action = ACTIONS.CLARIFY;

  return {
    action,
    target: String(src.target || `prompts/${agentId}.md`).trim(),
    patch: String(src.patch == null ? '' : src.patch).trim(),
    reasoning: String(src.reasoning == null ? '' : src.reasoning).trim(),
    risk,
  };
}

/**
 * Детерминированный fallback, если LLM недоступен.
 * Гарантирует, что proposeChanges всегда отдаёт осмысленный контракт.
 */
function heuristicProposal(agentId, summary, reason) {
  const top = summary && summary.topIssues && summary.topIssues[0];
  const patch = top
    ? `Before finalizing, explicitly verify this rule: ${top.issue}`
    : 'Re-read the task, list your assumptions, then answer step by step.';

  return {
    action: top ? ACTIONS.ADD_CONSTRAINT : ACTIONS.CLARIFY,
    target: `prompts/${agentId}.md`,
    patch,
    reasoning:
      `${reason}. Dominant failure pattern: ` +
      (top ? `"${top.issue}" (x${top.count})` : 'unknown (no patterns found)') +
      `. Observed failures: ${(summary && summary.failures) || 0}/${(summary && summary.total) || 0}.`,
    risk: 3,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Применение (только вне dry-run) и журналирование
// ─────────────────────────────────────────────────────────────────────────────

function recordProposal(agentId, proposal, dryRun) {
  const store = safeReadJson(PROPOSALS_FILE, { proposals: [] });
  if (!Array.isArray(store.proposals)) store.proposals = [];
  store.proposals.push(Object.assign({ ts: nowIso(), agent: agentId, dry_run: dryRun }, proposal));
  if (store.proposals.length > MAX_LOG_ENTRIES) {
    store.proposals = store.proposals.slice(-MAX_LOG_ENTRIES);
  }
  safeWriteJson(PROPOSALS_FILE, store);
}

function applyProposal(agentId, proposal) {
  // Пишем только внутрь prompts/ — защита от path traversal.
  const rel = String(proposal.target || '').replace(/^.*prompts[\\/]/, 'prompts/');
  const targetFile = path.join(ROOT, rel);
  const resolved = path.resolve(targetFile);

  if (resolved !== PROMPTS_DIR && !resolved.startsWith(PROMPTS_DIR + path.sep)) {
    return { applied: false, reason: 'target outside prompts/ — apply skipped' };
  }

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(
      resolved,
      `\n\n<!-- DNA-ARCHITECT ${nowIso()} | ${proposal.action} | agent=${agentId} -->\n${proposal.patch}\n`
    );
    return { applied: true, file: resolved };
  } catch (e) {
    return { applied: false, reason: String((e && e.message) || e) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Публичный API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Предложить патч в промпт слабого агента.
 *
 * @param {string} agentId
 * @returns {Promise<{action:string,target:string,patch:string,reasoning:string,risk:number}>}
 */
async function proposeChanges(agentId) {
  if (!agentId) throw new Error('proposeChanges(agentId): agentId is required');

  const id = String(agentId);
  const rec = getAgentRecord(id);
  const patterns = loadAgentPatterns(id);
  const summary = summarizePatterns(patterns);

  const payload = {
    agent: id,
    fitness: rec || null,
    is_weak: isWeakAgent(rec),
    weak_threshold: WEAK_FITNESS_THRESHOLD,
    patterns: summary,
  };

  const userPrompt =
    'AGENT PROFILE:\n' +
    JSON.stringify(payload, null, 2).slice(0, MAX_PROMPT_CHARS) +
    '\n\nPropose the single most impactful prompt patch as JSON.';

  let proposal;
  try {
    const raw = await callDeepSeek(userPrompt);
    const parsed = extractJsonObject(raw);
    proposal = parsed
      ? normalizeProposal(parsed, id)
      : Object.assign(
          normalizeProposal(
            { action: ACTIONS.NOOP, patch: '', reasoning: 'LLM returned unparseable output', risk: 2 },
            id
          ),
          { _raw: truncate(raw, 600) }
        );
  } catch (err) {
    // LLM недоступен — деградируем к эвристике, а не падаем.
    proposal = heuristicProposal(id, summary, 'LLM unavailable: ' + String((err && err.message) || err));
  }

  // Записываем только вне dry-run и не для noop.
  let apply = { applied: false, reason: 'dry-run' };
  if (!DRY_RUN && proposal.action !== ACTIONS.NOOP && proposal.patch) {
    apply = applyProposal(id, proposal);
  }

  recordProposal(id, Object.assign({}, proposal, { apply, dry_run: DRY_RUN }), DRY_RUN);

  // Строгий контракт ответа.
  return {
    action: proposal.action,
    target: proposal.target,
    patch: proposal.patch,
    reasoning: proposal.reasoning,
    risk: proposal.risk,
  };
}

/**
 * Пройтись по всем слабым агентам и собрать предложения.
 * @param {{limit?:number}} [opts]
 */
async function proposeForAllWeak(opts = {}) {
  const limit = Number(opts.limit || 5);
  const weak = listWeakAgents().slice(0, limit);
  const out = [];
  for (const w of weak) {
    try {
      const p = await proposeChanges(w.id);
      out.push({ agent: w.id, ...p });
    } catch (e) {
      out.push({ agent: w.id, error: String((e && e.message) || e) });
    }
  }
  return { dry_run: DRY_RUN, count: out.length, proposals: out };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const arg = process.argv[2];

  (async () => {
    if (arg === '--list-weak' || arg === 'list') {
      console.log(JSON.stringify({ dry_run: DRY_RUN, weak: listWeakAgents() }, null, 2));
      return;
    }

    if (arg === '--all' || arg === 'all') {
      console.log(`[dna_architect] dry_run=${DRY_RUN} scanning weak agents…`);
      console.log(JSON.stringify(await proposeForAllWeak({ limit: 5 }), null, 2));
      return;
    }

    let agentId = arg;
    if (!agentId) {
      const weak = listWeakAgents();
      agentId = weak.length ? weak[0].id : 'agent_8';
    }

    console.log(`[dna_architect] dry_run=${DRY_RUN} agent=${agentId}`);
    const out = await proposeChanges(agentId);
    console.log(JSON.stringify(out, null, 2));
  })().catch((e) => {
    console.error('[dna_architect] error:', (e && e.message) || e);
    process.exitCode = 1;
  });
}

module.exports = {
  proposeChanges,
  proposeForAllWeak,
  listWeakAgents,
  isWeakAgent,
  loadAgentPatterns,
  summarizePatterns,
  normalizeProposal,
  extractJsonObject,
  ACTIONS,
  DRY_RUN,
  WEAK_FITNESS_THRESHOLD,
};
