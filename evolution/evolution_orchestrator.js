#!/usr/bin/env node
/**
 * evolution/evolution_orchestrator.js
 * ============================================================================
 * Evolution Orchestrator — дирижёр эволюционного контура Феникса.
 *
 * Назначение
 * ----------
 * Единая точка управления всеми модулями каталога `evolution/*`. Оркестратор
 * периодически (по интервалу) запускает «такт эволюции»: последовательно
 * вызывает публичные entry-point'ы зарегистрированных модулей (breeding_cycle,
 * mutation_logger, generation_report, species_guard, reaper_v2, dna_architect,
 * niche_finder, fitness_history, extinction_detector и т.д.), собирает отчёты,
 * ведёт статистику и безопасно переживает падение любого отдельного модуля.
 *
 * Публичный API
 * -------------
 *   const orch = require('./evolution/evolution_orchestrator');
 *
 *   orch.start(60000);   // запустить цикл каждые 60 секунд
 *   orch.start();        // интервал по умолчанию (CONFIG.defaultIntervalMs)
 *   orch.stop();         // остановить цикл (идемпотентно)
 *   orch.status();       // → снимок состояния (running, ticks, lastTick, ...)
 *
 * Дополнительно доступны:
 *   orch.tick()          — выполнить один такт вручную (async)
 *   orch.register(name, entry) — зарегистрировать свой модуль/функцию
 *   orch.modules()       — список зарегистрированных модулей
 *   orch.CONFIG, orch.STATUS
 *
 * Гарантии
 * --------
 *   - Модуль НИКОГДА не бросает исключение наружу из start/stop/status/tick:
 *     любые ошибки перехватываются, пишутся в лог и в состояние.
 *   - Отсутствующие/битые модули пропускаются (safe require), а не ломают такт.
 *   - Состояние best-effort сохраняется в memory/evolution_orchestrator_state.json.
 *
 * Зависимости
 * -----------
 *   Только stdlib Node.js (fs, path). Node >= 16.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* --------------------------------------------------------------------------- *
 * 0. Конфигурация
 * --------------------------------------------------------------------------- */

const ROOT_DIR = process.env.EVOLUTION_ORCH_ROOT || path.join(__dirname, '..');

const CONFIG = {
  // Каталог с эволюционными модулями
  modulesDir: process.env.EVOLUTION_MODULES_DIR || __dirname,

  // Интервал по умолчанию между тактами, мс (60 секунд)
  defaultIntervalMs: Number(process.env.EVOLUTION_INTERVAL_MS || 60000),

  // Минимально допустимый интервал, мс (защита от busy-loop)
  minIntervalMs: Number(process.env.EVOLUTION_MIN_INTERVAL_MS || 1000),

  // Запускать первый такт сразу при start() (без ожидания интервала)
  runOnStart: String(process.env.EVOLUTION_RUN_ON_START || 'true').toLowerCase() !== 'false',

  // Не запускать такт, если предыдущий ещё не завершился
  skipOverlapping: String(process.env.EVOLUTION_SKIP_OVERLAP || 'true').toLowerCase() !== 'false',

  // Глубина истории тактов, хранимой в памяти
  historyLimit: Number(process.env.EVOLUTION_HISTORY_LIMIT || 100),

  // Таймаут на один модуль, мс (0 = без таймаута)
  moduleTimeoutMs: Number(process.env.EVOLUTION_MODULE_TIMEOUT_MS || 30000),

  // Персистентное состояние
  stateFile: process.env.EVOLUTION_STATE_FILE
    || path.join(ROOT_DIR, 'memory', 'evolution_orchestrator_state.json'),

  // Журнал
  logFile: process.env.EVOLUTION_LOG_FILE
    || path.join(ROOT_DIR, 'evolution', 'evolution_orchestrator.log'),

  // Подробный вывод в консоль
  verbose: String(process.env.EVOLUTION_VERBOSE || 'false').toLowerCase() === 'true',

  // Писать лог в файл
  logToFile: String(process.env.EVOLUTION_LOG_TO_FILE || 'true').toLowerCase() !== 'false',
};

