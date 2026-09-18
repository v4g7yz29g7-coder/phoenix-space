#!/usr/bin/env node
/**
 * architect_agent.js — Агент-Архитектор Aeon
 * ============================================================================
 * Назначение:
 *   Читает prompts/architect_dna.md (ДНК архитектора), анализирует проект,
 *   генерирует архитектурные предложения и (в режиме dry-run) записывает их
 *   в memory/architect_proposals.json. Отдельный метод review() оценивает
 *   предложения по рубрике из ДНК и формирует вердикт.
 *
 * Публичный API:
 *   - propose(opts)  -> { ok, dryRun, dna, proposals, written, file }
 *   - review(opts)   -> { ok, reviewed, approved, rejected, report, file }
 *
 * Дополнительно экспортируются хелперы для тестов и оператора:
 *   loadDNA, parseDNA, analyzeProject, generateProposals, scoreProposal,
 *   writeJSONAtomic, slugify, nowISO.
 *
 * Режимы запуска (CLI):
 *   node architect_agent.js            # propose() в dry-run (по умолчанию)
 *   node architect_agent.js --apply    # реальная запись proposals
 *   node architect_agent.js --review   # review() по proposals-файлу
 *   node architect_agent.js --json     # машинный вывод в stdout
 *
 * Безопасность:
 *   - НИКОГДА не пишет в .env, node_modules, *.db, .git
 *   - dry-run по умолчанию: файл не перезаписывается без явного opt-in
 *   - все ошибки перехватываются, процесс не падает с трейсом наружу
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Константы и пути
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname);
const PROMPTS_DIR = path.join(PROJECT_ROOT, 'prompts');
const MEMORY_DIR = path.join(PROJECT_ROOT, 'memory');

const DNA_PATH = path.join(PROMPTS_DIR, 'architect_dna.md');
const PROPOSALS_PATH = path.join(MEMORY_DIR, 'architect_proposals.json');
const REVIEW_PATH = path.join(MEMORY_DIR, 'architect_review.json');
const LOG_PATH = path.join(MEMORY_DIR, 'architect_agent.log');

const DRY_RUN_DEFAULT = true;
const MAX_PROPOSALS = 24;
const SCHEMA_VERSION = 1;

const SAFETY_FORBIDDEN = [
  /\.env$/,
  /node_modules/,
  /\.db$/,
  /\.sqlite$/,
  /\.git\//
];

// ---------------------------------------------------------------------------
// Утилиты общего назначения
// ---------------------------------------------------------------------------

/** ISO-метка времени. */
function nowISO() {
  return new Date().toISOString();
}

/** Преобразует произвольную строку в безопасный slug. */
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'proposal';
}

/** Безопасная проверка пути на запрещённые цели. */
function isForbiddenPath(p) {
  const abs = path.resolve(PROJECT_ROOT, p || '');
  if (!abs.startsWith(PROJECT_ROOT)) return true;
  return SAFETY_FORBIDDEN.some((re) => re.test(abs));
}

/** Гарантирует наличие каталога memory/. */
function ensureMemoryDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

/** Простая append-only запись в лог, никогда не бросает исключение. */
function logEvent(kind, data) {
  try {
    ensureMemoryDir();
    const line = JSON.stringify({ ts: nowISO(), kind, data: data || {} }) + '\n';
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    /* логирование не должно ломать основной поток */
  }
}

/** Атомарная запись JSON: temp-file + rename. */
function writeJSONAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

/** Чтение JSON с дефолтом. */
function readJSONSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

