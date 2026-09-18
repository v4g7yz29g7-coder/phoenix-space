'use strict';

/**
 * polyphony.js — Полифония голосов (М. М. Бахтин, задача POLY-1)
 * ============================================================================
 * У Бахтина (разбор романов Достоевского) нет единого авторского голоса —
 * есть множество равноправных голосов, каждый со своей правдой. В гонке боксов
 * это означает: каждый агент получает СВОЙ RACE_TASK (свою «партию»), а не
 * одну общую задачу, навязанную сверху.
 *
 * Источники голосов (в порядке приоритета):
 *   1. env  RACE_TASKS_BY_BOX — JSON-карта {"agent_4": "задача", ...}
 *   2. файл RACE_VOICES_FILE  — та же карта, но в файле
 *   3. пул  tasks_night_pool.json — автоназначение уникальных голосов
 *
 * Формы значения голоса:
 *   "строка"                          -> голая партия
 *   { prompt: "...", role, style }    -> партия с ролью/стилем
 *   { task: "..." } / { text: "..."}  -> алиасы prompt
 *
 * Спецключ "*" задаёт голос по умолчанию для боксов без своей партии.
 *
 * Модуль ЧИСТЫЙ по побочным эффектам: он не читает process.env сам, не
 * печатает и не пишет файлы. Вся I/O остаётся у вызывающей стороны (race.js),
 * поэтому логику можно покрывать тестами без запуска гонки.
 */

const fs = require('fs');

/** Спецключ «голос по умолчанию» для боксов без персональной партии. */
const WILDCARD = '*';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Привести сырое значение к внутренней форме.
 * @returns {{prompt: string, role: string, style: string} | null}
 */
function normalizeVoice(value) {
  if (typeof value === 'string') {
    const prompt = value.trim();
    return prompt ? { prompt, role: '', style: '' } : null;
  }
  if (!isPlainObject(value)) return null;

  const raw =
    typeof value.prompt === 'string' ? value.prompt :
    typeof value.task === 'string' ? value.task :
    typeof value.text === 'string' ? value.text : '';
  const prompt = raw.trim();
  if (!prompt) return null;

  return {
    prompt,
    role: typeof value.role === 'string' ? value.role.trim() : '',
    style: typeof value.style === 'string' ? value.style.trim() : '',
  };
}

/**
 * Разобрать JSON-строку (или уже готовый объект) в карту голосов {box: voice}.
 * Некорректный JSON не бросает исключение — печатается предупреждение и
 * возвращается пустая карта (фолбэк на общий RACE_TASK).
 */
function parseVoices(raw) {
  if (!raw) return {};

  let parsed = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return {};
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('⚠️  polyphony: некорректный JSON голосов — ' + e.message);
      return {};
    }
  }
  if (!isPlainObject(parsed)) return {};

  const voices = {};
  for (const [box, value] of Object.entries(parsed)) {
    if (!box || box === '__proto__') continue;
    const voice = normalizeVoice(value);
    if (voice) voices[box] = voice;
  }
  return voices;
}

/** Прочитать карту голосов из файла; при любой проблеме — пустая карта. */
function loadVoicesFile(file) {
  if (!file || typeof file !== 'string') return {};
  try {
    if (!fs.existsSync(file)) return {};
    return parseVoices(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('⚠️  polyphony: не удалось прочитать RACE_VOICES_FILE (' + e.message + ')');
    return {};
  }
}

/**
 * Собрать финальную партию бокса из голоса.
 * Голые строки возвращаются без изменений (обратная совместимость).
 */
function composeVoice(box, voice) {
  if (!voice || !voice.prompt) return null;
  const parts = [];
  if (voice.role) parts.push('[ГОЛОС ' + box + ': ' + voice.role + ']');
  if (voice.style) parts.push('[СТИЛЬ: ' + voice.style + ']');
  parts.push(voice.prompt);
  return parts.join('\n');
}

/**
 * Приписать голоса боксам (с учётом "*").
 * @returns {Object} {box: текст партии} — только боксы с персональным голосом.
 */
function resolveVoices(boxes = [], voices = {}) {
  const tasks = {};
  for (const box of boxes) {
    const voice = voices[box] || voices[WILDCARD];
    const composed = composeVoice(box, voice);
    if (composed) tasks[box] = composed;
  }
  return tasks;
}

/**
 * Автоназначение: каждому боксу — уникальная pending-задача из пула.
 * @param {string[]} boxes
 * @param {{tasks?: Array}} pool  pool.tasks[i] = {id, prompt, status, file, group}
 * @returns {{tasks: Object, used: Array}}
 */
function assignFromPool(boxes = [], pool = {}) {
  const pending = Array.isArray(pool && pool.tasks)
    ? pool.tasks.filter((t) => t && t.status === 'pending' && typeof t.prompt === 'string' && t.prompt.trim())
    : [];

  const tasks = {};
  const used = [];
  for (let i = 0; i < boxes.length && i < pending.length; i++) {
    const t = pending[i];
    tasks[boxes[i]] = t.prompt;
    used.push({ box: boxes[i], id: t.id || null, file: t.file || null });
  }
  return { tasks, used };
}

/**
 * Главная точка входа: собрать голоса для боксов.
 *
 * @param {Object}   options
 * @param {string}   [options.raw]    RACE_TASKS_BY_BOX (JSON-строка)
 * @param {string}   [options.file]   RACE_VOICES_FILE (путь)
 * @param {string[]} [options.boxes]  список боксов гонки
 * @param {Object}   [options.pool]   tasks_night_pool.json (для автоназначения)
 * @returns {{tasks: Object, source: string, wildcard: boolean, used: Array}}
 */
function buildVoices(options = {}) {
  const { raw = '', file = '', boxes = [], pool = null } = options;

  const fromFile = loadVoicesFile(file);
  const fromEnv = parseVoices(raw);
  // Явный env приоритетнее файла: он ближе к моменту запуска.
  const explicit = Object.assign({}, fromFile, fromEnv);

  if (Object.keys(explicit).length > 0) {
    const tasks = resolveVoices(boxes, explicit);
    return {
      tasks,
      source: Object.keys(fromEnv).length ? 'env:RACE_TASKS_BY_BOX' : 'file:RACE_VOICES_FILE',
      wildcard: Boolean(explicit[WILDCARD]),
      used: [],
    };
  }

  if (pool) {
    const assigned = assignFromPool(boxes, pool);
    if (Object.keys(assigned.tasks).length > 0) {
      return {
        tasks: assigned.tasks,
        source: 'pool:tasks_night_pool.json',
        wildcard: false,
        used: assigned.used,
      };
    }
  }

  return { tasks: {}, source: 'none', wildcard: false, used: [] };
}

/** Человекочитаемая таблица голосов для логов гонки. */
function describeVoices(boxes = [], tasks = {}) {
  const lines = [];
  for (const box of boxes) {
    const t = tasks[box];
    if (t) lines.push(box + ' → ' + String(t).replace(/\s+/g, ' ').slice(0, 120));
    else lines.push(box + ' → (общий RACE_TASK)');
  }
  return lines;
}

module.exports = {
  WILDCARD,
  isPlainObject,
  normalizeVoice,
  parseVoices,
  loadVoicesFile,
  composeVoice,
  resolveVoices,
  assignFromPool,
  buildVoices,
  describeVoices,
};
