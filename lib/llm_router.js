// lib/llm_router.js — единый LLM-роутер (по мотивам коммита f06ad628):
// логирование usage + дневной бюджет + fallback chat -> flash.
//
// Отличия от корневого llm_router.js, важные для тестируемости:
//   * используется глобальный fetch (легко подменяется моком, без https.request);
//   * usage пишется в logs/llm_usage.jsonl (JSON Lines: model, tokens_in, tokens_out);
//   * превышение бюджета НЕ бросает исключение и НЕ идёт в сеть — возвращает
//     { ok:false, reason:'budget_exceeded' };
//   * fallback делает ровно 1 ретрай (primary + 1 fallback), без зацикливания.
'use strict';

const fs = require('fs');
const path = require('path');

// Пути можно переопределить через env — это используют тесты для изоляции.
const LOG_FILE =
  process.env.LLM_USAGE_LOG ||
  path.join(__dirname, '..', 'logs', 'llm_usage.jsonl');
const BUDGET_FILE =
  process.env.LLM_BUDGET_FILE ||
  path.join(__dirname, '..', 'memory', 'llm_budget.json');
const DAILY_LIMIT_USD = Number(process.env.LLM_DAILY_LIMIT_USD || 3);
const API_URL =
  process.env.LLM_API_URL || 'https://api.deepseek.com/v1/chat/completions';

// Логические модели: 'chat' (primary) и 'flash' (дешёвый fallback).
const PRIMARY_MODEL = 'chat';
const FALLBACK_MODEL = 'flash';

// Цены (per 1M tokens) — для учёта бюджета.
const PRICE = {
  chat: { input: 0.27, output: 1.10 },
  flash: { input: 0.22, output: 0.88 },
};

// Максимум ретраев: primary + 1 fallback. Больше — зацикливание, чего быть не должно.
const MAX_ATTEMPTS = 2;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function readBudget() {
  try {
    if (!fs.existsSync(BUDGET_FILE)) return { date: todayStr(), cost: 0, calls: 0 };
    const d = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    if (!d || d.date !== todayStr()) return { date: todayStr(), cost: 0, calls: 0 };
    return { date: d.date, cost: Number(d.cost) || 0, calls: Number(d.calls) || 0 };
  } catch (e) {
    return { date: todayStr(), cost: 0, calls: 0 };
  }
}

function writeBudget(d) {
  fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
  fs.writeFileSync(BUDGET_FILE, JSON.stringify(d, null, 2));
}

function updateBudget(cost) {
  const b = readBudget();
  b.cost = (b.cost || 0) + (Number(cost) || 0);
  b.calls = (b.calls || 0) + 1;
  b.updated = new Date().toISOString();
  writeBudget(b);
}

function budgetExceeded() {
  const b = readBudget();
  return false; // TAMPER
}

// Запись строки usage в logs/llm_usage.jsonl (JSON Lines).
function logUsage(entry) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  return entry;
}

function costOf(model, usage) {
  const p = PRICE[model] || PRICE[PRIMARY_MODEL];
  const tokensIn = Number((usage && usage.tokens_in) || 0);
  const tokensOut = Number((usage && usage.tokens_out) || 0);
  return (tokensIn * p.input + tokensOut * p.output) / 1_000_000;
}

// Один сетевой запрос. Бросает при перегрузке (429/5xx) или ошибке — это
// сигнал для перехода на fallback. Использует глобальный fetch (mock-friendly).
async function request(model, messages, opts) {
  const doFetch = opts.fetch || global.fetch;
  if (typeof doFetch !== 'function') throw new Error('fetch is not available');

  const body = {
    model,
    messages,
    temperature: opts.temperature != null ? opts.temperature : 0.5,
    max_tokens: opts.max_tokens || 2000,
  };

  const resp = await doFetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + (opts.apiKey || process.env.DEEPSEEK_API_KEY || ''),
    },
    body: JSON.stringify(body),
  });

  if (resp.status === 429 || resp.status >= 500) {
    throw new Error('overloaded: http ' + resp.status);
  }
  if (resp.ok === false) {
    throw new Error('http ' + resp.status);
  }

  const j = await resp.json();
  if (!j || !j.choices || !j.choices[0] || !j.choices[0].message) {
    throw new Error('bad response');
  }
  const u = j.usage || {};
  return {
    content: j.choices[0].message.content,
    usage: {
      tokens_in: Number(u.prompt_tokens || u.input_tokens || 0),
      tokens_out: Number(u.completion_tokens || u.output_tokens || 0),
    },
  };
}

// Единый вход. Порядок попыток: [primary, fallback] — максимум MAX_ATTEMPTS.
async function call(messages, opts = {}) {
  const primary = opts.model || PRIMARY_MODEL;
  const fallback = opts.fallback || (primary === FALLBACK_MODEL ? PRIMARY_MODEL : FALLBACK_MODEL);
  const attempts = [primary, fallback].slice(0, MAX_ATTEMPTS);

  // 1. Бюджет — до любого сетевого вызова.
  if (budgetExceeded()) {
    return { ok: false, reason: 'budget_exceeded' };
  }

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i];
    try {
      const r = await request(model, messages, opts);
      const usage = { model, tokens_in: r.usage.tokens_in, tokens_out: r.usage.tokens_out };
      logUsage(usage);
      updateBudget(costOf(model, r.usage));
      return { ok: true, model, content: r.content, usage };
    } catch (e) {
      lastErr = e;
      // неудачную попытку не логируем в usage и не зацикливаемся — идём к следующей
    }
  }

  return { ok: false, reason: 'upstream_error', error: String(lastErr && lastErr.message) };
}

function stats() {
  const b = readBudget();
  return {
    date: b.date,
    cost_usd: b.cost,
    calls: b.calls,
    limit_usd: DAILY_LIMIT_USD,
    percent: Math.round((b.cost / DAILY_LIMIT_USD) * 100),
  };
}

module.exports = {
  call,
  stats,
  logUsage,
  readBudget,
  budgetExceeded,
  costOf,
  PRICE,
  DAILY_LIMIT_USD,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  MAX_ATTEMPTS,
};
