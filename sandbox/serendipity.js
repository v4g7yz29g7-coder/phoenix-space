'use strict';

/**
 * ============================================================================
 * sandbox/serendipity.js — случайные находки (serendipity engine).
 * ============================================================================
 *
 * «Серендипность» — способность находить ценное случайно, не ища его.
 * Модуль бросает «кости» по нескольким независимым осям (редкость, домен,
 * форма, контекст) и синтезирует из комбинации осей осмысленную находку.
 *
 * Публичный API:  roll()
 *
 *   const s = require('./sandbox/serendipity');
 *   s.roll()                 -> одна находка (объект)
 *   s.roll(n)                -> массив из n находок
 *   s.roll(options)          -> одна находка с фильтрами
 *   s.roll(n, options)       -> массив из n находок с фильтрами
 *   s.rollMany(n, options)   -> то же, что roll(n, options)
 *   s.rollUnique(n, options) -> n РАЗНЫХ находок (без повторов)
 *   s.rollChain(n, options)  -> цепочка; у каждой есть поле "because"
 *   s.register(entry)        -> добавить собственную находку в корпус
 *   s.stats()                -> снимок статистики движка
 *   s.tags()                 -> отсортированный список тегов
 *   s.totalValue(finds)      -> суммарная ценность набора
 *   s.best(finds)            -> лучшая находка по valueScore
 *
 * Опции (options):
 *   seed       number|string  — зерно для воспроизводимости (детерминизм)
 *   rng        () => [0,1)    — внешний ГПСЧ (приоритетнее seed)
 *   tag        string         — оставить находки с этим тегом
 *   tags       string[]       — находка должна иметь ВСЕ перечисленные теги
 *   rarity     number 1..5    — ровно эта редкость
 *   minRarity  number 1..5    — нижняя граница редкости
 *   maxRarity  number 1..5    — верхняя граница редкости
 *   luck       number 0..1    — смещает выбор к более редким находкам
 *
 * Модуль чистый (без внешних зависимостей) и детерминирован при передаче
 * seed или внешнего rng. Прямой запуск:
 *
 *   node sandbox/serendipity.js [n] [seed]
 */

// ---------------------------------------------------------------------------
// 1. Детерминированный ГПСЧ (mulberry32) + стабильный хэш.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Стабильный 32-битный хэш строки (FNV-1a). */
function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Глобальный источник случайности; переключается на PRNG при seed/rng.
let RNG = Math.random;

function setSeed(seed) {
  if (seed === undefined || seed === null) {
    RNG = Math.random;
    return;
  }
  RNG = mulberry32(hash32(String(seed)) ^ (Number(seed) >>> 0));
}

// ---------------------------------------------------------------------------
// 2. Словари осей. Каждая ось — независимый источник случайности.
// ---------------------------------------------------------------------------

const FORMS = [
  'аналогия', 'парадокс', 'инверсия', 'метафора', 'граничный случай',
  'контрпример', 'изоморфизм', 'эмерджентность', 'резонанс', 'фрактал',
];

const CONTEXTS = [
  'в шуме', 'на пределе', 'при охлаждении', 'в темноте', 'на рассвете',
  'во сне', 'в спешке', 'в тишине', 'на перекрёстке', 'в тумане',
];

// Редкость: level 1..5, вес для взвешенного выбора и базовая ценность.
const RARITY_TIERS = Object.freeze([
  { level: 1, label: 'обычная', weight: 60, value: 1 },
  { level: 2, label: 'интересная', weight: 30, value: 3 },
  { level: 3, label: 'редкая', weight: 14, value: 8 },
  { level: 4, label: 'очень редкая', weight: 5, value: 21 },
  { level: 5, label: 'уникальная', weight: 1, value: 55 },
]);

const MIN_RARITY = 1;
const MAX_RARITY = 5;

