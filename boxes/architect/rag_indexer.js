#!/usr/bin/env node
'use strict';

/**
 * architect/rag_indexer.js
 * ========================
 *
 * Векторный индекс корпуса «Архитектора»: markdown-диалоги из
 * `corpus/architect/core/*.md` разбиваются на перекрывающиеся чанки,
 * кодируются в векторы и складываются в LanceDB — ту же встроенную
 * векторную БД, которая уже используется в EverOS
 * (`~/.everos/.index/lancedb/*.lance`), поэтому индекс читается теми же
 * инструментами, что и память агентов.
 *
 * Зачем это нужно:
 *   - dna_builder.js отвечает на вопрос «как Архитектор формулирует задачи»;
 *   - rag_indexer.js отвечает на вопрос «где именно он это говорил» —
 *     семантический поиск по исходным репликам с точной ссылкой на файл,
 *     чанк и позицию, чтобы цитата была проверяемой.
 *
 * Публичный API (CommonJS):
 *
 *   const rag = require('./architect/rag_indexer');
 *
 *   // 1) Построить (пересобрать) индекс
 *   const res = await rag.index();
 *   // -> { ok, backend: 'lancedb'|'json', files, chunks, dim, table, dbPath, ms }
 *
 *   // 2) Искать по индексу
 *   const hits = await rag.search('как ставить задачи и критерии готовности', { limit: 5 });
 *   // -> [{ id, docId, title, date, file, chunkIndex, text, score, backend }, ...]
 *
 *   // 3) Диагностика
 *   const st = await rag.info();
 *
 * Опции index():
 *   dir          {string}  директория корпуса (по умолчанию corpus/architect/core)
 *   dbDir        {string}  директория LanceDB (по умолчанию .rag_index/lancedb)
 *   tableName    {string}  имя таблицы (по умолчанию architect_core)
 *   chunkChars   {number}  целевой размер чанка в символах (по умолчанию 900)
 *   overlapChars {number}  перекрытие соседних чанков (по умолчанию 180)
 *   dim          {number}  размерность эмбеддинга (по умолчанию 256)
 *   rebuild      {boolean} пересоздавать таблицу целиком (по умолчанию true)
 *   fallback     {boolean} разрешить JSON-фолбэк без LanceDB (по умолчанию true)
 *   quiet        {boolean} не писать прогресс в stdout
 *
 * Опции search():
 *   limit        {number}  сколько результатов вернуть (по умолчанию 5)
 *   minScore     {number}  отсечь всё ниже порога косинусной близости (по умолчанию -1)
 *   dir / dbDir / tableName / dim — как в index()
 *   fallback     {boolean} разрешить поиск по JSON-фолбэку (по умолчанию true)
 *
 * Схема строки таблицы LanceDB:
 *   id          STRING  — '<docId>#<chunkIndex>' (стабильный ключ чанка)
 *   doc_id      STRING  — '001_2025-04-27_Приветствие_и_предложение_помощи'
 *   chunk_index INT32   — номер чанка внутри документа
 *   title       STRING  — первый заголовок '# ...' документа
 *   date        STRING  — 'YYYY-MM-DD' из имени файла или подписи
 *   file        STRING  — путь относительно корня репозитория
 *   text        STRING  — сам текст чанка
 *   vector      VECTOR  — FLOAT32[dim], L2-нормированный
 *
 * Модель эмбеддинга:
 *   По умолчанию используется детерминированный локальный энкодер
 *   (hashing trick: слова + символьные триграммы) — он не требует сети,
 *   не тянет моделей и даёт воспроизводимый индекс. Внешние эмбеддинги
 *   подключаются опцией `embed(text, dim) => number[]` в options.index()/
 *   options.search(), если потребуется более сильная семантика.
 *
 * Зависимости: встроенные модули Node.js + опционально `@lancedb/lancedb`.
 * Если LanceDB недоступна, модуль НЕ падает: он пишет JSON-фолбэк
 * (`.rag_index/index.json`) и ищет по косинусной близости в памяти,
 * честно помечая результаты `backend: 'json'`.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gigachat = require('../../sensors/gigachat_adapter');

/* ------------------------------------------------------------------ */
/* Константы и значения по умолчанию                                   */
/* ------------------------------------------------------------------ */

