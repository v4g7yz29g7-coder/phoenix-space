// race_director.js — Гоночный директор. Управляет гонкой из Race Control.
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const flags = require('./flag_marshal');
const ioClient = require('socket.io-client');

let directorSocket = null;
try {
  directorSocket = ioClient('http://127.0.0.1:3020', {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5,
    timeout: 2000,
  });
} catch (e) { /* тихо */ }

function emitP2P(event, data) {
  try {
    if (directorSocket) directorSocket.emit(event, data);
  } catch (e) { /* тихо */ }
}

// === LIVE: трансляция событий гонки в WebSocket-канал 'race:live' ===
// Формат: { race_id, ts, type, data }
function emitLive(type, data) {
  try {
    if (directorSocket) {
      directorSocket.emit('race:live', {
        race_id: state.race_id,
        ts: Date.now(),
        type,
        data: data || {},
      });
    }
  } catch (e) { /* тихо */ }
}

// === race:live — единый канал телеметрии гонки ===
// На каждое событие (start | tick | overtake | finish) шлём в сокет
// объект единого формата: { race_id, ts, type, data }.
// socket.io-client буферизует emit'ы до подключения, поэтому события
// не теряются, даже если соединение устанавливается асинхронно.
function emitLive(type, data = {}) {
  try {
    if (!directorSocket) return;
    const payload = {
      race_id: state.race_id || (data && data.race_id) || null,
      ts: Date.now(),
      type,
      data: (data && typeof data === 'object') ? data : { value: data },
    };
    directorSocket.emit('race:live', payload);
    console.log(`📡 race:live → ${type} (${payload.race_id})`);
  } catch (e) { /* тихо */ }
}

// === 📻 РАДИО: подключаем race_commentator_v2 ===
// На каждое событие гонки (start | overtake | finish) комментатор генерирует
// короткую фразу через radio_writer и публикует её в канал 'race:radio'.
// Мы используем существующий API: onTick() и onOvertake(). Фразы печатаются
// в лог директора строкой «📻 Radio …».
let commentator = null;
try {
  commentator = require('./radio/race_commentator_v2');
  if (commentator && typeof commentator.on === 'function') {
    commentator.on('race:radio', (packet) => {
      const text = packet && packet.text ? packet.text : '';
      const reason = (packet && (packet.reason || packet.event)) || 'event';
      console.log(`📻 Radio [${reason}]: ${text}`);
    });
    commentator.on('error', () => { /* тихо */ });
  }
} catch (e) {
  commentator = null;
}

// Публикует событие гонки в комментатор. emitter-like API: radio(event, data).
function radio(event, data = {}) {
  try {
    if (!commentator) return;
    const raceId = (state && state.race_id) || data.race_id || null;
    if (event === 'overtake') {
      if (typeof commentator.onOvertake === 'function') {
        commentator.onOvertake({
          race_id: raceId,
          by: data.by || data.agent || null,
          on: data.on || data.leader || null,
          lap: data.position || data.lap || null,
          gap: data.gap || null,
        });
      }
      return;
    }
    if (event === 'finish') {
      const meta = { race_id: raceId, finish: true, reason: 'finish' };
      if (typeof commentator.say === 'function') {
        commentator.say('финиш', { победитель: data.winner || 'н/д' }, meta);
      }
      return;
    }
    // start / tick — ручной тик с текущим составом боксов
    const boxes = data.boxes || (state && state.boxes) || [];
    const positions = boxes.map((b, i) => ({
      agent: String(b),
      progress: Math.max(0.05, 1 - i * 0.1),
      status: event === 'start' ? 'running' : 'racing',
    }));
    if (typeof commentator.onTick === 'function') {
      commentator.onTick({ race_id: raceId, lap: event === 'start' ? 1 : null, positions });
    }
  } catch (e) { /* тихо */ }
}

const safety = require('./safety_car');
const oracle = require('./oracle_agent');

