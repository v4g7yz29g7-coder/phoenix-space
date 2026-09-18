'use strict';

/**
 * sensors/gigachat_adapter.js
 * =============================================================================
 * Обёртка над GigaChat Vision API (Sber).
 *
 * Публичный API:
 *     analyze(imagePath, prompt) -> Promise<{ text: string }>
 *
 * OAuth flow:
 *     POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth
 *     Агент https создаётся с rejectUnauthorized = false, потому что
 *     корневой сертификат НУЦ Минцифры России не всегда присутствует в
 *     системном хранилище доверенных сертификатов Node.js.
 *
 * Реализация использует только core-модули Node.js (`https`, `fs`, `path`,
 * `crypto`) — никаких внешних зависимостей.
 * =============================================================================
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============================ Конфигурация ============================== */

const OAUTH_HOST = 'ngw.devices.sberbank.ru';
const OAUTH_PORT = 9443;
const OAUTH_PATH = '/api/v2/oauth';
const DEFAULT_SCOPE = 'GIGACHAT_API_PERS';

/**
 * Конфигурация по умолчанию. Может быть переопределена через переменные
 * окружения или третий аргумент `analyze(imagePath, prompt, options)`.
 */
const DEFAULT_CONFIG = {
  // --- OAuth ---
  oauthHost: process.env.GIGACHAT_OAUTH_HOST || OAUTH_HOST,
  oauthPort: Number(process.env.GIGACHAT_OAUTH_PORT || OAUTH_PORT),
  oauthPath: process.env.GIGACHAT_OAUTH_PATH || OAUTH_PATH,
  scope: process.env.GIGACHAT_SCOPE || DEFAULT_SCOPE,

  // --- API ---
  apiHost: process.env.GIGACHAT_API_HOST || 'gigachat.devices.sberbank.ru',
  apiPort: Number(process.env.GIGACHAT_API_PORT || 9443),
  filesPath: process.env.GIGACHAT_FILES_PATH || '/api/v1/files',
  chatPath: process.env.GIGACHAT_CHAT_PATH || '/api/v1/chat/completions',

  // --- Модель ---
  model: process.env.GIGACHAT_MODEL || 'GigaChat-Pro',
  temperature: Number(process.env.GIGACHAT_TEMPERATURE || 0.2),
  maxTokens: Number(process.env.GIGACHAT_MAX_TOKENS || 2048),

  // --- Транспорт ---
  rejectUnauthorized: false,
  oauthTimeoutMs: Number(process.env.GIGACHAT_OAUTH_TIMEOUT_MS || 30000),
  requestTimeoutMs: Number(process.env.GIGACHAT_REQUEST_TIMEOUT_MS || 120000),
};

/** Единый https.Agent, отключающий проверку сертификата (НУЦ Минцифры). */
const insecureAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  maxSockets: 8,
  timeout: DEFAULT_CONFIG.requestTimeoutMs,
});

/** Кэш access_token на время жизни процесса. */
let _tokenCache = { accessToken: null, expiresAt: 0 };

/** Обновляем токен заранее, за это окно до фактического истечения (мс). */
const TOKEN_SAFETY_WINDOW = 60 * 1000;

/* ============================ Утилиты =================================== */

