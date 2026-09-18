// trajectory_builder.js — Trajectory > Skills
// Собирает путь восхождения из паттерна гонки, публикует в EverOS.
// НЕ копирует skills. Только путь + insights.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PATTERNS_DIR = path.join(ROOT, 'memory', 'patterns');
const EVEROS_ROOT = process.env.EVEROS_ROOT || '/home/ishidin/.everos';

function log(m) { console.log('🧬 ' + m); }
function err(m) { console.error('❌ ' + m); }

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// === КТО ЕСТЬ КТО ===
// Если бокс — клон, отделяем pilot от clone
function identifyAgent(box) {
  if (box.includes('_clone_')) {
    const pilot = box.split('_clone_')[0];
    return { kind: 'clone', pilot, box };
  }
  return { kind: 'pilot', pilot: box, box };
}

// === ПОСТРОИТЬ ПУТЬ ОДНОГО УЧАСТНИКА ===
function buildPath(result, winnerBox, allResults) {
  const isWinner = result.box === winnerBox;
  const scores = allResults.map(r => r.score).filter(s => typeof s === 'number');
  const times = allResults.map(r => r.time).filter(t => typeof t === 'number');
  const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const avgTime = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;

  const speedRank = times.sort((a, b) => a - b).indexOf(result.time) + 1;
  const scoreRank = scores.sort((a, b) => b - a).indexOf(result.score) + 1;

  // Формулируем "что сделал" — из доступных полей
  const steps = [];
  if (result.ok) {
    steps.push({
      step: 1,
      action: 'принял задачу',
      outcome: 'ok',
    });
    steps.push({
      step: 2,
      action: result.score >= 9 ? 'углубился' : 'быстро решил',
      outcome: 'score ' + result.score,
      time_ms: result.time,
    });
  } else {
    steps.push({
      step: 1,
      action: 'принял задачу',
      outcome: 'fail',
    });
  }

  // Формулируем суть стратегии
  let strategy = 'balanced';
  if (result.time < avgTime * 0.7) strategy = 'fast';
  else if (result.time > avgTime * 1.3) strategy = 'deep';

  if (isWinner) strategy = 'winner';

  return {
    box: result.box,
    ...identifyAgent(result.box),
    is_winner: isWinner,
    score: result.score,
    time_ms: result.time,
    ok: result.ok,
    speed_rank: speedRank,
    score_rank: scoreRank,
    strategy,
    steps,
    trade_off: isWinner
      ? (speedRank > 1 ? 'медленнее но глубже' : 'быстро и качественно')
      : (result.score >= avgScore ? 'на уровне' : 'ниже среднего'),
  };
}

// === INSIGHTS ===
function extractInsights(paths, winner) {
  const insights = [];

  const fastest = paths.reduce((a, b) => (a.time_ms < b.time_ms ? a : b));
  const slowest = paths.reduce((a, b) => (a.time_ms > b.time_ms ? a : b));
  const fastestAndBest = fastest.is_winner;

  if (winner.time_ms > fastest.time_ms * 2) {
    insights.push({
      pattern: 'trade-off: медленный = глубокий',
      evidence: winner.box + ' (' + winner.time_ms + 'ms) победил ' +
                fastest.box + ' (' + fastest.time_ms + 'ms)',
      lesson: 'скорость не всегда = победа; иногда +1 score стоит +3× времени',
    });
  }

  if (winner.score >= 9 && fastest.score >= 9) {
    insights.push({
      pattern: 'быстрый и глубокий одновременно',
      evidence: 'разброс времени ' + (slowest.time_ms - fastest.time_ms) + 'ms при score ≥9',
      lesson: 'некоторые стратегии дают и скорость и качество',
    });
  }

  const clones = paths.filter(p => p.kind === 'clone');
  if (clones.length) {
    insights.push({
      pattern: 'клон vs пилот',
      evidence: clones.map(c => c.pilot + '→' + c.box + ' ' + c.score).join(', '),
      lesson: 'клоны показывают «чистый» путь ДНК без накопленного опыта',
    });
  }

  return insights;
}

// === ГЛАВНАЯ ФУНКЦИЯ ===
function buildTrajectory(raceId) {
  const patternFile = path.join(PATTERNS_DIR, raceId + '.json');
  if (!fs.existsSync(patternFile)) {
    err('Паттерн не найден: ' + patternFile);
    return null;
  }

  const p = JSON.parse(fs.readFileSync(patternFile, 'utf8'));
  const results = p.results || [];
  const winnerBox = p.winner;

  if (!results.length) {
    err('Пустые results в паттерне');
    return null;
  }

  const winner = results.find(r => r.box === winnerBox);
  const paths = results.map(r => buildPath(r, winnerBox, results));
  const insights = winner ? extractInsights(paths, winner) : [];

  const trajectory = {
    race_id: raceId,
    ts: p.ts || new Date().toISOString(),
    task: (p.task || '').slice(0, 300),
    winner: winnerBox,
    participants: paths,
    insights,
    ascension: {
      winner_path: winner ? {
        strategy: paths.find(p => p.box === winnerBox).strategy,
        steps: paths.find(p => p.box === winnerBox).steps,
      } : null,
      for_team: results.filter(r => r.box !== winnerBox).map(r => r.box),
    },
    kind: 'trajectory',
    version: 1,
  };

  return trajectory;
}

