// vps_bot.js — Telegram пульт управления AI-1
// 15.09: расширен — race, agents, bench, loop, night, health, read, grep, logs
const https = require('https');
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const token = process.env.TELEGRAM_BOT_TOKEN;
const allowedUsers = [742154130];  // 15.09: исправлено (было 7421544130)

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN не задан');
  process.exit(1);
}

// 15.09: Cloudflare Worker (РКН блокирует api.telegram.org)
// 15.09: короткий polling (без long-poll) — Cloudflare Worker рвёт длинные соединения
// interval 1000ms + timeout 0 = быстрые запросы каждую секунду
const bot = new TelegramBot(token, {
  polling: {
    interval: 1000,
    autoStart: true,
    params: { timeout: 0 }   // ← НЕ long-polling
  },
  baseApiUrl: 'https://tg-proxy.ishidin.workers.dev',
});

const ROOT = '/home/ishidin/phoenix';

// Хелпер: exec с обрезкой
function run(cmd, maxLen = 4000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd: ROOT, timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let out = (stdout || stderr || err?.message || 'ок').toString();
      if (out.length > maxLen) out = out.slice(0, maxLen) + '\n...(обрезано)';
      resolve(out);
    });
  });
}

// 16.09: safe sendMessage — не падать на пустом тексте
const _origSend = bot.sendMessage.bind(bot);
bot.sendMessage = function(chatId, text, opts) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return Promise.resolve({ ok: false, reason: 'empty' });
  return _origSend(chatId, t, opts).catch(e => {
    console.error('[sendMessage]', e.message);
    return { ok: false, error: e.message };
  });
};

function guard(msg) {
  const ok = allowedUsers.includes(msg.from.id);
  console.log(`[msg] from.id=${msg.from.id} text="${(msg.text || '').slice(0, 50)}" allowed=${ok}`);
  return ok;
}

// ============ /start ============
bot.onText(/\/start/, async (msg) => {
  if (!guard(msg)) return;
  const help = `🚀 *AI-1 Pult*

*Управление:*
/race <задача> — запустить гонку
/agents — fitness top-3
/bench — свежие бенчмарки
/health — диагностика (5 сек)
/loop on|off — benchmark loop
/night on|off — night_evolution

*Чтение:*
/read <file> [start] [end] — файл
/grep <pattern> — поиск
/logs <module> — логи (benchmark/night/architect/bot)
/tree — структура папок

*Система:*
/status — PM2 процессы
/disk — диск
/mem — память
/uptime — uptime`;
  bot.sendMessage(msg.chat.id, help);  // 15.09: без Markdown (падал из-за _)
});

// ============ /status /logs /disk /mem /uptime ============
bot.onText(/\/status/, async (msg) => {
  if (!guard(msg)) return;
  const out = await run('pm2 status');
  bot.sendMessage(msg.chat.id, '```\n' + out + '\n```');
});

bot.onText(/\/disk/, async (msg) => {
  if (!guard(msg)) return;
  bot.sendMessage(msg.chat.id, await run('df -h /'));
});

bot.onText(/\/mem/, async (msg) => {
  if (!guard(msg)) return;
  bot.sendMessage(msg.chat.id, await run('free -h'));
});

bot.onText(/\/uptime/, async (msg) => {
  if (!guard(msg)) return;
  bot.sendMessage(msg.chat.id, await run('uptime'));
});

// ============ /health ============
bot.onText(/\/health/, async (msg) => {
  if (!guard(msg)) return;
  bot.sendMessage(msg.chat.id, '⏳ Проверяю...');
  const out = await run('bash scripts/phoenix_health.sh', 3500);
  bot.sendMessage(msg.chat.id, '```\n' + out + '\n```');
});

// ============ /race <task> ============
bot.onText(/\/race (.+)/, async (msg, match) => {
  if (!guard(msg)) return;
  const task = match[1].trim();
  bot.sendMessage(msg.chat.id, `🏁 Запускаю гонку:\n_${task.slice(0, 200)}_`);

  // Запуск в фоне, ответ через 60 сек
  const raceId = 'race_' + Date.now();
  const cmd = `RACE_TASK=${JSON.stringify(task)} RACE_BOXES="agent_1,agent_7,agent_3" RACE_ID_DIRECTED=${raceId} timeout 180 node race.js`;
  
  const out = await run(cmd, 3000);
  
  // Ищем последние строки с результатами
  const lines = out.split('\n').slice(-15).join('\n');
  bot.sendMessage(msg.chat.id, '```\n' + lines + '\n```');
});

