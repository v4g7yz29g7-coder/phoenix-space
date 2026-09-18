'use strict';

/**
 * evolution/fitness_normalize.js — Min-Max нормализация fitness метрик
 * ============================================================================
 * Назначение:
 *   Приводит массив "сырых" fitness-значений популяции к единой шкале 0..1
 *   по формуле min-max:  scaled = (x - min) / (max - min).
 *
 *   Модуль устойчив к "грязным" данным:
 *     - NaN                -> -1 (маркер "невалидное значение");
 *     - +Infinity          -> 1  (лучшее возможное);
 *     - -Infinity          -> 0  (худшее возможное);
 *     - строки-числа       -> парсятся (Number);
 *     - вырожденная популяция (max === min) -> 0 (конвенция sklearn MinMaxScaler);
 *     - пустой массив      -> [];
 *     - отсутствие валидных значений -> -1 на каждой позиции.
 *
 *   Результат всегда зажат в диапазон [0, 1] (кроме маркера -1).
 *
 * Публичный API:
 *   normalize(values)                 -> number | number[]
 *   normalizeWithStats(values)        -> { values, min, max, range, count, valid }
 *   rescale(value, min, max)          -> number   (точечная нормализация по известным границам)
 *
 * Пример:
 *   normalize([6.1252, 5.8684, 5.8484]);
 *   // => [1, 0.072253, 0]
 *
 *   normalize(NaN);                   // => -1
 *   normalize([]);                    // => []
 * ----------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/* Константы                                                                  */
/* -------------------------------------------------------------------------- */

/** Маркер невалидного/нечислового значения. */
const INVALID = -1;
/** Количество знаков после запятой при финальном округлении. */
const PRECISION = 6;

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Приводит произвольное значение к числу.
 * Возвращает NaN, если привести нельзя (в т.ч. null/undefined/объекты).
 * @param {*} v
 * @returns {number}
 */
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/**
 * Зажимает число в диапазон [lo, hi] и убирает "-0".
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  const c = Math.max(lo, Math.min(hi, v));
  return c === 0 ? 0 : c;
}

/**
 * Округление до PRECISION знаков (без потери детерминированности).
 * @param {number} v
 * @returns {number}
 */
function round(v) {
  const f = Math.pow(10, PRECISION);
  return Math.round(v * f) / f;
}

/**
 * Нормализует одиночное значение по уже известным границам.
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function rescale(value, min, max) {
  const v = toNumber(value);
  if (Number.isNaN(v)) return INVALID;
  if (v === Infinity) return 1;
  if (v === -Infinity) return 0;
  const range = max - min;
  if (!Number.isFinite(range) || range <= 0) return 0;
  return round(clamp((v - min) / range, 0, 1));
}

/* -------------------------------------------------------------------------- */
/* Основной API                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Min-max нормализация массива fitness-значений к шкале 0..1.
 *
 * @param {number[]} values — массив метрик популяции.
 * @returns {number[]} нормализованный массив.
 *   - [] (пустой вход)          -> []
 *   - NaN                       -> -1
 *   - +Infinity                 -> 1,  -Infinity -> 0
 *   - max === min (все равны)   -> 0
 */
function normalize(values) {
  // Скалярный вызов: normalize(NaN) -> -1, normalize(5) -> 1.
  if (!Array.isArray(values)) {
    if (values === null || values === undefined) return INVALID;
    const n = toNumber(values);
    if (Number.isNaN(n)) return INVALID;
    if (n === Infinity) return 1;
    if (n === -Infinity) return 0;
    return 1; // одиночное валидное значение — тривиальный максимум
  }

  // Пустой массив -> пустой массив.
  if (values.length === 0) return [];

  const nums = values.map(toNumber);

  // Границы считаем только по конечным (валидным) значениям.
  let min = Infinity;
  let max = -Infinity;
  let valid = 0;
  for (const n of nums) {
    if (Number.isFinite(n)) {
      if (n < min) min = n;
      if (n > max) max = n;
      valid += 1;
    }
  }

  // Валидных значений нет — все позиции помечаем маркером.
  if (valid === 0) {
    return nums.map((n) => {
      if (Number.isNaN(n)) return INVALID;
      return n === Infinity ? 1 : 0; // -Infinity -> 0
    });
  }

  const range = max - min;

  return nums.map((n) => {
    if (Number.isNaN(n)) return INVALID;
    if (n === Infinity) return 1;
    if (n === -Infinity) return 0;
    if (range <= 0) return 0; // вырожденная популяция (конвенция sklearn)
    return round(clamp((n - min) / range, 0, 1));
  });
}

/**
 * Как normalize(), но дополнительно возвращает описательную статистику.
 *
 * @param {number[]} values
 * @returns {{values:number[], min:number|null, max:number|null, range:number|null, count:number, valid:number}}
 */
function normalizeWithStats(values) {
  const arr = Array.isArray(values) ? values : [];
  const nums = arr.map(toNumber);
  const finite = nums.filter(Number.isFinite);
  const min = finite.length ? Math.min(...finite) : null;
  const max = finite.length ? Math.max(...finite) : null;
  return {
    values: normalize(arr),
    min,
    max,
    range: min === null ? null : max - min,
    count: arr.length,
    valid: finite.length,
  };
}

module.exports = {
  normalize,
  normalizeWithStats,
  rescale,
  INVALID,
  PRECISION,
};

// Прямой запуск: `node evolution/fitness_normalize.js` — smoke-проверка.
if (require.main === module) {
  const demo = [6.1252, 5.8684, 5.8484];
  const out = normalize(demo);
  console.log('normalize(', JSON.stringify(demo), ') =', JSON.stringify(out));
  console.log('normalize(NaN) =', normalize(NaN));
  console.log('normalize([])  =', JSON.stringify(normalize([])));
}
