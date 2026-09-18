'use strict';

/**
 * sensors/ocr_engine.js
 * =============================================================================
 * Оптическое распознавание текста (OCR) на базе Tesseract.
 *
 * Публичный API:
 *   extract(imagePath, options) -> Promise<OcrResult>
 *   extractSync(imagePath, options) -> OcrResult        (только CLI-бэкенд)
 *   checkAvailability() -> { available, binary, version, tesseractJs }
 *   createEngine(options) -> OcrEngine
 *
 * OcrResult:
 *   {
 *     text:       string,     // распознанный текст, строки склеены через "\n"
 *     lines:      string[],   // текст, разбитый по строкам
 *     words:      Array<{ text: string, confidence: number,
 *                         bbox: { x, y, width, height } | null }>,
 *     confidence: number,     // средняя уверенность, 0..100
 *     meta:       {           // служебная информация о запуске
 *       engine, backend, lang, psm, oem, format, width, height,
 *       bytes, durationMs, file
 *     }
 *   }
 *
 * Бэкенды (выбираются автоматически либо через options.backend):
 *   1. 'tesseract.js' — npm-пакет, распознавание в WASM (если установлен);
 *   2. 'cli'          — бинарник `tesseract` из PATH (stdout/TSV-режим).
 *
 * Возможности:
 *   - валидация файла (существование, непустой, определение формата по магии);
 *   - извлечение размеров PNG / JPEG / GIF / BMP / WEBP / TIFF из заголовков;
 *   - настройки lang / psm / oem / dpi / timeout / whitelist / config;
 *   - получение слов с bbox и уверенностью через TSV-вывод CLI;
 *   - безопасный graceful fallback: TSV -> plain text, tesseract.js -> CLI;
 *   - нормализация текста (переводы строк, пробелы, trim);
 *   - собственный класс ошибок OcrEngineError с полем details.
 *
 * Зависимости: только Node.js core (fs, path, os, child_process) плюс
 *              опциональный пакет tesseract.js.
 *
 * Пример:
 *   const { extract } = require('./sensors/ocr_engine');
 *   const res = await extract('./scan.png', { lang: 'rus+eng', psm: 3 });
 *   console.log(res.text, res.confidence);
 * =============================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');

/* ==========================================================================
 * 1. Константы и конфигурация по умолчанию
 * ========================================================================== */

const DEFAULT_LANG = 'rus+eng';
const DEFAULT_PSM = 3; // Fully automatic page segmentation, без OSD.
const DEFAULT_OEM = 3; // Default engine (LSTM + legacy).
const DEFAULT_DPI = 300;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_BUFFER = 64 * 1024 * 1024;
const HEAD_BYTES = 4096;

const DEFAULT_CONFIG = Object.freeze({
  binary: process.env.TESSERACT_BIN || 'tesseract',
  backend: null, // null = auto
  lang: DEFAULT_LANG,
  psm: DEFAULT_PSM,
  oem: DEFAULT_OEM,
  dpi: DEFAULT_DPI,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  retries: 1,
  retryDelayMs: 250,
  tessdata: process.env.TESSDATA_PREFIX || null,
  whitelist: null, // строка допустимых символов (tessedit_char_whitelist)
  config: [], // дополнительные -c key=value
  cachePath: path.join(os.tmpdir(), 'ocr-engine-cache'),
});