/** Загрузка .env без зависимостей (только для DEEPSEEK_API_KEY). */
function loadEnvFallback() {
  if (process.env.DEEPSEEK_API_KEY) return;
  try {
    const envPath = path.join(PROJECT_ROOT, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (e) {
    /* .env может отсутствовать — это нормально */
  }
}

// ---------------------------------------------------------------------------
// Чтение и разбор ДНК архитектора
// ---------------------------------------------------------------------------

/**
 * Читает prompts/architect_dna.md.
 * Возвращает { found, path, raw, sections, principles, goals, constraints }.
 */
function loadDNA() {
  const result = {
    found: false,
    path: DNA_PATH,
    raw: '',
    sections: {},
    principles: [],
    goals: [],
    constraints: [],
    error: null
  };

  try {
    if (!fs.existsSync(DNA_PATH)) {
      result.error = 'DNA file not found: ' + DNA_PATH;
      return result;
    }
    result.raw = fs.readFileSync(DNA_PATH, 'utf8');
    result.found = true;
    const parsed = parseDNA(result.raw);
    result.sections = parsed.sections;
    result.principles = parsed.principles;
    result.goals = parsed.goals;
    result.constraints = parsed.constraints;
  } catch (e) {
    result.error = e.message;
  }

  return result;
}

/**
 * Разбирает markdown ДНК на секции второго уровня и списки внутри них.
 * Возвращает { sections, principles, goals, constraints }.
 */
function parseDNA(raw) {
  const lines = String(raw || '').split('\n');
  const sections = {};
  let current = null;

  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = h[1].trim();
      sections[current] = [];
      continue;
    }
    if (!current) continue;
    const item = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (item) sections[current].push(item[1].trim());
  }

  const pick = (...names) => {
    for (const n of names) {
      for (const key of Object.keys(sections)) {
        if (key.toLowerCase() === n.toLowerCase()) return sections[key];
      }
    }
    return [];
  };

  return {
    sections,
    principles: pick('Principles', 'Принципы'),
    goals: pick('Goals', 'Цели', 'Objectives'),
    constraints: pick('Constraints', 'Ограничения')
  };
}

// ---------------------------------------------------------------------------
// Анализ проекта (контекст для предложений)
// ---------------------------------------------------------------------------

/** Собирает компактный срез состояния проекта без тяжёлых операций. */
function analyzeProject() {
  const ctx = {
    root: PROJECT_ROOT,
    jsFiles: [],
    totalLines: 0,
    hasPromptsDir: fs.existsSync(PROMPTS_DIR),
    hasMemoryDir: fs.existsSync(MEMORY_DIR),
    proposalsExist: fs.existsSync(PROPOSALS_PATH),
    dnaExists: fs.existsSync(DNA_PATH),
    suspicious: []
  };

  try {
    const entries = fs.readdirSync(PROJECT_ROOT, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.js')) continue;
      const p = path.join(PROJECT_ROOT, e.name);
      let lines = 0;
      try {
        lines = fs.readFileSync(p, 'utf8').split('\n').length;
      } catch (err) {
        continue;
      }
      ctx.jsFiles.push({ name: e.name, lines });
      ctx.totalLines += lines;
      if (lines > 1500) ctx.suspicious.push(e.name + ': слишком большой файл');
    }
  } catch (e) {
    ctx.error = e.message;
  }

  ctx.jsFiles.sort((a, b) => b.lines - a.lines);
  return ctx;
}

// ---------------------------------------------------------------------------
// Генерация предложений
// ---------------------------------------------------------------------------

/** Фабрика предложения — гарантирует единый формат. */
function makeProposal(fields) {
  const title = fields.title || 'Untitled proposal';
  return {
    id: fields.id || slugify(title),
    title,
    type: fields.type || 'refactor',
    priority: fields.priority || 'medium',
    rationale: fields.rationale || '',
    changes: Array.isArray(fields.changes) ? fields.changes : [],
    verification: fields.verification || 'node --check <file>',
    risk: fields.risk || 'low',
    effort: fields.effort || 'S',
    impact: typeof fields.impact === 'number' ? fields.impact : 5,
    status: 'proposed',
    createdAt: nowISO()
  };
}

