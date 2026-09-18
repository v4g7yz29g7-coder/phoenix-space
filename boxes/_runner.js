// Runner для бокса — устанавливает BOX_NAME и запускает agent_loop_v3
const path = require('path');
const boxName = path.basename(__dirname); // agent_1, agent_2, ...
process.env.BOX_NAME = boxName;

require('dotenv').config({ path: __dirname + '/.env' });

const task = process.env.RACE_TASK || process.argv[2];
if (!task) {
  console.log(JSON.stringify({ ok: false, error: 'No task' }));
  process.exit(1);
}

const loop = require('./agent_loop_v3');
loop.runWithCritic(task)
  .then(r => {
    console.log(JSON.stringify({
      ok: r.ok,
      score: r.critic && r.critic.score,
      verdict: r.critic && r.critic.verdict,
      answer: (r.answer || '').slice(0, 300),
      steps_count: (r.steps || []).length
    }));
  })
  .catch(e => {
    console.log(JSON.stringify({ ok: false, error: e.message.slice(0, 300) }));
  });
