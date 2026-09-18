#!/usr/bin/env node
/**
 * evolution/extinction_detector.js
 * ============================================================================
 * Extinction Detector — «детектор вымирания» агентов в экосистеме Phoenix.
 *
 * Назначение:
 *   Отслеживает жизнеспособность агентов эволюционной экосистемы и выявляет
 *   виды (агентов), которые находятся на грани исчезновения или уже вымерли.
 *
 *   Детектор считает для каждого агента набор признаков вымирания:
 *     1. Давность последней активности  (lastSeen).
 *     2. Продуктивность (мутации / циклы размножения за окно).
 *     3. Приспособленность (fitness) и её падение.
 *     4. Долю потомков (вклад в следующее поколение).
 *     5. Критическую ошибку / остановку (crashed, disabled).
 *
 *   На основе этих признаков агент получает категорию риска:
 *     - 'extinct'     — уже исчез (нет потомков, давно молчит, сломан).
 *     - 'endangered'  — на грани вымирания (high risk).
 *     - 'vulnerable'  — уязвим (средний риск).
 *     - 'thriving'    — процветает (низкий риск).
 *
 * Публичный API (модуль):
 *   - detect(population, options) -> Report
 *       Главная функция. Принимает массив агентов (или читает с диска)
 *       и возвращает структурированный отчёт.
 *
 *   - assessAgent(agent, options) -> Assessment
 *       Оценка одного агента.
 *
 *   - configure(options) -> config
 *   - stats()            -> object
 *   - reset()            -> this
 *
 *   Классы/утилиты:
 *   - ExtinctionReport    агрегатор результатов
 *   - loadPopulation(dir) чтение агентов с диска (best-effort)
 *   - riskScore(features) нормированная оценка риска 0..1
 *
 * Модель Report:
 *   {
 *     ts, total, threshold,
 *     counts: { extinct, endangered, vulnerable, thriving },
 *     extinctionRate,           // доля extinct+endangered от total
 *     extinct:    [Assessment],
 *     endangered: [Assessment],
 *     vulnerable: [Assessment],
 *     thriving:   [Assessment],
 *     alerts:     [string],
 *     verdict:    'stable' | 'warning' | 'critical' | 'collapse',
 *   }
 *
 * Зависимости: только Node.js >= 16 (fs, path). Никаких внешних пакетов.
 * Детерминизм: `now` и `rng` инъектируются через configure() — это делает
 * модуль пригодным для unit-тестов.
 *
 * CLI:
 *   node evolution/extinction_detector.js [--dir <path>] [--json]
 *   node evolution/extinction_detector.js --file <population.json>
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------------------- */
/* 0. Конфигурация по умолчанию                                               */
/* -------------------------------------------------------------------------- */

const ROOT_DIR = process.env.EXTINCTION_ROOT || path.resolve(__dirname, '..');

const DEFAULTS = Object.freeze({
  // Горизонт «молчания» (мс). Пока агент активен в этом окне — считается живым.
  silenceWindowMs: 1000 * 60 * 60 * 24 * 7, // 7 дней
  // Порог риска, выше которого агент считается вымирающим.
  endangeredThreshold: 0.66,
  // Порог риска для «уязвимого» статуса.
  vulnerableThreshold: 0.38,
  // Минимальная приспособленность, ниже которой вид считается деградирующим.
  minFitness: 0.25,
  // Минимальный вклад в потомство (доля генома в новом поколении).
  minOffspringShare: 0.02,
  // Максимальный размер выборки для быстрого режима (0 = без ограничений).
  sampleLimit: 0,
});

/* -------------------------------------------------------------------------- */
/* 1. Внутреннее состояние (инъекция времени/случайности)                     */
/* -------------------------------------------------------------------------- */

let CONFIG = Object.assign({}, DEFAULTS);
let _now = () => Date.now();
let _rng = () => Math.random();
let _lastReport = null;
let _detectCount = 0;

/**
 * Переопределить конфигурацию и заменить инъекции времени/случайности.
 * @param {object} [options]
 * @returns {object} актуальная конфигурация
 */
function configure(options) {
  if (options && typeof options === 'object') {
    Object.keys(options).forEach((k) => {
      if (k === 'now' && typeof options[k] === 'function') _now = options[k];
      else if (k === 'rng' && typeof options[k] === 'function') _rng = options[k];
      else CONFIG[k] = options[k];
    });
  }
  return Object.assign({}, CONFIG);
}

/** Сброс статистики и конфигурации к значениям по умолчанию. */
function reset() {
  CONFIG = Object.assign({}, DEFAULTS);
  _now = () => Date.now();
  _rng = () => Math.random();
  _lastReport = null;
  _detectCount = 0;
  return module.exports;
}

