// agent_13.js — «Хронометрист» (Chronometrician)
//
// УНИКАЛЬНАЯ СТРАТЕГИЯ: ИЗМЕРЕНИЕ И ЖУРНАЛ (measurement & journal).
// Её нет ни у одного из agent_1..agent_12.
//
// Все предыдущие агенты вмешиваются в решение задачи: меняют промпт,
// делают несколько проходов, атакуют собственный ответ, синтезируют гибрид.
// Хронометрист устроен принципиально иначе: он НЕ ВЛИЯЕТ на решение.
//
//   1) ЗАДАЧА ИДЁТ ТРАНЗИТОМ. Промпт передаётся в agent_loop_v3
//      БЕЗ ИЗМЕНЕНИЙ и без добавления директив — иначе измерение исказило бы
//      измеряемое (наблюдатель не должен двигать объект наблюдения).
//   2) ИЗМЕРЕНИЕ. Замеряется время выполнения (process.hrtime), score критика,
//      число шагов и попыток, тип задачи и использованные скиллы.
//   3) ЖУРНАЛ. Каждый прогон дописывается в memory/chronicle/YYYY-MM-DD.json
//      (запись атомарная: tmp + rename, дневной файл не теряется при сбое).
//   4) АГРЕГАЦИЯ РАЗ В 24 ЧАСА. Проверяется отметка в
//      memory/chronicle/aggregate_state.json; если прошло >= 24 ч (или отметки
//      нет — первый запуск), считается агрегат: средний score за день,
//      тренд за неделю, топ-3 агента. Результат пишется в
//      memory/chronicle/aggregate-YYYY-MM-DD.json.
//   5) ЭКСПОРТ. { runAgent, STRATEGY, getTrend, getSnapshot } — getTrend и
//      getSnapshot дают доступ к накопленным измерениям без запуска задачи.
//
// Отличие от «Документатора» (agent_6) и «Ментора» (agent_12): те пишут
// человекочитаемые .md-уроки о своём прогоне. Хронометрист пишет
// МАШИНОЧИТАЕМЫЕ измерения по всем агентам и умеет отвечать на вопросы
// «как менялся score за неделю» и «кто из агентов лучший» — то есть
// это не рассказ о себе, а приборная панель всего роя.
//
// ВАЖНО: agent_loop_v3.runWithCritic(prompt) принимает только промпт,
// поэтому транзит задачи — это отсутствие каких-либо добавок к промпту.

const fs = require('fs');
const path = require('path');
const loop = require('./agent_loop_v3');

const STRATEGY = 'chronometrician: measurement-and-journal - pass the task through unchanged, time it, journal score/duration/task-type/skills to memory/chronicle/YYYY-MM-DD.json, aggregate every 24h';

/** Каталог хроники (рядом с агентом — работает и в корне, и внутри бокса). */
const CHRONICLE_DIR = path.join(__dirname, 'memory', 'chronicle');
/** Отметка последней агрегации (файл-курсор, а не отдельная БД). */
const STATE_FILE = path.join(CHRONICLE_DIR, 'aggregate_state.json');
/** Период агрегации: раз в 24 часа. */
const AGGREGATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Окно тренда: неделя. */
const TREND_DAYS = 7;
/** Сколько агентов попадает в топ агрегата. */
const TOP_N = 3;
/** Версия схемы записи — чтобы старые файлы хроники читались однозначно. */
const SCHEMA_VERSION = 1;
/** Идентификатор агента-автора записи. */
const AGENT_ID = 'agent_13';
/** Предохранитель от неограниченного роста дневного файла. */
const MAX_RECORDS_PER_DAY = 5000;

/* ------------------------------------------------------------------ *
 * 1. Время и пути
 * ------------------------------------------------------------------ */

/**
 * Штамп даты в формате YYYY-MM-DD (UTC) — имя дневного файла хроники.
 * @param {Date|number} [date] — момент времени (по умолчанию сейчас).
 * @returns {string} 'YYYY-MM-DD'.
 */