/* --------------------------------------------------------------------------- *
 * 1. Внутреннее состояние
 * --------------------------------------------------------------------------- */

const STATE = {
  running: false,
  startedAt: null,
  stoppedAt: null,
  intervalMs: null,
  timer: null,

  ticks: 0,
  ticksOk: 0,
  ticksFailed: 0,
  ticksSkipped: 0,

  lastTickAt: null,
  lastTickDurationMs: null,
  lastTickOk: null,
  lastTickError: null,

  // Карта модуль → агрегированная статистика
  modules: {},

  // Последние N результатов тактов
  history: [],
};

/* --------------------------------------------------------------------------- *
 * 2. Утилиты
 * --------------------------------------------------------------------------- */

/** Текущий ISO-timestamp. */
function nowIso() {
  return new Date().toISOString();
}

/** Гарантировать существование каталога файла. */
function ensureDirFor(file) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (err) {
    return false;
  }
}

/** Logger: консоль + append в файл, best-effort. */
function log(message, level) {
  const line = `[ORCH ${nowIso().slice(11, 19)}]${level ? ` [${level}]` : ''} ${message}`;
  if (CONFIG.verbose || level === 'ERROR' || level === 'WARN' || level === undefined) {
    if (level === 'ERROR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else if (CONFIG.verbose) console.log(line);
  }
  if (CONFIG.logToFile) {
    try {
      ensureDirFor(CONFIG.logFile);
      fs.appendFileSync(CONFIG.logFile, line + '\n', 'utf8');
    } catch (_) {
      /* логирование не должно ломать логику */
    }
  }
}

/** Безопасный require модуля из каталога evolution. */
function safeRequire(relName) {
  try {
    const candidate = path.isAbsolute(relName)
      ? relName
      : path.join(CONFIG.modulesDir, relName);
    return require(candidate);
  } catch (err) {
    return { __error: err && err.message ? err.message : String(err) };
  }
}

/** Свести произвольный результат модуля к компактному виду. */
function summarizeResult(result) {
  if (result === undefined || result === null) return { ok: true, empty: true };
  if (typeof result !== 'object') return { ok: true, value: String(result).slice(0, 200) };
  const out = { ok: result.ok !== false };
  if (typeof result.generation !== 'undefined') out.generation = result.generation;
  if (typeof result.generations !== 'undefined') out.generations = result.generations;
  if (typeof result.count !== 'undefined') out.count = result.count;
  if (typeof result.populationAfter !== 'undefined') out.populationAfter = result.populationAfter;
  if (typeof result.action !== 'undefined') out.action = result.action;
  if (Array.isArray(result.cycles)) out.cycles = result.cycles.length;
  if (Array.isArray(result.offspring)) out.offspring = result.offspring.length;
  return out;
}

/** Обернуть промис таймаутом (0/NaN → без таймаута). */
function withTimeout(promise, ms, label) {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

/* --------------------------------------------------------------------------- *
 * 3. Реестр модулей
 * --------------------------------------------------------------------------- */

/**
 * Список участников такта. Порядок важен: сначала «производящие» модули
 * (размножение/мутации), затем «аналитические» (отчёты/оценка), затем
 * «управляющие» (охрана/жнец/архитектор).
 *
 * Поле entry — имя публичного метода; если не задано, оркестратор ищет
 * первый доступный из списка DEFAULT_ENTRIES.
 */
const DEFAULT_ENTRIES = ['cycle', 'run', 'report', 'tick', 'evaluate', 'main', 'default'];

const MODULE_REGISTRY = [
  // 15.09: расширен — 20+ модулей Института
  // Core
  { name: 'breeding_cycle', file: 'breeding_cycle.js', entry: 'cycle', enabled: true },
  { name: 'hybrid_vitality', file: 'hybrid_vitality.js', entry: 'analyze', enabled: true },

  // Биолог
  { name: 'biologist_taxonomy', file: 'biologist_taxonomy.js', entry: 'taxonomyTree', enabled: true },
  { name: 'biologist_team_builder', file: 'biologist_team_builder.js', entry: 'buildTeam', enabled: false },

  // Химик
  { name: 'chemist_match', file: '../chemistry/chemist_match.js', entry: 'match', enabled: false },
  { name: 'task_profiler', file: '../chemistry/task_profiler.js', entry: 'profile', enabled: false },

  // Дендролог
  { name: 'dendrologist_genealogy', file: 'dendrologist_genealogy.js', entry: 'tree', enabled: true },
  { name: 'dendrologist_health', file: 'dendrologist_health.js', entry: 'summary', enabled: true },
  { name: 'dendrologist_rings', file: 'dendrologist_rings.js', entry: 'summary', enabled: true },

  // Миколог
  { name: 'mycologist_network', file: 'mycologist_network.js', entry: 'build', enabled: true },
  { name: 'mycologist_symbiosis', file: 'mycologist_symbiosis.js', entry: 'analyze', enabled: true },

  // Виды
  { name: 'species_classifier', file: 'species_classifier.js', entry: 'stats', enabled: true },
  { name: 'species_guard', file: 'species_guard.js', entry: 'check', enabled: true },
  { name: 'extinction_detector', file: 'extinction_detector.js', entry: null, enabled: true },

  // Метрики
  { name: 'fitness_history', file: 'fitness_history.js', entry: 'summary', enabled: true },
  { name: 'mutation_logger', file: 'mutation_logger.js', entry: 'count', enabled: true },
  { name: 'experience_aggregator', file: 'experience_aggregator.js', entry: 'aggregateAll', enabled: true },
  { name: 'academy_threshold', file: 'academy_threshold.js', entry: 'checkAll', enabled: true },
  { name: 'niche_finder', file: 'niche_finder.js', entry: 'findNiches', enabled: false },

  // Генерация
  { name: 'generation_report', file: 'generation_report.js', entry: 'report', enabled: true },
  { name: 'dna_architect', file: 'dna_architect.js', entry: null, enabled: false },

  // Санитары
  { name: 'reaper_v2', file: 'reaper_v2.js', entry: 'reap', enabled: true },

  // 18.09: модули, найденные инвентаризацией (были на диске, но не в реестре)
  { name: 'bioelectric_field', file: 'bioelectric_field.js', entry: null, enabled: true },
  { name: 'biologist_synergy', file: 'biologist_synergy.js', entry: null, enabled: true },
  { name: 'fitness_normalize', file: 'fitness_normalize.js', entry: null, enabled: true },
  { name: 'fitness_normalizer', file: 'fitness_normalizer.js', entry: null, enabled: true },
  { name: 'mutation', file: 'mutation.js', entry: null, enabled: true },
  { name: 'mycologist_signal', file: 'mycologist_signal.js', entry: null, enabled: true },
  { name: 'parent_selector', file: 'parent_selector.js', entry: null, enabled: true },
  { name: 'puppeteer', file: 'puppeteer.js', entry: null, enabled: true },
  { name: 'selection', file: 'selection.js', entry: null, enabled: true },
];

/** Найти entry-функцию в загруженном модуле. */
function resolveEntry(mod, preferred) {
  // 15.09: допускаем функцию верхнего уровня (module.exports = fn)
  if (!mod) return null;
  if (typeof mod === 'function') return { fn: mod, key: 'module' };
  if (typeof mod !== 'object') return null;
  if (preferred && typeof mod[preferred] === 'function') return { fn: mod[preferred], key: preferred };
  for (const key of DEFAULT_ENTRIES) {
    if (typeof mod[key] === 'function') return { fn: mod[key], key };
  }
  return null;
}

/* --------------------------------------------------------------------------- *
 * 4. Один такт
 * --------------------------------------------------------------------------- */

/**
 * Выполнить один такт эволюции: пройти по реестру и вызвать entry-функции.
 * @returns {Promise<object>} отчёт о такте
 */

// 15.09: обёртки для модулей, требующих данные
function getActiveAgents() {
  try {
    const fs = require('fs');
    const path = require('path');
    const fit = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'memory', 'fitness.json'), 'utf8'));
    return Object.keys(fit.agents || {});
  } catch (e) { return []; }
}