const ROOT = __dirname;
const RACE_DIR = path.join(ROOT, 'memory', 'races');

// Состояние активной гонки
// 16.09: глобальный state → Map activeRaces (race_id → state)
// Теперь 8 гонок параллельно — каждая со своим состоянием
const activeRaces = new Map();

// Функция — получить или создать state для race_id
function getRaceState(raceId) {
  if (!activeRaces.has(raceId)) {
    activeRaces.set(raceId, {
      race_id: raceId,
      task: null,
      boxes: [],
      started_at: null,
      status: 'idle',
      results: [],
    });
  }
  return activeRaces.get(raceId);
}

// Старый state — оставлен для совместимости (deprecated)
const state = {
  race_id: null,
  task: null,
  boxes: [],
  started_at: null,
  status: 'idle', // idle | running | yellow | red | finished
  results: [],
  finish_order: [],
  leader: null,
};

// === СТАРТ ГОНКИ ===
// === 14.09: Кэш решений — не гоняем то, что уже решено ===
function findCachedSolution(task) {
  try {
    const dir = path.join(__dirname, 'memory', 'patterns');
    if (!fs.existsSync(dir)) return null;

    // 14.09: readdirSync возвращает алфавитный порядок — сортируем по mtime DESC
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.json') && f.startsWith('race_'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 500);

    const normTask = String(task || '').trim().toLowerCase();

    // 15.09: порог 9 → 7 (критика часто ставит 7-8 за адекватные ответы)
    // + проверка длины answer >= 200 (отсечь короткие заготовки)
    for (const { f } of files) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!p.task || !p.winner_answer) continue;
        if (typeof p.winner_answer !== 'string') continue;
        if (p.winner_answer.length < 200) continue;
        const pTask = String(p.task).trim().toLowerCase();
        if (pTask === normTask && (p.winner_score || 0) >= 7) {
          return p;
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) {}
  return null;
}

