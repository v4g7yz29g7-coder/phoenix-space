#!/usr/bin/env node
// ============================================================================
//  architect_agent.js — Агент-Архитектор (dry-run)
//  Читает prompts/architect_dna.md, генерирует предложения в
//  memory/architect_proposals.json. Ничего в коде не меняет.
//
//  Публичный API:
//    propose(options)  -> { ok, mode, count, proposals, file }
//    review(options)   -> { ok, mode, reviewed, approved, rejected, decisions }
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
//  Конфигурация
// ---------------------------------------------------------------------------
const BOX_DIR = path.resolve(__dirname);
const PROMPTS_DIR = path.join(BOX_DIR, 'prompts');
const MEMORY_DIR = path.join(BOX_DIR, 'memory');
const DNA_FILE = path.join(PROMPTS_DIR, 'architect_dna.md');
const PROPOSALS_FILE = path.join(MEMORY_DIR, 'architect_proposals.json');

const VERSION = '1.0.0';
const MAX_PROPOSALS = 50;          // жёсткий лимит из ДНК
const CONFIDENCE_REJECT = 0.5;     // ниже — reject
const ROLLBACK_REQUIRED = true;    // без плана отката — reject

// ---------------------------------------------------------------------------
//  Встроенная ДНК (fallback, если файл отсутствует)
// ---------------------------------------------------------------------------
const FALLBACK_DNA = [
  '# Architect DNA (fallback)',
  'dry-run обязателен',
  'scopes: architecture, reliability, performance, maintainability, security, observability',
  'confidence < 0.5 => reject',
  'rollback обязателен',
  'не трогать .env, *.db, node_modules, .git',
  'лимит 50 предложений за запуск'
].join('\n');

// ---------------------------------------------------------------------------
//  Хранилище (in-memory + файл)
// ---------------------------------------------------------------------------
const store = {
  dna: null,           // { raw, version, scopes, rules, loadedFrom }
  proposals: [],       // сгенерированные предложения
  decisions: [],       // результаты review()
  lastRun: null,
  warnings: []
};

// ---------------------------------------------------------------------------
//  Утилиты
// ---------------------------------------------------------------------------
function ensureDir(dir) {
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    store.warnings.push('mkdir ' + dir + ': ' + e.message);
    return false;
  }
}

function shortHash(input) {
  return crypto
    .createHash('sha1')
    .update(String(input))
    .digest('hex')
    .slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
}

function safeJsonRead(file) {
  const raw = safeRead(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    store.warnings.push('bad json ' + file + ': ' + e.message);
    return null;
  }
}

function writeJsonAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return true;
}

function clamp(n, lo, hi) {
  if (Number.isNaN(Number(n))) return lo;
  return Math.max(lo, Math.min(hi, Number(n)));
}

// ---------------------------------------------------------------------------
//  Загрузка и разбор ДНК
// ---------------------------------------------------------------------------
function loadDna() {
  let raw = safeRead(DNA_FILE);
  let loadedFrom = DNA_FILE;
  if (!raw) {
    raw = FALLBACK_DNA;
    loadedFrom = '(embedded fallback)';
    store.warnings.push('architect_dna.md не найден, использую fallback');
  }
  const scopes = parseList(raw, /^-?\s*(architecture|reliability|performance|maintainability|security|observability)/gim);
  const versionMatch = raw.match(/Версия:\s*([0-9.]+)/i);
  store.dna = {
    raw,
    version: versionMatch ? versionMatch[1] : 'unknown',
    scopes: scopes.length ? scopes : ['architecture', 'reliability', 'performance'],
    rules: {
      dryRun: /dry-run/i.test(raw),
      rollbackRequired: ROLLBACK_REQUIRED,
      maxProposals: MAX_PROPOSALS,
      confidenceReject: CONFIDENCE_REJECT
    },
    loadedFrom,
    lines: raw.split('\n').length
  };
  return store.dna;
}