function getRecentRaces(n = 5) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'memory', 'races');
    return fs.readdirSync(dir)
      .filter(f => f.startsWith('race_') && f.endsWith('.json'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, n)
      .map(({ f }) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  } catch (e) { return []; }
}

async function tick() {

  if (STATE.ticking) {
    STATE.ticksSkipped += 1;
    log('такт пропущен: предыдущий ещё выполняется', 'WARN');
    return { ok: false, skipped: true, reason: 'overlap' };
  }
  STATE.ticking = true;

  const startedAt = Date.now();
  const report = {
    ok: true,
    tickNumber: STATE.ticks + 1,
    startedAt: nowIso(),
    modules: [],
    errors: [],
  };

  for (const spec of MODULE_REGISTRY) {
    if (!spec.enabled) {
      report.modules.push({ name: spec.name, ok: true, skipped: true });
      continue;
    }

    const modStat = STATE.modules[spec.name] || (STATE.modules[spec.name] = {
      runs: 0, ok: 0, failed: 0, lastOk: null, lastError: null, lastDurationMs: null,
    });

    const t0 = Date.now();
    try {
      let mod;
      if (spec.custom) {
        // Пользовательский entry: функция или объект с публичным методом.
        mod = spec.custom;
      } else {
        mod = safeRequire(spec.file);
        if (mod && mod.__error) {
          throw new Error(`require failed: ${mod.__error}`);
        }
      }
      const resolved = resolveEntry(mod, spec.entry);
      if (!resolved) {
        report.modules.push({ name: spec.name, ok: true, noEntry: true });
        continue;
      }

      // 15.09: специфичные вызовы для модулей, требующих аргументов
      let raw;
      if (spec.name === 'dendrologist_rings') {
        const agents = getActiveAgents();
        raw = agents.length ? resolved.fn(agents[0]) : { ok: true, skipped: 'no agents' };
      } else if (spec.name === 'mycologist_symbiosis') {
        const agents = getActiveAgents();
        raw = resolved.fn(agents);
      } else {
        raw = resolved.fn({ orchestrator: true, tick: report.tickNumber });
      }
      // 15.09: применяем таймаут к промису, чтобы залипший модуль не
      // блокировал весь такт (0/NaN в CONFIG → без таймаута).
      const value = (raw && typeof raw.then === 'function')
        ? await withTimeout(raw, CONFIG.moduleTimeoutMs, spec.name)
        : raw;

      const dt = Date.now() - t0;
      modStat.runs += 1;
      modStat.ok += 1;
      modStat.lastOk = nowIso();
      modStat.lastError = null;
      modStat.lastDurationMs = dt;

      report.modules.push({
        name: spec.name,
        entry: resolved.key,
        ok: true,
        durationMs: dt,
        summary: summarizeResult(value),
      });
    } catch (err) {
      const dt = Date.now() - t0;
      const msg = err && err.message ? err.message : String(err);
      modStat.runs += 1;
      modStat.failed += 1;
      modStat.lastError = msg;
      modStat.lastDurationMs = dt;

      report.ok = false;
      report.errors.push({ name: spec.name, error: msg });
      report.modules.push({ name: spec.name, ok: false, durationMs: dt, error: msg });
      log(`модуль ${spec.name} упал: ${msg}`, 'ERROR');
    }
  }

  const durationMs = Date.now() - startedAt;
  report.durationMs = durationMs;
  report.finishedAt = nowIso();

  STATE.ticking = false;
  STATE.ticks += 1;
  STATE.lastTickAt = report.finishedAt;
  STATE.lastTickDurationMs = durationMs;
  STATE.lastTickOk = report.ok;
  STATE.lastTickError = report.errors.length ? report.errors[0].error : null;
  if (report.ok) STATE.ticksOk += 1;
  else STATE.ticksFailed += 1;

  STATE.history.push({
    tick: STATE.ticks,
    at: report.finishedAt,
    ok: report.ok,
    durationMs,
    errors: report.errors.length,
  });
  if (STATE.history.length > CONFIG.historyLimit) {
    STATE.history.splice(0, STATE.history.length - CONFIG.historyLimit);
  }

  persistState();
  log(`такт #${STATE.ticks} завершён: ok=${report.ok}, ${durationMs}ms, ошибок=${report.errors.length}`);
  return report;
}

