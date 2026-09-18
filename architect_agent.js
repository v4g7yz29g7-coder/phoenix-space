#!/usr/bin/env node
/**
 * architect_agent.js
 * ============================================================================
 *  Агент-Архитектор (ARCHITECT-PRIME) — исполнитель воли «Архитектурной ДНК».
 *
 *  ЧТО ДЕЛАЕТ
 *    1. Читает prompts/architect_dna.md — канонический документ о том, КАК
 *       архитектор думает и принимает решения (принципы, эвристики, границы,
 *       ворота качества, антипаттерны, чек-лист).
 *    2. Парсит документ в детерминированный набор «правил» (rules):
 *       каждое правило трассируется к разделу ДНК и к конкретной строке.
 *    3. Превращает правила в предложения (proposals) — проверяемые изменения
 *       системы: guard-файлы, чек-тесты, правку документации, правку системы.
 *    4. Пишет предложения в memory/architect_proposals.json В РЕЖИМЕ DRY-RUN:
 *       - ничего из целевых файлов НЕ меняется;
 *       - предложения лишь фиксируются с флагом dry_run: true.
 *    5. Проверяет (review) предложения на согласованность схемы и выдаёт вердикт.
 *
 *  ПУБЛИЧНЫЙ API (CommonJS, async)
 *      const architect = require('./architect_agent');
 *      const res = await architect.propose();          // сгенерировать (dry-run)
 *      const rev = await architect.review();           // проверить и записать
 *      const both = await architect.run();             // propose + review
 *
 *      // низкоуровневые, чистые функции:
 *      architect.loadDna();                            // -> {ok, text, hash, ...}
 *      architect.parseDna(text);                       // -> {sections, rules}
 *      architect.deriveProposals(rules, opts);         // -> [proposal...]
 *      architect.buildReview(proposals);               // -> [review...]
 *
 *  ГАРАНТИИ
 *      - Никогда не бросает исключение наружу из propose()/review(): возвращает
 *        { ok:false, error } и продолжает работать.
 *      - Нет внешних зависимостей: только модули ядра (fs, path, crypto).
 *      - Запись атомарна: прежний memory/architect_proposals.json сохраняется
 *        рядом как .bak_<timestamp> перед перезаписью.
 *      - Результат полностью JSON-сериализуем.
 *      - Идемпотентность: повторный прогон не порождает дубликаты — предложения
 *        с той же сигнатурой (title + source_section) обновляются на месте.
 *
 *  CLI
 *      node architect_agent.js propose
 *      node architect_agent.js review
 *      node architect_agent.js run         (по умолчанию)
 *      node architect_agent.js run --apply   (dry_run:false — предложения всё
 *                                             ещё только фиксируются, целевые
 *                                             файлы НЕ модифицируются)
 *
 *  Переменные окружения:
 *      ARCHITECT_DNA_PATH        — путь к ДНК (по умолчанию prompts/architect_dna.md)
 *      ARCHITECT_PROPOSALS_PATH  — путь к store предложений
 *      ARCHITECT_DRY_RUN         — 'false' чтобы выключить dry-run
 *      ARCHITECT_VERBOSE         — 'true' для подробных логов
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ==========================================================================
 * 0. Конфигурация и расположение файлов
 * ======================================================================== */

/** Корень репозитория = каталог этого файла. */
const ROOT_DIR = path.resolve(__dirname);

const CONFIG = {
  version: 'architect-agent-v1',
  dnaPath: process.env.ARCHITECT_DNA_PATH || path.join(ROOT_DIR, 'prompts', 'architect_dna.md'),
  storePath: process.env.ARCHITECT_PROPOSALS_PATH || path.join(ROOT_DIR, 'memory', 'architect_proposals.json'),
  logPath: path.join(ROOT_DIR, 'memory', 'architect_agent.log'),
  dryRun: String(process.env.ARCHITECT_DRY_RUN || 'true').toLowerCase() !== 'false',
  verbose: String(process.env.ARCHITECT_VERBOSE || 'false').toLowerCase() === 'true',
};

