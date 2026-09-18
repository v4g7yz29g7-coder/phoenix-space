'use strict';

/**
 * evolution/biologist_team_builder.js
 * ───────────────────────────────────────────────────────────────────────────
 * Биолог-бригадир: собирает сбалансированную тройку агентов под профиль
 * задачи. Экологическая метафора — стая/трио хищников с разделением ролей:
 *
 *   1) Быстрый    (Velox)     — стремительный исполнитель, делает «первый
 *                               проход» и разведку: скорость важнее глубины.
 *   2) Диверсант  (Saboteur)  — мутатор-разрушитель, генерирует неожиданные,
 *                               рискованные ходы, ломает шаблоны и тупики.
 *   3) Страховщик (Assecur)   — стабилизатор-страж, проверяет результат,
 *                               закрывает риски и доводит до надёжности.
 *
 * Тройка взаимно дополняет друг друга: скорость × вариативность × надёжность.
 * Роли выбираются детерминированно по профилю, но с управляемым джиттером,
 * чтобы одинаковый профиль всегда давал одну и ту же команду.
 *
 * Публичный API:
 *   buildTeam(profile) -> {
 *     profile, roles:[...], team:[{id, role, genome, fitness, ...}],
 *     coverage, synergy, notes, generatedAt
 *   }
 *
 * Дополнительно:
 *   listRoles()          -> [ {key, name, archetype, ...} ]
 *   evaluateTeam(team, profile) -> { coverage, synergy, gaps, verdict }
 *   describeTeam(team)   -> string
 *
 * Модуль без внешних зависимостей и без побочных эффектов.
 * Автор: evolution / phoenix
 * ───────────────────────────────────────────────────────────────────────────
 */

// ───────────────────────────────────────────────────────────────────────────
// КАТАЛОГ РОЛЕЙ
// ───────────────────────────────────────────────────────────────────────────

/**
 * Обязательные роли трио. Порядок фиксирован и определяет «костяк» команды.
 * weight-поля описывают целевую ДНК роли по осям генома (0..1).
 */
const ROLE_CATALOG = [
  {
    key: 'fast',
    name: 'Быстрый',
    archetype: 'Velox',
    niche: 'Scout',
    order: 0,
    weight: {
      speed: 0.95,
      curiosity: 0.70,
      creativity: 0.55,
      stability: 0.25,
      cooperation: 0.50,
      resilience: 0.45,
      empathy: 0.40,
      aggression: 0.55,
    },
    mandate: 'Первым входит в задачу, делает быстрый черновой проход и разведку.',
    risk: 'low',
  },
  {
    key: 'saboteur',
    name: 'Диверсант',
    archetype: 'Saboteur',
    niche: 'Mutant',
    order: 1,
    weight: {
      speed: 0.60,
      curiosity: 0.85,
      creativity: 0.95,
      stability: 0.15,
      cooperation: 0.40,
      resilience: 0.55,
      empathy: 0.30,
      aggression: 0.80,
    },
    mandate: 'Ломает шаблоны, генерирует рискованные гипотезы, ищет слабые места.',
    risk: 'high',
  },
  {
    key: 'insurer',
    name: 'Страховщик',
    archetype: 'Assecur',
    niche: 'Guardian',
    order: 2,
    weight: {
      speed: 0.35,
      curiosity: 0.45,
      creativity: 0.40,
      stability: 0.95,
      cooperation: 0.80,
      resilience: 0.90,
      empathy: 0.75,
      aggression: 0.20,
    },
    mandate: 'Страхует результат: валидирует, закрывает риски, доводит до надёжности.',
    risk: 'minimal',
  },
];

/** Оси генома, по которым оценивается совместимость ролей. */
const TRAIT_AXES = [
  'speed',
  'curiosity',
  'creativity',
  'stability',
  'cooperation',
  'resilience',
  'empathy',
  'aggression',
];

/** Минимальный «покрывающий» порог, ниже которого роль считается слабой. */
const COVERAGE_THRESHOLD = 0.55;

/** Число попыток тонкой подгонки генома к целевому профилю роли. */
const TUNE_STEPS = 4;

