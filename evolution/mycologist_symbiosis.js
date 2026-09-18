'use strict';

/**
 * evolution/mycologist_symbiosis.js
 * ───────────────────────────────────────────────────────────────────────────
 * Симбиоз vs паразитизм в мицелиальной сети Phoenix / Aeon.
 *
 * Микологическая метафора: агенты — это узлы мицелия (гифы), связи между
 * ними — это трофические взаимодействия (обмен питательными веществами).
 * Каждая связь описывается знаком эффекта для каждой стороны:
 *
 *      (+/+)  mutualism    — взаимовыгодный симбиоз (микориза, лишайник)
 *      (+/0)  commensalism — комменсализм (один выигрывает, второй нейтрален)
 *      (+/-)  parasitism   — паразитизм (один выигрывает за счёт второго)
 *      (-/0)  amensalism   — аменсализм (один подавляет, второй нейтрален)
 *      (-/-)  competition  — конкуренция (оба теряют)
 *      (0/0)  neutralism   — нейтрализм (связь без эффекта)
 *
 * Публичный API:
 *   createMycologistSymbiosis(config) -> instance
 *       instance.analyze()  -> { ok, analyzedPairs, counts, dominantType,
 *                                indices, verdict, pairs, network }
 *       instance.verify()   -> { ok, checks }
 *       instance.render()   -> string (ASCII-отчёт)
 *   analyze(config)         -> short-hand: createMycologistSymbiosis(cfg).analyze()
 *   classify(a, b)          -> string (тип взаимодействия по знакам эффектов)
 *
 * Дополнительно: classify, sign, buildPairs, computeIndices, gradeOf,
 * TYPES, SIGNS, describe.
 *
 * Автор: evolution / aeon
 */

// ───────────────────────────────────────────────────────────────────────────
// КОНСТАНТЫ
// ───────────────────────────────────────────────────────────────────────────

/** Порог, ниже которого эффект считается нейтральным (шум среды). */
const EPS = 0.05;

/** Канонический список типов взаимодействия, от «лучшего» к «худшему». */
const TYPES = [
  'mutualism',
  'commensalism',
  'neutralism',
  'amensalism',
  'parasitism',
  'competition',
];

/** Приоритет типа при равном счёте в counts (меньше — важнее). */
const TYPE_PRIORITY = TYPES.reduce((acc, t, i) => ((acc[t] = i), acc), {});

/** Человекочитаемые подписи типов (RU). */
const LABELS = {
  mutualism: 'симбиоз (+/+)',
  commensalism: 'комменсализм (+/0)',
  neutralism: 'нейтрализм (0/0)',
  amensalism: 'аменсализм (-/0)',
  parasitism: 'паразитизм (+/-)',
  competition: 'конкуренция (-/-)',
};

/** Условные «знаки» эффекта. */
const SIGNS = { positive: '+', negative: '-', neutral: '0' };

// ───────────────────────────────────────────────────────────────────────────
// БАЗОВЫЕ ХЕЛПЕРЫ
// ───────────────────────────────────────────────────────────────────────────

/** Число -> безопасное конечное число (иначе 0). */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Клэмп в диапазон [lo, hi]. */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Знак эффекта с учётом порога EPS. */
function sign(v) {
  const x = num(v);
  if (x > EPS) return 1;
  if (x < -EPS) return -1;
  return 0;
}

/** Числовой знак -> символьная метка. */
function signLabel(v) {
  const s = sign(v);
  return s > 0 ? SIGNS.positive : s < 0 ? SIGNS.negative : SIGNS.neutral;
}

/** Достать id узла из строки либо объекта { id }. */
function idOf(node) {
  if (node == null) return 'unknown';
  if (typeof node === 'object') return String(node.id != null ? node.id : JSON.stringify(node));
  return String(node);
}

/**
 * Нормализовать эффект взаимодействия к паре [effectA, effectB].
 * Поддерживаются ключи { a, b }, { from, to }, числовой массив.
 */
function normalizeEffect(effect) {
  if (Array.isArray(effect)) return [num(effect[0]), num(effect[1])];
  if (effect && typeof effect === 'object') {
    if ('from' in effect || 'to' in effect) return [num(effect.from), num(effect.to)];
    if ('a' in effect || 'b' in effect) return [num(effect.a), num(effect.b)];
    if ('source' in effect || 'target' in effect) return [num(effect.source), num(effect.target)];
  }
  return [0, 0];
}

