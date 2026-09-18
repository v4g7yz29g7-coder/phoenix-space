'use strict';

/**
 * task_chemistry.js — «химия задач».
 * ------------------------------------------------------------------
 * Модуль моделирует взаимодействие двух задач (или агентов, их
 * исполняющих) по аналогии с химической реакцией:
 *
 *   react(a, b) -> ReactionResult
 *
 * Возможные исходы (kind):
 *   - CONFLICT   — участники несовместимы (гонка, двойная запись, трение);
 *   - CATALYST   — один усиливает/ускоряет другого;
 *   - SYNERGY    — взаимное усиление, эффект 1+1 > 2;
 *   - INHIBITOR  — взаимное замедление (дребезг, лишние ожидания);
 *   - NEUTRAL    — заметного влияния нет.
 *
 * Результат содержит «энергию» реакции (delta в диапазоне [-1, 1]),
 * флаги catalyst/conflict, фазу (агрегатное состояние смеси) и пояснение.
 *
 * Модуль детерминирован, не имеет внешних зависимостей,
 * совместим с Node >= 12, экспортируется как CommonJS.
 * ------------------------------------------------------------------
 */

/* ------------------------------------------------------------------ *
 * Константы предметной области
 * ------------------------------------------------------------------ */

const KIND = Object.freeze({
  CONFLICT: 'conflict',
  CATALYST: 'catalyst',
  SYNERGY: 'synergy',
  INHIBITOR: 'inhibitor',
  NEUTRAL: 'neutral',
});

const PHASE = Object.freeze({
  SOLID: 'solid',
  LIQUID: 'liquid',
  GAS: 'gas',
  PLASMA: 'plasma',
});

const SEVERITY = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

// Порядок фаз по возрастанию «подвижности» смеси.
const PHASE_ORDER = Object.freeze([
  PHASE.SOLID,
  PHASE.LIQUID,
  PHASE.GAS,
  PHASE.PLASMA,
]);

// Уровни «нагрева» -> фаза.
const HEAT_THRESHOLDS = Object.freeze([
  { max: 0.15, phase: PHASE.SOLID },
  { max: 0.45, phase: PHASE.LIQUID },
  { max: 0.75, phase: PHASE.GAS },
  { max: Infinity, phase: PHASE.PLASMA },
]);

/* ------------------------------------------------------------------ *
 * Таблица реакций: известные пары операций -> правило
 * ------------------------------------------------------------------ */

const REACTION_TABLE = Object.freeze({
  'read+write': { kind: KIND.CONFLICT, energy: -0.7, note: 'гонка за состоянием' },
  'write+write': { kind: KIND.CONFLICT, energy: -0.9, note: 'двойная запись' },
  'delete+read': { kind: KIND.INHIBITOR, energy: -0.35, note: 'чтение удалённого' },
  'read+read': { kind: KIND.SYNERGY, energy: 0.4, note: 'общий кэш' },
  'emit+parse': { kind: KIND.CATALYST, energy: 0.8, note: 'потоковый конвейер' },
  'fetch+parse': { kind: KIND.CATALYST, energy: 0.6, note: 'ETL' },
  'build+deploy': { kind: KIND.CATALYST, energy: 0.7, note: 'CI/CD' },
  'refactor+test': { kind: KIND.SYNERGY, energy: 0.65, note: 'безопасное улучшение' },
  'lock+unlock': { kind: KIND.SYNERGY, energy: 0.5, note: 'критическая секция' },
  'retry+timeout': { kind: KIND.INHIBITOR, energy: -0.3, note: 'дребезг' },
  'backup+migrate': { kind: KIND.NEUTRAL, energy: 0.0, note: 'порядок важен' },
  'cache+invalidate': { kind: KIND.SYNERGY, energy: 0.45, note: 'согласованность' },
  'execute+plan': { kind: KIND.CATALYST, energy: 0.55, note: 'план ведёт исполнение' },
  'migrate+schema': { kind: KIND.CATALYST, energy: 0.5, note: 'эволюция схемы' },
  'merge+rebase': { kind: KIND.CONFLICT, energy: -0.5, note: 'несовместимые истории' },
});

// Словарь «доменов»: пары, которые в одном домене усиливают друг друга.
const DOMAIN_CATALYSTS = Object.freeze({
  data: ['load', 'transform', 'validate', 'store'],
  web: ['route', 'render', 'hydrate', 'serve'],
  ml: ['collect', 'train', 'evaluate', 'deploy'],
  infra: ['provision', 'configure', 'monitor', 'scale'],
});

