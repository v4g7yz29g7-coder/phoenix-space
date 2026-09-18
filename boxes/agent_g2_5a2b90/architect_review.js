// ============================================================================
//  architect_review.js — Ревью предложений Архитектора (approve / reject)
// ----------------------------------------------------------------------------
//  Назначение:
//    Модуль принимает предложения от агента-Архитектора, хранит их в очереди
//    ревью и позволяет принять решение: approve(id) либо reject(id, reason).
//    Каждое решение фиксируется в истории предложения и в общем audit-логе.
//
//  Публичный API:
//    show(options)          -> { ok, count, items: [...] }   // список предложений
//    approve(id, meta?)     -> { ok, proposal }              // одобрить
//    reject(id, reason)     -> { ok, proposal }              // отклонить (reason обязателен)
//
//  Дополнительно (для тестов и повторного использования):
//    addProposal(input), getProposal(id), listProposals(), stats(), exportReport()
//
//  Совместимо со стилем Aeon: CommonJS, fs/path, атомарная запись JSON,
//  CLI через `node architect_review.js <command> [args]`.
// ============================================================================

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Конфигурация и пути
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // Где хранится очередь предложений относительно корня модуля.
  storeDir: 'memory',
  storeFile: 'architect_proposals.json',
  // Лимит на длину summary в символах (защита от «простыней»).
  maxSummaryLength: 2000,
  // Минимальная длина причины отклонения.
  minRejectReasonLength: 3,
  // Допустимые статусы жизненного цикла предложения.
  statuses: ['pending', 'approved', 'rejected'],
  priorities: ['low', 'normal', 'high', 'critical'],
};

const MODULE_DIR = __dirname;
const STORE_PATH = path.resolve(MODULE_DIR, DEFAULTS.storeDir, DEFAULTS.storeFile);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Персистентность (атомарная запись)
// ---------------------------------------------------------------------------

function emptyStore() {
  return { version: 1, proposals: [], audit: [] };
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return emptyStore();
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    if (!raw.trim()) return emptyStore();
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version || 1,
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  } catch (e) {
    // Повреждённый файл не должен ронять ревью — начинаем с пустой очереди.
    return emptyStore();
  }
}

function saveStore(store) {
  ensureDir(path.dirname(STORE_PATH));
  const tmp = STORE_PATH + '.tmp_' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_PATH); // атомарная замена
  return { ok: true, path: STORE_PATH };
}

function audit(store, entry) {
  store.audit.push(Object.assign({ at: new Date().toISOString() }, entry));
  // Держим лог компактным: не более 5000 последних записей.
  if (store.audit.length > 5000) store.audit = store.audit.slice(-5000);
}

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