// ============ /agents ============
bot.onText(/\/agents/, async (msg) => {
  if (!guard(msg)) return;
  try {
    const fit = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory/fitness.json'), 'utf8'));
    const sorted = Object.values(fit.agents).sort((a, b) => b.fitness - a.fitness).slice(0, 5);
    let out = '🏆 *Fitness топ-5:*\n\n';
    for (const a of sorted) {
      out += `*${a.box}* — fitness ${a.fitness}\n`;
      out += `  runs: ${a.runs_total} | wins: ${a.wins_total}\n`;
      out += `  last score: ${a.last_score_avg}\n\n`;
    }
    bot.sendMessage(msg.chat.id, out);
  } catch (e) {
    bot.sendMessage(msg.chat.id, '❌ Ошибка: ' + e.message);
  }
});

// ============ /bench ============
bot.onText(/\/bench/, async (msg) => {
  if (!guard(msg)) return;
  const out = await run('ls -t benchmark/archive/bench_*.json 2>/dev/null | head -5 | xargs -I{} sh -c "echo \\"=== {} ===\\" && python3 -c \\"import json; d=json.load(open(\'{}\')); print(f\'Задач: {len(d[\\"tasks\\"])}, Результатов: {len(d.get(\\"results\\",[]))}\')\\""', 3000);
  bot.sendMessage(msg.chat.id, out);
});

// ============ /loop on|off ============
bot.onText(/\/loop (on|off)/, async (msg, match) => {
  if (!guard(msg)) return;
  const action = match[1];
  if (action === 'on') {
    const out = await run('nohup bash -c "set -a; source .env; set +a; node benchmark/loop.js" > /tmp/benchmark_loop.log 2>&1 & echo "PID: $!"');
    bot.sendMessage(msg.chat.id, '✅ Loop запущен:\n' + out);
  } else {
    const out = await run('pkill -f "benchmark/loop" && echo "✅ Loop остановлен" || echo "не был запущен"');
    bot.sendMessage(msg.chat.id, out);
  }
});

// ============ /night on|off ============
bot.onText(/\/night (on|off)/, async (msg, match) => {
  if (!guard(msg)) return;
  const action = match[1];
  if (action === 'on') {
    const out = await run('nohup bash -c "set -a; source .env; set +a; node night_evolution.js" > /tmp/night_evolution.log 2>&1 & echo "PID: $!"');
    bot.sendMessage(msg.chat.id, '✅ Night запущен:\n' + out);
  } else {
    const out = await run('pkill -f "night_evolution" && echo "✅ Night остановлен" || echo "не был запущен"');
    bot.sendMessage(msg.chat.id, out);
  }
});

// ============ /read <file> [start] [end] ============
bot.onText(/\/read (\S+)(?:\s+(\d+))?(?:\s+(\d+))?/, async (msg, match) => {
  if (!guard(msg)) return;
  const file = match[1];
  const start = match[2] || '';
  const end = match[3] || '';
  const cmd = `bash scripts/phoenix_read.sh ${JSON.stringify(file)} ${start} ${end}`;
  const out = await run(cmd, 3500);
  bot.sendMessage(msg.chat.id, '```\n' + out + '\n```');
});

// ============ /grep <pattern> ============
bot.onText(/\/grep (.+)/, async (msg, match) => {
  if (!guard(msg)) return;
  const pattern = match[1];
  const out = await run(`bash scripts/phoenix_grep.sh ${JSON.stringify(pattern)} . --include=*.js`, 3000);
  bot.sendMessage(msg.chat.id, '```\n' + out + '\n```');
});

// ============ /logs <module> ============
bot.onText(/\/logs (\S+)/, async (msg, match) => {
  if (!guard(msg)) return;
  const mod = match[1];
  const out = await run(`bash scripts/phoenix_logs.sh ${mod} 30`, 3500);
  bot.sendMessage(msg.chat.id, '```\n' + out + '\n```');
});