/** Корень репозитория: <repo>/architect/rag_indexer.js -> <repo> */
const REPO_ROOT = path.join(__dirname, '..', '..');

/** Корпус диалогов Архитектора по умолчанию. */
const DEFAULT_CORPUS_DIR = path.join(REPO_ROOT, 'corpus', 'architect', 'core');

/** Каталог индекса (и LanceDB, и JSON-фолбэка). */
const DEFAULT_INDEX_DIR = path.join(REPO_ROOT, '.rag_index');

/** LanceDB-директория: внутри — подпапки *.lance, как в EverOS. */
const DEFAULT_DB_DIR = path.join(DEFAULT_INDEX_DIR, 'lancedb');

/** JSON-фолбэк, если LanceDB не установлена. */
const DEFAULT_JSON_INDEX = path.join(DEFAULT_INDEX_DIR, 'index.json');

/** Имя таблицы в LanceDB. */
const DEFAULT_TABLE = 'architect_core';

/** Размерность локального эмбеддинга. */
const DEFAULT_DIM = 256;

/** Целевой размер чанка (символов). */
const DEFAULT_CHUNK_CHARS = 900;

/** Перекрытие соседних чанков (символов). */
const DEFAULT_OVERLAP_CHARS = 180;

/** Сколько результатов возвращать по умолчанию. */
const DEFAULT_LIMIT = 5;

/** Версия формата индекса: меняется при несовместимой смене схемы. */
const INDEX_FORMAT = 'rag-index-v1';

/** Расширение файлов корпуса. */
const FILE_EXT = '.md';

/** Регэксп даты в имени файла: 001_2025-04-27_Заголовок.md */
const DATE_IN_NAME = /(\d{4}-\d{2}-\d{2})/;

/** Кэш загруженного модуля LanceDB, чтобы не требовать его дважды. */
let LANCE_CACHE = null;

/* ------------------------------------------------------------------ */
/* Файловые утилиты                                                    */
/* ------------------------------------------------------------------ */

/**
 * Прочитать файл как UTF-8, не падая на ошибке доступа.
 * @param {string} filePath
 * @returns {string}
 */
function safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
}

/**
 * Список markdown-файлов корпуса, отсортированный по имени (001, 002, ...).
 * @param {string} dir
 * @returns {string[]} абсолютные пути
 */
function listCorpusFiles(dir) {
  const root = dir || DEFAULT_CORPUS_DIR;
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch (err) {
    return [];
  }
  return entries
    .filter((name) => name.toLowerCase().endsWith(FILE_EXT))
    .filter((name) => !name.startsWith('.'))
    .sort((a, b) => a.localeCompare(b, 'ru'))
    .map((name) => path.join(root, name));
}

/**
 * Относительный путь от корня репозитория (для читаемых ссылок в выдаче).
 * @param {string} absPath
 * @returns {string}
 */
function relativeToRepo(absPath) {
  const rel = path.relative(REPO_ROOT, absPath);
  return rel.startsWith('..') ? absPath : rel;
}

/**
 * Короткий стабильный хэш строки (для id и дедупликации).
 * @param {string} str
 * @returns {string}
 */
