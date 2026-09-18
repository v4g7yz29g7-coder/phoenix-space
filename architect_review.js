#!/usr/bin/env node
/**
 * architect_review.js — Ревью предложений Архитектора Aeon
 * ============================================================================
 * Назначение:
 *   Очередь модерации (human-in-the-loop) для предложений, которые генерирует
 *   architect-агент (architect_agent.js / architect_dna_builder.js).
 *   Позволяет оператору или агенту-ревьюеру просматривать proposals и
 *   принимать решение approve / reject с обязательной причиной.
 *
 * Публичный API (модуль):
 *   - show()             -> { ok, count, proposals, stats }   // список + очередь
 *   - show(id)           -> { ok, proposal }                  // одно предложение
 *   - approve(id)        -> { ok, id, status, decision }      // одобрить
 *   - reject(id, reason) -> { ok, id, status, decision }      // отклонить
 *   - pending()          -> массив предложений без решения
 *   - stats()            -> агрегированная статистика по решениям
 *   - reset(id)          -> сбросить решение по предложению
 *
 * CLI:
 *   node architect_review.js show
 *   node architect_review.js show <id>
 *   node architect_review.js approve <id>
 *   node architect_review.js reject <id> "причина отклонения"
 *   node architect_review.js stats
 *   node architect_review.js pending
 *
 * Гарантии:
 *   - атомарная запись решения (temp-file + rename)
 *   - идемпотентность: повторный approve/reject не дублирует запись
 *   - reject БЕЗ непустой причины запрещён
 *   - исходный proposals-файл не мутируется (read-only)
 *   - все ошибки перехватываются, наружу отдаётся { ok:false, error }
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Пути и константы
// ---------------------------------------------------------------------------

const PROJECT_ROOT = path.resolve(__dirname);
const MEMORY_DIR = path.join(PROJECT_ROOT, 'memory');
const CORPUS_DIR = path.join(PROJECT_ROOT, 'corpus', 'architect');

// Основной источник предложений + запасной путь (для устойчивости).
const PROPOSALS_CANDIDATES = [
  path.join(MEMORY_DIR, 'architect_proposals.json'),
  path.join(CORPUS_DIR, 'proposals.json')
];

// Файл сохранённых решений ревьюера.
const REVIEW_PATH = path.join(MEMORY_DIR, 'architect_review.json');
// Append-only лог ревью.
const LOG_PATH = path.join(MEMORY_DIR, 'architect_review.log');

const SCHEMA_VERSION = 1;
const VALID_DECISIONS = ['approved', 'rejected'];
const DEFAULT_REVIEWER = 'architect_review';

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

/** Текущая ISO-метка времени. */
function nowISO() {
  return new Date().toISOString();
}

/** Гарантирует существование каталога. */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Чтение JSON с безопасным дефолтом (никогда не бросает). */
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

/** Атомарная запись JSON: temp-file + rename. */
function writeJSONAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  ensureDir(dir);
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

/** Append-only лог ревью; никогда не бросает наружу. */
function logEvent(kind, data) {
  try {
    ensureDir(MEMORY_DIR);
    const line = JSON.stringify({ ts: nowISO(), kind, data: data || {} }) + '\n';
    fs.appendFileSync(LOG_PATH, line);
  } catch (e) {
    /* логирование не должно ломать основной поток */
  }
}

/** Нормализация id (обрезка пробелов). */
function normalizeId(id) {
  return String(id == null ? '' : id).trim();
}

/** Отображаемый заголовок предложения (устойчиво к разным схемам). */
function titleOf(p) {
  if (!p || typeof p !== 'object') return '(untitled)';
  return p.title || p.summary || p.name || p.source_item || p.id || '(untitled)';
}

/** Тело предложения (устойчиво к разным схемам). */
function bodyOf(p) {
  if (!p || typeof p !== 'object') return '';
  return p.body || p.description || p.rationale || p.text || '';
}

// ---------------------------------------------------------------------------
// Загрузка предложений и решений
// ---------------------------------------------------------------------------