async function startRace({ boxes, task, timeout_sec = 600 }) {
  // 14.09: проверка кэша перед запуском
  const cached = findCachedSolution(task);
  if (cached) {
    console.log(`[cache] ✅ Кэш-хит: task уже решался (winner ${cached.winner}, score ${cached.winner_score})`);
    const cachedRaceId = 'cached_' + Date.now();
    emitLive('start', { task, boxes, cached: true, race_id: cachedRaceId });
    emitLive('finish', { winner: cached.winner, cached: true, race_id: cachedRaceId });
    return {
      race_id: cachedRaceId,
      winner: cached.winner,
      answer: cached.winner_answer,
      results: cached.results,
      cached: true,
      duration_sec: 0,
    };
  }

  // 16.09: проверка только для ЭТОГО race_id
  const raceId = process.env.RACE_ID_DIRECTED || ('race_' + Date.now());
  const myState = getRaceState(raceId);
  
  if (myState.status === 'running') {
    throw new Error('Race already running: ' + state.race_id);
  }

  state.race_id = 'race_' + Date.now();
  state.task = task;
  state.boxes = boxes;
  state.started_at = Date.now();
  myState.status = 'running';
  myState.started_at = new Date().toISOString();
  state.results = [];
  state.p2p_shared = false;
  state.finish_order = [];
  state.leader = null;

  emitLive('start', { task, boxes, timeout_sec, started_at: state.started_at });

  // 📻 Radio: старт гонки
  radio('start', { task, boxes, race_id: state.race_id });

  console.log(`🏎️ FORMULA I1 CONTROL: старт ${state.race_id}`);
  console.log(`   Задача: ${task.slice(0, 60)}`);
  console.log(`   Боксы: ${boxes.join(', ')}`);

  // 🔮 Оракул: проверка решаемости + подсказка
  try {
    const check = oracle.checkSolvable({ id: 'stage_' + task.slice(0, 1), title: task.slice(0, 60) });
    if (check.ok) {
      oracle.giveHint({ id: 'stage_' + task.slice(0, 1) });
    }
  } catch (e) { /* тихо */ }

  // 🟢 Зелёный флаг — гонка разрешена
  flags.green(state.race_id);

  // 📡 race:live — событие старта гонки
  emitLive('start', {
    task,
    boxes,
    timeout_sec,
    started_at: state.started_at,
  });

  // 🚗 Запускаем Safety Car
  safety.watchRace(state.race_id);

  // Запускаем race.js в отдельном процессе
  const proc = spawn('node', ['race.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      RACE_BOXES: boxes.join(','),
      RACE_TASK: task,
      RACE_ID_DIRECTED: state.race_id,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', (d) => {
    output += d.toString();
    // 📡 race:live — tick: прогресс гонки в реальном времени
    const chunk = d.toString();
    if (chunk.trim()) {
      emitLive('tick', {
        elapsed_ms: state.started_at ? (Date.now() - state.started_at) : 0,
        status: state.status,
        tail: chunk.trim().split('\n').pop().slice(0, 200),
      });
    }
    // Парсим прогресс в реальном времени
    const lines = d.toString().split('\n');
    for (const line of lines) {
      if (line.includes('▶️  Запуск')) {
        const m = line.match(/Запуск\s+(\S+)/);
        if (m) console.log(`   ▶️ ${m[1]}`);
      }
      if (line.includes('✅')) {
        const m = line.match(/✅\s+(\S+)/);
        if (m) {
          console.log(`   ✅ ${m[1]} финишировал`);
          safety.reportActivity(m[1]);

          // 📡 LIVE: обгон / распределение позиций по мере финиша
          state.finish_order.push(m[1]);
          if (state.finish_order.length === 1) {
            state.leader = m[1];
          } else {
            emitLive('overtake', {
              agent: m[1],
              position: state.finish_order.length,
              leader: state.leader,
              finish_order: [...state.finish_order],
            });
            // 📻 Radio: обгон/смена позиции
            radio('overtake', {
              by: m[1],
              on: state.leader,
              position: state.finish_order.length,
              race_id: state.race_id,
            });
          }

          // 🟦 P2P: первый финишировавший = лидер, делится подходом
          if (!state.p2p_shared) {
            state.p2p_shared = true;
            const allBoxes = state.boxes;
            const recipients = allBoxes.filter(b => b !== m[1]);
            
            console.log(`🟦 P2P: ${m[1]} делится подходом с ${recipients.join(', ')}`);

            // 📡 race:live — обгон: первый финишировавший выходит в лидеры
            emitLive('overtake', {
              by: m[1],
              on: recipients,
              reason: 'first_finisher_becomes_leader',
              recipients,
            });
            // 📻 Radio: лидер вышел вперёд
            radio('overtake', {
              by: m[1],
              on: recipients,
              race_id: state.race_id,
            });
            
            emitP2P('p2p:leader_help', {
              race_id: state.race_id,
              leader: m[1],
              recipients,
              approach: 'Начинай с чтения reference файлов в research/, потом создай файл-заглушку через write, итерируй.',
              strategy_hint: 'Используй инструменты read и write, не отвечай текстом без действий.',
              ts: Date.now(),
            });
          }
        }
      }
      // Парсинг score
      const scoreMatch = line.match(/score:\s*(\d+)/);
      if (scoreMatch) {
        safety.reportScore('agent_from_line', parseInt(scoreMatch[1]));
      }
      if (line.includes('❌')) {
        const m = line.match(/❌\s+(\S+)/);
        if (m) {
          console.log(`   ❌ ${m[1]} ошибка`);
          flags.yellow(state.race_id, m[1], 'ошибка');
          safety.reportFailure(m[1], 'ошибка гонки');
        }
      }
    }
  });

  proc.stderr.on('data', (d) => {
    console.error('race.js stderr:', d.toString().slice(0, 200));
  });

  // Таймаут — если гонка висит
  const timeoutMs = timeout_sec * 1000;
  const timeoutHandle = setTimeout(() => {
    if (state.status === 'running') {
      console.log(`🚨 RACE CONTROL: timeout ${timeout_sec}s — вызываю Safety Car`);
      flags.yellow(state.race_id, null, 'timeout');
      state.status = 'yellow';
      proc.kill('SIGTERM');
    }
  }, timeoutMs);

  return new Promise((resolve) => {
    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);

      // Парсим финальный race.json
      const raceFile = path.join(RACE_DIR, state.race_id + '.json');
      let protocol = null;
      if (fs.existsSync(raceFile)) {
        protocol = JSON.parse(fs.readFileSync(raceFile, 'utf8'));
      }

      if (protocol) {
        state.results = protocol.results || [];
        const winner = protocol.winner;

        if (winner) {
          // 🏁 Финиш — победитель
          flags.finish(state.race_id, winner);
          console.log(`🏆 ПОБЕДИТЕЛЬ: ${winner}`);
        } else {
          // 🔴 Никто не финишировал — красный флаг
          flags.red(state.race_id, null, 'нет победителя');
          console.log(`🔴 Нет победителя`);
        }
      }

      state.status = 'finished';
      safety.endWatch();
      const duration = ((Date.now() - state.started_at) / 1000).toFixed(1);
      console.log(`🏁 Гонка завершена за ${duration}s (exit code: ${code})`);

      // 📡 LIVE: финиш гонки
      emitLive('finish', {
        winner: protocol?.winner || null,
        duration_sec: parseFloat(duration),
        results: state.results,
        status: state.status,
      });

      // 📻 Radio: финиш гонки
      radio('finish', {
        winner: protocol?.winner || null,
        race_id: state.race_id,
      });

      // 📡 race:live — событие финиша гонки
      emitLive('finish', {
        winner: protocol?.winner || null,
        duration_sec: parseFloat(duration),
        exit_code: code,
        results: state.results,
      });

      resolve({
        race_id: state.race_id,
        duration_sec: parseFloat(duration),
        winner: protocol?.winner || null,
        results: state.results,
      });
    });
  });
}