// ============ /tree ============
bot.onText(/\/tree/, async (msg) => {
  if (!guard(msg)) return;
  const out = await run('bash scripts/phoenix_tree.sh . 1', 3000);
  bot.sendMessage(msg.chat.id, '```\n' + out + '\n```');
});

// ============ Голосовые сообщения ============
// 15.09: Telegram сам транскрибирует голос в текст (если включено в настройках).
// Если text пришёл — обрабатываем как команду. Если нет — подсказка.
bot.on('voice', async (msg) => {
  if (!guard(msg)) return;

  const text = (msg.text || '').trim();

  if (!text) {
    // 16.09: без parse_mode — падало с 'message text is empty'
    bot.sendMessage(msg.chat.id,
      '⚠️ Транскрипция не работает.\n\n' +
      'Включи в Telegram:\n' +
      'Настройки → Язык → «Транскрипция голосовых сообщений»\n\n' +
      'После этого — говори голосом, я пойму.'
    ).catch(() => {});
    return;
  }

  // Пришёл текст из голосового — обрабатываем как обычное сообщение
  bot.sendMessage(msg.chat.id, `🎤 Распознано: _${text}_`);

  // Если начинается с / — это команда, эмулируем
  if (text.startsWith('/')) {
    // Telegram сам обработает через onText
    return;
  }

  // Иначе — оптимизируем как задачу
  bot.sendMessage(msg.chat.id, '🧠 Оптимизирую задачу через Архитектора...');
  const optimized = await run(`node scripts/phoenix_optimize.js ${JSON.stringify(text)}`, 2000);
  bot.sendMessage(msg.chat.id, '```\n' + optimized + '\n```');
});



// ============ Свободный текст → Архитектор → действие ============
// 15.09: пользователь пишет естественно, бот решает что делать
bot.on('message', async (msg) => {
  // 16.09: фото/документы — в отдельный обработчик
  if (msg.photo || msg.document) { handlePhoto(msg); return; }
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return;   // команды — отдельно
  if (msg.text.length < 3) return;

  const chatId = msg.chat.id;
  if (!allowedUsers.includes(msg.from.id)) return;

  bot.sendMessage(chatId, '🧠 Думаю...');

  const router = require('./llm_router');
  const systemPrompt = `Ты — автономный ассистент на сервере /home/ishidin/phoenix.
Отвечай СТРОГО JSON. Три действия:

{"action":"answer","reply":"..."} — если можешь ответить сразу (безопасный вопрос)
{"action":"read","target":"путь/к/файлу"} — если нужно прочитать файл
{"action":"exec","target":"команда"} — если нужно выполнить bash (только: ls, cat, grep, find ., tail, head, wc, ps, df, free, uptime, node --check, git)

ЗАПРЕЩЕНО в exec: rm, mv, find /, npm install, pip install, sudo, apt.

Пользователь: "${msg.text}"

Отвечай только JSON, без пояснений.`;

  try {
    const raw = await router.call([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: msg.text }
    ], { model: 'deepseek-flash', max_tokens: 400, temperature: 0.3 });

    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) { bot.sendMessage(chatId, raw.slice(0, 3000)); return; }
    const r = JSON.parse(m[0]);

    if (r.action === 'answer') {
      bot.sendMessage(chatId, String(r.reply || '—').slice(0, 3500));
    } else if (r.action === 'read') {
      const out = await run('bash scripts/phoenix_read.sh ' + JSON.stringify(r.target), 3500);
      bot.sendMessage(chatId, '```\n' + out + '\n```');
    } else if (r.action === 'exec') {
      const cmd = String(r.target || '').trim();
      const forbidden = /(rm |mv |find \/|npm install|pip install|sudo |apt |curl .*\|.*sh|wget .*\|)/;
      if (forbidden.test(cmd)) {
        bot.sendMessage(chatId, '🛑 Команда запрещена: ' + cmd.slice(0, 100));
        return;
      }
      const out = await run(cmd, 3500);
      bot.sendMessage(chatId, '```\n' + out + '\n```');
    } else {
      bot.sendMessage(chatId, '⚠️ Неизвестное действие: ' + JSON.stringify(r).slice(0, 200));
    }
  } catch (e) {
    bot.sendMessage(chatId, '❌ ' + e.message.slice(0, 300));
  }
});