/* --------------------------------------------------------------------------- *
 * 5. Публичный API
 * --------------------------------------------------------------------------- */

/**
 * Запустить оркестратор.
 * @param {number} [interval] интервал между тактами, мс
 * @returns {object} снимок состояния
 */
function start(interval) {
  let ms = Number(interval);
  if (!Number.isFinite(ms) || ms <= 0) ms = CONFIG.defaultIntervalMs;
  if (ms < CONFIG.minIntervalMs) {
    log(`интервал ${ms}ms слишком мал, поднят до ${CONFIG.minIntervalMs}ms`, 'WARN');
    ms = CONFIG.minIntervalMs;
  }

  if (STATE.running) {
    log(`уже запущен (интервал ${STATE.intervalMs}ms) — перезапуск с ${ms}ms`, 'WARN');
    stop();
  }

  STATE.running = true;
  STATE.intervalMs = ms;
  STATE.startedAt = nowIso();
  STATE.stoppedAt = null;

  if (CONFIG.runOnStart) {
    try {
      Promise.resolve(tick()).catch((err) => log(`ошибка немедленного такта: ${err && err.message}`, 'ERROR'));
    } catch (err) {
      log(`ошибка немедленного такта: ${err && err.message}`, 'ERROR');
    }
  }

  STATE.timer = setInterval(() => {
    if (CONFIG.skipOverlapping && STATE.ticking) {
      STATE.ticksSkipped += 1;
      return;
    }
    try {
      Promise.resolve(tick()).catch((err) => log(`ошибка такта: ${err && err.message}`, 'ERROR'));
    } catch (err) {
      log(`ошибка такта: ${err && err.message}`, 'ERROR');
    }
  }, ms);

  if (STATE.timer && typeof STATE.timer.unref === 'function') {
    // Не держим event loop, если оркестратор — единственная активность.
    STATE.timer.unref();
  }

  log(`запущен: интервал ${ms}ms, runOnStart=${CONFIG.runOnStart}`);
  persistState();
  return status();
}