/**
 * ГЛАВНАЯ ФУНКЦИЯ КЛАССИФИКАЦИИ.
 * classify(effectA, effectB) -> тип взаимодействия (строка из TYPES).
 */
function classify(a, b) {
  const sa = sign(a);
  const sb = sign(b);
  if (sa > 0 && sb > 0) return 'mutualism';
  if (sa > 0 && sb < 0) return 'parasitism';
  if (sa < 0 && sb > 0) return 'parasitism';
  if (sa < 0 && sb < 0) return 'competition';
  if (sa > 0 && sb === 0) return 'commensalism';
  if (sa === 0 && sb > 0) return 'commensalism';
  if (sa < 0 && sb === 0) return 'amensalism';
  if (sa === 0 && sb < 0) return 'amensalism';
  return 'neutralism';
}

/** Краткое описание типа + знаков. */
function describe(type, a, b) {
  return `${type} [${signLabel(a)}/${signLabel(b)}] — ${LABELS[type] || type}`;
}

/** Проверка «положительный» эффект (для расчёта health). */
function isPositive(v) {
  return sign(v) > 0;
}

/** Проверка «отрицательный» эффект. */
function isNegative(v) {
  return sign(v) < 0;
}

// ───────────────────────────────────────────────────────────────────────────
// СБОРКА ПАР
// ───────────────────────────────────────────────────────────────────────────

/**
 * Собрать агрегированные пары из списка взаимодействий.
 * Несколько связей между одной парой усредняются.
 *
 * @returns {Array<{ a, b, effectA, effectB, type, signA, signB, count }>}
 */
function buildPairs(interactions) {
  const list = Array.isArray(interactions) ? interactions : [];
  const acc = new Map();

  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const a = idOf(it.a != null ? it.a : it.from != null ? it.from : it.source);
    const b = idOf(it.b != null ? it.b : it.to != null ? it.to : it.target);
    const [ea, eb] = normalizeEffect(it.effect);
    const key = a <= b ? `${a}|${b}` : `${b}|${a}`;

    let rec = acc.get(key);
    if (!rec) {
      rec = { a, b, sumA: 0, sumB: 0, count: 0, orientA: a, orientB: b };
      acc.set(key, rec);
    }
    // Сохраняем ориентацию первой записи.
    rec.sumA += ea;
    rec.sumB += eb;
    rec.count += 1;
  }

  const pairs = [];
  for (const rec of acc.values()) {
    const effectA = rec.sumA / rec.count;
    const effectB = rec.sumB / rec.count;
    pairs.push({
      a: rec.a,
      b: rec.b,
      effectA: Number(effectA.toFixed(6)),
      effectB: Number(effectB.toFixed(6)),
      signA: sign(effectA),
      signB: sign(effectB),
      type: classify(effectA, effectB),
      count: rec.count,
    });
  }
  return pairs;
}

// ───────────────────────────────────────────────────────────────────────────
// ИНДЕКСЫ ЗДОРОВЬЯ ЭКОСИСТЕМЫ
// ───────────────────────────────────────────────────────────────────────────

/**
 * computeIndices(pairs, agentsCount) -> метрики мицелиальной сети.
 *  health      — агрегированное «здоровье» симбиоза в [0,1]
 *  mutualism   — доля взаимовыгодных связей
 *  parasitism  — доля паразитических связей
 *  balance     — (mutualism - parasitism), нормировано
 *  density     — плотность связей относительно числа агентов
 *  meanEffect  — средний абсолютный эффект связи
 */
