// architect/agent.js — мозг Архитектора
// DNA + router + RAG + DeepSeek
'use strict';

const fs = require('fs');
const path = require('path');
const { selectMode, loadMode } = require('./router');
const router_v7 = require('./router_v7');
const rag = require('./rag_indexer');

const ROOT = path.join(__dirname, '..');
const DNA_FILE = process.env.ARCHITECT_DNA || path.join(ROOT, 'prompts', 'architect_dna_v4_style.md');

const _dnaCache = {};
function loadDNA(dnaPath) {
  const p = dnaPath || DNA_FILE;
  if (_dnaCache[p]) return _dnaCache[p];
  if (!fs.existsSync(p)) throw new Error('DNA not found: ' + p);
  _dnaCache[p] = fs.readFileSync(p, 'utf8');
  return _dnaCache[p];
}

// === DeepSeek ===
// 15.09: единый роутер (логирование + бюджет)
let _llmRouter;
try { _llmRouter = require('/home/ishidin/phoenix/llm_router'); } catch (e) { _llmRouter = null; }

const https = require('https');
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_HOST = 'api.deepseek.com';
const DEEPSEEK_PATH = '/v1/chat/completions';

function callDeepSeek(messages, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!DEEPSEEK_KEY) return reject(new Error('DEEPSEEK_API_KEY не задан'));
    const body = JSON.stringify({
      model: opts.model || process.env.ARCHITECT_MODEL || 'deepseek-flash',
      messages,
      temperature: opts.temperature != null ? opts.temperature : 0.6,
      max_tokens: opts.max_tokens || 1500,
    });
    const req = https.request({
      hostname: DEEPSEEK_HOST,
      path: DEEPSEEK_PATH,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DEEPSEEK_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.choices || !j.choices[0]) return reject(new Error('bad response: ' + data.slice(0, 300)));
          // 14.09: логирование usage как в deepseek_responses.js
          if (j.usage) {
            const u = j.usage;
            const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
                           (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
            const total_in = u.prompt_tokens || u.input_tokens || 0;
            const fresh = total_in - cached;
            const pct = total_in > 0 ? Math.round((cached / total_in) * 100) : 0;
            const model = opts.model || process.env.ARCHITECT_MODEL || 'deepseek-flash';
            const logLine = '[arch-usage] model=' + model + ' in=' + total_in +
              ' cached=' + cached + ' (' + pct + '%) fresh=' + fresh +
              ' out=' + (u.completion_tokens || u.output_tokens || 0);
            console.log(logLine);
            try {
              require('fs').appendFileSync('/home/ishidin/phoenix/logs/usage.log',
                new Date().toISOString() + ' ' + logLine + '\n');
            } catch (e) {}
          }
          resolve(j.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// === Сборка контекста для режима ===
async function buildContext(text, opts = {}) {
  // 1+2. Двухосевой DAS: режим + ДНК
  const routeResult = router_v7.route(text, {
    timeOfDay: opts.timeOfDay || getTimeOfDay(),
    errorRate: opts.errorRate || 0,
    taskComplexity: opts.taskComplexity || 0,
  });
  const modeResult = { mode: routeResult.mode, reasons: routeResult.modeReasons || routeResult.reasons || [] };
  const dnaPath = router_v7.dnaPath(routeResult.dna);

  // Загрузка режимного промпта
  const mode = loadMode(modeResult.mode);

  // 3. RAG — ищем релевантные цитаты из корпуса
  let ragHits = [];
  try {
    ragHits = await rag.search(text, { limit: 5 });
  } catch (e) { /* тихо */ }

  // 4. Собираем system-prompt
  const dna = loadDNA(dnaPath);

  const mods = router_v7.modifiers(routeResult);

  const system = [
    '# Ты — Архитектор',
    '',
    'Ты — цифровой двойник брата Ишидина. Ты говоришь как он, думаешь как он, действуешь в его границах.',
    '',
    '## Твоя ДНК (v3)',
    '```',
    dna.slice(0, 8000),
    '```',
    '',
    '## Текущий режим',
    mode.label,
    '```',
    mode.prompt,
    '```',
    '',
    '## Цитаты из твоего корпуса (что ты говорил раньше)',
    ragHits.length ? ragHits.map((h, i) => `[${i + 1}] ${h.text.slice(0, 300)}`).join('\n\n') : '(нет совпадений)',
    '',
    '## Правило',
    'Отвечай в выбранном режиме. Не выходи из роли. Обращайся «брат».',
    '',
    '## Шестиосевые модификаторы',
    mods,
  ].join('\n');

  return {
    system,
    mode: modeResult.mode,
    dna: routeResult.dna,
    dnaSource: routeResult.dnaSource,
    lang: routeResult.lang,
    length: routeResult.length,
    iter: routeResult.iter,
    verify: routeResult.verify,
    creativity: routeResult.creativity,
    team: routeResult.team,
    autonomy: routeResult.autonomy,
    trigger: routeResult.trigger,
    tempo: routeResult.tempo,
    risk: routeResult.risk,
    ragHits,
    modeResult,
  };
}

function getTimeOfDay() {
  const h = new Date().getUTCHours() + 3; // МСК примерно
  const hh = ((h % 24) + 24) % 24;
  if (hh >= 5 && hh < 12) return 'morning';
  if (hh >= 12 && hh < 18) return 'day';
  if (hh >= 18 && hh < 23) return 'evening';
  return 'night';
}

// === Главный метод ===
async function respond(userText, opts = {}) {
  const ctx = await buildContext(userText, opts);

  const messages = [
    { role: 'system', content: ctx.system },
    { role: 'user', content: userText },
  ];

  const _call = _llmRouter ? _llmRouter.call : callDeepSeek;
  const answer = await _call(messages, {
    temperature: opts.temperature != null ? opts.temperature : (ctx.mode === 'crisis' ? 0.3 : 0.6),
  });

  return {
    answer,
    mode: ctx.mode,
    dna: ctx.dna,
    dnaSource: ctx.dnaSource,
    lang: ctx.lang,
    length: ctx.length,
    iter: ctx.iter,
    verify: ctx.verify,
    creativity: ctx.creativity,
    team: ctx.team,
    autonomy: ctx.autonomy,
    trigger: ctx.trigger,
    tempo: ctx.tempo,
    risk: ctx.risk,
    ragHits: ctx.ragHits.length,
    reasons: ctx.modeResult.reasons,
  };
}

// === CLI ===
if (require.main === module) {
  const text = process.argv.slice(2).join(' ');
  if (!text) {
    console.log('Использование: node architect/agent.js "ваш вопрос"');
    process.exit(0);
  }
  respond(text)
    .then(r => {
      console.log('');
      console.log('=== Режим:', r.mode, '| DNA:', r.dna, '| lang:', r.lang, '| len:', r.length, '| iter:', r.iter, '| verify:', r.verify, '| creativity:', r.creativity, '| team:', r.team, '| autonomy:', r.autonomy, '| trigger:', r.trigger, '| tempo:', r.tempo, '| risk:', r.risk, '| RAG-hits:', r.ragHits, '===');
      console.log('Причины:', r.reasons.join(', '));
      console.log('');
      console.log('=== Ответ ===');
      console.log(r.answer);
    })
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}

module.exports = { respond, buildContext, loadDNA, selectMode };
