'use strict';

/**
 * gnw_global.js
 * ============================================================
 * Глобальное рабочее пространство (Global Neuronal Workspace).
 *
 * Модель сознания Станисласа Деана (Dehaene): конкурирующие
 * "решения" (кандидаты) остаются локальными и бессознательными
 * до тех пор, пока их рейтинг не превысит порог. Рейтинг выше
 * порога вызывает "озарение" (ignition) — кандидат попадает в
 * глобальное пространство и становится доступен всей системе
 * (глобальная рассылка / broadcast).
 *
 * Публичный API (обязательный контракт):
 *
 *   ignite(solution)  -> boolean
 *       solution: number | { score: number, ... }
 *       Кандидат проходит в глобальное пространство и сохраняется
 *       ТОЛЬКО если его score СТРОГО больше порога (score > 8).
 *       Возвращает true — "озарение" произошло (кандидат сознателен),
 *       false — кандидат остался неосознанным.
 *
 *   getGlobal()       -> Array<entry>
 *       Возвращает копию глобального пространства — не более
 *       top-100 записей, отсортированных по score по убыванию.
 *
 *   clear()           -> boolean
 *       Опустошает глобальное пространство (и файл состояния).
 *
 * Хранилище: memory/gnw_global.json (относительно корня проекта).
 * Путь переопределяется переменной окружения GNW_FILE — удобно
 * для smoke-тестов, чтобы не портить боевое состояние.
 *
 * Формат файла — JSON-массив записей:
 *   [{ "id": "...", "score": 9.5, "content": {...}, "ts": 1700000000000 }]
 *
 * Модуль не имеет внешних зависимостей. Запись атомарная
 * (temp-файл + rename), поэтому сбой посреди записи не оставляет
 * обрезанный JSON.
 * ============================================================
 */

const fs = require('fs');
const path = require('path');

/** Порог "озарения". Строгое сравнение: score > THRESHOLD. */
const THRESHOLD = 8;

/** Ёмкость глобального пространства (top-100). */
const CAPACITY = 100;

/** Корень проекта: файл лежит в корне. */
const PROJECT_ROOT = path.resolve(__dirname);

/** Каталог состояния. */
const MEMORY_DIR = path.join(PROJECT_ROOT, 'memory');

/** Файл состояния по умолчанию. */
const DEFAULT_FILE = path.join(MEMORY_DIR, 'gnw_global.json');

/* ------------------------------------------------------------------ */
/* Утилиты                                                            */
/* ------------------------------------------------------------------ */

function resolveFile() {
  const env = process.env.GNW_FILE;
  if (typeof env === 'string' && env.trim() !== '') {
    return path.resolve(env.trim());
  }
  return DEFAULT_FILE;
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

/**
 * Извлекает из произвольного "решения" нормализованную запись.
 * Возвращает null, если кандидат невалиден (нет числового score).
 */
function extract(solution) {
  let score = null;
  let content = null;
  let id = null;

  if (isFiniteNumber(solution)) {
    score = solution;
  } else if (solution && typeof solution === 'object') {
    // Основное поле — score; допускаем алиас fitness (эволюционный
    // контекст проекта), но не угадываем произвольные поля.
    if (isFiniteNumber(solution.score)) {
      score = solution.score;
    } else if (isFiniteNumber(solution.fitness)) {
      score = solution.fitness;
    }

    if (Object.prototype.hasOwnProperty.call(solution, 'content')) {
      content = solution.content;
    } else if (Object.prototype.hasOwnProperty.call(solution, 'payload')) {
      content = solution.payload;
    } else if (Object.prototype.hasOwnProperty.call(solution, 'text')) {
      content = solution.text;
    }

    if (solution.id !== undefined && solution.id !== null) {
      id = String(solution.id);
    }
  }

  if (!isFiniteNumber(score)) return null;

  return {
    id: id,
    score: score,
    content: content,
    ts: Date.now(),
  };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const score = isFiniteNumber(raw.score) ? raw.score : null;
  if (score === null) return null;
  return {
    id: raw.id !== undefined && raw.id !== null ? String(raw.id) : null,
    score: score,
    content: Object.prototype.hasOwnProperty.call(raw, 'content') ? raw.content : null,
    ts: isFiniteNumber(raw.ts) ? raw.ts : 0,
  };
}

/** Сортировка: по score убыв., при равенстве — раньше добавленные. */
function byScoreDesc(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return a.ts - b.ts;
}

/* ------------------------------------------------------------------ */
/* Файловое хранилище                                                 */
/* ------------------------------------------------------------------ */

function readEntries() {
  const file = resolveFile();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // Нет файла / нет доступа — считаем пространство пустым.
    return [];
  }
  if (!raw || raw.trim() === '') return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Повреждённый JSON не должен ронять систему: пространство
    // пересоздаётся с нуля при следующей записи.
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : (parsed && Array.isArray(parsed.entries) ? parsed.entries : []);

  const out = [];
  for (let i = 0; i < list.length; i++) {
    const norm = normalizeEntry(list[i]);
    if (norm !== null) out.push(norm);
  }
  out.sort(byScoreDesc);
  return out.slice(0, CAPACITY);
}

function writeEntries(entries) {
  const file = resolveFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, file);
}

/* ------------------------------------------------------------------ */
/* Публичный API                                                      */
/* ------------------------------------------------------------------ */

/**
 * Попытка "озарения": кандидат попадает в глобальное пространство,
 * если его score строго больше порога.
 *
 * @param {number|object} solution
 * @returns {boolean} true — озарение состоялось, false — нет.
 */
function ignite(solution) {
  const rec = extract(solution);
  if (rec === null) return false;            // невалидный вход
  if (!(rec.score > THRESHOLD)) return false; // порог не преодолён

  const entries = readEntries();

  // Дедупликация по id: повторное озарение обновляет запись,
  // а не размножает её. Без id каждая попытка — отдельный кандидат.
  let updated = false;
  if (rec.id !== null) {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].id === rec.id) {
        if (rec.score >= entries[i].score) entries[i] = rec;
        updated = true;
        break;
      }
    }
  }
  if (!updated) entries.push(rec);

  entries.sort(byScoreDesc);
  writeEntries(entries.slice(0, CAPACITY));
  return true;
}

/**
 * Глобальное пространство: не более top-100, по score убыв.
 * Возвращается копия — вызывающий не может повредить состояние.
 *
 * @returns {Array<{id:?string, score:number, content:*, ts:number}>}
 */
function getGlobal() {
  return readEntries().map(function (e) {
    return { id: e.id, score: e.score, content: e.content, ts: e.ts };
  });
}

/**
 * Опустошает глобальное пространство.
 *
 * @returns {boolean} всегда true (идемпотентно).
 */
function clear() {
  writeEntries([]);
  return true;
}

module.exports = {
  ignite: ignite,
  getGlobal: getGlobal,
  clear: clear,
  THRESHOLD: THRESHOLD,
  CAPACITY: CAPACITY,
  _paths: { projectRoot: PROJECT_ROOT, memoryDir: MEMORY_DIR, file: DEFAULT_FILE },
};