function shortHash(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex').slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Разбор документа                                                    */
/* ------------------------------------------------------------------ */

/**
 * Разобрать markdown-документ корпуса: имя -> id, дата, заголовок, текст.
 * @param {string} filePath
 * @param {string} raw
 * @returns {{id: string, file: string, title: string, date: string, text: string, chars: number}}
 */
function parseDoc(filePath, raw) {
  const base = path.basename(filePath, FILE_EXT);
  const content = String(raw || '');
  const dateMatch = base.match(DATE_IN_NAME);
  const headingMatch = content.match(/^\s*#\s+(.+?)\s*$/m);
  const title = headingMatch
    ? headingMatch[1].trim()
    : base.replace(/^\d+_/, '').replace(/_/g, ' ').trim();
  return {
    id: base,
    file: relativeToRepo(filePath),
    title,
    date: dateMatch ? dateMatch[1] : '',
    text: content,
    chars: content.length,
  };
}

/**
 * Нарезать документ на перекрывающиеся чанки по границам абзацев/строк.
 * Алгоритм: идём по тексту, цепляясь за ближайший перевод строки или пробел
 * в пределах chunkChars; следующий чанк начинается с overlapChars назад.
 * @param {{id:string, file:string, title:string, date:string, text:string}} doc
 * @param {{chunkChars?: number, overlapChars?: number}} [opts]
 * @returns {Array<object>}
 */
function chunkDocument(doc, opts) {
  const chunkChars = Math.max(120, Number(opts && opts.chunkChars) || DEFAULT_CHUNK_CHARS);
  const overlapChars = Math.max(0, Math.min(chunkChars - 40, Number(opts && opts.overlapChars) || DEFAULT_OVERLAP_CHARS));
  const text = String(doc.text || '').replace(/\r\n/g, '\n');
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + chunkChars);
    if (end < text.length) {
      // Пытаемся закончить чанк на границе абзаца, затем строки, затем слова.
      const slice = text.slice(start, end);
      const para = slice.lastIndexOf('\n\n');
      const line = slice.lastIndexOf('\n');
      const space = slice.lastIndexOf(' ');
      let cut = -1;
      if (para > chunkChars * 0.5) cut = para + 2;
      else if (line > chunkChars * 0.5) cut = line + 1;
      else if (space > chunkChars * 0.5) cut = space + 1;
      if (cut > 0) end = start + cut;
    }

    const rawChunk = text.slice(start, end);
    const body = rawChunk.trim();
    if (body) {
      const chunkIndex = chunks.length;
      chunks.push({
        id: doc.id + '#' + chunkIndex,
        docId: doc.id,
        chunkIndex,
        title: doc.title,
        date: doc.date,
        file: doc.file,
        text: body,
        start: start,
        end: end,
      });
    }

    if (end >= text.length) break;
    const next = end - overlapChars;
    start = next > start ? next : end;
  }

  return chunks;
}

/* ------------------------------------------------------------------ */
/* Локальный эмбеддинг (hashing trick)                                 */
/* ------------------------------------------------------------------ */

/** Быстрый FNV-1a (32 бита) — основа хэширования признаков. */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Нормализовать текст: нижний регистр, ё->е, оставить буквы/цифры/пробелы.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Токенизация: слова длиной >= 2 символов.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  const norm = normalize(text);
  if (!norm) return [];
  return norm.split(' ').filter((w) => w.length >= 2);
}

/** Лёгкий стеммер: срезает частые русские окончания у длинных слов. */
function stem(token) {
  if (token.length <= 4) return token;
  const endings = ['иями', 'ями', 'ами', 'ость', 'ений', 'ения', 'ать', 'ять', 'еть', 'ить', 'ого', 'ему', 'ыми', 'ими', 'ий', 'ый', 'ая', 'ое', 'ые', 'ов', 'ев', 'ах', 'ях', 'ам', 'ям', 'ой', 'ей', 'ы', 'и', 'а', 'я', 'е', 'о', 'у', 'ю'];
  for (const end of endings) {
    if (token.length - end.length >= 4 && token.endsWith(end)) {
      return token.slice(0, token.length - end.length);
    }
  }
  return token;
}

/**
 * Локальный детерминированный эмбеддинг: мешок слов (со стеммингом) плюс
 * символьные триграммы — это даёт устойчивость к опечаткам и формам слов.
 * Все веса раскладываются по dim корзинам хэшем и результат L2-нормируется.
 * @param {string} text
 * @param {number} [dim]
 * @returns {number[]}
 */
// === Локальный эмбеддер (Xenova/transformers) ===
let _embedPipeline = null;
async function getEmbedder() {
  if (_embedPipeline) return _embedPipeline;
  const { pipeline } = await import('@xenova/transformers');
  _embedPipeline = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small');
  return _embedPipeline;
}

