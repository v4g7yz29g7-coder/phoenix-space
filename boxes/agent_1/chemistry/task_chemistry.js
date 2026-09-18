// ============================================================================
//  chemistry/task_chemistry.js
//  «Химия» конфликтов и катализаторов между задачами/агентами.
//
//  Идея: каждая сущность (задача, агент, ветка работы) — это реагент.
//  У реагента есть «элементы» (skills/tags), энергия активации, валентность,
//  заряд и набор примесей — катализаторов и ингибиторов.
//
//    - react(a, b)        — запускает реакцию между двумя реагентами
//    - detectConflict(a,b) — ищет конфликты (перекрытие ресурсов, противоречия)
//    - catalysis(a, b)     — считает каталитический/ингибирующий эффект
//
//  Типы исходов реакции:
//    'bond'      — синергия: реагенты усиливают друг друга (низкий барьер)
//    'conflict'  — конфликт: жёсткое противоречие или борьба за ресурс
//    'friction'  — слабый конфликт: работают, но с потерями энергии
//    'inert'     — реакции нет: реагенты не взаимодействуют
//
//  Публичный API:
//    react(a, b[, options]) -> {
//      a, b, type, score, barrier, energy, catalysts, inhibitors,
//      products, conflicts, notes
//    }
//
//  Модуль чистый: без внешних зависимостей, детерминированный.
// ============================================================================

'use strict';

// ---------------------------------------------------------------------------
//  Константы
// ---------------------------------------------------------------------------
const REACTION_TYPES = Object.freeze({
  BOND: 'bond',
  CONFLICT: 'conflict',
  FRICTION: 'friction',
  INERT: 'inert',
});

// Порог конфликта: доля/вес, выше которого реакция объявляется конфликтной.
const THRESHOLDS = Object.freeze({
  conflict: 0.55,
  friction: 0.25,
  bond: 0.60,
  inert: 0.05,
});

// Как сильно катализатор снижает барьер активации.
const CATALYSIS = Object.freeze({
  maxReduction: 0.75,   // катализатор не может убрать барьер больше чем на 75%
  perCatalyst: 0.22,    // вклад каждого катализатора
  inhibitorBoost: 0.35, // ингибитор повышает барьер
});

const DEFAULTS = Object.freeze({
  temperature: 1.0,   // 0 — холодно (вяло), 1 — норма, >1 — разгон
  allowSelfReact: true,
  epsilon: 1e-9,
});

