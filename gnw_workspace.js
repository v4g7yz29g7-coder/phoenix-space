// gnw_workspace.js — Глобальное рабочее пространство (Global Neuronal Workspace, Dehaene)
//
// Теория GNW (Stanislas Dehaene): информация становится «осознанной» только тогда,
// когда локальный сигнал набирает достаточную силу и происходит ИГНИЦИЯ (ignition) —
// лавинообразный сдвиг, после которого содержимое транслируется (broadcast)
// во все модули системы.
//
// Ключевые свойства, реализованные здесь:
//   1) ПОРОГ. В глобальное пространство попадают только решения со score > 8.
//      Слабые сигналы (score <= 8) отбрасываются — ignite() возвращает false.
//   2) ОГРАНИЧЕННАЯ ЁМКОСТЬ. Рабочая память узка: храним не более CAPACITY записей,
//      вытесняя самое слабое решение (не FIFO, а по значимости).
//   3) ТРАНСЛЯЦИЯ. Каждая игинированная запись получает счётчик вещаний
//      (broadcastCount) — сколько раз модули её видели через getGlobal().
//   4) ПЕРСИСТЕНТНОСТЬ. Состояние хранится в memory/gnw_global.json
//      (атомарная запись: tmp + rename, чтобы файл не бился при сбое).
//
// Публичный API (как в задаче):
//   ignite(solution) -> bool   — попытка доступа к глобальному пространству
//   getGlobal()      -> Array  — top-100 игинированных решений (по score desc)
//   clear()          -> void   — полная очистка пространства
//
// Дополнительно (для наблюдаемости, не мешает контракту):
//   getStats()       -> Object
//   THRESHOLD, CAPACITY, STRATEGY

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Порог игиниции: строго больше 8. */
const THRESHOLD = 8;
/** Ёмкость глобального пространства (top-100). */
const CAPACITY = 100;
/** Версия схемы файла состояния. */
const SCHEMA_VERSION = 1;
/** Файл состояния глобального пространства. */
const STATE_PATH = path.join(__dirname, 'memory', 'gnw_global.json');
/** Идентификатор стратегии для внешних реестров. */
const STRATEGY =
  'gnw-dehaene: ignition-gated global broadcast (threshold score>8, capacity top-100, persisted to memory/gnw_global.json)';

/* ------------------------------------------------------------------ *
 * Внутреннее состояние
 * ------------------------------------------------------------------ */

/** Кэш состояния в памяти процесса. */
let state = null;

/** Пустое состояние. */
function emptyState() {
  return {
    version: SCHEMA_VERSION,
    threshold: THRESHOLD,
    capacity: CAPACITY,
    updatedAt: new Date().toISOString(),
    ignitions: 0, // сколько раз ignite() вернул true за всю историю
    rejected: 0, // сколько раз ignite() вернул false
    broadcasts: 0, // сколько записей суммарно выдано через getGlobal()
    entries: [],
  };
}

/** Нормализовать распарсенное состояние к ожидаемой форме. */
function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  return {
    version: SCHEMA_VERSION,
    threshold: THRESHOLD,
    capacity: CAPACITY,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    ignitions: toSafeCount(raw.ignitions),
    rejected: toSafeCount(raw.rejected),
    broadcasts: toSafeCount(raw.broadcasts),
    entries: entries.filter(isValidEntry).map(normalizeEntry),
  };
}

function toSafeCount(v) {
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function isValidEntry(e) {
  return e && typeof e === 'object' && typeof e.hash === 'string' && Number.isFinite(e.score);
}

function normalizeEntry(e) {
  return {
    id: typeof e.id === 'string' ? e.id : null,
    hash: e.hash,
    score: e.score,
    content: e.content === undefined ? null : e.content,
    agent: typeof e.agent === 'string' ? e.agent : null,
    task: typeof e.task === 'string' ? e.task : null,
    ignitedAt: typeof e.ignitedAt === 'string' ? e.ignitedAt : new Date().toISOString(),
    broadcastCount: toSafeCount(e.broadcastCount),
  };
}

/* ------------------------------------------------------------------ *
 * 1. Загрузка / сохранение
 * ------------------------------------------------------------------ */

/** Ленивая загрузка состояния с диска (устойчиво к отсутствию/битому файлу). */
function load() {
  if (state) return state;
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    state = normalizeState(JSON.parse(raw));
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      // Битый JSON — не роняем процесс, начинаем с чистого пространства.
      process.emitWarning(`gnw_workspace: cannot read ${STATE_PATH}: ${err.message}`);
    }
    state = emptyState();
  }
  return state;
}

