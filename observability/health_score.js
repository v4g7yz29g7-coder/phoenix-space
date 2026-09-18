'use strict';

/**
 * observability/health_score.js
 * ============================================================================
 * Единый скор здоровья (health score) 0..1 из пяти компонент снапшота:
 *
 *     { cpu, ram, load, heartbeat, alert_count }
 *
 * Назначение
 * ----------
 * Свернуть разнородные метрики в одно число 0..1, где
 *     1 = всё идеально,
 *     0 = всё плохо.
 * Скор нужен для дашбордов, алертинга и принятия решений (например,
 * "понижать ли агента в правах"), поэтому он должен быть:
 *   - детерминированным (один и тот же снапшот -> один и тот же скор);
 *   - устойчивым к "грязным" данным (NaN / строки / Infinity / мусор);
 *   - объяснимым (возвращает вклад каждой компоненты).
 *
 * Веса (сумма = 1.0):
 *     cpu       0.25
 *     ram       0.25
 *     load      0.20
 *     heartbeat 0.20
 *     alerts    0.10
 *
 * Публичный API
 * -------------
 *   score(snapshot, options) -> {
 *       value,                    // итоговый скор 0..1
 *       parts,                    // { cpu, ram, load, heartbeat, alerts } — здоровье каждой компоненты 0..1
 *       contributions,            // { cpu, ... } — вклад каждой компоненты в value (part * weight)
 *       weights,                  // использованные веса
 *       warnings                  // массив строк с предупреждениями (NaN-вход и т.п.)
 *   }
 *
 *   normalizeParts(snapshot, options) -> parts        // только нормализованные компоненты
 *   WEIGHTS                                          // замороженные веса
 *   DEFAULT_OPTIONS                                  // пороги здорового/нулевого уровня
 *
 * КРИТЕРИЙ (соблюдается):
 *   - сбалансированный (здоровый) снапшот даёт value >= 0.9;
 *   - все компоненты плохие -> value <= 0.1;
 *   - NaN-вход (или отсутствие снапшота) -> value === 0 И warning
 *     (в `warnings`, а также в console.warn, если не отключено);
 *   - value всегда лежит в диапазоне [0, 1];
 *   - score() никогда не бросает исключение.
 *
 * Семантика нормализации (почему не просто 1 - x/100)
 * ---------------------------------------------------
 * "Здоровый" диапазон метрики не начинается сразу у нуля: использование
 * CPU на 30% — это норма, а не потеря 30% здоровья. Поэтому каждая метрика
 * переводится в 0..1 кусочно-линейной функцией с двумя порогами:
 *
 *     health = 1                при value <= healthy
 *     health = 0                при value >= zero
 *     health линейно убывает    между healthy и zero
 *
 * Пороги по умолчанию:
 *     cpu        healthy <= 60   -> 0 при 100 (%)
 *     ram        healthy <= 70   -> 0 при 100 (%)
 *     load       <= 1.0/ядро     -> 0 при 2.0/ядро
 *     heartbeat  свежесть 0..1 (1 = только что), либо возраст в мс -> 0 при TTL=60s
 *     alerts     healthy = 0     -> 0 при 10 алертах
 *
 * @module observability/health_score
 */

const os = require('os');

/* -------------------------------------------------------------------------- */
/* Константы                                                                  */
/* -------------------------------------------------------------------------- */

/** Веса компонент. Сумма ровно 1.0. */
const WEIGHTS = Object.freeze({
  cpu: 0.25,
  ram: 0.25,
  load: 0.2,
  heartbeat: 0.2,
  alerts: 0.1,
});

/** Порядок компонент (используется для детерминированного обхода). */
const COMPONENT_KEYS = Object.freeze(['cpu', 'ram', 'load', 'heartbeat', 'alerts']);

/** Пороги по умолчанию. */
const DEFAULT_OPTIONS = Object.freeze({
  /** CPU: (%) ниже порога — идеально, выше второго — ноль. */
  cpuHealthy: 60,
  cpuZero: 100,
  /** RAM: (%) ниже порога — идеально, выше второго — ноль. */
  ramHealthy: 70,
  ramZero: 100,
  /** LOAD: множитель на ядро. <=1 идеально, >=2 — ноль. */
  loadHealthy: 1.0,
  loadZero: 2.0,
  /** HEARTBEAT: если передан возраст (мс), за TTL свежесть падает до нуля. */
  heartbeatTtlMs: 60 * 1000,
  /** ALERTS: 0 — идеально, >=10 — ноль. */
  alertsHealthy: 0,
  alertsZero: 10,
  /** Количество ядер для нормализации load (null -> os.cpus().length). */
  cores: null,
  /** Писать ли предупреждения в console.warn. */
  warn: true,
  /** Кол-во знаков после запятой в результате. */
  precision: 6,
});

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Округление числа до `digits` знаков (без -0).
 * @param {number} v
 * @param {number} digits
 * @returns {number}
 */
