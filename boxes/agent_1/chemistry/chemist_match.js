// ============================================================================
//  chemistry/chemist_match.js
//  «Химия» матчинга задач и агентов.
//
//  Идея: каждая задача и каждый агент описываются вектором «элементов»
//  (навыков, тегов, доменов). Совместимость считается как химическое родство:
//    - перекрытие навыков (skill overlap / Jaccard)
//    - сродство доменов (affinity)
//    - загруженность агента (load / balance)
//    - надёжность по истории (reliability / success rate)
//    - стоимость и задержка (cost / latency)
//    - жёсткие ограничения (capabilities, permissions)
//
//  Публичный API:
//    match(task, agents[, options]) -> { task, matches, best, rejected }
//
//  Модуль чистый: без внешних зависимостей, детерминированный.
// ============================================================================

'use strict';

// ---------------------------------------------------------------------------
//  Константы весов по умолчанию
// ---------------------------------------------------------------------------
const WEIGHTS = {
  skill: 0.34,       // перекрытие навыков
  affinity: 0.18,    // доменное/теговое сродство
  reliability: 0.16, // исторический success rate
  load: 0.14,        // свободная мощность
  cost: 0.10,        // дешевизна
  latency: 0.08,     // скорость
};

const DEFAULTS = {
  minScore: 0.0,
  limit: Infinity,
  requireSkills: true,   // задача с requiredSkills требует хотя бы одного совпадения
  excludeUnavailable: true,
  now: () => Date.now(),
};

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
  if (Number.isNaN(x) || x === Infinity || x === -Infinity) return lo;
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