/**
 * Остановить оркестратор. Идемпотентно.
 * @returns {object} снимок состояния
 */
function stop() {
  if (STATE.timer) {
    clearInterval(STATE.timer);
    STATE.timer = null;
  }
  const wasRunning = STATE.running;
  STATE.running = false;
  STATE.stoppedAt = nowIso();
  if (wasRunning) log('остановлен');
  persistState();
  return status();
}

/**
 * Снимок текущего состояния оркестратора.
 * @returns {object}
 */
function status() {
  const uptimeMs = STATE.startedAt && STATE.running
    ? Date.now() - new Date(STATE.startedAt).getTime()
    : 0;

  const modules = {};
  for (const key of Object.keys(STATE.modules)) {
    const m = STATE.modules[key];
    modules[key] = { runs: m.runs, ok: m.ok, failed: m.failed, lastOk: m.lastOk, lastError: m.lastError };
  }

  return {
    ok: true,
    running: STATE.running,
    intervalMs: STATE.intervalMs,
    startedAt: STATE.startedAt,
    stoppedAt: STATE.stoppedAt,
    uptimeMs,
    ticks: STATE.ticks,
    ticksOk: STATE.ticksOk,
    ticksFailed: STATE.ticksFailed,
    ticksSkipped: STATE.ticksSkipped,
    lastTickAt: STATE.lastTickAt,
    lastTickDurationMs: STATE.lastTickDurationMs,
    lastTickOk: STATE.lastTickOk,
    lastTickError: STATE.lastTickError,
    modules,
    history: STATE.history.slice(-20),
    registered: MODULE_REGISTRY.map((m) => ({ name: m.name, file: m.file, enabled: !!m.enabled })),
    config: {
      defaultIntervalMs: CONFIG.defaultIntervalMs,
      minIntervalMs: CONFIG.minIntervalMs,
      runOnStart: CONFIG.runOnStart,
      skipOverlapping: CONFIG.skipOverlapping,
      moduleTimeoutMs: CONFIG.moduleTimeoutMs,
    },
  };
}