function parseList(text, regex) {
  const out = [];
  let m;
  regex.lastIndex = 0;
  while ((m = regex.exec(text)) !== null) {
    const val = (m[1] || '').trim();
    if (val && !out.includes(val)) out.push(val);
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Генераторы предложений по каждому scope
// ---------------------------------------------------------------------------
const GENERATORS = {
  architecture() {
    return [
      mk('architecture', 'Ввести слой портов и адаптеров', 'medium', 0.72, 'S',
        ['модули напрямую импортируют друг друга', 'нет явных контрактов между слоями'],
        'Выделить интерфейсы (ports) для внешних зависимостей и подключать их через адаптеры.',
        'Снижение связности coupling и упрощение замены LLM-провайдера.',
        'Убрать адаптеры и вернуть прямые импорты.'),
      mk('architecture', 'Документировать карту модулей', 'low', 0.8, 'S',
        ['ARCHITECTURE.md описывает не все модули', 'нет диаграммы зависимостей'],
        'Сгенерировать граф зависимостей и добавить в знания.',
        'Ускоряет онбординг и ревью.',
        'Откат не требуется, изменение аддитивное.')
    ];
  },
  reliability() {
    return [
      mk('reliability', 'Добавить таймауты и ретраи для LLM-вызовов', 'high', 0.9, 'M',
        ['в llm_client нет явного timeout', 'сетевые ошибки не ретраятся'],
        'Обернуть вызовы в retry с экспоненциальной задержкой и AbortController.',
        'Рост успешных ответов при нестабильной сети.',
        'Вернуть предыдущую версию llm_client.js.'),
      mk('reliability', 'Graceful shutdown для процессов', 'medium', 0.75, 'S',
        ['процессы завершаются без ожидания соединений'],
        'Перехватить SIGTERM/SIGINT, дождаться завершения задач.',
        'Снижение риска повреждения данных.',
        'Убрать обработчики сигналов.')
    ];
  },
  performance() {
    return [
      mk('performance', 'Кешировать разбор ДНК', 'low', 0.7, 'S',
        ['ДНК читается на каждый запуск', 'файл статичен'],
        'Кешировать по mtime + hash.',
        'Меньше I/O и латентность запуска.',
        'Отключить кеш (флаг noCache).'),
      mk('performance', 'Ограничить размер proposals.json', 'medium', 0.68, 'M',
        ['файл растёт бесконечно', 'история не архивируется'],
        'Хранить последние N предложений + архив.',
        'Стабильный размер памяти/диска.',
        'Вернуть полный файл из бэкапа.')
    ];
  },
  maintainability() {
    return [
      mk('maintainability', 'Убрать дублирование JSON-хелперов', 'medium', 0.78, 'S',
        ['safeJsonRead дублируется в модулях'],
        'Вынести утилиты в общий модуль json_utils.',
        'Единая точка правки.',
        'Вернуть локальные копии функций.'),
      mk('maintainability', 'Покрыть модули юнит-тестами', 'high', 0.65, 'L',
        ['test_ratio низкий', 'критические модули без тестов'],
        'Добавить тесты на парсеры и генераторы.',
        'Регрессии ловятся раньше.',
        'Удалить каталог tests/.')
    ];
  },
  security() {
    return [
      mk('security', 'Валидировать пути записи', 'critical', 0.88, 'M',
        ['запись идёт без проверки на .. ', 'нет белого списка каталогов'],
        'Разрешать запись только внутри box/memory.',
        'Исключение path traversal.',
        'Откатить к предыдущей проверке isPathSafe.'),
      mk('security', 'Не логировать секреты', 'high', 0.82, 'S',
        ['в логах возможны ключи API'],
        'Маскировать секреты перед логированием.',
        'Защита от утечки.',
        'Вернуть прямой вывод строк.')
    ];
  },
  observability() {
    return [
      mk('observability', 'Структурированные логи (JSON)', 'medium', 0.7, 'M',
        ['логи свободным текстом', 'нет корреляции по run_id'],
        'Перейти на JSON-логи с run_id и step.',
        'Проще искать причины сбоев.',
        'Вернуть текстовый форматтер.'),
      mk('observability', 'Метрики предложений', 'low', 0.66, 'S',
        ['нет счётчиков approved/rejected'],
        'Писать агрегаты в memory/metrics.json.',
        'Видимость динамики архитектуры.',
        'Удалить metrics.json.')
    ];
  }
};

function mk(scope, title, severity, confidence, effort, evidence, recommendation, impact, rollback) {
  const id = 'prop_' + scope + '_' + shortHash(scope + '|' + title);
  return {
    id,
    scope,
    title,
    severity,
    confidence: clamp(confidence, 0, 1),
    evidence: Array.isArray(evidence) ? evidence : [String(evidence)],
    recommendation,
    impact,
    effort,
    rollback,
    files: [],
    status: 'proposed',
    mode: 'dry-run',
    created_at: nowIso()
  };
}

// ---------------------------------------------------------------------------
//  propose() — основная точка генерации (dry-run)
// ---------------------------------------------------------------------------
function propose(options) {
  const opts = Object.assign(
    { scopes: null, filter: null, persist: true, limit: MAX_PROPOSALS, dryRun: true },
    options || {}
  );

  const dna = loadDna();
  const scopes = opts.scopes && opts.scopes.length ? opts.scopes : dna.scopes;

  let generated = [];
  for (const scope of scopes) {
    const gen = GENERATORS[scope];
    if (typeof gen !== 'function') {
      store.warnings.push('нет генератора для scope: ' + scope);
      continue;
    }
    generated = generated.concat(gen());
  }

  // фильтр по подстроке в title
  if (opts.filter) {
    const f = String(opts.filter).toLowerCase();
    generated = generated.filter(p => p.title.toLowerCase().includes(f));
  }

  // дедуп по id
  const seen = new Set();
  generated = generated.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  // лимит
  if (generated.length > opts.limit) generated = generated.slice(0, opts.limit);

  store.proposals = generated;
  store.lastRun = nowIso();

  const payload = {
    version: VERSION,
    mode: opts.dryRun ? 'dry-run' : 'apply',
    generated_at: store.lastRun,
    dna: {
      version: dna.version,
      loadedFrom: dna.loadedFrom,
      scopes: dna.scopes,
      lines: dna.lines
    },
    count: generated.length,
    proposals: generated,
    warnings: store.warnings.slice()
  };

  let file = null;
  if (opts.persist) {
    file = PROPOSALS_FILE;
    writeJsonAtomic(file, payload);
  }

  return {
    ok: true,
    mode: payload.mode,
    count: generated.length,
    proposals: generated,
    file,
    warnings: payload.warnings
  };
}

// ---------------------------------------------------------------------------
//  review() — ревью предложений по правилам ДНК
// ---------------------------------------------------------------------------
function review(options) {
  const opts = Object.assign(
    { source: null, proposals: null, persist: true, dryRun: true },
    options || {}
  );

  loadDna();

  let list = opts.proposals;
  if (!list) {
    const src = opts.source || PROPOSALS_FILE;
    const data = safeJsonRead(src);
    list = data && Array.isArray(data.proposals) ? data.proposals : store.proposals;
  }

  const decisions = [];
  const seenKeys = new Set();

  for (const p of list) {
    const key = (p.scope || '') + '|' + (p.title || '');
    const problems = [];

    if (seenKeys.has(key)) problems.push('дубликат (scope,title)');
    seenKeys.add(key);

    if (!p.rollback || !String(p.rollback).trim()) problems.push('нет плана отката');
    if (!Array.isArray(p.evidence) || p.evidence.length === 0) problems.push('нет evidence');
    if (typeof p.confidence !== 'number') problems.push('confidence не число');
    if (typeof p.confidence === 'number' && p.confidence < CONFIDENCE_REJECT) {
      problems.push('confidence < ' + CONFIDENCE_REJECT);
    }

    let verdict;
    if (problems.length) {
      verdict = 'reject';
    } else if (p.severity === 'critical' && p.effort === 'L') {
      verdict = 'needs_human';
    } else {
      verdict = 'approve';
    }

    decisions.push({
      id: p.id,
      scope: p.scope,
      title: p.title,
      severity: p.severity,
      confidence: p.confidence,
      verdict,
      problems,
      reviewed_at: nowIso()
    });
  }

  store.decisions = decisions;

  const summary = {
    reviewed: decisions.length,
    approved: decisions.filter(d => d.verdict === 'approve').length,
    rejected: decisions.filter(d => d.verdict === 'reject').length,
    needs_human: decisions.filter(d => d.verdict === 'needs_human').length
  };

  if (opts.persist && decisions.length) {
    const data = safeJsonRead(PROPOSALS_FILE) || {};
    data.review = { summary, decisions, reviewed_at: nowIso(), mode: 'dry-run' };
    data.proposals = (data.proposals || []).map(p => {
      const d = decisions.find(x => x.id === p.id);
      return d ? Object.assign({}, p, { status: d.verdict }) : p;
    });
    writeJsonAtomic(PROPOSALS_FILE, data);
  }

  return Object.assign({ ok: true, mode: 'dry-run', decisions }, summary);
}

// ---------------------------------------------------------------------------
//  Вспомогательные публичные методы
// ---------------------------------------------------------------------------
function loadProposals(file) {
  const data = safeJsonRead(file || PROPOSALS_FILE);
  return data && Array.isArray(data.proposals) ? data.proposals : [];
}

function stats(file) {
  const data = safeJsonRead(file || PROPOSALS_FILE) || {};
  const list = data.proposals || [];
  const byScope = {};
  for (const p of list) byScope[p.scope] = (byScope[p.scope] || 0) + 1;
  return {
    ok: true,
    file: file || PROPOSALS_FILE,
    total: list.length,
    byScope,
    review: data.review ? data.review.summary : null,
    generated_at: data.generated_at || null,
    mode: data.mode || null
  };
}

// ---------------------------------------------------------------------------
//  CLI
// ---------------------------------------------------------------------------
function main(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || 'propose';

  if (cmd === 'propose') {
    const filterIdx = args.indexOf('--filter');
    const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
    const res = propose({ filter });
    console.log(JSON.stringify({
      ok: res.ok, mode: res.mode, count: res.count, file: res.file,
      warnings: res.warnings
    }, null, 2));
    return 0;
  }

  if (cmd === 'review') {
    const res = review({});
    console.log(JSON.stringify({
      ok: res.ok, mode: res.mode, reviewed: res.reviewed,
      approved: res.approved, rejected: res.rejected, needs_human: res.needs_human
    }, null, 2));
    return 0;
  }

  if (cmd === 'stats') {
    console.log(JSON.stringify(stats(), null, 2));
    return 0;
  }

  console.log('Usage: node architect_agent.js [propose|review|stats] [--filter X]');
  return 1;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}

module.exports = {
  propose,
  review,
  stats,
  loadProposals,
  loadDna,
  store,
  VERSION,
  PROPOSALS_FILE,
  DNA_FILE,
  _internals: { shortHash, mk, clamp }
};