// Jaccard: |A ∩ B| / |A ∪ B|
function jaccard(a, b) {
  const A = new Set(toArray(a).map((s) => String(s).toLowerCase()));
  const B = new Set(toArray(b).map((s) => String(s).toLowerCase()));
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Взвешенное перекрытие: доля требуемых навыков, покрытых агентом.
function coverage(required, have) {
  const R = uniq(required);
  if (R.length === 0) return 1; // нет требований — покрытие полное
  const H = new Set(uniq(have));
  let hit = 0;
  for (const r of R) if (H.has(r)) hit++;
  return hit / R.length;
}

// ---------------------------------------------------------------------------
//  Нормализация входа
// ---------------------------------------------------------------------------
function normalizeTask(task) {
  const t = task && typeof task === 'object' ? task : {};
  return {
    id: t.id || t.name || 'task',
    title: t.title || t.name || t.id || 'task',
    requiredSkills: uniq(toArray(t.requiredSkills || t.skills || t.requires)),
    tags: uniq(toArray(t.tags || t.domains || t.topics)),
    priority: clamp(num(t.priority, 0.5), 0, 1),
    complexity: clamp(num(t.complexity, 0.5), 0, 1),
    maxCost: t.maxCost === undefined ? Infinity : num(t.maxCost, Infinity),
    maxLatency: t.maxLatency === undefined ? Infinity : num(t.maxLatency, Infinity),
    minReliability: clamp(num(t.minReliability, 0), 0, 1),
    forbid: uniq(toArray(t.forbid || t.forbiddenCapabilities)),
  };
}

function normalizeAgent(agent) {
  const a = agent && typeof agent === 'object' ? agent : {};
  const skills = uniq(toArray(a.skills || a.capabilities));
  const tags = uniq(toArray(a.tags || a.domains));
  return {
    id: a.id || a.name || 'agent',
    name: a.name || a.id || 'agent',
    skills,
    tags,
    // свободная мощность: 1 — полностью свободен, 0 — загружен
    capacity: clamp(num(a.capacity, 1), 0, 1),
    load: clamp(num(a.load, 0), 0, 1),
    // история
    attempts: Math.max(0, num(a.attempts, 0)),
    successes: Math.max(0, num(a.successes, 0)),
    successRate: a.successRate !== undefined ? clamp(num(a.successRate, 0.5), 0, 1) : null,
    avgCost: num(a.avgCost, 0),
    avgLatency: num(a.avgLatency, 0), // мс
    available: a.available !== false,
    capabilities: uniq(toArray(a.capabilities)),
    meta: a.meta || {},
  };
}

// ---------------------------------------------------------------------------
//  Компоненты оценки
// ---------------------------------------------------------------------------

// 1. Навыковый скор: смесь покрытия (coverage) и симметричного Jaccard.
function skillScore(task, agent) {
  const cov = coverage(task.requiredSkills, agent.skills);
  const jac = jaccard(task.requiredSkills, agent.skills);
  // покрытие важнее симметрии: 70/30
  return clamp(0.7 * cov + 0.3 * jac);
}

// 2. Сродство доменов/тегов.
function affinityScore(task, agent) {
  const tagSim = jaccard(task.tags, agent.tags);
  const capSim = jaccard(task.tags, agent.capabilities);
  return clamp(0.6 * tagSim + 0.4 * capSim);
}

// 3. Надёжность: приоритет явному successRate, иначе — по истории.
function reliabilityScore(task, agent) {
  let rate;
  if (agent.successRate !== null) {
    rate = agent.successRate;
  } else if (agent.attempts > 0) {
    rate = agent.successes / agent.attempts;
  } else {
    rate = 0.5; // нет данных — нейтрально
  }
  // Небольшой бонус за опыт, насыщающийся на 20 попытках.
  const experience = clamp(agent.attempts / 20);
  const experienceBonus = 0.1 * experience;
  const score = clamp(0.9 * rate + experienceBonus);
  // Учёт требования minReliability.
  if (task.minReliability > 0 && rate < task.minReliability) {
    return score * 0.5; // штраф, но не полный бан — решает hard-фильтр
  }
  return score;
}

// 4. Свободная мощность агента.
function loadScore(task, agent) {
  // headroom: сколько ещё влезет с учётом capacity и текущей загрузки
  const headroom = clamp(agent.capacity * (1 - agent.load));
  // idle-бонус для агентов, которые вообще почти не нагружены
  const idle = clamp(1 - agent.load);
  return clamp(0.6 * headroom + 0.4 * idle);
}

// 5. Стоимость: чем дешевле относительно лимита, тем лучше.
function costScore(task, agent) {
  if (agent.avgCost <= 0) return 1;
  if (task.maxCost === Infinity || task.maxCost <= 0) {
    // Нет лимита — нормируем по логарифму, 10 → ~0.5.
    return clamp(1 / (1 + Math.log10(1 + agent.avgCost)));
  }
  const ratio = clamp(agent.avgCost / task.maxCost, 0, 2);
  return clamp(1 - ratio);
}

// 6. Задержка.
function latencyScore(task, agent) {
  if (agent.avgLatency <= 0) return 1;
  if (task.maxLatency === Infinity || task.maxLatency <= 0) {
    // Без лимита: 1000мс → ~0.5
    return clamp(1 / (1 + Math.log10(1 + agent.avgLatency / 100)));
  }
  const ratio = clamp(agent.avgLatency / task.maxLatency, 0, 2);
  return clamp(1 - ratio);
}

// ---------------------------------------------------------------------------
//  Жёсткие ограничения
// ---------------------------------------------------------------------------
function checkHardConstraints(task, agent) {
  const reasons = [];

  if (task.requiredSkills.length > 0 && agent.skills.length === 0) {
    reasons.push('no_skills');
  }
  // Запрещённые capability
  for (const f of task.forbid) {
    if (agent.capabilities.includes(f) || agent.skills.includes(f)) {
      reasons.push('forbidden_capability:' + f);
    }
  }
  // Лимит стоимости
  if (task.maxCost !== Infinity && agent.avgCost > task.maxCost) {
    reasons.push('over_budget');
  }
  // Лимит задержки
  if (task.maxLatency !== Infinity && agent.avgLatency > task.maxLatency) {
    reasons.push('over_latency');
  }
  // Минимальная надёжность
  if (task.minReliability > 0) {
    const rate = agent.successRate !== null
      ? agent.successRate
      : (agent.attempts > 0 ? agent.successes / agent.attempts : 0);
    if (rate < task.minReliability) {
      reasons.push('low_reliability');
    }
  }
  // Требование совпадения хотя бы одного навыка
  if (task.requiredSkills.length > 0 && agent.skills.length > 0) {
    const inter = task.requiredSkills.filter((s) => agent.skills.includes(s));
    if (inter.length === 0) reasons.push('no_skill_overlap');
  }

  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
//  Оценка пары
// ---------------------------------------------------------------------------
function scorePair(task, agent, opts) {
  const weights = Object.assign({}, WEIGHTS, (opts && opts.weights) || {});

  const components = {
    skill: skillScore(task, agent),
    affinity: affinityScore(task, agent),
    reliability: reliabilityScore(task, agent),
    load: loadScore(task, agent),
    cost: costScore(task, agent),
    latency: latencyScore(task, agent),
  };

  let total = 0;
  let weightSum = 0;
  const contributions = {};
  for (const k of Object.keys(weights)) {
    const w = num(weights[k], 0);
    if (w <= 0) continue;
    const v = components[k] !== undefined ? components[k] : 0;
    total += v * w;
    weightSum += w;
    contributions[k] = round(v * w);
  }
  if (weightSum > 0) total /= weightSum;

  // Бонус за приоритет: для срочных задач свободная мощность важнее среднего.
  const priorityBoost = task.priority * components.load * 0.05;
  total = clamp(total + priorityBoost);

  return {
    score: round(total),
    components: mapRound(components),
    contributions,
  };
}

function mapRound(obj) {
  const out = {};
  for (const k of Object.keys(obj)) out[k] = round(obj[k]);
  return out;
}

// ---------------------------------------------------------------------------
//  Объяснение выбора
// ---------------------------------------------------------------------------
function explain(task, agent, scored) {
  const c = scored.components;
  const parts = [];
  parts.push(`skill=${c.skill}`);
  parts.push(`affinity=${c.affinity}`);
  parts.push(`reliability=${c.reliability}`);
  parts.push(`load=${c.load}`);
  parts.push(`cost=${c.cost}`);
  parts.push(`latency=${c.latency}`);

  const overlap = task.requiredSkills.filter((s) => agent.skills.includes(s));
  const missing = task.requiredSkills.filter((s) => !agent.skills.includes(s));

  return {
    agent: agent.id,
    score: scored.score,
    overlap,
    missing,
    formula: parts.join(' | '),
  };
}

// ---------------------------------------------------------------------------
//  Публичный API
// ---------------------------------------------------------------------------
function match(task, agents, options) {
  const opts = Object.assign({}, DEFAULTS, options || {});
  const t = normalizeTask(task);
  const list = toArray(agents).map(normalizeAgent);

  if (list.length === 0) {
    return { task: t, matches: [], best: null, rejected: [], count: 0 };
  }

  const matches = [];
  const rejected = [];

  for (const agent of list) {
    // Фильтр доступности
    if (opts.excludeUnavailable && !agent.available) {
      rejected.push({ agent: agent.id, reasons: ['unavailable'] });
      continue;
    }

    const hard = checkHardConstraints(t, agent);
    if (!hard.ok) {
      rejected.push({ agent: agent.id, reasons: hard.reasons });
      continue;
    }

    const scored = scorePair(t, agent, opts);
    if (scored.score < opts.minScore) {
      rejected.push({ agent: agent.id, reasons: ['below_min_score'], score: scored.score });
      continue;
    }

    matches.push(Object.assign({
      id: agent.id,
      name: agent.name,
      agent,
      rank: 0,
      why: explain(t, agent, scored),
    }, scored));
  }

  // Сортировка: по score desc, при равенстве — по загрузке asc (стабильно).
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.agent.load - b.agent.load;
  });

  matches.forEach((m, i) => { m.rank = i + 1; });

  const limited = opts.limit === Infinity ? matches : matches.slice(0, opts.limit);

  return {
    task: t,
    matches: limited,
    best: limited.length ? limited[0] : null,
    rejected,
    count: limited.length,
  };
}

