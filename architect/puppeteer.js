#!/usr/bin/env node
// architect/puppeteer.js
// ─────────────────────────────────────────────────────────────────────────────
// КУКЛОВОД (Puppeteer) — управляющий RL-агент пула.
// По мотивам «Кукловод» (NeurIPS 2025): единый агент держит нити пула пилотов
// и решает три вещи — запускать ли новую гонку, как расставить приоритеты и
// какую стратегию включить, максимизируя суммарную награду.
//
// ── Пространство наблюдений (observation) ───────────────────────────────────
//   {
//     pool_size : number,          // размер пула (пилотов/исполнителей)
//     load      : number,          // загрузка пула, 0..1 (принимаем и 0..100)
//     budget    : number|object,   // остаток (число) либо { total, remaining }
//     history   : Array,           // прошлые эпизоды [{ quality, spent, ... }]
//   }
//
// ── Пространство действий (actions) ─────────────────────────────────────────
//   start_race       — запустить новую гонку (растёт качество и загрузка);
//   change_priority  — переставить приоритеты задач пула (дёшево);
//   switch_strategy  — сменить стратегию пула (balanced|quality_first|
//                      budget_first|explore|throttle).
//
// ── Награда (reward) ────────────────────────────────────────────────────────
//   reward = w_q * quality + w_e * budget_efficiency + w_s * stability
//   (веса нормируются; опциональный penalty вычитается).
//
// ── Политика ────────────────────────────────────────────────────────────────
//   ЗАГЛУШКА rule-based: детерминированные правила ниже. Каркас табличного
//   Q-learning присутствует, но по умолчанию выключен (mode='rule').
//
// ── Публичный API ───────────────────────────────────────────────────────────
//   const { Puppeteer, createPuppeteer } = require('./architect/puppeteer');
//   const pup = createPuppeteer();
//   const action = pup.decide(state);        // { action, params, reasoning }
//   const { reward } = pup.observe(metrics); // награда + обучение
//
// Зависимости: только Node core (fs, path). require() не имеет побочных
// эффектов — файл безопасно грузится для `node --check` и тестов.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── Действия ────────────────────────────────────────────────────────────────
const ACTIONS = Object.freeze({
  START_RACE: 'start_race',
  CHANGE_PRIORITY: 'change_priority',
  SWITCH_STRATEGY: 'switch_strategy',
});
const ACTION_LIST = Object.freeze(Object.values(ACTIONS));

// ── Стратегии пула ──────────────────────────────────────────────────────────
const STRATEGIES = Object.freeze([
  'balanced',
  'quality_first',
  'budget_first',
  'explore',
  'throttle',
]);

// ── Режимы приоритизации задач ──────────────────────────────────────────────
const PRIORITY_MODES = Object.freeze([
  'fifo',
  'cheap_first',
  'quality_first',
  'deadline_first',
]);

// ── Пороги и веса по умолчанию ──────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  minPool: 3, // меньше — пул слишком мал для гонки
  maxLoad: 0.85, // выше — перегрузка, нужен throttle
  busyLoad: 0.6, // ниже — можно запускать новую гонку
  lowBudget: 0.2, // доля остатка: ниже — режим экономии
  richBudget: 0.5, // доля остатка: выше — бюджет богатый
  epsilon: 0.1, // доля случайных действий (Q-политика)
  alpha: 0.3, // скорость обучения Q
  gamma: 0.9, // дисконт Q
  minVisits: 8, // визитов (s,a) до доверия к Q
  qWeight: 0.6, // вес Q-совета в hybrid-режиме
  weights: Object.freeze({ quality: 0.5, budget_efficiency: 0.3, stability: 0.2 }),
  qTableFile: path.join(ROOT, 'memory', 'architect_puppeteer_qtable.json'),
});

// ── Мелкие утилиты ──────────────────────────────────────────────────────────

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function toNum(x, fallback) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function round(x, digits = 4) {
  const k = Math.pow(10, digits);
  return Math.round(x * k) / k;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) * (v - m))));
}

