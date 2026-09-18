#!/usr/bin/env node
/**
 * evolution/experience_aggregator.js
 * ============================================================================
 * Experience Aggregator — агрегатор накопленного опыта пилотов.
 *
 * Что делает:
 *   1. Обходит каталог `boxes/agent_*` и читает у каждого пилота файл
 *      `memory/experience.jsonl` (по одной JSON-записи на строку).
 *   2. Толерантно парсит записи (битые строки пропускаются, а не роняют обход).
 *   3. Считает по каждому пилоту три ключевые метрики:
 *        - score    — средний балл (взвешенный по числу задач);
 *        - tasks    — суммарное количество выполненных задач;
 *        - ok_rate  — доля успешных задач (ok_count / total_tasks).
 *   4. Умеет писать сводку в `memory/experience_summary.json`
 *      (глобально и/или по каждому пилоту).
 *
 * Формат строки `experience.jsonl` (см. boxes/agent_1/memory/experience.jsonl):
 *   {
 *     "clone_id": "agent_1_clone_...",
 *     "pilot": "agent_1",
 *     "race_id": "race_...",
 *     "dna_hash": "sha256:...",
 *     "attempts": [ { "task": "...", "ok": true, "score": 9, "tools_used": [] } ],
 *     "insights": [],
 *     "score_avg": 9,        // может отсутствовать — тогда считаем из attempts
 *     "ok_count": 1,         // алиасы: ok, okCount, successes
 *     "total_tasks": 1,      // алиасы: tasks, total, attempts.length
 *     "archived_at": "2026-09-13T18:01:21.798Z"
 *   }
 *
 * Публичный API:
 *   const { aggregateAll, writeSummary } = require('./evolution/experience_aggregator');
 *
 *   const agg = aggregateAll();
 *   // => { agent_1: { score: 8.5, tasks: 2, ok_rate: 1 }, ... }
 *
 *   const res = writeSummary();
 *   // => { file, agents, total_tasks, written: [...] }
 *
 *   // Можно передать уже посчитанный агрегат, чтобы не считать дважды:
 *   writeSummary(aggregateAll());
 *
 * Зависимости: только Node.js >= 16 (fs, path). Никаких внешних пакетов.
 *
 * CLI:
 *   node evolution/experience_aggregator.js            # посчитать + записать
 *   node evolution/experience_aggregator.js --dry-run  # только посчитать
 *   node evolution/experience_aggregator.js --json     # вывести агрегат в stdout
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------------------------
 * 0. Конфигурация путей
 * ------------------------------------------------------------------------ */

// Корень проекта (phoenix). Можно переопределить через ENV для тестов.
const ROOT_DIR = process.env.EXP_AGG_ROOT || path.resolve(__dirname, '..');

// Каталог с боксами агентов: boxes/agent_*/
const BOXES_DIR = process.env.EXP_AGG_BOXES_DIR || path.join(ROOT_DIR, 'boxes');

// Глобальный файл сводки (по умолчанию <root>/memory/experience_summary.json).
const SUMMARY_FILE =
  process.env.EXP_AGG_SUMMARY_FILE ||
  path.join(ROOT_DIR, 'memory', 'experience_summary.json');

// Имя исходного файла опыта внутри бокса и имя итоговой сводки.
const EXPERIENCE_FILENAME = 'experience.jsonl';
const SUMMARY_FILENAME = 'experience_summary.json';

/* ---------------------------------------------------------------------------
 * 1. Утилиты
 * ------------------------------------------------------------------------ */

/** Округление до заданного числа знаков (без «плавающего мусора»). */
function round(value, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Безопасное приведение к числу. */
function toNumber(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Безопасное чтение файла: возвращает '' если файла нет / нет доступа. */
function safeReadFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return '';
  }
}

/** Есть ли каталог. */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    return false;
  }
}

/**
 * Парсер JSONL: одна JSON-запись на строку.
 * Битые строки не роняют парсер, а попадают в `errors`.
 */
function parseJsonl(text) {
  const entries = [];
  const errors = [];
  if (!text) return { entries, errors };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') entries.push(obj);
    } catch (err) {
      errors.push({ line: i + 1, message: err.message });
    }
  }
  return { entries, errors };
}

/** Извлекает имя пилота из записи или из имени файла/каталога. */
function resolveAgentName(entry, fallback) {
  if (entry && typeof entry.pilot === 'string' && entry.pilot) return entry.pilot;
  if (entry && typeof entry.agent === 'string' && entry.agent) return entry.agent;
  if (entry && typeof entry.agentId === 'string' && entry.agentId) return entry.agentId;
  return fallback;
}