function computeIndices(pairs, agentsCount) {
  const total = pairs.length || 0;
  let pos = 0;
  let neg = 0;
  let mut = 0;
  let par = 0;
  let sumAbs = 0;

  for (const p of pairs) {
    if (isPositive(p.effectA)) pos += 1;
    if (isPositive(p.effectB)) pos += 1;
    if (isNegative(p.effectA)) neg += 1;
    if (isNegative(p.effectB)) neg += 1;
    if (p.type === 'mutualism') mut += 1;
    if (p.type === 'parasitism') par += 1;
    sumAbs += Math.abs(p.effectA) + Math.abs(p.effectB);
  }

  const denom = Math.max(1, pos + neg);
  const balance = (pos - neg) / denom; // [-1,1]
  const mutualismShare = total ? mut / total : 0;
  const parasitismShare = total ? par / total : 0;
  const meanEffect = total ? sumAbs / (total * 2) : 0;
  const maxEdges = agentsCount > 1 ? (agentsCount * (agentsCount - 1)) / 2 : 1;
  const density = clamp(total / maxEdges, 0, 1);

  // Здоровье: симбиоз тянет вверх, паразитизм/конкуренция — вниз.
  const raw = 0.5 + 0.5 * balance + 0.25 * (mutualismShare - parasitismShare);
  const health = Number(clamp(raw, 0, 1).toFixed(4));

  return {
    health,
    balance: Number(balance.toFixed(4)),
    mutualism: Number(mutualismShare.toFixed(4)),
    parasitism: Number(parasitismShare.toFixed(4)),
    density: Number(density.toFixed(4)),
    meanEffect: Number(meanEffect.toFixed(4)),
  };
}

/** Буквенная оценка по health. */
function gradeOf(health) {
  const h = num(health);
  if (h >= 0.85) return 'A';
  if (h >= 0.7) return 'B';
  if (h >= 0.55) return 'C';
  if (h >= 0.4) return 'D';
  return 'F';
}

/** Вердикт по индексам. */
function verdictOf(indices) {
  const health = indices.health;
  const grade = gradeOf(health);
  let status;
  if (health >= 0.7) status = 'симбиотическая сеть устойчива';
  else if (health >= 0.5) status = 'сеть сбалансирована с очагами паразитизма';
  else if (health >= 0.4) status = 'паразитизм преобладает над симбиозом';
  else status = 'сеть деградирует (доминируют эксплуатация и конкуренция)';
  return { health, grade, status };
}

// ───────────────────────────────────────────────────────────────────────────
// ЭКЗЕМПЛЯР
// ───────────────────────────────────────────────────────────────────────────

/**
 * createMycologistSymbiosis(config)
 * @param {object} config
 * @param {Array}  config.agents        — узлы мицелия (id | {id})
 * @param {Array}  config.interactions  — трофические связи
 */
function createMycologistSymbiosis(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const agents = Array.isArray(cfg.agents) ? cfg.agents : [];
  const interactions = Array.isArray(cfg.interactions) ? cfg.interactions : [];

  const agentIds = agents.map(idOf);

  /** Подсчитать counts по типам взаимодействия. */
  function countTypes(pairs) {
    const counts = {};
    for (const t of TYPES) counts[t] = 0;
    for (const p of pairs) counts[p.type] = (counts[p.type] || 0) + 1;
    return counts;
  }

  /** Доминирующий тип по counts (с приоритетом при равенстве). */
  function dominantType(counts) {
    let best = 'neutralism';
    let bestCount = -1;
    for (const t of TYPES) {
      const c = counts[t] || 0;
      if (c > bestCount || (c === bestCount && TYPE_PRIORITY[t] < TYPE_PRIORITY[best])) {
        best = t;
        bestCount = c;
      }
    }
    return bestCount <= 0 ? 'neutralism' : best;
  }

  /** Основной метод анализа. */
  function analyze() {
    const pairs = buildPairs(interactions);
    const counts = countTypes(pairs);
    const indices = computeIndices(pairs, agentIds.length || inferAgents(pairs).length);
    const verdict = verdictOf(indices);
    const network = buildNetwork(agentIds, pairs);

    return {
      ok: true,
      analyzedPairs: pairs.length,
      agents: agentIds.length ? agentIds.slice() : inferAgents(pairs),
      counts,
      dominantType: dominantType(counts),
      indices,
      verdict,
      pairs,
      network,
    };
  }

  /** Самопроверка инвариантов. */
  function verify() {
    const checks = [];
    const r = analyze();
    checks.push({ name: 'analyze.ok', pass: r.ok === true });
    checks.push({ name: 'pairs>=0', pass: Number.isInteger(r.analyzedPairs) && r.analyzedPairs >= 0 });
    checks.push({ name: 'health in [0,1]', pass: r.indices.health >= 0 && r.indices.health <= 1 });
    checks.push({ name: 'grade valid', pass: 'ABCDF'.indexOf(r.verdict.grade) >= 0 });
    checks.push({ name: 'classify(+,-)=parasitism', pass: classify(1, -1) === 'parasitism' });
    checks.push({ name: 'classify(+,+)=mutualism', pass: classify(1, 1) === 'mutualism' });
    checks.push({ name: 'classify(-,-)=competition', pass: classify(-1, -1) === 'competition' });
    return { ok: checks.every((c) => c.pass), checks };
  }

  /** ASCII-отчёт для консоли. */
  function render() {
    const r = analyze();
    const lines = [];
    lines.push('╔══════════════════════════════════════════════════════════╗');
    lines.push('║  MYCOLOGIST SYMBIOSIS — карта трофических связей         ║');
    lines.push('╠══════════════════════════════════════════════════════════╣');
    lines.push(`║  узлов: ${pad(agentIds.length || r.agents.length, 3)}   связей: ${pad(r.analyzedPairs, 3)}   доминант: ${pad(r.dominantType, 13)} ║`);
    lines.push(`║  health=${pad(r.indices.health, 5)}  grade=${pad(r.verdict.grade, 2)}  balance=${pad(r.indices.balance, 6)}          ║`);
    lines.push(`║  ${r.verdict.status}`);
    lines.push('╚══════════════════════════════════════════════════════════╝');
    for (const t of TYPES) {
      const c = r.counts[t] || 0;
      lines.push(`  ${LABELS[t].padEnd(22, ' ')} ${String(c).padStart(4)}  ${bar(c, r.analyzedPairs)}`);
    }
    lines.push('  ────────────────────────────────────────────────────────');
    for (const p of r.pairs) {
      lines.push(`  ${p.a} ⇄ ${p.b}  ${p.type.padEnd(13)} (${signLabel(p.effectA)}/${signLabel(p.effectB)})`);
    }
    return lines.join('\n');
  }

  return { analyze, verify, render, classify, TYPES, LABELS };
}

