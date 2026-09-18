'use strict';

/**
 * sensors/pdf_reader.js
 * =====================
 * Сенсор чтения PDF-документов на чистом Node.js (без внешних бинарников).
 *
 * Публичный API:
 *   read(pdfPath[, options])       -> Promise<PdfDocument>
 *   readBuffer(buffer[, options])  -> Promise<PdfDocument>
 *   isPdf(input)                   -> boolean
 *   PdfReader                      -> class
 *
 * PdfDocument:
 *   {
 *     path, size, version,
 *     pageCount, numPages, numObjects, numStreams,
 *     metadata, info,
 *     pages: [{ index, text, charCount }],
 *     pageTexts: string[],
 *     text: string,
 *     warnings: string[],
 *     durationMs: number,
 *     source: 'builtin'
 *   }
 *
 * Встроенный парсер умеет:
 *   1. Проверять сигнатуру %PDF-.
 *   2. Разбирать версию, trailer и объекты <n> <g> obj ... endobj.
 *   3. Декодировать потоки: FlateDecode, ASCIIHexDecode, ASCII85Decode.
 *   4. Извлекать текст из контент-потоков (операторы Tj, TJ, ', ").
 *   5. Собирать страницы (по /Type /Page) и общий текст документа.
 *   6. Возвращать метаданные /Info (Title, Author, Subject, ...).
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

const PDF_MAGIC = '%PDF-';
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024; // 96 MB
const DEFAULT_TIMEOUT_MS = 30000;

const DEFAULT_OPTIONS = Object.freeze({
  maxBytes: DEFAULT_MAX_BYTES,
  maxPages: Infinity,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  includeMetadata: true,
  normalizeWhitespace: true,
  pageSeparator: '\n\n',
  recover: true,
});

/* ------------------------------------------------------------------ */
/* Базовые утилиты                                                     */
/* ------------------------------------------------------------------ */

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isBufferLike(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array;
}

function mergeOptions(options) {
  if (options == null) return Object.assign({}, DEFAULT_OPTIONS);
  if (typeof options !== 'object') {
    throw new TypeError('pdf_reader: options должен быть объектом');
  }
  return Object.assign({}, DEFAULT_OPTIONS, options);
}

function normalizeWhitespace(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Декодирует PDF-строку: раскрывает escape-последовательности и octal.
 * @param {string} raw
 * @returns {string}
 */
function decodePdfString(raw) {
  if (typeof raw !== 'string') return '';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    switch (next) {
      case 'n': out += '\n'; i += 1; break;
      case 'r': out += '\r'; i += 1; break;
      case 't': out += '\t'; i += 1; break;
      case 'b': out += '\b'; i += 1; break;
      case 'f': out += '\f'; i += 1; break;
      case '(': out += '('; i += 1; break;
      case ')': out += ')'; i += 1; break;
      case '\\': out += '\\'; i += 1; break;
      default: {
        if (next && /[0-7]/.test(next)) {
          const oct = raw.substr(i + 1, 3).match(/[0-7]{1,3}/);
          if (oct) {
            out += String.fromCharCode(parseInt(oct[0], 8));
            i += oct[0].length;
          }
        } else {
          if (next !== undefined) {
            out += next;
            i += 1;
          }
        }
      }
    }
  }
  return out;
}

/**
 * Преобразует hex-строку PDF (<48656c6c6f>) в текст.
 * @param {string} hex
 * @returns {string}
 */
function hexToString(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    bytes.push(parseInt(clean.substr(i, 2), 16));
  }
  const buf = Buffer.from(bytes);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.slice(2).toString('utf16be').replace(/\u0000/g, '');
  }
  return buf.toString('latin1');
}

/**
 * Проверка сигнатуры PDF по пути или буферу. Никогда не бросает.
 * @param {string|Buffer|Uint8Array} input
 * @returns {boolean}
 */