/** Краткая статистика последнего прогона. */
function stats() {
  if (!_lastReport) {
    return { runs: _detectCount, last: null };
  }
  return {
    runs: _detectCount,
    last: {
      ts: _lastReport.ts,
      total: _lastReport.total,
      verdict: _lastReport.verdict,
      extinctionRate: _lastReport.extinctionRate,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Вспомогательные утилиты                                                 */
/* -------------------------------------------------------------------------- */

/** Надёжное приведение к числу. */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

/** Ограничение значения в диапазоне [lo, hi]. */
function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** Привести к строке для стабильной сортировки/сравнения. */
function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Разбор времени последней активности агента.
 * Принимает ISO-строку, мс-число или имя поля с таймстампом.
 * @returns {number} мс, либо NaN
 */
function parseTime(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? t : NaN;
}

/** Первое непустое значение из списка ключей объекта. */
function pick(obj, keys, fallback) {
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      return obj[k];
    }
  }
  return fallback;
}

/* -------------------------------------------------------------------------- */
/* 3. Извлечение признаков вымирания                                          */
/* -------------------------------------------------------------------------- */

/**
 * Собрать признаки вымирания для одного агента.
 * @param {object} agent — запись агента (может быть неполной)
 * @param {object} [options]
 * @returns {object} features
 */
function extractFeatures(agent, options) {
  const opts = options || {};
  const now = num(opts.now, _now());

  const lastSeenRaw = pick(
    agent,
    ['lastSeen', 'last_seen', 'lastActive', 'updatedAt', 'updated_at', 'ts'],
    null
  );
  const lastSeen = parseTime(lastSeenRaw);
  const silenceMs = Number.isFinite(lastSeen) ? Math.max(0, now - lastSeen) : Infinity;

  const offspring = num(
    pick(agent, ['offspring', 'children', 'descendants', 'childCount'], 0),
    0
  );
  const population = Math.max(1, num(pick(agent, ['population', 'count'], 1), 1));
  const offspringShare = clamp(offspring / population, 0, 1);

  const fitness = clamp(num(pick(agent, ['fitness', 'score', 'fitnessScore'], 0), 0), 0, 1);
  const prevFitness = clamp(
    num(pick(agent, ['prevFitness', 'previousFitness', 'fitnessPrev'], fitness), fitness),
    0,
    1
  );
  const fitnessTrend = clamp(fitness - prevFitness, -1, 1);

  const cycles = num(pick(agent, ['cycles', 'runs', 'generations', 'activity'], 0), 0);

  const crashed = Boolean(
    pick(agent, ['crashed', 'dead', 'stopped', 'halted'], false)
  );
  const disabled = Boolean(pick(agent, ['disabled', 'archived', 'retired'], false));

  const status = str(pick(agent, ['status'], '')).toLowerCase();
  const errorRate = clamp(num(pick(agent, ['errorRate', 'errors', 'failRate'], 0), 0), 0, 1);

  return {
    id: str(pick(agent, ['id', 'agentId', 'agent_id', 'name'], 'unknown')),
    now,
    lastSeenRaw,
    lastSeen: Number.isFinite(lastSeen) ? lastSeen : null,
    silenceMs,
    offspring,
    population,
    offspringShare,
    fitness,
    prevFitness,
    fitnessTrend,
    cycles,
    crashed,
    disabled,
    status,
    errorRate,
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Оценка риска вымирания                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Нормированная оценка риска вымирания 0..1 по признакам.
 * Чем больше 1 — тем ближе агент к исчезновению.
 * @param {object} f — результат extractFeatures()
 * @returns {number}
 */
function riskScore(f) {
  const window = Math.max(1, num(CONFIG.silenceWindowMs, DEFAULTS.silenceWindowMs));

  // Компонент давности: 0 — активен сейчас, 1 — «молчит» >= окна.
  let silenceScore;
  if (!Number.isFinite(f.silenceMs)) silenceScore = 1;
  else silenceScore = clamp(f.silenceMs / window, 0, 1);

  // Компонент приспособленности: слабый фитнес => высокий риск.
  const fitnessRisk = clamp(1 - f.fitness / Math.max(1e-6, 1), 0, 1);

  // Компонент потомства: нет вклада в следующее поколение => риск.
  const offspringRisk = clamp(
    1 - f.offspringShare / Math.max(1e-6, CONFIG.minOffspringShare || 0.02),
    0,
    1
  );

  // Компонент ошибок.
  const errorRisk = clamp(f.errorRate, 0, 1);

  // Компонент тренда: падение фитнеса ускоряет вымирание.
  const trendRisk = f.fitnessTrend < 0 ? clamp(-f.fitnessTrend, 0, 1) : 0;

  // Компонент неактивности (число циклов).
  const activityRisk = f.cycles > 0 ? clamp(1 - f.cycles / 20, 0, 1) : 1;

  // Базовые жёсткие сигналы.
  const hardRisk = f.crashed || f.disabled || /dead|extinct|offline/.test(f.status) ? 1 : 0;

  // Взвешенная сумма компонентов.
  const score =
    0.28 * silenceScore +
    0.20 * fitnessRisk +
    0.16 * offspringRisk +
    0.10 * errorRisk +
    0.09 * trendRisk +
    0.09 * activityRisk +
    0.08 * hardRisk;

  return clamp(score, 0, 1);
}

/**
 * Оценить одного агента: признаки + риск + категория.
 * @param {object} agent
 * @param {object} [options]
 * @returns {object} assessment
 */
function assessAgent(agent, options) {
  const features = extractFeatures(agent, options);
  const risk = riskScore(features);

  let category;
  if (features.crashed || features.disabled) {
    category = 'extinct';
  } else if (risk >= num(CONFIG.endangeredThreshold, DEFAULTS.endangeredThreshold)) {
    category = 'extinct';
  } else if (risk >= num(CONFIG.vulnerableThreshold, DEFAULTS.vulnerableThreshold) * 1.5) {
    category = 'endangered';
  } else if (risk >= num(CONFIG.vulnerableThreshold, DEFAULTS.vulnerableThreshold)) {
    category = 'vulnerable';
  } else {
    category = 'thriving';
  }

  const reasons = [];
  if (features.crashed) reasons.push('crashed');
  if (features.disabled) reasons.push('disabled');
  if (Number.isFinite(features.silenceMs) &&
      features.silenceMs >= num(CONFIG.silenceWindowMs, DEFAULTS.silenceWindowMs)) {
    reasons.push('silent_too_long');
  }
  if (features.fitness < num(CONFIG.minFitness, DEFAULTS.minFitness)) {
    reasons.push('low_fitness');
  }
  if (features.offspringShare < num(CONFIG.minOffspringShare, DEFAULTS.minOffspringShare)) {
    reasons.push('no_offspring');
  }
  if (features.fitnessTrend < 0) reasons.push('fitness_declining');
  if (features.errorRate > 0.5) reasons.push('high_error_rate');

  return {
    id: features.id,
    category,
    risk: Number(risk.toFixed(4)),
    confidence: Number(clamp(1 - (risk > 0.5 ? 1 - risk : risk), 0.5, 1).toFixed(4)),
    reasons,
    features: {
      lastSeen: features.lastSeen,
      silenceMs: Number.isFinite(features.silenceMs) ? features.silenceMs : null,
      offspring: features.offspring,
      offspringShare: Number(features.offspringShare.toFixed(4)),
      fitness: Number(features.fitness.toFixed(4)),
      fitnessTrend: Number(features.fitnessTrend.toFixed(4)),
      cycles: features.cycles,
      errorRate: Number(features.errorRate.toFixed(4)),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 5. Загрузка популяции                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort загрузка популяции с диска.
 * Ищет `population.json`, `agents.json` или собирает *.json в каталоге.
 * @param {string} dir
 * @returns {object[]} массив агентов (пустой при неудаче)
 */
function loadPopulation(dir) {
  const base = dir || path.join(ROOT_DIR, 'evolution');
  const candidates = [
    path.join(base, 'population.json'),
    path.join(base, 'agents.json'),
    path.join(ROOT_DIR, 'agents.json'),
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      const raw = fs.readFileSync(candidates[i], 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && Array.isArray(parsed.population)) return parsed.population;
      if (parsed && Array.isArray(parsed.agents)) return parsed.agents;
    } catch (e) { /* пробуем следующий источник */ }
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* 6. Отчёт                                                                   */
/* -------------------------------------------------------------------------- */

/** Агрегатор результатов детекции. */
class ExtinctionReport {
  constructor(assessments, meta) {
    this.ts = meta && meta.ts !== undefined ? meta.ts : _now();
    this.total = assessments.length;
    this.threshold = meta && meta.endangeredThreshold !== undefined
      ? meta.endangeredThreshold
      : CONFIG.endangeredThreshold;
    this.extinct = assessments.filter((a) => a.category === 'extinct');
    this.endangered = assessments.filter((a) => a.category === 'endangered');
    this.vulnerable = assessments.filter((a) => a.category === 'vulnerable');
    this.thriving = assessments.filter((a) => a.category === 'thriving');
    this.counts = {
      extinct: this.extinct.length,
      endangered: this.endangered.length,
      vulnerable: this.vulnerable.length,
      thriving: this.thriving.length,
    };
    this.extinctionRate = this.total === 0
      ? 0
      : Number(((this.counts.extinct + this.counts.endangered) / this.total).toFixed(4));
    this.alerts = [];
    this.verdict = 'stable';
    this._finalize();
  }

  _finalize() {
    const flagged = this.extinct.concat(this.endangered);
    flagged
      .sort((a, b) => b.risk - a.risk)
      .slice(0, 10)
      .forEach((a) => {
        this.alerts.push(
          `${a.category}: ${a.id} (risk=${a.risk}; ${a.reasons.join(', ') || 'n/a'})`
        );
      });

    if (this.total === 0) this.verdict = 'stable';
    else if (this.extinctionRate >= 0.75) this.verdict = 'collapse';
    else if (this.extinctionRate >= 0.5) this.verdict = 'critical';
    else if (this.extinctionRate >= 0.25) this.verdict = 'warning';
    else this.verdict = 'stable';
  }

  /** Компактное представление отчёта. */
  summary() {
    return {
      ts: this.ts,
      total: this.total,
      counts: this.counts,
      extinctionRate: this.extinctionRate,
      verdict: this.verdict,
      alerts: this.alerts,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* 7. Публичный API detect()                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Обнаружить вымирание в популяции агентов.
 *
 * @param {object[]} [population] — массив агентов. Если не передан, детектор
 *        попытается загрузить популяцию с диска (best-effort).
 * @param {object}   [options]    — { now, threshold, silenceWindowMs, silent }
 * @returns {ExtinctionReport}
 */
function detect(population, options) {
  const opts = options || {};
  if (opts.threshold !== undefined) CONFIG.endangeredThreshold = num(opts.threshold);
  if (opts.silenceWindowMs !== undefined) CONFIG.silenceWindowMs = num(opts.silenceWindowMs);
  if (opts.endangeredThreshold !== undefined) CONFIG.endangeredThreshold = num(opts.endangeredThreshold);
  if (opts.vulnerableThreshold !== undefined) CONFIG.vulnerableThreshold = num(opts.vulnerableThreshold);

  let agents = population;
  if (!Array.isArray(agents)) {
    agents = loadPopulation(opts.dir);
  }

  const limit = num(CONFIG.sampleLimit, 0);
  if (limit > 0 && agents.length > limit) agents = agents.slice(0, limit);

  const now = num(opts.now, _now());
  const assessments = agents.map((agent) => assessAgent(agent, { now }));

  const report = new ExtinctionReport(assessments, {
    ts: now,
    endangeredThreshold: CONFIG.endangeredThreshold,
  });

  _lastReport = report;
  _detectCount += 1;

  if (!opts.silent && _detectCount > 0 && report.verdict !== 'stable') {
    report.alerts.forEach((line) => {
      // Аккуратное информирование без падения, если stdout недоступен.
      try { console.warn(`[extinction] ${line}`); } catch (e) { /* noop */ }
    });
  }

  return report;
}

/* -------------------------------------------------------------------------- */
/* 8. CLI                                                                     */
/* -------------------------------------------------------------------------- */

/** Разбор аргументов командной строки. */
function parseArgs(argv) {
  const args = { dir: null, file: null, json: false, silent: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--file') args.file = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--silent') args.silent = true;
  }
  return args;
}

/** Точка входа CLI. */
function main() {
  const args = parseArgs(process.argv.slice(2));
  let population = null;
  if (args.file) {
    try {
      population = JSON.parse(fs.readFileSync(args.file, 'utf8'));
      if (!Array.isArray(population) && population && Array.isArray(population.agents)) {
        population = population.agents;
      }
    } catch (e) {
      console.error(`не удалось прочитать --file ${args.file}: ${e.message}`);
      process.exit(2);
    }
  }

  const report = detect(population || undefined, { dir: args.dir, silent: args.silent });
  if (args.json) {
    console.log(JSON.stringify(report.summary(), null, 2));
  } else {
    const s = report.summary();
    console.log('=== Extinction Detector ===');
    console.log(`total:     ${s.total}`);
    console.log(`verdict:   ${s.verdict}`);
    console.log(`rate:      ${s.extinctionRate}`);
    console.log(`counts:    ${JSON.stringify(s.counts)}`);
    if (s.alerts.length) {
      console.log('--- alerts ---');
      s.alerts.forEach((l) => console.log(`  ${l}`));
    }
  }
  // Ненулевой код выхода, если экосистема коллапсирует.
  if (report.verdict === 'collapse') process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  }
}

/* -------------------------------------------------------------------------- */
/* 9. Экспорт                                                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
  detect,
  assessAgent,
  extractFeatures,
  riskScore,
  loadPopulation,
  configure,
  stats,
  reset,
  ExtinctionReport,
  CONFIG,
  DEFAULTS,
};