/** Эвристические предложения на основе среза проекта + ДНК. */
function heuristicProposals(dna, ctx) {
  const out = [];
  const names = ctx.jsFiles.map((f) => f.name);
  const hasAgentTools = names.includes('agent_tools.js');
  const hasLogger = names.some((n) => /log|usage/i.test(n));

  if (!ctx.dnaExists) {
    out.push(makeProposal({
      title: 'Создать базовую ДНК архитектора',
      type: 'docs',
      priority: 'high',
      rationale: 'Директива архитектора отсутствует — предложения генерируются вслепую.',
      changes: [{ path: 'prompts/architect_dna.md', action: 'create', summary: 'базовые принципы и рубрика' }],
      verification: 'cat prompts/architect_dna.md',
      risk: 'low',
      effort: 'S',
      impact: 8
    }));
  }

  if (hasAgentTools && !hasLogger) {
    out.push(makeProposal({
      title: 'Единый структурный логгер событий',
      type: 'refactor',
      priority: 'medium',
      rationale: 'Агенты пишут в разные места; нужен общий append-only JSON-лог.',
      changes: [{ path: 'core_logger.js', action: 'create', summary: 'logEvent/summary/TTL ротация' }],
      verification: 'node --check core_logger.js',
      risk: 'low',
      effort: 'M',
      impact: 7
    }));
  }

  for (const f of ctx.jsFiles) {
    if (f.lines > 1200) {
      out.push(makeProposal({
        title: 'Декомпозировать ' + f.name,
        type: 'refactor',
        priority: 'medium',
        rationale: f.name + ' содержит ' + f.lines + ' строк — тяжело сопровождать.',
        changes: [{ path: f.name, action: 'split', summary: 'выделить чистые хелперы в отдельный модуль' }],
        verification: 'node --check ' + f.name,
        risk: 'medium',
        effort: 'L',
        impact: 6
      }));
    }
  }

  if (!ctx.proposalsExist) {
    out.push(makeProposal({
      title: 'Ввести реестр архитектурных предложений',
      type: 'feature',
      priority: 'high',
      rationale: 'Пока нет memory/architect_proposals.json — решения не отслеживаются.',
      changes: [{ path: 'memory/architect_proposals.json', action: 'create', summary: 'массив proposal-объектов' }],
      verification: 'ls -la memory/architect_proposals.json',
      risk: 'low',
      effort: 'S',
      impact: 8
    }));
  }

  // Предложения, вытекающие из ДНК
  for (const goal of dna.goals.slice(0, 6)) {
    out.push(makeProposal({
      title: 'Цель: ' + (goal.length > 60 ? goal.slice(0, 57) + '...' : goal),
      type: 'feature',
      priority: 'medium',
      rationale: 'Заложено в ДНК архитектора как стратегическая цель.',
      changes: [{ path: 'ROADMAP.md', action: 'update', summary: 'зафиксировать шаги достижения цели' }],
      verification: 'cat ROADMAP.md',
      risk: 'low',
      effort: 'M',
      impact: 6
    }));
  }

  return out;
}

/** Опциональная генерация через DeepSeek, если есть ключ. Никогда не бросает. */
async function llmProposals(dna, ctx) {
  loadEnvFallback();
  if (!process.env.DEEPSEEK_API_KEY) return [];
  let askDeepSeek;
  try {
    ({ askDeepSeek } = require('./llm_client'));
  } catch (e) {
    return [];
  }

  const sys = 'Ты архитектор ПО в проекте Aeon. Отвечай СТРОГО JSON-массивом объектов ' +
    'с полями: title, type, priority, rationale, changes[{path,action,summary}], ' +
    'verification, risk, effort, impact(number 0-10). Без markdown.';
  const user = 'ДНК:\n' + dna.raw.slice(0, 3000) +
    '\n\nСрез проекта (top js по строкам):\n' +
    ctx.jsFiles.slice(0, 12).map((f) => f.name + ' (' + f.lines + ')').join('\n');

  try {
    const text = await askDeepSeek(sys, user, 2000);
    const cleaned = text.replace(/```json|```/g, '').trim();
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start === -1 || end === -1) return [];
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 8).map((p) => makeProposal(p));
  } catch (e) {
    logEvent('llm_error', { message: e.message });
    return [];
  }
}

/** Объединяет источники, дедуплицирует и сортирует по impact/priority. */
function generateProposals(dna, ctx, extra) {
  const all = [...(extra || []), ...heuristicProposals(dna, ctx)];
  const seen = new Set();
  const unique = [];
  const weight = { critical: 4, high: 3, medium: 2, low: 1 };

  for (const p of all) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    unique.push(p);
  }

  unique.sort((a, b) => {
    const pw = (weight[b.priority] || 0) - (weight[a.priority] || 0);
    if (pw !== 0) return pw;
    return (b.impact || 0) - (a.impact || 0);
  });

  return unique.slice(0, MAX_PROPOSALS);
}