function isPdf(input) {
  try {
    if (typeof input === 'string') {
      if (!isNonEmptyString(input)) return false;
      const fd = fs.openSync(input, 'r');
      try {
        const head = Buffer.alloc(5);
        const read = fs.readSync(fd, head, 0, 5, 0);
        return read === 5 && head.toString('latin1') === PDF_MAGIC;
      } finally {
        fs.closeSync(fd);
      }
    }
    if (isBufferLike(input)) {
      return Buffer.from(input).slice(0, 5).toString('latin1') === PDF_MAGIC;
    }
  } catch (_err) {
    return false;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Декодеры потоков                                                    */
/* ------------------------------------------------------------------ */

function inflateStream(buf) {
  const attempts = [
    () => zlib.inflateSync(buf),
    () => zlib.inflateRawSync(buf),
    () => zlib.gunzipSync(buf),
  ];
  for (const attempt of attempts) {
    try {
      const out = attempt();
      if (out && out.length) return out;
    } catch (_err) {
      /* пробуем следующий вариант */
    }
  }
  return buf;
}

function asciiHexDecode(buf) {
  const text = buf.toString('latin1').replace(/\s+/g, '').replace(/>.*$/, '');
  const bytes = [];
  for (let i = 0; i + 1 < text.length; i += 2) {
    bytes.push(parseInt(text.substr(i, 2), 16));
  }
  return Buffer.from(bytes);
}

function ascii85Decode(buf) {
  const text = buf.toString('latin1').replace(/\s+/g, '');
  const end = text.indexOf('~>');
  const data = end === -1 ? text : text.slice(0, end);
  const out = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    if (ch === 'z' && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = ch.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    tuple = tuple * 85 + code;
    count += 1;
    if (count === 5) {
      out.push(
        (tuple >>> 24) & 0xff,
        (tuple >>> 16) & 0xff,
        (tuple >>> 8) & 0xff,
        tuple & 0xff
      );
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i += 1) tuple = tuple * 85 + 84;
    out.push(
      (tuple >>> 24) & 0xff,
      (tuple >>> 16) & 0xff,
      (tuple >>> 8) & 0xff,
      tuple & 0xff
    );
    out.splice(out.length - (5 - count), 5 - count);
  }
  return Buffer.from(out);
}

function parseFilters(dictRaw) {
  const m = dictRaw.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/);
  if (!m) return [];
  const names = m[1].match(/\/([A-Za-z0-9]+)/g) || [];
  return names.map((n) => n.slice(1));
}

function decodeStream(raw, filters) {
  let out = raw;
  for (const filter of filters) {
    if (filter === 'FlateDecode' || filter === 'Fl') {
      out = inflateStream(out);
    } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
      out = asciiHexDecode(out);
    } else if (filter === 'ASCII85Decode' || filter === 'A85') {
      out = ascii85Decode(out);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Токенизация контент-потока и извлечение текста                      */
/* ------------------------------------------------------------------ */

function tokenizeContent(src) {
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '%') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '(') {
      i += 1;
      let depth = 1;
      let val = '';
      while (i < n && depth > 0) {
        const c = src[i];
        if (c === '\\') {
          val += c;
          if (i + 1 < n) val += src[i + 1];
          i += 2;
          continue;
        }
        if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) { i += 1; break; }
        }
        val += c;
        i += 1;
      }
      tokens.push({ type: 'string', value: decodePdfString(val) });
      continue;
    }
    if (ch === '<') {
      if (src[i + 1] === '<') { tokens.push({ type: 'dict-open' }); i += 2; continue; }
      const end = src.indexOf('>', i);
      const hex = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
      tokens.push({ type: 'string', value: hexToString(hex) });
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (ch === '>') {
      if (src[i + 1] === '>') i += 2; else i += 1;
      tokens.push({ type: 'dict-close' });
      continue;
    }
    if (ch === '[') { tokens.push({ type: 'array-open' }); i += 1; continue; }
    if (ch === ']') { tokens.push({ type: 'array-close' }); i += 1; continue; }
    if (/\s/.test(ch)) { i += 1; continue; }

    let j = i;
    while (j < n && !/\s/.test(src[j]) && '()<>[]{}/%'.indexOf(src[j]) === -1) j += 1;
    if (j === i) {
      tokens.push({ type: 'token', value: src[i] });
      i += 1;
    } else {
      tokens.push({ type: 'token', value: src.slice(i, j) });
      i = j;
    }
  }
  return tokens;
}