function round(v, digits) {
  if (!Number.isFinite(v)) return 0;
  const f = Math.pow(10, digits);
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * Зажимает значение в [0, 1]. NaN/Infinity приводятся к границам.
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

/**
 * Приводит произвольное значение к конечному числу.
 * Возвращает NaN, если привести нельзя (null/undefined/объект/пустая строка).
 * @param {*} v
 * @returns {number}
 */
function toFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * Кусочно-линейная "функция здоровья": 1 до healthy, 0 после zero.
 *
 * @param {number} value — метрика (чем больше, тем хуже).
 * @param {number} healthy — верхняя граница идеального диапазона.
 * @param {number} zero — граница, за которой здоровье = 0.
 * @returns {number} 0..1 либо NaN, если value не число.
 */
function decayHealth(value, healthy, zero) {
  if (!Number.isFinite(value)) return NaN;
  const lo = Number.isFinite(healthy) ? healthy : 0;
  const hi = Number.isFinite(zero) ? zero : lo + 1;
  if (value <= lo) return 1;
  if (hi <= lo) return value <= lo ? 1 : 0;
  if (value >= hi) return 0;
  return (hi - value) / (hi - lo);
}

/**
 * Здоровье heartbeat.
 *
 * Поддерживаются три формы:
 *   - boolean:  true -> 1, false -> 0;
 *   - 0..1:     готовый показатель свежести (1 = только что бился, 0 = мёртв);
 *   - > 1:      возраст последнего удара в миллисекундах; свежесть линейно
 *               падает с возрастом и достигает 0 на `ttlMs`.
 *
 * @param {*} value
 * @param {number} ttlMs
 * @returns {number} 0..1 либо NaN
 */
function heartbeatHealth(value, ttlMs) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  const n = toFiniteNumber(value);
  if (Number.isNaN(n)) return NaN;
  if (n <= 0) return 0;
  if (n <= 1) return clamp01(n);
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_OPTIONS.heartbeatTtlMs;
  return clamp01(1 - (n - 1) / ttl);
}

/**
 * Резолвит эффективные опции: DEFAULT_OPTIONS + переопределения + ядра.
 * @param {object} [options]
 * @returns {object}
 */
function resolveOptions(options) {
  const o = Object.assign({}, DEFAULT_OPTIONS, options && typeof options === 'object' ? options : {});
  if (!Number.isFinite(o.cores) || o.cores <= 0) {
    let cores = 1;
    try {
      cores = (os.cpus && os.cpus().length) || 1;
    } catch (_err) {
      cores = 1;
    }
    o.cores = cores > 0 ? cores : 1;
  }
  if (!Number.isFinite(o.precision) || o.precision < 0) o.precision = DEFAULT_OPTIONS.precision;
  return o;
}

/* -------------------------------------------------------------------------- */
/* Нормализация компонент                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Считает здоровье каждой компоненты снапшота (0..1).
 * Некорректные (NaN/undefined/нечисловые) компоненты дают 0 и warning.
 *
 * @param {object} snapshot — { cpu, ram, load, heartbeat, alert_count }
 * @param {object} [options]
 * @returns {{parts: object, warnings: string[]}}
 */
function normalizePartsInternal(snapshot, options) {
  const o = resolveOptions(options);
  const warnings = [];
  const raw = snapshot && typeof snapshot === 'object' ? snapshot : {};

  const cpu = toFiniteNumber(raw.cpu);
  const ram = toFiniteNumber(raw.ram);
  const load = toFiniteNumber(raw.load);
  // alert_count — каноничное имя; alerts принимается как синоним.
  const alertCountRaw = raw.alert_count !== undefined ? raw.alert_count : raw.alerts;
  const alertCount = toFiniteNumber(alertCountRaw);

  const parts = {};

  // --- CPU / RAM: доля использования в процентах --------------------------
  parts.cpu = decayHealth(cpu, o.cpuHealthy, o.cpuZero);
  if (Number.isNaN(parts.cpu)) {
    parts.cpu = 0;
    warnings.push('component "cpu" is not a finite number -> treated as 0');
  }

  parts.ram = decayHealth(ram, o.ramHealthy, o.ramZero);
  if (Number.isNaN(parts.ram)) {
    parts.ram = 0;
    warnings.push('component "ram" is not a finite number -> treated as 0');
  }

  // --- LOAD: нормализуем на количество ядер -------------------------------
  if (Number.isNaN(load)) {
    parts.load = 0;
    warnings.push('component "load" is not a finite number -> treated as 0');
  } else {
    const perCore = load / o.cores;
    parts.load = decayHealth(perCore, o.loadHealthy, o.loadZero);
  }

  // --- HEARTBEAT -----------------------------------------------------------
  parts.heartbeat = heartbeatHealth(raw.heartbeat, o.heartbeatTtlMs);
  if (Number.isNaN(parts.heartbeat)) {
    parts.heartbeat = 0;
    warnings.push('component "heartbeat" is not a finite number -> treated as 0');
  }

  // --- ALERTS --------------------------------------------------------------
  if (Number.isNaN(alertCount)) {
    parts.alerts = 0;
    warnings.push('component "alert_count" is not a finite number -> treated as 0');
  } else {
    parts.alerts = decayHealth(alertCount, o.alertsHealthy, o.alertsZero);
  }

  // Финальный зажим + округление (страховка от арифметики с плавающей точкой).
  for (const key of COMPONENT_KEYS) {
    parts[key] = round(clamp01(parts[key]), o.precision);
  }

  return { parts, warnings };
}