/* ------------------------------------------------------------------ *
 * Утилиты
 * ------------------------------------------------------------------ */

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function clamp01(v) {
  return clamp(v, 0, 1);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Извлекает имя сущности из строки/объекта. */
function normName(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x.toLowerCase().trim();
  if (isObject(x)) {
    if (typeof x.name === 'string') return x.name.toLowerCase().trim();
    if (typeof x.id === 'string') return x.id.toLowerCase().trim();
    if (typeof x.op === 'string') return x.op.toLowerCase().trim();
  }
  return String(x).toLowerCase().trim();
}

/** Канонический ключ пары: имена сортируются, чтобы a+b === b+a. */
function key(a, b) {
  const ka = normName(a);
  const kb = normName(b);
  if (!ka || !kb) return null;
  return [ka, kb].sort().join('+');
}

function getWeight(task) {
  if (isObject(task) && typeof task.weight === 'number') {
    return clamp01(task.weight);
  }
  return 0.5;
}

function getPhase(task) {
  if (isObject(task) && typeof task.phase === 'string' && PHASE_ORDER.indexOf(task.phase) >= 0) {
    return task.phase;
  }
  return PHASE.LIQUID;
}

function getDomain(task) {
  if (isObject(task) && typeof task.domain === 'string') return task.domain;
  return '';
}

/** Строит множества токенов из строки/массива. */
function tokens(x) {
  const src = Array.isArray(x) ? x : typeof x === 'string' ? x.split(/[\s,;]+/) : [];
  const out = new Set();
  for (const t of src) {
    const s = String(t).toLowerCase().trim();
    if (s) out.add(s);
  }
  return out;
}

/** Жаккар двух множеств [0..1]. */
function jaccard(a, b) {
  const A = a instanceof Set ? a : tokens(a);
  const B = b instanceof Set ? b : tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* ------------------------------------------------------------------ *
 * Ядро: реакция двух задач
 * ------------------------------------------------------------------ */

function mergePhases(p1, p2) {
  const i1 = Math.max(0, PHASE_ORDER.indexOf(p1));
  const i2 = Math.max(0, PHASE_ORDER.indexOf(p2));
  return PHASE_ORDER[Math.max(i1, i2)] || PHASE.LIQUID;
}

function phaseFromHeat(heat) {
  for (const t of HEAT_THRESHOLDS) {
    if (heat <= t.max) return t.phase;
  }
  return PHASE.PLASMA;
}

function defaultEnergy(a, b) {
  const same = getDomain(a) && getDomain(a) === getDomain(b);
  return same ? 0.25 : -0.15;
}

function classify(delta) {
  if (delta <= -0.4) return KIND.CONFLICT;
  if (delta >= 0.4) return KIND.CATALYST;
  if (delta <= -0.1) return KIND.INHIBITOR;
  if (delta >= 0.1) return KIND.SYNERGY;
  return KIND.NEUTRAL;
}

/** Дополнительные катализаторы между задачами (доменный словарь). */
function domainCatalysis(a, b) {
  const da = getDomain(a);
  const db = getDomain(b);
  if (!da || da !== db) return 0;
  const vocab = DOMAIN_CATALYSTS[da];
  if (!vocab) return 0;
  const ka = normName(a);
  const kb = normName(b);
  let hits = 0;
  if (vocab.indexOf(ka) >= 0) hits++;
  if (vocab.indexOf(kb) >= 0) hits++;
  return hits * 0.15;
}

/**
 * react(a, b) — вычислить взаимодействие двух задач.
 *
 * @param {string|object} a — задача / агент.
 * @param {string|object} b — задача / агент.
 * @returns {{
 *   kind: string, energy: number, delta: number, catalyst: boolean,
 *   conflict: boolean, severity: string|null, note: string,
 *   pair: string|null, phase: string
 * }}
 */
function react(a, b) {
  const pairKey = key(a, b);
  const phase = mergePhases(getPhase(a), getPhase(b));

  if (!pairKey) {
    return {
      kind: KIND.NEUTRAL,
      energy: 0,
      delta: 0,
      catalyst: false,
      conflict: false,
      severity: null,
      note: 'пустая реакция',
      pair: null,
      phase,
    };
  }

  const rule = REACTION_TABLE[pairKey] || null;
  const baseEnergy = rule ? rule.energy : defaultEnergy(a, b);
  const wA = getWeight(a);
  const wB = getWeight(b);
  const mass = (wA + wB) / 2;

  let delta = baseEnergy * (0.5 + mass);
  delta += domainCatalysis(a, b);

  // Похожесть описаний усиливает эффект, но не меняет знак.
  const sim = jaccard(tokens(a), tokens(b));
  if (delta > 0) delta += sim * 0.1;
  delta = clamp(delta, -1, 1);

  const kind = rule ? rule.kind : classify(delta);
  const absDelta = Math.abs(delta);

  let severity = null;
  if (kind === KIND.CONFLICT || kind === KIND.INHIBITOR) {
    severity = absDelta >= 0.7 ? SEVERITY.HIGH : absDelta >= 0.4 ? SEVERITY.MEDIUM : SEVERITY.LOW;
  }

  return {
    kind,
    energy: round3(absDelta),
    delta: round3(delta),
    catalyst: kind === KIND.CATALYST || kind === KIND.SYNERGY,
    conflict: kind === KIND.CONFLICT,
    severity,
    note: rule ? rule.note : 'правило не найдено',
    pair: pairKey,
    phase,
  };
}

/* ------------------------------------------------------------------ *
 * Пакетная обработка
 * ------------------------------------------------------------------ */

function reactAll(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const r = react(list[i], list[j]);
      r.a = normName(list[i]);
      r.b = normName(list[j]);
      out.push(r);
    }
  }
  return out;
}

