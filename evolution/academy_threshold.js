'use strict';

/**
 * evolution/academy_threshold.js
 * ============================================================================
 * "Academy Threshold" — решает, каких пилотов/агентов нужно отправить
 * в Академию (переобучение, переработку промпта, breed+mutate).
 *
 * Управляющая идея
 * ----------------
 * Агент считается СЛАБЫМ и подлежит отправке в академию, если выполняется
 * ХОТЯ БЫ ОДНО из двух условий:
 *
 *   1. avg_score < 7  — средний счёт за последние 5 гонок ниже порога;
 *   2. stuck_rate > 30% — доля "залипших" гонок превышает порог.
 *
 * Публичный API
 * -------------
 *   shouldSendToAcademy(agentId, races[, config]) -> boolean
 *   checkAll(pilotsDir[, config])                 -> [{ agentId, ... }]
 *
 * Дополнительно (полезно для тестов и повторного использования):
 *   computeMetrics(races[, config])   -> { raceCount, avgScore, stuckRate, ... }
 *   analyzePilot(pilot[, config])     -> { agentId, sendToAcademy, reasons, ... }
 *   loadPilotFile(file)               -> races[]
 *   loadPilot(file)                   -> { agentId, races }
 *   DEFAULT_CONFIG                    -> пороги по умолчанию
 *
 * Зависимости: только Node.js >= 14 (fs, path). Ноль внешних пакетов.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

/* -------------------------------------------------------------------------- */
/* Конфигурация                                                               */
/* -------------------------------------------------------------------------- */

const DEFAULT_CONFIG = Object.freeze({
  // Сколько последних гонок учитываем (скользящее окно).
  windowSize: 5,
  // Порог среднего счёта: строго меньше -> в академию.
  avgScoreThreshold: 7,
  // Порог залипаний: строго больше (доля 0..1) -> в академию.
  stuckRateThreshold: 0.3,
  // Минимальное число гонок, чтобы вообще судить об агенте.
  minRaces: 1,
  // Поля, из которых можно достать числовой счёт гонки.
  scoreFields: ['score', 'avg_score', 'avgScore', 'points', 'result', 'rating'],
  // Поля-флаги "залипания".
  stuckFields: ['stuck', 'is_stuck', 'isStuck', 'stuck_flag', 'stuckFlag', 'slipped', 'stalled'],
  // Текстовый статус, помечающий гонку как залипшую/проваленную.
  stuckPattern: /stuck|stall|hung|hang|timeout|timed\s*out|dnf|did\s*not\s*finish|disqualif|forfeit|залип|провал|fail/i,
  // Агрегация счёта: геометрическое среднее штрафует низкие выбросы.
  aggregation: 'geometric',
});

/**
 * Мержит пользовательский конфиг с дефолтным и поддерживает legacy-алиасы.
 * @param {object} [config]
 * @returns {object}
 */
function mergeConfig(config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config || {});
  // Legacy-алиасы (старое имя полей в других версиях модуля).
  if (cfg.windowSize == null && cfg.window != null) cfg.windowSize = cfg.window;
  if (cfg.avgScoreThreshold == null && cfg.scoreThreshold != null) {
    cfg.avgScoreThreshold = cfg.scoreThreshold;
  }
  return cfg;
}

/* -------------------------------------------------------------------------- */
/* Утилиты                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Округление до заданного числа знаков без «плавающего мусора».
 * @param {number} value
 * @param {number} [digits]
 * @returns {number|null}
 */
function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

/**
 * Безопасное приведение к числу.
 * @param {*} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'object') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------------------- */
/* Нормализация гонок                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Приводит произвольное описание гонок к массиву объектов.
 * Принимает: массив чисел/объектов, JSON-строку, { races: [...] } и т.п.
 * @param {*} races
 * @returns {Array<object>}
 */
function normalizeRaces(races) {
  let list = races;
  if (list === null || list === undefined) return [];

  if (typeof list === 'string') {
    try {
      list = JSON.parse(list);
    } catch (_) {
      const n = toNumber(list);
      return n === null ? [] : [{ score: n }];
    }
  }

  if (list && !Array.isArray(list) && typeof list === 'object') {
    const keys = ['races', 'history', 'data', 'items', 'list', 'results', 'entries'];
    for (const key of keys) {
      if (Array.isArray(list[key])) {
        list = list[key];
        break;
      }
    }
  }

  if (!Array.isArray(list)) return [];

  const out = [];
  for (const item of list) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'number') {
      if (Number.isFinite(item)) out.push({ score: item });
      continue;
    }
    if (typeof item === 'string') {
      const n = toNumber(item);
      if (n !== null) out.push({ score: n });
      continue;
    }
    if (typeof item === 'object') out.push(item);
  }
  return out;
}