/* ---------------------------------------------------------------------------
 * 2. Нормализация одной записи опыта
 * ------------------------------------------------------------------------ */

/**
 * Достаёт из записи число задач и сумму успехов, учитывая разнообразие полей.
 * @returns {{tasks:number, ok:number}}
 */
function extractCounts(entry) {
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : null;

  // Число задач: явное поле либо длина attempts.
  let tasks = toNumber(
    entry.total_tasks != null ? entry.total_tasks
      : entry.tasks != null ? entry.tasks
        : entry.total != null ? entry.total
          : attempts ? attempts.length : 0,
    0,
  );

  // Успехи: ok_count / ok / successes, иначе считаем по attempts.
  let ok;
  if (entry.ok_count != null) ok = toNumber(entry.ok_count, 0);
  else if (entry.okCount != null) ok = toNumber(entry.okCount, 0);
  else if (entry.successes != null) ok = toNumber(entry.successes, 0);
  else if (entry.ok != null && typeof entry.ok === 'boolean') ok = entry.ok ? 1 : 0;
  else if (attempts) ok = attempts.filter((a) => a && a.ok === true).length;
  else ok = 0;

  if (tasks <= 0 && attempts) tasks = attempts.length;
  if (tasks < 0) tasks = 0;
  if (ok < 0) ok = 0;
  if (ok > tasks && tasks > 0) ok = tasks;
  return { tasks, ok };
}

/**
 * Средний балл записи. Приоритет — явный score_avg; иначе среднее по attempts.
 * Если данных нет — возвращает null (такая запись не влияет на средний балл).
 */
function extractScore(entry) {
  if (entry.score_avg != null) return toNumber(entry.score_avg, 0);
  if (entry.avg_score != null) return toNumber(entry.avg_score, 0);
  if (entry.score != null && typeof entry.score !== 'object') {
    return toNumber(entry.score, 0);
  }
  const attempts = Array.isArray(entry.attempts) ? entry.attempts : null;
  if (!attempts || attempts.length === 0) return null;
  const scored = attempts
    .map((a) => (a ? toNumber(a.score, NaN) : NaN))
    .filter((v) => Number.isFinite(v));
  if (scored.length === 0) return null;
  return scored.reduce((acc, v) => acc + v, 0) / scored.length;
}

/**
 * Нормализует одну запись опыта к внутреннему виду.
 * @returns {{agent:string, tasks:number, ok:number, score:number|null, archived_at:string|null}}
 */
function normalizeEntry(entry, fallbackAgent) {
  const { tasks, ok } = extractCounts(entry);
  return {
    agent: resolveAgentName(entry, fallbackAgent),
    tasks,
    ok,
    score: extractScore(entry),
    archived_at: entry.archived_at || entry.ts || entry.timestamp || null,
  };
}

/* ---------------------------------------------------------------------------
 * 3. Обнаружение и чтение файлов опыта
 * ------------------------------------------------------------------------ */

/**
 * Находит все боксы агентов `boxes/agent_*` и соответствующие jsonl-файлы.
 * @returns {Array<{agent:string, file:string, exists:boolean}>}
 */
function discoverExperienceFiles(boxesDir = BOXES_DIR) {
  const found = [];
  if (!isDir(boxesDir)) return found;

  let dirents = [];
  try {
    dirents = fs.readdirSync(boxesDir, { withFileTypes: true });
  } catch (err) {
    return found;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (!/^agent_/.test(dirent.name)) continue;

    const file = path.join(boxesDir, dirent.name, 'memory', EXPERIENCE_FILENAME);
    found.push({ agent: dirent.name, file, exists: fs.existsSync(file) });
  }

  // Стабильный порядок: agent_1, agent_2, ... agent_10 (натуральная сортировка).
  found.sort((a, b) => a.agent.localeCompare(b.agent, undefined, { numeric: true }));
  return found;
}

/**
 * Читает и нормализует записи одного файла опыта.
 * @returns {{records:Array, errors:Array, agent:string, file:string}}
 */
function readExperienceFile(file, agent) {
  const text = safeReadFile(file);
  const { entries, errors } = parseJsonl(text);
  const records = entries.map((e) => normalizeEntry(e, agent));
  return { records, errors, agent, file };
}

/* ---------------------------------------------------------------------------
 * 4. Агрегация
 * ------------------------------------------------------------------------ */

