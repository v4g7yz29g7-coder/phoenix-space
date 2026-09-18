'use strict';

/**
 * sensors/audio_transcriber.js
 * =============================================================================
 * Транскрибация аудио через Yandex SpeechKit (Speech-to-Text).
 *
 * Публичный API:
 *   transcribe(audioPath, options)       -> Promise<TranscriptResult>
 *   transcribeShort(audioPath, options)  -> Promise<TranscriptResult>  (sync, <=30s/<=1MB)
 *   transcribeLong(audioPath, options)   -> Promise<TranscriptResult>  (async/chunked)
 *   healthcheck()                        -> { ok, ... }                (без сети)
 *   getSupportedFormats()                -> string[]
 *   isSupportedFormat(audioPath)         -> boolean
 *   normalizeText(text)                  -> string
 *   configure(config)                    -> AudioTranscriber
 *
 * TranscriptResult:
 *   {
 *     text:        string,          // склеенный нормализованный текст
 *     chunks:      Array<{ text, startMs, endMs, confidence }>,
 *     confidence:  number|null,     // средняя уверенность, 0..1
 *     durationMs:  number|null,
 *     languageCode:string,
 *     model:       string,
 *     format:      string,          // формат, отправленный в SpeechKit
 *     mode:        'sync'|'async'|'chunked',
 *     source:      string,          // путь к файлу
 *     bytes:       number,
 *   }
 *
 * Стратегия:
 *   1. Маленький файл (<=1MB и, для LPCM, <=30s) -> синхронный recognize;
 *   2. Большой WAV/LPCM -> нарезка на сегменты <=30s и последовательный recognize;
 *   3. Большой сжатый файл -> longRunningRecognize по URI из Object Storage
 *      (передаётся через options.audioUri).
 *
 * Аутентификация (одно из):
 *   - YANDEX_IAM_TOKEN                        -> Authorization: Bearer <token>
 *   - YANDEX_API_KEY + YANDEX_FOLDER_ID       -> Api-Key <key> + x-folder-id
 *
 * Зависимости: только Node.js core (fs, path, https, crypto).
 * Требуется Node.js >= 14 (используется https + async/await).
 * =============================================================================
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');

/* -------------------------------------------------------------------------- */
/* Конфигурация                                                               */
/* -------------------------------------------------------------------------- */

function envFlag(name) {
  return String(process.env[name] || '').toLowerCase() === 'true';
}

const DEFAULT_CONFIG = {
  apiKey: process.env.YANDEX_API_KEY || process.env.YC_API_KEY || null,
  iamToken: process.env.YANDEX_IAM_TOKEN || process.env.YC_IAM_TOKEN || null,
  folderId: process.env.YANDEX_FOLDER_ID || process.env.YC_FOLDER_ID || null,

  lang: process.env.YANDEX_STT_LANG || 'ru-RU',
  model: process.env.YANDEX_STT_MODEL || 'general',
  profanityFilter: envFlag('YANDEX_STT_PROFANITY'),

  // Живой STT-эндпоинт (синхронный recognize).
  syncHost: process.env.YANDEX_STT_HOST || 'stt.api.cloud.yandex.net',
  syncPath: '/speech/v1/stt:recognize',

  // Асинхронное распознавание + operations API.
  asyncHost: process.env.YANDEX_STT_ASYNC_HOST || 'transcribe.api.cloud.yandex.net',
  asyncPath: '/speech/stt/v2/longRunningRecognize',
  operationHost: process.env.YANDEX_STT_OP_HOST || 'operation.api.cloud.yandex.net',

  sampleRateHertz: 48000,
  audioChannelCount: 1,

  // Порог выбора sync/async.
  shortAudioLimitBytes: 1024 * 1024,
  shortAudioLimitSec: 30,

  // Поллинг асинхронной операции.
  pollIntervalMs: 3000,
  maxPollAttempts: 100,

  timeoutMs: 120000,
  maxRetries: 3,
  retryBackoffMs: 500,
};

const SUPPORTED_FORMATS = ['lpcm', 'wav', 'oggopus', 'ogg', 'opus', 'mp3', 'flac', 'm4a', 'aac'];

