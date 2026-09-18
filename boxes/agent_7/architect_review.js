#!/usr/bin/env node
/**
 * architect_review.js — Ревью предложений Архитектора Aeon
 * ============================================================================
 * Назначение:
 *   Очередь модерации (human-in-the-loop) для предложений, которые генерирует
 *   architect_agent.js. Позволяет оператору/агенту-ревьюеру просматривать
 *   proposals и принимать решение approve / reject с обязательной причиной.
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
 *
 * Гарантии:
 *   - атомарная запись решения (temp-file + rename)
 *   - идемпотентность: повторный approve/reject не дублирует запись
 *   - reject БЕЗ непустой причины запрещён
 *   - исходный architect_proposals.json не мутируется (read-only)
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
const PROPOSALS_PATH = path.join(MEMORY_DIR, 'architect_proposals.json');
const REVIEW_PATH = path.join(MEMORY_DIR, 'architect_review.json');
const LOG_PATH = path.join(MEMORY_DIR, 'architect_review.log');

const SCHEMA_VERSION = 1;
const VALID_DECISIONS = ['approved', 'rejected'];

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

/** Текущая ISO-метка времени. */
function nowISO() {
  return new Date().toISOString();
}

/** Гарантирует существование каталога memory/. */
function ensureMemoryDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
  return filePath;
}

/** Append-only лог ревью; никогда не бросает наружу. */
function logEvent(kind, data) {
  try {
    ensureMemoryDir();
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

// ---------------------------------------------------------------------------
// Загрузка предложений и решений
// ---------------------------------------------------------------------------

/** Читает proposals-файл архитектора. */
function loadProposals() {
  const data = readJSONSafe(PROPOSALS_PATH, null);
  if (!data) {
    return { ok: false, error: 'proposals file not found: ' + PROPOSALS_PATH, proposals: [] };
  }
  const list = Array.isArray(data.proposals) ? data.proposals : [];
  return { ok: true, meta: data, proposals: list };
}

/** Читает сохранённые решения ревьюера. */
function loadReview() {
  const data = readJSONSafe(REVIEW_PATH, null);
  if (!data || typeof data !== 'object') {
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
 * { ...proposal, decision, decided_at, reason }.
 */
function merged() {
  const p = loadProposals();
  if (!p.ok) return p;
  const review = loadReview();
  const proposals = p.proposals.map((prop) => {
    const d = review.decisions[prop.id];
    return Object.assign({}, prop, {
      decision: d ? d.decision : 'pending',
      decided_at: d ? d.decided_at : null,
      reason: d ? d.reason : null,
      reviewer: d ? d.reviewer : null
    });
  });
  return { ok: true, meta: p.meta, proposals };
}

/** Внутренний поиск предложения по id с учётом решения. */
function findProposal(id) {
  const m = merged();
  if (!m.ok) return m;
  const pid = normalizeId(id);
  const proposal = m.proposals.find((x) => x.id === pid) || null;
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
  const stats = { total: proposals.length, pending: 0, approved: 0, rejected: 0, byScope: {} };
  for (const p of proposals) {
    if (p.decision === 'approved') stats.approved++;
    else if (p.decision === 'rejected') stats.rejected++;
    else stats.pending++;
    const scope = p.scope || 'unknown';
    stats.byScope[scope] = stats.byScope[scope] || { total: 0, approved: 0, rejected: 0, pending: 0 };
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
    decision,
    reason: reason == null ? null : String(reason).trim(),
    reviewer: reviewer || 'operator',
    decided_at: nowISO(),
    prev_decision: prev ? prev.decision : null
  };
  review.decisions[pid] = entry;
  saveReview(review);
  logEvent('decide', { id: pid, decision, reason: entry.reason });
  return { ok: true, id: pid, status: decision, decision: entry };
}

/** Одобрить предложение. */
function approve(id, reviewer) {
  try {
    return decide(id, 'approved', null, reviewer);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Отклонить предложение — причина обязательна. */
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
  const head = '[' + p.decision + '] ' + p.id + ' (' + p.scope + '/' + p.severity + ')';
  if (short) return head + ' — ' + p.title;
  const lines = [
    head,
    '  title   : ' + p.title,
    '  conf    : ' + p.confidence + '  effort: ' + p.effort,
    '  impact  : ' + (p.impact || '-'),
    '  rec     : ' + (p.recommendation || '-')
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
      print({ ok: true, count: pending().length, proposals: pending() });
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
  nowISO
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
