// Гонка боксов. Безопасный запуск через _runner.js
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const fs = require('fs');
const path = require('path');

// === 3D ARENA BROADCAST ===
let socket3D = null;
const COLORS3D = ['#4dd0ff', '#ff7eb6', '#a855f7', '#6eff8b', '#ffd700', '#ff5c5c', '#7dd3fc', '#fb923c'];
try {
  const ioClient = require('socket.io-client');
  socket3D = ioClient('http://127.0.0.1:3020', {
    timeout: 3000,
    reconnection: false,
    transports: ['polling', 'websocket'],
  });
  socket3D.on('connect', () => console.log('🎮 3D: подключено к арене'));
  socket3D.on('connect_error', (e) => console.log('🎮 3D ERROR:', e.message));
} catch (e) {
  console.log('🎮 3D: socket.io-client недоступен (' + e.message + ')');
}

function emit3D(event, data) {
  try {
    // socket.io-client сам буферизует emit'ы до подключения
    if (socket3D) {
      socket3D.emit(event, data);
      console.log('🎮 3D emit:', event, JSON.stringify(data).slice(0, 80));
    }
  } catch (e) { /* тихо */ }
}

const TASK = process.env.RACE_TASK || 'Прочитай KNOWLEDGE.md и скажи, сколько там строк. Ничего не меняй.';
const BOXES = (process.env.RACE_BOXES || 'agent_1,agent_2,agent_3').split(',');
const RACE_ID = process.env.RACE_ID_DIRECTED || ('race_' + Date.now());

// === ПОЛИФОНИЯ (Бахтин, POLY-1) ===
// Каждому агенту — свой голос (RACE_TASK). Логика голосов живёт в отдельном
// чистом модуле polyphony.js (его покрывают тесты tests/polyphony.test.js).
// Источники голосов, в порядке приоритета:
//   1) env  RACE_TASKS_BY_BOX — JSON {"agent_4":"...", "agent_5":"...", "*":"..."}
//   2) файл RACE_VOICES_FILE  — та же карта голосов в файле
//   3) RACE_POLYPHONIC=1      — автоназначение уникальных задач из пула
// Фолбэк: единый RACE_TASK для всех, кому не назначена персональная задача.
let polyphony = null;
try {
  polyphony = require('./polyphony');
} catch (e) {
  console.error('⚠️  polyphony.js недоступен — работаю на общем RACE_TASK (' + e.message + ')');
}

// Пул задач читаем только в явном полифоническом режиме (opt-in, 0 риска).
let POLY_POOL = null;
if (polyphony && String(process.env.RACE_POLYPHONIC) === '1') {
  try {
    POLY_POOL = JSON.parse(fs.readFileSync('tasks_night_pool.json', 'utf8'));
  } catch (e) {
    console.error('⚠️  RACE_POLYPHONIC: пул задач недоступен (' + e.message + ')');
  }
}

const VOICES = polyphony
  ? polyphony.buildVoices({
      raw: process.env.RACE_TASKS_BY_BOX,
      file: process.env.RACE_VOICES_FILE,
      boxes: BOXES,
      pool: POLY_POOL,
    })
  : { tasks: {}, source: 'none', wildcard: false, used: [] };

