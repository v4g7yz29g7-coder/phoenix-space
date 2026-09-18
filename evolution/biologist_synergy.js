'use strict';

/**
 * evolution/biologist_synergy.js
 * ───────────────────────────────────────────────────────────────────────────
 * Симбиоз и антипатия между агентами Phoenix / Aeon.
 *
 * Биологическая метафора: два организма взаимодействуют по нескольким
 * «экологическим» осям (ресурс, защита, конфликт, темп, обмен, выносливость).
 * Вектор агента собирается из его генома-признаков (traits). Совместимость
 * пары считается взвешенной билинейной формой над осями + таблица явных
 * исключений (канонические пары вроде «водоросль ↔ гриб = лишайник»).
 *
 * Публичный API:
 *   synergy(a, b)          -> { a, b, score, kind, axes, notes }
 *   topPairs([n], [list])  -> Array<{ a, b, score, kind }>  (самые совместимые)
 *   antiPairs([n], [list]) -> Array<{ a, b, score, kind }>  (самые конфликтные)
 *
 * Дополнительно: registerAgent, listAgents, allPairs, relationKind,
 * matrix, report, clear, seedDefaultFauna.
 *
 * Автор: evolution / aeon
 */

// ───────────────────────────────────────────────────────────────────────────
// ЭКОЛОГИЧЕСКИЕ ОСИ
// ───────────────────────────────────────────────────────────────────────────

/** Семантические оси профиля. Значения каждого признака нормированы в [0,1]. */
const DIMENSIONS = [
  'resource',  // 0 — производство/добыча ресурса
  'defense',   // 1 — защита, укрытие, устойчивость структуры
  'conflict',  // 2 — агрессия, хищничество, конкуренция
  'tempo',     // 3 — скорость метаболизма/реакции
  'exchange',  // 4 — обмен веществом/информацией
  'tolerance', // 5 — стрессоустойчивость, выносливость
];

/**
 * Матрица взаимодействия осей W[i][j]: как ось i агента A реагирует
 * на ось j агента B. Положительные значения — симбиоз, отрицательные —
 * антипатия. Матрица симметрична.
 */
const AXIS_MATRIX = [
  // resource defense conflict tempo exchange tolerance
  [-0.20,  0.50,  -0.60,  0.20,  0.40,  0.30], // resource
  [ 0.50,  0.10,  -0.30, -0.10,  0.30,  0.50], // defense
  [-0.60, -0.30,  -0.80, -0.20, -0.50, -0.40], // conflict
  [ 0.20, -0.10,  -0.20, -0.10,  0.30,  0.20], // tempo
  [ 0.40,  0.30,  -0.50,  0.30,  0.30,  0.40], // exchange
  [ 0.30,  0.50,  -0.40,  0.20,  0.40,  0.10], // tolerance
];

/** Норма для приведения сырой билинейной формы к диапазону ~[-1,1]. */
const AXIS_NORM = AXIS_MATRIX.reduce(
  (s, row) => s + row.reduce((t, v) => t + Math.abs(v), 0),
  0
);

// ───────────────────────────────────────────────────────────────────────────
// БИБЛИОТЕКА ПРИЗНАКОВ
// ───────────────────────────────────────────────────────────────────────────

/**
 * Каждый признак — вектор по DIMENSIONS. Порядок значений совпадает с
 * порядком DIMENSIONS: [resource, defense, conflict, tempo, exchange, tolerance].
 */
const TRAIT_LIBRARY = {
  photosynthesis: { label: 'фотосинтез',   vector: [0.95, 0.10, 0.00, 0.20, 0.30, 0.40] },
  shade_protect:  { label: 'защита тенью', vector: [0.10, 0.90, 0.00, 0.10, 0.20, 0.60] },
  mycelium:       { label: 'мицелий',      vector: [0.30, 0.30, 0.00, 0.40, 0.95, 0.60] },
  soil_enrich:    { label: 'обогащение',   vector: [0.60, 0.10, 0.00, 0.20, 0.80, 0.50] },
  nutrient_fix:   { label: 'фиксация N',   vector: [0.80, 0.20, 0.00, 0.20, 0.70, 0.60] },
  resilience:     { label: 'выносливость', vector: [0.20, 0.60, 0.00, 0.30, 0.30, 0.95] },
  predation:      { label: 'хищничество',  vector: [0.50, 0.40, 0.95, 0.80, -0.10, 0.30] },
  competitor:     { label: 'конкуренция',  vector: [0.60, 0.30, 0.80, 0.60, -0.20, 0.20] },
  parasitism:     { label: 'паразитизм',   vector: [0.40, 0.20, 0.85, 0.40, -0.40, 0.30] },
  symbiosis:      { label: 'симбиоз',      vector: [0.40, 0.50, 0.00, 0.30, 0.95, 0.60] },
  detox:          { label: 'детоксикация', vector: [0.50, 0.40, 0.00, 0.30, 0.70, 0.70] },
};