// Расширение -> формат, ожидаемый SpeechKit.
const FORMAT_ALIASES = {
  '.wav': 'wav',
  '.pcm': 'lpcm',
  '.raw': 'lpcm',
  '.lpcm': 'lpcm',
  '.ogg': 'oggopus',
  '.oga': 'oggopus',
  '.opus': 'oggopus',
  '.mp3': 'mp3',
  '.flac': 'flac',
  '.m4a': 'mp3',
  '.aac': 'mp3',
};

// Формат SpeechKit -> audioEncoding для longRunningRecognize.
const ASYNC_ENCODING = {
  lpcm: 'LINEAR16_PCM',
  wav: 'LINEAR16_PCM',
  oggopus: 'OGG_OPUS',
  ogg: 'OGG_OPUS',
  opus: 'OGG_OPUS',
  mp3: 'MP3',
};

/* -------------------------------------------------------------------------- */
/* Ошибки                                                                     */
/* -------------------------------------------------------------------------- */

class AudioTranscriberError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = 'AudioTranscriberError';
    this.code = code || 'TRANSCRIBER_ERROR';
    this.details = details || null;
  }
}

class AuthError extends AudioTranscriberError {
  constructor(message, details) {
    super(message || 'Yandex SpeechKit authentication failed', 'AUTH_ERROR', details);
    this.name = 'AuthError';
  }
}

class AudioError extends AudioTranscriberError {
  constructor(message, details) {
    super(message || 'Invalid or unreadable audio file', 'AUDIO_ERROR', details);
    this.name = 'AudioError';
  }
}

class RecognitionError extends AudioTranscriberError {
  constructor(message, details) {
    super(message || 'Speech recognition failed', 'RECOGNITION_ERROR', details);
    this.name = 'RecognitionError';
  }
}

/* -------------------------------------------------------------------------- */
/* Вспомогательные функции                                                    */
/* -------------------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readCredentials(options = {}) {
  const apiKey = options.apiKey || DEFAULT_CONFIG.apiKey;
  const iamToken = options.iamToken || DEFAULT_CONFIG.iamToken;
  const folderId = options.folderId || DEFAULT_CONFIG.folderId;
  return { apiKey: apiKey || null, iamToken: iamToken || null, folderId: folderId || null };
}

function buildAuthHeaders(config, extra = {}) {
  const headers = Object.assign({}, extra);
  if (config.iamToken) {
    headers.Authorization = `Bearer ${config.iamToken}`;
  } else if (config.apiKey) {
    headers.Authorization = `Api-Key ${config.apiKey}`;
    if (config.folderId) headers['x-folder-id'] = config.folderId;
  } else {
    throw new AuthError(
      'Set YANDEX_IAM_TOKEN or (YANDEX_API_KEY + YANDEX_FOLDER_ID)'
    );
  }
  return headers;
}

function detectFormat(audioPath) {
  const ext = path.extname(String(audioPath || '')).toLowerCase();
  return FORMAT_ALIASES[ext] || null;
}

function guessFormat(audioPath, explicitFormat) {
  if (explicitFormat) {
    const fmt = String(explicitFormat).toLowerCase();
    if (!SUPPORTED_FORMATS.includes(fmt)) {
      throw new AudioError(`Unsupported audio format: ${explicitFormat}`, {
        code: 'AUDIO_FORMAT_ERROR',
      });
    }
    return fmt;
  }
  const fmt = detectFormat(audioPath);
  if (!fmt) {
    throw new AudioError(
      `Cannot infer audio format from "${path.extname(String(audioPath))}". ` +
        'Pass options.format explicitly.'
    );
  }
  return fmt;
}

function isSupportedFormat(audioPath) {
  return detectFormat(audioPath) !== null;
}

function getSupportedFormats() {
  return SUPPORTED_FORMATS.slice();
}

/**
 * Статистика файла + базовые проверки читаемости.
 */
async function assertReadable(audioPath) {
  if (!audioPath || typeof audioPath !== 'string') {
    throw new AudioError('audioPath must be a non-empty string', { audioPath });
  }
  let stat;
  try {
    stat = await fsp.stat(audioPath);
  } catch (err) {
    throw new AudioError(`Audio file not found: ${audioPath}`, { cause: err.message });
  }
  if (!stat.isFile()) throw new AudioError(`Not a regular file: ${audioPath}`);
  if (stat.size === 0) throw new AudioError(`Audio file is empty: ${audioPath}`);
  return stat;
}

