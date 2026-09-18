// oracle_agent.js — Мета-наставник. Знает подходы, проверяет решаемость.
const fs = require('fs');
const path = require('path');
const ioClient = require('socket.io-client');

let socket = null;
try {
  socket = ioClient('http://127.0.0.1:3020', {
    transports: ['polling'],
    reconnection: true,
  });
  socket.on('connect', () => console.log('🔮 Оракул подключён к арене'));
} catch (e) { /* тихо */ }

// === БАЗА ЗНАНИЙ ОРАКУЛА ===
const KNOWLEDGE = {
  'stage_2': {
    name: 'Киберпанк-кар',
    approach: 'Начни с research/racing-game/src/models/vehicle/. Vehicle.tsx — точка входа. Используй @react-three/cannon.',
    hint: 'Физику бери из reference, но адаптируй под наш проект. Не копируй 1-в-1.',
    reference: 'research/racing-game/src/models/vehicle/Vehicle.tsx',
  },
  'stage_3': {
    name: 'Трассы + ТВ',
    approach: 'Смотри research/racing-game/src/effects/Cameras.tsx. Там 3 камеры — расширь до 6.',
    hint: 'Арену уже сделали. Работай только с камерами и трассой.',
    reference: 'research/racing-game/src/effects/Cameras.tsx',
  },
  'stage_4': {
    name: 'Cinematic Intro',
    approach: 'Используй useFrame + time.lerp для плавных переходов. Образец — PitLane.tsx.',
    hint: 'Начни с простой сцены в боксах, потом добавляй выезд.',
    reference: 'arena_lab/src/scene/PitLane.tsx',
  },
  'stage_6': {
    name: 'Платформа',
    approach: 'AuthGate уже готов. Добавляй новые компоненты рядом.',
    hint: 'JWT — на бэкенде web/server.js, не в React.',
    reference: 'web/server.js',
  },
  'stage_7': {
    name: 'Маркетплейс',
    approach: 'Схема: parts.json, builds.json. API: /api/parts, /api/builds.',
    hint: 'Комиссия 30% — на бэкенде. UI — React-компоненты.',
    reference: 'web/server.js',
  },
  'stage_8': {
    name: 'Монетизация',
    approach: 'CloudPayments — виджет на лендинг. Подписки — рекуррентные.',
    hint: 'Сначала договор-оферта, потом оплата.',
    reference: 'web/public/landing.html',
  },
};

// === ПРОВЕРКА РЕШАЕМОСТИ ===
function checkSolvable(task) {
  const stage = task.id.split('.')[0];
  const stageId = 'stage_' + stage;
  const knowledge = KNOWLEDGE[stageId];
  
  if (!knowledge) {
    return { ok: false, reason: 'Нет знаний о stage' };
  }
  
  // Проверяем, что reference существует
  const refPath = path.join(__dirname, knowledge.reference);
  const refExists = fs.existsSync(refPath);
  
  return {
    ok: true,
    knowledge,
    reference_exists: refExists,
  };
}

// === ПОДСКАЗКА (P2P) ===
function giveHint(task) {
  const stage = task.id.split('.')[0];
  const knowledge = KNOWLEDGE['stage_' + stage];
  
  if (!knowledge || !socket) return null;
  
  const hint = {
    type: 'oracle_hint',
    task_id: task.id,
    stage: knowledge.name,
    approach: knowledge.approach,
    hint: knowledge.hint,
    reference: knowledge.reference,
    ts: Date.now(),
  };
  
  socket.emit('p2p:oracle_hint', hint);
  console.log(`🔮 Оракул: подсказка для ${task.id}`);
  return hint;
}

// === API ===
module.exports = { checkSolvable, giveHint, KNOWLEDGE };

// === CLI ===
if (require.main === module) {
  const taskId = process.argv[2] || '2.1';
  const task = { id: taskId, title: 'Test' };
  
  console.log('🔮 Оракул: проверяю', taskId);
  const check = checkSolvable(task);
  console.log(JSON.stringify(check, null, 2));
  
  setTimeout(() => {
    giveHint(task);
    setTimeout(() => process.exit(0), 500);
  }, 500);
}