/** Пустой аккумулятор метрик одного пилота. */
function emptyAccumulator(agent) {
  return {
    agent,
    scoreWeighted: 0, // сумма (score * tasks) для взвешенного среднего
    scoreWeight: 0,   // сумма задач, участвовавших в оценке
    scoreSimple: 0,   // простая сумма score (fallback, когда tasks=0)
    scoreSimpleN: 0,  // количество записей с оценкой
    tasks: 0,
    ok: 0,
    entries: 0,
    malformed: 0,
    last_at: null,
  };
}

/** Финализирует аккумулятор в публичный объект {score, tasks, ok_rate}. */
function finalizeAccumulator(acc) {
  let score = 0;
  if (acc.scoreWeight > 0) {
    score = acc.scoreWeighted / acc.scoreWeight;
  } else if (acc.scoreSimpleN > 0) {
    score = acc.scoreSimple / acc.scoreSimpleN;
  }
  const okRate = acc.tasks > 0 ? acc.ok / acc.tasks : 0;
  return {
    score: round(score, 2),
    tasks: Math.round(acc.tasks),
    ok_rate: round(okRate, 3),
    ok: Math.round(acc.ok),
    entries: acc.entries,
    malformed: acc.malformed,
    last_at: acc.last_at,
  };
}

/**
 * Сливает одну нормализованную запись в аккумулятор пилота.
 * Записи с tasks=0 не портят взвешенное среднее: они идут в простой fallback.
 */
function mergeRecord(acc, rec) {
  acc.entries += 1;
  acc.tasks += rec.tasks;
  acc.ok += rec.ok;

  if (rec.score != null) {
    if (rec.tasks > 0) {
      acc.scoreWeighted += rec.score * rec.tasks;
      acc.scoreWeight += rec.tasks;
    } else {
      acc.scoreSimple += rec.score;
      acc.scoreSimpleN += 1;
    }
  }

  if (rec.archived_at && (!acc.last_at || rec.archived_at > acc.last_at)) {
    acc.last_at = rec.archived_at;
  }
}

/**
 * aggregateAll — главная функция агрегации.
 *
 * @param {object} [options]
 * @param {string} [options.boxesDir] — переопределить каталог боксов.
 * @param {boolean} [options.includeEmpty=false] — включать пилотов без опыта.
 * @returns {Object<string, {score:number, tasks:number, ok_rate:number}>}
 */
function aggregateAll(options = {}) {
  const boxesDir = options.boxesDir || BOXES_DIR;
  const includeEmpty = options.includeEmpty === true;

  const files = discoverExperienceFiles(boxesDir);
  const accumulators = new Map();

  for (const item of files) {
    if (!item.exists) continue;
    const { records, errors } = readExperienceFile(item.file, item.agent);
    if (records.length === 0 && errors.length === 0 && !includeEmpty) {
      // Пустой файл — пилот без опыта; по умолчанию не показываем.
      continue;
    }
    if (!accumulators.has(item.agent)) {
      accumulators.set(item.agent, emptyAccumulator(item.agent));
    }
    const acc = accumulators.get(item.agent);
    acc.malformed += errors.length;
    for (const rec of records) {
      // Пилот может быть явно указан в записи и отличаться от имени бокса.
      const key = rec.agent || item.agent;
      if (!accumulators.has(key)) {
        accumulators.set(key, emptyAccumulator(key));
      }
      mergeRecord(accumulators.get(key), rec);
    }
  }

  const result = {};
  const keys = Array.from(accumulators.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  for (const key of keys) {
    const finalized = finalizeAccumulator(accumulators.get(key));
    if (!includeEmpty && finalized.tasks === 0 && finalized.entries === 0) continue;
    result[key] = finalized;
  }
  return result;
}

/** Суммарные метрики по всем пилотам (для шапки сводки). */
function totalsOf(agg) {
  let tasks = 0;
  let ok = 0;
  let scoreWeighted = 0;
  let scoreWeight = 0;
  let agents = 0;

  for (const key of Object.keys(agg)) {
    const a = agg[key];
    if (!a) continue;
    agents += 1;
    tasks += toNumber(a.tasks, 0);
    ok += toNumber(a.ok, 0);
    if (toNumber(a.tasks, 0) > 0) {
      scoreWeighted += toNumber(a.score, 0) * toNumber(a.tasks, 0);
      scoreWeight += toNumber(a.tasks, 0);
    }
  }

  return {
    agents,
    tasks,
    ok,
    ok_rate: tasks > 0 ? round(ok / tasks, 3) : 0,
    score: scoreWeight > 0 ? round(scoreWeighted / scoreWeight, 2) : 0,
  };
}

/* ---------------------------------------------------------------------------
 * 5. Запись сводки
 * ------------------------------------------------------------------------ */

/** Гарантированно создаёт каталог для файла. */
function ensureDirForFile(file) {
  const dir = path.dirname(file);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    /* каталог уже существует либо нет прав — обработается при записи */
  }
}

