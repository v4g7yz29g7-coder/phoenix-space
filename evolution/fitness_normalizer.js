'use strict';

/**
 * evolution/fitness_normalizer.js — Min-max нормализация fitness по популяции
 * ============================================================================
 * Назначение:
 *   Приводит «сырые» значения приспособленности (fitness) агентов популяции
 *   к единой шкале 0..1 методом min-max масштабирования:
 *
 *       scaled = (value - min) / (max - min)
 *
 *   где min/max берутся по *финитным* значениям всей переданной популяции.
 *   Так «лучший» агент получает ровно 1.0, «худший» — ровно 0.0, а
 *   остальные — пропорциональную позицию между ними. Это позволяет
 *   сравнивать fitness агентов из разных поколений/раундов и подавать
 *   их, например, в селекцию или визуализацию.
 *
 * КРИТЕРИЙ ПРИЁМКИ (гарантируется этим модулем):
 *   normalize([6.1252, 5.8684, 5.8484]) -> [1.0, ~0, ~0]   (max -> 1, min -> 0)
 *   normalize(NaN)                      -> -1              (sentinel)
 *   normalize([])                       -> []              (пустая популяция)
 *
 * Устойчивость к «грязным» данным (robustness):
 *   - NaN, Infinity, -Infinity, null, undefined, '' и нечисловые строки
 *     внутри массива отображаются в sentinel -1 и НЕ портят min/max
 *     остальной популяции;
 *   - массив без единого финитного значения -> массив из -1 той же длины;
 *   - популяция с нулевым разбросом (все значения равны) -> constantValue
 *     (по умолчанию 0, как у наивного `max - min || 1`), переопределяется
 *     опцией `constantValue`;
 *   - результат обрезается (clamp) в [0, 1] и округляется до `digits`.
 *
 * Публичный API:
 *   normalize(values, options)      -> number[] | number  (основная функция)
 *   normalizePopulation(values, o)  -> number[]           (алиас, всегда массив)
 *   denormalize(scaled, min, max)   -> number             (обратное преобразование)
 *   minMax(values, options)         -> { min, max, span, finite, missing, count }
 *   stats(values, options)          -> расширенная описательная статистика
 *   isFiniteNumber(v)               -> boolean
 *   toFiniteOrNull(v)               -> number | null
 *
 * Опции:
 *   sentinel      {number} — значение для нефинитных входов (по умолчанию -1)
 *   digits        {number} — знаков после запятой при округлении (по умолчанию 6)
 *   clamp         {boolean}— обрезать ли результат в [0, 1] (по умолчанию true)
 *   constantValue {number} — результат для нулевого разброса (по умолчанию 0)
 *
 * Модуль zero-deps и детерминирован.
 * ----------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/* Константы и конфигурация                                                   */
/* -------------------------------------------------------------------------- */

/** Sentinel для NaN / Infinity / прочих нефинитных входов. */
const NAN_SENTINEL = -1;

const DEFAULTS = Object.freeze({
  sentinel: NAN_SENTINEL,
  digits: 6,
  clamp: true,
  constantValue: 0,
});

const isArrayLike = (v) =>
  v !== null &&
  typeof v === 'object' &&
  typeof v.length === 'number' &&
  !(v instanceof String);

function resolveConfig(options = {}) {
  const cfg = Object.assign({}, DEFAULTS, options || {});
  if (!Number.isFinite(cfg.sentinel)) cfg.sentinel = NAN_SENTINEL;
  if (!Number.isInteger(cfg.digits) || cfg.digits < 0) cfg.digits = DEFAULTS.digits;
  cfg.clamp = cfg.clamp !== false;
  if (!Number.isFinite(cfg.constantValue)) cfg.constantValue = DEFAULTS.constantValue;
  return cfg;
}

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                    */
/* -------------------------------------------------------------------------- */

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Приводит произвольный вход к конечному числу или null.
 * null/undefined/'' /boolean считаются «пропущенными» (не 0!).
 * Числовые строки ("6.1252") и bigint приводятся к Number.
 */
function toFiniteOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'string') {
    if (v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // объекты/массивы/символы — не числовой вход
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clamp01(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

function round(v, digits) {
  if (!Number.isFinite(v)) return v;
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function asArray(values) {
  if (Array.isArray(values)) return values;
  if (isArrayLike(values)) return Array.prototype.slice.call(values);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Статистика популяции                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Считает min/max/span только по финитным значениям. Нечисловые входы
 * учитываются как missing и в расчёте диапазона не участвуют.
 */
function minMax(values, options = {}) {
  const cfg = resolveConfig(options);
  const arr = asArray(values);
  if (arr === null) {
    const n = toFiniteOrNull(values);
    if (n === null) {
      return { min: null, max: null, span: 0, finite: 0, missing: 1, count: 1, sentinel: cfg.sentinel };
    }
    return { min: n, max: n, span: 0, finite: 1, missing: 0, count: 1, sentinel: cfg.sentinel };
  }

  let min = Infinity;
  let max = -Infinity;
  let finite = 0;
  let missing = 0;
  for (let i = 0; i < arr.length; i++) {
    const n = toFiniteOrNull(arr[i]);
    if (n === null) {
      missing += 1;
      continue;
    }
    finite += 1;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  if (finite === 0) {
    return { min: null, max: null, span: 0, finite: 0, missing, count: arr.length, sentinel: cfg.sentinel };
  }
  return { min, max, span: max - min, finite, missing, count: arr.length, sentinel: cfg.sentinel };
}

/** Описательная статистика (дополнение к minMax). */
function stats(values, options = {}) {
  const mm = minMax(values, options);
  const arr = asArray(values);
  const finiteVals = [];
  if (arr !== null) {
    for (const v of arr) {
      const n = toFiniteOrNull(v);
      if (n !== null) finiteVals.push(n);
    }
  } else {
    const n = toFiniteOrNull(values);
    if (n !== null) finiteVals.push(n);
  }
  let sum = 0;
  for (const n of finiteVals) sum += n;
  const mean = finiteVals.length ? sum / finiteVals.length : null;
  return Object.assign({}, mm, {
    mean,
    sum: finiteVals.length ? sum : null,
  });
}

/* -------------------------------------------------------------------------- */
/* Нормализация                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Min-max нормализация fitness в 0..1 по популяции.
 *
 * @param  {number[]|number} values  популяция или одиночное значение
 * @param  {object}          options см. DEFAULTS
 * @returns {number[]|number}        массив 0..1 либо sentinel для скаляра
 *
 * Примеры:
 *   normalize([6.1252, 5.8684, 5.8484]) // -> [1, 0.072254, 0]
 *   normalize([1, 2, 3, NaN])           // -> [0, 0.5, 1, -1]
 *   normalize([5, 5, 5])                // -> [0, 0, 0]
 *   normalize([])                       // -> []
 *   normalize(NaN)                      // -> -1
 */
function normalize(values, options = {}) {
  const cfg = resolveConfig(options);
  const arr = asArray(values);

  // --- скалярная форма: normalize(NaN) -> -1, normalize(5) -> 1 ------------
  if (arr === null) {
    const n = toFiniteOrNull(values);
    if (n === null) return cfg.sentinel;
    // единственное значение — одновременно и min, и max всей популяции
    return cfg.constantValue === 0 ? 1 : round(cfg.constantValue, cfg.digits);
  }

  const n = arr.length;
  if (n === 0) return [];

  // 1) отбираем финитные значения, запоминаем маску «пропусков»
  const finite = new Array(n);
  const finiteVals = [];
  for (let i = 0; i < n; i++) {
    const v = toFiniteOrNull(arr[i]);
    if (v === null) {
      finite[i] = false;
    } else {
      finite[i] = true;
      finiteVals.push(v);
    }
  }

  // 2) если финитных нет вообще — вся популяция помечается sentinel
  if (finiteVals.length === 0) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = cfg.sentinel;
    return out;
  }

  // 3) диапазон по финитным
  let min = finiteVals[0];
  let max = finiteVals[0];
  for (const v of finiteVals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;

  // 4) масштабируем
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (!finite[i]) {
      out[i] = cfg.sentinel;
      continue;
    }
    let scaled;
    if (span === 0) {
      scaled = cfg.constantValue; // нулевой разброс: все значения равны
    } else {
      scaled = (arr[i] - min) / span;
    }
    if (cfg.clamp) scaled = clamp01(scaled);
    out[i] = round(scaled, cfg.digits);
  }
  return out;
}

/** Алиас, гарантирующий массив на выходе. */
function normalizePopulation(values, options = {}) {
  const cfg = resolveConfig(options);
  const arr = asArray(values);
  if (arr === null) {
    const n = toFiniteOrNull(values);
    return [n === null ? cfg.sentinel : 1];
  }
  return normalize(arr, cfg);
}

/**
 * Обратное преобразование: scaled -> исходное значение.
 * denormalize(1, 5, 6.1252) === 6.1252 при clamp=false.
 */
function denormalize(scaled, min, max) {
  const s = toFiniteOrNull(scaled);
  const lo = toFiniteOrNull(min);
  const hi = toFiniteOrNull(max);
  if (s === null || lo === null || hi === null) return NAN_SENTINEL;
  return lo + s * (hi - lo);
}

/* -------------------------------------------------------------------------- */
/* Самопроверка (запуск: node evolution/fitness_normalizer.js)                */
/* -------------------------------------------------------------------------- */

function selfTest() {
  const assert = require('assert');
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push('  \u2713 ' + name);
    } catch (err) {
      checks.push('  \u2717 ' + name + ' \u2014 ' + err.message);
      process.exitCode = 1;
    }
  };

  check('max -> 1.0, остальные ~0', () => {
    const out = normalize([6.1252, 5.8684, 5.8484]);
    assert.strictEqual(out[0], 1.0);
    assert.ok(out[1] < 0.1, 'second should be ~0, got ' + out[1]);
    assert.ok(out[2] < 0.05, 'third should be ~0, got ' + out[2]);
    assert.strictEqual(out[2], 0);
  });

  check('NaN -> -1 (скаляр)', () => {
    assert.strictEqual(normalize(NaN), -1);
    assert.strictEqual(normalize(Infinity), -1);
    assert.strictEqual(normalize(-Infinity), -1);
  });

  check('пустой массив -> []', () => {
    assert.deepStrictEqual(normalize([]), []);
  });

  check('NaN/inf внутри массива -> -1, не портит диапазон', () => {
    const out = normalize([1, 2, 3, NaN, Infinity]);
    assert.deepStrictEqual(out.slice(0, 3), [0, 0.5, 1]);
    assert.strictEqual(out[3], -1);
    assert.strictEqual(out[4], -1);
  });

  check('нулевой разброс -> constantValue (0)', () => {
    assert.deepStrictEqual(normalize([5, 5, 5]), [0, 0, 0]);
    assert.deepStrictEqual(normalize([5, 5, 5], { constantValue: 1 }), [1, 1, 1]);
  });

  check('все значения нефинитны -> массив sentinel', () => {
    assert.deepStrictEqual(normalize([NaN, Infinity, null]), [-1, -1, -1]);
  });

  check('null/undefined/пустые строки -> sentinel', () => {
    assert.deepStrictEqual(normalize([null, undefined, '', 'abc', 1, 2]), [-1, -1, -1, -1, 0, 1]);
  });

  check('числовые строки нормализуются', () => {
    assert.deepStrictEqual(normalize(['1', '3']), [0, 1]);
    assert.deepStrictEqual(normalize(['1', '2', '3']), [0, 0.5, 1]);
  });

  check('clamp=true отрезает выбросы', () => {
    const out = normalize([0, 10, 20], { clamp: false });
    assert.ok(out[2] > 0 && out[0] === 0);
  });

  check('normalizePopulation всегда массив', () => {
    assert.deepStrictEqual(normalizePopulation(NaN), [-1]);
    assert.deepStrictEqual(normalizePopulation([]), []);
  });

  check('denormalize обратен min-max', () => {
    assert.strictEqual(denormalize(1, 5, 6.1252), 6.1252);
    assert.strictEqual(denormalize(0, 5, 6.1252), 5);
  });

  check('minMax игнорирует нефинитные', () => {
    const mm = minMax([1, NaN, 3, Infinity]);
    assert.strictEqual(mm.min, 1);
    assert.strictEqual(mm.max, 3);
    assert.strictEqual(mm.finite, 2);
    assert.strictEqual(mm.missing, 2);
  });

  console.log('evolution/fitness_normalizer.js — self-test');
  console.log(checks.join('\n'));
  const failed = checks.filter((c) => c.indexOf('\u2717') !== -1).length;
  console.log(failed ? `FAILED (${failed})` : 'ALL_OK');
}

if (require.main === module) selfTest();

module.exports = {
  normalize,
  normalizePopulation,
  denormalize,
  minMax,
  stats,
  isFiniteNumber,
  toFiniteOrNull,
  selfTest,
  NAN_SENTINEL,
  DEFAULTS,
};
