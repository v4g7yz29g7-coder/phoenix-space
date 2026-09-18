'use strict';
// apply_worker.js — раз в 5 минут запускает apply()
const { apply } = require('./apply');

const INTERVAL_MS = 5 * 60 * 1000; // 5 минут

function log(msg) {
  const line = `[${new Date().toISOString()}] [apply_worker] ${msg}`;
  console.log(line);
}

async function tick() {
  try {
    log('Проверка...');
    const r = apply();
    if (r.ok) log('✅ Внедрено: ' + r.file);
    else log('— нет нового: ' + r.reason);
  } catch (e) {
    log('❌ Ошибка: ' + e.message.slice(0, 100));
  }
}

tick();
setInterval(tick, INTERVAL_MS);