/** Нормированный наклон линейной регрессии (единиц y на шаг). */
function slope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const mx = mean(xs);
  const my = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    num += dx * (values[i] - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

/** Распаковать историю в массив quality 0..1. */
function extractQualities(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((h) => (h && typeof h === 'object' ? (h.quality ?? h.score) : h))
    .map((v) => toNum(v, NaN))
    .filter((v) => Number.isFinite(v))
    .map((v) => clamp01(v));
}

/**
 * Привести сырое состояние пула к каноничной обсервации.
 * Устойчиво к мусору: пропуски заменяются безопасными значениями.
 */
function normalizeObservation(raw = {}) {
  const poolSize = Math.max(0, Math.round(toNum(raw.pool_size ?? raw.poolSize, 0)));

  let load = toNum(raw.load, 0);
  if (load > 1) load = load / 100; // поддержка процентов
  load = clamp01(load);

  // ── Бюджет: число | { total, remaining/budget_left } ──
  let budgetTotal = toNum(raw.budget_total ?? raw.budgetTotal, NaN);
  let budgetLeft = toNum(raw.budget_left ?? raw.budgetLeft, NaN);
  const rawBudget = raw.budget;
  if (rawBudget && typeof rawBudget === 'object') {
    budgetTotal = toNum(rawBudget.total, budgetTotal);
    budgetLeft = toNum(
      rawBudget.remaining ?? rawBudget.left ?? rawBudget.budget_left,
      budgetLeft,
    );
  } else if (typeof rawBudget === 'number') {
    budgetLeft = rawBudget;
    if (!Number.isFinite(budgetTotal)) budgetTotal = Math.max(budgetLeft, 1);
  }
  if (!Number.isFinite(budgetTotal) || budgetTotal <= 0) {
    budgetTotal = Number.isFinite(budgetLeft) && budgetLeft > 0 ? budgetLeft : 1;
  }
  if (!Number.isFinite(budgetLeft)) budgetLeft = budgetTotal;
  const budgetRatio = clamp01(budgetLeft / budgetTotal);

  // ── История ──
  const history = Array.isArray(raw.history) ? raw.history.slice(-50) : [];
  const qualities = extractQualities(history);
  const qualityMean = qualities.length ? mean(qualities) : 0;
  const sl = slope(qualities);
  const trend = sl > 0.02 ? 'up' : sl < -0.02 ? 'down' : 'flat';

  // Стабильность = 1 - коэффициент вариации качества (кламп 0..1).
  let stability = 1;
  if (qualities.length >= 2) {
    const m = mean(qualities);
    const cv = m > 0 ? stdDev(qualities) / m : 0;
    stability = clamp01(1 - cv);
  }

  return {
    pool_size: poolSize,
    load,
    budget_total: budgetTotal,
    budget_left: budgetLeft,
    budget_ratio: budgetRatio,
    history,
    history_size: history.length,
    quality_mean: qualityMean,
    trend,
    slope: round(sl, 5),
    stability: round(stability, 4),
    strategy: STRATEGIES.includes(raw.strategy) ? raw.strategy : 'balanced',
    priority: PRIORITY_MODES.includes(raw.priority) ? raw.priority : 'fifo',
  };
}

/**
 * Компонент budget_efficiency: доля сохранённого бюджета.
 * Если задано явно — берём его, иначе выводим из spent/budget.
 */
function deriveBudgetEfficiency(metrics = {}) {
  if (metrics.budget_efficiency != null) return clamp01(metrics.budget_efficiency);
  const spent = toNum(metrics.spent, 0);
  const budget = toNum(metrics.budget ?? metrics.budget_total, NaN);
  if (Number.isFinite(budget) && budget > 0) return clamp01(1 - spent / budget);
  const left = toNum(metrics.budget_left ?? metrics.remaining, NaN);
  if (Number.isFinite(left) && spent + left > 0) return clamp01(left / (spent + left));
  return 0.5;
}

/**
 * Награда = (w_q*quality + w_e*budget_efficiency + w_s*stability)/Σw - penalty*0.5.
 * @returns {{reward:number, components:object}}
 */
function computeReward(metrics = {}, weights = DEFAULTS.weights) {
  const quality = clamp01(metrics.quality ?? metrics.score ?? 0);
  const budgetEfficiency = deriveBudgetEfficiency(metrics);

  let stability;
  if (metrics.stability != null) {
    stability = clamp01(metrics.stability);
  } else {
    const previous = extractQualities(metrics.history);
    previous.push(quality);
    const m = mean(previous);
    stability = previous.length >= 2 ? clamp01(1 - (m > 0 ? stdDev(previous) / m : 0)) : 1;
  }

  const w = {
    quality: toNum(weights.quality, DEFAULTS.weights.quality),
    budget_efficiency: toNum(weights.budget_efficiency, DEFAULTS.weights.budget_efficiency),
    stability: toNum(weights.stability, DEFAULTS.weights.stability),
  };
  const norm = w.quality + w.budget_efficiency + w.stability || 1;

  const penalty = clamp01(toNum(metrics.penalty, 0));
  const raw =
    (w.quality * quality + w.budget_efficiency * budgetEfficiency + w.stability * stability) / norm;
  const reward = clamp01(raw - penalty * 0.5);

  return {
    reward: round(reward, 4),
    components: {
      quality: round(quality, 4),
      budget_efficiency: round(budgetEfficiency, 4),
      stability: round(stability, 4),
      penalty: round(penalty, 4),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Класс Puppeteer
// ─────────────────────────────────────────────────────────────────────────────

class Puppeteer {
  /**
   * @param {object} [options] переопределения DEFAULTS + { mode }
   *   mode: 'rule' (по умолчанию) | 'hybrid' | 'q'
   */
  constructor(options = {}) {
    this.config = Object.assign({}, DEFAULTS, options);
    this.config.weights = Object.assign({}, DEFAULTS.weights, options.weights || {});
    this.mode = ['rule', 'hybrid', 'q'].includes(options.mode) ? options.mode : 'rule';

    this.strategy = STRATEGIES.includes(options.strategy) ? options.strategy : 'balanced';
    this.priority = PRIORITY_MODES.includes(options.priority) ? options.priority : 'fifo';

    /** Q-таблица: `${stateKey}::${action}` -> { value, visits } */
    this.q = new Map();
    this.steps = 0;
    this.races = 0;
    this.totalReward = 0;
    this.lastState = null;
    this.lastStateKey = null;
    this.lastAction = null;
    this.lastObservation = null;
    this.trace = [];

    if (options.loadQTable) this._loadQTable();
  }

  // ── Наблюдение ────────────────────────────────────────────────────────────

  /** @param {object} raw сырое состояние пула @returns {object} обсервация */
  observeState(raw = {}) {
    const obs = normalizeObservation(
      Object.assign({}, raw, { strategy: this.strategy, priority: this.priority }),
    );
    this.lastObservation = obs;
    this.lastState = obs;
    return obs;
  }

  /** Дискретизация обсервации в ключ состояния. */
  stateKey(obs) {
    const s = obs || this.lastObservation || normalizeObservation({});
    const pool = s.pool_size >= 7 ? 'L' : s.pool_size >= this.config.minPool ? 'M' : 'S';
    const load = s.load >= this.config.maxLoad ? 'H' : s.load >= 0.5 ? 'M' : 'L';
    const budget =
      s.budget_ratio <= this.config.lowBudget
        ? 'scarce'
        : s.budget_ratio <= this.config.richBudget
          ? 'ok'
          : 'rich';
    return `${pool}|${load}|${budget}|${s.trend}`;
  }

  // ── Правила (заглушка) ────────────────────────────────────────────────────

  /**
   * Детерминированная rule-based политика — ядро заглушки.
   * @returns {{action:string, params:object, reasoning:string, source:string}}
   */
  rulePolicy(obs) {
    const c = this.config;
    const s = obs || this.observeState({});

    // 1. Перегрузка → разгружаем пул (стабильность важнее качества).
    if (s.load >= c.maxLoad) {
      if (this.strategy !== 'throttle') {
        return this._makeAction(
          ACTIONS.SWITCH_STRATEGY,
          { strategy: 'throttle' },
          `load=${round(s.load, 3)} >= maxLoad=${c.maxLoad}: включаю throttle`,
          'rule',
        );
      }
      return this._makeAction(
        ACTIONS.CHANGE_PRIORITY,
        { priority: 'deadline_first' },
        'throttle уже активен: переприоритизирую на deadline_first',
        'rule',
      );
    }

    // 2. Бюджет на исходе → экономим.
    if (s.budget_ratio <= c.lowBudget) {
      if (this.strategy !== 'budget_first') {
        return this._makeAction(
          ACTIONS.SWITCH_STRATEGY,
          { strategy: 'budget_first' },
          `budget_ratio=${round(s.budget_ratio, 3)} <= ${c.lowBudget}: режим экономии`,
          'rule',
        );
      }
      return this._makeAction(
        ACTIONS.CHANGE_PRIORITY,
        { priority: 'cheap_first' },
        'бюджет исчерпан: сначала дешёвые задачи',
        'rule',
      );
    }

    // 3. Качество падает → исследуем пространство стратегий.
    if (s.trend === 'down' && this.strategy !== 'explore') {
      return this._makeAction(
        ACTIONS.SWITCH_STRATEGY,
        { strategy: 'explore' },
        `trend=down (slope=${s.slope}): пробую explore`,
        'rule',
      );
    }

    // 4. Есть ресурсы и бюджет → запускаем гонку.
    if (s.load < c.busyLoad && s.pool_size >= c.minPool && s.budget_ratio > c.lowBudget) {
      const boxes = Math.max(1, Math.min(s.pool_size, Math.round(s.pool_size * (1 - s.load)) || 1));
      return this._makeAction(
        ACTIONS.START_RACE,
        { boxes, priority: 'quality_first', strategy: this.strategy },
        `load=${round(s.load, 3)} < ${c.busyLoad}, pool=${s.pool_size}: запускаю гонку на ${boxes} пилотах`,
        'rule',
      );
    }

    // 5. Иначе — мягкая переприоритизация под цель.
    const priority = s.budget_ratio > c.richBudget ? 'quality_first' : 'cheap_first';
    return this._makeAction(
      ACTIONS.CHANGE_PRIORITY,
      { priority },
      'устойчивое состояние: уточняю приоритеты задач',
      'rule',
    );
  }

  // ── Q-политика (каркас) ───────────────────────────────────────────────────

  _qValue(stateKey, action) {
    const rec = this.q.get(`${stateKey}::${action}`);
    return rec ? rec.value : 0;
  }

  _qVisits(stateKey, action) {
    const rec = this.q.get(`${stateKey}::${action}`);
    return rec ? rec.visits : 0;
  }

  /** Жадное по Q действие; null, если данных мало. */
  qPolicy(obs) {
    const s = obs || this.lastObservation;
    if (!s) return null;
    const key = this.stateKey(s);
    let best = null;
    let bestVal = -Infinity;
    let visits = 0;
    for (const a of ACTION_LIST) {
      const v = this._qValue(key, a);
      visits += this._qVisits(key, a);
      if (v > bestVal) {
        bestVal = v;
        best = a;
      }
    }
    if (visits < this.config.minVisits) return null;
    return this._makeAction(
      best,
      this._defaultParams(best, s),
      `Q[${key}]=${round(bestVal, 3)}`,
      'q',
    );
  }

  _defaultParams(action, s) {
    if (action === ACTIONS.START_RACE) {
      return { boxes: Math.max(1, Math.min(s.pool_size, 3)), strategy: this.strategy };
    }
    if (action === ACTIONS.CHANGE_PRIORITY) {
      return {
        priority: s.budget_ratio > this.config.richBudget ? 'quality_first' : 'cheap_first',
      };
    }
    return { strategy: s.trend === 'down' ? 'explore' : 'balanced' };
  }

  // ── Выбор действия ────────────────────────────────────────────────────────

  /**
   * Выбрать действие. По умолчанию — rule-based заглушка.
   * @param {object} rawState наблюдение пула
   * @param {object} [opts] { mode, rng }
   * @returns {{action:string, params:object, reasoning:string, source:string}}
   */
  decide(rawState, opts = {}) {
    const obs = this.observeState(rawState);
    const mode = opts.mode || this.mode;
    const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
    const stateKey = this.stateKey(obs);

    let chosen;

    if (mode === 'q') {
      chosen = this.qPolicy(obs);
      if (!chosen) {
        const a = ACTION_LIST[Math.floor(rng() * ACTION_LIST.length)];
        chosen = this._makeAction(a, this._defaultParams(a, obs), 'cold-start exploration', 'explore');
      }
    } else if (mode === 'hybrid') {
      const rule = this.rulePolicy(obs);
      const q = this.qPolicy(obs);
      if (q && rng() > this.config.epsilon) {
        chosen = q.action === rule.action ? q : rng() < this.config.qWeight ? q : rule;
      } else {
        chosen = rule;
      }
    } else {
      // rule: детерминированная заглушка (без epsilon-шума)
      chosen = this.rulePolicy(obs);
    }

    this.lastState = obs;
    this.lastStateKey = stateKey;
    this.lastAction = chosen;
    this.steps += 1;

    // Управляющие действия меняют состояние самого Кукловода.
    if (chosen.action === ACTIONS.SWITCH_STRATEGY && chosen.params.strategy) {
      this.strategy = chosen.params.strategy;
    }
    if (chosen.action === ACTIONS.CHANGE_PRIORITY && chosen.params.priority) {
      this.priority = chosen.params.priority;
    }
    if (chosen.action === ACTIONS.START_RACE) {
      this.races += toNum(chosen.params.boxes, 1) || 1;
    }

    return chosen;
  }

  _makeAction(action, params, reasoning, source) {
    return { action, params: params || {}, reasoning: reasoning || '', source: source || 'rule' };
  }

  // ── Награда и обучение ────────────────────────────────────────────────────

  /**
   * Сообщить Кукловоду результат последнего действия.
   * Считает награду и (в режимах q/hybrid) обновляет Q-таблицу.
   * @param {object} metrics { quality, spent, budget, stability, ... }
   * @param {object} [nextState] следующее наблюдение (bootstrap)
   * @returns {{reward:number, components:object, action:object|null}}
   */
  observe(metrics = {}, nextState = null) {
    const { reward, components } = computeReward(
      Object.assign({ history: (this.lastObservation || {}).history }, metrics),
      this.config.weights,
    );

    this.totalReward += reward;
    const entry = {
      t: this.steps,
      state: this.lastStateKey,
      action: this.lastAction ? this.lastAction.action : null,
      reward,
      components,
    };
    this.trace.push(entry);
    if (this.trace.length > 500) this.trace.shift();

    if ((this.mode === 'q' || this.mode === 'hybrid') && this.lastStateKey && this.lastAction) {
      this._qUpdate(this.lastStateKey, this.lastAction.action, reward, nextState);
    }

    return { reward, components, action: this.lastAction };
  }

  _qUpdate(stateKey, action, reward, nextState) {
    const key = `${stateKey}::${action}`;
    const rec = this.q.get(key) || { value: 0, visits: 0 };
    let bestNext = 0;
    if (nextState) {
      const nk = this.stateKey(this.observeState(nextState));
      bestNext = Math.max(...ACTION_LIST.map((a) => this._qValue(nk, a)));
    }
    const target = reward + this.config.gamma * bestNext;
    rec.value = rec.value + this.config.alpha * (target - rec.value);
    rec.visits += 1;
    this.q.set(key, rec);
  }

  /** Ручное обновление Q (тесты / офлайн-обучение). */
  learn(stateKey, action, reward, nextStateKey = null) {
    let bestNext = 0;
    if (nextStateKey) bestNext = Math.max(...ACTION_LIST.map((a) => this._qValue(nextStateKey, a)));
    const key = `${stateKey}::${action}`;
    const rec = this.q.get(key) || { value: 0, visits: 0 };
    rec.value = rec.value + this.config.alpha * (reward + this.config.gamma * bestNext - rec.value);
    rec.visits += 1;
    this.q.set(key, rec);
    return rec.value;
  }

  // ── Эпизод ────────────────────────────────────────────────────────────────

  /**
   * Шаг «решить → применить → получить награду».
   * @param {object} rawState
   * @param {Function} apply функция применения действия -> метрики
   */
  async step(rawState, apply) {
    const action = this.decide(rawState);
    let metrics = {};
    let nextState = rawState;
    if (typeof apply === 'function') {
      const out = await apply(action, this.observeState(rawState));
      if (out && typeof out === 'object') {
        metrics = out.metrics || out;
        nextState = out.nextState || rawState;
      }
    }
    const { reward } = this.observe(metrics, nextState);
    return { action, reward, metrics, nextState };
  }

  /** Прогнать N шагов над «средой»-резолвером. */
  async runEpisode(resolveState, apply, steps = 10) {
    const log = [];
    for (let i = 0; i < steps; i++) {
      const state = typeof resolveState === 'function' ? await resolveState(i, log) : resolveState;
      const res = await this.step(state, apply);
      log.push(res);
    }
    return log;
  }

  // ── Статистика / персистенция ─────────────────────────────────────────────

  stats() {
    return {
      mode: this.mode,
      steps: this.steps,
      races: this.races,
      strategy: this.strategy,
      priority: this.priority,
      total_reward: round(this.totalReward, 4),
      avg_reward: this.steps ? round(this.totalReward / this.steps, 4) : 0,
      q_states: this.q.size,
      trace_size: this.trace.length,
      config: {
        minPool: this.config.minPool,
        maxLoad: this.config.maxLoad,
        lowBudget: this.config.lowBudget,
        weights: this.config.weights,
      },
    };
  }

  serialize() {
    return {
      version: 1,
      mode: this.mode,
      strategy: this.strategy,
      priority: this.priority,
      steps: this.steps,
      races: this.races,
      totalReward: this.totalReward,
      q: Array.from(this.q.entries()).map(([k, v]) => ({ key: k, value: v.value, visits: v.visits })),
    };
  }

  static deserialize(data = {}, options = {}) {
    const pup = new Puppeteer(options);
    if (data.mode) pup.mode = data.mode;
    if (STRATEGIES.includes(data.strategy)) pup.strategy = data.strategy;
    if (PRIORITY_MODES.includes(data.priority)) pup.priority = data.priority;
    pup.steps = toNum(data.steps, 0);
    pup.races = toNum(data.races, 0);
    pup.totalReward = toNum(data.totalReward, 0);
    if (Array.isArray(data.q)) {
      for (const rec of data.q) {
        if (rec && rec.key) pup.q.set(rec.key, { value: toNum(rec.value, 0), visits: toNum(rec.visits, 0) });
      }
    }
    return pup;
  }

  _loadQTable() {
    try {
      const file = this.config.qTableFile;
      if (!fs.existsSync(file)) return false;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) {
        for (const rec of data) if (rec && rec.key) this.q.set(rec.key, { value: toNum(rec.value, 0), visits: toNum(rec.visits, 0) });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  save() {
    try {
      const file = this.config.qTableFile;
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.serialize(), null, 2));
      return { ok: true, file };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

/** Фабрика. */
function createPuppeteer(options) {
  return new Puppeteer(options);
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI: node architect/puppeteer.js --demo [--steps 20] [--json]
// ─────────────────────────────────────────────────────────────────────────────

function makeSyntheticEnv(seedState) {
  const state = Object.assign(
    { pool_size: 5, load: 0.3, budget: { total: 100, remaining: 100 }, history: [] },
    seedState || {},
  );
  let quality = 0.6;

  function resolve() {
    return {
      pool_size: state.pool_size,
      load: state.load,
      budget: state.budget,
      history: state.history.slice(-10),
      strategy: 'balanced',
    };
  }

  function apply(action) {
    let spent = 0;
    if (action.action === 'start_race') {
      spent = 12;
      state.load = clamp01(state.load + 0.25);
      quality = clamp01(quality + 0.05 + (Math.random() - 0.5) * 0.15);
    } else if (action.action === 'change_priority') {
      spent = 2;
      quality = clamp01(quality + 0.01);
    } else if (action.action === 'switch_strategy') {
      spent = 1;
      if (action.params.strategy === 'throttle') state.load = clamp01(state.load - 0.3);
      else if (action.params.strategy === 'budget_first') spent = 0;
      else quality = clamp01(quality + 0.03);
    }
    state.load = clamp01(state.load - 0.08); // естественное остывание
    state.budget.remaining = Math.max(0, state.budget.remaining - spent);
    state.history.push({ quality, spent });
    return { metrics: { quality, spent, budget: state.budget.total, stability: 0.8 } };
  }

  return { resolve, apply, state };
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const demo = args.includes('--demo') || json || args.length === 0;
  const stepsIdx = args.indexOf('--steps');
  const steps = stepsIdx >= 0 ? parseInt(args[stepsIdx + 1], 10) || 20 : 20;

  if (!demo) {
    console.log('Usage: node architect/puppeteer.js --demo [--steps N] [--json]');
    return;
  }

  const pup = createPuppeteer({ mode: 'hybrid' });
  const env = makeSyntheticEnv();
  const log = await pup.runEpisode(env.resolve, (action, obs) => env.apply(action, obs), steps);

  if (json) {
    console.log(
      JSON.stringify(
        {
          stats: pup.stats(),
          log: log.map((l) => ({ action: l.action.action, params: l.action.params, reward: l.reward })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('🎭 Кукловод — demo (hybrid)');
  log.forEach((l, i) => {
    console.log(
      `  step ${String(i + 1).padStart(2)} ` +
        `${l.action.action.padEnd(16)} reward=${l.reward.toFixed(3)} ` +
        `params=${JSON.stringify(l.action.params)}`,
    );
  });
  console.log('─'.repeat(60));
  console.log(JSON.stringify(pup.stats(), null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[puppeteer] error:', (e && e.message) || e);
    process.exitCode = 1;
  });
}

module.exports = {
  // Главный экспорт
  Puppeteer,
  createPuppeteer,
  // Справочники
  ACTIONS,
  ACTION_LIST,
  STRATEGIES,
  PRIORITY_MODES,
  DEFAULTS,
  // Функции
  normalizeObservation,
  computeReward,
  deriveBudgetEfficiency,
  clamp01,
  // внутренние, но полезные для тестов
  _internals: { mean, stdDev, slope, round, extractQualities },
};
