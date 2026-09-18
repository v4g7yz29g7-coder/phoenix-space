// arena/race_runner.js — запуск гонки с пользовательской моделью
'use strict';

const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const teamBuilder = require('./team_builder');

const ROOT = path.join(__dirname, '..');

/**
 * Запустить гонку: user model + 2 эталонных пилота.
 * @returns {Promise<{ok: boolean, race_id?, results?, error?}>}
 */
function runRace({ userId, modelId, task }) {
  return new Promise((resolve) => {
    // Загружаем запись модели
    let modelRecord = null;
    try {
      const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'arena_models.json'), 'utf8'));
      modelRecord = registry[modelId];
    } catch (e) {
      return resolve({ ok: false, error: 'registry: ' + e.message });
    }
    if (!modelRecord) {
      return resolve({ ok: false, error: 'model not found: ' + modelId });
    }

    // Системная модель — используем существующий бокс напрямую
    let userBox, buildResult;
    if (modelRecord.is_official && modelRecord.source_agent) {
      userBox = modelRecord.source_agent;  // 'agent_1', 'agent_7', ...
      buildResult = { ok: true, boxPath: null, boxName: userBox };
      console.log('[race_runner] official model →', userBox);
    } else {
      buildResult = teamBuilder.buildBoxFromModel(userId, modelId, modelRecord);
      if (!buildResult.ok) {
        return resolve({ ok: false, error: 'build: ' + buildResult.error });
      }
      userBox = buildResult.boxName;
    }

    // Соперники — топ агенты, исключая сам user_box
    const TOP_5 = ['agent_1', 'agent_7', 'agent_3', 'agent_14', 'agent_4'];
    const opponents = TOP_5.filter(a => a !== userBox).slice(0, 2);
    const RACERS = [userBox, ...opponents];
    const raceId = 'race_user_' + Date.now();

    console.log('[race_runner] start', raceId, '| boxes:', RACERS.join(','));

    const env = {
      ...process.env,
      RACE_BOXES: RACERS.join(','),
      RACE_TASK: task || 'Прочитай README.md и скажи сколько там строк. Ничего не меняй.',
      RACE_ID_DIRECTED: raceId,
      RACE_NO_P2P: '1',
    };

    const proc = spawn('node', ['race.js'], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    proc.stdout.on('data', d => { output += d.toString(); });
    proc.stderr.on('data', d => { output += d.toString(); });

    const timeout = setTimeout(() => {
      console.log('[race_runner] timeout, killing');
      proc.kill('SIGTERM');
    }, 5 * 60 * 1000);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      // Читаем протокол
      const raceFile = path.join(ROOT, 'memory', 'races', raceId + '.json');
      let protocol = null;
      if (fs.existsSync(raceFile)) {
        try { protocol = JSON.parse(fs.readFileSync(raceFile, 'utf8')); } catch (e) {}
      }

      // Чистим бокс
      try { teamBuilder.cleanupBox(buildResult.boxPath, buildResult.boxName); } catch (e) {}

      if (!protocol) {
        return resolve({
          ok: false,
          error: 'no protocol (exit ' + code + ')',
          log_tail: output.slice(-500),
        });
      }

      // Находим результат user box
      const userResult = (protocol.results || []).find(r => r.box === userBox);
      const winner = protocol.winner;

      resolve({
        ok: true,
        race_id: raceId,
        user_box: userBox,
        winner,
        user_score: userResult ? userResult.score : null,
        user_ok: userResult ? userResult.ok : false,
        user_time_ms: userResult ? userResult.duration_ms : null,
        is_winner: winner === userBox,
        results: protocol.results,
        duration_sec: (protocol.results || []).reduce((m, r) => Math.max(m, r.duration_ms || 0), 0) / 1000,
      });
    });
  });
}

module.exports = { runRace };

// CLI
if (require.main === module) {
  const [userId, modelId] = process.argv.slice(2);
  if (!userId || !modelId) {
    console.log('Использование: node arena/race_runner.js <user_id> <model_id>');
    process.exit(0);
  }
  runRace({ userId, modelId })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
