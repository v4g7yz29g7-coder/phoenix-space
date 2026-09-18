'use strict';

/**
 * radio/radio_writer.js
 * ---------------------
 * Генератор коротких комментариев для гоночного радио.
 *
 * Использует GigaChat API (Sber) для генерации живых фраз по контексту гонки.
 * Все комментарии строго <= 100 символов.
 *
 * Публичное API:
 *   comment(event, context) -> Promise<string>
 *
 * Где:
 *   event   : string | object  — тип события ('overtake', 'pit', 'lap', ...)
 *   context : object           — контекст гонки (driver, position, lap, ...)
 *
 * Пример:
 *   const writer = require('./radio_writer');
 *   writer.comment('overtake', { driver: 'Алонсо', target: 'Хэмилтон', lap: 34 })
 *     .then(txt => console.log(txt));
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

/* ------------------------------------------------------------------ */
/* Конфигурация                                                        */
/* ------------------------------------------------------------------ */

const MAX_LEN = 100;

const CONFIG = {
  // OAuth endpoint для получения access_token GigaChat
  oauthUrl: process.env.GIGACHAT_OAUTH_URL ||
    'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
  // REST endpoint генерации
  chatUrl: process.env.GIGACHAT_CHAT_URL ||
    'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
  scope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
  authKey: process.env.GIGACHAT_AUTH_KEY || '',
  model: process.env.GIGACHAT_MODEL || 'GigaChat',
  timeout: parseInt(process.env.RADIO_WRITER_TIMEOUT || '8000', 10),
  insecure: process.env.RADIO_WRITER_INSECURE === '1',
  temperature: parseFloat(process.env.RADIO_WRITER_TEMP || '0.9'),
  maxRetries: parseInt(process.env.RADIO_WRITER_RETRIES || '2', 10)
};

/* ------------------------------------------------------------------ */
/* Внутреннее состояние                                                */
/* ------------------------------------------------------------------ */

const state = {
  token: null,
  tokenExpiresAt: 0,
  cache: new Map(),        // key -> string
  cacheLimit: 500,
  inflight: new Map(),     // key -> Promise (дедупликация одновременных запросов)
  stats: { generated: 0, fallback: 0, errors: 0, cached: 0 }
};

/* ------------------------------------------------------------------ */
/* Утилиты                                                             */
/* ------------------------------------------------------------------ */

/**
 * Обрезка строки до лимита без разрыва слова (по возможности).
 */