// ───────────────────────────────────────────────────────────────────────────
// УТИЛИТЫ
// ───────────────────────────────────────────────────────────────────────────

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Стабильный хеш строки (FNV-1a, 32 бита). */
function hash(str) {
  let h = 2166136261;
  const s = String(str == null ? '' : str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Псевдослучайное число в [0,1) из строки и соли (детерминированно). */
function rand(str, salt) {
  return (hash(str + '|' + salt) % 100000) / 100000;
}

/** Приводит значение к числу с дефолтом. */
function num(v, dflt) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Нормализует значение в [0,1] по диапазону [min,max]. */
function norm(v, min, max) {
  if (max === min) return 0;
  return clamp((v - min) / (max - min), 0, 1);
}

/** Мягкое копирование: возвращает новый объект с числовыми полями. */
function cloneNum(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) out[k] = num(obj[k], 0);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// ПРОФИЛЬ ЗАДАЧИ
// ───────────────────────────────────────────────────────────────────────────

/**
 * Нормализует произвольный профиль задачи в единый вид.
 * Поддерживаются как числовые подсказки (speed/risk/…), так и строковые
 * маркеры (tags, skills, kind).
 * @param {Object} [profile]
 * @returns {Object}
 */
function normalizeProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  const tags = Array.isArray(p.tags) ? p.tags.map(String) : [];
  const skills = Array.isArray(p.skills) ? p.skills.map(String) : [];

  // Признаки задачи, выведенные из сырых подсказок.
  const urgency = clamp(num(p.urgency, num(p.speed, 0.5)), 0, 1);
  const riskTolerance = clamp(num(p.riskTolerance, num(p.risk, 0.5)), 0, 1);
  const quality = clamp(num(p.quality, num(p.precision, 0.5)), 0, 1);
  const novelty = clamp(num(p.novelty, num(p.exploration, 0.5)), 0, 1);
  const budget = Math.max(0, num(p.budget, num(p.energy, 100)));

  // Текстовые маркеры влияют на оси.
  const joined = (tags.concat(skills).join(' ')).toLowerCase();
  const has = (w) => (joined.indexOf(w) >= 0 ? 0.1 : 0);
  const textUrgency = has('urgent') + has('fast') + has('срочно');
  const textRisk = has('risky') + has('bet') + has('риск');
  const textQuality = has('quality') + has('safe') + has('надёж');

  return {
    id: p.id != null ? String(p.id) : 'task-' + hash(joined + '|' + urgency).toString(36),
    urgency: clamp(urgency + textUrgency, 0, 1),
    riskTolerance: clamp(riskTolerance + textRisk, 0, 1),
    quality: clamp(quality + textQuality, 0, 1),
    novelty,
    budget,
    tags,
    skills,
    raw: p,
  };
}

/**
 * Целевой геном команды, выведенный из профиля задачи.
 * Определяет, каким должен быть «идеальный» ансамбль.
 */
function desiredGenome(profile) {
  return {
    speed: clamp(0.4 + profile.urgency * 0.6, 0, 1),
    curiosity: clamp(0.4 + profile.novelty * 0.5, 0, 1),
    creativity: clamp(0.35 + profile.novelty * 0.6, 0, 1),
    stability: clamp(0.35 + profile.quality * 0.6, 0, 1),
    cooperation: clamp(0.45 + profile.quality * 0.3, 0, 1),
    resilience: clamp(0.4 + profile.quality * 0.5, 0, 1),
    empathy: clamp(0.4 + profile.quality * 0.3, 0, 1),
    aggression: clamp(0.3 + profile.riskTolerance * 0.5, 0, 1),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ГЕНОМ АГЕНТА
// ───────────────────────────────────────────────────────────────────────────

/**
 * Извлекает геном агента из сырого объекта.
 * Если у агента есть traits — берём их, иначе восстанавливаем из фитнеса.
 */
function agentGenome(agent) {
  if (!agent || typeof agent !== 'object') return null;
  if (agent.genome && typeof agent.genome === 'object') return cloneNum(agent.genome);
  if (agent.traits && typeof agent.traits === 'object') return cloneNum(agent.traits);
  // Реконструкция из числовых полей агента.
  const fitness = norm(num(agent.fitness, 0), -100, 100);
  return {
    speed: clamp(num(agent.speed, fitness), 0, 1),
    curiosity: clamp(num(agent.curiosity, 0.5), 0, 1),
    creativity: clamp(num(agent.creativity, fitness), 0, 1),
    stability: clamp(num(agent.stability, fitness), 0, 1),
    cooperation: clamp(num(agent.cooperation, 0.5), 0, 1),
    resilience: clamp(num(agent.resilience, fitness), 0, 1),
    empathy: clamp(num(agent.empathy, 0.5), 0, 1),
    aggression: clamp(num(agent.aggression, 1 - fitness), 0, 1),
  };
}

/** Евклидова близость двух геномов в [0,1] (1 = идентичны). */
function genomeSimilarity(a, b) {
  let sum = 0;
  for (const axis of TRAIT_AXES) {
    const d = (num(a[axis], 0.5) - num(b[axis], 0.5));
    sum += d * d;
  }
  const dist = Math.sqrt(sum / TRAIT_AXES.length);
  return clamp(1 - dist, 0, 1);
}

// ───────────────────────────────────────────────────────────────────────────
// ПОДБОР АГЕНТА ПОД РОЛЬ
// ───────────────────────────────────────────────────────────────────────────

/**
 * Оценивает пригодность агента к роли: близость генома к весам роли,
 * скорректированная бюджетом и общим фитнесом.
 */
function fitScore(agent, role, profile, salt) {
  const genome = agentGenome(agent);
  if (!genome) return -1;
  const target = role.weight;
  let acc = 0;
  for (const axis of TRAIT_AXES) {
    const w = num(target[axis], 0.5);
    const v = num(genome[axis], 0.5);
    acc += 1 - Math.abs(w - v);
  }
  const base = acc / TRAIT_AXES.length; // 0..1
  const fitness = norm(num(agent.fitness, num(agent.score, 0)), -100, 100);
  const jitter = rand((agent.id || 'x') + role.key, salt) * 0.015;
  const budgetPenalty = profile.budget < 30 ? 0.05 : 0;
  return clamp(base * 0.7 + fitness * 0.3 + jitter - budgetPenalty, 0, 1);
}

/**
 * Из переданного пула выбирает лучшего агента под роль, исключая уже
 * взятых (usedIds). Если пул пуст — синтезирует агента из весов роли.
 */
function selectAgent(pool, role, profile, usedIds, salt) {
  let best = null;
  let bestScore = -Infinity;
  for (const agent of pool) {
    const id = agent && (agent.id != null ? agent.id : agent.name);
    if (id != null && usedIds.has(String(id))) continue;
    const s = fitScore(agent, role, profile, salt);
    if (s > bestScore) {
      bestScore = s;
      best = agent;
    }
  }
  if (best && bestScore >= 0) {
    const id = best.id != null ? best.id : best.name != null ? best.name : role.key + '-' + hash(String(bestScore)).toString(36);
    usedIds.add(String(id));
    return {
      id: String(id),
      role: role.key,
      roleName: role.name,
      archetype: role.archetype,
      genome: agentGenome(best),
      fitness: Math.round(num(best.fitness, num(best.score, 0))),
      source: 'pool',
      fit: Math.round(bestScore * 1000) / 1000,
      mandate: role.mandate,
    };
  }
  return synthesizeAgent(role, profile);
}

// ───────────────────────────────────────────────────────────────────────────
// СИНТЕЗ АГЕНТА (если пул не задан/исчерпан)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Синтезирует агента-роль детерминированно по профилю.
 * Целевой геном = 70% веса роли + 30% желаемого генома команды, плюс
 * управляемый джиттер. Так роли получаются сбалансированными, но живыми.
 */
function synthesizeAgent(role, profile) {
  const desired = desiredGenome(profile);
  const genome = {};
  const idSeed = role.key + '|' + profile.id + '|' + String(profile.urgency.toFixed(3));
  for (const axis of TRAIT_AXES) {
    const target = num(role.weight[axis], 0.5) * 0.7 + num(desired[axis], 0.5) * 0.3;
    const jitter = (rand(idSeed, axis) - 0.5) * 0.08;
    genome[axis] = Math.round(clamp(target + jitter, 0, 1) * 1000) / 1000;
  }
  const fit = genomeSimilarity(genome, role.weight);
  const fitness = Math.round((fit * 0.6 + 0.4) * 100);
  return {
    id: role.archetype.toLowerCase() + '-' + hash(idSeed).toString(36),
    role: role.key,
    roleName: role.name,
    archetype: role.archetype,
    genome,
    fitness,
    source: 'synthesized',
    fit: Math.round(fit * 1000) / 1000,
    mandate: role.mandate,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ОЦЕНКА КОМАНДЫ
// ───────────────────────────────────────────────────────────────────────────

/**
 * Покрытие команды по каждой оси: насколько ансамбль закрывает весь спектр.
 * Возвращает { perAxis, overall }.
 */
function coverageOf(team, profile) {
  const desired = desiredGenome(profile);
  const perAxis = {};
  let acc = 0;
  for (const axis of TRAIT_AXES) {
    let best = 0;
    for (const member of team) {
      const v = num(member.genome && member.genome[axis], 0);
      // Чем ближе к цели и чем выше абсолютно — тем лучше покрытие.
      const score = clamp(1 - Math.abs(v - num(desired[axis], 0.5)), 0, 1);
      if (score > best) best = score;
    }
    perAxis[axis] = Math.round(best * 1000) / 1000;
    acc += best;
  }
  return { perAxis, overall: Math.round((acc / TRAIT_AXES.length) * 1000) / 1000 };
}

/**
 * Внутренняя синергия трио: комплементарность ролей (разные ниши) и
 * базовая близость. Итог [0,1].
 */
function synergyOf(team) {
  if (team.length < 2) return 0;
  let pairs = 0;
  let acc = 0;
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      const gi = team[i].genome || {};
      const gj = team[j].genome || {};
      const sim = genomeSimilarity(gi, gj);
      // Комплементарность: чуть разные — лучше, чем клоны.
      const complement = 1 - Math.abs(sim - 0.55) / 0.55;
      acc += clamp(0.5 * sim + 0.5 * complement, 0, 1);
      pairs++;
    }
  }
  return Math.round((acc / pairs) * 1000) / 1000;
}

/**
 * Полная оценка команды: покрытие, синергия, «дыры», вердикт.
 */
function evaluateTeam(team, profile) {
  const p = normalizeProfile(profile);
  const members = Array.isArray(team) ? team : [];
  const coverage = coverageOf(members, p);
  const synergy = synergyOf(members);
  const gaps = [];
  for (const axis of TRAIT_AXES) {
    if (coverage.perAxis[axis] < COVERAGE_THRESHOLD) gaps.push(axis);
  }
  const expected = ROLE_CATALOG.length;
  const missingRoles = ROLE_CATALOG
    .filter((r) => !members.some((m) => m.role === r.key))
    .map((r) => r.key);

  let verdict = 'ok';
  if (members.length < expected || missingRoles.length) verdict = 'incomplete';
  if (coverage.overall >= 0.8 && synergy >= 0.5 && !missingRoles.length) verdict = 'coalition';
  if (coverage.overall < 0.6) verdict = 'weak';

  return {
    coverage,
    synergy,
    gaps,
    missingRoles,
    verdict,
    expected,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ОСНОВНОЙ КОНВЕЙЕР
// ───────────────────────────────────────────────────────────────────────────

/**
 * Извлекает пул агентов из профиля (profile.pool) либо использует
 * встроенный синтез. Пул может быть массивом или {agents:[...]}.
 */
function extractPool(profile) {
  const p = profile && typeof profile === 'object' ? profile : {};
  if (Array.isArray(p.pool)) return p.pool;
  if (p.pool && Array.isArray(p.pool.agents)) return p.pool.agents;
  if (Array.isArray(p.agents)) return p.agents;
  if (Array.isArray(p.candidates)) return p.candidates;
  return [];
}

/**
 * Собирает трио: 1 быстрый + 1 диверсант + 1 страховщик.
 *
 * @param {Object} [profile] профиль задачи (urgency, riskTolerance, quality,
 *        novelty, budget, tags, skills, pool/agents — пул кандидатов).
 * @returns {Object} { profile, roles, team, coverage, synergy, notes,
 *          verdict, generatedAt }.
 */
function buildTeam(profile) {
  const p = normalizeProfile(profile);
  const pool = extractPool(profile);
  const usedIds = new Set();
  const salt = 'team|' + p.id;

  const team = ROLE_CATALOG.map((role) => {
    const member = selectAgent(pool, role, p, usedIds, salt);
    member.order = role.order;
    member.niche = role.niche;
    member.risk = role.risk;
    return member;
  }).sort((a, b) => a.order - b.order);

  const evaluation = evaluateTeam(team, p);
  const notes = composeNotes(team, p, evaluation);

  return {
    profile: {
      id: p.id,
      urgency: Math.round(p.urgency * 1000) / 1000,
      riskTolerance: Math.round(p.riskTolerance * 1000) / 1000,
      quality: Math.round(p.quality * 1000) / 1000,
      novelty: Math.round(p.novelty * 1000) / 1000,
      budget: p.budget,
    },
    roles: ROLE_CATALOG.map((r) => ({ key: r.key, name: r.name, archetype: r.archetype })),
    team,
    coverage: evaluation.coverage,
    synergy: evaluation.synergy,
    gaps: evaluation.gaps,
    verdict: evaluation.verdict,
    notes,
    generatedAt: new Date().toISOString(),
  };
}

/** Формирует человекочитаемые заметки по собранной команде. */
function composeNotes(team, profile, evaluation) {
  const notes = [];
  const fast = team.find((m) => m.role === 'fast');
  const saboteur = team.find((m) => m.role === 'saboteur');
  const insurer = team.find((m) => m.role === 'insurer');

  if (fast) notes.push(`Быстрый «${fast.id}» задаёт темп: первым входит в задачу.`);
  if (saboteur) notes.push(`Диверсант «${saboteur.id}» расширяет пространство гипотез и ломает тупики.`);
  if (insurer) notes.push(`Страховщик «${insurer.id}» закрывает риски и валидирует результат.`);

  if (profile.urgency > 0.7) notes.push('Задача срочная: роль «быстрого» усилена приоритетом.');
  if (profile.riskTolerance > 0.7) notes.push('Высокий риск-аппетит: диверсанту выдана свобода маневра.');
  if (profile.quality > 0.7) notes.push('Критично качество: страховщик получает приоритет над скоростью.');
  if (evaluation.gaps.length) notes.push('Провалы покрытия по осям: ' + evaluation.gaps.join(', ') + '.');
  if (!evaluation.gaps.length) notes.push('Все ключевые оси генома покрыты приемлемо.');

  return notes;
}

/** Краткое человекочитаемое описание команды. */
function describeTeam(team) {
  const members = Array.isArray(team) ? team : [];
  if (!members.length) return 'Пустая команда.';
  const parts = members.map((m) => `${m.roleName || m.role}(${m.id})`);
  return 'Трио: ' + parts.join(' + ') + '.';
}

/** Возвращает список доступных ролей (копию каталога без весов). */
function listRoles() {
  return ROLE_CATALOG.map((r) => ({
    key: r.key,
    name: r.name,
    archetype: r.archetype,
    niche: r.niche,
    order: r.order,
    mandate: r.mandate,
    risk: r.risk,
  }));
}

// ───────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ
// ───────────────────────────────────────────────────────────────────────────

module.exports = {
  buildTeam,
  evaluateTeam,
  describeTeam,
  listRoles,
  // служебные, полезные для тестов/расширений
  _internals: {
    normalizeProfile,
    desiredGenome,
    agentGenome,
    genomeSimilarity,
    fitScore,
    selectAgent,
    synthesizeAgent,
    coverageOf,
    synergyOf,
    hash,
    rand,
  },
  ROLE_CATALOG,
  TRAIT_AXES,
  COVERAGE_THRESHOLD,
};

// Прямой запуск: демонстрационный прогон.
if (require.main === module) {
  const demo = buildTeam({
    id: 'demo',
    urgency: 0.8,
    riskTolerance: 0.6,
    quality: 0.7,
    novelty: 0.5,
    budget: 120,
    tags: ['urgent', 'quality'],
  });
  console.log('[biologist_team_builder]', describeTeam(demo.team));
  console.log('verdict=%s synergy=%s coverage=%s',
    demo.verdict, demo.synergy, demo.coverage.overall);
  console.log('notes:', JSON.stringify(demo.notes, null, 2));
}
