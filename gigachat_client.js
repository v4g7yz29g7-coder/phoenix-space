'use strict';
/**
 * gigachat_client.js
 * GigaChat Vision client: OAuth + file upload + chat completions.
 * Uses only Node.js built-in https (Russian Trusted CA -> rejectUnauthorized:false).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- lightweight .env loader (no external deps) ----------------------------
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (_) {
    /* ignore */
  }
})();

const OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
const API_BASE = 'https://gigachat.devices.sberbank.ru';

const agent = new https.Agent({ rejectUnauthorized: false });

// ---- token cache -----------------------------------------------------------
let _token = null;
let _expiresAt = 0;

function _rawRequest(url, opts = {}) {
  const method = opts.method || 'POST';
  const headers = opts.headers || {};
  const body = opts.body || null;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        agent,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('GigaChat request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function _parse(text, ctx) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`GigaChat ${ctx}: non-JSON response (${text.slice(0, 300)})`);
  }
}

/**
 * Get access_token via OAuth. Cached until expires_at - 60s.
 */
async function getAccessToken() {
  const now = Date.now();
  if (_token && _expiresAt - 60000 > now) return _token;

  const authKey = process.env.GIGACHAT_AUTH_KEY;
  const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';
  if (!authKey) throw new Error('GIGACHAT_AUTH_KEY not set');

  const body = 'scope=' + encodeURIComponent(scope);
  const res = await _rawRequest(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + authKey,
      RqUID: crypto.randomUUID(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });

  if (res.status !== 200) {
    throw new Error(`OAuth failed ${res.status}: ${res.text.slice(0, 300)}`);
  }
  const data = _parse(res.text, 'OAuth');
  if (!data.access_token) throw new Error('OAuth: no access_token in response');

  _token = data.access_token;
  _expiresAt = data.expires_at || now + 25 * 60 * 1000;
  return _token;
}

/**
 * Upload a local file (image) to GigaChat.
 * @returns {Promise<string>} file id
 */
async function uploadFile(filePath, purpose = 'general') {
  if (!fs.existsSync(filePath)) throw new Error(`uploadFile: not found ${filePath}`);
  const token = await getAccessToken();
  const buf = fs.readFileSync(filePath);
  const boundary = '----GigaChatBoundary' + crypto.randomBytes(12).toString('hex');
  const fname = path.basename(filePath);

  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="purpose"\r\n\r\n${purpose}\r\n` +
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fname}"\r\n` +
    `Content-Type: image/png\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([Buffer.from(head, 'utf8'), buf, Buffer.from(tail, 'utf8')]);

  const res = await _rawRequest(API_BASE + '/api/v1/files', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
      'Content-Length': body.length,
      Accept: 'application/json',
    },
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Upload failed ${res.status}: ${res.text.slice(0, 300)}`);
  }
  const data = _parse(res.text, 'Upload');
  const id = data.id || (data.file && data.file.id);
  if (!id) throw new Error('Upload: no file id in response: ' + res.text.slice(0, 200));
  return id;
}

/**
 * Chat completion, optionally with image attachments.
 * @param {string} prompt
 * @param {string[]} attachments file ids
 * @param {object} opts { model, temperature }
 * @returns {Promise<string>} assistant text
 */
async function chat(prompt, attachments = [], opts = {}) {
  const token = await getAccessToken();
  const message = { role: 'user', content: prompt };
  if (attachments && attachments.length) message.attachments = attachments;

  const payload = {
    model: opts.model || 'GigaChat-Pro',
    messages: [message],
    temperature: opts.temperature != null ? opts.temperature : 0.2,
  };
  const body = JSON.stringify(payload);

  const res = await _rawRequest(API_BASE + '/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'application/json',
    },
    body,
  });

  if (res.status !== 200) {
    throw new Error(`Chat failed ${res.status}: ${res.text.slice(0, 400)}`);
  }
  const data = _parse(res.text, 'Chat');
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) throw new Error('Chat: no message: ' + res.text.slice(0, 200));
  return (choice.message.content || '').trim();
}

/**
 * Analyze an image file directly: upload + chat.
 * @returns {Promise<string>} description
 */
async function analyzeImage(filePath, prompt) {
  const fileId = await uploadFile(filePath);
  const text = await chat(prompt || 'Что на этом скриншоте? Опиши подробно.', [fileId]);
  return text;
}

module.exports = {
  getAccessToken,
  uploadFile,
  chat,
  analyzeImage,
  _OAUTH_URL: OAUTH_URL,
  _API_BASE: API_BASE,
};
