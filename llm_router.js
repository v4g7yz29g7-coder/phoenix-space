// llm_router.js — единый роутер LLM
// 15.09: вместо 4+ разных callDeepSeek — один вход.
// Логирует ВСЕ вызовы, следит за бюджетом, готов к GigaChat/Astra.
'use strict';

require('dotenv').config({ path: __dirname + '/.env' });
const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'logs', 'usage.log');
const BUDGET_FILE = path.join(__dirname, 'memory', 'deepseek_budget.json');
const DAILY_LIMIT_USD = Number(process.env.LLM_DAILY_LIMIT_USD || 3);

// Цены DeepSeek (per 1M tokens)
const PRICE = {
  'deepseek-flash': { input: 0.22, cache: 0.022, output: 0.88 },
  'deepseek-chat': { input: 0.27, cache: 0.027, output: 1.10 },
  'deepseek-pro': { input: 0.55, cache: 0.055, output: 2.19 },
};

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function readBudget() {
  try {
    if (!fs.existsSync(BUDGET_FILE)) return { date: todayStr(), cost: 0, calls: 0 };
    const d = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf8'));
    if (d.date !== todayStr()) return { date: todayStr(), cost: 0, calls: 0 };
    return d;
  } catch (e) { return { date: todayStr(), cost: 0, calls: 0 }; }
}

function writeBudget(d) {
  try {
    fs.mkdirSync(path.dirname(BUDGET_FILE), { recursive: true });
    fs.writeFileSync(BUDGET_FILE, JSON.stringify(d, null, 2));
  } catch (e) {}
}

function checkBudget() {
  const b = readBudget();
  if (b.cost >= DAILY_LIMIT_USD) {
    throw new Error(`Daily LLM budget $${DAILY_LIMIT_USD} exceeded (current $${b.cost.toFixed(4)})`);
  }
  return b;
}

function updateBudget(cost) {
  const b = readBudget();
  b.cost = (b.cost || 0) + cost;
  b.calls = (b.calls || 0) + 1;
  b.updated = new Date().toISOString();
  writeBudget(b);
}

function logUsage(model, usage) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    const u = usage || {};
    const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
                   (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
    const total_in = u.prompt_tokens || u.input_tokens || 0;
    const fresh = total_in - cached;
    const pct = total_in > 0 ? Math.round((cached / total_in) * 100) : 0;
    const out = u.completion_tokens || u.output_tokens || 0;

    const p = PRICE[model] || PRICE['deepseek-flash'];
    const cost = (fresh * p.input + cached * p.cache + out * p.output) / 1_000_000;

    const line = `${new Date().toISOString()} [usage] model=${model} in=${total_in} cached=${cached} (${pct}%) fresh=${fresh} out=${out} cost=$${cost.toFixed(6)}`;
    fs.appendFileSync(LOG_FILE, line + '\n');
    updateBudget(cost);
    return { cached, fresh, out, total_in, cost };
  } catch (e) {
    return null;
  }
}

// === Основной вызов ===
function call(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    // 1. Бюджет
    try { checkBudget(); } catch (e) { return reject(e); }

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) return reject(new Error('DEEPSEEK_API_KEY не задан'));

    const model = opts.model || 'deepseek-flash';
    const body = JSON.stringify({
      model,
      messages,
      temperature: opts.temperature != null ? opts.temperature : 0.5,
      max_tokens: opts.max_tokens || 2000,
    });

    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.choices || !j.choices[0]) {
            return reject(new Error('bad response: ' + data.slice(0, 300)));
          }
          // Логируем
          const usageStats = logUsage(model, j.usage);
          const content = j.choices[0].message.content;

          if (opts.returnUsage) {
            resolve({ content, usage: usageStats, model });
          } else {
            resolve(content);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(opts.timeout_ms || 120000, () => {
      req.destroy();
      reject(new Error('timeout after ' + (opts.timeout_ms || 120000) + 'ms'));
    });
    req.write(body);
    req.end();
  });
}

// === Статистика ===
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

module.exports = { call, stats, logUsage, PRICE, DAILY_LIMIT_USD };