/**
 * writeSummary — пишет сводку в memory/experience_summary.json.
 *
 * @param {object} [agg] — уже посчитанный агрегат (иначе вызовет aggregateAll()).
 * @param {object} [options]
 * @param {string} [options.file]        — путь к глобальному файлу сводки.
 * @param {string} [options.boxesDir]    — каталог боксов (для пер-агентных сводок).
 * @param {boolean} [options.perAgent=true] — писать ли сводку в memory каждого пилота.
 * @param {boolean} [options.dryRun=false]  — если true, ничего не пишет на диск.
 * @returns {{file:string, written:string[], agents:number, total_tasks:number, data:object}}
 */
function writeSummary(agg, options = {}) {
  const aggregate = agg && typeof agg === 'object' ? agg : aggregateAll(options);
  const file = options.file || SUMMARY_FILE;
  const boxesDir = options.boxesDir || BOXES_DIR;
  const perAgent = options.perAgent !== false;
  const dryRun = options.dryRun === true;

  const totals = totalsOf(aggregate);
  const payload = {
    generated_at: new Date().toISOString(),
    generator: 'evolution/experience_aggregator.js',
    source_dir: boxesDir,
    total_agents: totals.agents,
    total_tasks: totals.tasks,
    totals,
    agents: aggregate,
  };

  const written = [];

  if (!dryRun) {
    ensureDirForFile(file);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    written.push(file);
  }

  if (perAgent) {
    for (const key of Object.keys(aggregate)) {
      const boxMemory = path.join(boxesDir, key, 'memory');
      if (!isDir(path.join(boxesDir, key))) continue; // нет такого бокса — пропускаем
      const perFile = path.join(boxMemory, SUMMARY_FILENAME);
      if (dryRun) {
        written.push(perFile);
        continue;
      }
      ensureDirForFile(perFile);
      const perPayload = {
        generated_at: payload.generated_at,
        generator: payload.generator,
        agent: key,
        summary: aggregate[key],
      };
      fs.writeFileSync(perFile, JSON.stringify(perPayload, null, 2) + '\n', 'utf8');
      written.push(perFile);
    }
  }

  return {
    file,
    written,
    agents: totals.agents,
    total_tasks: totals.tasks,
    data: payload,
  };
}

/* ---------------------------------------------------------------------------
 * 6. Экспорт
 * ------------------------------------------------------------------------ */

module.exports = {
  aggregateAll,
  writeSummary,
  // Вспомогательные функции (полезны для тестов и переиспользования):
  parseJsonl,
  normalizeEntry,
  discoverExperienceFiles,
  readExperienceFile,
  totalsOf,
  // Конфигурация (только чтение для внешних потребителей):
  CONFIG: Object.freeze({
    ROOT_DIR,
    BOXES_DIR,
    SUMMARY_FILE,
    EXPERIENCE_FILENAME,
    SUMMARY_FILENAME,
  }),
  _internals: {
    round,
    toNumber,
    extractCounts,
    extractScore,
    mergeRecord,
    finalizeAccumulator,
    emptyAccumulator,
  },
};

/* ---------------------------------------------------------------------------
 * 7. CLI
 * ------------------------------------------------------------------------ */

if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const asJson = args.includes('--json');

  const agg = aggregateAll();

  if (asJson || dryRun) {
    if (asJson) {
      console.log(JSON.stringify(agg, null, 2));
    } else {
      console.log('Aggregated pilots:', Object.keys(agg).length);
      for (const key of Object.keys(agg)) {
        const a = agg[key];
        console.log(
          `  ${key}: score=${a.score} tasks=${a.tasks} ok_rate=${a.ok_rate}`,
        );
      }
    }
  }

  if (!dryRun) {
    const res = writeSummary(agg);
    console.log(
      `Summary written: ${res.file} (agents=${res.agents}, ` +
        `total_tasks=${res.total_tasks}, files=${res.written.length})`,
    );
  }
}