/**
 * Извлекает числовой счёт из записи о гонке.
 * @param {object} race
 * @param {object} config
 * @returns {number|null}
 */
function extractScore(race, config) {
  if (!race || typeof race !== 'object') return null;
  const cfg = mergeConfig(config);
  for (const field of cfg.scoreFields) {
    const n = toNumber(race[field]);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Определяет, была ли гонка «залипшей».
 * @param {object} race
 * @param {object} config
 * @returns {boolean}
 */
function isStuck(race, config) {
  if (!race || typeof race !== 'object') return false;
  const cfg = mergeConfig(config);

  for (const field of cfg.stuckFields) {
    const v = race[field];
    if (v === true || v === 1) return true;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === '1' || s === 'true' || s === 'yes' || s === 'y') return true;
    }
  }

  const status =
    typeof race.status === 'string'
      ? race.status
      : typeof race.state === 'string'
        ? race.state
        : typeof race.outcome === 'string'
          ? race.outcome
          : typeof race.result === 'string'
            ? race.result
            : null;

  if (status && cfg.stuckPattern.test(status)) return true;
  return false;
}

/**
 * Берёт последние N гонок (по timestamp/date, если есть, иначе — хвост).
 * @param {Array<object>} races
 * @param {number} windowSize
 * @returns {Array<object>}
 */
function takeRecent(races, windowSize) {
  if (!Array.isArray(races) || races.length <= windowSize) return races.slice();

  const getTs = (r) => {
    const raw = r.timestamp !== undefined ? r.timestamp : r.date !== undefined ? r.date : r.ts;
    if (raw === undefined) return null;
    const num = typeof raw === 'number' ? raw : Date.parse(raw);
    return Number.isFinite(num) ? num : null;
  };

  const timestamps = races.map(getTs);
  if (timestamps.every((t) => t !== null)) {
    return races
      .slice()
      .sort((a, b) => getTs(a) - getTs(b))
      .slice(-windowSize);
  }
  return races.slice(-windowSize);
}

/* -------------------------------------------------------------------------- */
/* Метрики                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Геометрическое среднее положительных значений.
 * Ноль/отрицательный счёт => 0 (гарантированно ниже порога => в академию).
 * @param {number[]} scores
 * @returns {number|null}
 */
function geoMean(scores) {
  if (!scores.length) return null;
  if (scores.some((s) => s <= 0)) return 0;
  let acc = 0;
  for (const s of scores) acc += Math.log(s);
  return Math.exp(acc / scores.length);
}

/**
 * Считает метрики агента по его истории гонок.
 * @param {*} races
 * @param {object} [config]
 * @returns {{raceCount:number, sampleSize:number, avgScore:number|null,
 *            meanScore:number|null, stuckRate:number, stuckCount:number,
 *            scores:number[]}}
 */
function computeMetrics(races, config) {
  const cfg = mergeConfig(config);
  const list = normalizeRaces(races);
  const recent = takeRecent(list, cfg.windowSize);

  const scores = [];
  let stuckCount = 0;
  for (const race of recent) {
    const score = extractScore(race, cfg);
    if (score !== null) scores.push(score);
    if (isStuck(race, cfg)) stuckCount += 1;
  }

  const raceCount = recent.length;
  const meanScore = scores.length
    ? round(scores.reduce((a, b) => a + b, 0) / scores.length, 2)
    : null;
  const avgScore =
    cfg.aggregation === 'arithmetic' ? meanScore : round(geoMean(scores), 2);
  const stuckRate = raceCount ? round(stuckCount / raceCount, 4) : 0;

  return {
    raceCount,
    sampleSize: raceCount,
    avgScore,
    meanScore,
    stuckRate,
    stuckCount,
    scores,
  };
}

/**
 * Псевдоним computeMetrics для обратной совместимости.
 */
const computeStats = computeMetrics;

/* -------------------------------------------------------------------------- */
/* Анализ одного пилота                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Полный разбор одного пилота: метрики + вердикт + причины.
 * @param {object|Array} pilot
 * @param {object} [config]
 * @returns {{agentId:string|null, sendToAcademy:boolean, avgScore:number|null,
 *            meanScore:number|null, stuckRate:number, raceCount:number,
 *            reasons:string[]}}
 */
