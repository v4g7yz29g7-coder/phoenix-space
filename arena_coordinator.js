// arena_coordinator.js — Mission Control для агентов
const fs = require('fs');
const path = require('path');
const flags = require('./flag_marshal');

const ROADMAP = path.join(__dirname, 'arena_roadmap.json');
const BOARD = path.join(__dirname, 'arena_board.json');

function load(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function save(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

function analyze() {
  if (!fs.existsSync(ROADMAP)) return { issues: { failed: [], stuck: [], ready: [] } };
  const roadmap = load(ROADMAP);
  const board = fs.existsSync(BOARD) ? load(BOARD) : { tasks: {}, artifacts: {}, notes: [] };
  const now = Date.now();
  const issues = { failed: [], stuck: [], conflicts: [], ready: [] };
  for (const stage of roadmap.stages) {
    for (const task of stage.tasks) {
      const b = board.tasks[task.id] || {};
      if (task.status === 'failed') issues.failed.push({ stage: stage.id, task });
      if (task.status === 'in_progress' && b.started_at) {
        const elapsed = (now - new Date(b.started_at).getTime()) / 3600000;
        if (elapsed > 2) issues.stuck.push({ stage: stage.id, task, elapsed });
      }
      if (task.status === 'pending' && task.assignee !== 'мы') {
        issues.ready.push({ stage: stage.id, task });
      }
    }
  }
  return { roadmap, board, issues };
}

function tick() {
  console.log(`\n🛰️ Mission Control (${new Date().toISOString()})`);
  try {
    const { issues } = analyze();
    console.log(`   Failed: ${issues.failed.length}, Stuck: ${issues.stuck.length}, Ready: ${issues.ready.length}`);
  } catch (e) {
    console.log(`   Ошибка: ${e.message}`);
  }
}

module.exports = { tick, analyze };
if (require.main === module) {
  tick();
  if (process.argv[2] === '--loop') setInterval(tick, 5 * 60 * 1000);
}
