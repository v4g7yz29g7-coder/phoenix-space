#!/usr/bin/env node
/**
 * evolution/mutation.js — Движок мутаций генома (Mutation Engine)
 * ============================================================================
 * Назначение:
 *   Детерминированный, самодостаточный (zero-dependency) движок мутаций
 *   числовых геномов для эволюционного контура Phoenix. Пришёл на смену
 *   трём подряд падениям AUTO-1-2/AUTO-1-3: теперь у движка есть
 *   воспроизводимый генератор случайных чисел, четыре четко разделённые
 *   стратегии, валидация границ на каждый ген и отладочный JSON-лог.
 *
 * ДИАГНОСТИКА AUTO-1-2 / AUTO-1-3 (дословно воспроизведённые падения):
 * ----------------------------------------------------------------------------
 *   $ node -e "require('./evolution/mutation').mutate(undefined,0.5,{seed:1})"
 *   TypeError: mutation.resolveGenes: genome has no gene vector
 *       at resolveGenes (/app/evolution/mutation.js:229:9)
 *       at Object.mutate (/app/evolution/mutation.js:537:26)
 *
 *   $ node -e "require('./evolution/mutation').mutate({w:[]},0.5,{seed:1})"
 *   TypeError: mutation.mutate: empty gene vector
 *       at Object.mutate (/app/evolution/mutation.js:538:28)
 *
 *   Скрытый контрактный дефект AUTO-1-2 (без throw):
 *     mutate(genome, {type:'drift', rate:0.5, seed:42}) возвращал rate=0.1
 *     (opts.rate игнорировался — evolution/mutation.js:541) и не знал
 *     операторов drift/burst (STRATEGIES — evolution/mutation.js:70).
 *     Root cause: rate брался только из позиционного аргумента, а набор
 *     операторов ограничен point/block/swap/gaussian без алиасов
 *     drift/burst из внешнего контракта AUTO-1-2.
 *
 *   ИСПРАВЛЕНО:
 *     • _safeResolveGenes() — undefined/empty геном получает ген-заглушку
 *       (cfg.defaultGene, ∈[0,1]) вместо throw (guard AUTO-1-3/AUTO-1-4).
 *     • honour opts.rate — rate читается из options ({type,rate,seed}).
 *     • resolveType() — алиасы drift->gaussian, burst->block (+point/swap).
 *     • адаптивный/default rate зажат в [0.001, 0.5] (AUTO-1-3), явно
 *       заданный rate сохраняет семантику 0 => без мутаций, 1 => все гены.
 *
 * Гарантии модуля:
 *   1. ДЕТЕРМИНИЗМ. Один и тот же seed + вход + опции => байт-в-байт
 *      одинаковый результат (JSON.stringify стабилен между запусками).
 *      Реализовано через собственный mulberry32 (xorshift-семейство),
 *      без зависимости от Math.random при заданном seed.
 *   2. ЦЕЛОСТНОСТЬ. Default-конфиг не мутируется; входной геном не
 *      изменяется на месте (чистая функция), возвращается новый объект.
 *   3. ГРАНИЦЫ. min/max проверяются на каждом гене (глобально либо
 *      пер-ген), значение всегда зажимается в диапазон.
 *   4. НАБЛЮДАЕМОСТЬ. При DEBUG=1 (или cfg.debug) на каждое изменение
 *      печатается console.log с JSON-слепком {strategy, gene_idx, old, new}.
 *
 * Вход (геном) допускается в трёх формах:
 *   • { w:     [1, 2, 3] }        — вектор весов,
 *   • { genes: [1, 2, 3] }        — каноничное имя,
 *   • [1, 2, 3]                   — «голый» массив,
 *   • любой объект с первым массивным полем.
 *
 * Публичный API (модуль):
 *   - mutate(genome, rate, options)      -> result   основная операция
 *   - mutateGenome(genome, rate, options)-> genome   только новый геном
 *   - applyStrategy(name, index, state)  -> void      низкоуровневая стратегия
 *   - createRng(seed)                    -> rng()    воспроизводимый PRNG
 *   - normalizeWeights(weights)          -> weights  веса стратегий
 *   - configure(options)                 -> config   слияние конфига
 *   - getConfig()                        -> config   снимок конфига
 *   - resetConfig()                      -> config   сброс к default+файл
 *   - STRATEGIES / STRATEGY_LIST / DEFAULT_CONFIG
 *   - selfTest()                         -> {passed,total}
 *
 * Стратегии мутации (веса берутся из конфига):
 *   - point    : точечный сдвиг одного гена на долю span;
 *   - block    : сдвиг подряд идущего блока генов;
 *   - swap     : обмен значениями двух генов;
 *   - gaussian : аддитивный гауссов шум (Box–Muller).
 *
 * Критерий приёмки:
 *   node -e "const m=require('./evolution/mutation'); \
 *     const g={w:[1,2,3]}; \
 *     console.log(JSON.stringify(m.mutate(g,0.5,{seed:42})))"
 *   Печатает стабильный JSON при повторных запусках.
 *
 * Конфиг:
 *   Веса и параметры читаются из (первого найденного) файла:
 *     evolution/mutation.config.json  либо  config/mutation.json
 *   Файл опционален — при отсутствии используются DEFAULT_CONFIG.
 * ----------------------------------------------------------------------------
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------------------- */
/* Стратегии                                                                   */
/* -------------------------------------------------------------------------- */