/** Атомарная запись состояния (tmp + rename). */
function persist() {
  const s = load();
  s.updatedAt = new Date().toISOString();
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const tmp = `${STATE_PATH}.tmp_${process.pid}_${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_PATH);
    return true;
  } catch (err) {
    process.emitWarning(`gnw_workspace: cannot persist ${STATE_PATH}: ${err.message}`);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 2. Игиниция
 * ------------------------------------------------------------------ */

/** Устойчивый хэш содержимого решения — ключ дедупликации в пространстве. */
function hashSolution(solution) {
  let payload;
  try {
    payload = JSON.stringify(solution);
  } catch (err) {
    payload = String(solution);
  }
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

/** Извлечь score из решения (число или числовая строка). */
function extractScore(solution) {
  if (typeof solution === 'number') return solution;
  if (!solution || typeof solution !== 'object') return NaN;
  const raw = solution.score !== undefined ? solution.score : solution.value;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw);
  return NaN;
}

/**
 * Попытаться провести решение в глобальное рабочее пространство.
 * @param {object|number} solution — решение; ожидается поле score.
 * @returns {boolean} true, если игиниция состоялась (score > 8).
 */
function ignite(solution) {
  const s = load();
  const score = extractScore(solution);

  // Слабый или некорректный сигнал не проходит порог.
  if (!Number.isFinite(score) || score <= THRESHOLD) {
    s.rejected += 1;
    persist();
    return false;
  }

  const obj = solution && typeof solution === 'object' ? solution : { value: solution };
  const hash = hashSolution(obj);
  const now = new Date().toISOString();
  const entry = {
    id: typeof obj.id === 'string' ? obj.id : null,
    hash,
    score,
    content: obj.content !== undefined ? obj.content : obj.solution !== undefined ? obj.solution : null,
    agent: typeof obj.agent === 'string' ? obj.agent : null,
    task: typeof obj.task === 'string' ? obj.task : null,
    ignitedAt: now,
    broadcastCount: 0,
  };

  // Дедупликация: то же решение не занимает две ячейки, а освежается.
  const existingIdx = s.entries.findIndex((e) => e.hash === hash);
  if (existingIdx >= 0) {
    const prev = s.entries[existingIdx];
    entry.broadcastCount = prev.broadcastCount || 0;
    entry.ignitedAt = prev.ignitedAt || now;
    s.entries[existingIdx] = entry;
  } else {
    s.entries.push(entry);
  }

  // Ограниченная ёмкость: вытесняем самое слабое решение (по score).
  s.entries.sort(compareEntries);
  if (s.entries.length > CAPACITY) s.entries.length = CAPACITY;

  s.ignitions += 1;
  persist();
  return true;
}

/** Сортировка: score desc, затем свежесть desc, затем hash для детерминизма. */
function compareEntries(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ta = Date.parse(a.ignitedAt) || 0;
  const tb = Date.parse(b.ignitedAt) || 0;
  if (tb !== ta) return tb - ta;
  return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * 3. Глобальная трансляция
 * ------------------------------------------------------------------ */

/**
 * Вернуть top-100 игинированных решений (копии, по score desc).
 * Каждая выдача увеличивает broadcastCount записи — это и есть «вещание».
 * @returns {Array<object>}
 */
function getGlobal() {
  const s = load();
  const top = s.entries.slice().sort(compareEntries).slice(0, CAPACITY);
  for (const e of top) e.broadcastCount = toSafeCount(e.broadcastCount) + 1;
  s.broadcasts += top.length;
  if (top.length > 0) persist();
  return top.map((e) => ({ ...e }));
}

/* ------------------------------------------------------------------ *
 * 4. Очистка
 * ------------------------------------------------------------------ */

/** Полностью очистить глобальное пространство (история счётчиков сохраняется). */
function clear() {
  const s = load();
  s.entries = [];
  s.updatedAt = new Date().toISOString();
  persist();
  return true;
}

/* ------------------------------------------------------------------ *
 * 5. Наблюдаемость
 * ------------------------------------------------------------------ */

/** Сводка о состоянии пространства. */
function getStats() {
  const s = load();
  const top = s.entries.slice().sort(compareEntries);
  return {
    size: top.length,
    capacity: CAPACITY,
    threshold: THRESHOLD,
    ignitions: s.ignitions,
    rejected: s.rejected,
    broadcasts: s.broadcasts,
    bestScore: top.length ? top[0].score : null,
    worstScore: top.length ? top[top.length - 1].score : null,
    updatedAt: s.updatedAt,
  };
}

module.exports = {
  ignite,
  getGlobal,
  clear,
  getStats,
  THRESHOLD,
  CAPACITY,
  STRATEGY,
  STATE_PATH,
};