/** Допустимые действия предложения. */
const ALLOWED_ACTIONS = ['add_guard', 'add_check', 'add_file', 'update_doc', 'update_system'];

/** Действия, для которых поле target обязательно. */
const TARGET_REQUIRED = ['add_guard', 'add_check', 'add_file', 'update_doc'];

/** Уровни риска по возрастанию. */
const RISK_LEVELS = ['low', 'medium', 'high'];

/* ==========================================================================
 * 1. Утилиты
 * ======================================================================== */

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    log('ERROR', 'mkdir ' + dir + ' failed: ' + err.message);
    return false;
  }
}

function log(level, msg) {
  if (level !== 'ERROR' && !CONFIG.verbose) return;
  const line = '[' + nowIso() + '] [architect_agent] [' + level + '] ' + msg;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  try {
    ensureDir(path.dirname(CONFIG.logPath));
    fs.appendFileSync(CONFIG.logPath, line + '\n');
  } catch (_) {
    /* логирование не должно ломать основной поток */
  }
}

function readText(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    log('WARN', 'read ' + file + ' failed: ' + err.message);
    return fallback;
  }
}

/** Атомарная запись с резервной копией предыдущего содержимого. */
function writeTextAtomic(file, content) {
  try {
    ensureDir(path.dirname(file));
    if (fs.existsSync(file)) {
      const bak = file + '.bak_' + Date.now();
      try {
        fs.copyFileSync(file, bak);
      } catch (_) {
        /* копия не критична */
      }
    }
    const tmp = file + '.tmp_' + process.pid;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    log('ERROR', 'write ' + file + ' failed: ' + err.message);
    return false;
  }
}