// ---------------------------------------------------------------------------
// Основной API: propose()
// ---------------------------------------------------------------------------

/**
 * propose({ dryRun, useLLM, persist })
 *  - читает ДНК, анализирует проект, генерирует предложения;
 *  - в dry-run (по умолчанию) НЕ пишет на диск, только возвращает;
 *  - при persist/--apply — атомарно пишет memory/architect_proposals.json.
 */
async function propose(opts) {
  const options = Object.assign(
    { dryRun: DRY_RUN_DEFAULT, useLLM: true, persist: false },
    opts || {}
  );

  const dna = loadDNA();
  const ctx = analyzeProject();

  let extra = [];
  if (options.useLLM) {
    extra = await llmProposals(dna, ctx);
  }

  const proposals = generateProposals(dna, ctx, extra);

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: nowISO(),
    generator: 'architect_agent.js',
    dryRun: !!options.dryRun,
    dnaFound: dna.found,
    dnaPath: path.relative(PROJECT_ROOT, DNA_PATH),
    project: {
      root: ctx.root,
      jsFiles: ctx.jsFiles.length,
      totalLines: ctx.totalLines,
      suspicious: ctx.suspicious
    },
    count: proposals.length,
    proposals
  };

  let written = false;
  const shouldWrite = options.persist || options.dryRun === false;
  if (shouldWrite) {
    if (PROPOSALS_PATH.includes('.env') || isForbiddenPath(PROPOSALS_PATH)) {
      logEvent('blocked_write', { path: PROPOSALS_PATH });
    } else {
      writeJSONAtomic(PROPOSALS_PATH, payload);
      written = true;
    }
  }

  logEvent('propose', {
    dryRun: !!options.dryRun,
    written,
    count: proposals.length,
    dnaFound: dna.found
  });

  return {
    ok: true,
    dryRun: !!options.dryRun,
    written,
    dna: {
      found: dna.found,
      path: dna.path,
      principles: dna.principles.length,
      goals: dna.goals.length,
      constraints: dna.constraints.length,
      error: dna.error
    },
    proposals,
    count: proposals.length,
    file: PROPOSALS_PATH
  };
}

// ---------------------------------------------------------------------------
// Review: оценка предложений
// ---------------------------------------------------------------------------

/** Оценивает одно предложение по рубрике ДНК. */
function scoreProposal(p) {
  const impact = clamp(p.impact != null ? p.impact : 5, 0, 10);

  let feasibility = 8;
  if (p.effort === 'L') feasibility = 4;
  else if (p.effort === 'M') feasibility = 6;
  else if (p.effort === 'S') feasibility = 9;

  const risky = (p.changes || []).some((c) => isForbiddenPath(c && c.path || ''));
  let safety = 10;
  if (p.risk === 'high' || risky) safety = 2;
  else if (p.risk === 'medium') safety = 6;

  let clarity = 5;
  if (p.rationale && p.rationale.length > 10) clarity += 2;
  if (p.verification && p.verification.length > 3) clarity += 2;
  if (Array.isArray(p.changes) && p.changes.length) clarity += 1;
  clarity = clamp(clarity, 0, 10);

  const score = round1(impact * 0.35 + feasibility * 0.2 + safety * 0.3 + clarity * 0.15);
  const approve = score >= 7 && safety >= 6 && (p.risk !== 'high');

  return {
    id: p.id,
    title: p.title,
    impact,
    feasibility,
    safety,
    clarity,
    score,
    verdict: approve ? 'approve' : 'reject',
    reasons: buildReasons(p, { impact, feasibility, safety, clarity })
  };
}