/**
 * Публичная нормализация: возвращает только parts.
 * @param {object} snapshot
 * @param {object} [options]
 * @returns {object} { cpu, ram, load, heartbeat, alerts } каждое 0..1
 */
function normalizeParts(snapshot, options) {
  return normalizePartsInternal(snapshot, options).parts;
}

/* -------------------------------------------------------------------------- */
/* Основной API                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Единый скор здоровья 0..1.
 *
 * @param {object|NaN|null} snapshot — { cpu, ram, load, heartbeat, alert_count }
 * @param {object} [options] — переопределения порогов/ядер/весов/вывода.
 * @returns {{
 *   value: number,
 *   parts: {cpu:number, ram:number, load:number, heartbeat:number, alerts:number},
 *   contributions: object,
 *   weights: object,
 *   warnings: string[]
 * }}
 */
function score(snapshot, options) {
  const o = resolveOptions(options);
  const warnings = [];

  // --- Жёсткая валидация входа: не-объект (в т.ч. NaN) -> 0 + warning ------
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    const reason =
      snapshot === null
        ? 'snapshot is null'
        : snapshot === undefined
          ? 'snapshot is undefined'
          : Array.isArray(snapshot)
            ? 'snapshot is an array'
            : `snapshot has invalid type "${typeof snapshot}"`;
    warnings.push(`${reason} -> health score = 0`);

    const zeroParts = {};
    const zeroContrib = {};
    for (const key of COMPONENT_KEYS) {
      zeroParts[key] = 0;
      zeroContrib[key] = 0;
    }

    emitWarnings(warnings, o);
    return {
      value: 0,
      parts: zeroParts,
      contributions: zeroContrib,
      weights: Object.assign({}, WEIGHTS),
      warnings,
    };
  }

  // --- Нормализация компонент ---------------------------------------------
  const normalized = normalizePartsInternal(snapshot, o);
  warnings.push.apply(warnings, normalized.warnings);
  const parts = normalized.parts;

  // --- Взвешенная сумма ----------------------------------------------------
  const weights = resolveWeights(o);
  const contributions = {};
  let value = 0;
  for (const key of COMPONENT_KEYS) {
    const c = parts[key] * weights[key];
    contributions[key] = round(c, o.precision);
    value += c;
  }

  value = round(clamp01(value), o.precision);

  emitWarnings(warnings, o);

  return {
    value,
    parts,
    contributions,
    weights: Object.assign({}, WEIGHTS),
    warnings,
  };
}

/**
 * Пишет предупреждения в console.warn (если включено), не роняя вызов.
 * @param {string[]} warnings
 * @param {object} options
 */
function emitWarnings(warnings, options) {
  if (!warnings || warnings.length === 0) return;
  if (!options || options.warn === false) return;
  for (const w of warnings) {
    try {
      // eslint-disable-next-line no-console
      console.warn('[health_score] ' + w);
    } catch (_err) {
      /* console может быть недоступен — молча пропускаем. */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  score,
  normalizeParts,
  WEIGHTS,
  COMPONENT_KEYS,
  DEFAULT_OPTIONS,
  // Внутренние помощники — полезны для тестов и переиспользования.
  decayHealth,
  heartbeatHealth,
  clamp01,
  round,
  toFiniteNumber,
};

// Прямой запуск: `node observability/health_score.js` — smoke-демо.
if (require.main === module) {
  const healthy = { cpu: 25, ram: 40, load: 1, heartbeat: 1, alert_count: 0 };
  const bad = { cpu: 100, ram: 100, load: 9999, heartbeat: 0, alert_count: 50 };
  console.log('healthy ->', JSON.stringify(score(healthy, { warn: false })));
  console.log('bad     ->', JSON.stringify(score(bad, { warn: false })));
  console.log('NaN     ->', JSON.stringify(score(NaN, { warn: false })));
}