// === ЗАПИСЬ В EverOS ===
function writeToEverOS(trajectory) {
  try {
    const date = new Date(trajectory.ts).toISOString().slice(0, 10);
    const dir = path.join(EVEROS_ROOT, 'aeon', 'phoenix', 'trajectories');
    ensureDir(dir);
    const file = path.join(dir, trajectory.race_id + '.md');

    const lines = [];
    lines.push('# 🏁 Trajectory — ' + trajectory.race_id);
    lines.push('');
    lines.push('**Дата:** ' + trajectory.ts);
    lines.push('**Победитель:** ' + trajectory.winner);
    lines.push('**Задача:** ' + trajectory.task);
    lines.push('');
    lines.push('## 🛤️ Пути восхождения');
    lines.push('');

    const sorted = [...trajectory.participants].sort((a, b) => {
      if (a.is_winner) return -1;
      if (b.is_winner) return 1;
      return (b.score || 0) - (a.score || 0);
    });

    for (const p of sorted) {
      const medal = p.is_winner ? '🥇' : (p.score_rank === 2 ? '🥈' : '🥉');
      const kindLabel = p.kind === 'clone' ? '🧬 клон ' + p.pilot : '👤 пилот';
      lines.push('### ' + medal + ' ' + p.box + ' (' + kindLabel + ')');
      lines.push('');
      lines.push('- **Стратегия:** ' + p.strategy);
      lines.push('- **Score:** ' + p.score + ' | **Time:** ' + p.time_ms + 'ms');
      lines.push('- **Trade-off:** ' + p.trade_off);
      lines.push('- **Путь:**');
      for (const step of p.steps) {
        lines.push('  ' + step.step + '. ' + step.action + ' → ' + step.outcome +
          (step.time_ms ? ' (' + step.time_ms + 'ms)' : ''));
      }
      lines.push('');
    }

    if (trajectory.insights.length) {
      lines.push('## 💡 Insights');
      lines.push('');
      for (const ins of trajectory.insights) {
        lines.push('**' + ins.pattern + '**');
        lines.push('- Evidence: ' + ins.evidence);
        lines.push('- Lesson: ' + ins.lesson);
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push('## 🎯 Для команды');
    lines.push('');
    lines.push('**Что это:** не готовая рыба, а удочка. Не решение, а маршрут его найти.');
    lines.push('');
    lines.push('**Как использовать:**');
    lines.push('1. Прочитай пути всех участников');
    lines.push('2. Найди свой trade-off (быстро/глубоко)');
    lines.push('3. Адаптируй под свою ДНК — не копируй');
    lines.push('');
    lines.push('**Помни:** разные стратегии дают разные ниши. Arena preserves diversity.');

    fs.writeFileSync(file, lines.join('\n'));
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// === ПУБЛИЧНОЕ API ===
function publishTrajectory(raceId) {
  const traj = buildTrajectory(raceId);
  if (!traj) return null;

  const everosResult = writeToEverOS(traj);

  // Локальная копия для аудита
  const localDir = path.join(ROOT, 'memory', 'trajectories');
  ensureDir(localDir);
  const localFile = path.join(localDir, raceId + '.json');
  fs.writeFileSync(localFile, JSON.stringify(traj, null, 2));

  log('Опубликована траектория: ' + raceId);
  log('   Участников: ' + traj.participants.length);
  log('   Insights: ' + traj.insights.length);
  log('   → ' + localFile);
  if (everosResult.ok) log('   → EverOS: ' + everosResult.path);
  else log('   ⚠️  EverOS: ' + (everosResult.error || 'skip'));

  return traj;
}

// === CLI ===
if (require.main === module) {
  const raceId = process.argv[2];
  if (!raceId) {
    console.log('🧬 trajectory_builder.js — Путь восхождения');
    console.log('');
    console.log('  node trajectory_builder.js <race_id>');
    console.log('');
    console.log('  Пример:');
    console.log('    node trajectory_builder.js race_1789321457602');
    process.exit(0);
  }
  const r = publishTrajectory(raceId);
  if (!r) process.exit(1);
}

module.exports = { buildTrajectory, publishTrajectory, writeToEverOS };