function analyzePilot(pilot, config) {
  const cfg = mergeConfig(config);
  const p = pilot && typeof pilot === 'object' && !Array.isArray(pilot) ? pilot : {};

  const agentId = p.agentId || p.id || p.pilot || p.name || null;
  const races =
    Array.isArray(pilot)
      ? pilot
      : p.races || p.history || p.data || p.results || [];

  const metrics = computeMetrics(races, cfg);
  const reasons = [];

  const lowScore =
    metrics.avgScore !== null && metrics.avgScore < cfg.avgScoreThreshold;
  const highStuck = metrics.stuckRate > cfg.stuckRateThreshold;

  if (lowScore) {
    reasons.push(
      'avg_score ' + metrics.avgScore + ' < ' + cfg.avgScoreThreshold
    );
  }
  if (highStuck) {
    reasons.push(
      'stuck_rate ' +
        round(metrics.stuckRate * 100, 1) +
        '% > ' +
        round(cfg.stuckRateThreshold * 100, 0) +
        '%'
    );
  }

  const enoughData = metrics.raceCount >= cfg.minRaces;
  const sendToAcademy = enoughData && (lowScore || highStuck);

  return {
    agentId,
    sendToAcademy,
    avgScore: metrics.avgScore,
    meanScore: metrics.meanScore,
    stuckRate: metrics.stuckRate,
    raceCount: metrics.raceCount,
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Публичный API                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Решает, надо ли отправить агента в академию.
 * Критерий: avg_score < 7 (за окно) ИЛИ stuck_rate > 30%.
 *
 * @param {string} agentId
 * @param {Array|string} races история гонок агента
 * @param {object} [config] переопределения порогов
 * @returns {boolean}
 */
function shouldSendToAcademy(agentId, races, config) {
  const res = analyzePilot({ agentId, races }, config);
  if (res.sendToAcademy && agentId) {
    // Полезный след для отладки: почему агент улетает в академию.
    // eslint-disable-next-line no-console
    console.log('[academy] ' + agentId + ' -> academy (' + res.reasons.join(', ') + ')');
  }
  return res.sendToAcademy;
}

/**
 * Читает JSON-файл пилота и возвращает массив гонок.
 * Битый/отсутствующий файл -> [].
 * @param {string} file
 * @returns {Array<object>}
 */
function loadPilotFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return [];
  }
  return normalizeRaces(parsed);
}

/**
 * Читает файл пилота и возвращает дескриптор { agentId, races }.
 * @param {string} file
 * @returns {{agentId:string, races:*}}
 */
function loadPilot(file) {
  const fallback = path.basename(file).replace(/\.json$/i, '');
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return { agentId: fallback, races: [] };
  }
  if (Array.isArray(parsed)) return { agentId: fallback, races: parsed };
  if (parsed && typeof parsed === 'object') {
    const agentId =
      parsed.agentId || parsed.id || parsed.pilot || parsed.name || fallback;
    const races =
      parsed.races || parsed.history || parsed.data || parsed.results || [];
    return { agentId, races };
  }
  return { agentId: fallback, races: [] };
}

/**
 * Обходит каталог пилотов и возвращает список СЛАБЫХ агентов,
 * отсортированный от худшего к лучшему.
 *
 * Формат файла: массив гонок, либо { agentId, races: [...] },
 * либо пакет { pilots: [ {...}, {...} ] }.
 *
 * @param {string} pilotsDir
 * @param {object} [config]
 * @returns {Array<object>} [{ agentId, sendToAcademy, avgScore, stuckRate, reasons }]
 */