// Голос каждого бокса: персональный, а если нет — общий RACE_TASK.
const TASKS_BY_BOX = VOICES.tasks;
function taskForBox(box) {
  return TASKS_BY_BOX[box] || TASK;
}
// === ФАЙЛ-ЛОК: только один race.js за раз ===
// 16.09: lock на каждый RACE_ID — параллельные гонки
// Один RACE_ID — не запускается дважды (защита)
// Разные RACE_ID — работают параллельно
const RACE_LOCK = `/tmp/phoenix_race_${process.env.RACE_ID_DIRECTED || process.pid}.lock`;
async function acquireRaceLock() {
  const start = Date.now();
  const TIMEOUT_MS = 60 * 1000;  // 60 секунд
  const MAX_PARALLEL = 8;              // 16.09: не больше 8 race одновременно
  while (Date.now() - start < TIMEOUT_MS) {
    // 16.09: проверка лимита параллельных
    try {
      const locks = fs.readdirSync('/tmp').filter(f => f.startsWith('phoenix_race_') && f.endsWith('.lock'));
      if (locks.length >= MAX_PARALLEL) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
    } catch (e) {}
    
    try {
      const fd = fs.openSync(RACE_LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      // Убираем лок при выходе
      const cleanup = () => { try { fs.unlinkSync(RACE_LOCK); } catch (e) {} };
      process.on('exit', cleanup);
      process.on('SIGINT', () => { cleanup(); process.exit(1); });
      process.on('SIGTERM', () => { cleanup(); process.exit(1); });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Проверяем жив ли владелец
      try {
        const owner = parseInt(fs.readFileSync(RACE_LOCK, 'utf8'));
        process.kill(owner, 0);
      } catch (killErr) {
        try { fs.unlinkSync(RACE_LOCK); } catch (e2) {}
        continue;
      }
      // Ждём 500мс (async, не жжёт CPU)
      await new Promise(r => setTimeout(r, 500));
    }
  }
  console.error('❌ race.js: не дождался лока за 5 минут');
  process.exit(1);
}

const RACE_DIR = 'memory/races';
fs.mkdirSync(RACE_DIR, { recursive: true });

console.log('🏁 ГОНКА:', RACE_ID);
console.log('Задача:', TASK);
console.log('Боксы:', BOXES.join(', '));
// ПОЛИФОНИЯ: печатаем персональные голоса, если они назначены
if (Object.keys(TASKS_BY_BOX).length > 0) {
  console.log('🎼 Полифония (' + VOICES.source + '): у каждого голоса своя партия');
  const voiceLines = polyphony
    ? polyphony.describeVoices(BOXES, TASKS_BY_BOX)
    : BOXES.map((b) => b + ' → ' + String(taskForBox(b)).slice(0, 120));
  for (const line of voiceLines) console.log('   ' + line);
}
console.log('');

// 3D: старт гонки
emit3D('race:start', {
  race_id: RACE_ID,
  task: TASK,
  agents: BOXES.map((name, i) => ({
    name,
    color: COLORS3D[i % COLORS3D.length],
    avatar: 'cube',
    task: taskForBox(name),
  })),
});

// === КРУГИ / LAP COUNTER (Sprint 2): 1 задача = 1 круг ===
const TOTAL_LAPS = parseInt(process.env.RACE_LAPS || '3', 10);
const results = [];
const laps = {}; // box -> кол-во пройденных кругов

// Позиции всех болидов (с полями lap / progress) для UI
function buildPositions(currentBox) {
  return BOXES.map((b) => {
    const r = results.find((x) => x.box === b);
    const lap = laps[b] || 0;
    // Результат важнее статуса «текущий»: после финиша агент = done/failed
    if (r) {
      return { agent: b, progress: r.ok ? 0.95 : 0.15, status: r.ok ? 'done' : 'failed', lap, total_laps: TOTAL_LAPS };
    }
    if (b === currentBox) {
      return { agent: b, progress: 0.5, status: 'running', lap, total_laps: TOTAL_LAPS };
    }
    return { agent: b, progress: 0, status: 'idle', lap, total_laps: TOTAL_LAPS };
  });
}

function emitTick(currentBox) {
  emit3D('race:tick', {
    race_id: RACE_ID,
    total_laps: TOTAL_LAPS,
    positions: buildPositions(currentBox),
  });
}

// После каждой задачи: agent.lap += 1. Обгон на круг → race:overtake
function registerLap(box) {
  laps[box] = (laps[box] || 0) + 1;
  for (const other of BOXES) {
    if (other === box) continue;
    const gap = (laps[box] || 0) - (laps[other] || 0);
    if (gap >= 1) {
      emit3D('race:overtake', {
        race_id: RACE_ID,
        by: box,
        on: other,
        lap: laps[box],
        gap,
      });
    }
  }
}


// === spawnBox: запуск бокса с process group + kill-tree ===
// Причина (14.09): execAsync убивал только sh, а node _runner.js и его
// дети (find /, grep -r) оставались сиротами → I/O-бомба.
function spawnBox(boxPath, task, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['_runner.js'], {
      cwd: boxPath,
      detached: true,                          // ← новая process group
      env: { ...process.env, BOX_NAME: path.basename(boxPath), RACE_TASK: task },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let done = false;
    const start = Date.now();

    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });

    const killTree = () => {
      try {
        process.kill(-proc.pid, 'SIGKILL');    // ← убить всю группу
      } catch (e) {
        try { proc.kill('SIGKILL'); } catch (_) {}
      }
    };

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree();
      resolve({
        stdout: out,
        error: new Error(`timeout ${timeoutMs}ms`),
        duration_ms: Date.now() - start,
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          stdout: out,
          error: new Error(`exit code ${code}`),
          duration_ms: Date.now() - start,
        });
      } else {
        resolve({ stdout: out, error: null, duration_ms: Date.now() - start });
      }
    });

    proc.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree();
      resolve({ stdout: out, error: e, duration_ms: Date.now() - start });
    });
  });
}

