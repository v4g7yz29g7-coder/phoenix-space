// flag_marshal.js — маршал трассы. Публикует флаги для 3D-арены.
const ioClient = require('socket.io-client');

const SOCKET_URL = 'http://127.0.0.1:3020';

let socket = null;
let connected = false;

function connect() {
  if (socket) return;
  socket = ioClient(SOCKET_URL, {
    timeout: 3000,
    reconnection: true,
    transports: ['polling', 'websocket'],
  });
  socket.on('connect', () => {
    connected = true;
    console.log('🚩 flag_marshal: подключён к арене');
  });
  socket.on('connect_error', () => { connected = false; });
  socket.on('disconnect', () => { connected = false; });
}

// Типы флагов + их смысл
const FLAGS = {
  green:  { emoji: '🟢', label: 'GREEN',  msg: 'Трасса свободна. Гонка идёт.' },
  yellow: { emoji: '🟡', label: 'YELLOW', msg: 'Осторожно! Инцидент на трассе.' },
  blue:   { emoji: '🔵', label: 'BLUE',   msg: 'Пропусти лидера.' },
  red:    { emoji: '🔴', label: 'RED',    msg: 'СТОП! Гонка остановлена.' },
  finish: { emoji: '🏁', label: 'FINISH', msg: 'Финиш!' },
};

function raise(flagType, payload = {}) {
  connect();
  const flag = FLAGS[flagType];
  if (!flag) {
    console.log(`⚠️ flag_marshal: неизвестный флаг ${flagType}`);
    return;
  }
  const event = {
    type: 'flag',
    flag: flagType,
    emoji: flag.emoji,
    label: flag.label,
    msg: flag.msg,
    race_id: payload.race_id || null,
    agent: payload.agent || null,
    reason: payload.reason || null,
    ts: Date.now(),
  };
  if (socket && connected) {
    socket.emit('flag:event', event);
  }
  console.log(`${flag.emoji} FLAG ${flag.label}` + (payload.agent ? ` → ${payload.agent}` : '') + (payload.reason ? ` (${payload.reason})` : ''));
}

// Хелперы
const green    = (race_id) => raise('green',    { race_id });
const yellow   = (race_id, agent, reason) => raise('yellow', { race_id, agent, reason });
const blue     = (race_id, agent) => raise('blue',     { race_id, agent });
const red      = (race_id, agent, reason) => raise('red',      { race_id, agent, reason });
const finish   = (race_id, agent) => raise('finish',   { race_id, agent });

module.exports = { raise, green, yellow, blue, red, finish, connect };

// CLI-режим для теста
if (require.main === module) {
  const flag = process.argv[2] || 'green';
  const agent = process.argv[3] || null;
  const reason = process.argv[4] || null;
  connect();

  const trySend = (attempt) => {
    if (socket && connected) {
      raise(flag, { agent, reason, race_id: 'test_' + Date.now() });
      setTimeout(() => process.exit(0), 500);
    } else if (attempt < 20) {
      setTimeout(() => trySend(attempt + 1), 200);
    } else {
      console.log('⚠️ flag_marshal: не удалось подключиться за 4 сек');
      process.exit(1);
    }
  };
  trySend(0);
}