function conflicts(results) {
  return (results || []).filter((r) => r.conflict);
}

function catalysts(results) {
  return (results || []).filter((r) => r.catalyst);
}

function inhibitors(results) {
  return (results || []).filter((r) => r.kind === KIND.INHIBITOR);
}

function summarize(results) {
  const rs = Array.isArray(results) ? results : [];
  const total = rs.length;
  const conflictsCount = conflicts(rs).length;
  const catalystsCount = catalysts(rs).length;
  const inhibitorsCount = inhibitors(rs).length;
  const netEnergy = rs.reduce((s, r) => s + r.delta, 0);
  const heat = total ? rs.reduce((s, r) => s + Math.abs(r.delta), 0) / total : 0;
  return {
    total,
    conflicts: conflictsCount,
    catalysts: catalystsCount,
    inhibitors: inhibitorsCount,
    neutral: total - conflictsCount - catalystsCount - inhibitorsCount,
    stability: total ? round3(1 - conflictsCount / total) : 1,
    netEnergy: round3(netEnergy),
    heat: round3(heat),
    phase: phaseFromHeat(heat),
  };
}

/** Самая «горячая» пара по абсолютной энергии. */
function hottestPair(tasks) {
  const rs = reactAll(tasks);
  if (!rs.length) return null;
  let best = rs[0];
  for (const r of rs) if (Math.abs(r.delta) > Math.abs(best.delta)) best = r;
  return best;
}

/** Лучшая совместимая пара (катализатор/синергия с максимумом энергии). */
function bestPair(tasks) {
  const rs = reactAll(tasks).filter((r) => r.catalyst);
  if (!rs.length) return null;
  let best = rs[0];
  for (const r of rs) if (r.delta > best.delta) best = r;
  return best;
}

/** Худшая пара (самый сильный конфликт). */
function worstPair(tasks) {
  const rs = reactAll(tasks).filter((r) => r.conflict);
  if (!rs.length) return null;
  let worst = rs[0];
  for (const r of rs) if (r.delta < worst.delta) worst = r;
  return worst;
}

function recommend(tasks) {
  const results = reactAll(tasks);
  const stats = summarize(results);
  const advice = [];
  if (stats.conflicts > 0) advice.push('развести конфликтующие задачи по времени');
  if (stats.catalysts > 0) advice.push('сгруппировать катализаторы в один батч');
  if (stats.inhibitors > 0) advice.push('убрать взаимные ожидания между ингибиторами');
  if (stats.stability < 0.6) advice.push('снизить параллелизм');
  if (!advice.length) advice.push('порядок задач безопасен');
  return { stats, advice, results };
}

/** Человекочитаемое резюме одной реакции. */
function explain(reaction) {
  if (!reaction) return 'Нет данных о реакции.';
  const lines = [
    `Реакция ${reaction.a || '?'} + ${reaction.b || '?'}: ${reaction.kind} ` +
      `(delta=${reaction.delta})`,
    `Фаза: ${reaction.phase}, энергия: ${reaction.energy}`,
  ];
  if (reaction.note) lines.push(`Причина: ${reaction.note}`);
  if (reaction.severity) lines.push(`Серьёзность: ${reaction.severity}`);
  return lines.join('\n');
}

module.exports = {
  react,
  reactAll,
  conflicts,
  catalysts,
  inhibitors,
  summarize,
  hottestPair,
  bestPair,
  worstPair,
  recommend,
  explain,
  KIND,
  PHASE,
  SEVERITY,
  REACTION_TABLE,
  DOMAIN_CATALYSTS,
  _internal: {
    normName,
    key,
    clamp,
    clamp01,
    jaccard,
    tokens,
    classify,
    mergePhases,
    phaseFromHeat,
    domainCatalysis,
  },
};