// === СТОП ГОНКИ (Red Flag) ===
function stopRace(reason = 'Ручная остановка') {
  if (state.status !== 'running' && state.status !== 'yellow') {
    console.log('⚠️ Нет активной гонки для остановки');
    return;
  }
  flags.red(state.race_id, null, reason);
  state.status = 'red';
  console.log(`🔴 Гонка ${state.race_id} остановлена: ${reason}`);
}

// === ТЕКУЩИЙ СТАТУС ===
function getStatus() {
  return {
    race_id: state.race_id,
    task: state.task,
    boxes: state.boxes,
    status: state.status,
    elapsed_sec: state.started_at ? ((Date.now() - state.started_at) / 1000).toFixed(1) : 0,
  };
}


// === ДЕТЕКТ ОБГОНА НА КРУГ ===
function checkLapLead(raceId, positions) {
  if (!positions || positions.length < 2) return null;
  const sorted = [...positions].sort((a, b) => b.progress - a.progress);
  const leader = sorted[0];
  const last = sorted[sorted.length - 1];
  
  if (leader.progress - last.progress >= 1.0) {
    return {
      leader: leader.agent,
      can_help: sorted.slice(1).map(s => s.agent),
      race_id: raceId,
    };
  }
  return null;
}

module.exports = { startRace, stopRace, getStatus, checkLapLead };

// === CLI ===
if (require.main === module) {
  const task = process.env.RACE_TASK || process.argv[2] || 'READY';
  const boxes = (process.env.RACE_BOXES || process.argv[3] || 'agent_1,agent_4').split(',');

  startRace({
    boxes,
    task,
    timeout_sec: 300,
  }).then((result) => {
    console.log('\n=== FORMULA I1 CONTROL — FINAL ===');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }).catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