function sha1(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

function hash10(str) {
  return sha1(str).slice(0, 10);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/** Убирает markdown-разметку из строки правила, оставляя чистый текст. */
function stripMd(s) {
  return String(s == null ? '' : s)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(s, n) {
  const t = stripMd(s);
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function uniqueBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/* ==========================================================================
 * 2. Чтение и разбор Архитектурной ДНК
 * ======================================================================== */

/** Извлекает версию ДНК из заголовка вида: Версия: `1.0.0`. */
function extractVersion(md) {
  const m = String(md || '').match(/Версия:\s*`?v?([0-9]+(?:\.[0-9]+)*)`?/i);
  if (!m) return 'dna-v1';
  const major = m[1].split('.')[0];
  return 'dna-v' + major;
}

/** Загружает ДНК с диска; возвращает метаданные и текст. */
function loadDna() {
  const text = readText(CONFIG.dnaPath, null);
  if (text == null) {
    return { ok: false, error: 'DNA not found: ' + CONFIG.dnaPath, path: CONFIG.dnaPath };
  }
  const lines = text.split(/\r?\n/).length;
  const hash = sha1(text);
  const version = extractVersion(text);
  return { ok: true, path: CONFIG.dnaPath, text: text, hash: hash, version: version, lines: lines };
}

/** Разбивает markdown на секции уровня `##`. Возвращает [{title, lines:[...]}]. */
function parseSections(md) {
  const out = [];
  let current = null;
  const lines = String(md || '').split(/\r?\n/);
  for (const raw of lines) {
    const h2 = raw.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = { title: stripMd(h2[1]), lines: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    const h3 = raw.match(/^###\s+(.+?)\s*$/);
    if (h3) current.lines.push({ type: 'h3', text: stripMd(h3[1]) });
    else current.lines.push({ type: 'line', text: raw });
  }
  return out;
}

/** Определяет стабильный ключ секции по её заголовку. */
function sectionKey(title) {
  const t = String(title || '').toLowerCase();
  if (t.includes('кто ты')) return 'identity';
  if (t.includes('принцип')) return 'principles';
  if (t.includes('цикл решения')) return 'cycle';
  if (t.includes('декомпозиц')) return 'decomposition';
  if (t.includes('эвристик')) return 'heuristics';
  if (t.includes('инструмент')) return 'tools';
  if (t.includes('антипаттерн')) return 'antipatterns';
  if (t.includes('ворота')) return 'gates';
  if (t.includes('коммуникац')) return 'communication';
  if (t.includes('границ') || t.includes('безопасн')) return 'boundaries';
  if (t.includes('память') || t.includes('контекст')) return 'memory';
  if (t.includes('адаптац')) return 'adaptation';
  if (t.includes('чек-лист') || t.includes('чеклист')) return 'checklist';
  return 'general';
}

/** Разбирает одну строку таблицы `| a | b |` в массив ячеек. */
function tableCells(line) {
  const t = String(line || '').trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  return t.slice(1, -1).split('|').map((c) => stripMd(c));
}

/** Строка таблицы является разделителем (|---|---|)? */
function isTableSeparator(cells) {
  if (!cells || !cells.length) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
}

/**
 * Парсит секции в плоский список «правил».
 * Каждое правило: { section, sectionTitle, kind, text, raw }
 */
function parseRules(sections) {
  const rules = [];
  for (const sec of sections) {
    const key = sectionKey(sec.title);
    for (const ln of sec.lines) {
      if (ln.type === 'h3') {
        rules.push({ section: key, sectionTitle: sec.title, kind: 'note', text: ln.text, raw: ln.text });
        continue;
      }
      const line = ln.text;

      // Таблица
      const cells = tableCells(line);
      if (cells) {
        if (isTableSeparator(cells)) continue;
        if (key === 'antipatterns' && cells.length >= 2) {
          const anti = cells[0];
          const looks = cells[1];
          const fix = cells[2] || '';
          const text = stripMd(anti + ' — ' + (looks ? looks + ' → ' : '') + fix);
          if (text && anti.toLowerCase() !== 'антипаттерн') {
            rules.push({ section: key, sectionTitle: sec.title, kind: 'antipattern', text: text, raw: line });
          }
        }
        continue;
      }

      // Нумерованный пункт
      const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
      if (numbered) {
        const text = stripMd(numbered[1]);
        if (text) rules.push({ section: key, sectionTitle: sec.title, kind: ruleKind(key, sec.title), text: text, raw: line });
        continue;
      }

      // Пункт списка
      const bullet = line.match(/^\s*[-*]\s+(.+)$/);
      if (bullet) {
        const text = stripMd(bullet[1]);
        if (text) rules.push({ section: key, sectionTitle: sec.title, kind: ruleKind(key, sec.title), text: text, raw: line });
        continue;
      }

      // Цитата-предупреждение
      const quote = line.match(/^\s*>\s*(.+)$/);
      if (quote) {
        const text = stripMd(quote[1]);
        if (text) rules.push({ section: key, sectionTitle: sec.title, kind: 'warning', text: text, raw: line });
      }
    }
  }
  return rules;
}

/** Определяет kind правила по ключу секции. */
function ruleKind(key, title) {
  switch (key) {
    case 'principles': return 'principle';
    case 'heuristics': return 'heuristic';
    case 'boundaries': return 'boundary';
    case 'gates': return 'gate';
    case 'checklist': return 'checklist';
    case 'antipatterns': return 'antipattern';
    default: return 'note';
  }
}

/** Полный разбор ДНК: секции + правила. Чистая функция (без I/O). */
function parseDna(md) {
  const sections = parseSections(md);
  const rules = parseRules(sections);
  return {
    sections: sections.map((s) => ({ title: s.title, key: sectionKey(s.title) })),
    rules: rules,
    ruleCount: rules.length,
  };
}

/* ==========================================================================
 * 3. Генерация предложений из правил
 * ======================================================================== */

/** Базовое сопоставление kind -> действие и целевой артефакт. */
const ACTION_MAP = {
  principle: { action: 'update_doc', target: 'ARCHITECTURE.md', risk: 'low' },
  heuristic: { action: 'add_guard', target: 'architect/heuristics.js', risk: 'low' },
  boundary: { action: 'add_guard', target: 'architect/boundaries.js', risk: 'medium' },
  gate: { action: 'add_check', target: 'tests/quality_gates.test.js', risk: 'low' },
  checklist: { action: 'add_check', target: 'tests/acceptance.test.js', risk: 'low' },
  antipattern: { action: 'update_system', target: null, risk: 'medium' },
  warning: { action: 'update_doc', target: 'ARCHITECTURE.md', risk: 'low' },
  note: { action: 'update_doc', target: 'ARCHITECTURE.md', risk: 'low' },
};

/** Слова-триггеры, повышающие риск изменения. */
const RISK_WORDS = ['секрет', 'токен', 'данн', 'никогда', 'нельзя', 'критич', 'разруш', 'удал', '.env', 'node_modules'];

/** Вычисляет риск предложения: базовый по действию + повышение по триггерам. */
function computeRisk(action, text, baseRisk) {
  let idx = RISK_LEVELS.indexOf(baseRisk);
  if (idx < 0) idx = RISK_LEVELS.indexOf('low');
  const low = stripMd(text).toLowerCase();
  if (RISK_WORDS.some((w) => low.includes(w))) idx = clamp(idx + 1, 0, RISK_LEVELS.length - 1);
  if (action === 'update_system') idx = clamp(idx + 1, 0, RISK_LEVELS.length - 1);
  return RISK_LEVELS[idx];
}

/** Короткий человекочитаемый заголовок предложения из текста правила. */
function titleFromRule(rule) {
  let t = stripMd(rule.text);
  // «Понять, потом менять — ...» -> «Понять, потом менять»
  const dash = t.split(/\s[—–-]\s/)[0].trim();
  if (dash && dash.length >= 6 && dash.length <= 80) t = dash;
  if (t.length > 80) t = t.slice(0, 79).trimEnd() + '…';
  return t;
}

/** Человекочитаемая причина предложения. */
function rationaleFromRule(rule, action) {
  const base = 'Правило ДНК «' + rule.sectionTitle + '» задаёт инвариант; его надо сделать проверяемым через ' + action + '.';
  return base;
}

/**
 * Строит одно предложение из правила.
 * Ид детерминирован: prop-<sha1(section|text)[:10]>.
 */
function buildProposal(rule, opts) {
  const o = opts || {};
  const map = ACTION_MAP[rule.kind] || ACTION_MAP.note;
  const action = o.action || map.action;
  const target = o.target !== undefined ? o.target : map.target;
  const title = titleFromRule(rule);
  const id = 'prop-' + hash10(rule.section + '|' + rule.text);
  const risk = computeRisk(action, rule.text, map.risk);
  return {
    id: id,
    title: title,
    source_section: rule.section,
    source_item: rule.text,
    action: action,
    target: target,
    patch: null,
    rationale: rationaleFromRule(rule, action),
    risk: risk,
    status: 'proposed',
    dry_run: o.dryRun !== undefined ? !!o.dryRun : CONFIG.dryRun,
    created_at: o.now || nowIso(),
  };
}

/**
 * Превращает правила в список предложений.
 * По умолчанию — по одному предложению на правило, дедуп по сигнатуре.
 */
function deriveProposals(rules, opts) {
  const o = opts || {};
  const list = Array.isArray(rules) ? rules : (rules && rules.rules) || [];
  const built = list
    .filter((r) => r && r.text && r.text.length >= 4)
    .map((r) => buildProposal(r, o));
  const deduped = uniqueBy(built, (p) => p.title + '|' + p.source_section);
  if (o.maxProposals && o.maxProposals > 0) return deduped.slice(0, o.maxProposals);
  return deduped;
}

/* ==========================================================================
 * 4. Хранилище предложений (memory/architect_proposals.json)
 * ======================================================================== */

/** Пустое хранилище. */
function emptyStore() {
  return { meta: { version: CONFIG.version, count: 0, new_count: 0 }, proposals: [], reviews: [] };
}

/** Читает хранилище; при ошибке возвращает пустое (не бросает). */
function loadStore() {
  const text = readText(CONFIG.storePath, null);
  if (!text) return { ok: true, store: emptyStore(), fresh: true };
  try {
    const parsed = JSON.parse(text);
    const store = {
      meta: parsed && typeof parsed.meta === 'object' && parsed.meta ? parsed.meta : {},
      proposals: Array.isArray(parsed && parsed.proposals) ? parsed.proposals : [],
      reviews: Array.isArray(parsed && parsed.reviews) ? parsed.reviews : [],
    };
    return { ok: true, store: store, fresh: false };
  } catch (err) {
    log('WARN', 'store parse failed: ' + err.message);
    return { ok: false, error: err.message, store: emptyStore(), fresh: true };
  }
}

/**
 * Сливает входящие предложения в существующие.
 * Дедуп по id, затем по сигнатуре (title + source_section).
 * Возвращает { merged, added, updated }.
 */
function mergeProposals(existing, incoming) {
  const byId = new Map();
  const bySig = new Map();
  for (const p of existing) {
    byId.set(p.id, p);
    bySig.set(String(p.title) + '|' + String(p.source_section), p);
  }
  let added = 0;
  let updated = 0;
  for (const p of incoming) {
    const sig = String(p.title) + '|' + String(p.source_section);
    const ex = byId.get(p.id) || bySig.get(sig);
    if (ex) {
      Object.assign(ex, p, { id: ex.id, created_at: ex.created_at || p.created_at });
      updated++;
    } else {
      byId.set(p.id, p);
      bySig.set(sig, p);
      added++;
    }
  }
  return { merged: Array.from(byId.values()), added: added, updated: updated };
}

/** Сохраняет хранилище атомарно. */
function saveStore(store) {
  const text = JSON.stringify(store, null, 2) + '\n';
  return writeTextAtomic(CONFIG.storePath, text);
}

/* ==========================================================================
 * 5. Review — проверка предложений по схеме
 * ======================================================================== */

/**
 * Проверяет одно предложение. Возвращает {id, title, verdict, issues[]}.
 */
function reviewOne(p) {
  const issues = [];
  if (!p || typeof p !== 'object') {
    return { id: null, title: null, verdict: 'rejected', issues: ['proposal is not an object'] };
  }
  if (!p.id || !/^prop-[0-9a-f]{6,}$/.test(String(p.id))) issues.push('invalid or missing id');
  if (!p.title || typeof p.title !== 'string' || p.title.length < 3) issues.push('missing title');
  if (!p.source_section) issues.push('missing source_section');
  if (ALLOWED_ACTIONS.indexOf(p.action) === -1) issues.push('unknown action: ' + p.action);
  if (RISK_LEVELS.indexOf(p.risk) === -1) issues.push('unknown risk: ' + p.risk);
  if (TARGET_REQUIRED.indexOf(p.action) !== -1 && !p.target) issues.push('target required for action ' + p.action);
  if (!p.rationale) issues.push('missing rationale');
  if (p.risk === 'high') issues.push('warning: high risk — требует ручного подтверждения');
  return {
    id: p.id || null,
    title: p.title || null,
    verdict: issues.filter((i) => !i.startsWith('warning:')).length ? 'rejected' : 'approved',
    issues: issues,
  };
}

/** Проверяет список предложений. Чистая функция. */
function buildReview(proposals) {
  const list = Array.isArray(proposals) ? proposals : [];
  return list.map(reviewOne);
}

/**
 * selfTest() — чистая самопроверка агента БЕЗ записи на диск.
 * Прогоняет весь конвейер (loadDna → parseDna → deriveProposals → buildReview)
 * и проверяет инварианты публичного контракта. Ничего не пишет на диск и не
 * модифицирует целевые файлы, поэтому безопасна в любом окружении.
 *
 * @returns {Promise<Object>} { ok, passed, failed, checks, meta }
 */
async function selfTest() {
  const checks = [];
  const check = (name, cond, detail) => {
    checks.push({ name: name, ok: !!cond, detail: detail == null ? null : String(detail) });
    return !!cond;
  };

  const dna = loadDna();
  check('dna_found', dna.ok, dna.ok ? dna.path : dna.error);
  if (!dna.ok) {
    return { ok: false, passed: 0, failed: checks.length, checks: checks };
  }
  check('dna_nonempty', typeof dna.text === 'string' && dna.text.length > 0, 'len=' + dna.text.length);
  check('dna_hash', typeof dna.hash === 'string' && dna.hash.length === 40, dna.hash);

  const parsed = parseDna(dna.text);
  check('sections_parsed', Array.isArray(parsed.sections) && parsed.sections.length > 0, 'sections=' + parsed.sections.length);
  check('rules_parsed', Array.isArray(parsed.rules) && parsed.rules.length > 0, 'rules=' + parsed.rules.length);

  const proposals = deriveProposals(parsed.rules, { dryRun: true, now: nowIso() });
  check('proposals_generated', Array.isArray(proposals) && proposals.length > 0, 'count=' + proposals.length);

  const everyDryRun = proposals.every((p) => p.dry_run === true);
  check('proposals_dry_run', everyDryRun, 'all dry_run=true');

  const everyHasFields = proposals.every(
    (p) => p && typeof p.id === 'string' && typeof p.title === 'string' && ALLOWED_ACTIONS.indexOf(p.action) !== -1
  );
  check('proposals_schema', everyHasFields, 'id+title+action');

  const reviews = buildReview(proposals);
  check('reviews_count', reviews.length === proposals.length, 'reviews=' + reviews.length);
  const validVerdicts = reviews.every((r) => r.verdict === 'approved' || r.verdict === 'rejected');
  check('reviews_verdicts', validVerdicts, 'approved|rejected');

  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;

  log('INFO', 'selfTest: ' + passed + '/' + checks.length + ' passed');

  return {
    ok: failed === 0,
    passed: passed,
    failed: failed,
    checks: checks,
    meta: {
      version: CONFIG.version,
      dna_version: dna.version,
      dna_hash: dna.hash,
      rules: parsed.rules.length,
      proposals: proposals.length,
      at: nowIso(),
    },
  };
}

/* ==========================================================================
 * 6. Публичные операции
 * ======================================================================== */

/**
 * propose() — читает ДНК, генерирует предложения и записывает их в store
 * в режиме dry-run. Целевые файлы НЕ изменяются.
 *
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=true]
 * @param {number}  [options.maxProposals]
 * @param {boolean} [options.persist=true] — записывать ли store на диск
 * @returns {Promise<Object>} { ok, proposals, added, updated, meta, store }
 */
async function propose(options) {
  const o = options || {};
  try {
    const dryRun = o.dryRun !== undefined ? !!o.dryRun : CONFIG.dryRun;

    const dna = loadDna();
    if (!dna.ok) return { ok: false, error: dna.error, path: dna.path };

    const parsed = parseDna(dna.text);
    const contextEmpty = parsed.ruleCount === 0;

    const proposals = deriveProposals(parsed.rules, {
      dryRun: dryRun,
      maxProposals: o.maxProposals,
      now: nowIso(),
    });

    const loaded = loadStore();
    const merged = mergeProposals(loaded.store.proposals, proposals);

    const meta = {
      version: CONFIG.version,
      generated_at: nowIso(),
      dry_run: dryRun,
      dna_version: dna.version,
      dna_hash: dna.hash,
      dna_lines: dna.lines,
      context_empty: contextEmpty,
      count: merged.merged.length,
      new_count: merged.added,
    };

    const store = {
      meta: meta,
      proposals: merged.merged,
      reviews: loaded.store.reviews || [],
    };

    let persisted = false;
    if (o.persist !== false) persisted = saveStore(store);

    log('INFO', 'propose: ' + proposals.length + ' rules -> ' + merged.added + ' new, ' + merged.updated + ' updated');

    return {
      ok: true,
      dry_run: dryRun,
      proposals: proposals,
      added: merged.added,
      updated: merged.updated,
      persisted: persisted,
      meta: meta,
      store: store,
    };
  } catch (err) {
    log('ERROR', 'propose failed: ' + err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * review() — проверяет предложения по схеме, проставляет вердикты,
 * сохраняет результат в store.
 *
 * @param {Array|Object} [input] массив предложений либо { proposals }
 * @returns {Promise<Object>} { ok, reviewed, approved, rejected, reviews, store }
 */
async function review(input) {
  try {
    let proposals;
    if (Array.isArray(input)) {
      proposals = input;
    } else if (input && Array.isArray(input.proposals)) {
      proposals = input.proposals;
    } else {
      proposals = loadStore().store.proposals;
    }

    const reviews = buildReview(proposals);
    const approved = reviews.filter((r) => r.verdict === 'approved').length;
    const rejected = reviews.filter((r) => r.verdict === 'rejected').length;

    // Обновляем статусы предложений согласно вердиктам.
    const verdictById = new Map(reviews.map((r) => [r.id, r.verdict]));
    for (const p of proposals) {
      const v = verdictById.get(p.id);
      if (v === 'approved') p.status = 'approved';
      else if (v === 'rejected') p.status = 'rejected';
    }

    const loaded = loadStore();
    const merged = mergeProposals(loaded.store.proposals, proposals);
    const store = {
      meta: Object.assign({}, loaded.store.meta, {
        version: CONFIG.version,
        reviewed_at: nowIso(),
        count: merged.merged.length,
      }),
      proposals: merged.merged,
      reviews: (loaded.store.reviews || []).concat([
        { at: nowIso(), reviewed: reviews.length, approved: approved, rejected: rejected, items: reviews },
      ]),
    };

    let persisted = false;
    if (!input || input.persist !== false) persisted = saveStore(store);

    log('INFO', 'review: ' + reviews.length + ' checked, ' + approved + ' approved, ' + rejected + ' rejected');

    return {
      ok: true,
      reviewed: reviews.length,
      approved: approved,
      rejected: rejected,
      reviews: reviews,
      persisted: persisted,
      store: store,
    };
  } catch (err) {
    log('ERROR', 'review failed: ' + err.message);
    return { ok: false, error: err.message };
  }
}

/** run() — полный цикл: propose() затем review(). */
async function run(options) {
  const o = options || {};
  const proposed = await propose(o);
  if (!proposed.ok) return { ok: false, stage: 'propose', error: proposed.error };
  const reviewed = await review({ proposals: proposed.proposals, persist: o.persist });
  return {
    ok: reviewed.ok,
    proposal: proposed.meta,
    review: {
      reviewed: reviewed.reviewed,
      approved: reviewed.approved,
      rejected: reviewed.rejected,
    },
  };
}

/* ==========================================================================
 * 7. CLI
 * ======================================================================== */

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args.find((a) => !a.startsWith('-')) || 'run';
  return {
    cmd: cmd,
    apply: args.indexOf('--apply') !== -1,
    quiet: args.indexOf('--json') === -1,
  };
}

async function main() {
  const { cmd, apply } = parseArgs(process.argv);
  const opts = { dryRun: !apply };

  let result;
  if (cmd === 'selftest') result = await selfTest();
  else if (cmd === 'propose') result = await propose(opts);
  else if (cmd === 'review') result = await review(opts);
  else result = await run(opts);

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('fatal: ' + err.message);
    process.exitCode = 1;
  });
}

/* ==========================================================================
 * 8. Экспорт
 * ======================================================================== */

module.exports = {
  // публичный API
  propose: propose,
  generate: propose, // алиас: генерация предложений из ДНК (синоним propose)
  review: review,
  run: run,
  // чистые/вспомогательные функции
  loadDna: loadDna,
  parseDna: parseDna,
  parseSections: parseSections,
  parseRules: parseRules,
  deriveProposals: deriveProposals,
  buildProposal: buildProposal,
  buildReview: buildReview,
  reviewOne: reviewOne,
  selfTest: selfTest,
  loadStore: loadStore,
  saveStore: saveStore,
  mergeProposals: mergeProposals,
  // константы
  CONFIG: CONFIG,
  ALLOWED_ACTIONS: ALLOWED_ACTIONS,
  RISK_LEVELS: RISK_LEVELS,
  ROOT_DIR: ROOT_DIR,
};