function dayStamp(date) {
  const d = (date instanceof Date) ? date : new Date(date === undefined ? Date.now() : date);
  if (isNaN(d.getTime())) {
    // Некорректная дата не должна ронять измерение: пишем в «сегодня».
    return new Date().toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Путь к дневному файлу хроники для штампа.
 * @param {string} stamp — 'YYYY-MM-DD'.
 * @returns {string} абсолютный путь.
 */
function dayFile(stamp) {
  return path.join(CHRONICLE_DIR, String(stamp) + '.json');
}

/**
 * Время в миллисекундах с высоким разрешением (монотонное, не зависит от NTP).
 * @returns {number} мс с плавающей точкой.
 */
function hrNow() {
  /* TODO */
}

/* ------------------------------------------------------------------ *
 * 2. Безопасный ввод-вывод
 * ------------------------------------------------------------------ */

/**
 * Читает JSON, не бросая исключений: битый или отсутствующий файл -> fallback.
 * @param {string} file — путь.
 * @param {*} [fallback] — значение по умолчанию.
 * @returns {*} разобранный JSON либо fallback.
 */
function readJsonSafe(file, fallback) {
  try {
    if (!file) return fallback;
    const text = fs.readFileSync(file, 'utf8');
    if (!text || !text.trim()) return fallback;
    return JSON.parse(text);
  } catch (err) {
    // Битый/отсутствующий файл — не роняем измерение, отдаём fallback.
    return fallback;
  }
}

/**
 * Атомарная запись JSON: mkdir -p, запись в tmp-файл, затем rename.
 * @param {string} file — путь назначения.
 * @param {*} data — сериализуемое значение.
 * @returns {{ok: boolean, error?: string}} результат записи.
 */
function writeJsonAtomic(file, data) {
  /* TODO */
}

/* ------------------------------------------------------------------ *
 * 3. Извлечение метрик из результата прогона
 * ------------------------------------------------------------------ */

/**
 * Извлекает score критика из результата agent_loop_v3.
 * Score лежит либо в result.critic.score, либо в последней попытке
 * result.attempts[].critic.score (когда цикл исчерпал попытки).
 * @param {object} result — результат loop.runWithCritic.
 * @returns {number|null} score 1..10 либо null, если оценка недоступна.
 */
function extractScore(result) {
  /* TODO */
}

/**
 * Собирает реально использованные инструменты из шагов исполнения.
 * @param {Array<{tool: string, ok: boolean}>} steps — result.steps.
 * @returns {{tools: string[], counts: Object, failed: string[]}} сводка по инструментам.
 */
function extractToolsUsed(steps) {
  /* TODO */
}

/**
 * Классифицирует задачу по тексту промпта (тип нужен для агрегата).
 * @param {string} prompt — задача.
 * @returns {string} 'codegen' | 'read-only' | 'test' | 'refactor' | 'analysis' | 'other'.
 */
function classifyTask(prompt) {
  /* TODO */
}

/**
 * Определяет использованные скиллы: явно переданные, упомянутые в промпте
 * и (как отдельно помеченные) предполагаемые по типу задачи.
 * @param {string} prompt — задача.
 * @param {object} [options] — { skills: string[] } явный список.
 * @returns {{skills: string[], declared: string[], observed: string[], inferred: string[]}}
 */
function extractSkills(prompt, options) {
  /* TODO */
}

/* ------------------------------------------------------------------ *
 * 4. Журнал хроники
 * ------------------------------------------------------------------ */

/**
 * Читает дневной файл хроники.
 * @param {string} stamp — 'YYYY-MM-DD'.
 * @returns {{date: string, schema: number, records: Array<object>}} день хроники.
 */
function loadDay(stamp) {
  const empty = { date: String(stamp), schema: SCHEMA_VERSION, records: [] };
  const raw = readJsonSafe(dayFile(stamp), null);
  if (!raw) return empty;
  // Основной формат — { date, schema, records: [...] }.
  if (typeof raw === 'object' && Array.isArray(raw.records)) {
    return {
      date: typeof raw.date === 'string' ? raw.date : String(stamp),
      schema: (typeof raw.schema === 'number') ? raw.schema : SCHEMA_VERSION,
      records: raw.records,
    };
  }
  // Терпимость к «голому» массиву записей.
  if (Array.isArray(raw)) {
    return { date: String(stamp), schema: SCHEMA_VERSION, records: raw };
  }
  return empty;
}

/**
 * Список штампов дней, по которым есть файлы хроники (отсортирован по возрастанию).
 * @returns {string[]} массив 'YYYY-MM-DD'.
 */
function listDays() {
  try {
    if (!fs.existsSync(CHRONICLE_DIR)) return [];
    return fs.readdirSync(CHRONICLE_DIR)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  } catch (err) {
    return [];
  }
}

/**
 * Дописывает одну запись измерения в дневной файл хроники.
 * @param {object} record — запись измерения.
 * @returns {{path: string, appended: boolean, records: number, error?: string}}
 */
function appendRecord(record) {
  /* TODO */
}

/* ------------------------------------------------------------------ *
 * 5. Агрегация, тренд, снимок
 * ------------------------------------------------------------------ */

/**
 * Строит агрегат по набору записей: средний score, разбивка по типам задач,
 * топ-3 агента по среднему score (второй критерий — число прогонов).
 * @param {Array<object>} records — записи измерений.
 * @returns {object} агрегат.
 */
/** Достаёт первое числовое поле из записи по списку возможных имён. */
function _firstNumber(record, keys) {
  if (!record || typeof record !== 'object') return null;
  for (let i = 0; i < keys.length; i++) {
    const v = record[keys[i]];
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** Score записи: плоское поле или вложенный critic.score. */
function _recordScore(record) {
  const direct = _firstNumber(record, ['score', 'criticScore', 'critic_score']);
  if (direct !== null) return direct;
  if (record && record.critic && typeof record.critic === 'object') {
    return _firstNumber(record.critic, ['score', 'value']);
  }
  return null;
}

/** Длительность записи в мс (терпимо к разным именам поля). */
function _recordDuration(record) {
  return _firstNumber(record, ['durationMs', 'duration', 'ms', 'elapsedMs']);
}

/** Идентификатор агента записи (никогда не пустой). */
function _recordAgent(record) {
  if (!record || typeof record !== 'object') return 'unknown';
  const a = record.agent !== undefined ? record.agent
    : (record.agentId !== undefined ? record.agentId : record.agent_id);
  if (typeof a === 'string' && a.trim() !== '') return a;
  if (a === undefined || a === null) return 'unknown';
  return String(a);
}

function computeAggregate(records) {
  const list = Array.isArray(records) ? records : [];
  const out = { total: list.length, scored: 0, avgScore: 0, avgDuration: 0, topAgents: [], byType: {} };

  let scoreSum = 0;
  let scoreCount = 0;
  let durSum = 0;
  let durCount = 0;
  const perAgent = new Map();

  for (let i = 0; i < list.length; i++) {
    const rec = list[i];
    const score = _recordScore(rec);
    if (score !== null) { scoreSum += score; scoreCount++; }
    const dur = _recordDuration(rec);
    if (dur !== null) { durSum += dur; durCount++; }

    const agent = _recordAgent(rec);
    let bucket = perAgent.get(agent);
    if (!bucket) { bucket = { agent, scoreSum: 0, scoreCount: 0, runs: 0 }; perAgent.set(agent, bucket); }
    bucket.runs++;
    if (score !== null) { bucket.scoreSum += score; bucket.scoreCount++; }

    const type = (rec && typeof rec.taskType === 'string' && rec.taskType.trim() !== '') ? rec.taskType : 'other';
    out.byType[type] = (out.byType[type] || 0) + 1;
  }

  out.scored = scoreCount;
  out.avgScore = scoreCount ? Math.round((scoreSum / scoreCount) * 100) / 100 : 0;
  out.avgDuration = durCount ? Math.round(durSum / durCount) : 0;
  out.topAgents = Array.from(perAgent.values())
    .map((b) => ({
      agent: b.agent,
      avgScore: b.scoreCount ? Math.round((b.scoreSum / b.scoreCount) * 100) / 100 : 0,
      runs: b.runs,
    }))
    .sort((a, b) => (b.avgScore - a.avgScore) || (b.runs - a.runs) || String(a.agent).localeCompare(String(b.agent)))
    .slice(0, TOP_N);

  return out;
}

/**
 * Считает тренд за окно дней по дневным файлам хроники.
 * @param {number} [days] — размер окна в днях (по умолчанию TREND_DAYS).
 * @returns {Array<{date: string, avgScore: number, totalTasks: number}>}
 *   точки тренда по дням (дни без данных пропускаются); пустой массив, если данных нет.
 */
function getTrend(days) {
  // Окно: положительное целое число дней, по умолчанию неделя.
  let windowDays = Number(days);
  if (!isFinite(windowDays) || windowDays <= 0) windowDays = TREND_DAYS;
  windowDays = Math.floor(windowDays);

  const dayMs = 24 * 60 * 60 * 1000;
  const todayStamp = dayStamp(Date.now());
  const fromStamp = dayStamp(Date.now() - (windowDays - 1) * dayMs);

  const points = [];
  let stamps = [];
  try {
    stamps = listDays();
  } catch (err) {
    stamps = [];
  }

  for (let i = 0; i < stamps.length; i++) {
    const stamp = stamps[i];
    if (stamp < fromStamp || stamp > todayStamp) continue; // только окно тренда
    let records = [];
    try {
      const day = loadDay(stamp);
      records = Array.isArray(day.records) ? day.records : [];
    } catch (err) {
      records = [];
    }
    if (records.length === 0) continue; // дни без данных не искажают тренд
    const agg = computeAggregate(records);
    points.push({ date: stamp, avgScore: agg.avgScore, totalTasks: records.length });
  }

  points.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return points;
}

/**
 * Раз в 24 часа пересчитывает агрегат и пишет его в файл, обновляя отметку времени.
 * @param {boolean} [force] — пересчитать независимо от отметки.
 * @returns {{ran: boolean, reason: string, path?: string, summary?: object}}
 */
function maybeAggregate(force) {
  /* TODO */
}

/**
 * Снимок накопленной хроники за сегодня: сколько измерено, средний score и
 * средняя длительность, топ агентов дня. При отсутствии папки — создаёт её.
 * @returns {{date: string, totalTasks: number, avgScore: number, avgDuration: number, topAgents: Array<object>}}
 */
function getSnapshot() {
  const date = dayStamp(Date.now());

  // Папки хроники может не быть — создаём (измерение должно работать с нуля).
  let records = [];
  try {
    if (!fs.existsSync(CHRONICLE_DIR)) fs.mkdirSync(CHRONICLE_DIR, { recursive: true });
    const day = loadDay(date);
    records = Array.isArray(day.records) ? day.records : [];
  } catch (err) {
    records = [];
  }

  const agg = computeAggregate(records);
  return {
    date,
    totalTasks: records.length,
    avgScore: agg.avgScore,
    avgDuration: agg.avgDuration,
    topAgents: agg.topAgents,
  };
}

/* ------------------------------------------------------------------ *
 * 6. Точка входа
 * ------------------------------------------------------------------ */

/**
 * Точка входа агента: ИЗМЕРЕНИЕ И ЖУРНАЛ.
 * Задача идёт транзитом (промпт не изменяется), результат измеряется и
 * записывается в хроник, после чего при необходимости считается агрегат.
 * @param {string} prompt — задача пользователя.
 * @param {object} [options] — { agent, skills, chronicleDir, forceAggregate, skipAggregate }.
 * @returns {Promise<object>} результат прогона + измерения (chronicle).
 */
async function runAgent(prompt, options = {}) {
  /* TODO */
}

module.exports = { runAgent, STRATEGY, getTrend, getSnapshot };
