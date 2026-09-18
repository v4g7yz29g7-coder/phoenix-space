'use strict';
require('dotenv').config({ path: __dirname + '/.env' });
const fs = require('fs');
const https = require('https');

const INVENTORY = fs.readFileSync('/tmp/system_inventory.txt', 'utf8');

async function getToken() {
  const authKey = process.env.GIGACHAT_AUTH_KEY || process.env.GIGACHAT_API_KEY;
  const scope = process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS';

  return new Promise((resolve, reject) => {
    const body = 'scope=' + encodeURIComponent(scope);
    const req = https.request({
      hostname: 'ngw.devices.sberbank.ru',
      port: 9443,
      path: '/api/v2/oauth',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'RqUID': require('crypto').randomUUID(),
        'Authorization': 'Basic ' + authKey,
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).access_token); }
        catch (e) { reject(new Error('token: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function askGiga(token, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'GigaChat',
      messages: [
        { role: 'system', content: 'Ты — технический архитектор проекта AI-1 Phoenix. Расскажи подробно и структурированно.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 4000,
      temperature: 0.3,
    });
    const req = https.request({
      hostname: 'gigachat.devices.sberbank.ru',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Content-Length': Buffer.byteLength(body),
      },
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (!j.choices) return reject(new Error('bad: ' + data.slice(0, 300)));
          resolve(j.choices[0].message.content);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

(async () => {
  try {
    console.log('🔑 Получаю GigaChat токен...');
    const token = await getToken();
    console.log('✅ Токен получен');

    const prompt = `Ниже — инвентаризация проекта AI-1 Phoenix (архитектура, модули, зависимости, процессы). Расскажи подробно:

1. Как устроена система (контуры, ядро, связи)
2. Что делает каждый крупный модуль (architect, evolution, benchmark, race, radio, trajectory, sensors)
3. Какие модули подключены к общему циклу, а какие лежат мёртвым грузом
4. Потоки данных: как задача от пользователя доходит до результата
5. Точки роста и что мешает

ИНВЕНТАРИЗАЦИЯ:
${INVENTORY.slice(0, 30000)}`;

    console.log('📤 Отправляю GigaChat...');
    const answer = await askGiga(token, prompt);

    fs.writeFileSync('/tmp/system_analysis.md', '# AI-1 Phoenix — анализ системы\n\n' + answer);
    console.log('\n=== ОТВЕТ GIGACHAT ===\n');
    console.log(answer);
    console.log('\n=== Сохранено в /tmp/system_analysis.md ===');
  } catch (e) {
    console.error('❌ Ошибка:', e.message);
  }
})();
