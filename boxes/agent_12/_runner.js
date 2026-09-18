// Runner для бокса — устанавливает BOX_NAME и запускает agent_loop_v3
// 18.09: добавлена проверка Рва (Moat) ПЕРЕД вызовом LLM
const path = require('path');
const boxName = path.basename(__dirname);
process.env.BOX_NAME = boxName;

require('dotenv').config({ path: __dirname + '/.env' });

const task = process.env.RACE_TASK || process.argv[2];
if (!task) {
  console.log(JSON.stringify({ ok: false, error: 'No task' }));
  process.exit(1);
}

// === GUARDIAN: проверка входа ===
try {
  const guardian = require('../../security/guardian');
  const g = guardian.inspectInput(task, boxName);
  if (!g.ok) {
    console.log(JSON.stringify({ ok: false, error: 'Guardian blocked input', flags: g.flags }));
    process.exit(0);
  }
} catch (e) {
  console.error('[guardian] error:', e.message.slice(0, 200));
}

// === MOAT: проверка Рва ===
let moatResult = null;
try {
  const moat = require('../../moat_inject');
  if (process.env.MOAT_DISABLED !== '1') {
    moatResult = moat.trySolve({ file: null, prompt: task });
  }
  if (moatResult && moatResult.solved) {
    console.log(JSON.stringify({
      ok: true,
      score: moatResult.score || 9,
      verdict: 'approve',
      answer: (moatResult.answer || '').slice(0, 5000),
      steps_count: 0,
      source: moatResult.source,
      moat_winner: moatResult.winner || null,
      moat_hash: moatResult.hash || null,
    }));
    process.exit(0);
  }
} catch (e) {
  // Ров не сработал — идём к LLM
  console.error('[moat] error:', e.message.slice(0, 200));
}

// === LLM: обычный путь ===
const loop = require('./agent_loop_v3');
loop.runWithCritic(task)
  .then(r => {
    console.log(JSON.stringify({
      ok: r.ok,
      score: r.critic && r.critic.score,
      verdict: r.critic && r.critic.verdict,
      answer: (r.answer || '').slice(0, 5000),
      steps_count: (r.steps || []).length,
      source: 'llm',
    }));
  })
  .catch(e => {
    console.log(JSON.stringify({ ok: false, error: e.message.slice(0, 300) }));
  });