function assertReadableSync(audioPath) {
  if (!audioPath || typeof audioPath !== 'string') {
    throw new AudioError('audioPath must be a non-empty string', { audioPath });
  }
  let stat;
  try {
    stat = fs.statSync(audioPath);
  } catch (err) {
    throw new AudioError(`Audio file not found: ${audioPath}`, { cause: err.message });
  }
  if (!stat.isFile()) throw new AudioError(`Not a regular file: ${audioPath}`);
  if (stat.size === 0) throw new AudioError(`Audio file is empty: ${audioPath}`);
  return stat;
}

/**
 * Оценка длительности. Для несжатого LPCM точна, для прочего — null.
 */
function estimateDurationSec(stat, format, config) {
  if (format !== 'lpcm') return null;
  const bytesPerSample = 2 * (config.audioChannelCount || 1);
  const bytesPerSec = (config.sampleRateHertz || 48000) * bytesPerSample;
  if (!bytesPerSec) return null;
  return stat.size / bytesPerSec;
}

function buildQuery(params) {
  const qs = new URLSearchParams();
  Object.keys(params).forEach((key) => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') {
      qs.append(key, String(value));
    }
  });
  return qs.toString();
}

function normalizeText(text) {
  return String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeChunks(rawChunks) {
  if (!Array.isArray(rawChunks)) return [];
  return rawChunks.map((chunk) => {
    const alternatives = Array.isArray(chunk.alternatives) ? chunk.alternatives : [];
    const best = alternatives[0] || {};
    return {
      text: String(best.text || '').trim(),
      startMs: chunk.startTimeMs != null ? Number(chunk.startTimeMs) : null,
      endMs: chunk.endTimeMs != null ? Number(chunk.endTimeMs) : null,
      confidence: best.confidence != null ? Number(best.confidence) : null,
    };
  });
}

function joinChunks(chunks) {
  return normalizeText(chunks.map((c) => c.text).join(' '));
}

function averageConfidence(chunks) {
  const values = chunks.map((c) => c.confidence).filter((v) => typeof v === 'number');
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/* -------------------------------------------------------------------------- */
/* Низкоуровневый HTTP (только https, без внешних зависимостей)               */
/* -------------------------------------------------------------------------- */

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, raw });
      });
    });
    req.on('error', (err) =>
      reject(new AudioTranscriberError(`Network error: ${err.message}`, 'NETWORK_ERROR', { cause: err }))
    );
    req.setTimeout(options.timeoutMs || DEFAULT_CONFIG.timeoutMs, () => {
      req.destroy(new AudioTranscriberError('SpeechKit request timed out', 'TIMEOUT'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function parseJsonSafe(raw, statusCode) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RecognitionError('Invalid JSON from SpeechKit', {
      code: 'PROTOCOL_ERROR',
      statusCode,
      response: raw.slice(0, 500),
    });
  }
}

async function requestJson(options, body, config) {
  let lastErr = null;
  const attempts = (config && config.maxRetries) || DEFAULT_CONFIG.maxRetries;
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    try {
      const res = await httpsRequest(options, body);
      const parsed = parseJsonSafe(res.raw, res.statusCode);
      if (res.statusCode >= 200 && res.statusCode < 300 && !parsed.error_code) {
        return parsed;
      }
      const message =
        parsed.error_message || parsed.message || res.raw.slice(0, 300) || 'unknown error';
      if (res.statusCode >= 500 && attempt < attempts) {
        lastErr = new RecognitionError(`SpeechKit HTTP ${res.statusCode}: ${message}`, {
          statusCode: res.statusCode,
          response: parsed,
        });
        await sleep(((config && config.retryBackoffMs) || DEFAULT_CONFIG.retryBackoffMs) * 2 ** attempt);
        continue;
      }
      throw new RecognitionError(`SpeechKit HTTP ${res.statusCode}: ${message}`, {
        statusCode: res.statusCode,
        response: parsed,
      });
    } catch (err) {
      if (err instanceof AudioTranscriberError && err.code !== 'NETWORK_ERROR') throw err;
      if (attempt < attempts) {
        lastErr = err;
        await sleep(((config && config.retryBackoffMs) || DEFAULT_CONFIG.retryBackoffMs) * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new RecognitionError('SpeechKit request failed');
}

/* -------------------------------------------------------------------------- */
/* WAV-разбор и нарезка                                                       */
/* -------------------------------------------------------------------------- */

function parseWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AudioError('Not a valid RIFF/WAVE file', { code: 'AUDIO_FORMAT_ERROR' });
  }
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      data = { offset: body, size: Math.min(size, buffer.length - body) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new AudioError('WAV file is missing fmt/data chunk', { code: 'AUDIO_FORMAT_ERROR' });
  return Object.assign({}, fmt, data);
}

function buildWavHeader(pcmLength, info) {
  const header = Buffer.alloc(44);
  const byteRate = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  const blockAlign = info.channels * (info.bitsPerSample / 8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(info.bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

/**
 * Режет WAV на куски <= maxSeconds. Возвращает массив Buffer (каждый — валидный WAV).
 */
function splitWav(buffer, maxSeconds) {
  const info = parseWav(buffer);
  const bytesPerSec = info.sampleRate * info.channels * (info.bitsPerSample / 8);
  const maxBytes = Math.max(1, Math.floor(bytesPerSec * maxSeconds));
  const segments = [];
  for (let pos = info.offset; pos < info.offset + info.size; pos += maxBytes) {
    const end = Math.min(pos + maxBytes, info.offset + info.size);
    const pcm = buffer.subarray(pos, end);
    segments.push(Buffer.concat([buildWavHeader(pcm.length, info), pcm]));
  }
  return segments.length ? segments : [buffer];
}

function splitLpcm(buffer, config, maxSeconds) {
  const bytesPerSec = (config.sampleRateHertz || 48000) * 2 * (config.audioChannelCount || 1);
  const maxBytes = Math.max(1, Math.floor(bytesPerSec * maxSeconds));
  const segments = [];
  for (let pos = 0; pos < buffer.length; pos += maxBytes) {
    segments.push(buffer.subarray(pos, Math.min(pos + maxBytes, buffer.length)));
  }
  return segments.length ? segments : [buffer];
}

/* -------------------------------------------------------------------------- */
/* Транскрайбер                                                               */
/* -------------------------------------------------------------------------- */

class AudioTranscriber {
  constructor(options = {}) {
    this.config = Object.assign({}, DEFAULT_CONFIG, options, {
      creds: readCredentials(options),
    });
  }

  /* ------------------------------ Health -------------------------------- */

  healthcheck() {
    const creds = this.config.creds;
    let authMode = 'none';
    if (creds.iamToken) authMode = 'iam';
    else if (creds.apiKey) authMode = 'api-key';
    return {
      ok: authMode !== 'none',
      authMode,
      hasFolderId: Boolean(creds.folderId),
      lang: this.config.lang,
      model: this.config.model,
      formats: getSupportedFormats(),
      shortAudioLimitBytes: this.config.shortAudioLimitBytes,
      shortAudioLimitSec: this.config.shortAudioLimitSec,
    };
  }

  /* ------------------------------ Публичный API ------------------------- */

  /**
   * Универсальная транскрибация. Сама выбирает режим.
   * @param {string} audioPath
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async transcribe(audioPath, options = {}) {
    const stat = await assertReadable(audioPath);
    const format = guessFormat(audioPath, options.format);
    const cfg = Object.assign({}, this.config, options);
    const estimated = estimateDurationSec(stat, format, cfg);
    const wantLong =
      options.long === true ||
      stat.size > cfg.shortAudioLimitBytes ||
      (estimated != null && estimated > cfg.shortAudioLimitSec);

    let result;
    if (!wantLong) {
      result = await this.recognizeShort(audioPath, { stat, format, cfg });
    } else {
      result = await this.recognizeLong(audioPath, { stat, format, cfg, estimated });
    }
    return Object.assign(result, { source: audioPath, bytes: stat.size });
  }

  async transcribeShort(audioPath, options = {}) {
    const stat = await assertReadable(audioPath);
    const format = guessFormat(audioPath, options.format);
    const cfg = Object.assign({}, this.config, options);
    const result = await this.recognizeShort(audioPath, { stat, format, cfg });
    return Object.assign(result, { source: audioPath, bytes: stat.size });
  }

  async transcribeLong(audioPath, options = {}) {
    const stat = await assertReadable(audioPath);
    const format = guessFormat(audioPath, options.format);
    const cfg = Object.assign({}, this.config, options);
    const estimated = estimateDurationSec(stat, format, cfg);
    const result = await this.recognizeLong(audioPath, { stat, format, cfg, estimated });
    return Object.assign(result, { source: audioPath, bytes: stat.size });
  }

  /* ------------------------------ Синхронный режим ---------------------- */

  async recognizeShort(audioPath, { format, cfg }) {
    const audio = await fsp.readFile(audioPath);
    const query = buildQuery({
      lang: cfg.lang,
      topic: cfg.model,
      format,
      sampleRateHertz: format === 'lpcm' || format === 'wav' ? cfg.sampleRateHertz : undefined,
      profanityFilter: cfg.profanityFilter ? 'true' : undefined,
    });
    const headers = buildAuthHeaders(cfg.creds, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': Buffer.byteLength(audio),
    });
    const parsed = await requestJson(
      {
        host: cfg.syncHost,
        path: `${cfg.syncPath}?${query}`,
        method: 'POST',
        headers,
        timeoutMs: cfg.timeoutMs,
      },
      audio,
      cfg
    );
    const text = normalizeText(parsed.result || parsed.text || '');
    return {
      text,
      chunks: text ? [{ text, startMs: null, endMs: null, confidence: null }] : [],
      confidence: null,
      durationMs: null,
      languageCode: cfg.lang,
      model: cfg.model,
      format,
      mode: 'sync',
    };
  }

  /* ------------------------------ Асинхронный/нарезка ------------------- */

  async recognizeLong(audioPath, { format, cfg, estimated }) {
    // 1. Если задан URI в Object Storage — используем longRunningRecognize.
    if (cfg.audioUri) {
      return this.recognizeAsync(cfg.audioUri, { format, cfg });
    }

    // 2. Несжатые форматы можно безопасно нарезать.
    if (format === 'wav' || format === 'lpcm') {
      return this.recognizeChunked(audioPath, { format, cfg });
    }

    // 3. Сжатый формат без URI — нарезка некорректна.
    const durationHint = estimated != null ? ` (~${estimated.toFixed(1)}s)` : '';
    throw new RecognitionError(
      `Audio too large for sync recognition${durationHint} and format "${format}" cannot be split. ` +
        'Upload the file to Object Storage and pass options.audioUri to use longRunningRecognize.',
      { code: 'NEEDS_AUDIO_URI', format }
    );
  }

  async recognizeChunked(audioPath, { format, cfg }) {
    const buffer = await fsp.readFile(audioPath);
    const segments =
      format === 'wav'
        ? splitWav(buffer, Math.max(1, cfg.shortAudioLimitSec - 1))
        : splitLpcm(buffer, cfg, Math.max(1, cfg.shortAudioLimitSec - 1));

    const allChunks = [];
    let offsetMs = 0;
    for (const segment of segments) {
      const parsed = await this.requestSyncBuffer(segment, format, cfg);
      const text = normalizeText(parsed.result || '');
      if (text) {
        allChunks.push({ text, startMs: offsetMs, endMs: null, confidence: null });
      }
      // Оценка смещения: 1 секунда на сегмент-порог (приблизительно).
      offsetMs += Math.round((cfg.shortAudioLimitSec - 1) * 1000);
    }
    return {
      text: joinChunks(allChunks),
      chunks: allChunks,
      confidence: null,
      durationMs: segments.length * (cfg.shortAudioLimitSec - 1) * 1000,
      languageCode: cfg.lang,
      model: cfg.model,
      format,
      mode: 'chunked',
      segments: segments.length,
    };
  }

  async requestSyncBuffer(buffer, format, cfg) {
    const query = buildQuery({
      lang: cfg.lang,
      topic: cfg.model,
      format,
      sampleRateHertz: format === 'lpcm' || format === 'wav' ? cfg.sampleRateHertz : undefined,
      profanityFilter: cfg.profanityFilter ? 'true' : undefined,
    });
    const headers = buildAuthHeaders(cfg.creds, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': Buffer.byteLength(buffer),
    });
    return requestJson(
      {
        host: cfg.syncHost,
        path: `${cfg.syncPath}?${query}`,
        method: 'POST',
        headers,
        timeoutMs: cfg.timeoutMs,
      },
      buffer,
      cfg
    );
  }

  async recognizeAsync(audioUri, { format, cfg }) {
    const encoding = ASYNC_ENCODING[format] || 'OGG_OPUS';
    const payload = JSON.stringify({
      config: {
        specification: {
          languageCode: cfg.lang,
          model: cfg.model,
          profanityFilter: cfg.profanityFilter,
          audioEncoding: encoding,
          sampleRateHertz: cfg.sampleRateHertz,
          audioChannelCount: cfg.audioChannelCount,
        },
      },
      audio: { uri: audioUri },
    });
    const headers = buildAuthHeaders(cfg.creds, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    const started = await requestJson(
      {
        host: cfg.asyncHost,
        path: cfg.asyncPath,
        method: 'POST',
        headers,
        timeoutMs: cfg.timeoutMs,
      },
      payload,
      cfg
    );
    if (!started.id) {
      throw new RecognitionError('longRunningRecognize did not return an operation id', {
        response: started,
      });
    }
    const operation = await this.pollOperation(started.id, cfg);
    const chunks = normalizeChunks(operation.chunks);
    return {
      text: joinChunks(chunks),
      chunks,
      confidence: averageConfidence(chunks),
      durationMs: null,
      languageCode: cfg.lang,
      model: cfg.model,
      format,
      mode: 'async',
      operationId: started.id,
    };
  }

  async pollOperation(operationId, cfg) {
    const headers = buildAuthHeaders(cfg.creds);
    for (let attempt = 0; attempt < cfg.maxPollAttempts; attempt += 1) {
      const op = await requestJson(
        {
          host: cfg.operationHost,
          path: `/operations/${encodeURIComponent(operationId)}`,
          method: 'GET',
          headers,
          timeoutMs: cfg.timeoutMs,
        },
        null,
        cfg
      );
      if (op.error) {
        throw new RecognitionError(`Async recognition failed: ${op.error.message || 'unknown'}`, {
          operation: op,
        });
      }
      if (op.done) {
        const response = op.response || {};
        return { chunks: Array.isArray(response.chunks) ? response.chunks : [] };
      }
      await sleep(cfg.pollIntervalMs);
    }
    throw new RecognitionError(`Async recognition timed out after ${cfg.maxPollAttempts} polls`, {
      code: 'POLL_TIMEOUT',
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Модульный фасад                                                            */
/* -------------------------------------------------------------------------- */

let _instance = null;

function instance() {
  if (!_instance) _instance = new AudioTranscriber();
  return _instance;
}

function configure(config) {
  _instance = new AudioTranscriber(config || {});
  return _instance;
}

function transcribe(audioPath, options) {
  return instance().transcribe(audioPath, options);
}

function transcribeShort(audioPath, options) {
  return instance().transcribeShort(audioPath, options);
}

function transcribeLong(audioPath, options) {
  return instance().transcribeLong(audioPath, options);
}

function healthcheck() {
  return instance().healthcheck();
}

/* -------------------------------------------------------------------------- */
/* Экспорт                                                                    */
/* -------------------------------------------------------------------------- */

module.exports = {
  AudioTranscriber,
  transcribe,
  transcribeShort,
  transcribeLong,
  configure,
  healthcheck,
  getSupportedFormats,
  isSupportedFormat,
  normalizeText,
  // errors
  AudioTranscriberError,
  AuthError,
  AudioError,
  RecognitionError,
  // constants
  SUPPORTED_FORMATS,
  FORMAT_ALIASES,
  DEFAULT_CONFIG,
};

/* -------------------------------------------------------------------------- */
/* CLI: node sensors/audio_transcriber.js <file> [--format=wav] [--long]      */
/* -------------------------------------------------------------------------- */

if (require.main === module) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: node sensors/audio_transcriber.js <audio-file> [--long] [--format=mp3]');
    process.exit(2);
  }
  const options = {};
  argv.forEach((arg) => {
    if (arg === '--long') options.long = true;
    const match = /^--format=(.+)$/.exec(arg);
    if (match) options.format = match[1];
  });
  healthcheck();
  transcribe(file, options)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(`[${err.code || 'ERROR'}] ${err.message}`);
      process.exit(1);
    });
}
