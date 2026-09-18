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
  /* TODO */
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
  /* TODO */
}

/**
 * Список штампов дней, по которым есть файлы хроники (отсортирован по возрастанию).
 * @returns {string[]} массив 'YYYY-MM-DD'.
 */
function listDays() {
  /* TODO */
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
function computeAggregate(records) {
  /* TODO */
}

/**
 * Считает тренд за окно в TREND_DAYS дней по дневным файлам хроники.
 * @param {number} [days] — размер окна в днях.
 * @returns {object} тренд: точки по дням, направление, дельта, средний score.
 */
function getTrend(days) {
  /* TODO */
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
 * Снимок накопленной хроники: сколько измерено, средний score, топ агентов, тренд.
 * @returns {object} снимок состояния измерений.
 */
function getSnapshot() {
  /* TODO */
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