(async () => {
  // Захватываем lock — только один race.js за раз
  // await acquireRaceLock(); // DISABLED 17.09: race condition fix

  // Функция запуска одного бокса
  const runBox = async (box) => {
    const boxPath = path.resolve('boxes', box);
    const start = Date.now();
    const boxTask = taskForBox(box);   // ПОЛИФОНИЯ: у каждого бокса свой голос
    console.log('▶️  Запуск', box, '...' + (TASKS_BY_BOX[box] ? ' (своя задача)' : ''));

    // 3D: текущий агент — running
    emitTick(box);

    try {
      const spawnResult = await spawnBox(boxPath, boxTask, 180000);
      if (spawnResult.error && !spawnResult.stdout) {
        throw spawnResult.error;
      }
      const output = spawnResult.stdout;
      // Умный парсер: ищем JSON с конца
      const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
      let parsed = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line.startsWith('{')) continue;
        try {
          const candidate = JSON.parse(line);
          if (candidate && typeof candidate === 'object' && 'ok' in candidate) {
            parsed = candidate;
            break;
          }
        } catch (e) { /* не JSON */ }
      }
      if (!parsed) {
        const rawFile = path.join(RACE_DIR, RACE_ID + '_' + box + '_raw.log');
        try { fs.writeFileSync(rawFile, output); } catch (e) {}
        console.log('⚠️ ', box, '| JSON не найден →', rawFile);
        const duration = Date.now() - start;
        results.push({ box, task: boxTask, duration_ms: duration, ok: false, error: 'JSON not found', raw_log: rawFile });
        return { box, ok: false };
      }
      const duration = Date.now() - start;
      results.push({ box, task: boxTask, duration_ms: duration, ...parsed });
      console.log('✅', box, '|', duration + 'ms | score:', parsed.score, '| ok:', parsed.ok);

      // LAP
      registerLap(box);
      emitTick(box);

      return { box, ok: parsed.ok, score: parsed.score };
    } catch (e) {
      const duration = Date.now() - start;
      const errMsg = (e.message || '').slice(0, 200);
      // 14.09: гарантированный kill-tree — если spawnBox упал,
      // убиваем всех сирот от этого бокса
      try {
        const { execSync } = require('child_process');
        execSync('pkill -9 -f "find /" 2>/dev/null || true');
        execSync('pkill -9 -f "grep -rn" 2>/dev/null || true');
      } catch (_) {}
      results.push({ box, task: boxTask, duration_ms: duration, ok: false, error: errMsg });
      console.log('❌', box, '|', duration + 'ms | error:', errMsg.slice(0, 100));
      return { box, ok: false };
    }
  };

  // === ВЫБОР РЕЖИМА ===
  if (process.env.EARLY_STOP === 'true') {
    // Последовательно — нужен break
    console.log('🐢 Последовательный режим (EARLY_STOP)');
    for (const box of BOXES) {
      const r = await runBox(box);
      if (r.ok && r.score >= 8) {
        console.log('🛑 EARLY_STOP: ' + box + ' победил (score ' + r.score + '), остальные пропущены');
        break;
      }
    }
  } else {
    // Параллельно — все боксы одновременно
    console.log('⚡ Параллельный запуск ' + BOXES.length + ' боксов');
    await Promise.all(BOXES.map(runBox));
  }