// ============ Приём фото → OCR → ответ ============
// 16.09: скрин → Telegram → GigaChat Vision → текст

// ============ Фото/Document → OCR (через message) ============
// 16.09: node-telegram-bot-api перехватывает message раньше photo,
// поэтому фото ловим ЗДЕСЬ, а не в bot.on('photo')
async function handlePhoto(msg) {
  console.log('[handlePhoto] START chatId=' + msg.chat.id + ' hasPhoto=' + !!msg.photo + ' hasDoc=' + !!msg.document);
  const chatId = msg.chat.id;
  const fileId = msg.photo
    ? msg.photo[msg.photo.length - 1].file_id
    : (msg.document ? msg.document.file_id : null);
  if (!fileId) { console.log('[handlePhoto] NO fileId, return'); return; }

  bot.sendMessage(chatId, '👁️ Смотрю скрин...').catch(()=>{});

  try {
    const https = require('https');
    const fs = require('fs');
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const base = 'https://tg-proxy.ishidin.workers.dev';

    // 1. getFile
    const fileInfo = await new Promise((resolve, reject) => {
      https.get(`${base}/bot${token}/getFile?file_id=${fileId}`, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    if (!fileInfo.ok) throw new Error('getFile: ' + JSON.stringify(fileInfo).slice(0, 200));

    // 2. Скачать
    const localPath = '/tmp/tg_photo_' + Date.now() + '.jpg';
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(localPath);
      https.get(`${base}/file/bot${token}/${fileInfo.result.file_path}`, (res) => {
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    });

    // 3. GigaChat Vision (16.09) — 95% точности
    const giga = require('./sensors/gigachat_adapter');
    let result = '';
    try {
      const vision = await giga.analyze(localPath, msg.caption || 'Распознай весь текст на изображении. Если это код или терминал — верни код/вывод дословно. Если это фото — опиши что на нём.');
      result = typeof vision === 'string' ? vision : (vision.text || JSON.stringify(vision));
      console.log('[handlePhoto] GigaChat Vision OK');
    } catch (e) {
      // Fallback на Tesseract
      console.log('[handlePhoto] GigaChat Vision fail: ' + e.message.slice(0, 100) + ' → fallback Tesseract');
      const ocr = require('./sensors/ocr_engine');
      const ocrResult = await ocr.extract(localPath, { lang: 'rus+eng', psm: 6 });
      result = typeof ocrResult === 'string' ? ocrResult : (ocrResult.text || JSON.stringify(ocrResult));
    }

    // 16.09: фильтр мусора — Tesseract добавляет спецсимволы и одиночные знаки
    result = result
      .replace(/[\uFFFD]+/g, '')                       // неизвестные символы
      .replace(/[\u2000-\u206F]+/g, ' ')             // типографские символы
      .replace(/[№@©®™«»„""''`·•▪▫◦]+/g, ' ')        // пунктуационный шум
      .replace(/\b[a-zA-Zа-яА-Я]\b/g, '')            // одиночные буквы (рус/лат)
      .replace(/[ \t]+/g, ' ')                          // множественные пробелы
      .replace(/\n\s*\n/g, '\n')                       // пустые строки
      .trim();

    // Отсечь мусор
    if (result.length < 20) {
      result = '📷 На фото не распознан текст (только изображение).';
    }

    console.log('[handlePhoto] OCR length=' + result.length + ' preview=' + result.slice(0, 100).replace(/\n/g, ' '));

    bot.sendMessage(chatId, '📄 Распознано:\n\n' + result.slice(0, 3500)).catch(()=>{});
  } catch (e) {
    console.log('[handlePhoto] ERROR: ' + e.message + ' | stack: ' + (e.stack || '').slice(0, 200));
    bot.sendMessage(chatId, '❌ Ошибка OCR: ' + e.message.slice(0, 300)).catch(()=>{});
  }
}

console.log('🚀 AI-1 Pult запущен');
console.log('   Команды: /start для списка');