/** Определяет, какой из candidate-путей существует. */
function resolveProposalsPath() {
  for (const p of PROPOSALS_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return PROPOSALS_CANDIDATES[0];
}

/** Читает proposals-файл архитектора. */
function loadProposals() {
  const filePath = resolveProposalsPath();
  const data = readJSONSafe(filePath, null);
  if (!data) {
    return { ok: false, error: 'proposals file not found: ' + filePath, proposals: [] };
  }
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data.proposals)) list = data.proposals;
  // Нормализуем: гарантируем наличие id и строки-title.
  list = list.map((p, idx) => {
    const obj = (p && typeof p === 'object') ? Object.assign({}, p) : { value: p };
    if (!obj.id) obj.id = 'prop_index_' + idx;
    return obj;
  });
  return { ok: true, meta: data.meta || {}, source: filePath, proposals: list };
}

/** Читает сохранённые решения ревьюера. */
function loadReview() {
  const data = readJSONSafe(REVIEW_PATH, null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { version: SCHEMA_VERSION, updated_at: null, decisions: {} };
  }
  if (!data.decisions || typeof data.decisions !== 'object') data.decisions = {};
  return data;
}

/** Сохраняет решения на диск (атомарно). */
function saveReview(review) {
  review.version = SCHEMA_VERSION;
  review.updated_at = nowISO();
  return writeJSONAtomic(REVIEW_PATH, review);
}

/**
 * Объединяет предложения с решениями: возвращает массив
 * { ...proposal, status, decision, decided_at, reason, reviewer }.
 */
function merged() {
  const p = loadProposals();
  if (!p.ok) return p;
  const review = loadReview();
  const proposals = p.proposals.map((prop) => {
    const d = review.decisions[prop.id];
    const decision = d ? d.decision : (prop.status === 'approved' || prop.status === 'rejected'
      ? prop.status : 'pending');
    return Object.assign({}, prop, {
      decision: decision,
      status: decision,
      decided_at: (d && d.decided_at) || prop.decided_at || null,
      reason: (d && d.reason != null) ? d.reason : (prop.reason || null),
      reviewer: (d && d.reviewer) || prop.reviewer || null
    });
  });
  return { ok: true, meta: p.meta, source: p.source, proposals };
}

