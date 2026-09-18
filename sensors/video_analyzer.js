'use strict';

/**
 * sensors/video_analyzer.js
 * -------------------------
 * Анализ видео через GigaChat Vision API.
 *
 * Пайплайн:
 *   1. ffprobe -> длительность видео.
 *   2. ffmpeg  -> извлечение равномерно распределённых кадров.
 *   3. Кадры -> base64 (JPEG/PNG/WEBP).
 *   4. GigaChat Vision -> описание каждого кадра (OAuth + /chat/completions).
 *   5. Агрегация -> таймлайн, сводка, использование токенов.
 *
 * Публичный API:
 *   const va = require('./sensors/video_analyzer');
 *   const result = await va.analyze('/path/to/video.mp4');   // модульная функция
 *   // либо классом:
 *   const { VideoAnalyzer } = require('./sensors/video_analyzer');
 *   const r2 = await new VideoAnalyzer({...}).analyze('/path/to/video.mp4');
 *
 * Зависимости: только Node.js core (fs, path, os, https, crypto, child_process).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

/** Поддерживаемые расширения видео. */
const VIDEO_EXTENSIONS = [
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v', '.mpeg', '.mpg',
];

const DEFAULTS = {
  // GigaChat OAuth / API endpoints
  oauthUrl: 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
  apiBase: 'https://gigachat.devices.sberbank.ru/api/v1',
  scope: 'GIGACHAT_API_PERS',
  model: 'GigaChat',
  // Аутентификация
  authKey: process.env.GIGACHAT_AUTH_KEY || '',
  clientId: process.env.GIGACHAT_CLIENT_ID || '',
  clientSecret: process.env.GIGACHAT_CLIENT_SECRET || '',
  // Извлечение кадров
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
  frameCount: 5,          // сколько ключевых кадров извлекать
  frameFormat: 'jpeg',
  frameWidth: 640,        // масштаб кадра по ширине
  jpegQuality: 4,         // qscale для ffmpeg (2..31)
  // Запрос vision
  prompt: 'Опиши, что происходит на кадре. Перечисли объекты, людей, действия и текст.',
  systemPrompt: 'Ты — система компьютерного зрения. Отвечай кратко и по делу, на русском языке.',
  maxTokens: 1024,
  temperature: 0.2,
  timeoutMs: 60000,
  // Поведение
  keepFrames: false,
  concurrency: 2,
  retries: 2,
  retryDelayMs: 1500,
};

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function ensureVideoPath(p) {
  if (!p || typeof p !== 'string') {
    throw new TypeError('videoPath must be a non-empty string');
  }
  if (!fs.existsSync(p)) throw new Error(`Video file not found: ${p}`);
  const stat = fs.statSync(p);
  if (!stat.isFile()) throw new Error(`Not a regular file: ${p}`);
  return stat;
}

function isVideoFile(p) {
  if (typeof p !== 'string') return false;
  return VIDEO_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

function mimeFor(format) {
  switch (String(format).toLowerCase()) {
    case 'png': return 'image/png';
    case 'webp': return 'image/webp';
    case 'jpeg':
    case 'jpg':
    default:
      return 'image/jpeg';
  }
}

/**
 * Равномерно распределяет N временных меток по длительности видео.
 * @param {number} duration - длительность в секундах
 * @param {number} count    - требуемое число кадров
 * @returns {number[]}
 */
function pickFrameTimestamps(duration, count) {
  const n = Math.max(1, Math.floor(count) || 1);
  const dur = Number.isFinite(duration) && duration > 0 ? duration : n;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    // центры равных интервалов: не залипаем на первом/последнем кадре
    const t = (dur * (i + 0.5)) / n;
    out.push(Number(t.toFixed(3)));
  }
  return out;
}

/**
 * Собирает текстовый таймлайн из описаний кадров.
 * @param {Array<{time?:number, tsSec?:number, text?:string, description?:string}>} parts
 * @returns {string}
 */