/** Уникальные признаки из библиотеки (для валидации). */
const TRAIT_NAMES = Object.keys(TRAIT_LIBRARY);

/**
 * Канонические пары-исключения. Ключ — два признака, отсортированных
 * по алфавиту и соединённых «|». Значение — аддитивный сдвиг к score.
 */
const EXCEPTIONS = {
  'shade_protect|photosynthesis': 0.35, // лишайник: водоросль + гриб
  'mycelium|photosynthesis': 0.30,      // микориза
  'mycelium|nutrient_fix': 0.28,        // микориза бобовых
  'resilience|symbiosis': 0.20,
  'detox|nutrient_fix': 0.22,
  'competitor|predation': -0.45,        // два хищника делят одну нишу
  'parasitism|predation': -0.30,
  'competitor|nutrient_fix': -0.25,
  'mycelium|parasitism': -0.40,
  'detox|parasitism': -0.35,
};

// ───────────────────────────────────────────────────────────────────────────
// РЕЕСТР АГЕНТОВ
// ───────────────────────────────────────────────────────────────────────────

const REGISTRY = new Map();

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function squash(x) {
  return Math.tanh(x);
}

/** Сортированный ключ пары признаков. */
function pairKey(x, y) {
  return [x, y].sort().join('|');
}

/**
 * Возвращает вектор признака по имени.
 * Неизвестный признак трактуется как нейтральный (нулевой).
 */
function traitVector(name) {
  const t = TRAIT_LIBRARY[name];
  if (!t) return [0, 0, 0, 0, 0, 0];
  return t.vector.slice();
}

/**
 * Нормализует список признаков агента в объект { traits: string[] }.
 */
function normalizeTraits(raw) {
  if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string');
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.traits)) return raw.traits.filter((t) => typeof t === 'string');
    // Плоский объект trait -> любое truthy значение.
    return Object.keys(raw).filter((k) => raw[k] && TRAIT_LIBRARY[k]);
  }
  return [];
}

/**
 * Собирает агрегированный вектор агента как нормированную сумму векторов
 * его признаков. Результат — массив длины DIMENSIONS.length.
 */
function vectorize(traits) {
  const out = new Array(DIMENSIONS.length).fill(0);
  const list = Array.isArray(traits) ? traits : normalizeTraits(traits);
  if (list.length === 0) return out;
  for (const name of list) {
    const v = traitVector(name);
    for (let i = 0; i < out.length; i += 1) out[i] += v[i];
  }
  for (let i = 0; i < out.length; i += 1) out[i] /= list.length;
  return out;
}

/**
 * Регистрирует агента по имени. Идемпотентно.
 */
function registerAgent(id, traits, profile) {
  if (!id) throw new Error('registerAgent: id required');
  const norm = normalizeTraits(traits);
  REGISTRY.set(id, {
    id,
    traits: norm,
    profile: profile || {},
    vector: vectorize(norm),
  });
  return REGISTRY.get(id);
}

/**
 * Приводит произвольный вход к записи агента.
 */
function resolveAgent(ref) {
  if (typeof ref === 'string') {
    if (REGISTRY.has(ref)) return REGISTRY.get(ref);
    return {
      id: ref,
      traits: [],
      profile: { unknown: true },
      vector: vectorize([]),
    };
  }
  if (ref && typeof ref === 'object') {
    const id = ref.id || ref.name || 'anonymous';
    const traits = normalizeTraits(ref.traits || ref);
    return {
      id,
      traits,
      profile: ref.profile || ref.meta || {},
      vector: ref.vector ? ref.vector.slice() : vectorize(traits),
    };
  }
  return { id: 'null', traits: [], profile: { unknown: true }, vector: vectorize([]) };
}

function listAgents() {
  return Array.from(REGISTRY.values()).map((r) => ({
    id: r.id,
    traits: r.traits.slice(),
    profile: r.profile,
  }));
}

function clear() {
  REGISTRY.clear();
}

// ───────────────────────────────────────────────────────────────────────────
// МАТЕМАТИКА ВЗАИМОДЕЙСТВИЯ
// ───────────────────────────────────────────────────────────────────────────

/** Взвешенная билинейная форма над осями. */
function bilinear(va, vb) {
  let sum = 0;
  for (let i = 0; i < DIMENSIONS.length; i += 1) {
    for (let j = 0; j < DIMENSIONS.length; j += 1) {
      sum += va[i] * vb[j] * AXIS_MATRIX[i][j];
    }
  }
  return sum / AXIS_NORM;
}