// Вычисляем победителя ДО сохранения
const winner = results
  .filter(r => r.ok && r.score !== undefined && r.score !== null)
  .sort((a, b) => (b.score - a.score) || ((a.duration_ms || 0) - (b.duration_ms || 0)))[0];

const protocol = {
  race_id: RACE_ID,
  ts: new Date().toISOString(),
  task: TASK,
  tasks_by_box: TASKS_BY_BOX,   // ПОЛИФОНИЯ: голос каждого агента
  polyphonic: Object.keys(TASKS_BY_BOX).length > 0,
  polyphony_source: VOICES.source,   // env / file / pool / none
  winner: winner ? winner.box : null,
  winner_score: winner ? winner.score : null,
  winner_time: winner ? winner.duration_ms : null,
  results,
  p2p: null
};

// P2P: победитель делится скиллами с проигравшими
if (winner && results.length > 1 && !process.env.RACE_NO_P2P) {
  try {
    const p2p = require('./p2p_share');
    const allBoxes = results.map(r => r.box);  // ВСЕ боксы, включая победителя
    const loserBoxes = results.filter(r => r.box !== winner.box).map(r => r.box);
    const shareResult = p2p.shareSkillsFromWinner(winner.box, allBoxes);
    console.log('🔗 P2P: ' + winner.box + ' → ' + loserBoxes.join(', ') +
      ' | скиллов передано: ' + (shareResult.skills_copied || 0));
    protocol.p2p = shareResult;
  } catch (e) {
    console.error('⚠️  P2P ошибка: ' + e.message);
  }
}
// SIGTERM handler — сохранить partial results при timeout
process.on('SIGTERM', () => {
  console.log('⚠️  SIGTERM получен — сохраняю partial results');
  try {
    fs.writeFileSync(path.join(RACE_DIR, RACE_ID + '.json'), JSON.stringify(protocol, null, 2));
    console.log('📋 Partial протокол сохранён');
  } catch (e) {
    console.error('Failed to save partial:', e.message);
  }
  process.exit(0);
});

fs.writeFileSync(path.join(RACE_DIR, RACE_ID + '.json'), JSON.stringify(protocol, null, 2));

// Также пишем в memory/patterns/ — чтобы Prophet видел гонки
try {
  const patternsDir = 'memory/patterns';
  fs.mkdirSync(patternsDir, { recursive: true });

  const _winnerTmp = results
    .filter(r => r.ok && r.score)
    .sort((a, b) => (b.score - a.score) || (a.duration_ms - b.duration_ms))[0];

  const pattern = {
    ts: new Date().toISOString(),
    type: 'race',
    race_id: RACE_ID,
    task: TASK.slice(0, 200),
    boxes: BOXES,
    results: results.map(r => ({
      box: r.box,
      score: r.score,
      time: r.duration_ms,
      ok: r.ok
    })),
    winner: winner ? winner.box : null,
    winner_score: winner ? winner.score : null,
    winner_time: winner ? winner.duration_ms : null,
    winner_answer: (function() {
      // 14.09: сохраняем ответ победителя — для кэша решений
      if (!winner) return null;
      const w = results.find(r => r.box === winner.box);
      return (w && w.answer) ? String(w.answer).slice(0, 5000) : null;
    })()
  };

  const patternFile = path.join(patternsDir, 'race_' + RACE_ID.replace('race_', '') + '.json');
  fs.writeFileSync(patternFile, JSON.stringify(pattern, null, 2));
  console.log('📝 Паттерн гонки записан:', patternFile);
} catch (e) {
  console.error('⚠️  Не удалось записать паттерн гонки:', e.message);
}