function generateId(seq) {
  const stamp = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return 'prop-' + stamp + '-' + String(seq).padStart(3, '0') + '-' + rnd;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePriority(p) {
  return DEFAULTS.priorities.includes(p) ? p : 'normal';
}

function clampText(text, limit) {
  const s = String(text == null ? '' : text);
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

// Оценка риска предложения до принятия решения.
function assessRisk(proposal) {
  const reasons = [];
  let score = 0;
  const target = String(proposal.target || '');
  if (/\.env($|\.)/.test(target)) { score += 40; reasons.push('затрагивает .env'); }
  if (/(^|\/)\.git\//.test(target)) { score += 30; reasons.push('изменения в .git'); }
  if (/(node_modules|\/node_modules\/)/.test(target)) { score += 25; reasons.push('пишет в node_modules'); }
  if (/\.(db|sqlite)$/.test(target)) { score += 35; reasons.push('работа с БД напрямую'); }
  if (proposal.requiresRestart) { score += 15; reasons.push('требует перезапуска сервиса'); }
  if (proposal.touchesProduction) { score += 20; reasons.push('production-контур'); }

  let level = 'low';
  if (score >= 45) level = 'critical';
  else if (score >= 25) level = 'high';
  else if (score >= 10) level = 'medium';
  return { score, level, reasons };
}

// ---------------------------------------------------------------------------
// Валидация входящего предложения
// ---------------------------------------------------------------------------

function validateProposalInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['input is not an object'] };
  const title = String(input.title || '').trim();
  if (!title) errors.push('title обязателен');
  if (title.length > 200) errors.push('title слишком длинный (max 200)');
  const summary = String(input.summary || '').trim();
  if (!summary) errors.push('summary обязателен');
  if (summary.length > DEFAULTS.maxSummaryLength) errors.push('summary слишком длинный');
  return { ok: errors.length === 0, errors };
}

function makeProposal(input, seq) {
  const priority = normalizePriority(input.priority);
  const base = {
    id: input.id || generateId(seq),
    title: String(input.title).trim(),
    summary: clampText(input.summary, DEFAULTS.maxSummaryLength),
    author: input.author || 'architect',
    target: input.target || '',
    priority,
    tags: Array.isArray(input.tags) ? input.tags.slice(0, 20) : [],
    requiresRestart: !!input.requiresRestart,
    touchesProduction: !!input.touchesProduction,
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    decision: null,
    history: [],
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  };
  base.risk = assessRisk(base);
  base.history.push({ at: base.createdAt, action: 'created', by: base.author });
  return base;
}

// ---------------------------------------------------------------------------
// Базовые операции над хранилищем
// ---------------------------------------------------------------------------

function listProposals(filter) {
  const store = loadStore();
  let items = store.proposals.slice();
  const f = filter || {};
  if (f.status) items = items.filter((p) => p.status === f.status);
  if (f.priority) items = items.filter((p) => p.priority === f.priority);
  if (f.author) items = items.filter((p) => p.author === f.author);
  if (f.tag) items = items.filter((p) => (p.tags || []).includes(f.tag));
  // Сначала новые.
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (typeof f.limit === 'number' && f.limit > 0) items = items.slice(0, f.limit);
  return items;
}

function getProposal(id) {
  if (!id) return null;
  const store = loadStore();
  return store.proposals.find((p) => p.id === id) || null;
}

function addProposal(input) {
  const check = validateProposalInput(input);
  if (!check.ok) return { ok: false, error: 'validation failed', details: check.errors };
  const store = loadStore();
  if (input.id && store.proposals.some((p) => p.id === input.id)) {
    return { ok: false, error: 'duplicate id: ' + input.id };
  }
  const proposal = makeProposal(input, store.proposals.length + 1);
  store.proposals.push(proposal);
  audit(store, { action: 'add', id: proposal.id, by: proposal.author });
  saveStore(store);
  return { ok: true, proposal };
}

// ---------------------------------------------------------------------------
// Публичный API: show()
// ---------------------------------------------------------------------------

function formatProposal(p) {
  const risk = p.risk ? p.risk.level + '(' + p.risk.score + ')' : 'n/a';
  const lines = [
    '[' + p.status.toUpperCase() + '] ' + p.id,
    '  title   : ' + p.title,
    '  author  : ' + p.author + '  priority: ' + p.priority + '  risk: ' + risk,
    '  target  : ' + (p.target || '—'),
    '  created : ' + p.createdAt + '  updated: ' + p.updatedAt,
    '  summary : ' + clampText(p.summary, 200),
  ];
  if (p.decision) {
    lines.push('  decision: ' + p.decision.action + ' by ' + p.decision.by +
      (p.decision.reason ? ' — ' + clampText(p.decision.reason, 160) : ''));
  }
  return lines.join('\n');
}

/**
 * show(options) — показать очередь предложений.
 * @param {object} [options]
 * @param {string} [options.id]      — показать одно предложение по id
 * @param {string} [options.status]  — фильтр по статусу (pending/approved/rejected)
 * @param {string} [options.priority]
 * @param {number} [options.limit]
 * @param {boolean}[options.raw]     — вернуть объекты, а не строки (для API)
 * @returns {{ok:boolean, count:number, items:any[]}}
 */
function show(options) {
  const opts = options || {};
  if (opts.id) {
    const p = getProposal(opts.id);
    if (!p) return { ok: false, error: 'not found: ' + opts.id, count: 0, items: [] };
    return {
      ok: true,
      count: 1,
      items: opts.raw ? [p] : [formatProposal(p)],
      text: opts.raw ? undefined : formatProposal(p),
    };
  }
  const items = listProposals(opts);
  const rendered = opts.raw ? items : items.map(formatProposal);
  return {
    ok: true,
    count: items.length,
    items: rendered,
    text: opts.raw ? undefined : (rendered.join('\n\n') || '(очередь пуста)'),
  };
}

// ---------------------------------------------------------------------------
// Публичный API: approve(id)
// ---------------------------------------------------------------------------

/**
 * approve(id, meta) — одобрить предложение.
 * @param {string} id
 * @param {object} [meta] — { by, note }
 */
function approve(id, meta) {
  const m = meta || {};
  const by = m.by || 'reviewer';
  if (!id) return { ok: false, error: 'id is required' };

  const store = loadStore();
  const p = store.proposals.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'not found: ' + id };
  if (p.status === 'approved') return { ok: false, error: 'already approved', proposal: p };
  if (p.status === 'rejected') return { ok: false, error: 'rejected proposals must be reopened first', proposal: p };

  const at = nowIso();
  p.status = 'approved';
  p.updatedAt = at;
  p.decision = { action: 'approve', by, at, reason: m.note || '' };
  p.history.push({ at, action: 'approved', by, note: m.note || '' });
  audit(store, { action: 'approve', id, by });
  saveStore(store);
  return { ok: true, proposal: p };
}

// ---------------------------------------------------------------------------
// Публичный API: reject(id, reason)
// ---------------------------------------------------------------------------

/**
 * reject(id, reason, meta) — отклонить предложение. Причина обязательна.
 * @param {string} id
 * @param {string} reason
 * @param {object} [meta] — { by }
 */
