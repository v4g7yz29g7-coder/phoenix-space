// worker_pool.js — КОНВЕЙЕР. Агент освободился → сразу следующая задача.
const fs = require('fs');
const path = require('path');
const { startRace } = require('./race_director');

const ROOT = __dirname;
const ROADMAP = path.join(ROOT, 'arena_roadmap.json');

// === ПУЛ АГЕНТОВ ===
const POOL = [
  { id: 'agent_1', status: 'idle', current_task: null },
  { id: 'agent_4', status: 'idle', current_task: null },
  { id: 'agent_7', status: 'idle', current_task: null },
];

// === ЗАГРУЗКА ===
function loadRoadmap() {
  return JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
}
function saveRoadmap(d) {
  fs.writeFileSync(ROADMAP, JSON.stringify(d, null, 2));
}

// === ВЫБОР СЛЕДУЮЩЕЙ ЗАДАЧИ ===
function pickNextTask(roadmap, excludeIds = []) {
  const candidates = [];
  for (const stage of roadmap.stages) {
    for (const task of stage.tasks) {
      if (task.status === 'pending' && task.assignee !== 'мы' && !excludeIds.includes(task.id)) {
        candidates.push({ stage, task });
      }
    }
  }
  // Сортировка: по priority (Easy первыми), потом по id
  candidates.sort((a, b) => {
    const pa = a.task.priority || 2;
    const pb = b.task.priority || 2;
    if (pa !== pb) return pa - pb;
    return a.task.id.localeCompare(b.task.id);
  });
  return candidates[0] || null;
}

// === ИСПОЛНЕНИЕ ЗАДАЧИ ВОРКЕРОМ ===
async function runWorkerTask(worker, stage, task) {
  worker.status = 'busy';
  worker.current_task = task.id;
  
  console.log(`\n🏎️ ${worker.id} → ${task.id}: ${task.title}`);
  
  // Ставим in_progress
  const roadmap = loadRoadmap();
  for (const s of roadmap.stages) {
    for (const t of s.tasks) {
      if (t.id === task.id) {
        t.status = 'in_progress';
        t.started_at = new Date().toISOString();
      }
    }
  }
  saveRoadmap(roadmap);
  
  try {
    const result = await startRace({
      boxes: [worker.id],
      task: buildPrompt(stage, task),
      timeout_sec: 600,
    });
    
    // Обновляем статус
    const r2 = loadRoadmap();
    for (const s of r2.stages) {
      for (const t of s.tasks) {
        if (t.id === task.id) {
          t.status = result.winner ? 'completed' : 'failed';
          t.completed_at = new Date().toISOString();
          t.winner = result.winner;
        }
      }
    }
    saveRoadmap(r2);
    
    console.log(`   ${result.winner ? '✅' : '❌'} ${task.id} → ${result.winner || 'failed'}`);
  } catch (e) {
    console.log(`   ❌ ${task.id}: ${e.message}`);
    // Отмечаем failed
    const r2 = loadRoadmap();
    for (const s of r2.stages) {
      for (const t of s.tasks) {
        if (t.id === task.id) {
          t.status = 'failed';
          t.error = e.message;
        }
      }
    }
    saveRoadmap(r2);
  } finally {
    worker.status = 'idle';
    worker.current_task = null;
  }
}

// === ПРОМПТ (как в worker.js) ===
function buildPrompt(stage, task) {
  return `КРИТИЧЕСКИ ВАЖНО: Ты ОБЯЗАН использовать инструмент write для создания/изменения файла.

ЗАДАЧА ${task.id}: ${task.title}
STAGE: ${stage.name}

${task.file ? 'Создай файл: arena_lab/src/scene/' + task.file : ''}

Пиши через write, проверяй через exec("cd arena_lab && npx tsc --noEmit").`;
}

// === ГЛАВНЫЙ ЦИКЛ ПУЛА ===
async function poolLoop() {
  console.log('\n🎖️ WORKER POOL — конвейер запущен');
  console.log(`   Воркеры: ${POOL.map(w => w.id).join(', ')}\n`);
  
  let iteration = 0;
  while (true) {
    iteration++;
    
    // Найти idle-воркеров
    const idleWorkers = POOL.filter(w => w.status === 'idle');
    if (idleWorkers.length === 0) {
      console.log(`\n⏳ Все воркеры заняты. Ждём 30 сек...`);
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }
    
    // Найти задачи
    const roadmap = loadRoadmap();
    const activeTaskIds = POOL.filter(w => w.current_task).map(w => w.current_task);
    
    // Раздаём задачи idle-воркерам
    for (const worker of idleWorkers) {
      const next = pickNextTask(roadmap, activeTaskIds);
      if (!next) {
        console.log(`\n🎉 Больше нет pending задач!`);
        console.log(`   Воркеры: ${POOL.map(w => `${w.id}=${w.status}`).join(', ')}`);
        return;
      }
      
      // Запускаем асинхронно (не ждём завершения!)
      runWorkerTask(worker, next.stage, next.task).catch(e => {
        console.log(`❌ ${worker.id} FATAL: ${e.message}`);
      });
    }
    
    // Ждём немного перед следующей проверкой
    await new Promise(r => setTimeout(r, 5000));
  }
}

module.exports = { poolLoop, POOL };

// === CLI ===
if (require.main === module) {
  poolLoop().catch(e => console.error('FATAL:', e.message));
}