const HOOKS = [
  'Соедини %A с %B через %F — может проявиться скрытый порядок.',
  'А если %A %C окажется не багом, а сигналом?',
  'Похоже, %F связывает %A и %B сильнее, чем мы думали.',
  '%C %A ведёт себя как %B: стоит проверить масштаб.',
  'Инверсия: вместо %A попробуй %B — %F подскажет направление.',
  'Наблюдение: %A %C даёт тот же %F, что и %B.',
  'Гипотеза: %F объясняет, почему %A и %B неожиданно совпали.',
];

// ---------------------------------------------------------------------------
// 3. Встроенный корпус находок.
// ---------------------------------------------------------------------------

function entry(text, tags, rarity) {
  return Object.freeze({
    id: 'b-' + hash32(text).toString(16),
    text,
    tags: Object.freeze(tags.slice()),
    rarity,
    source: 'builtin',
  });
}

const CORPUS = [
  entry('Случайная пауза перед сложным решением повышает качество выбора.',
    ['idea', 'psychology'], 2),
  entry('Ошибка округления во float может породить целую научную статью.',
    ['code', 'math'], 3),
  entry('Два независимых модуля с общим форматом данных — уже архитектура.',
    ['code', 'architecture'], 2),
  entry('Шум в данных иногда несёт больше сигнала, чем тренд.',
    ['science', 'data'], 3),
  entry('Полезный баг — это баг, который кто-то успел задокументировать.',
    ['code', 'humor'], 1),
  entry('Общий предок двух далёких алгоритмов: оба — частный случай жадности.',
    ['math', 'algorithm', 'code'], 4),
  entry('Симметрия задачи часто подсказывает, где искать решение.',
    ['math', 'philosophy'], 3),
  entry('Чем проще API, тем сложнее его внутренняя реализация — и наоборот.',
    ['code', 'design'], 2),
  entry('Неожиданная аналогия музыки и цвета: обе раскладываются в спектр.',
    ['art', 'music', 'science'], 4),
  entry('В природе нет «мусора»: любой отход кому-то сырьё.',
    ['nature', 'philosophy'], 3),
  entry('Редчайший инвариант: сохраняется при всех известных преобразованиях.',
    ['math', 'science'], 5),
  entry('Код, который легко удалить, обычно хорошо написан.',
    ['code', 'design'], 2),
  entry('Правило 80/20 в логах: 20% строк объясняют 80% инцидентов.',
    ['data', 'ops', 'code'], 2),
  entry('Случайная мутация в геноме оказалась полезнее запланированной.',
    ['nature', 'evolution'], 4),
  entry('Две ветки истории сошлись в одной идее независимо.',
    ['history', 'science'], 5),
  entry('Сон перерабатывает случайные впечатления в устойчивые схемы.',
    ['psychology', 'nature'], 3),
  entry('Хорошая метрика меняет поведение наблюдателя.',
    ['data', 'philosophy'], 3),
  entry('Танец — это распределённый алгоритм согласования ритма.',
    ['art', 'music', 'algorithm'], 4),
  entry('Иногда лучший тест — это отсутствие теста и здравый смысл.',
    ['code', 'humor'], 1),
  entry('Красота доказательства часто указывает на его истинность.',
    ['math', 'philosophy'], 4),
  entry('Повторение — мать учения, но враг DRY.',
    ['code', 'humor'], 1),
  entry('Звёздная пыль в нас — следствие термоядерного синтеза.',
    ['science', 'nature'], 3),
  entry('Утечка памяти может быть метафорой незакрытого гештальта.',
    ['code', 'psychology'], 4),
  entry('Сумма противоположностей постоянна — это про инвариант.',
    ['math', 'philosophy'], 5),
  entry('Случайное блуждание с bias почти всегда куда-то да приведёт.',
    ['math', 'data'], 1),
  entry('Лучший интерфейс тот, о котором не приходится думать.',
    ['design', 'psychology'], 2),
  entry('Паттерн на трёх несвязанных уровнях стоит изучить.',
    ['data', 'science'], 4),
  entry('Ошибка в одном месте часто маскирует здоровье в другом.',
    ['code', 'ops'], 3),
  entry('Найден предел, за которым хаос становится регулярным.',
    ['math', 'chaos'], 5),
  entry('Эвристика, рождённая из опечатки, ускорила сборку вдвое.',
    ['code', 'performance'], 2),
  entry('Два снаряда одного эксперимента дали согласованный сдвиг.',
    ['science', 'data'], 4),
  entry('Имя переменной может быть лучшим комментарием.',
    ['code', 'design'], 1),
];

