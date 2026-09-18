// oracle_loop.js — Оракул следит за гонками и даёт подсказки в реальном времени
const fs = require('fs');
const path = require('path');
const ioClient = require('socket.io-client');

const ROADMAP = path.join(__dirname, 'arena_roadmap.json');

let socket = null;
try {
  socket = ioClient('http://127.0.0.1:3020', {
    transports: ['polling'],
    reconnection: true,
  });
  socket.on('connect', () => console.log('🔮 Oracle Loop: подключён'));
} catch (e) {
  console.error('Oracle Loop: ошибка подключения', e.message);
}

// Следим за событиями гонок
if (socket) {
  socket.on('race:start', (data) => {
    console.log(`🔮 Oracle Loop: гонка стартовала ${data.race_id}`);
    
    // Определяем stage из task
    const taskText = data.task || '';
    const stageMatch = taskText.match(/ЗАДАЧА\s+(\d+)\./);
    if (!stageMatch) return;
    
    const stageId = 'stage_' + stageMatch[1];
    
    // Даём подсказку всем
    const KNOWLEDGE = {
      'stage_2': {
        approach: 'Reference: research/racing-game/src/models/vehicle/. Vehicle.tsx — точка входа.',
        hint: 'Адаптируй код, не копируй. Используй @react-three/cannon.',
        reference: 'research/racing-game/src/models/vehicle/Vehicle.tsx',
      },
      'stage_3': {
        approach: 'Reference: research/racing-game/src/effects/Cameras.tsx.',
        hint: 'Расширь 3 камеры до 6. Добавь helicam, trackside, finishline.',
        reference: 'research/racing-game/src/effects/Cameras.tsx',
      },
      'stage_4': {
        approach: 'Кинематография через useFrame + lerp.',
        hint: 'Начни с простой сцены в боксах.',
        reference: 'arena_lab/src/scene/PitLane.tsx',
      },
      'stage_6': {
        approach: 'AuthGate уже готов. Добавляй компоненты рядом.',
        hint: 'JWT — на бэкенде web/server.js.',
        reference: 'web/server.js',
      },
      'stage_7': {
        approach: 'Схема: parts.json, builds.json. API: /api/parts, /api/builds.',
        hint: 'Комиссия 30% на бэкенде.',
        reference: 'web/server.js',
      },
      'stage_8': {
        approach: 'CloudPayments — виджет на лендинг.',
        hint: 'Сначала договор-оферта, потом оплата.',
        reference: 'web/public/landing.html',
      },
    };
    
    const k = KNOWLEDGE[stageId];
    if (k) {
      socket.emit('p2p:oracle_hint', {
        task_id: stageMatch[1],
        stage: stageId,
        approach: k.approach,
        hint: k.hint,
        reference: k.reference,
        ts: Date.now(),
      });
      console.log(`🔮 Oracle Loop: подсказка для ${stageId}`);
    }
  });
  
  socket.on('race:finish', (data) => {
    console.log(`🔮 Oracle Loop: гонка ${data.race_id} завершена | winner: ${data.winner}`);
  });
  
  socket.on('flag:event', (data) => {
    console.log(`🔮 Oracle Loop: флаг ${data.flag} (${data.agent || 'общий'})`);
  });
}

// Heartbeat каждые 30 сек — статистика
setInterval(() => {
  if (!fs.existsSync(ROADMAP)) return;
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  const all = d.stages.flatMap(s => s.tasks);
  const completed = all.filter(t => t.status === 'completed').length;
  const inProgress = all.filter(t => t.status === 'in_progress').length;
  const failed = all.filter(t => t.status === 'failed').length;
  console.log(`📊 Прогресс: ${completed}/${all.length} | В работе: ${inProgress} | Провалено: ${failed}`);
}, 30000);

console.log('🔮 Oracle Loop запущен. Следим за гонками.');