function arrayToString(arr) {
  let out = '';
  for (const item of arr) {
    if (item.str != null) out += item.str;
    else if (item.num != null && item.num < -100) out += ' ';
  }
  return out;
}

function extractTextFromContent(content) {
  if (!isNonEmptyString(content)) return '';
  const tokens = tokenizeContent(content);
  const out = [];
  let operands = [];

  for (let k = 0; k < tokens.length; k += 1) {
    const tok = tokens[k];
    if (tok.type === 'string') {
      operands.push({ str: tok.value });
      continue;
    }
    if (tok.type === 'array-open') {
      const arr = [];
      k += 1;
      while (k < tokens.length && tokens[k].type !== 'array-close') {
        const inner = tokens[k];
        if (inner.type === 'string') arr.push({ str: inner.value });
        else if (inner.type === 'token') arr.push({ num: Number(inner.value) });
        k += 1;
      }
      operands.push({ array: arr });
      continue;
    }
    if (tok.type === 'token') {
      const op = tok.value;
      const last = operands.length ? operands[operands.length - 1] : null;
      if (op === 'Tj' || op === "'" || op === '"') {
        if (last && last.str != null) out.push(last.str);
        else if (last && last.array) out.push(arrayToString(last.array));
        if (op !== 'Tj') out.push('\n');
        operands = [];
      } else if (op === 'TJ') {
        if (last && last.array) out.push(arrayToString(last.array));
        else if (last && last.str != null) out.push(last.str);
        operands = [];
      } else if (op === 'Td' || op === 'TD' || op === 'T*') {
        out.push('\n');
        operands = [];
      } else if (op === 'BT' || op === 'ET') {
        out.push('\n');
        operands = [];
      } else {
        operands = [];
      }
      continue;
    }
  }
  return out.join('');
}

/* ------------------------------------------------------------------ */
/* Разбор объектов                                                     */
/* ------------------------------------------------------------------ */