// ---------------------------------------------------------------------------
// 4. Статистика и реестр.
// ---------------------------------------------------------------------------

const STATS = {
  total: CORPUS.length,
  rolls: 0,
  byRarity: Object.create(null),
};

/** Взвешенный выбор уровня редкости с учётом luck. */
function chooseRarity(luck) {
  const bias = Math.min(1, Math.max(0, Number(luck) || 0));
  const weights = RARITY_TIERS.map((t) => {
    // luck сдвигает вес от обычных к уникальным экспоненциально.
    const shift = Math.pow(2, (t.level - 3) * bias * 2);
    return Math.max(0.0001, t.weight * shift);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = RNG() * total;
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) return RARITY_TIERS[i].level;
    r -= weights[i];
  }
  return 1;
}

function pick(arr) {
  return arr[Math.floor(RNG() * arr.length)];
}

function applyTemplate(hook, a, b, f, c) {
  return hook
    .replace(/%A/g, a)
    .replace(/%B/g, b)
    .replace(/%F/g, f)
    .replace(/%C/g, c);
}

/** Собирает одну находку из осей случайности. */
function compose(base, luck) {
  const tier = RARITY_TIERS[chooseRarity(luck) - 1];
  const form = pick(FORMS);
  const context = pick(CONTEXTS);
  const hook = pick(HOOKS);
  const a = base ? base.text.replace(/^[А-ЯЁ]/, (m) => m.toLowerCase()) : pick(HOOKS);
  const b = pick(CONTEXTS);
  const text = base
    ? applyTemplate(hook, a, b, form, context) + ' [' + tier.label + '] ' + base.text
    : applyTemplate(hook, 'явление', b, form, context);

  const tags = new Set(base ? base.tags : []);
  tags.add(form);
  tags.add(tier.label);
  tags.add('r' + tier.level);

  const valueScore = tier.value * (1 + (hash32(text) % 97) / 100);

  return {
    id: 'f-' + hash32(text + '|' + tier.level).toString(16),
    signature: hash32(text + '|' + tier.level).toString(36),
    text,
    tags: Array.from(tags),
    rarity: tier.level,
    rarityLabel: tier.label,
    form,
    context,
    valueScore: Number(valueScore.toFixed(3)),
    source: base ? base.source : 'synthetic',
  };
}

/** Проверяет соответствие находки фильтрам. */
function matches(find, opts) {
  if (!find) return false;
  const o = opts || {};
  if (o.tag && !find.tags.includes(o.tag)) return false;
  if (Array.isArray(o.tags) && o.tags.length &&
      !o.tags.every((t) => find.tags.includes(t))) return false;
  if (typeof o.rarity === 'number' && find.rarity !== o.rarity) return false;
  if (typeof o.minRarity === 'number' && find.rarity < o.minRarity) return false;
  if (typeof o.maxRarity === 'number' && find.rarity > o.maxRarity) return false;
  return true;
}

/** Генерирует находку, удовлетворяющую фильтрам (или null после попыток). */
function rollOne(opts) {
  const o = opts || {};
  const luck = Number.isFinite(o.luck) ? o.luck : 0;
  const attempts = 400;
  for (let i = 0; i < attempts; i++) {
    const base = CORPUS[Math.floor(RNG() * CORPUS.length)];
    const find = compose(RNG() < 0.35 ? base : null, luck);
    STATS.rolls++;
    if (matches(find, o)) {
      STATS.byRarity[find.rarity] = (STATS.byRarity[find.rarity] || 0) + 1;
      return find;
    }
  }
  return null;
}

