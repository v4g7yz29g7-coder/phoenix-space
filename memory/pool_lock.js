// pool_lock.js — файл-лок для tasks_night_pool.json
// Один writer в момент времени. Второй ждёт.
'use strict';
const fs = require('fs');
const path = require('path');
const LOCK_FILE = path.join(__dirname, '..', '.pool.lock');
const TIMEOUT_MS = 30000;  // 30 сек ожидания
const STALE_MS = 60000;    // 60 сек — старый лок снимаем

function acquire() {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      // Эксклюзивное создание
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Проверяем владельца
      try {
        const stat = fs.statSync(LOCK_FILE);
        const age = Date.now() - stat.mtimeMs;
        if (age > STALE_MS) {
          // Старый лок — снимаем
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
        const owner = parseInt(fs.readFileSync(LOCK_FILE, 'utf8'));
        try { process.kill(owner, 0); } catch (killErr) {
          // Владелец мёртв — снимаем
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch (statErr) { /* тихо */ }
      // Ждём 200-500 мс
      const wait = 200 + Math.floor(Math.random() * 300);
      const until = Date.now() + wait;
      while (Date.now() < until) { /* busy wait */ }
    }
  }
  return false;
}

function release() {
  try { fs.unlinkSync(LOCK_FILE); } catch (e) {}
}

function withLock(fn) {
  if (!acquire()) throw new Error('pool_lock: timeout');
  try { return fn(); }
  finally { release(); }
}

module.exports = { acquire, release, withLock, LOCK_FILE };
