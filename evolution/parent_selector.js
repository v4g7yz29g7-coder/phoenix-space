// evolution/parent_selector.js
// ─────────────────────────────────────────────────────────────────────────────
// Parent Selector — выбор родителей для следующего поколения.
//
// Идея: скрещивать двух ЛУЧШИХ агентов — прямой путь к вырождению (инцест
// генома). Поэтому селектор берёт top-N по fitness, а затем жадно выбирает из
// них K родителей, максимизируя РАЗНООБРАЗИЕ (diversity) — чтобы геномы не
// были почти идентичными.
//
// Публичный API:
//     pickParents(options?) -> {
//         parents:   [{ id, fitness, genome, score, diversity, reasons }],
//         strategy:  'top3_diverse',
//         diversity: { pairwiseMin, pairwiseAvg, threshold },
//         poolSize, durationMs, timestamp
//     }
//
// Зависимости: только Node core (fs, path, crypto).
// Режим: чтение-only. Ничего не пишет на диск.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Конфигурация
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.env.PHOENIX_ROOT || path.resolve(__dirname, '..');
const MEMORY_DIR = process.env.MEMORY_DIR || path.join(ROOT, 'memory');
const FITNESS_FILE = process.env.FITNESS_FILE || path.join(MEMORY_DIR, 'fitness.json');
const POPULATION_FILE =
  process.env.POPULATION_FILE || path.join(MEMORY_DIR, 'population.json');
const AGENTS_FILE = process.env.AGENTS_FILE || path.join(MEMORY_DIR, 'agents.json');

// Сколько финалистов берём (по умолчанию 3 — как в задаче).
const DEFAULT_K = Number(process.env.PARENT_K || 3);
// Насколько широкий пул кандидатов держим до диверсификации.
const DEFAULT_POOL = Number(process.env.PARENT_POOL || 12);
// Минимальная нормализованная дистанция между выбранными геномами.
const DEFAULT_MIN_DIVERSITY = Number(process.env.PARENT_MIN_DIVERSITY || 0.25);
// Вес штрафа за слабую fitness при финальном ранжировании.
const FITNESS_WEIGHT = Number(process.env.PARENT_FITNESS_WEIGHT || 0.7);
const DIVERSITY_WEIGHT = Number(process.env.PARENT_DIVERSITY_WEIGHT || 0.3);

const MAX_REASONS = 4;

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────────────────────

function safeReadJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch (_err) {
    return fallback;
  }
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function num(x, def) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function stableHash(obj) {
  let str;
  try {
    str = JSON.stringify(obj);
  } catch (_e) {
    str = String(obj);
  }
  return crypto.createHash('sha1').update(str).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// Загрузка популяции
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Пытаемся собрать список агентов из нескольких источников, чтобы модуль
 * работал и с population.json, и с agents.json, и с fitness.json.
 * @returns {Array<object>}
 */
function loadPopulation() {
  const sources = [POPULATION_FILE, AGENTS_FILE, FITNESS_FILE];

  for (const file of sources) {
    const data = safeReadJSON(file, null);
    if (!data) continue;

    if (Array.isArray(data)) return data;
    if (Array.isArray(data.agents)) return data.agents;
    if (Array.isArray(data.population)) return data.population;

    // fitness.json часто выглядит как { agentId: {fitness, ...} }
    if (typeof data === 'object') {
      const entries = Object.keys(data).map((id) => {
        const v = data[id];
        if (v && typeof v === 'object') return Object.assign({ id }, v);
        return { id, fitness: v };
      });
      if (entries.length) return entries;
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Нормализация и fitness
// ─────────────────────────────────────────────────────────────────────────────

function normalizeAgent(raw, idx) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const id = a.id || a.agentId || a.name || `agent_${idx}`;

  const wins = num(a.wins, num(a.battles, 0) && a.winRate ? 0 : 0);
  const losses = num(a.losses, 0);
  const runs = num(a.runs, wins + losses);

  let fitness = num(a.fitness, NaN);
  if (!Number.isFinite(fitness)) {
    fitness = num(a.score, num(a.elo, 0));
  }

  const genome = a.genome || a.dna || a.promptHash || stableHash({
    id,
    strategy: a.strategy || a.persona || null,
    tags: a.tags || a.skills || null,
  });

  return {
    id: String(id),
    fitness,
    elo: num(a.elo, 0),
    winRate: runs > 0 ? clamp01(num(a.winRate, wins / runs)) : clamp01(num(a.winRate, 0)),
    runs,
    wins,
    losses,
    lineage: a.lineage || a.parents || a.ancestry || null,
    strategy: a.strategy || a.persona || a.role || 'default',
    tags: toStringArray(a.tags || a.skills || a.traits),
    genome,
    raw: a,
  };
}

function toStringArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (v == null) return [];
  return String(v)
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Дистанция / разнообразие
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Нормализованная дистанция между двумя агентами в [0..1].
 * Учитываем: совпадение стратегии, пересечение тегов, lineage-родство,
 * а также хеш генома (если всё совпало — геномы почти идентичны).
 */
function distance(a, b) {
  let d = 0;
  let w = 0;

  // стратегия / роль
  w += 0.35;
  d += 0.35 * (a.strategy === b.strategy ? 0 : 1);

  // теги (Жаккар)
  w += 0.25;
  d += 0.25 * (1 - jaccard(a.tags, b.tags));

  // lineage: общий предок = близкие родственники
  w += 0.2;
  d += 0.2 * (1 - lineageOverlap(a.lineage, b.lineage));

  // геном
  w += 0.2;
  d += 0.2 * genomeDistance(a.genome, b.genome);

  return w > 0 ? clamp01(d / w) : 0;
}

function jaccard(xs, ys) {
  if (!xs.length && !ys.length) return 0; // нет данных -> считаем разными
  const A = new Set(xs);
  const B = new Set(ys);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function lineageOverlap(a, b) {
  const A = toStringArray(a);
  const B = toStringArray(b);
  if (!A.length || !B.length) return 0;
  return jaccard(A, B);
}

function genomeDistance(ga, gb) {
  if (ga == null || gb == null) return 1;
  if (ga === gb) return 0;
  // Если это объекты — сравниваем ключи, иначе строки.
  if (typeof ga === 'object' && typeof gb === 'object') {
    const ka = Object.keys(ga).sort();
    const kb = Object.keys(gb).sort();
    if (ka.join('|') !== kb.join('|')) return 1;
    let diff = 0;
    for (const k of ka) {
      if (String(ga[k]) !== String(gb[k])) diff += 1;
    }
    return ka.length ? diff / ka.length : 1;
  }
  return 0.5;
}

function pairwiseStats(items) {
  if (items.length < 2) return { pairwiseMin: 1, pairwiseAvg: 1 };
  let min = 1;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const d = distance(items[i], items[j]);
      if (d < min) min = d;
      sum += d;
      cnt += 1;
    }
  }
  return { pairwiseMin: min, pairwiseAvg: cnt ? sum / cnt : 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Селекция
// ─────────────────────────────────────────────────────────────────────────────

function fitnessBounds(pool) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of pool) {
    if (a.fitness < lo) lo = a.fitness;
    if (a.fitness > hi) hi = a.fitness;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
  if (hi === lo) return { lo, hi: lo + 1 };
  return { lo, hi };
}

function normFitness(a, bounds) {
  return clamp01((a.fitness - bounds.lo) / (bounds.hi - bounds.lo || 1));
}

/**
 * Возвращает top-N пул по fitness (с учётом winRate как тайбрейкера).
 */
function buildPool(agents, poolSize) {
  const sorted = agents.slice().sort((x, y) => {
    if (y.fitness !== x.fitness) return y.fitness - x.fitness;
    if (y.winRate !== x.winRate) return y.winRate - x.winRate;
    return y.runs - x.runs;
  });
  return sorted.slice(0, Math.max(poolSize, DEFAULT_K));
}

/**
 * Жадный отбор K родителей: берём лучшего по fitness, затем на каждом шаге
 * добавляем кандидата с максимальным combined-score = fitness*wF + diversity*wD,
 * где diversity — минимальная дистанция до уже выбранных.
 */
function greedyDiverseSelect(pool, k, minDiversity) {
  if (!pool.length) return [];
  const bounds = fitnessBounds(pool);

  // 1) Стартуем с самого «здорового».
  const first = pool.reduce((best, a) => (normFitness(a, bounds) > normFitness(best, bounds) ? a : best), pool[0]);
  const chosen = [first];
  const reasons = new Map();
  reasons.set(first.id, ['elite by fitness']);

  const remaining = pool.filter((a) => a.id !== first.id);

  while (chosen.length < Math.min(k, pool.length)) {
    let bestPick = null;
    let bestScore = -Infinity;

    for (const cand of remaining) {
      const f = normFitness(cand, bounds);
      // минимальная дистанция до уже выбранных
      let minDist = 1;
      for (const c of chosen) {
        const d = distance(cand, c);
        if (d < minDist) minDist = d;
      }
      const combined = FITNESS_WEIGHT * f + DIVERSITY_WEIGHT * minDist;
      if (combined > bestScore) {
        bestScore = combined;
        bestPick = { cand, f, minDist };
      }
    }

    if (!bestPick) break;
    const { cand, minDist } = bestPick;

    const why = [];
    if (minDist >= minDiversity) why.push(`diverse (minDist ${minDist.toFixed(2)})`);
    else why.push(`low-diversity fallback (minDist ${minDist.toFixed(2)})`);
    why.push(...topReasons(cand));
    reasons.set(cand.id, why.slice(0, MAX_REASONS));

    chosen.push(cand);
    const idx = remaining.indexOf(cand);
    if (idx >= 0) remaining.splice(idx, 1);
  }

  return chosen.map((a) => ({ agent: a, why: reasons.get(a.id) || [] }));
}

function topReasons(agent) {
  const out = [];
  if (agent.winRate >= 0.6) out.push(`high winRate ${(agent.winRate * 100).toFixed(0)}%`);
  if (agent.runs >= 5) out.push(`proven over ${agent.runs} runs`);
  if (agent.elo) out.push(`elo ${agent.elo}`);
  if (agent.tags.length) out.push(`tags: ${agent.tags.slice(0, 3).join(',')}`);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Публичный API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Выбрать родителей: top-3 с максимальным разнообразием.
 *
 * @param {object} [options]
 * @param {number} [options.k=3]              сколько родителей вернуть
 * @param {number} [options.poolSize]         размер пула до диверсификации
 * @param {number} [options.minDiversity]     порог «достаточно разные»
 * @param {Array}  [options.agents]           явный список агентов
 * @returns {object}
 */
function pickParents(options) {
  const started = Date.now();
  const opts = options || {};
  const k = Math.max(1, num(opts.k, DEFAULT_K));
  const poolSize = Math.max(k, num(opts.poolSize, DEFAULT_POOL));
  const minDiversity = clamp01(num(opts.minDiversity, DEFAULT_MIN_DIVERSITY));

  let rawAgents = opts.agents;
  if (!Array.isArray(rawAgents)) rawAgents = loadPopulation();

  const agents = rawAgents
    .map((a, i) => normalizeAgent(a, i))
    .filter((a) => a && a.id);

  if (!agents.length) {
    return {
      parents: [],
      strategy: 'top3_diverse',
      diversity: { pairwiseMin: 0, pairwiseAvg: 0, threshold: minDiversity },
      poolSize: 0,
      durationMs: Date.now() - started,
      timestamp: new Date().toISOString(),
      warning: 'population is empty',
    };
  }

  const pool = buildPool(agents, poolSize);
  const selected = greedyDiverseSelect(pool, k, minDiversity);
  const pickedAgents = selected.map((s) => s.agent);
  const stats = pairwiseStats(pickedAgents);
  const bounds = fitnessBounds(pool);

  const parents = selected.map((s, i) => ({
    rank: i + 1,
    id: s.agent.id,
    fitness: s.agent.fitness,
    normFitness: Number(normFitness(s.agent, bounds).toFixed(4)),
    winRate: Number(s.agent.winRate.toFixed(4)),
    strategy: s.agent.strategy,
    tags: s.agent.tags,
    genome: typeof s.agent.genome === 'string' ? s.agent.genome.slice(0, 16) : stableHash(s.agent.genome).slice(0, 16),
    diversity: i === 0 ? null : Number(minDistTo(s.agent, pickedAgents.slice(0, i)).toFixed(4)),
    reasons: s.why,
  }));

  return {
    parents,
    strategy: 'top3_diverse',
    diversity: {
      pairwiseMin: Number(stats.pairwiseMin.toFixed(4)),
      pairwiseAvg: Number(stats.pairwiseAvg.toFixed(4)),
      threshold: minDiversity,
      ok: stats.pairwiseMin >= minDiversity,
    },
    poolSize: pool.length,
    candidateCount: agents.length,
    durationMs: Date.now() - started,
    timestamp: new Date().toISOString(),
  };
}

function minDistTo(agent, others) {
  let min = 1;
  for (const o of others) {
    const d = distance(agent, o);
    if (d < min) min = d;
  }
  return min;
}

module.exports = {
  pickParents,
  // низкоуровневые хелперы — полезны для тестов/переиспользования
  _internals: {
    normalizeAgent,
    distance,
    pairwiseStats,
    greedyDiverseSelect,
    buildPool,
    loadPopulation,
  },
};