function buildReasons(p, s) {
  const r = [];
  if (s.safety <= 2) r.push('blast radius: затрагивает защищённые пути');
  if (s.feasibility <= 4) r.push('большой объём работ (effort=L)');
  if (s.clarity < 7) r.push('недостаточно конкретики в rationale/verification');
  if (s.impact >= 8) r.push('высокое влияние на систему');
  if (!r.length) r.push('соответствует рубрике ДНК');
  return r;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(n) || 0));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * review({ proposals, persist })
 *  - если proposals не переданы, читает memory/architect_proposals.json;
 *  - оценивает каждое, формирует сводный отчёт и вердикт;
 *  - при persist — пишет memory/architect_review.json.
 */
function review(opts) {
  const options = Object.assign({ proposals: null, persist: false }, opts || {});

  let list = options.proposals;
  if (!list) {
    const payload = readJSONSafe(PROPOSALS_PATH, null);
    list = payload && Array.isArray(payload.proposals) ? payload.proposals : [];
  }
  if (!Array.isArray(list)) list = [];

  const reviewed = list.map(scoreProposal);
  const approved = reviewed.filter((r) => r.verdict === 'approve');
  const rejected = reviewed.filter((r) => r.verdict !== 'approve');
  const avg = reviewed.length
    ? round1(reviewed.reduce((a, r) => a + r.score, 0) / reviewed.length)
    : 0;

  const report = {
    schemaVersion: SCHEMA_VERSION,
    reviewedAt: nowISO(),
    generator: 'architect_agent.js:review',
    total: reviewed.length,
    approved: approved.length,
    rejected: rejected.length,
    avgScore: avg,
    topPriority: approved.slice().sort((a, b) => b.score - a.score).slice(0, 5),
    items: reviewed,
    summary: buildSummary(approved.length, rejected.length, avg)
  };

  if (options.persist) {
    if (!isForbiddenPath(REVIEW_PATH)) {
      writeJSONAtomic(REVIEW_PATH, report);
    }
  }

  logEvent('review', {
    total: reviewed.length,
    approved: approved.length,
    avg
  });

  return {
    ok: true,
    reviewed: reviewed.length,
    approved: approved.length,
    rejected: rejected.length,
    avgScore: avg,
    report,
    file: REVIEW_PATH
  };
}

function buildSummary(approved, rejected, avg) {
  if (approved + rejected === 0) return 'Нет предложений для ревью.';
  if (approved === 0) return 'Ни одно предложение не прошло рубрику (avg=' + avg + ').';
  return 'Одобрено ' + approved + ' из ' + (approved + rejected) +
    ' предложений (avg=' + avg + ').';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    if (a === '--review') args.review = true;
    if (a === '--json') args.json = true;
    if (a === '--no-llm') args.noLLM = true;
    if (a.startsWith('--dna=')) args.dna = a.slice(6);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.review) {
    const res = review({ persist: true, proposals: null });
    if (args.json) console.log(JSON.stringify(res, null, 2));
    else console.log('[review]', res.report.summary);
    return;
  }

  const res = await propose({
    dryRun: !args.apply,
    useLLM: !args.noLLM,
    persist: !!args.apply
  });

  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.log('[propose] dryRun=' + res.dryRun + ' written=' + res.written +
    ' count=' + res.count + ' dnaFound=' + res.dna.found);
  for (const p of res.proposals) {
    console.log(' - [' + p.priority + '/' + p.type + '] ' + p.title + ' (impact=' + p.impact + ')');
  }
  if (res.dryRun) {
    console.log('(dry-run: файл не перезаписан; используйте --apply для записи)');
  }
}

if (require.main === module) {
  main().catch((e) => {
    logEvent('fatal', { message: e.message });
    console.error('[architect_agent] fatal:', e.message);
    process.exitCode = 1;
  });
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

module.exports = {
  // основной API
  propose,
  review,
  // хелперы
  loadDNA,
  parseDNA,
  analyzeProject,
  generateProposals,
  heuristicProposals,
  llmProposals,
  scoreProposal,
  buildSummary,
  slugify,
  nowISO,
  writeJSONAtomic,
  readJSONSafe,
  isForbiddenPath,
  logEvent,
  // константы
  PROJECT_ROOT,
  DNA_PATH,
  PROPOSALS_PATH,
  REVIEW_PATH,
  LOG_PATH
};
