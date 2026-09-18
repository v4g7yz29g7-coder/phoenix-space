// agent_loop_v3.js — Исполнитель + Критик. Без P2P в top-level.
const agentV2 = require('./agent_responses');
const critic = require('./agent_critic');
const fs = require('fs');
const path = require('path');

const MAX_ATTEMPTS = 3;

// === Oracle hints (читаем файл, не блокирует) ===
function loadOracleHint(stageId) {
  try {
    const f = path.join(__dirname, '..', '..', 'oracle_hints.json');
    if (!fs.existsSync(f)) return null;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    return d[stageId] || null;
  } catch (e) { return null; }
}

function detectStage(prompt) {
  const m = prompt.match(/(?:ЗАДАЧА|Задача|задача)\s+(\d+)\./);
  if (!m) return null;
  return 'stage_' + m[1];
}

// 15.09: Луч + Маячки — тактические якоря
function extractBeacons(prompt) {
  const m = String(prompt || '').match(/🎯\s*ЛУЧ:\s*(.+?)(?:\n|$)/);
  return m ? m[1].trim() : null;
}

async function runWithCritic(prompt) {
  const attempts = [];

  // === Oracle: если есть подсказка для stage — добавляем ===
  const stageId = detectStage(prompt);
  if (stageId) {
    const hint = loadOracleHint(stageId);
    if (hint) {
      prompt = prompt + '\n\n🔮 ОРАКУЛ (общая подсказка):\n' +
        'Подход: ' + hint.approach + '\n' +
        'Совет: ' + hint.hint + '\n' +
        'Reference: ' + hint.reference + '\n';
      console.log('[oracle] Подсказка для ' + stageId);
    }
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const execResult = await agentV2.runAgent(prompt);

    if (!execResult.ok) {
      return { ok: false, error: 'Executor failed', attempt, result: execResult, attempts };
    }

    const criticResult = await critic.verify(prompt, execResult);

    attempts.push({
      attempt,
      executor: { answer: execResult.answer, steps: execResult.steps },
      critic: criticResult.verdict || { error: criticResult.error },
    });

    if (!criticResult.ok) {
      return { ok: false, error: 'Critic failed', attempts };
    }

    if (criticResult.verdict.verdict === 'approve') {
      return {
        ok: true,
        answer: execResult.answer,
        steps: execResult.steps,
        critic: criticResult.verdict,
        attempts,
      };
    }

    console.log('Attempt ' + attempt + ' rejected. Score: ' + criticResult.verdict.score);
    prompt = prompt + '\n\n[CRITIC FEEDBACK from attempt ' + attempt + ']:\n' +
      'Score: ' + criticResult.verdict.score + '\n' +
      'Issues: ' + (criticResult.verdict.issues || []).join('; ') + '\n' +
      'Please fix these issues.';
  }

  return { ok: false, error: 'Max attempts reached', attempts };
}

module.exports = { runWithCritic };