/** Суммирует вклад канонических пар-исключений между двумя геномами. */
function exceptionBonus(traitsA, traitsB) {
  let bonus = 0;
  for (const x of traitsA) {
    for (const y of traitsB) {
      const key = pairKey(x, y);
      if (Object.prototype.hasOwnProperty.call(EXCEPTIONS, key)) {
        bonus += EXCEPTIONS[key];
      }
    }
  }
  return bonus;
}

/** Вклад профилей (size/mobility) — слабая детюнинг-поправка. */
function profileBias(pa, pb) {
  const sizeA = Number(pa && pa.size) || 0;
  const sizeB = Number(pb && pb.size) || 0;
  const mobA = Number(pa && pa.mobility) || 0;
  const mobB = Number(pb && pb.mobility) || 0;
  const sizeDelta = Math.abs(sizeA - sizeB) / 10;
  const mobDelta = Math.abs(mobA - mobB) / 10;
  // Похожий темп — чуть больше совместимости.
  return 0.10 - 0.15 * mobDelta - 0.05 * sizeDelta;
}

/** Косинусная близость геномов (общие признаки сближают). */
function sharedOverlap(traitsA, traitsB) {
  if (traitsA.length === 0 || traitsB.length === 0) return 0;
  const setB = new Set(traitsB);
  let shared = 0;
  for (const t of traitsA) if (setB.has(t)) shared += 1;
  return shared / Math.max(traitsA.length, traitsB.length);
}

/** Классификация взаимодействия по итоговому score. */
function relationKind(score) {
  if (score >= 0.55) return 'mutualism';
  if (score >= 0.25) return 'symbiosis';
  if (score >= 0.05) return 'commensalism';
  if (score > -0.05) return 'neutral';
  if (score > -0.35) return 'competition';
  if (score > -0.65) return 'antagonism';
  return 'antipathy';
}

function describe(kind) {
  switch (kind) {
    case 'mutualism':
      return 'Сильный взаимный симбиоз: агенты усиливают друг друга.';
    case 'symbiosis':
      return 'Симбиоз: устойчивое взаимовыгодное сосуществование.';
    case 'commensalism':
      return 'Комменсализм: односторонняя польза без вреда.';
    case 'neutral':
      return 'Нейтральное сосуществование.';
    case 'competition':
      return 'Конкуренция за общий ресурс.';
    case 'antagonism':
      return 'Антагонизм: совместная работа снижает результат.';
    case 'antipathy':
      return 'Сильная антипатия: совместная работа вредна обоим.';
    default:
      return 'Неопределённое взаимодействие.';
  }
}

/**
 * Полное взаимодействие двух агентов.
 * @returns {{a:string,b:string,score:number,kind:string,axes:Object,notes:string[]}}
 */
function synergy(a, b) {
  const A = resolveAgent(a);
  const B = resolveAgent(b);
  const va = A.vector;
  const vb = B.vector;

  const base = bilinear(va, vb);
  const exc = exceptionBonus(A.traits, B.traits);
  const prof = profileBias(A.profile, B.profile);
  const overlap = sharedOverlap(A.traits, B.traits);

  const score = squash(base * 2.4 + exc + prof + overlap * 0.05);
  const kind = relationKind(score);

  const axes = {};
  for (let i = 0; i < DIMENSIONS.length; i += 1) {
    axes[DIMENSIONS[i]] = Number(((va[i] + vb[i]) / 2).toFixed(4));
  }

  const notes = [];
  if (exc > 0.01) notes.push('Сработала каноническая пара-симбионт.');
  if (exc < -0.01) notes.push('Сработала каноническая конфликтная пара.');
  if (overlap > 0.5) notes.push('Высокая общность генома.');
  if (A.profile && A.profile.unknown) notes.push(`Агент "${A.id}" неизвестен реестру.`);
  if (B.profile && B.profile.unknown) notes.push(`Агент "${B.id}" неизвестен реестру.`);

  return {
    a: A.id,
    b: B.id,
    score: Number(score.toFixed(4)),
    kind,
    axes,
    notes,
  };
}

/**
 * Все пары среди списка агентов.
 */
function allPairs(list) {
  const source = Array.isArray(list) && list.length ? list : Array.from(REGISTRY.values()).concat(demoAgents());
  const seen = new Map();
  // Убираем дубликаты по id.
  for (const item of source) {
    const rec = resolveAgent(item);
    seen.set(rec.id, item);
  }
  const ids = Array.from(seen.keys());
  const out = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      out.push(synergy(seen.get(ids[i]), seen.get(ids[j])));
    }
  }
  return out;
}