// === TRAJECTORY v1 + v2 + RADIO (14.09) ===
// v1: старый trajectory_builder (путь восхождения → EverOS)
try {
  require('./trajectory_builder').publishTrajectory(RACE_ID);
  console.log('🧬 Trajectory v1: путь восхождения опубликован');
} catch (e) {
  console.error('⚠️  Trajectory v1: ' + e.message);
}

// v2: новый набор trajectory/* (timeline, insights) + radio
// 14.09: каждый модуль в своём try/catch + правильные await
try {
  const pathBuilder = require('./trajectory/path_builder');
  const paths = pathBuilder.buildAll([RACE_ID]);
  const n = Array.isArray(paths) ? paths.length : (paths ? 1 : 0);
  console.log(`📊 Trajectory v2: ${n} путей`);
    // writeReport: no-op (функция отсутствует)
} catch (e) { console.error('⚠️ Trajectory v2: ' + e.message); }

try {
  const insightExtractor = require('./trajectory/insight_extractor');
  // extractFromRace возвращает Promise — нужно await
  const insights = await insightExtractor.extractFromRace(RACE_ID);
  const n = Array.isArray(insights) ? insights.length : 0;
  console.log(`💡 Insights: ${n}`);
} catch (e) { console.error('⚠️ Insights: ' + e.message); }

try {
  const radioWriter = require('./radio/radio_writer');
  const winnerBox = winner ? winner.box : null;
  if (winnerBox) {
    const comment = await radioWriter.comment('race_finish', {
      winner: winnerBox,
      score: winner.score,
      task: TASK.slice(0, 100),
    });
    if (comment) console.log(`📻 Radio: "${comment}"`);
  }
} catch (e) { console.error('⚠️ Radio: ' + e.message); }

try {
  const dramaDetector = require('./radio/drama_detector');
  const drama = dramaDetector.detectDrama({ positions: results });
  if (Array.isArray(drama) && drama.length) {
    console.log(`🎭 Драма: ${drama.map(d => d.type || '?').join(', ')}`);
  }
} catch (e) { console.error('⚠️ Драма: ' + e.message); }

console.log('');
console.log('🏆 РЕЗУЛЬТАТЫ:');
results.forEach(r => {
  console.log(' ', r.box, '| score:', r.score || 'n/a', '| time:', r.duration_ms + 'ms', '| ok:', r.ok);
});

// (_w — дубль winner, удалён 14.09)

if (winner) {
  console.log('');
  console.log('🥇 ПОБЕДИТЕЛЬ:', winner.box, '(score:', winner.score + ', time:', winner.duration_ms + 'ms)');

  // Обогащаем EverOS: пишем результат гонки в память
  try {
    const everos = require('./everos_client');
    const summary = 'RACE ' + RACE_ID + ': task="' + TASK.slice(0, 150) + '" winner=' + winner.box +
      ' score=' + winner.score + ' time=' + winner.duration_ms + 'ms. Results: ' +
      results.map(r => r.box + '=' + (r.score || 'FAIL')).join(', ');
    everos.addMemory(summary, RACE_ID).then(() => everos.flushMemory(RACE_ID)).catch(() => {});
    console.log('📚 Результат записан в EverOS');
  } catch (e) {
    console.error('⚠️  EverOS:', e.message);
  }
}
console.log('');
console.log('📋 Протокол:', path.join(RACE_DIR, RACE_ID + '.json'));

// 3D: финал
emit3D('race:finish', {
  race_id: RACE_ID,
  winner: winner ? winner.box : null,
  results: results.map(r => ({
    agent: r.box,
    time_ms: r.duration_ms,
    score: r.score || 0,
    ok: !!r.ok,
  })),
});

// Даём 500мс на доставку и закрываем
setTimeout(() => {
  try { if (socket3D) { console.log('🎮 3D: закрываю соединение'); socket3D.close(); } } catch (e) {}
}, 2000);

})(); // конец async IIFE