function checkAll(pilotsDir, config) {
  // 18.09 v2: критерий «слабый агент» — только по fitness и wins.
  // Не трогаем: wins >= 5 (доказал способность побеждать).
  // Не трогаем: fitness >= 5.0 (топ).
  // Не трогаем: runs < 20 (рано судить).
  // Отправляем в Академию: fitness < 1.5 И wins < 3.
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const fitPath = path.join(ROOT, 'memory', 'fitness.json');

  const MIN_RUNS = 20;
  const MAX_FITNESS = 1.5;
  const MIN_WINS_SAFE = 5;
  const PROTECTED_FITNESS = 5.0;

  if (!fs.existsSync(fitPath)) {
    console.log('[academy] fitness.json не найден');
    return [];
  }

  try {
    const fit = JSON.parse(fs.readFileSync(fitPath, 'utf8'));
    const agents = Object.values(fit.agents || {});
    const weak = [];

    for (const a of agents) {
      const fitness = a.fitness || 0;
      const runs = a.runs_total || 0;
      const wins = a.wins_total || 0;
      const avgScore = a.last_score_avg || 0;
      const winRate = runs ? (wins / runs) : 0;

      // Защита: топ-агенты
      if (fitness >= PROTECTED_FITNESS) continue;
      // Защита: тот, кто доказал способность побеждать
      if (wins >= MIN_WINS_SAFE) continue;
      // Защита: новички
      if (runs < MIN_RUNS) continue;
      // Слабый только если fitness низкий
      if (fitness >= MAX_FITNESS) continue;

      weak.push({
        agentId: a.box,
        sendToAcademy: true,
        avgScore: avgScore,
        fitness: fitness,
        winRate: winRate,
        runs: runs,
        wins: wins,
        stuckRate: 0,
        reasons: [
          'fitness ' + fitness.toFixed(2) + ' < ' + MAX_FITNESS,
          'wins ' + wins + ' < ' + MIN_WINS_SAFE,
        ],
      });
    }

    console.log('[academy] Проверено: ' + agents.length + ' | Слабых: ' + weak.length);
    return weak;
  } catch (e) {
    console.log('[academy] Ошибка:', e.message);
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 16.09: checkAllFromBoxes — собрать pilots из boxes/ + memory/races/.
 * Читает fitness.json для метрик, races для истории.
 */
function checkAllFromBoxes(cfg) {
  const ROOT = path.join(__dirname, '..');
  const BOXES = path.join(ROOT, 'boxes');
  const RACES = path.join(ROOT, 'memory', 'races');
  const FITNESS = path.join(ROOT, 'memory', 'fitness.json');
  const weak = [];

  // 1. Читаем fitness.json — метрики агентов
  let fitness = { agents: {} };
  try { fitness = JSON.parse(fs.readFileSync(FITNESS, 'utf8')); } catch (_) {}

  // 2. Собираем все боксы
  let boxes;
  try {
    boxes = fs.readdirSync(BOXES).filter(f => /^agent_\d+$/.test(f));
  } catch (_) { return weak; }

  // 3. Проходим по боксам
  for (const box of boxes) {
    const f = fitness.agents && fitness.agents[box];
    if (!f) continue;

    const fitValue = typeof f.fitness === 'number' ? f.fitness : 0;
    const runs = f.runs_total || 0;
    const wins = f.wins_total || 0;
    const winRate = runs > 0 ? wins / runs : 0;
    const avgScore = f.last_score_avg || 0;

    // Вердикт: fitness < 1 ИЛИ (runs >= 5 И winRate < 0.2)
    const sendToAcademy =
      fitValue < (cfg.minFitness || 1.0) ||
      (runs >= 5 && winRate < 0.2) ||
      avgScore < (cfg.minAvgScore || 3.0);

    if (sendToAcademy) {
      weak.push({
        agentId: box,
        sendToAcademy: true,
        avgScore: fitValue,
        fitness: fitValue,
        winRate: +winRate.toFixed(2),
        runs, wins,
        stuckRate: 0,
        reasons: [
          fitValue < 1.0 ? `fitness ${fitValue} < 1.0` : null,
          winRate < 0.2 && runs >= 5 ? `winRate ${winRate.toFixed(2)} < 0.2` : null,
          avgScore < 3.0 ? `avgScore ${avgScore} < 3.0` : null,
        ].filter(Boolean),
      });
    }
  }

  // Сортируем — худший первым
  weak.sort((a, b) => a.fitness - b.fitness);
  return weak;
}

/**
 * 16.09: moveToAcademy — переносим слабого агента в arena/academy/candidate_N/
 */
function moveToAcademy(agentId) {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(__dirname, '..');
  const BOXES = path.join(ROOT, 'boxes');
  const ACADEMY = path.join(ROOT, 'arena', 'academy');

  const srcBox = path.join(BOXES, agentId);
  if (!fs.existsSync(srcBox)) {
    return { ok: false, error: 'box not found: ' + agentId };
  }

  // Найти свободный слот candidate_N
  fs.mkdirSync(ACADEMY, { recursive: true });
  let n = 1;
  while (fs.existsSync(path.join(ACADEMY, `candidate_${n}`))) n++;
  const dstBox = path.join(ACADEMY, `candidate_${n}`);

  // Переместить
  try {
    fs.renameSync(srcBox, dstBox);
  } catch (e) {
    // Если перекрёстные ФС — копируем
    require('child_process').execSync(`cp -r "${srcBox}" "${dstBox}" && rm -rf "${srcBox}"`);
  }

  // Записать карточку
  const card = {
    agentId,
    ts: new Date().toISOString(),
    candidate: `candidate_${n}`,
    reason: 'fitness below threshold',
    status: 'in_academy',
  };
  fs.writeFileSync(path.join(dstBox, 'ACADEMY_CARD.json'), JSON.stringify(card, null, 2));

  return { ok: true, candidate: `candidate_${n}`, path: dstBox };
}

module.exports = {
  shouldSendToAcademy,
  checkAll,
  checkAllFromBoxes,
  moveToAcademy,
  computeMetrics,
  computeStats,
  analyzePilot,
  loadPilotFile,
  loadPilot,
  normalizeRaces,
  extractScore,
  isStuck,
  round,
  DEFAULT_CONFIG,
};