function clamp(text, limit) {
  if (typeof text !== 'string') return '';
  let s = text.trim().replace(/\s+/g, ' ');
  // убираем кавычки и markdown-мусор из ответа LLM
  s = s.replace(/^["'«»\s]+|["'«»\s]+$/g, '');
  s = s.replace(/[`*_#]/g, '');
  if (s.length <= limit) return s;
  const cut = s.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > limit * 0.6) return cut.slice(0, lastSpace).trim();
  return cut.trim();
}

/**
 * Безопасное получение поля из контекста.
 */
function pick(ctx, keys, fallback) {
  if (!ctx || typeof ctx !== 'object') return fallback;
  for (const k of keys) {
    if (ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== '') return ctx[k];
  }
  return fallback;
}

/**
 * Приведение event к строковому типу.
 */
function eventType(event) {
  if (typeof event === 'string') return event;
  if (event && typeof event === 'object') {
    return event.type || event.kind || event.event || 'unknown';
  }
  return 'unknown';
}

/**
 * Ключ кэша для события+контекста.
 */
function cacheKey(event, context) {
  const t = eventType(event);
  const id = pick(context, ['driverId', 'driver', 'id', 'raceId'], '');
  const extra = pick(context, ['lap', 'position', 'target'], '');
  return `${t}|${id}|${extra}`;
}

/**
 * HTTP(S) POST с таймаутом. Возвращает { status, body }.
 */
function httpPost(urlStr, headers, payload) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const opts = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }, headers || {}),
      timeout: CONFIG.timeout,
      rejectUnauthorized: !CONFIG.insecure
    };
    const req = lib.request(opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* GigaChat: авторизация                                               */
/* ------------------------------------------------------------------ */

async function getToken(force) {
  const now = Date.now();
  if (!force && state.token && now < state.tokenExpiresAt - 30000) {
    return state.token;
  }
  if (!CONFIG.authKey) throw new Error('GIGACHAT_AUTH_KEY is not set');

  const res = await httpPost(
    CONFIG.oauthUrl,
    {
      'Accept': 'application/json',
      'RqUID': require('crypto').randomUUID(),
      'Authorization': `Basic ${CONFIG.authKey}`
    },
    `scope=${encodeURIComponent(CONFIG.scope)}`
  );

  if (res.status !== 200) {
    throw new Error(`oauth failed: ${res.status}`);
  }
  const json = JSON.parse(res.body);
  state.token = json.access_token;
  state.tokenExpiresAt = json.expires_at || (now + 25 * 60 * 1000);
  return state.token;
}

/* ------------------------------------------------------------------ */
/* GigaChat: генерация                                                 */
/* ------------------------------------------------------------------ */

/**
 * Формирование системного промпта.
 */
function systemPrompt() {
  return [
    'Ты — спортивный комментатор Формулы-1 на радио.',
    'Отвечай ОДНОЙ короткой фразой на русском языке.',
    `Максимум ${MAX_LEN} символов, без пояснений и без кавычек.`,
    'Стиль: живой, эмоциональный, информативный.'
  ].join(' ');
}

/**
 * Формирование пользовательского промпта из события и контекста.
 */
function userPrompt(event, context) {
  const t = eventType(event);
  const driver = pick(context, ['driver', 'driverName', 'name'], 'пилот');
  const target = pick(context, ['target', 'other', 'rival'], 'соперник');
  const lap = pick(context, ['lap', 'currentLap'], null);
  const pos = pick(context, ['position', 'pos', 'place'], null);
  const speed = pick(context, ['speed', 'kph'], null);
  const team = pick(context, ['team', 'constructor'], null);
  const gap = pick(context, ['gap', 'delta'], null);

  const bits = [`Событие: ${t}.`, `Пилот: ${driver}.`];
  if (target) bits.push(`Соперник: ${target}.`);
  if (team) bits.push(`Команда: ${team}.`);
  if (lap !== null) bits.push(`Круг: ${lap}.`);
  if (pos !== null) bits.push(`Позиция: ${pos}.`);
  if (speed !== null) bits.push(`Скорость: ${speed} км/ч.`);
  if (gap !== null) bits.push(`Отрыв: ${gap}.`);
  bits.push(`Сгенерируй реплику не длиннее ${MAX_LEN} символов.`);
  return bits.join(' ');
}

/**
 * Вызов GigaChat chat/completions.
 */
async function callGigaChat(event, context, attempt) {
  attempt = attempt || 0;
  const token = await getToken(attempt > 0);
  const payload = {
    model: CONFIG.model,
    temperature: CONFIG.temperature,
    max_tokens: 64,
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userPrompt(event, context) }
    ]
  };
  const res = await httpPost(
    CONFIG.chatUrl,
    { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
    payload
  );
  if (res.status === 401 && attempt < CONFIG.maxRetries) {
    return callGigaChat(event, context, attempt + 1);
  }
  if (res.status !== 200) {
    throw new Error(`gigachat ${res.status}`);
  }
  const json = JSON.parse(res.body);
  const content = json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.content;
  if (!content) throw new Error('empty completion');
  return content;
}

/* ------------------------------------------------------------------ */
/* Fallback-шаблоны (если API недоступно)                              */
/* ------------------------------------------------------------------ */

const TEMPLATES = {
  overtake: (c) => `Обгон! ${pick(c, ['driver', 'name'], 'Пилот')} прошёл ${pick(c, ['target', 'rival'], 'соперника')}!`,
  pit: (c) => `${pick(c, ['driver', 'name'], 'Пилот')} — пит-стоп на круге ${pick(c, ['lap'], '?')}.`,
  fastest: (c) => `Быстрейший круг: ${pick(c, ['driver', 'name'], 'пилот')} ускоряется!`,
  spin: (c) => `Разворот! ${pick(c, ['driver', 'name'], 'Пилот')} теряет время.`,
  crash: (c) => `Авария! ${pick(c, ['driver', 'name'], 'Пилот')} в контакте со стеной.`,
  safety_car: () => 'На трассе машина безопасности.',
  start: () => 'Гонка стартовала! Пилоты уходят вперёд.',
  finish: (c) => `Финиш! ${pick(c, ['driver', 'name'], 'Пилот')} пересекает линию.`,
  weather: () => 'Погода меняется, пилоты осторожны.',
  unknown: (c) => `Внимание на трассе: ${pick(c, ['driver', 'name'], 'пилот')} в эфире.`
};

/**
 * Синхронный fallback: восстановление из шаблонов.
 */
function fallback(event, context) {
  const t = eventType(event);
  const fn = TEMPLATES[t] || TEMPLATES.unknown;
  let text;
  try {
    text = fn(context || {});
  } catch (e) {
    text = TEMPLATES.unknown(context || {});
  }
  state.stats.fallback += 1;
  return clamp(text, MAX_LEN);
}

/* ------------------------------------------------------------------ */
/* Публичное API                                                       */
/* ------------------------------------------------------------------ */

/**
 * Генерация короткого комментария по событию и контексту.
 *
 * @param {string|object} event
 * @param {object} [context]
 * @returns {Promise<string>} строка длиной <= 100 символов
 */
async function comment(event, context) {
  context = context || {};
  const key = cacheKey(event, context);

  // 1) кэш
  if (state.cache.has(key)) {
    state.stats.cached += 1;
    return state.cache.get(key);
  }

  // 2) дедупликация одновременных вызовов
  if (state.inflight.has(key)) {
    return state.inflight.get(key);
  }

  const task = (async () => {
    try {
      const raw = await callGigaChat(event, context, 0);
      const text = clamp(raw, MAX_LEN) || fallback(event, context);
      state.stats.generated += 1;
      remember(key, text);
      return text;
    } catch (err) {
      state.stats.errors += 1;
      const text = fallback(event, context);
      remember(key, text);
      return text;
    } finally {
      state.inflight.delete(key);
    }
  })();

  state.inflight.set(key, task);
  return task;
}

function remember(key, text) {
  state.cache.set(key, text);
  if (state.cache.size > state.cacheLimit) {
    const first = state.cache.keys().next().value;
    state.cache.delete(first);
  }
}

/**
 * Полностью локальный (без сети) комментарий.
 */
function commentSync(event, context) {
  return fallback(event, context);
}

/**
 * Диагностика.
 */
function stats() {
  return Object.assign({}, state.stats, {
    cacheSize: state.cache.size,
    hasToken: !!state.token
  });
}

/**
 * Сброс кэша (для тестов).
 */
function resetCache() {
  state.cache.clear();
  state.inflight.clear();
}

module.exports = {
  comment,
  commentSync,
  stats,
  resetCache,
  MAX_LEN,
  CONFIG,
  _internals: { clamp, eventType, fallback, cacheKey, userPrompt }
};