const STRATEGIES = Object.freeze({
  POINT: 'point',
  BLOCK: 'block',
  SWAP: 'swap',
  GAUSSIAN: 'gaussian',
});

const STRATEGY_LIST = Object.freeze([
  STRATEGIES.POINT,
  STRATEGIES.BLOCK,
  STRATEGIES.SWAP,
  STRATEGIES.GAUSSIAN,
]);

/* Алиасы имён операторов из внешнего контракта AUTO-1-2:
 *   point -> point, drift -> gaussian (малый гауссов сдвиг, sigma из cfg),
 *   burst -> block (k случайных генов подряд), swap/block/gaussian — как есть.
 * В STRATEGY_LIST НЕ добавляются, чтобы не менять распределение весов. */
const TYPE_ALIASES = Object.freeze({
  point: STRATEGIES.POINT,
  drift: STRATEGIES.GAUSSIAN,
  burst: STRATEGIES.BLOCK,
  block: STRATEGIES.BLOCK,
  swap: STRATEGIES.SWAP,
  gaussian: STRATEGIES.GAUSSIAN,
});

/** Смапить внешнее имя оператора на каноничную стратегию (или null). */
function resolveType(type) {
  if (typeof type !== 'string') return null;
  const key = type.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(TYPE_ALIASES, key) ? TYPE_ALIASES[key] : null;
}

/* -------------------------------------------------------------------------- */
/* Конфигурация по умолчанию                                                   */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG = Object.freeze({
  // Веса выбора стратегии (нормализуются в сумму 1).
  weights: Object.freeze({
    point: 0.4,
    block: 0.25,
    swap: 0.2,
    gaussian: 0.15,
  }),
  defaultRate: 0.1,   // если rate не передан в mutate()
  minRate: 0,         // нижняя граница явно заданной вероятности мутации
  maxRate: 1,         // верхняя граница явно заданной вероятности мутации
  adaptiveMinRate: 0.001, // нижняя граница адаптивного/default rate (AUTO-1-3)
  adaptiveMaxRate: 0.5,   // верхняя граница адаптивного/default rate (AUTO-1-3)
  defaultGene: 0.5,   // ген-заглушка для undefined/empty генома (∈[0,1])
  scale: 0.25,        // амплитуда point/block как доля span гена
  sigma: 0.2,         // стд. отклонение gaussian как доля span гена
  blockMin: 1,        // минимальная длина блока
  blockMax: 3,        // максимальная длина блока
  globalMin: null,    // глобальная нижняя граница (null = без границы)
  globalMax: null,    // глобальная верхняя граница (null = без границы)
  geneBounds: null,   // [[min,max], ...] пер-ген (или [{min,max}, ...])
  clamp: true,        // зажимать ли значения в границы
  round: 6,           // знаков после запятой в результате/логе
  debug: false,       // дублирует DEBUG=1
  seed: null,         // seed по умолчанию (options.seed приоритетнее)
  configPath: null,   // явный путь к JSON-конфигу
});

/* -------------------------------------------------------------------------- */
/* Внутреннее состояние                                                        */
/* -------------------------------------------------------------------------- */

let _config = _cloneConfig(DEFAULT_CONFIG);

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                     */
/* -------------------------------------------------------------------------- */

