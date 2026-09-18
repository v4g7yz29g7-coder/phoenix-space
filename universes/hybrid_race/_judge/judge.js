#!/usr/bin/env node
// _judge/judge.js — LLM-судья для 3 гибридов
'use strict';
// Загрузка .env
try {
  const dotenv = require('dotenv');
  dotenv.config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env') });
} catch (e) { /* тихо */ }

const fs = require('fs');
const path = require('path');
const https = require('https');

const HERE = __dirname;
const RESULTS = path.join(HERE, 'results.json');
const REPORT = path.join(HERE, 'REPORT.md');
// 15.09: единый роутер (логирование + бюджет)
let _llmRouter;
try { _llmRouter = require('/home/ishidin/phoenix/llm_router'); } catch (e) { _llmRouter = null; }

const KEY = process.env.DEEPSEEK_API_KEY;

async function callDeepSeek(messages, opts = {}) {
  // 15.09: через router (логирование + бюджет)
  if (_llmRouter) {
    try {
      return await _llmRouter.call(messages, {
        model: 'deepseek-chat',
        temperature: 0.3,
        max_tokens: 2000,
      });
    } catch (e) {
      console.error('[judge] router fallback:', e.message);
    }
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.3,
      max_tokens: 2000,
    });
    const req = https.request({
      hostname: 'api.deepseek.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.choices || !j.choices[0]) return reject(new Error('bad: ' + data.slice(0, 300)));
          resolve(j.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function judgeOne(row) {
  const prompt = `Ты — судья гонки гибридов ДНК Архитектора.

Задача: ${row.q}
Тип задачи: ${row.type}

Три версии ответа (одинаковый запрос, разные ДНК):

=== TECH (A+C+v3) ===
${row.answers.tech?.answer || '(нет)'}

=== STYLE (B+v3+D) ===
${row.answers.style?.answer || '(нет)'}

=== FULL (всё) ===
${row.answers.full?.answer || '(нет)'}

Оцени каждый по 4 метрикам (0-10):
1. Полнота (покрытие темы)
2. Точность (соответствие фактам, нет галлюцинаций)
3. Действенность (можно ли действовать по ответу)
4. Стиль (голос Архитектора — «брат», прямота, структура)

Отвечай ТОЛЬКО JSON:
{"tech":{"полнота":X,"точность":X,"действенность":X,"стиль":X,"итог":X},
 "style":{...},
 "full":{...},
 "winner":"tech|style|full",
 "reason":"1 строка"}`;

  const answer = await callDeepSeek([
    { role: 'system', content: 'Ты — строгий судья. Отвечай только JSON.' },
    { role: 'user', content: prompt },
  ]);

  // Парсим JSON
  const clean = answer.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); }
  catch (e) {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    return { error: 'parse failed', raw: answer.slice(0, 200) };
  }
}

async function run() {
  const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
  console.log(`Задач: ${results.length}`);

  const scores = { tech: [], style: [], full: [] };
  const winners = { tech: 0, style: 0, full: 0 };
  const details = [];

  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    console.log(`[${i + 1}/${results.length}] ${row.id}...`);
    try {
      const v = await judgeOne(row);
      details.push({ id: row.id, type: row.type, verdict: v });
      for (const m of ['tech', 'style', 'full']) {
        if (v[m] && typeof v[m].итог === 'number') scores[m].push(v[m].итог);
      }
      if (v.winner) winners[v.winner] = (winners[v.winner] || 0) + 1;
    } catch (e) {
      console.log(`  ❌ ${e.message}`);
    }
  }

  const avg = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : '—';
  const summary = {
    tasks: results.length,
    tech_avg: avg(scores.tech),
    style_avg: avg(scores.style),
    full_avg: avg(scores.full),
    winners,
    winner_overall: Object.entries(winners).sort((a, b) => b[1] - a[1])[0][0],
  };

  // Отчёт
  const md = [
    '# Суд гибридов ДНК Архитектора',
    '',
    `Дата: ${new Date().toISOString()}`,
    `Задач: ${results.length}`,
    '',
    '## Средние оценки',
    '',
    '| Гибрид | Средний итог |',
    '|---|---:|',
    `| tech | ${summary.tech_avg} |`,
    `| style | ${summary.style_avg} |`,
    `| full | ${summary.full_avg} |`,
    '',
    '## Победители по задачам',
    '',
    `- tech: ${winners.tech}`,
    `- style: ${winners.style}`,
    `- full: ${winners.full}`,
    '',
    `## 🏆 Общий победитель: **${summary.winner_overall}**`,
    '',
    '## Детали',
    '',
    ...details.map(d => `### ${d.id} (${d.type})\nПобедитель: **${d.verdict.winner}** — ${d.verdict.reason || ''}\n`),
  ].join('\n');

  fs.writeFileSync(REPORT, md);
  fs.writeFileSync(path.join(HERE, 'scores.json'), JSON.stringify({ summary, details }, null, 2));

  console.log('');
  console.log('=== ИТОГ ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Отчёт: ${REPORT}`);
}

if (require.main === module) {
  run().catch(e => { console.error('❌', e); process.exit(1); });
}

module.exports = { run };