function parseDictionaryKeys(dictRaw) {
  const keys = {};
  const re = /\/([A-Za-z0-9#]+)\s*(\[[^\]]*\]|[^\s/<>[\]]+|\/[A-Za-z0-9#]+)/g;
  let m;
  while ((m = re.exec(dictRaw)) !== null) {
    keys[m[1]] = m[2];
  }
  return keys;
}

function parseContentRefs(contentsRaw) {
  const refs = [];
  const re = /(\d+)\s+(\d+)\s+R/g;
  let m;
  while ((m = re.exec(contentsRaw)) !== null) {
    refs.push({ id: parseInt(m[1], 10), gen: parseInt(m[2], 10) });
  }
  return refs;
}

function parseInfoFromText(text) {
  const meta = {};
  const keys = [
    'Title', 'Author', 'Subject', 'Keywords',
    'Creator', 'Producer', 'CreationDate', 'ModDate',
  ];
  for (const key of keys) {
    const lit = new RegExp('\\/' + key + '\\s*\\(([^)]*)\\)', 'm');
    const hex = new RegExp('\\/' + key + '\\s*<([0-9a-fA-F\\s]+)>', 'm');
    const lm = text.match(lit);
    const hm = text.match(hex);
    if (lm) meta[key] = decodePdfString(lm[1]);
    else if (hm) meta[key] = hexToString(hm[1]);
  }
  return meta;
}

/* ------------------------------------------------------------------ */
/* Класс PdfReader                                                     */
/* ------------------------------------------------------------------ */

class PdfReader {
  constructor(options = {}) {
    this.options = mergeOptions(options);
  }

  /**
   * Читает PDF-файл с диска.
   * @param {string} pdfPath
   * @returns {Promise<object>}
   */
  async read(pdfPath) {
    if (!isNonEmptyString(pdfPath)) {
      throw new TypeError('pdf_reader.read: pdfPath должен быть непустой строкой');
    }
    const resolved = path.resolve(pdfPath);
    const started = Date.now();

    let stat;
    try {
      stat = await fsp.stat(resolved);
    } catch (err) {
      const wrapped = new Error(
        'pdf_reader.read: файл недоступен: ' + resolved + ' (' + (err.code || 'ERR') + ')'
      );
      wrapped.code = err.code || 'ENOENT';
      throw wrapped;
    }

    if (stat.isDirectory()) {
      const err = new Error('pdf_reader.read: это директория, а не PDF: ' + resolved);
      err.code = 'EISDIR';
      throw err;
    }
    if (!stat.isFile()) {
      const err = new Error('pdf_reader.read: не обычный файл: ' + resolved);
      err.code = 'EINVAL';
      throw err;
    }
    if (stat.size === 0) {
      const err = new Error('pdf_reader.read: пустой файл: ' + resolved);
      err.code = 'EMPTY_FILE';
      throw err;
    }
    if (stat.size > this.options.maxBytes) {
      const err = new Error(
        'pdf_reader.read: файл слишком большой: ' + stat.size + ' байт'
      );
      err.code = 'TOO_LARGE';
      throw err;
    }

    const buffer = await this._readWithTimeout(resolved);
    const doc = await this.readBuffer(buffer, { path: resolved });
    doc.size = stat.size;
    doc.durationMs = Date.now() - started;
    return doc;
  }

  /**
   * Разбирает PDF из буфера.
   * @param {Buffer|Uint8Array} input
   * @param {{path?: string}} [context]
   * @returns {Promise<object>}
   */
  async readBuffer(input, context = {}) {
    if (!isBufferLike(input)) {
      throw new TypeError('pdf_reader.readBuffer: ожидается Buffer или Uint8Array');
    }
    const buffer = Buffer.from(input);
    const warnings = [];
    const opts = this.options;

    if (buffer.length < 5 || buffer.slice(0, 5).toString('latin1') !== PDF_MAGIC) {
      const err = new Error('pdf_reader: отсутствует сигнатура %PDF-');
      err.code = 'NOT_PDF';
      throw err;
    }

    const text = buffer.toString('latin1');
    const version = this._parseVersion(text);
    const encrypted = /\/Encrypt\b/.test(text);
    if (encrypted) warnings.push('Документ помечен как зашифрованный (/Encrypt)');

    const objects = this._parseObjects(text);
    const numStreams = objects.filter((o) => o.stream !== null).length;
    const metadata = opts.includeMetadata ? parseInfoFromText(text) : {};

    const pages = this._buildPages(objects, opts, warnings);
    const pageTexts = pages.map((p) => p.text);
    let fullText = pageTexts.join(opts.pageSeparator);
    if (opts.normalizeWhitespace) fullText = normalizeWhitespace(fullText);

    const result = {
      path: context.path || null,
      size: buffer.length,
      version,
      pageCount: pages.length,
      numPages: pages.length,
      numObjects: objects.length,
      numStreams,
      metadata,
      info: {
        valid: true,
        encrypted,
        hasObjects: objects.length > 0,
        xrefCount: objects.length,
        linearized: /\/Linearized\b/.test(text),
      },
      pages,
      pageTexts,
      text: fullText,
      warnings,
      durationMs: 0,
      source: 'builtin',
      toJSON() {
        return {
          path: this.path,
          size: this.size,
          version: this.version,
          pageCount: this.pageCount,
          numPages: this.numPages,
          numObjects: this.numObjects,
          numStreams: this.numStreams,
          metadata: this.metadata,
          info: this.info,
          pages: this.pages,
          text: this.text,
          warnings: this.warnings,
        };
      },
    };

    return result;
  }

  /* ---------------------------------------------------------------- */

  _readWithTimeout(file) {
    const timeoutMs = this.options.timeoutMs;
    const reading = fsp.readFile(file);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return reading;
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('pdf_reader: таймаут чтения ' + timeoutMs + 'ms');
        err.code = 'ETIMEDOUT';
        reject(err);
      }, timeoutMs);
    });
    return Promise.race([reading, guard]).finally(() => clearTimeout(timer));
  }

  _parseVersion(text) {
    const m = text.slice(0, 32).match(/%PDF-(\d+\.\d+)/);
    return m ? m[1] : 'unknown';
  }

  _parseObjects(text) {
    const objects = [];
    const re = /(\d+)\s+(\d+)\s+obj\b([\s\S]*?)endobj/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const body = m[3];
      const dictRaw = body.split('stream', 1)[0];
      const obj = {
        id: parseInt(m[1], 10),
        gen: parseInt(m[2], 10),
        dictRaw,
        keys: parseDictionaryKeys(dictRaw),
        stream: null,
      };
      const sm = body.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
      if (sm) {
        const filters = parseFilters(dictRaw);
        const raw = Buffer.from(sm[1], 'latin1');
        obj.stream = decodeStream(raw, filters);
      }
      objects.push(obj);
    }
    return objects;
  }

  _buildPages(objects, opts, warnings) {
    const byId = new Map();
    for (const obj of objects) {
      if (!byId.has(obj.id)) byId.set(obj.id, obj);
    }

    const pages = [];
    for (const obj of objects) {
      if (!/\/Type\s*\/Page\b/.test(obj.dictRaw)) continue;
      if (/\/Type\s*\/Pages\b/.test(obj.dictRaw)) continue;

      const contentsRaw = obj.keys.Contents || '';
      const refs = parseContentRefs(contentsRaw);
      let content = '';
      for (const ref of refs) {
        const target = byId.get(ref.id);
        if (target && target.stream) {
          content += target.stream.toString('latin1') + '\n';
        }
      }
      if (!content) continue;
      let pageText = extractTextFromContent(content);
      if (opts.normalizeWhitespace) pageText = normalizeWhitespace(pageText);
      pages.push({
        index: pages.length,
        text: pageText,
        charCount: pageText.length,
      });
      if (pages.length >= opts.maxPages) break;
    }

    if (pages.length === 0) {
      // Fallback: трактуем каждый декодируемый поток как отдельную страницу.
      for (const obj of objects) {
        if (!obj.stream) continue;
        let pageText = extractTextFromContent(obj.stream.toString('latin1'));
        if (opts.normalizeWhitespace) pageText = normalizeWhitespace(pageText);
        if (!pageText.replace(/\s+/g, '')) continue;
        pages.push({
          index: pages.length,
          text: pageText,
          charCount: pageText.length,
        });
        if (pages.length >= opts.maxPages) break;
      }
      if (pages.length > 0) {
        warnings.push('Страницы определены эвристически по контент-потокам');
      } else {
        warnings.push('Извлекаемый текст не найден (возможно, скан или шрифты)');
      }
    }

    return pages;
  }
}