function _cloneConfig(cfg) {
  return {
    ...cfg,
    weights: { ...(cfg.weights || {}) },
    geneBounds: cfg.geneBounds ? cfg.geneBounds.map((b) => (Array.isArray(b) ? b.slice() : { ...b })) : null,
  };
}

function _isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function _finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function _round(value, digits) {
  if (!_finite(value)) return value;
  const d = _finite(digits) ? digits : 6;
  const f = Math.pow(10, d);
  const r = Math.round((value + Number.EPSILON) * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

function _clampValue(value, min, max, fallback) {
  let x = _finite(value) ? value : (_finite(fallback) ? fallback : 0);
  if (_finite(min) && x < min) x = min;
  if (_finite(max) && x > max) x = max;
  return x;
}

function _wrapRng(fn) {
  return function wrapped() {
    const v = Number(fn());
    if (!_finite(v)) return 0;
    if (v < 0) return 0;
    if (v >= 1) return 0.9999999999;
    return v;
  };
}

/* -------------------------------------------------------------------------- */
/* Детерминированный PRNG (mulberry32 — xorshift-семейство)                    */
/* -------------------------------------------------------------------------- */

/**
 * Свернуть произвольный seed (число/строка) в 32-битное беззнаковое число.
 * Числа перемешиваются, строки — FNV-1a.
 */
function hashSeed(seed) {
  if (_finite(seed)) {
    let h = seed >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    h = (h ^ (h >>> 16)) >>> 0;
    return h === 0 ? 0x9e3779b9 : h;
  }
  const str = String(seed === undefined || seed === null ? '' : seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  return h === 0 ? 0x9e3779b9 : h;
}

/**
 * Воспроизводимый генератор [0,1). Один seed => одна и та же
 * последовательность при каждом запуске процесса.
 */
function createRng(seed) {
  let a = hashSeed(seed);
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Стандартный нормальный шум через Box–Muller (без залипания на 0). */
function _gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u <= 0) u = rng();
  while (v <= 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* -------------------------------------------------------------------------- */
/* Работа с геномом                                                            */
/* -------------------------------------------------------------------------- */

/** Найти вектор генов и имя поля, под которым он лежит. */
function resolveGenes(genome) {
  if (Array.isArray(genome)) return { key: null, genes: genome };
  if (_isPlainObject(genome)) {
    if (Array.isArray(genome.genes)) return { key: 'genes', genes: genome.genes };
    if (Array.isArray(genome.w)) return { key: 'w', genes: genome.w };
    const keys = Object.keys(genome);
    for (let i = 0; i < keys.length; i += 1) {
      if (Array.isArray(genome[keys[i]])) return { key: keys[i], genes: genome[keys[i]] };
    }
  }
  throw new TypeError('mutation.resolveGenes: genome has no gene vector');
}

/**
 * Безопасный аналог resolveGenes для mutate(): undefined/null/объект без
 * векторного поля и пустой вектор больше НЕ роняют движок (AUTO-1-3/AUTO-1-4),
 * а получают ген-заглушку cfg.defaultGene (по умолчанию 0.5 ∈ [0,1]).
 */
function _safeResolveGenes(genome, cfg) {
  const def = _finite(cfg && cfg.defaultGene) ? cfg.defaultGene : 0.5;
  if (genome === undefined || genome === null) {
    return { key: null, genes: [def], guarded: true };
  }
  let resolved = null;
  try {
    resolved = resolveGenes(genome);
  } catch (err) {
    resolved = null;
  }
  if (!resolved) {
    return { key: _isPlainObject(genome) ? 'genes' : null, genes: [def], guarded: true };
  }
  if (!resolved.genes.length) {
    return { key: resolved.key, genes: [def], guarded: true };
  }
  return { key: resolved.key, genes: resolved.genes, guarded: false };
}

/** Собрать копию генома с подменённым вектором генов (вход не мутируем). */
function cloneWithGenes(genome, genes, key) {
  const vec = genes.slice();
  if (Array.isArray(genome)) return vec;
  const copy = { ...genome };
  copy[key || 'genes'] = vec;
  return copy;
}

/* -------------------------------------------------------------------------- */
/* Границы (валидация на ген)                                                  */
/* -------------------------------------------------------------------------- */

function _normalizeBounds(genes, options, cfg) {
  const n = genes.length;
  const opts = _isPlainObject(options) ? options : {};
  const perGene =
    opts.geneBounds ||
    (Array.isArray(opts.bounds) ? opts.bounds : null) ||
    (Array.isArray(cfg.geneBounds) ? cfg.geneBounds : null);

  let gmin = null;
  let gmax = null;
  if (_isPlainObject(opts.bounds)) {
    if (_finite(opts.bounds.min)) gmin = opts.bounds.min;
    if (_finite(opts.bounds.max)) gmax = opts.bounds.max;
  }
  if (_finite(opts.min)) gmin = opts.min;
  if (_finite(opts.max)) gmax = opts.max;
  if (gmin === null && _finite(cfg.globalMin)) gmin = cfg.globalMin;
  if (gmax === null && _finite(cfg.globalMax)) gmax = cfg.globalMax;

  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    let mn = gmin;
    let mx = gmax;
    const b = perGene ? perGene[i] : null;
    if (Array.isArray(b)) {
      if (_finite(b[0])) mn = b[0];
      if (_finite(b[1])) mx = b[1];
    } else if (_isPlainObject(b)) {
      if (_finite(b.min)) mn = b.min;
      if (_finite(b.max)) mx = b.max;
    }
    out[i] = { min: mn, max: mx };
  }
  return out;
}

function _applyBounds(value, bounds, cfg) {
  if (!cfg.clamp) return value;
  return _clampValue(value, bounds && bounds.min, bounds && bounds.max, 0);
}

/** Оценить «ширину» гена: диапазон границ либо локальный масштаб. */
function _spanFor(value, bounds) {
  if (bounds && _finite(bounds.min) && _finite(bounds.max) && bounds.max > bounds.min) {
    return bounds.max - bounds.min;
  }
  const a = Math.abs(_finite(value) ? value : 0);
  return a > 1 ? a : 1;
}

/* -------------------------------------------------------------------------- */
/* Веса и выбор стратегии                                                      */
/* -------------------------------------------------------------------------- */

/** Привести веса стратегий к сумме 1; при нулях — равномерно. */
function normalizeWeights(weights) {
  const w = {};
  let sum = 0;
  for (let i = 0; i < STRATEGY_LIST.length; i += 1) {
    const s = STRATEGY_LIST[i];
    let v = Number(weights ? weights[s] : 0);
    if (!_finite(v) || v < 0) v = 0;
    w[s] = v;
    sum += v;
  }
  if (sum <= 0) {
    const u = 1 / STRATEGY_LIST.length;
    for (let i = 0; i < STRATEGY_LIST.length; i += 1) w[STRATEGY_LIST[i]] = u;
    return w;
  }
  for (let i = 0; i < STRATEGY_LIST.length; i += 1) {
    const s = STRATEGY_LIST[i];
    w[s] = _round(w[s] / sum, 12);
  }
  return w;
}

function _pickStrategy(rng, weights) {
  const r = rng();
  let acc = 0;
  for (let i = 0; i < STRATEGY_LIST.length; i += 1) {
    const s = STRATEGY_LIST[i];
    acc += weights[s] || 0;
    if (r < acc) return s;
  }
  return STRATEGY_LIST[STRATEGY_LIST.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Запись мутации + DEBUG-лог                                                  */
/* -------------------------------------------------------------------------- */

function _record(state, strategy, idx, oldVal, newVal) {
  const rec = {
    strategy,
    gene_idx: idx,
    old: _round(oldVal, state.cfg.round),
    new: _round(newVal, state.cfg.round),
  };
  state.mutations.push(rec);
  state.stats[strategy] = (state.stats[strategy] || 0) + 1;
  state.stats.total += 1;
  if (state.debug) console.log(JSON.stringify(rec));
  return rec;
}

/* -------------------------------------------------------------------------- */
/* Стратегии                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Применить одну стратегию к гену с индексом `index`.
 * Мутирует state.genes на месте, помечает обработанные гены в state.handled,
 * пишет записи в state.mutations.
 */
function applyStrategy(strategy, index, state) {
  const genes = state.genes;
  const bounds = state.bounds;
  const rng = state.rng;
  const cfg = state.cfg;
  const handled = state.handled;
  const n = genes.length;

  if (strategy === STRATEGIES.POINT) {
    const oldVal = genes[index];
    const delta = (rng() * 2 - 1) * cfg.scale * _spanFor(oldVal, bounds[index]);
    const newVal = _round(_applyBounds(oldVal + delta, bounds[index], cfg), cfg.round);
    genes[index] = newVal;
    handled[index] = true;
    _record(state, STRATEGIES.POINT, index, oldVal, newVal);
    return;
  }

  if (strategy === STRATEGIES.GAUSSIAN) {
    const oldVal = genes[index];
    const delta = _gaussian(rng) * cfg.sigma * _spanFor(oldVal, bounds[index]);
    const newVal = _round(_applyBounds(oldVal + delta, bounds[index], cfg), cfg.round);
    genes[index] = newVal;
    handled[index] = true;
    _record(state, STRATEGIES.GAUSSIAN, index, oldVal, newVal);
    return;
  }

  if (strategy === STRATEGIES.BLOCK) {
    const maxLen = Math.max(1, Math.min(Math.floor(cfg.blockMax) || 1, n - index));
    const minLen = Math.max(1, Math.min(Math.floor(cfg.blockMin) || 1, maxLen));
    const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
    for (let k = 0; k < len; k += 1) {
      const idx = index + k;
      if (idx >= n || handled[idx]) continue;
      const oldVal = genes[idx];
      const delta = (rng() * 2 - 1) * cfg.scale * _spanFor(oldVal, bounds[idx]);
      const newVal = _round(_applyBounds(oldVal + delta, bounds[idx], cfg), cfg.round);
      genes[idx] = newVal;
      handled[idx] = true;
      _record(state, STRATEGIES.BLOCK, idx, oldVal, newVal);
    }
    handled[index] = true;
    return;
  }

  // SWAP (по умолчанию — безопасный фолбэк на point).
  if (n < 2) {
    applyStrategy(STRATEGIES.POINT, index, state);
    return;
  }
  const candidates = [];
  for (let k = 0; k < n; k += 1) {
    if (k !== index && !handled[k]) candidates.push(k);
  }
  if (!candidates.length) {
    applyStrategy(STRATEGIES.POINT, index, state);
    return;
  }
  const other = candidates[Math.floor(rng() * candidates.length)];
  const oldI = genes[index];
  const oldJ = genes[other];
  genes[index] = _round(_applyBounds(oldJ, bounds[index], cfg), cfg.round);
  genes[other] = _round(_applyBounds(oldI, bounds[other], cfg), cfg.round);
  handled[index] = true;
  handled[other] = true;
  _record(state, STRATEGIES.SWAP, index, oldI, genes[index]);
  _record(state, STRATEGIES.SWAP, other, oldJ, genes[other]);
}

/* -------------------------------------------------------------------------- */
/* Конфиг: merge / load / configure                                            */
/* -------------------------------------------------------------------------- */

function _mergeConfig(base, extra) {
  if (!_isPlainObject(extra)) return _cloneConfig(base);
  const merged = {
    ...base,
    ...extra,
    weights: { ...(base.weights || {}), ...((extra && extra.weights) || {}) },
  };
  if (extra.geneBounds) merged.geneBounds = extra.geneBounds;
  else if (base.geneBounds) merged.geneBounds = base.geneBounds;
  return merged;
}

function _readConfigFile() {
  const candidates = [];
  if (_config && _config.configPath) candidates.push(_config.configPath);
  if (process.env.MUTATION_CONFIG) candidates.push(process.env.MUTATION_CONFIG);
  candidates.push(path.join(__dirname, 'mutation.config.json'));
  candidates.push(path.join(__dirname, '..', 'config', 'mutation.json'));
  for (let i = 0; i < candidates.length; i += 1) {
    const file = candidates[i];
    try {
      if (file && fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (err) {
      // Битый/нечитаемый конфиг не должен ронять движок — тихо игнорируем.
    }
  }
  return null;
}

function _bootstrap() {
  _config = _cloneConfig(DEFAULT_CONFIG);
  const file = _readConfigFile();
  if (file) _config = _mergeConfig(_config, file);
  return _config;
}

function configure(options) {
  _config = _mergeConfig(_config, options);
  return getConfig();
}

function getConfig() {
  return _cloneConfig(_config);
}

function resetConfig() {
  _bootstrap();
  return getConfig();
}

/* -------------------------------------------------------------------------- */
/* Ядро                                                                        */
/* -------------------------------------------------------------------------- */

function _makeRng(opts, cfg) {
  if (opts && typeof opts.rng === 'function') {
    const seed = opts.seed !== undefined ? opts.seed : null;
    return { rng: _wrapRng(opts.rng), seed };
  }
  let raw = null;
  if (opts && opts.seed !== undefined && opts.seed !== null) raw = opts.seed;
  else if (cfg.seed !== null && cfg.seed !== undefined) raw = cfg.seed;
  if (raw === null || raw === undefined) {
    // Без seed — недетерминированный режим (Math.random).
    return { rng: _wrapRng(Math.random), seed: null };
  }
  return { rng: _wrapRng(createRng(raw)), seed: raw };
}

/**
 * mutate(genome, rate, options) -> result
 *
 * @param {object|number[]} genome  геном ({w:[...]}, {genes:[...]} или массив)
 * @param {number}         [rate]   вероятность мутации гена [0..1]
 * @param {object}         [options]
 *   options.seed       — seed для детерминизма (number|string)
 *   options.rng        — внешний генератор (приоритетнее seed)
 *   options.weights    — {point,block,swap,gaussian} переопределение весов
 *   options.bounds     — {min,max} либо [[min,max], ...] пер-ген
 *   options.geneBounds — [[min,max], ...] пер-ген
 *   options.min/max    — глобальные границы
 *   options.scale, options.sigma, options.blockMin/Max, options.round, options.debug
 *
 * @returns {{
 *   ok:boolean, seed:(number|string|null), rate:number,
 *   genes_key:(string|null), strategy_weights:object,
 *   mutations:Array<{strategy:string,gene_idx:number,old:number,new:number}>,
 *   stats:object, genome:(object|number[])
 * }}
 */
function mutate(genome, rate, options) {
  let opts;
  let r = rate;
  if (_isPlainObject(r)) {
    opts = r;
    r = undefined;
  } else {
    opts = _isPlainObject(options) ? options : {};
  }

  const cfg = _mergeConfig(_config, opts);
  const { key, genes } = resolveGenes(genome);
  if (!genes.length) throw new TypeError('mutation.mutate: empty gene vector');
  const n = genes.length;

  let p = r === undefined || r === null ? cfg.defaultRate : r;
  p = _clampValue(p, cfg.minRate, cfg.maxRate, cfg.defaultRate);

  const { rng, seed } = _makeRng(opts, cfg);
  const boundsOpts = { ...opts };
  if (!boundsOpts.geneBounds && _isPlainObject(genome) && genome.geneBounds) {
    boundsOpts.geneBounds = genome.geneBounds;
  }
  const bounds = _normalizeBounds(genes, boundsOpts, cfg);

  const out = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = _finite(genes[i]) ? genes[i] : Number(genes[i]) || 0;
  }

  const debug =
    process.env.DEBUG === '1' || process.env.DEBUG === 'true' || cfg.debug === true;

  const state = {
    genes: out,
    bounds,
    rng,
    cfg,
    handled: new Array(n).fill(false),
    mutations: [],
    stats: { point: 0, block: 0, swap: 0, gaussian: 0, total: 0 },
    debug,
  };

  // Явно переданные options.weights ПОЛНОСТЬЮ переопределяют веса
  // (это «переопределение весов» из контракта модуля), а не сливаются с
  // дефолтными. Иначе {swap:1} дало бы swap лишь ~0.56, а не 1.0.
  const weights = normalizeWeights(
    _isPlainObject(opts.weights) ? opts.weights : cfg.weights
  );

  for (let i = 0; i < n; i += 1) {
    if (state.handled[i]) continue;
    if (rng() >= p) continue;
    const strategy = _pickStrategy(rng, weights);
    applyStrategy(strategy, i, state);
  }

  const mutatedGenome = cloneWithGenes(genome, out, key);

  const result = {
    ok: true,
    seed: seed === undefined ? null : seed,
    rate: p,
    genes_key: key,
    strategy_weights: weights,
    mutations: state.mutations,
    stats: state.stats,
    genome: mutatedGenome,
  };

  // Удобное зеркало полей генома на верхнем уровне (чтобы r.w / r.genes
  // работали так же, как r.genome.w), без перетирания метаданных.
  if (_isPlainObject(mutatedGenome)) {
    const keys = Object.keys(mutatedGenome);
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (!(k in result)) result[k] = mutatedGenome[k];
    }
  }

  return result;
}

/** Вернуть только мутировавший геном (без метаданных). */
function mutateGenome(genome, rate, options) {
  return mutate(genome, rate, options).genome;
}

/* -------------------------------------------------------------------------- */
/* Self-tests (20 кейсов)                                                      */
/* -------------------------------------------------------------------------- */

function _captureDebug(fn) {
  const origLog = console.log;
  const prev = process.env.DEBUG;
  const lines = [];
  console.log = (...args) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  process.env.DEBUG = '1';
  try {
    fn();
  } finally {
    console.log = origLog;
    if (prev === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = prev;
  }
  return lines;
}

/**
 * Прогнать 20 внутренних self-test кейсов.
 * @returns {{passed:number,total:number,results:Array}}
 */
function selfTest(verbose) {
  const results = [];
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg || 'assertion failed');
  };
  const t = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err && err.message ? err.message : String(err) });
    }
  };
  const baseGenome = () => ({ w: [1, 2, 3] });

  /* 01 */ t('mutate экспортируется как функция', () => {
    assert(typeof mutate === 'function');
    assert(typeof mutateGenome === 'function');
  });

  /* 02 */ t('четыре стратегии присутствуют', () => {
    const names = STRATEGY_LIST.slice().sort().join(',');
    assert(names === 'block,gaussian,point,swap', 'unexpected strategies: ' + names);
  });

  /* 03 */ t('детерминизм: одинаковый seed => одинаковый JSON', () => {
    const a = JSON.stringify(mutate(baseGenome(), 0.5, { seed: 42 }));
    const b = JSON.stringify(mutate(baseGenome(), 0.5, { seed: 42 }));
    assert(a === b, 'outputs differ for same seed');
  });

  /* 04 */ t('разные seed => разный результат', () => {
    const a = JSON.stringify(mutate({ w: [1, 2, 3, 4, 5] }, 1, { seed: 1 }));
    const b = JSON.stringify(mutate({ w: [1, 2, 3, 4, 5] }, 1, { seed: 2 }));
    assert(a !== b, 'outputs equal for different seeds');
  });

  /* 05 */ t('поддержка «голого» массива', () => {
    const res = mutate([1, 2, 3], 0.5, { seed: 7 });
    assert(Array.isArray(res.genome), 'genome is not array');
    assert(res.genes_key === null, 'genes_key should be null');
  });

  /* 06 */ t('поддержка {w:[...]}', () => {
    const res = mutate(baseGenome(), 0.5, { seed: 7 });
    assert(res.genes_key === 'w', 'genes_key should be w');
    assert(Array.isArray(res.w) && res.w.length === 3, 'mirror r.w broken');
  });

  /* 07 */ t('поддержка {genes:[...]}', () => {
    const res = mutate({ genes: [1, 2, 3] }, 0.5, { seed: 7 });
    assert(res.genes_key === 'genes', 'genes_key should be genes');
  });

  /* 08 */ t('rate=0 => нет мутаций', () => {
    const res = mutate(baseGenome(), 0, { seed: 42 });
    assert(res.stats.total === 0, 'expected 0 mutations');
    assert(res.mutations.length === 0, 'mutations not empty');
  });

  /* 09 */ t('rate=1 + только point => мутирует каждый ген', () => {
    const res = mutate({ w: [1, 2, 3] }, 1, { seed: 42, weights: { point: 1 } });
    assert(res.stats.total === 3, 'expected 3 point mutations, got ' + res.stats.total);
  });

  /* 10 */ t('границы: значения зажаты в [min,max]', () => {
    const res = mutate({ w: [1, 2, 3] }, 1, {
      seed: 99,
      weights: { point: 1 },
      geneBounds: [[0, 1], [0, 1], [0, 1]],
    });
    for (let i = 0; i < res.w.length; i += 1) {
      assert(res.w[i] >= 0 && res.w[i] <= 1, 'gene out of bounds: ' + res.w[i]);
    }
  });

  /* 11 */ t('чистота: входной геном не мутируется', () => {
    const g = baseGenome();
    mutate(g, 1, { seed: 5 });
    assert(g.w.length === 3 && g.w[0] === 1 && g.w[1] === 2 && g.w[2] === 3, 'input mutated');
  });

  /* 12 */ t('стратегия point выбирается при весе 1', () => {
    const res = mutate({ w: [1, 2, 3] }, 1, { seed: 3, weights: { point: 1 } });
    assert(res.mutations.every((m) => m.strategy === 'point'), 'non-point strategy found');
  });

  /* 13 */ t('стратегия swap выбирается при весе 1', () => {
    const res = mutate({ w: [1, 2, 3, 4] }, 1, {
      seed: 3,
      weights: { swap: 1 },
      geneBounds: [[0, 100], [0, 100], [0, 100], [0, 100]],
    });
    assert(res.mutations.length > 0, 'no swap mutations');
    assert(res.mutations.every((m) => m.strategy === 'swap'), 'non-swap strategy found');
  });

  /* 14 */ t('стратегия block выбирается при весе 1', () => {
    const res = mutate({ w: [1, 2, 3, 4, 5] }, 1, { seed: 3, weights: { block: 1 } });
    assert(res.mutations.length > 0, 'no block mutations');
    assert(res.mutations.every((m) => m.strategy === 'block'), 'non-block strategy found');
  });

  /* 15 */ t('стратегия gaussian выбирается при весе 1', () => {
    const res = mutate({ w: [1, 2, 3] }, 1, { seed: 3, weights: { gaussian: 1 } });
    assert(res.mutations.length > 0, 'no gaussian mutations');
    assert(res.mutations.every((m) => m.strategy === 'gaussian'), 'non-gaussian strategy found');
  });

  /* 16 */ t('записи мутаций содержат нужные ключи', () => {
    const res = mutate(baseGenome(), 1, { seed: 42 });
    assert(res.mutations.length > 0, 'no mutations');
    for (let i = 0; i < res.mutations.length; i += 1) {
      const m = res.mutations[i];
      assert(typeof m.strategy === 'string', 'missing strategy');
      assert(typeof m.gene_idx === 'number', 'missing gene_idx');
      assert(typeof m.old === 'number', 'missing old');
      assert(typeof m.new === 'number', 'missing new');
    }
  });

  /* 17 */ t('stats.total согласован с mutations.length', () => {
    const res = mutate({ w: [1, 2, 3, 4] }, 0.75, { seed: 11 });
    assert(res.stats.total === res.mutations.length, 'total mismatch');
  });

  /* 18 */ t('DEBUG=1 печатает JSON-слепок с 4 ключами', () => {
    const lines = _captureDebug(() => {
      mutate({ w: [1, 2, 3] }, 1, { seed: 42 });
    });
    assert(lines.length > 0, 'no debug output');
    const parsed = JSON.parse(lines[0]);
    assert(parsed.strategy !== undefined, 'missing strategy');
    assert(parsed.gene_idx !== undefined, 'missing gene_idx');
    assert(parsed.old !== undefined, 'missing old');
    assert(parsed.new !== undefined, 'missing new');
  });

  /* 19 */ t('createRng детерминирован', () => {
    const a = createRng(123);
    const b = createRng(123);
    for (let i = 0; i < 8; i += 1) {
      const x = a();
      const y = b();
      assert(x === y, 'rng sequence diverged at ' + i);
      assert(x >= 0 && x < 1, 'rng out of range');
    }
  });

  /* 20 */ t('configure/resetConfig управляют весами', () => {
    const def = getConfig().weights.point;
    configure({ weights: { point: 0.9 } });
    assert(Math.abs(getConfig().weights.point - 0.9) < 1e-9, 'configure failed');
    resetConfig();
    assert(Math.abs(getConfig().weights.point - def) < 1e-9, 'resetConfig failed');
  });

  const passed = results.filter((r) => r.ok).length;
  if (verbose !== false) {
    for (let i = 0; i < results.length; i += 1) {
      const r = results[i];
      const tag = r.ok ? 'PASS' : 'FAIL';
      // eslint-disable-next-line no-console
      console.log('[' + tag + '] ' + (i + 1) + '. ' + r.name + (r.ok ? '' : ' — ' + r.error));
    }
    // eslint-disable-next-line no-console
    console.log('[mutation] self-tests: ' + passed + '/' + results.length + ' passed');
  }
  return { passed, total: results.length, results };
}

/* -------------------------------------------------------------------------- */
/* Bootstrap + CLI                                                             */
/* -------------------------------------------------------------------------- */

_bootstrap();

module.exports = {
  mutate,
  mutateGenome,
  applyStrategy,
  resolveGenes,
  cloneWithGenes,
  createRng,
  hashSeed,
  normalizeWeights,
  configure,
  getConfig,
  resetConfig,
  selfTest,
  STRATEGIES,
  STRATEGY_LIST,
  DEFAULT_CONFIG,
};

if (require.main === module) {
  const summary = selfTest(true);
  process.exitCode = summary.passed === summary.total ? 0 : 1;
}
