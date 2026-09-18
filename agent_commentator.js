require('dotenv').config({ path: __dirname + '/.env' });
// agent_commentator.js — Комментатор гонок
const fs = require('fs');
const path = require('path');
const { askDeepSeekChat } = require('./llm_client');

// Радио-клиент
let radioSocket = null;
try {
  const ioClient = require('socket.io-client');
  radioSocket = ioClient('http://localhost:3020');
  radioSocket.on('connect', () => log('📻 Радио: подключено'));
  radioSocket.on('disconnect', () => log('📻 Радио: отключено'));
} catch (e) {
  log('⚠️ socket.io-client не установлен: ' + e.message);
}


const PATTERNS_DIR = '/home/ishidin/phoenix/memory/patterns';
const LOG = '/home/ishidin/phoenix/logs/commentator.log';

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

async function commentRace(raceFile) {
  try {
    const data = JSON.parse(fs.readFileSync(raceFile, 'utf8'));
    if (data.type !== 'race') return;

    // Формируем промпт для комментатора
    const prompt = `Ты — спортивный комментатор гонок AI-агентов. Кратко (1-2 предложения) опиши результат:

Задача: ${(data.task || '').slice(0, 100)}
Победитель: ${data.winner}
Score: ${data.winner_score}
Время: ${data.winner_time}ms
Всего боксов: ${(data.results || []).length}
P2P: ${data.p2p ? 'скиллов передано ' + (data.p2p.skills_copied || 0) : 'нет'}

Стиль: живой, эмоциональный, как в Формуле-1.`;

    const comment = await askDeepSeekChat([
      { role: 'system', content: 'Ты — комментатор гонок. Отвечай кратко и эмоционально.' },
      { role: 'user', content: prompt }
    ], 200);

    log('🏁 ' + comment.trim());

    // Отправляем в радио
    if (radioSocket && radioSocket.connected) {
      radioSocket.emit('radio:event', {
        type: 'comment',
        text: comment.trim(),
        race_id: data.race_id,
        winner: data.winner,
        score: data.winner_score,
        time_ms: data.winner_time,
        boxes: (data.results || []).length,
        ts: Date.now()
      });
    }
    return comment.trim();
  } catch (e) {
    log('⚠️ Ошибка: ' + e.message);
    return null;
  }
}

// Слушаем новые race-паттерны
function watchPatterns() {
  log('🎙️ Комментатор запущен. Следим за ' + PATTERNS_DIR);
  let seen = new Set(fs.readdirSync(PATTERNS_DIR));

  setInterval(async () => {
    try {
      const files = fs.readdirSync(PATTERNS_DIR).filter(f => f.startsWith('race_') && f.endsWith('.json'));
      for (const f of files) {
        if (!seen.has(f)) {
          seen.add(f);
          const fullPath = path.join(PATTERNS_DIR, f);
          setTimeout(() => commentRace(fullPath), 2000);
        }
      }
    } catch (e) {}
  }, 10000);
}

if (require.main === module) {
  watchPatterns();
}

module.exports = { commentRace, watchPatterns };