/** Магические байты -> формат изображения. */
const SIGNATURES = [
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { format: 'bmp', bytes: [0x42, 0x4d] },
  { format: 'tiff-le', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { format: 'tiff-be', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { format: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF
];

/** Форматы, которые Tesseract понимает «из коробки». */
const SUPPORTED_FORMATS = new Set([
  'png',
  'jpeg',
  'gif',
  'bmp',
  'tiff-le',
  'tiff-be',
  'webp',
]);

/** Расширения, которые считаем изображениями, если магия не распознана. */
const SUPPORTED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.pnm',
  '.pbm', '.pgm', '.ppm',
]);

const DEBUG = process.env.OCR_ENGINE_DEBUG === '1';

/* ==========================================================================
 * 2. Ошибки и логирование
 * ========================================================================== */

/**
 * Ошибка OCR-движка. Содержит машинночитаемые details.
 * @extends Error
 */
class OcrEngineError extends Error {
  /**
   * @param {string} message
   * @param {object} [details]
   */
  constructor(message, details) {
    super(message);
    this.name = 'OcrEngineError';
    this.details = details || {};
  }
}

function log(...args) {
  if (DEBUG) console.error('[ocr_engine]', ...args);
}

function warn(...args) {
  if (DEBUG) console.error('[ocr_engine][warn]', ...args);
}

/* ==========================================================================
 * 3. Общие помощники
 * ========================================================================== */

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/**
 * Нормализация распознанного текста: CRLF -> LF, схлопывание пробелов
 * внутри строк, удаление пустых строк по краям.
 * @param {string} raw
 * @returns {string}
 */
function normalizeText(raw) {
  if (typeof raw !== 'string') return '';
  const unified = raw.replace(/\r\n?/g, '\n').replace(/\f/g, '');
  const lines = unified
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim());
  // Обрезаем пустые строки в начале/конце.
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // Схлопываем подряд идущие пустые строки в одну.
  const out = [];
  for (const line of lines) {
    if (line === '' && out.length > 0 && out[out.length - 1] === '') continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

/**
 * Разбить нормализованный текст на непустые строки.
 * @param {string} text
 * @returns {string[]}
 */
function splitLines(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .filter((line) => line.length > 0);
}

/* ==========================================================================
 * 4. Определение формата и размеров изображения
 * ========================================================================== */

/**
 * Прочитать первые N байт файла.
 * @param {string} file
 * @param {number} n
 * @returns {Buffer}
 */
function readHead(file, n) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.max(0, Math.min(n, size));
    const buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Определить формат изображения по магическим байтам.
 * @param {Buffer} head
 * @returns {string|null}
 */
function detectFormat(head) {
  if (!Buffer.isBuffer(head) || head.length === 0) return null;
  for (const sig of SIGNATURES) {
    if (head.length < sig.bytes.length) continue;
    let match = true;
    for (let i = 0; i < sig.bytes.length; i += 1) {
      if (head[i] !== sig.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      if (sig.format === 'webp') {
        if (head.length >= 12 && head.toString('ascii', 8, 12) === 'WEBP') return 'webp';
        continue;
      }
      return sig.format;
    }
  }
  return null;
}

/* ---- Извлечение размеров из заголовков ---- */

function pngSize(buf) {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function gifSize(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function bmpSize(buf) {
  if (buf.length < 26) return null;
  return {
    width: Math.abs(buf.readInt32LE(18)),
    height: Math.abs(buf.readInt32LE(22)),
  };
}

function jpegSize(buf) {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (offset + 3 >= buf.length) break;
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) break;
    offset += 2 + segLen;
  }
  return null;
}

/**
 * Определить размеры изображения (width/height) из заголовка.
 * @param {string} file
 * @param {string} format
 * @returns {{width:number, height:number}|null}
 */
function imageSize(file, format) {
  try {
    const head = readHead(file, HEAD_BYTES);
    switch (format) {
      case 'png': return pngSize(head);
      case 'gif': return gifSize(head);
      case 'bmp': return bmpSize(head);
      case 'jpeg': return jpegSize(head);
      default: return null;
    }
  } catch (err) {
    return null;
  }
}

/* ==========================================================================
 * 5. Валидация входного файла
 * ========================================================================== */

/**
 * Проверить, что путь — валидный непустой файл-изображение.
 * @param {string} imagePath
 * @returns {{resolved:string, bytes:number, format:string|null, ext:string}}
 */
function assertImagePath(imagePath) {
  if (!isNonEmptyString(imagePath)) {
    throw new OcrEngineError('imagePath должен быть непустой строкой', {
      code: 'OCR_BAD_PATH',
    });
  }
  const resolved = path.resolve(imagePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    throw new OcrEngineError(`Файл не найден: ${resolved}`, {
      code: 'OCR_ENOENT',
      path: resolved,
    });
  }
  if (!stat.isFile()) {
    throw new OcrEngineError(`Не является файлом: ${resolved}`, {
      code: 'OCR_EISDIR',
      path: resolved,
    });
  }
  if (stat.size === 0) {
    throw new OcrEngineError(`Пустой файл: ${resolved}`, {
      code: 'OCR_EMPTY',
      path: resolved,
    });
  }
  const ext = path.extname(resolved).toLowerCase();
  let format = null;
  try {
    format = detectFormat(readHead(resolved, HEAD_BYTES));
  } catch (err) {
    warn('readHead failed', err && err.message);
  }
  if (!format && !SUPPORTED_EXTENSIONS.has(ext)) {
    throw new OcrEngineError(
      `Неподдерживаемый формат файла: ${resolved} (ext="${ext || 'n/a'}")`,
      { code: 'OCR_UNSUPPORTED', path: resolved, ext },
    );
  }
  return { resolved, bytes: stat.size, format, ext };
}

/* ==========================================================================
 * 6. Разбор TSV-вывода tesseract (слова, bbox, уверенность)
 * ========================================================================== */

/**
 * Разобрать TSV-строку в структуру { level, text, confidence, bbox }.
 * @param {string} line
 * @returns {object|null}
 */
function parseTsvLine(line) {
  const cols = line.split('\t');
  if (cols.length < 12) return null;
  const level = Number(cols[0]);
  if (!Number.isFinite(level)) return null;
  const text = cols.slice(11).join('\t');
  return {
    level,
    page: Number(cols[1]) || 0,
    block: Number(cols[2]) || 0,
    par: Number(cols[3]) || 0,
    line: Number(cols[4]) || 0,
    word: Number(cols[5]) || 0,
    left: Number(cols[6]) || 0,
    top: Number(cols[7]) || 0,
    width: Number(cols[8]) || 0,
    height: Number(cols[9]) || 0,
    confidence: Number(cols[10]) || 0,
    text: text.replace(/\s+$/g, ''),
  };
}

/**
 * Преобразовать TSV-вывод tesseract в массив слов.
 * @param {string} tsv
 * @returns {{words:Array, text:string}}
 */
function parseTsv(tsv) {
  const words = [];
  const textLines = [];
  const lines = String(tsv || '').split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    const row = parseTsvLine(raw);
    if (!row) continue;
    // Уровень 5 — слово, 4 — строка.
    if (row.level === 5 && row.text.trim() !== '') {
      words.push({
        text: row.text,
        confidence: row.confidence,
        bbox: { x: row.left, y: row.top, width: row.width, height: row.height },
      });
    } else if (row.level === 4 && row.text.trim() !== '') {
      textLines.push(row.text.replace(/\s+$/g, ''));
    }
  }
  return { words, text: textLines.join('\n') };
}

/**
 * Обратно совместимое имя: получить слова и текст из TSV.
 * @param {string} tsv
 * @returns {{words:Array, text:string}}
 */
function textFromTsv(tsv) {
  return parseTsv(tsv);
}

/* ==========================================================================
 * 7. Статистика уверенности
 * ========================================================================== */

function normaliseConfidence(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const i = Math.trunc(n);
  if (i < 0) return 0;
  if (i > 100) return 100;
  return i;
}

/**
 * Средняя уверенность по массиву слов.
 * @param {Array} words
 * @returns {number}
 */
function estimateConfidence(words) {
  if (!Array.isArray(words) || words.length === 0) return 0;
  const total = words.reduce((acc, w) => acc + normaliseConfidence(w.confidence), 0);
  return Math.round((total / words.length) * 100) / 100;
}

const meanConfidence = estimateConfidence;

/* ==========================================================================
 * 8. Сборка итогового результата
 * ========================================================================== */

/**
 * Собрать OcrResult.
 * @param {string} text
 * @param {object} meta
 * @param {object} cfg
 * @param {number} durationMs
 * @param {Array} words
 * @param {string} engine
 * @returns {object}
 */
function assembleResult(text, meta, cfg, durationMs, words, engine) {
  const normalized = normalizeText(text);
  const wordList = Array.isArray(words) ? words : [];
  return {
    text: normalized,
    lines: splitLines(normalized),
    words: wordList,
    confidence: wordList.length > 0 ? estimateConfidence(wordList) : (meta.confidence || 0),
    meta: Object.assign({}, meta, {
      engine: engine || cfg.backend || 'tesseract',
      backend: cfg.backend || 'auto',
      lang: cfg.lang,
      psm: cfg.psm,
      oem: cfg.oem,
      dpi: cfg.dpi,
      durationMs,
    }),
  };
}

/* ==========================================================================
 * 9. Конфигурация запуска
 * ========================================================================== */

/**
 * Слить пользовательские опции с дефолтами и провалидировать.
 * @param {object} [options]
 * @returns {object}
 */
function resolveConfig(options) {
  const o = options && typeof options === 'object' ? options : {};
  return {
    binary: isNonEmptyString(o.binary) ? o.binary : DEFAULT_CONFIG.binary,
    backend: isNonEmptyString(o.backend) ? o.backend : DEFAULT_CONFIG.backend,
    lang: isNonEmptyString(o.lang) ? o.lang : DEFAULT_CONFIG.lang,
    psm: clampInt(o.psm, 0, 13, DEFAULT_CONFIG.psm),
    oem: clampInt(o.oem, 0, 3, DEFAULT_CONFIG.oem),
    dpi: clampInt(o.dpi, 1, 10000, DEFAULT_CONFIG.dpi),
    timeoutMs: clampInt(o.timeoutMs, 1000, 3600000, DEFAULT_CONFIG.timeoutMs),
    retries: clampInt(o.retries, 0, 10, DEFAULT_CONFIG.retries),
    retryDelayMs: clampInt(o.retryDelayMs, 0, 60000, DEFAULT_CONFIG.retryDelayMs),
    tessdata: isNonEmptyString(o.tessdata) ? o.tessdata : DEFAULT_CONFIG.tessdata,
    whitelist: isNonEmptyString(o.whitelist) ? o.whitelist : DEFAULT_CONFIG.whitelist,
    config: Array.isArray(o.config) ? o.config.slice() : DEFAULT_CONFIG.config.slice(),
    cachePath: isNonEmptyString(o.cachePath) ? o.cachePath : DEFAULT_CONFIG.cachePath,
  };
}

/* ==========================================================================
 * 10. Бэкенд CLI (бинарник tesseract)
 * ========================================================================== */

/**
 * Проверить доступность бинарника в PATH.
 * @param {string} binary
 * @returns {boolean}
 */
function binaryAvailable(binary) {
  try {
    const res = childProcess.spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    return !res.error;
  } catch (err) {
    return false;
  }
}

/**
 * Получить версию бинарника.
 * @param {string} binary
 * @returns {string|null}
 */
function binaryVersion(binary) {
  try {
    const res = childProcess.spawnSync(binary, ['--version'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    if (res.error) return null;
    const out = String(res.stdout || '') + String(res.stderr || '');
    const m = out.match(/tesseract\s+v?([0-9][0-9A-Za-z.\-]*)/i);
    return m ? m[1] : out.trim().split('\n')[0] || null;
  } catch (err) {
    return null;
  }
}

/**
 * Собрать аргументы командной строки tesseract.
 * @param {string} imagePath
 * @param {string} outputBase
 * @param {object} cfg
 * @param {string} format 'tsv' | 'txt'
 * @returns {string[]}
 */
function buildArgs(imagePath, outputBase, cfg, format) {
  const args = [imagePath, outputBase, '-l', cfg.lang];
  if (format === 'tsv') args.push('tsv');
  // Параметры движка.
  args.push('--psm', String(cfg.psm));
  args.push('--oem', String(cfg.oem));
  if (cfg.dpi) args.push('--dpi', String(cfg.dpi));
  if (cfg.tessdata) args.push('--tessdata-dir', cfg.tessdata);
  if (cfg.whitelist) {
    args.push('-c', `tessedit_char_whitelist=${cfg.whitelist}`);
  }
  for (const item of cfg.config) {
    if (typeof item === 'string' && item.includes('=')) {
      args.push('-c', item);
    }
  }
  return args;
}

/**
 * Распознать изображение через CLI-бинарник tesseract.
 * @param {string} imagePath
 * @param {object} cfg
 * @param {object} meta
 * @param {number} started
 * @returns {object} OcrResult
 */
function runCli(imagePath, cfg, meta, started) {
  const tmpBase = path.join(
    os.tmpdir(),
    `ocr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    const args = buildArgs(imagePath, tmpBase, cfg, 'tsv');
    log('cli args:', args.join(' '));
    const res = childProcess.spawnSync(cfg.binary, args, {
      encoding: 'utf8',
      timeout: cfg.timeoutMs,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });

    if (res.error) {
      throw new OcrEngineError(`Ошибка запуска tesseract: ${res.error.message}`, {
        code: res.error.code || 'OCR_SPAWN',
      });
    }
    if (typeof res.status === 'number' && res.status !== 0) {
      const stderr = String(res.stderr || '').trim();
      throw new OcrEngineError(`tesseract завершился с кодом ${res.status}`, {
        code: 'OCR_CLI_STATUS',
        status: res.status,
        stderr,
      });
    }

    // tesseract пишет результат в <tmpBase>.tsv
    let tsv = '';
    const tsvPath = `${tmpBase}.tsv`;
    if (fs.existsSync(tsvPath)) {
      tsv = fs.readFileSync(tsvPath, 'utf8');
    } else if (res.stdout) {
      // На случай, если пользовательский билд пишет в stdout.
      tsv = String(res.stdout);
    }

    const parsed = parseTsv(tsv);
    const hasWords = parsed.words.length > 0;
    const text = hasWords ? parsed.text : normalizeText(tsv);
    return assembleResult(
      text,
      meta,
      cfg,
      Date.now() - started,
      hasWords ? parsed.words : [],
      'tesseract-cli',
    );
  } finally {
    cleanupTmpFiles(tmpBase);
  }
}

/**
 * Удалить временные файлы tesseract.
 * @param {string} base
 */
function cleanupTmpFiles(base) {
  for (const ext of ['', '.tsv', '.txt', '.hocr', '.html', '.box', '.osd']) {
    const p = base + ext;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (err) {
      warn('cleanup failed', p, err && err.message);
    }
  }
}

/* ==========================================================================
 * 11. Бэкенд tesseract.js (WASM)
 * ========================================================================== */

let TessJs = null;
let tessJsLoaded = false;
let tessJsError = null;

function loadTesseractJs() {
  if (tessJsLoaded) return TessJs;
  tessJsLoaded = true;
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    TessJs = require('tesseract.js');
  } catch (err) {
    TessJs = null;
    tessJsError = err;
  }
  return TessJs;
}

async function runTesseractJs(imagePath, cfg, meta, started) {
  const T = loadTesseractJs();
  if (!T) {
    throw new OcrEngineError(
      'tesseract.js не установлен (npm i tesseract.js)',
      { code: 'OCR_NO_TESSJS', cause: tessJsError && tessJsError.message },
    );
  }
  const createOptions = { cachePath: cfg.cachePath };
  if (typeof cfg.logger === 'function') createOptions.logger = cfg.logger;
  const worker = await T.createWorker(cfg.lang, cfg.oem, createOptions);
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: String(cfg.psm),
      user_defined_dpi: String(cfg.dpi),
    });
    const { data } = await worker.recognize(imagePath);
    const words = Array.isArray(data && data.words)
      ? data.words.map((w) => ({
        text: w.text,
        confidence: normaliseConfidence(w.confidence),
        bbox: w.bbox
          ? {
            x: w.bbox.x0 | 0,
            y: w.bbox.y0 | 0,
            width: (w.bbox.x1 - w.bbox.x0) | 0,
            height: (w.bbox.y1 - w.bbox.y0) | 0,
          }
          : null,
      }))
      : [];
    const text = (data && data.text) || '';
    const confidence = data && typeof data.confidence === 'number'
      ? Math.round(data.confidence * 100) / 100
      : 0;
    const meta2 = Object.assign({}, meta, { confidence });
    return assembleResult(text, meta2, cfg, Date.now() - started, words, 'tesseract.js');
  } finally {
    try {
      await worker.terminate();
    } catch (err) {
      warn('worker.terminate failed', err && err.message);
    }
  }
}

/* ==========================================================================
 * 12. Выбор бэкенда и публичный API
 * ========================================================================== */

/**
 * Выбрать бэкенд: явный -> 'tesseract.js' (если установлен) -> 'cli'.
 * @param {object} cfg
 * @returns {string}
 */
function pickBackend(cfg) {
  if (cfg.backend === 'cli' || cfg.backend === 'tesseract.js') return cfg.backend;
  if (loadTesseractJs()) return 'tesseract.js';
  return 'cli';
}

function buildMeta(imagePath, info) {
  const size = info.format ? imageSize(imagePath, info.format) : null;
  return {
    file: info.resolved,
    format: info.format,
    ext: info.ext,
    width: size ? size.width : null,
    height: size ? size.height : null,
    bytes: info.bytes,
  };
}

/**
 * Распознать текст на изображении.
 * @param {string} imagePath
 * @param {object} [options]
 * @returns {Promise<object>} OcrResult
 */
async function extract(imagePath, options) {
  const cfg = resolveConfig(options);
  const info = assertImagePath(imagePath);
  const meta = buildMeta(info.resolved, info);
  const started = Date.now();
  const attempts = Math.max(1, cfg.retries + 1);

  let backend = pickBackend(cfg);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      log(`attempt ${attempt}/${attempts}, backend=${backend}`);
      if (backend === 'tesseract.js') {
        return await runTesseractJs(info.resolved, cfg, meta, started);
      }
      return runCli(info.resolved, cfg, meta, started);
    } catch (err) {
      lastError = err;
      // Fallback: если tesseract.js упал — пробуем CLI (и наоборот).
      if (backend === 'tesseract.js' && !cfg.backend) {
        warn('tesseract.js failed, falling back to CLI:', err && err.message);
        backend = 'cli';
        if (attempt < attempts) {
          await sleep(cfg.retryDelayMs * attempt);
          continue;
        }
      }
      if (attempt < attempts) {
        await sleep(cfg.retryDelayMs * attempt);
      }
    }
  }

  if (lastError instanceof OcrEngineError) throw lastError;
  throw new OcrEngineError(
    `OCR не удался: ${lastError ? lastError.message : 'неизвестная ошибка'}`,
    { code: 'OCR_FAILED', cause: lastError && lastError.message },
  );
}

/**
 * Синхронный вариант — только CLI-бэкенд.
 * @param {string} imagePath
 * @param {object} [options]
 * @returns {object} OcrResult
 */
function extractSync(imagePath, options) {
  const cfg = resolveConfig(options);
  cfg.backend = 'cli';
  const info = assertImagePath(imagePath);
  const meta = buildMeta(info.resolved, info);
  const started = Date.now();
  return runCli(info.resolved, cfg, meta, started);
}

/**
 * Проверить доступность OCR-движка.
 * @returns {{available:boolean, binary:string, version:string|null,
 *            tesseractJs:boolean}}
 */
function checkAvailability() {
  const binary = DEFAULT_CONFIG.binary;
  const available = binaryAvailable(binary);
  const tesseractJs = !!loadTesseractJs();
  return {
    available: available || tesseractJs,
    binary,
    version: available ? binaryVersion(binary) : null,
    tesseractJs,
  };
}

/**
 * Фабрика движка с общей конфигурацией (удобно для повторных вызовов).
 * @param {object} [options]
 * @returns {{extract:Function, extractSync:Function, options:object}}
 */
function createEngine(options) {
  const cfg = resolveConfig(options);
  return {
    options: cfg,
    extract: (imagePath, overrides) => extract(imagePath, Object.assign({}, cfg, overrides)),
    extractSync: (imagePath, overrides) => extractSync(imagePath, Object.assign({}, cfg, overrides)),
  };
}

/* ==========================================================================
 * 13. Экспорт
 * ========================================================================== */

module.exports = {
  extract,
  extractSync,
  checkAvailability,
  createEngine,
  // вспомогательные функции, полезные для тестов и композиции
  OcrEngineError,
  detectFormat,
  normalizeText,
  splitLines,
  parseTsv,
  textFromTsv,
  estimateConfidence,
  assertImagePath,
  _internal: {
    resolveConfig,
    buildArgs,
    binaryAvailable,
    binaryVersion,
    meanConfidence,
    assembleResult,
    imageSize,
    SIGNATURES,
    SUPPORTED_FORMATS,
    SUPPORTED_EXTENSIONS,
    SUPPORTED_EXTENSIONS_LIST: Array.from(SUPPORTED_EXTENSIONS),
    DEFAULT_CONFIG,
  },
};

/* ==========================================================================
 * 14. CLI-запуск:  node sensors/ocr_engine.js <image> [lang] [psm]
 * ========================================================================== */

if (require.main === module) {
  const [, , fileArg, langArg, psmArg] = process.argv;
  if (!fileArg) {
    console.error('Usage: node sensors/ocr_engine.js <image> [lang] [psm]');
    process.exit(2);
  }
  (async () => {
    try {
      const res = await extract(fileArg, {
        lang: langArg || DEFAULT_LANG,
        psm: psmArg != null ? Number(psmArg) : DEFAULT_PSM,
      });
      process.stdout.write(res.text + '\n');
      console.error(`[ocr_engine] words=${res.words.length} confidence=${res.confidence}`);
      process.exit(0);
    } catch (err) {
      console.error('[ocr_engine] error:', err && err.message);
      process.exit(1);
    }
  })();
}