async function embed(text, dim) {
  // 1. Пробуем локальный эмбеддер (384-мерный, русский)
  try {
    const embedder = await getEmbedder();
    const out = await embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  } catch (e) {
    // тихо в fallback
  }

  // 2. Fallback: FNV-1a (dim координат) — только если модель недоступна
  const d = Math.max(32, Number(dim) || DEFAULT_DIM);
  const vec = new Float64Array(d);
  const tokens = tokenize(text);

  for (const token of tokens) {
    const key = stem(token);
    const bucket = fnv1a32('w:' + key) % d;
    vec[bucket] += 1.0 + Math.min(3, key.length) / 3;
  }

  for (const token of tokens) {
    if (token.length < 4) continue;
    const padded = '^' + token + '$';
    for (let i = 0; i + 3 <= padded.length; i += 1) {
      const tri = padded.slice(i, i + 3);
      const bucket = fnv1a32('g:' + tri) % d;
      vec[bucket] += 0.35;
    }
  }

  let norm = 0;
  for (let i = 0; i < d; i += 1) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(d);
  for (let i = 0; i < d; i += 1) out[i] = vec[i] / norm;
  return out;
}

/**
 * Косинусная близость двух векторов (на нормированных = скалярное произведение).
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ------------------------------------------------------------------ */
/* Бэкенд LanceDB                                                      */
/* ------------------------------------------------------------------ */

/**
 * Ленивая загрузка LanceDB. Пробуем оба известных имени пакета.
 * @returns {{mod: object|null, error: string|null}}
 */
function loadLance() {
  if (LANCE_CACHE) return LANCE_CACHE;
  const names = ['@lancedb/lancedb', 'lancedb'];
  for (const name of names) {
    try {
      // eslint-disable-next-line global-require
      const mod = require(name);
      LANCE_CACHE = { mod, error: null, name };
      return LANCE_CACHE;
    } catch (err) {
      LANCE_CACHE = { mod: null, error: err && err.message ? err.message : String(err), name: null };
    }
  }
  return LANCE_CACHE;
}

/**
 * Подключиться к LanceDB в заданной директории.
 * @param {string} dbDir
 * @returns {Promise<object>}
 */
async function connectLance(dbDir) {
  const { mod } = loadLance();
  if (!mod) throw new Error('LanceDB недоступна: ' + (loadLance().error || 'модуль не найден'));
  const uri = dbDir || DEFAULT_DB_DIR;
  fs.mkdirSync(uri, { recursive: true });
  return mod.connect(uri);
}

/**
 * Пересоздать таблицу и залить строки. Совместимо с разными версиями API:
 * если createTable умеет overwrite — используем его, иначе dropTable + createTable.
 * @param {object} db
 * @param {string} tableName
 * @param {object[]} rows
 * @returns {Promise<object>} таблица
 */
async function writeLanceTable(db, tableName, rows) {
  let existing = [];
  try {
    existing = await db.tableNames();
  } catch (err) {
    existing = [];
  }
  if (Array.isArray(existing) && existing.includes(tableName)) {
    try {
      await db.dropTable(tableName);
    } catch (err) {
      /* таблицы может уже не быть — не критично */
    }
  }
  const table = await db.createTable(tableName, rows);
  // Полнотекстовый индекс по тексту — необязательный, но полезный бонус.
  try {
    const { mod } = loadLance();
    const fts = mod.index && mod.index.fts ? mod.index.fts() : undefined;
    if (typeof table.createIndex === 'function') {
      await table.createIndex('text', fts ? { config: fts } : undefined);
    }
  } catch (err) {
    /* FTS недоступен — векторного поиска достаточно */
  }
  return table;
}

/**
 * Векторный поиск в LanceDB с совместимостью по версиям API.
 * @param {object} table
 * @param {number[]} vector
 * @param {number} limit
 * @returns {Promise<object[]>} сырые строки с _distance
 */
async function searchLanceTable(table, vector, limit) {
  let query;
  if (typeof table.vectorSearch === 'function') query = table.vectorSearch(vector);
  else if (typeof table.search === 'function') query = table.search(vector);
  else throw new Error('Таблица LanceDB не поддерживает vectorSearch/search');
  if (typeof query.limit === 'function') query = query.limit(limit);
  if (typeof query.toArray === 'function') return query.toArray();
  if (typeof query.execute === 'function') {
    const res = await query.execute();
    return typeof res.toArray === 'function' ? res.toArray() : res;
  }
  return query;
}