/* ------------------------------------------------------------------ */
/* Публичные функции                                                   */
/* ------------------------------------------------------------------ */

/**
 * Основная точка входа.
 * @param {string} pdfPath
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function read(pdfPath, options) {
  return new PdfReader(options).read(pdfPath);
}

async function readBuffer(input, options) {
  const reader = new PdfReader(options);
  return reader.readBuffer(input);
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('Usage: node sensors/pdf_reader.js <file.pdf>\n');
    process.exit(1);
  }
  read(target)
    .then((doc) => {
      process.stdout.write('version: ' + doc.version + '\n');
      process.stdout.write('pages: ' + doc.numPages + '\n');
      process.stdout.write('objects: ' + doc.numObjects + '\n');
      process.stdout.write('metadata: ' + JSON.stringify(doc.metadata) + '\n');
      process.stdout.write('--- text ---\n' + doc.text + '\n');
    })
    .catch((err) => {
      process.stderr.write('ERROR [' + (err.code || 'ERR') + ']: ' + err.message + '\n');
      process.exit(2);
    });
}

module.exports = {
  read,
  readBuffer,
  isPdf,
  PdfReader,
  _internals: {
    normalizeWhitespace,
    decodePdfString,
    hexToString,
    extractTextFromContent,
    parseFilters,
    decodeStream,
    inflateStream,
  },
};