// ---------------------------------------------------------------------------
//  Дополнительные помощники (переиспользуемы)
// ---------------------------------------------------------------------------
function rank(task, agents, options) {
  return match(task, agents, options).matches.map((m) => ({
    id: m.id,
    score: m.score,
    rank: m.rank,
  }));
}

function top(task, agents, n) {
  return match(task, agents, { limit: n });
}

function matrix(task, agents) {
  const t = normalizeTask(task);
  const list = toArray(agents).map(normalizeAgent);
  const rows = list.map((a) => {
    const hard = checkHardConstraints(t, a);
    const scored = hard.ok ? scorePair(t, a, {}) : null;
    return {
      agent: a.id,
      ok: hard.ok,
      reasons: hard.reasons,
      score: scored ? scored.score : 0,
      components: scored ? scored.components : null,
    };
  });
  return { task: t.id, rows };
}

// ============================================================================
module.exports = {
  match,
  rank,
  top,
  matrix,
  // низкоуровневые хелперы
  normalizeTask,
  normalizeAgent,
  skillScore,
  affinityScore,
  reliabilityScore,
  loadScore,
  costScore,
  latencyScore,
  checkHardConstraints,
  scorePair,
  // util
  jaccard,
  coverage,
  clamp,
  weights: WEIGHTS,
};
