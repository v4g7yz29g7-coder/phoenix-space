// research_worker.js — глубокое исследование через агентов
const fs = require('fs');
const path = require('path');
const { startRace } = require('./race_director');

const RESEARCH = path.join(__dirname, 'arena_research.json');

function load() { return JSON.parse(fs.readFileSync(RESEARCH, 'utf8')); }
function save(d) { fs.writeFileSync(RESEARCH, JSON.stringify(d, null, 2)); }

async function runNext() {
  const d = load();
  const task = d.tasks.find(t => t.status === 'pending');
  if (!task) {
    console.log('🎉 Все research задачи выполнены');
    return;
  }
  
  task.status = 'in_progress';
  task.started_at = new Date().toISOString();
  save(d);
  
  console.log(`\n🔬 RESEARCH ${task.id}: ${task.title}`);
  console.log(`   Агент: ${task.assignee}`);
  
  const prompt = `РЕЖИМ ИССЛЕДОВАНИЯ
${task.prompt}

Ты в режиме глубокого исследования. Изучи GitHub, документацию, примеры.
Результат: файл ${task.file} (используй write).
Не просто опиши — приведи конкретные примеры кода.`;

  try {
    const result = await startRace({
      boxes: ['agent_1', 'agent_4', 'agent_7'],
      task: prompt,
      timeout_sec: 600,
    });
    
    task.status = result.winner ? 'completed' : 'failed';
    task.completed_at = new Date().toISOString();
    task.winner = result.winner;
    
    console.log(`   ${result.winner ? '✅' : '❌'} ${task.id} (winner: ${result.winner})`);
  } catch (e) {
    task.status = 'failed';
    task.error = e.message;
    console.log(`   ❌ ${task.id}: ${e.message}`);
  }
  
  save(d);
}

module.exports = { runNext };
if (require.main === module) {
  const loop = process.argv[2] === '--loop';
  const tick = async () => {
    await runNext();
    if (loop) setTimeout(tick, 30000);
    else process.exit(0);
  };
  tick();
}