/**
 * Зарегистрировать дополнительный модуль/функцию в такте.
 * @param {string} name
 * @param {object|Function} entry
 */
function register(name, entry) {
  if (!name || !entry) return { ok: false, error: 'name и entry обязательны' };
  const exists = MODULE_REGISTRY.find((m) => m.name === name);
  const spec = { name, file: null, entry: null, enabled: true, custom: entry };
  if (exists) Object.assign(exists, spec);
  else MODULE_REGISTRY.unshift(spec);
  log(`зарегистрирован модуль: ${name}`);
  return { ok: true, name };
}

/** Список зарегистрированных модулей. */
function modules() {
  return MODULE_REGISTRY.map((m) => ({ name: m.name, file: m.file, enabled: !!m.enabled, custom: !!m.custom }));
}

/* --------------------------------------------------------------------------- *
 * 6. Персистентность
 * --------------------------------------------------------------------------- */

/** Сохранить состояние на диск (best-effort). */
function persistState() {
  try {
    ensureDirFor(CONFIG.stateFile);
    const snapshot = {
      running: STATE.running,
      intervalMs: STATE.intervalMs,
      startedAt: STATE.startedAt,
      stoppedAt: STATE.stoppedAt,
      ticks: STATE.ticks,
      ticksOk: STATE.ticksOk,
      ticksFailed: STATE.ticksFailed,
      ticksSkipped: STATE.ticksSkipped,
      lastTickAt: STATE.lastTickAt,
      lastTickDurationMs: STATE.lastTickDurationMs,
      lastTickOk: STATE.lastTickOk,
      lastTickError: STATE.lastTickError,
      modules: STATE.modules,
      history: STATE.history.slice(-20),
      savedAt: nowIso(),
    };
    fs.writeFileSync(CONFIG.stateFile, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    log(`не удалось сохранить состояние: ${err && err.message}`, 'WARN');
  }
}

/* --------------------------------------------------------------------------- *
 * 7. Экспорт
 * --------------------------------------------------------------------------- */

const API = {
  start,
  stop,
  status,
  tick,
  register,
  modules,
  CONFIG,
  STATE,
};

module.exports = API;
module.exports.default = API;

/* --------------------------------------------------------------------------- *
 * 8. CLI
 * --------------------------------------------------------------------------- */

if (require.main === module) {
  const cmd = process.argv[2] || 'demo';

  if (cmd === 'status') {
    console.log(JSON.stringify(status(), null, 2));
  } else if (cmd === 'once') {
    tick().then((r) => {
      console.log(JSON.stringify(r, null, 2));
    }).catch((err) => {
      console.error('tick error:', err && err.message);
      process.exitCode = 1;
    });
  } else if (cmd === 'demo') {
    const interval = Number(process.argv[3] || 2000);
    console.log(`[demo] start(${interval}ms), один такт, затем stop()`);
    start(interval);
    setTimeout(() => {
      console.log(JSON.stringify(status(), null, 2));
      stop();
    }, Math.max(interval, 500));
  } else {
    console.log('Usage: node evolution/evolution_orchestrator.js [status|once|demo [intervalMs]]');
  }
}