function reject(id, reason, meta) {
  const m = meta || {};
  const by = m.by || 'reviewer';
  if (!id) return { ok: false, error: 'id is required' };
  const text = String(reason == null ? '' : reason).trim();
  if (text.length < DEFAULTS.minRejectReasonLength) {
    return { ok: false, error: 'rejection reason is required (min ' + DEFAULTS.minRejectReasonLength + ' chars)' };
  }

  const store = loadStore();
  const p = store.proposals.find((x) => x.id === id);
  if (!p) return { ok: false, error: 'not found: ' + id };
  if (p.status === 'rejected') return { ok: false, error: 'already rejected', proposal: p };

  const at = nowIso();
  p.status = 'rejected';
  p.updatedAt = at;
  p.decision = { action: 'reject', by, at, reason: text };
  p.history.push({ at, action: 'rejected', by, reason: text });
  audit(store, { action: 'reject', id, by, reason: text });
  saveStore(store);
  return { ok: true, proposal: p };
}

// ---------------------------------------------------------------------------
// Аналитика и экспорт
// ---------------------------------------------------------------------------

function stats() {
  const store = loadStore();
  const byStatus = { pending: 0, approved: 0, rejected: 0 };
  const byPriority = { low: 0, normal: 0, high: 0, critical: 0 };
  let risky = 0;
  for (const p of store.proposals) {
    byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    byPriority[p.priority] = (byPriority[p.priority] || 0) + 1;
    if (p.risk && (p.risk.level === 'high' || p.risk.level === 'critical')) risky++;
  }
  return {
    ok: true,
    total: store.proposals.length,
    byStatus,
    byPriority,
    highRisk: risky,
    auditEntries: store.audit.length,
  };
}

function exportReport() {
  const store = loadStore();
  const pending = store.proposals.filter((p) => p.status === 'pending');
  const lines = [
    '# Architect Review Report',
    '',
    '- generated: ' + nowIso(),
    '- total: ' + store.proposals.length,
    '- pending: ' + pending.length,
    '',
    '## Pending',
    '',
  ];
  if (!pending.length) lines.push('(нет предложений в очереди)');
  for (const p of pending) {
    lines.push('### ' + p.title + ' (' + p.priority + ')');
    lines.push('- id: ' + p.id);
    lines.push('- target: ' + (p.target || '—'));
    lines.push('- risk: ' + (p.risk ? p.risk.level + '/' + p.risk.score : 'n/a'));
    lines.push('- summary: ' + p.summary);
    lines.push('');
  }
  return { ok: true, markdown: lines.join('\n'), pending: pending.length };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsage() {
  process.stdout.write([
    'Usage: node architect_review.js <command> [args]',
    '',
    '  show [status]              показать очередь (опц. фильтр: pending/approved/rejected)',
    '  approve <id>               одобрить предложение',
    '  reject <id> <reason...>    отклонить предложение (причина обязательна)',
    '  add <json>                 добавить предложение из JSON-строки',
    '  stats                      сводная статистика',
    '  report                     экспорт отчёта по pending (markdown)',
    '',
  ].join('\n'));
}

if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') {
      printUsage();
      process.exitCode = 0;
    } else if (cmd === 'show') {
      const res = show({ status: rest[0] });
      process.stdout.write(res.text + '\n');
      process.exitCode = res.ok ? 0 : 1;
    } else if (cmd === 'approve') {
      const res = approve(rest[0], { by: process.env.REVIEWER || 'cli' });
      process.stdout.write(JSON.stringify(res.ok ? { ok: true, id: res.proposal.id, status: res.proposal.status } : res, null, 2) + '\n');
      process.exitCode = res.ok ? 0 : 1;
    } else if (cmd === 'reject') {
      const id = rest[0];
      const reason = rest.slice(1).join(' ');
      const res = reject(id, reason, { by: process.env.REVIEWER || 'cli' });
      process.stdout.write(JSON.stringify(res.ok ? { ok: true, id: res.proposal.id, status: res.proposal.status } : res, null, 2) + '\n');
      process.exitCode = res.ok ? 0 : 1;
    } else if (cmd === 'add') {
      const payload = JSON.parse(rest.join(' ') || '{}');
      const res = addProposal(payload);
      process.stdout.write(JSON.stringify(res.ok ? { ok: true, id: res.proposal.id } : res, null, 2) + '\n');
      process.exitCode = res.ok ? 0 : 1;
    } else if (cmd === 'stats') {
      process.stdout.write(JSON.stringify(stats(), null, 2) + '\n');
    } else if (cmd === 'report') {
      process.stdout.write(exportReport().markdown + '\n');
    } else {
      process.stderr.write('Unknown command: ' + cmd + '\n');
      printUsage();
      process.exitCode = 2;
    }
  } catch (err) {
    process.stderr.write('[architect_review] ERROR: ' + (err && err.stack) + '\n');
    process.exitCode = 1;
  }
}

module.exports = {
  show,
  approve,
  reject,
  // вспомогательное
  addProposal,
  getProposal,
  listProposals,
  stats,
  exportReport,
  formatProposal,
  assessRisk,
  validateProposalInput,
  loadStore,
  saveStore,
  ensureDir,
  DEFAULTS,
  STORE_PATH,
};