// ───────────────────────────────────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНОЕ ДЛЯ СЕТИ
// ───────────────────────────────────────────────────────────────────────────

/** Вывести список агентов из пар, если агенты не заданы. */
function inferAgents(pairs) {
  const set = new Set();
  for (const p of pairs) {
    set.add(p.a);
    set.add(p.b);
  }
  return Array.from(set);
}

/** Построить degree-map сети (кто с кем и как связан). */
function buildNetwork(agentIds, pairs) {
  const nodes = new Map();
  for (const id of agentIds) {
    nodes.set(id, { id, degree: 0, symbionts: [], parasites: [], rivals: [] });
  }
  for (const p of pairs) {
    if (!nodes.has(p.a)) nodes.set(p.a, { id: p.a, degree: 0, symbionts: [], parasites: [], rivals: [] });
    if (!nodes.has(p.b)) nodes.set(p.b, { id: p.b, degree: 0, symbionts: [], parasites: [], rivals: [] });
    const A = nodes.get(p.a);
    const B = nodes.get(p.b);
    A.degree += 1;
    B.degree += 1;
    if (p.type === 'mutualism') {
      A.symbionts.push(p.b);
      B.symbionts.push(p.a);
    } else if (p.type === 'parasitism') {
      // Паразит — тот, у кого положительный эффект.
      if (p.effectA > 0) {
        A.parasites.push(p.b);
        B.rivals.push(p.a);
      } else {
        B.parasites.push(p.a);
        A.rivals.push(p.b);
      }
    } else if (p.type === 'competition') {
      A.rivals.push(p.b);
      B.rivals.push(p.a);
    }
  }
  return Array.from(nodes.values());
}

/** pad — безопасное дополнение строки. */
function pad(v, w) {
  return String(v).padEnd(w, ' ');
}

/** Текстовый бар для отчёта. */
function bar(count, total) {
  const width = 20;
  if (!total) return '░'.repeat(width);
  const filled = Math.round(clamp(count / total, 0, 1) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ───────────────────────────────────────────────────────────────────────────
// STANDALONE API
// ───────────────────────────────────────────────────────────────────────────

/** analyze(config) — короткая форма. */
function analyze(config) {
  return createMycologistSymbiosis(config).analyze();
}

// ───────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ
// ───────────────────────────────────────────────────────────────────────────

module.exports = {
  createMycologistSymbiosis,
  analyze,
  classify,
  sign,
  signLabel,
  buildPairs,
  buildNetwork,
  computeIndices,
  gradeOf,
  verdictOf,
  normalizeEffect,
  describe,
  TYPES,
  LABELS,
  SIGNS,
  EPS,
};