function resolveRng(opts) {
  const o = opts || {};
  if (typeof o.rng === 'function') {
    RNG = o.rng;
  } else if (o.seed !== undefined) {
    setSeed(o.seed);
  }
}

// ---------------------------------------------------------------------------
// 5. Публичный API.
// ---------------------------------------------------------------------------

function roll(countOrOptions, maybeOptions) {
  let count = 1;
  let opts = maybeOptions || {};
  if (typeof countOrOptions === 'number') {
    count = Math.max(1, Math.floor(countOrOptions));
  } else if (countOrOptions && typeof countOrOptions === 'object') {
    opts = countOrOptions;
    if (typeof opts.count === 'number') count = Math.max(1, Math.floor(opts.count));
  }
  resolveRng(opts);

  const out = [];
  for (let i = 0; i < count; i++) out.push(rollOne(opts));

  if (count === 1 && typeof countOrOptions !== 'number') return out[0];
  return out;
}

function rollMany(n, opts) {
  return roll(Math.max(1, Math.floor(n) || 1), opts);
}

function rollUnique(n, opts) {
  const want = Math.max(1, Math.floor(n) || 1);
  resolveRng(opts);
  const seen = new Set();
  const out = [];
  const maxAttempts = want * 500 + 2000;
  for (let i = 0; i < maxAttempts && out.length < want; i++) {
    const f = rollOne(opts);
    if (f && !seen.has(f.signature)) {
      seen.add(f.signature);
      out.push(f);
    }
  }
  return out;
}

function rollChain(n, opts) {
  const want = Math.max(1, Math.floor(n) || 1);
  const list = rollUnique(want, opts);
  return list.map((f, i) => Object.assign({}, f, {
    because: i === 0 ? null : list[i - 1].text,
    depth: i,
  }));
}

function register(item) {
  if (!item || typeof item.text !== 'string' || !item.text.trim()) return null;
  const rarity = Math.min(MAX_RARITY, Math.max(MIN_RARITY,
    Math.floor(Number(item.rarity) || 1)));
  const tags = Array.isArray(item.tags) && item.tags.length
    ? item.tags.slice()
    : ['custom'];
  const e = entry(item.text, tags, rarity);
  CORPUS.push(e);
  STATS.total = CORPUS.length;
  return e;
}

function stats() {
  return {
    total: CORPUS.length,
    rolls: STATS.rolls,
    byRarity: Object.assign({}, STATS.byRarity),
    tags: tags().length,
  };
}

function tags() {
  const set = new Set();
  for (const e of CORPUS) for (const t of e.tags) set.add(t);
  return Array.from(set).sort();
}

function totalValue(finds) {
  const list = Array.isArray(finds) ? finds : [finds];
  return list.reduce((sum, f) => sum + (f && Number(f.valueScore) || 0), 0);
}

function best(finds) {
  const list = (Array.isArray(finds) ? finds : [finds]).filter(Boolean);
  if (!list.length) return null;
  return list.reduce((a, b) => (b.valueScore > a.valueScore ? b : a));
}

module.exports = {
  roll,
  rollMany,
  rollUnique,
  rollChain,
  register,
  stats,
  tags,
  totalValue,
  best,
  // служебные словари — для тестов и расширений
  FORMS,
  CONTEXTS,
  RARITY_TIERS,
  HOOKS,
  CORPUS,
  mulberry32,
  hash32,
};

// ---------------------------------------------------------------------------
// 6. Прямой запуск: node sandbox/serendipity.js [n] [seed]
// ---------------------------------------------------------------------------

if (require.main === module) {
  const n = parseInt(process.argv[2], 10) || 3;
  const seed = process.argv[3] !== undefined ? process.argv[3] : 1;
  const finds = roll(n, { seed });
  console.log('serendipity: ' + n + ' находок, seed=' + seed);
  for (const f of finds) {
    console.log('  [' + f.rarityLabel + ' r' + f.rarity + '] ' + f.text);
  }
  console.log('ценность: ' + totalValue(finds).toFixed(3));
}