// ---------------------------------------------------------------------------
//  Утилиты
// ---------------------------------------------------------------------------
function toArray(v) {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = String(x).trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

function clamp(x, lo = 0, hi = 1) {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function round(x, digits = 4) {
  const p = Math.pow(10, digits);
  return Math.round(x * p) / p;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Пересечение двух множеств (в нижнем регистре).
function intersect(a, b) {
  const A = new Set(toArray(a).map((s) => String(s).toLowerCase()));
  const B = toArray(b).map((s) => String(s).toLowerCase());
  const out = [];
  for (const x of B) if (A.has(x) && !out.includes(x)) out.push(x);
  return out;
}

function difference(a, b) {
  const A = uniq(a);
  const B = new Set(uniq(b));
  return A.filter((x) => !B.has(x));
}

// Jaccard: |A ∩ B| / |A ∪ B|
function jaccard(a, b) {
  const A = new Set(uniq(a));
  const B = new Set(uniq(b));
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
//  Нормализация реагента
// ---------------------------------------------------------------------------
function normalizeReagent(r) {
  const x = r && typeof r === 'object' ? r : {};
  const skills = uniq(toArray(x.skills || x.capabilities));
  const tags = uniq(toArray(x.tags || x.domains || x.topics));
  const needs = uniq(toArray(x.needs || x.requires || x.requiredSkills));
  return {
    id: x.id || x.name || 'reagent',
    name: x.name || x.id || 'reagent',
    skills,
    tags,
    needs,
    // «Энергия активации»: насколько реагент сам по себе требует усилий.
    activation: clamp(num(x.activation !== undefined ? x.activation : x.complexity, 0.5), 0, 1),
    // «Валентность»: сколько связей реагент держит одновременно.
    valence: Math.max(0, num(x.valence, 1)),
    // «Заряд»: -1 конфликтный, +1 коллаборативный, 0 нейтральный.
    charge: clamp(num(x.charge, 0), -1, 1),
    // Ресурсы, за которые идёт борьба (CPU, время, file-lock и т.п.).
    resources: uniq(toArray(x.resources || x.locks)),
    // Катализаторы ускоряют реакцию.
    catalysts: uniq(toArray(x.catalysts)),
    // Ингибиторы тормозят / мешают реакции.
    inhibitors: uniq(toArray(x.inhibitors || x.blockers)),
    // Явные несовместимости (id других реагентов).
    incompatibleWith: uniq(toArray(x.incompatibleWith || x.conflictsWith)),
    // Явные синергии.
    synergyWith: uniq(toArray(x.synergyWith || x.allies)),
    priority: clamp(num(x.priority, 0.5), 0, 1),
    available: x.available !== false,
    meta: x.meta || {},
  };
}

// ---------------------------------------------------------------------------
//  Конфликты
// ---------------------------------------------------------------------------
//  Возвращает { weight, reasons[] }. weight ∈ [0, 1] — сила конфликта.
function detectConflict(a, b) {
  const A = normalizeReagent(a);
  const B = normalizeReagent(b);
  const reasons = [];
  let weight = 0;

  // 1. Явная несовместимость — бинарный конфликт.
  if (A.incompatibleWith.includes(B.id) || B.incompatibleWith.includes(A.id)) {
    weight = Math.max(weight, 1.0);
    reasons.push({ kind: 'explicit', detail: `${A.id} <-> ${B.id}` });
  }

  // 2. Борьба за разделяемый ресурс (file-lock / CPU / порт).
  const shared = intersect(A.resources, B.resources);
  if (shared.length > 0) {
    const w = clamp(shared.length / Math.max(1, Math.min(A.resources.length, B.resources.length)));
    weight = Math.max(weight, 0.4 + 0.5 * w);
    reasons.push({ kind: 'resource', detail: shared.join(','), weight: round(w) });
  }

  // 3. Противоречивые заряды: два доминирующих отрицательных заряда.
  if (A.charge <= -0.5 && B.charge <= -0.5) {
    weight = Math.max(weight, 0.7);
    reasons.push({ kind: 'polarity', detail: 'both-negative' });
  }

  // 4. Незакрытые потребности: A.needs пересекается с B.inhibitors.
  const blocked = intersect(A.needs, B.inhibitors.concat(B.incompatibleWith));
  if (blocked.length > 0) {
    const w = clamp(blocked.length / Math.max(1, A.needs.length));
    weight = Math.max(weight, 0.5 + 0.3 * w);
    reasons.push({ kind: 'blocked-needs', detail: blocked.join(',') });
  }

  // 5. Ингибиторы взаимно пересекаются со skills (яды против компетенций).
  const poisoned = intersect(A.skills, B.inhibitors).concat(intersect(B.skills, A.inhibitors));
  if (poisoned.length > 0) {
    weight = Math.max(weight, 0.45 + 0.2 * clamp(poisoned.length / 3));
    reasons.push({ kind: 'poisoned', detail: uniq(poisoned).join(',') });
  }

  // 6. Перегрузка: суммарная валентность превышает разумный предел.
  const load = (A.valence + B.valence);
  if (load > 3) {
    weight = Math.max(weight, clamp((load - 3) / 3) * 0.6);
    reasons.push({ kind: 'valence', detail: `sum=${load}` });
  }

  return { weight: clamp(weight), reasons };
}

// ---------------------------------------------------------------------------
//  Катализ
// ---------------------------------------------------------------------------
//  Возвращает { factor, catalysts[], inhibitors[] }.
//  factor < 1 — снижает барьер (катализ); factor > 1 — повышает (ингибирование).
function catalysis(a, b) {
  const A = normalizeReagent(a);
  const B = normalizeReagent(b);

  // Катализаторы: общие для пары + поддержка общими навыками.
  const cat = uniq(A.catalysts.concat(B.catalysts));
  const shared = intersect(A.catalysts, B.catalysts);
  const inh = uniq(A.inhibitors.concat(B.inhibitors));

  // Общий катализатор и общий навык — это «кофактор».
  const skillCofactors = intersect(A.skills, B.skills);

  const catBoost =
    cat.length * CATALYSIS.perCatalyst +
    shared.length * CATALYSIS.perCatalyst +
    skillCofactors.length * 0.05;

  const reduction = clamp(catBoost, 0, CATALYSIS.maxReduction);
  const boost = inh.length * CATALYSIS.inhibitorBoost;

  const factor = clamp(1 - reduction + boost, 0.1, 3.0);

  return {
    factor: round(factor),
    catalysts: cat,
    cofactors: skillCofactors,
    inhibitors: inh,
    reduction: round(reduction),
    boost: round(boost),
  };
}

// ---------------------------------------------------------------------------
//  Сила связи (сродство) между реагентами
// ---------------------------------------------------------------------------
function affinity(a, b) {
  const A = normalizeReagent(a);
  const B = normalizeReagent(b);

  const skillSim = jaccard(A.skills, B.skills);
  const tagSim = jaccard(A.tags, B.tags);
  const needFit = jaccard(A.needs, B.skills) + jaccard(B.needs, A.skills);
  const explicitSyn =
    (A.synergyWith.includes(B.id) ? 1 : 0) + (B.synergyWith.includes(A.id) ? 1 : 0);

  const raw =
    0.42 * skillSim +
    0.22 * tagSim +
    0.20 * clamp(needFit) +
    0.16 * clamp(explicitSyn / 2);

  return round(clamp(raw));
}

// ---------------------------------------------------------------------------
//  Барьер активации  (энергия, которую надо затратить, чтобы реакция пошла)
// ---------------------------------------------------------------------------
function activationBarrier(a, b, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const A = normalizeReagent(a);
  const B = normalizeReagent(b);

  const intrinsic = 0.5 * (A.activation + B.activation);
  const aff = affinity(A, B);
  const { factor } = catalysis(A, B);

  // Барьер снижается сродством и катализом.
  let barrier = intrinsic * (1 - 0.6 * aff) * factor;

  // Температура: >1 разгоняет (снижает барьер), <1 замедляет.
  const temp = clamp(num(opts.temperature, 1), 0.1, 3);
  barrier = barrier / temp;

  return round(clamp(barrier, 0, 1));
}

// ---------------------------------------------------------------------------
//  Основная функция — реакция
// ---------------------------------------------------------------------------
function react(a, b, options = {}) {
  const opts = Object.assign({}, DEFAULTS, options);
  const A = normalizeReagent(a);
  const B = normalizeReagent(b);

  // Самовзаимодействие запрещено, если задано.
  if (!opts.allowSelfReact && A.id === B.id) {
    return {
      a: A,
      b: B,
      type: REACTION_TYPES.INERT,
      score: 0,
      barrier: 1,
      energy: 0,
      catalysts: [],
      inhibitors: [],
      products: [],
      conflicts: [],
      notes: ['self-reaction disabled'],
    };
  }

  const conflict = detectConflict(A, B);
  const cat = catalysis(A, B);
  const aff = affinity(A, B);
  const barrier = activationBarrier(A, B, opts);
  const notes = [];

  // Реакция не идёт: нет сродства и нет конфликта.
  if (aff < THRESHOLDS.inert && conflict.weight < THRESHOLDS.inert) {
    notes.push('no affinity, no conflict');
    return {
      a: A, b: B,
      type: REACTION_TYPES.INERT,
      score: 0,
      barrier,
      energy: 0,
      catalysts: cat.catalysts,
      inhibitors: cat.inhibitors,
      products: [],
      conflicts: [],
      notes,
    };
  }

  // Конфликт доминирует над синергией.
  let type;
  if (conflict.weight >= THRESHOLDS.conflict) {
    type = REACTION_TYPES.CONFLICT;
  } else if (conflict.weight >= THRESHOLDS.friction) {
    type = REACTION_TYPES.FRICTION;
  } else if (aff >= THRESHOLDS.bond && conflict.weight < THRESHOLDS.friction) {
    type = REACTION_TYPES.BOND;
  } else {
    type = REACTION_TYPES.INERT;
  }

  // Итоговый скор: сродство усиленное катализом минус конфликт.
  const baseScore = aff + (1 - cat.factor) * 0.3;
  const score = clamp(baseScore - conflict.weight * 0.8);

  // Продукты: объединение навыков/тегов минус «выгоревшие» ингибиторы.
  const products = uniq(A.skills.concat(B.skills)).filter(
    (s) => !cat.inhibitors.includes(s)
  );

  if (type === REACTION_TYPES.BOND) notes.push('synergy: low barrier, high affinity');
  if (type === REACTION_TYPES.CONFLICT) notes.push('conflict: hard incompatibility');
  if (type === REACTION_TYPES.FRICTION) notes.push('friction: workable but lossy');
  if (cat.factor < 1) notes.push(`catalyzed x${cat.factor}`);
  if (cat.factor > 1) notes.push(`inhibited x${cat.factor}`);

  // Энергия реакции: сколько остаётся полезной работы после барьера.
  const energy = round(clamp((score - barrier) + 0.5));

  return {
    a: A,
    b: B,
    type,
    score: round(score),
    affinity: aff,
    barrier,
    energy,
    catalysisFactor: cat.factor,
    catalysts: cat.catalysts,
    cofactors: cat.cofactors,
    inhibitors: cat.inhibitors,
    products,
    conflicts: conflict.reasons,
    conflictWeight: round(conflict.weight),
    notes,
  };
}

// ---------------------------------------------------------------------------
//  Пакетная реакция: реактор над списком реагентов
// ---------------------------------------------------------------------------
function reactAll(reagents, options = {}) {
  const list = toArray(reagents).map(normalizeReagent);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      results.push(react(list[i], list[j], options));
    }
  }
  return results;
}

// Сводка по пакету реакций.
function summarize(results) {
  const summary = {
    total: results.length,
    bond: 0,
    conflict: 0,
    friction: 0,
    inert: 0,
    avgScore: 0,
    worst: null,
    best: null,
  };
  let sum = 0;
  for (const r of results) {
    summary[r.type] = (summary[r.type] || 0) + 1;
    sum += r.score;
    if (!summary.best || r.score > summary.best.score) summary.best = r;
    if (!summary.worst || r.score < summary.worst.score) summary.worst = r;
  }
  summary.avgScore = results.length ? round(sum / results.length) : 0;
  return summary;
}

// ---------------------------------------------------------------------------
//  Экспорт
// ---------------------------------------------------------------------------
module.exports = {
  REACTION_TYPES,
  THRESHOLDS,
  CATALYSIS,
  react,
  reactAll,
  summarize,
  detectConflict,
  catalysis,
  affinity,
  activationBarrier,
  normalizeReagent,
  jaccard,
};

// Прямой запуск — маленькая демонстрация.
if (require.main === module) {
  const a = {
    id: 'builder',
    skills: ['js', 'refactor', 'tests'],
    tags: ['frontend'],
    resources: ['repo'],
    charge: 0.6,
    catalysts: ['mentor'],
    incompatibleWith: ['saboteur'],
  };
  const b = {
    id: 'reviewer',
    skills: ['js', 'review', 'tests'],
    tags: ['frontend'],
    resources: ['repo'],
    charge: 0.4,
    catalysts: ['mentor'],
    needs: ['js'],
  };
  const c = {
    id: 'saboteur',
    skills: ['js'],
    inhibitors: ['tests', 'mentor'],
    charge: -0.8,
    incompatibleWith: ['builder'],
  };
  console.log(JSON.stringify(react(a, b), null, 2));
  console.log(JSON.stringify(summarize(reactAll([a, b, c])), null, 2));
}