/** Обрезать длинную строку для сообщений об ошибках. */
function truncate(str, max) {
  const s = String(str == null ? '' : str);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** RqUID — уникальный идентификатор запроса (требуется для OAuth). */
function generateRquid() {
  try {
    return crypto.randomUUID();
  } catch (_) {
    return crypto.randomBytes(16).toString('hex');
  }
}

/** Разрешить учётные данные из окружения (ничего не хардкодим). */
function resolveAuthKey() {
  const authKey =
    process.env.GIGACHAT_AUTH_KEY ||
    process.env.GIGACHAT_CLIENT_ID;
  if (!authKey) {
    throw new Error(
      'GigaChat: не задан GIGACHAT_AUTH_KEY (Authorization key для OAuth).'
    );
  }
  return authKey;
}

/**
 * Низкоуровневый HTTP(S)-запрос.
 * @param {object} options — опции для https.request
 * @param {string|Buffer} [body]
 * @returns {Promise<{statusCode:number, headers:object, body:string}>}
 */
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(options.timeout || DEFAULT_CONFIG.requestTimeoutMs, () => {
      req.destroy(new Error('GigaChat: таймаут запроса'));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

/* ============================ OAuth ===================================== */

/**
 * Выполнить client_credentials OAuth и получить новый access_token.
 * @param {object} cfg
 * @returns {Promise<{accessToken:string, expiresAt:number}>}
 */
async function fetchAccessToken(cfg) {
  const authKey = resolveAuthKey();
  const scope = cfg.scope || process.env.GIGACHAT_SCOPE || DEFAULT_SCOPE;
  const payload = `scope=${encodeURIComponent(scope)}`;

  const options = {
    host: cfg.oauthHost,
    port: cfg.oauthPort,
    path: cfg.oauthPath,
    method: 'POST',
    agent: insecureAgent,
    rejectUnauthorized: false,
    timeout: cfg.oauthTimeoutMs,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Authorization: `Basic ${authKey}`,
      RqUID: generateRquid(),
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const res = await httpsRequest(options, payload);

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `GigaChat OAuth failed: HTTP ${res.statusCode} — ${truncate(res.body, 500)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`GigaChat OAuth: некорректный JSON ответа: ${e.message}`);
  }

  if (!parsed.access_token) {
    throw new Error('GigaChat OAuth: ответ не содержит access_token');
  }

  const now = Date.now();
  const expiresAt = parsed.expires_at
    ? Number(parsed.expires_at)
    : now + 30 * 60 * 1000;

  return { accessToken: parsed.access_token, expiresAt };
}

/**
 * Получить действующий access_token (из кэша или новый).
 * @param {object} cfg
 * @param {boolean} [force=false] — принудительно обновить
 * @returns {Promise<string>}
 */
async function getAccessToken(cfg, force = false) {
  const now = Date.now();
  if (
    !force &&
    _tokenCache.accessToken &&
    _tokenCache.expiresAt - TOKEN_SAFETY_WINDOW > now
  ) {
    return _tokenCache.accessToken;
  }

  const fresh = await fetchAccessToken(cfg);
  _tokenCache = fresh;
  return fresh.accessToken;
}

/* ======================= Работа с изображениями ========================= */

/** Сигнатуры форматов для определения MIME. */
const MIME_SIGNATURES = [
  { mime: 'image/jpeg', sig: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', sig: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', sig: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', sig: [0x42, 0x4d] },
  { mime: 'image/tiff', sig: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/webp', sig: [0x52, 0x49, 0x46, 0x46] },
];

/** Определить MIME по расширению, при неудаче — по магическим байтам. */
function detectMime(filePath, buffer) {
  const EXT_MAP = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
  };

  const ext = path.extname(filePath).toLowerCase();
  if (EXT_MAP[ext]) {
    return EXT_MAP[ext];
  }

  for (const { mime, sig } of MIME_SIGNATURES) {
    if (buffer.length >= sig.length && sig.every((b, i) => buffer[i] === b)) {
      return mime;
    }
  }
  return 'application/octet-stream';
}

/**
 * Прочитать изображение с диска.
 * @param {string} imagePath
 * @returns {{absPath:string, buffer:Buffer, mime:string, base64:string}}
 */
function readImageAsBase64(imagePath) {
  if (!imagePath || typeof imagePath !== 'string') {
    throw new Error('GigaChat Vision: imagePath обязателен и должен быть строкой');
  }

  const absPath = path.resolve(imagePath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`GigaChat Vision: файл не найден: ${absPath}`);
  }

  const buffer = fs.readFileSync(absPath);
  if (!buffer.length) {
    throw new Error(`GigaChat Vision: пустой файл: ${absPath}`);
  }

  return {
    absPath,
    buffer,
    mime: detectMime(absPath, buffer),
    base64: buffer.toString('base64'),
  };
}

/** Собрать тело multipart/form-data для загрузки файла. */
function buildMultipartBody(boundary, filename, mime, buffer) {
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  return Buffer.concat([
    Buffer.from(head, 'utf8'),
    buffer,
    Buffer.from(tail, 'utf8'),
  ]);
}

/* ======================= GigaChat API =================================== */

/**
 * Загрузить изображение в GigaChat и получить file_id.
 * @param {object} cfg
 * @param {string} imagePath
 * @param {string} token
 * @returns {Promise<string>}
 */
async function uploadImage(cfg, imagePath, token) {
  const img = readImageAsBase64(imagePath);
  const boundary = `----GigaChatBoundary${crypto.randomBytes(12).toString('hex')}`;
  const body = buildMultipartBody(
    boundary,
    path.basename(img.absPath),
    img.mime,
    img.buffer
  );

  const options = {
    host: cfg.apiHost,
    port: cfg.apiPort,
    path: cfg.filesPath,
    method: 'POST',
    agent: insecureAgent,
    rejectUnauthorized: false,
    timeout: cfg.requestTimeoutMs,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length,
    },
  };

  const res = await httpsRequest(options, body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `GigaChat upload failed: HTTP ${res.statusCode} — ${truncate(res.body, 400)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`GigaChat upload: некорректный JSON ответа: ${e.message}`);
  }

  const fileId = parsed.id || (parsed.data && parsed.data.id);
  if (!fileId) {
    throw new Error('GigaChat upload: ответ не содержит id файла');
  }
  return fileId;
}

/**
 * Запросить у модели описание изображения (chat/completions).
 * @returns {Promise<string>} текст ответа
 */
async function requestCompletion(cfg, token, fileId, prompt) {
  const bodyObj = {
    model: cfg.model,
    messages: [
      {
        role: 'user',
        content: prompt || 'Опиши подробно, что изображено на картинке.',
        attachments: fileId ? [fileId] : [],
      },
    ],
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
  };
  const body = JSON.stringify(bodyObj);

  const options = {
    host: cfg.apiHost,
    port: cfg.apiPort,
    path: cfg.chatPath,
    method: 'POST',
    agent: insecureAgent,
    rejectUnauthorized: false,
    timeout: cfg.requestTimeoutMs,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const res = await httpsRequest(options, body);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `GigaChat completion failed: HTTP ${res.statusCode} — ${truncate(res.body, 400)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch (e) {
    throw new Error(`GigaChat completion: некорректный JSON ответа: ${e.message}`);
  }

  const choice = parsed.choices && parsed.choices[0];
  const text =
    choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content
      : '';
  if (!text) {
    throw new Error('GigaChat completion: пустой ответ модели');
  }
  return text;
}

/* ============================ Публичный API ============================= */

/**
 * Проанализировать изображение через GigaChat Vision.
 *
 * @param {string} imagePath — путь к локальному файлу изображения
 * @param {string} [prompt]  — текстовый промпт для модели
 * @param {object} [options] — переопределение конфигурации
 * @returns {Promise<{text:string}>}
 */
async function analyze(imagePath, prompt, options = {}) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, options);

  // 1. Токен (с автообновлением при 401).
  let token = await getAccessToken(cfg, false);

  // 2. Загрузка изображения.
  let fileId;
  try {
    fileId = await uploadImage(cfg, imagePath, token);
  } catch (err) {
    if (/401/.test(String(err.message))) {
      token = await getAccessToken(cfg, true);
      fileId = await uploadImage(cfg, imagePath, token);
    } else {
      throw err;
    }
  }

  // 3. Запрос к модели (с автообновлением токена при 401).
  let text;
  try {
    text = await requestCompletion(cfg, token, fileId, prompt);
  } catch (err) {
    if (/401/.test(String(err.message))) {
      token = await getAccessToken(cfg, true);
      text = await requestCompletion(cfg, token, fileId, prompt);
    } else {
      throw err;
    }
  }

  return { text };
}

/** Сбросить кэш access_token (для тестов/ручного обновления). */
function resetTokenCache() {
  _tokenCache = { accessToken: null, expiresAt: 0 };
}

module.exports = {
  analyze,
  // Наблюдаемость и тесты.
  resetTokenCache,
  _internals: {
    fetchAccessToken,
    getAccessToken,
    uploadImage,
    requestCompletion,
    readImageAsBase64,
    detectMime,
    generateRquid,
    httpsRequest,
    buildMultipartBody,
  },
};