/* ------------------------------------------------------------------ */
/* JSON-фолбэк                                                         */
/* ------------------------------------------------------------------ */

/**
 * Сохранить индекс в JSON (когда LanceDB недоступна).
 * @param {string} jsonPath
 * @param {object} payload
 */
function saveJsonIndex(jsonPath, payload) {
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
}

/**
 * Прочитать JSON-индекс.
 * @param {string} jsonPath
 * @returns {object|null}
 */
function loadJsonIndex(jsonPath) {
  try {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Сборка индекса                                                      */
/* ------------------------------------------------------------------ */

/**
 * Собрать все чанки корпуса с эмбеддингами (без записи в БД).
 * @param {object} [options]
 * @returns {{rows: object[], files: number, dim: number}}
 */
async function buildRows(options) {
  const opts = options || {};
  const dir = opts.dir || DEFAULT_CORPUS_DIR;
  const dim = Math.max(32, Number(opts.dim) || DEFAULT_DIM);
  const embedFn = typeof opts.embed === 'function' ? opts.embed : embed;
  const files = listCorpusFiles(dir);
  const rows = [];

  for (const filePath of files) {
    const raw = safeReadFile(filePath);
    if (!raw.trim()) continue;
    const doc = parseDoc(filePath, raw);
    const chunks = chunkDocument(doc, opts);
    for (const chunk of chunks) {
      const vec = await embed(chunk.text, dim);
        rows.push({
        id: chunk.id,
        doc_id: doc.id,
        chunk_index: chunk.chunkIndex,
        title: doc.title,
        date: doc.date,
        file: doc.file,
        text: chunk.text,
        vector: Array.from(vec, (x) => Number(x.toFixed(6))),
      });
    }
  }

  return { rows, files: files.length, dim };
}

/**
 * Построить (или пересобрать) векторный индекс корпуса.
 *
 * @param {object} [options] см. шапку модуля
 * @returns {Promise<object>} отчёт о сборке
 */
async function index(options) {
  const opts = Object.assign({}, options);
  const dim = Math.max(32, Number(opts.dim) || DEFAULT_DIM);
  const dbDir = opts.dbDir || DEFAULT_DB_DIR;
  const jsonPath = opts.jsonPath || DEFAULT_JSON_INDEX;
  const tableName = opts.tableName || DEFAULT_TABLE;
  const started = Date.now();

  const built = await buildRows(Object.assign({}, opts, { dim }));
  if (!built.rows.length) {
    const err = new Error('Корпус пуст: нет markdown-файлов в ' + (opts.dir || DEFAULT_CORPUS_DIR));
    err.code = 'EMPTY_CORPUS';
    throw err;
  }

  const lance = loadLance();
  let backend = 'json';
  let dbPath = jsonPath;
  let table = null;

  if (lance.mod) {
    try {
      const db = await connectLance(dbDir);
      table = await writeLanceTable(db, tableName, built.rows);
      backend = 'lancedb';
      dbPath = dbDir;
    } catch (err) {
      if (opts.fallback === false) throw err;
      backend = 'json';
      dbPath = jsonPath;
    }
  } else if (opts.fallback === false) {
    throw new Error('LanceDB недоступна и fallback отключён: ' + (lance.error || 'модуль не найден'));
  }

  if (backend === 'json') {
    saveJsonIndex(jsonPath, {
      format: INDEX_FORMAT,
      createdAt: new Date().toISOString(),
      dim,
      tableName,
      rows: built.rows,
    });
  } else {
    // Держим JSON рядом с LanceDB: он даёт быстрый оффлайн-поиск и бэкап.
    saveJsonIndex(jsonPath, {
      format: INDEX_FORMAT,
      createdAt: new Date().toISOString(),
      dim,
      tableName,
      rows: [],
      note: 'Векторы лежат в LanceDB, JSON содержит только метаданные.',
    });
  }

  const report = {
    ok: true,
    format: INDEX_FORMAT,
    backend,
    table: tableName,
    dbPath,
    jsonPath,
    dir: opts.dir || DEFAULT_CORPUS_DIR,
    files: built.files,
    chunks: built.rows.length,
    dim,
    ms: Date.now() - started,
  };

  if (!opts.quiet) {
    process.stdout.write(
      '[rag_indexer] backend=' + report.backend +
      ' files=' + report.files +
      ' chunks=' + report.chunks +
      ' dim=' + report.dim +
      ' ms=' + report.ms + '\n'
    );
  }
  return report;
}

/* ------------------------------------------------------------------ */
/* Поиск                                                               */
/* ------------------------------------------------------------------ */

/**
 * Нормализовать сырую строку LanceDB в результат поиска.
 * @param {object} row
 * @param {number} score
 * @param {string} backend
 * @returns {object}
 */
function toHit(row, score, backend) {
  return {
    id: row.id,
    docId: row.doc_id || row.docId,
    chunkIndex: typeof row.chunk_index === 'number' ? row.chunk_index : row.chunkIndex,
    title: row.title || '',
    date: row.date || '',
    file: row.file || '',
    text: row.text || '',
    score: Number(score.toFixed(4)),
    backend,
  };
}

/**
 * Оценка расстояния LanceDB -> косинус. Для L2-метрики на нормированных
 * векторах: cos = 1 - d/2. Для уже косинусного расстояния cos = 1 - d.
 * @param {object} row
 * @returns {number}
 */
function scoreFromRow(row) {
  const raw = typeof row._distance === 'number' ? row._distance
    : typeof row._score === 'number' ? row._score
      : typeof row._relevance === 'number' ? row._relevance : 0;
  if (typeof row._distance === 'number') {
    const cos = 1 - raw / 2;
    return cos < -1 ? -1 : cos > 1 ? 1 : cos;
  }
  return raw;
}

/**
 * Поиск по векторному индексу.
 *
 * @param {string} query текст запроса
 * @param {object} [options] см. шапку модуля
 * @returns {Promise<object[]>} отсортированные попадания
 */
async function search(query, options) {
  const opts = options || {};
  const q = String(query || '').trim();
  if (!q) throw new Error('search(): пустой запрос');

  const dim = Math.max(32, Number(opts.dim) || DEFAULT_DIM);
  const limit = Math.max(1, Number(opts.limit) || DEFAULT_LIMIT);
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : -1;
  const embedFn = typeof opts.embed === 'function' ? opts.embed : embed;
  const qvecRaw = await embedFn(q, dim);  // FIX: embed теперь async
  const qvec = Array.from(qvecRaw, (x) => Number(x));

  const lance = loadLance();
  const tableName = opts.tableName || DEFAULT_TABLE;
  const dbDir = opts.dbDir || DEFAULT_DB_DIR;
  const jsonPath = opts.jsonPath || DEFAULT_JSON_INDEX;

  // 1) LanceDB — основной путь.
  if (lance.mod) {
    try {
      const db = await connectLance(dbDir);
      const names = await db.tableNames();
      if (Array.isArray(names) && names.includes(tableName)) {
        const table = await db.openTable(tableName);
        // Берём с запасом, чтобы после отсечения по minScore осталось limit.
        const raw = await searchLanceTable(table, qvec, limit * 3);
        const hits = (raw || [])
          .map((row) => toHit(row, scoreFromRow(row), 'lancedb'))
          .filter((h) => h.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
        if (hits.length) return hits;
      }
    } catch (err) {
      if (opts.fallback === false) throw err;
      // падаем ниже — в JSON-фолбэк
    }
  } else if (opts.fallback === false) {
    throw new Error('LanceDB недоступна и fallback отключён: ' + (lance.error || 'модуль не найден'));
  }

  // 2) JSON-фолбэк: косинус в памяти.
  const stored = loadJsonIndex(jsonPath);
  if (!stored || !Array.isArray(stored.rows) || !stored.rows.length) {
    const err = new Error('Индекс не найден. Сначала выполните rag_indexer.index() (искали: ' + jsonPath + ')');
    err.code = 'NO_INDEX';
    throw err;
  }

  const scored = [];
  for (const row of stored.rows) {
    scored.push(toHit(row, cosine(qvec, row.vector || []), 'json'));
  }
  return scored
    .filter((h) => h.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Диагностика: какие бэкенды доступны и что уже построено.
 * @param {object} [options]
 * @returns {object}
 */
function info(options) {
  const opts = options || {};
  const lance = loadLance();
  const jsonPath = opts.jsonPath || DEFAULT_JSON_INDEX;
  const stored = loadJsonIndex(jsonPath);
  const dir = opts.dir || DEFAULT_CORPUS_DIR;
  return {
    format: INDEX_FORMAT,
    lanceAvailable: Boolean(lance.mod),
    lancePackage: lance.name || null,
    lanceError: lance.error || null,
    dbDir: opts.dbDir || DEFAULT_DB_DIR,
    jsonPath,
    jsonIndex: stored ? { rows: (stored.rows || []).length, createdAt: stored.createdAt, dim: stored.dim } : null,
    corpusDir: dir,
    corpusFiles: listCorpusFiles(dir).length,
    dim: Math.max(32, Number(opts.dim) || DEFAULT_DIM),
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Разобрать argv вида: node rag_indexer.js index --dir=... --limit=5
 * @param {string[]} argv
 * @returns {{cmd: string, query: string[], flags: object}}
 */
function parseArgv(argv) {
  const args = argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('-') ? args[0] : 'info';
  const rest = args[0] && !args[0].startsWith('-') ? args.slice(1) : args;
  const flags = {};
  const query = [];
  for (const arg of rest) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      flags[key] = value === undefined ? true : value;
    } else {
      query.push(arg);
    }
  }
  return { cmd, query, flags };
}

/** Точка входа CLI. */
async function main(argv) {
  const { cmd, query, flags } = parseArgv(argv || process.argv);
  const options = {};
  if (flags.dir) options.dir = flags.dir;
  if (flags.dbDir) options.dbDir = flags.dbDir;
  if (flags.table) options.tableName = flags.table;
  if (flags.limit) options.limit = Number(flags.limit);
  if (flags.dim) options.dim = Number(flags.dim);
  if (flags.rebuild === 'false') options.rebuild = false;

  try {
    if (cmd === 'index') {
      const res = await index(options);
      process.stdout.write('[rag_indexer] индекс готов: ' + JSON.stringify(res, null, 2) + '\n');
      return 0;
    }
    if (cmd === 'search' || cmd === 'query') {
      const text = query.join(' ');
      if (!text) {
        process.stderr.write('Использование: node architect/rag_indexer.js search "запрос" [--limit=5]\n');
        return 2;
      }
      const hits = await search(text, options);
      process.stdout.write('[rag_indexer] найдено ' + hits.length + '\n');
      hits.forEach((h, i) => {
        const snippet = h.text.replace(/\s+/g, ' ').slice(0, 160);
        process.stdout.write(
          (i + 1) + '. [' + h.score + '] ' + h.title + ' (' + h.date + ')\n' +
          '   ' + h.file + ' #' + h.chunkIndex + '\n' +
          '   ' + snippet + '...\n'
        );
      });
      return 0;
    }
    const st = info(options);
    process.stdout.write('[rag_indexer] ' + JSON.stringify(st, null, 2) + '\n');
    return 0;
  } catch (err) {
    process.stderr.write('[rag_indexer] ошибка: ' + (err && err.message ? err.message : String(err)) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  });
}

/* ------------------------------------------------------------------ */
/* Экспорт                                                             */
/* ------------------------------------------------------------------ */

module.exports = {
  // публичный API
  index,
  search,
  info,
  // низкоуровневые утилиты — для тестов и переиспользования
  buildRows,
  chunkDocument,
  parseDoc,
  embed,
  cosine,
  tokenize,
  normalize,
  stem,
  fnv1a32,
  listCorpusFiles,
  loadLance,
  loadJsonIndex,
  saveJsonIndex,
  toHit,
  scoreFromRow,
  parseArgv,
  main,
  // константы
  REPO_ROOT,
  DEFAULT_CORPUS_DIR,
  DEFAULT_INDEX_DIR,
  DEFAULT_DB_DIR,
  DEFAULT_JSON_INDEX,
  DEFAULT_TABLE,
  DEFAULT_DIM,
  DEFAULT_CHUNK_CHARS,
  DEFAULT_OVERLAP_CHARS,
  DEFAULT_LIMIT,
  INDEX_FORMAT,
};