/** Внутренний поиск предложения по id с учётом решения. */
function findProposal(id) {
  const m = merged();
  if (!m.ok) return m;
  const pid = normalizeId(id);
  const proposal = m.proposals.find((x) => String(x.id) === pid) || null;
  if (!proposal) {
    return { ok: false, error: 'proposal not found: ' + pid, proposals: m.proposals };
  }
  return { ok: true, proposal, proposals: m.proposals };
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/**
 * show()             — вернуть список предложений и статистику очереди.
 * show(id)           — вернуть одно предложение по id.
 */
function show(id) {
  try {
    if (id != null && normalizeId(id) !== '') {
      const found = findProposal(id);
      if (!found.ok) {
        logEvent('show.miss', { id: normalizeId(id), error: found.error });
        return { ok: false, error: found.error };
      }
      logEvent('show.one', { id: found.proposal.id });
      return { ok: true, proposal: found.proposal };
    }

    const m = merged();
    if (!m.ok) return { ok: false, error: m.error };
    const s = aggregate(m.proposals);
    logEvent('show.list', { count: m.proposals.length });
    return { ok: true, count: m.proposals.length, proposals: m.proposals, stats: s };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Только нерешённые предложения (очередь ревью). */
function pending() {
  const m = merged();
  if (!m.ok) return [];
  return m.proposals.filter((p) => p.decision === 'pending');
}

/** Агрегированная статистика решений. */
function aggregate(proposals) {
  const stats = {
    total: proposals.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    byScope: {}
  };
  for (const p of proposals) {
    if (p.decision === 'approved') stats.approved++;
    else if (p.decision === 'rejected') stats.rejected++;
    else stats.pending++;

    const scope = p.scope || p.source_section || p.action || 'unknown';
    stats.byScope[scope] = stats.byScope[scope] ||
      { total: 0, approved: 0, rejected: 0, pending: 0 };
    stats.byScope[scope].total++;
    stats.byScope[scope][p.decision === 'approved' ? 'approved'
      : p.decision === 'rejected' ? 'rejected' : 'pending']++;
  }
  stats.approvalRate = stats.total
    ? Number(((stats.approved / stats.total) * 100).toFixed(1))
    : 0;
  return stats;
}

/** Обёртка статистики для API/CLI. */
function stats() {
  try {
    const m = merged();
    if (!m.ok) return { ok: false, error: m.error };
    return { ok: true, stats: aggregate(m.proposals), updated_at: loadReview().updated_at };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Записывает решение по предложению (идемпотентно).
 * @param {string} id
 * @param {'approved'|'rejected'} decision
 * @param {string} reason
 * @param {string} reviewer
 */
function decide(id, decision, reason, reviewer) {
  if (VALID_DECISIONS.indexOf(decision) === -1) {
    return { ok: false, error: 'invalid decision: ' + decision };
  }
  const pid = normalizeId(id);
  if (!pid) return { ok: false, error: 'id is required' };

  const found = findProposal(pid);
  if (!found.ok) {
    logEvent('decide.miss', { id: pid, decision });
    return { ok: false, error: found.error };
  }

  const review = loadReview();
  const prev = review.decisions[pid] || null;
  const entry = {
    decision: decision,
    reason: reason == null ? null : String(reason).trim(),
    reviewer: reviewer || DEFAULT_REVIEWER,
    decided_at: nowISO(),
    prev_decision: prev ? prev.decision : null
  };
  review.decisions[pid] = entry;
  saveReview(review);
  logEvent('decide', { id: pid, decision: decision, reason: entry.reason });
  return { ok: true, id: pid, status: decision, decision: entry };
}

/** Одобрить предложение. approve(id) */
function approve(id, reviewer) {
  try {
    return decide(id, 'approved', null, reviewer);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Отклонить предложение — причина обязательна. reject(id, reason) */
function reject(id, reason, reviewer) {
  try {
    if (reason == null || String(reason).trim() === '') {
      return { ok: false, error: 'reject requires a non-empty reason' };
    }
    return decide(id, 'rejected', reason, reviewer);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Сбросить решение по предложению (вернуть в очередь). */
function reset(id) {
  try {
    const pid = normalizeId(id);
    if (!pid) return { ok: false, error: 'id is required' };
    const review = loadReview();
    if (!review.decisions[pid]) {
      return { ok: false, error: 'no decision to reset for: ' + pid };
    }
    delete review.decisions[pid];
    saveReview(review);
    logEvent('reset', { id: pid });
    return { ok: true, id: pid, status: 'pending' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Форматирование для консоли
// ---------------------------------------------------------------------------

/** Человекочитаемая строка предложения. */
function fmtRow(p, short) {
  const scope = p.scope || p.source_section || p.action || '-';
  const sev = p.severity || p.risk || p.impact || '-';
  const head = '[' + p.decision + '] ' + p.id + ' (' + scope + '/' + sev + ')';
  if (short) return head + ' — ' + titleOf(p);
  const lines = [
    head,
    '  title   : ' + titleOf(p),
    '  body    : ' + bodyOf(p).replace(/\s+/g, ' ').slice(0, 120),
    '  action  : ' + (p.action || '-'),
    '  target  : ' + (p.target || '-'),
    '  conf    : ' + (p.confidence != null ? p.confidence : '-') +
      '  effort: ' + (p.effort || '-')
  ];
  if (p.decision === 'rejected' && p.reason) lines.push('  reason  : ' + p.reason);
  return lines.join('\n');
}

/** Печать результата CLI. */
function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const cmd = (argv[0] || 'show').toLowerCase();
  const a1 = argv[1];
  const a2 = argv[2];
  let out;

  switch (cmd) {
    case 'show':
      out = show(a1);
      if (out.ok && out.proposals) {
        console.log('count=' + out.count + ' ' + JSON.stringify(out.stats));
        for (const p of out.proposals) console.log(fmtRow(p, true));
        return 0;
      }
      if (out.ok && out.proposal) {
        console.log(fmtRow(out.proposal, false));
        return 0;
      }
      print(out);
      return out.ok ? 0 : 1;
    case 'approve':
      out = approve(a1, 'cli');
      print(out);
      return out.ok ? 0 : 1;
    case 'reject':
      out = reject(a1, a2, 'cli');
      print(out);
      return out.ok ? 0 : 1;
    case 'reset':
      out = reset(a1);
      print(out);
      return out.ok ? 0 : 1;
    case 'stats':
      out = stats();
      print(out);
      return out.ok ? 0 : 1;
    case 'pending':
      out = { ok: true, count: pending().length, proposals: pending() };
      print(out);
      return 0;
    default:
      print({ ok: false, error: 'unknown command: ' + cmd });
      return 1;
  }
}

module.exports = {
  show,
  approve,
  reject,
  reset,
  pending,
  stats,
  // хелперы для тестов и оператора
  aggregate,
  loadProposals,
  loadReview,
  findProposal,
  nowISO,
  REVIEW_PATH,
  LOG_PATH
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
