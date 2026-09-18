// safety_car.js — Машина безопасности. Следит за аномалиями в гонке.
const fs = require('fs');
const path = require('path');
const flags = require('./flag_marshal');

const ROOT = __dirname;
const RACE_DIR = path.join(ROOT, 'memory', 'races');

// Пороги аномалий
const THRESHOLDS = {
  agent_stuck_ms: 300000,      // 5 минут — агент завис
  race_timeout_ms: 600000,     // 10 минут — вся гонка висит
  zero_score_count: 2,         // 2 агента с score=0 подряд
  rapid_failures_ms: 60000,    // 3 ошибки за минуту
};

// Состояние Safety Car
const state = {
  watching: false,
  race_id: null,
  last_activity_ts: null,
  failure_timestamps: [],
  zero_scores: [],
};

// === НАЧАЛО НАБЛЮДЕНИЯ ===
function watchRace(race_id) {
  state.watching = true;
  state.race_id = race_id;
  state.last_activity_ts = Date.now();
  state.failure_timestamps = [];
  state.zero_scores = [];
  console.log(`🚗 FORMULA I1 Safety: следим за ${race_id}`);
}

// === СИГНАЛ АКТИВНОСТИ ===
function reportActivity(agent) {
  state.last_activity_ts = Date.now();
}

// === СИГНАЛ ОШИБКИ ===
function reportFailure(agent, reason = 'unknown') {
  const now = Date.now();
  state.failure_timestamps.push(now);
  // Чистим старые
  state.failure_timestamps = state.failure_timestamps.filter(
    (t) => now - t < THRESHOLDS.rapid_failures_ms
  );

  console.log(`⚠️ Safety Car: ${agent} — ${reason}`);

  // Rapid failures
  if (state.failure_timestamps.length >= 3) {
    console.log(`🚨 Safety Car: ${state.failure_timestamps.length} ошибок за минуту!`);
    deploy('rapid_failures', agent, reason);
  }
}

// === СИГНАЛ ПУСТОГО SCORE ===
function reportScore(agent, score) {
  if (score === 0) {
    state.zero_scores.push(agent);
    if (state.zero_scores.length >= THRESHOLDS.zero_score_count) {
      console.log(`🚨 Safety Car: ${state.zero_scores.length} агентов с score=0`);
      deploy('zero_scores', null, `agents: ${state.zero_scores.join(', ')}`);
    }
  } else {
    state.zero_scores = state.zero_scores.filter((a) => a !== agent);
  }
}

// === ВЫПУСК SAFETY CAR ===
function deploy(reason, agent = null, details = null) {
  if (!state.watching) return;

  console.log(`🚗 SAFETY CAR DEPLOYED: ${reason}`);

  // 🟡 Жёлтый флаг — все замедлились
  flags.yellow(state.race_id, agent, reason);

  // Пишем в лог
  const logEntry = {
    ts: new Date().toISOString(),
    race_id: state.race_id,
    reason,
    agent,
    details,
  };
  const logDir = path.join(ROOT, 'memory', 'safety_car');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${state.race_id}.json`);
  let log = [];
  if (fs.existsSync(logFile)) {
    log = JSON.parse(fs.readFileSync(logFile, 'utf8'));
  }
  log.push(logEntry);
  fs.writeFileSync(logFile, JSON.stringify(log, null, 2));

  return logEntry;
}

// === ПРОВЕРКА ТАЙМАУТОВ (запускать каждые 30 сек) ===
function tick() {
  if (!state.watching) return;

  const now = Date.now();
  const since_activity = now - state.last_activity_ts;

  // Гонка молчит > 10 мин
  if (since_activity > THRESHOLDS.race_timeout_ms) {
    console.log(`🚨 Safety Car: гонка молчит ${(since_activity / 1000).toFixed(0)}s`);
    deploy('race_timeout', null, `silent ${(since_activity / 1000).toFixed(0)}s`);
  }
}

// === ЗАВЕРШЕНИЕ НАБЛЮДЕНИЯ ===
function endWatch() {
  if (!state.watching) return;
  console.log(`🚗 Safety Car: наблюдение за ${state.race_id} завершено`);
  state.watching = false;
}

// === АВТО-TICK ===
setInterval(tick, 30000);

module.exports = {
  watchRace,
  reportActivity,
  reportFailure,
  reportScore,
  deploy,
  endWatch,
};