/**
 * Разбирает аргументы topPairs/antiPairs: поддерживаются оба порядка
 * (n), (list), (n, list), (list, n).
 */
function parseArgs(first, second, fallbackSize) {
  let n = fallbackSize;
  let list = null;
  for (const arg of [first, second]) {
    if (Array.isArray(arg)) list = arg;
    else if (typeof arg === 'number' && Number.isFinite(arg)) n = arg;
  }
  return { n, list };
}

/**
 * Самые совместимые пары.
 */
function topPairs(first, second) {
  const { n, list } = parseArgs(first, second, 5);
  return allPairs(list)
    .filter((p) => p.score > 0)
    .sort((x, y) => y.score - x.score || x.a.localeCompare(y.a))
    .slice(0, n);
}

/**
 * Самые конфликтные пары.
 */
function antiPairs(first, second) {
  const { n, list } = parseArgs(first, second, 5);
  return allPairs(list)
    .filter((p) => p.score < 0)
    .sort((x, y) => x.score - y.score || x.a.localeCompare(y.a))
    .slice(0, n);
}

/**
 * Симметричная матрица совместимости для списка агентов.
 */
function matrix(list) {
  const source = Array.isArray(list) && list.length ? list : Array.from(REGISTRY.values()).concat(demoAgents());
  const ids = Array.from(new Set(source.map((x) => resolveAgent(x).id)));
  const grid = ids.map(() => new Array(ids.length).fill(1));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const s = synergy(resolveAgent(source.find((x) => resolveAgent(x).id === ids[i])),
        resolveAgent(source.find((x) => resolveAgent(x).id === ids[j]))).score;
      grid[i][j] = s;
      grid[j][i] = s;
    }
  }
  return { ids, grid };
}

/**
 * Текстовый отчёт.
 */
function report(list) {
  const pairs = allPairs(list);
  const avg = pairs.length
    ? pairs.reduce((s, p) => s + p.score, 0) / pairs.length
    : 0;
  return {
    agents: new Set(pairs.flatMap((p) => [p.a, p.b])).size,
    pairs: pairs.length,
    avg: Number(avg.toFixed(4)),
    top: topPairs(3, list),
    anti: antiPairs(3, list),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// ДЕМО-НАСЕЛЕНИЕ
// ───────────────────────────────────────────────────────────────────────────

const DEMO_AGENTS = [
  { id: 'algae',    traits: ['photosynthesis', 'shade_protect'], profile: { size: 1, mobility: 0 } },
  { id: 'fungus',   traits: ['mycelium', 'soil_enrich'],         profile: { size: 2, mobility: 1 } },
  { id: 'legume',   traits: ['nutrient_fix', 'resilience'],      profile: { size: 2, mobility: 1 } },
  { id: 'wolf',     traits: ['predation', 'competitor'],         profile: { size: 5, mobility: 9 } },
  { id: 'fox',      traits: ['predation', 'competitor'],         profile: { size: 4, mobility: 8 } },
  { id: 'mite',     traits: ['parasitism'],                      profile: { size: 1, mobility: 3 } },
  { id: 'lichen',   traits: ['symbiosis', 'resilience'],         profile: { size: 1, mobility: 0 } },
  { id: 'bacteria', traits: ['detox', 'nutrient_fix'],           profile: { size: 1, mobility: 4 } },
];

function demoAgents() {
  return DEMO_AGENTS.map((d) => d);
}

function seedDefaultFauna() {
  for (const d of DEMO_AGENTS) registerAgent(d.id, d.traits, d.profile);
  return listAgents();
}

// ───────────────────────────────────────────────────────────────────────────
// ЭКСПОРТ
// ───────────────────────────────────────────────────────────────────────────

function main() {
  console.log('== biologist_synergy demo ==');
  const rep = report(DEMO_AGENTS);
  console.log('agents=%d pairs=%d avg=%s', rep.agents, rep.pairs, rep.avg);
  console.log('\n-- topPairs --');
  console.log(JSON.stringify(topPairs(3, DEMO_AGENTS), null, 2));
  console.log('\n-- antiPairs --');
  console.log(JSON.stringify(antiPairs(3, DEMO_AGENTS), null, 2));
}

if (require.main === module) {
  seedDefaultFauna();
  main();
}

module.exports = {
  // публичный API
  synergy,
  topPairs,
  antiPairs,
  // расширения
  allPairs,
  matrix,
  report,
  relationKind,
  registerAgent,
  listAgents,
  clear,
  seedDefaultFauna,
  // константы и утилиты
  DIMENSIONS,
  AXIS_MATRIX,
  TRAIT_LIBRARY,
  EXCEPTIONS,
  DEMO_AGENTS,
  normalizeTraits,
  vectorize,
  describe,
};