function buildTimeline(parts) {
  if (!Array.isArray(parts)) return '';
  return parts
    .slice()
    .map((p) => {
      const t = (p && (p.time !== undefined ? p.time : p.tsSec)) || 0;
      const text = (p && (p.text !== undefined ? p.text : p.description)) || '';
      return { t: Number(t) || 0, text: String(text) };
    })
    .sort((a, b) => a.t - b.t)
    .map((p) => `[${p.t.toFixed(1)}s] ${p.text}`)
    .join('\n');
}

/**
 * Универсальный JSON HTTP-запрос (без внешних зависимостей).
 */
function requestJson(options, bodyObj) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) { /* not json */ }
        if (status >= 200 && status < 300) {
          resolve(parsed !== null ? parsed : data);
        } else {
          const err = new Error(`HTTP ${status} ${options.path}: ${String(data).slice(0, 500)}`);
          err.status = status;
          err.body = parsed !== null ? parsed : data;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || DEFAULTS.timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${options.timeout || DEFAULTS.timeoutMs}ms`));
    });
    if (bodyObj !== undefined) {
      const payload = JSON.stringify(bodyObj);
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Content-Length', Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

function makeUrlObj(url, extra) {
  const u = new URL(url);
  return Object.assign({
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port,
    path: u.pathname + u.search,
  }, extra || {});
}

/** Простой ограничитель параллелизма. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, limit | 0);
  async function run() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return results;
}

// ---------------------------------------------------------------------------
// Основной класс
// ---------------------------------------------------------------------------

class VideoAnalyzer {
  constructor(options = {}) {
    this.config = Object.assign({}, DEFAULTS, options);
    this._token = null;
    this._tokenExpiresAt = 0;
    this._tmpDir = null;
  }

  setAuthKey(key) {
    this.config.authKey = key;
    this._token = null;
    this._tokenExpiresAt = 0;
    return this;
  }

  // ------------------------- OAuth -------------------------

  _basicAuthHeader() {
    const { authKey, clientId, clientSecret } = this.config;
    if (authKey) return 'Basic ' + authKey;
    if (clientId && clientSecret) {
      const raw = `${clientId}:${clientSecret}`;
      return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
    }
    throw new Error(
      'GigaChat credentials missing: set GIGACHAT_AUTH_KEY or GIGACHAT_CLIENT_ID/GIGACHAT_CLIENT_SECRET'
    );
  }

  async getAccessToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpiresAt - 30000) return this._token;

    const opts = makeUrlObj(this.config.oauthUrl, {
      method: 'POST',
      headers: {
        Authorization: this._basicAuthHeader(),
        RqUID: uuid(),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: this.config.timeoutMs,
    });
    const payload = Buffer.from('scope=' + encodeURIComponent(this.config.scope), 'utf8');

    const json = await new Promise((resolve, reject) => {
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
          } else {
            reject(new Error(`OAuth failed HTTP ${res.statusCode}: ${String(data).slice(0, 400)}`));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(opts.timeout, () => req.destroy(new Error('OAuth timeout')));
      req.write(payload);
      req.end();
    });

    if (!json || !json.access_token) throw new Error('OAuth response missing access_token');
    this._token = json.access_token;
    this._tokenExpiresAt = json.expires_at ? Number(json.expires_at) : (now + 30 * 60 * 1000);
    return this._token;
  }

  // ------------------------- ffmpeg / ffprobe -------------------------

  ffprobeDuration(videoPath) {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ];
    return new Promise((resolve) => {
      execFile(this.config.ffprobePath, args, { timeout: this.config.timeoutMs }, (err, stdout) => {
        if (err) { resolve(null); return; }
        const d = parseFloat(String(stdout).trim());
        resolve(Number.isFinite(d) ? d : null);
      });
    });
  }

  _makeTmpDir() {
    if (this._tmpDir) return this._tmpDir;
    this._tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-analyzer-'));
    return this._tmpDir;
  }

  cleanup() {
    if (this._tmpDir) {
      try { fs.rmSync(this._tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
      this._tmpDir = null;
    }
  }

  /**
   * Извлекает кадры из видео и возвращает [{ index, tsSec, file, base64, mime }].
   * @param {string} videoPath
   * @param {object} [opts]
   */
  async extractFrames(videoPath, opts = {}) {
    ensureVideoPath(videoPath);
    const cfg = Object.assign({}, this.config, opts);
    const tmpDir = this._makeTmpDir();
    const ext = cfg.frameFormat === 'png' ? 'png' : 'jpg';

    const duration = await this.ffprobeDuration(videoPath);
    const timestamps = pickFrameTimestamps(
      duration !== null ? duration : cfg.frameCount,
      cfg.frameCount
    );

    const frames = [];
    for (let i = 0; i < timestamps.length; i += 1) {
      const ts = timestamps[i];
      const outFile = path.join(tmpDir, `frame_${String(i).padStart(3, '0')}.${ext}`);
      const args = ['-y', '-ss', String(ts), '-i', videoPath, '-frames:v', '1'];
      if (cfg.frameWidth) args.push('-vf', `scale=${cfg.frameWidth}:-2`);
      if (cfg.frameFormat === 'jpeg') args.push('-qscale:v', String(cfg.jpegQuality));
      args.push(outFile);

      // eslint-disable-next-line no-await-in-loop
      const ok = await new Promise((resolve) => {
        execFile(cfg.ffmpegPath, args, { timeout: cfg.timeoutMs }, (err) => resolve(!err));
      });
      if (!ok || !fs.existsSync(outFile)) continue;

      const buf = fs.readFileSync(outFile);
      frames.push({
        index: i,
        tsSec: ts,
        file: outFile,
        mime: mimeFor(cfg.frameFormat),
        base64: buf.toString('base64'),
      });
    }
    return frames;
  }

  // ------------------------- Vision -------------------------

  _buildVisionPayload(frame, prompt) {
    const cfg = this.config;
    return {
      model: cfg.model,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      messages: [
        { role: 'system', content: cfg.systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${frame.mime};base64,${frame.base64}` } },
          ],
        },
      ],
    };
  }

  async _analyzeSingleFrame(frame, prompt) {
    const cfg = this.config;
    const token = await this.getAccessToken();
    const opts = makeUrlObj(`${cfg.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: cfg.timeoutMs,
    });
    const json = await requestJson(opts, this._buildVisionPayload(frame, prompt));
    let text = '';
    if (json && Array.isArray(json.choices) && json.choices[0]) {
      const msg = json.choices[0].message;
      text = msg && typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg && msg.content);
    } else if (json && typeof json.content === 'string') {
      text = json.content;
    }
    return {
      index: frame.index,
      tsSec: frame.tsSec,
      text: (text || '').trim(),
      usage: json && json.usage ? json.usage : null,
    };
  }

  async analyzeFrame(frame, prompt) {
    const cfg = this.config;
    let lastErr = null;
    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      try {
        return await this._analyzeSingleFrame(frame, prompt);
      } catch (err) {
        lastErr = err;
        if (attempt < cfg.retries) await sleep(cfg.retryDelayMs * (attempt + 1));
      }
    }
    return { index: frame.index, tsSec: frame.tsSec, text: '', error: lastErr && lastErr.message };
  }

  analyzeFrames(frames, prompt) {
    const cfg = this.config;
    return mapLimit(frames, cfg.concurrency, (f) => this.analyzeFrame(f, prompt));
  }

  _aggregate(frameResults) {
    const successful = frameResults.filter((r) => r && r.text && !r.error);
    const descriptions = successful.map((r) => ({
      index: r.index,
      tsSec: r.tsSec,
      description: r.text,
    }));
    const timeline = buildTimeline(descriptions);
    const usage = successful.reduce((acc, r) => {
      if (r.usage) {
        acc.prompt_tokens += r.usage.prompt_tokens || 0;
        acc.completion_tokens += r.usage.completion_tokens || 0;
        acc.total_tokens += r.usage.total_tokens || 0;
      }
      return acc;
    }, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });

    return {
      framesAnalyzed: frameResults.length,
      framesOk: successful.length,
      framesFailed: frameResults.length - successful.length,
      descriptions,
      timeline,
      usage,
    };
  }

  /**
   * Главный публичный метод.
   * @param {string} videoPath
   * @param {object} [opts]
   * @returns {Promise<object>}
   */
  async analyze(videoPath, opts = {}) {
    const startedAt = Date.now();
    const cfg = Object.assign({}, this.config, opts);
    const prompt = opts.prompt || cfg.prompt;

    try {
      const frames = await this.extractFrames(videoPath, cfg);
      if (frames.length === 0) {
        throw new Error('No frames extracted (ffmpeg missing or unreadable video)');
      }
      const frameResults = await this.analyzeFrames(frames, prompt);
      const summary = this._aggregate(frameResults);
      return Object.assign({
        ok: summary.framesOk > 0,
        videoPath,
        prompt,
        model: cfg.model,
        durationMs: Date.now() - startedAt,
      }, summary);
    } catch (err) {
      return {
        ok: false,
        videoPath,
        error: err.message,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (!cfg.keepFrames) this.cleanup();
    }
  }
}

// ---------------------------------------------------------------------------
// Модульные обёртки
// ---------------------------------------------------------------------------

/** Общая (ленивая) инстанция для модульной функции analyze. */
let _shared = null;
function shared(opts) {
  if (!_shared) _shared = new VideoAnalyzer(opts || {});
  return _shared;
}

/**
 * Модульная функция: проанализировать видео.
 * @param {string} videoPath
 * @param {object} [opts]  опции + { analyzer } для инъекции готового инстанса
 * @returns {Promise<object>}
 */
function analyze(videoPath, opts = {}) {
  const va = opts.analyzer instanceof VideoAnalyzer ? opts.analyzer : shared(opts);
  return va.analyze(videoPath, opts);
}

/**
 * Возможности модуля / окружения.
 * @returns {Promise<object>}
 */
async function capabilities() {
  const has = (bin) => new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err, stdout) => {
      resolve({ available: !err, version: err ? null : String(stdout).split('\n')[0].trim() });
    });
  });
  const [ffmpeg, ffprobe] = await Promise.all([
    has(process.env.FFMPEG_PATH || DEFAULTS.ffmpegPath),
    has(process.env.FFPROBE_PATH || DEFAULTS.ffprobePath),
  ]);
  const credentials = Boolean(
    process.env.GIGACHAT_AUTH_KEY || (process.env.GIGACHAT_CLIENT_ID && process.env.GIGACHAT_CLIENT_SECRET)
  );
  return {
    module: 'video_analyzer',
    backend: 'GigaChat Vision',
    model: DEFAULTS.model,
    videoExtensions: VIDEO_EXTENSIONS.slice(),
    ffmpeg,
    ffprobe,
    credentials,
    supports: { frames: true, timeline: true, concurrency: DEFAULTS.concurrency },
  };
}

function create(opts) {
  return new VideoAnalyzer(opts);
}

// ---------------------------------------------------------------------------
// Экспорт
// ---------------------------------------------------------------------------

module.exports = {
  // модульный API
  analyze,
  capabilities,
  create,
  // утилиты (используются тестами и другими сенсорами)
  pickFrameTimestamps,
  buildTimeline,
  mimeFor,
  isVideoFile,
  requestJson,
  // константы/класс
  VideoAnalyzer,
  VIDEO_EXTENSIONS,
  DEFAULTS,
};

// Самопроверка при прямом запуске: node sensors/video_analyzer.js --selftest
if (require.main === module && process.argv.includes('--selftest')) {
  /* eslint-disable no-console */
  console.log('VIDEO_EXTENSIONS:', VIDEO_EXTENSIONS.join(','));
  console.log('pickFrameTimestamps(10,4):', JSON.stringify(pickFrameTimestamps(10, 4)));
  console.log('buildTimeline:', buildTimeline([{ time: 0, text: 'a' }, { time: 1, text: 'b' }]));
  capabilities().then((c) => console.log('capabilities:', JSON.stringify(c))).catch((e) => console.error(e));
}
