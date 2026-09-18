// arena_worker.js — авто-исполнитель задач
const fs = require('fs');
const path = require('path');
const { startRace } = require('./race_director');

const ROADMAP = path.join(__dirname, 'arena_roadmap.json');

function load(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
function save(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

function getNextTask(roadmap) {
  // 1. REAPER: задачи in_progress > 30 мин → pending
  const now = Date.now();
  for (const stage of roadmap.stages) {
    for (const task of stage.tasks) {
      if (task.status === 'in_progress' && task.started_at) {
        const elapsed = (now - new Date(task.started_at).getTime()) / 60000;
        if (elapsed > 30) {
          console.log(`💀 Reaper: ${task.id} висит ${elapsed.toFixed(0)} мин → pending`);
          task.status = 'pending';
          task.retry_count = (task.retry_count || 0) + 1;
          if (task.retry_count > 2) {
            task.status = 'failed';
            console.log(`❌ ${task.id} — 3 попытки, сдаёмся`);
          }
        }
      }
    }
  }
  // stuckReaper

  // 1. Сначала pending
  for (const stage of roadmap.stages) {
    for (const task of stage.tasks) {
      if (task.status === 'pending' && task.assignee !== 'мы') return { stage, task };
    }
  }
  // 2. Потом failed — retry (не больше 2 попыток)
  for (const stage of roadmap.stages) {
    for (const task of stage.tasks) {
      if (task.status === 'failed') {
        task.retry_count = (task.retry_count || 0) + 1;
        if (task.retry_count <= 2) {
          task.status = 'pending';
          // Меняем агента
          task.assignee = task.assignee === 'agent_1' ? 'agent_4'
                        : task.assignee === 'agent_4' ? 'agent_7'
                        : 'agent_1';
          console.log(`🔁 Retry ${task.id} → ${task.assignee} (попытка ${task.retry_count})`);
          return { stage, task };
        }
      }
    }
  }
  return null;
}

function buildPrompt(stage, task) {
  // Особый промпт для Stage 2 (Киберпанк-кар) — сложный
  if (stage.id === 'stage_2') {
    return `ЗАДАЧА: ${task.title} (${task.id})

РЕФЕРЕНС — ОБЯЗАТЕЛЬНО ПРОЧИТАЙ:
- research/racing-game/src/models/vehicle/Vehicle.tsx
- research/racing-game/src/models/vehicle/Chassis.tsx
- research/racing-game/src/models/vehicle/Wheel.tsx
- research/racing-game/src/store.ts

ЧТО СДЕЛАТЬ (ПОШАГОВО):
1. ПРОЧИТАЙ reference файлы выше через read
2. Пойми логику (физика, колёса, подвеска)
3. Создай СВОЙ файл в arena_lab/src/scene/
4. Используй write для сохранения
5. ПРОВЕРЬ: exec("cd arena_lab && npx tsc --noEmit")
6. Если ошибки — исправь через edit

ВАЖНО:
- НЕ КОПИРУЙ 1-в-1 — адаптируй под наш проект
- Используй @react-three/cannon (уже установлен)
- Файл должен быть TypeScript (.tsx)

КРИТЕРИЙ:
- Файл создан в arena_lab/src/
- npx tsc --noEmit = 0 ошибок
- Использован write`;
  }

  // Стандартный промпт для остальных
  return `КРИТИЧЕСКИ ВАЖНО: Ты ОБЯЗАН использовать инструмент write для создания/изменения файла. НЕ ОТВЕЧАЙ ТЕКСТОМ БЕЗ ДЕЙСТВИЙ.

ТЫ РАБОТАЕШЬ НАД ЗАДАЧЕЙ ПРОЕКТА AI-1 (FORMULA I1).

ЗАДАЧА ${task.id}: ${task.title}
STAGE: ${stage.name}
ВРЕМЯ: ~${task.hours} часов

ЧТО ДЕЛАТЬ (ПОШАГОВО):
1. СНАЧАЛА прочитай research/audit.md — там рекомендации
2. Найди в research/racing-game/ подходящие файлы
3. Создай/измени файл в arena_lab/src/
4. ОБЯЗАТЕЛЬНО используй write для сохранения
5. Проверь: exec("cd arena_lab && npx tsc --noEmit")
6. Если ошибки — исправь

ДОСТУПНЫЕ ФАЙЛЫ:
- research/racing-game/  — reference (MIT)
- research/kenney-racing/ — ассеты (CC0)
- arena_lab/src/          — куда писать

КРИТЕРИЙ: файл создан + tsc=0

ВАЖНО — ТОЧНЫЙ ПУТЬ:
${task.file ? 'Создай файл: arena_lab/src/scene/' + task.file : 'Определи путь сам в arena_lab/src/scene/'}
Рабочая папка агента: /home/ishidin/phoenix
Пиши через write('arena_lab/src/scene/<имя>.tsx', content)`;

}

let totalRaces = 0;
let totalWins = 0;

function updateTaskStatus(taskId, status, result = null) {
  const fs = require('fs');
  const path = require('path');
  const ROADMAP = path.join(__dirname, 'arena_roadmap.json');
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  for (const stage of d.stages) {
    for (const task of stage.tasks) {
      if (task.id === taskId) {
        // НЕ трогать completed!
        if (task.status === 'completed') {
          console.log(`⚠️ ${taskId} уже completed — не трогаем`);
          return;
        }
        task.status = status;
        if (status === 'completed') task.completed_at = new Date().toISOString();
        if (result) task.result = result;
      }
    }
  }
  fs.writeFileSync(ROADMAP, JSON.stringify(d, null, 2));
}

async function runNextTask() { // EXPONENTIAL
  totalRaces++;
  if (!fs.existsSync(ROADMAP)) { console.log('Нет roadmap'); return; }
  const roadmap = load(ROADMAP);
  const next = getNextTask(roadmap);
  if (!next) { console.log('🎉 Все задачи выполнены'); return; }
  const { stage, task } = next;
  console.log(`\n🚀 ${task.id}: ${task.title} (${task.assignee})`);
  task.status = 'in_progress';
  task.started_at = new Date().toISOString();
  save(ROADMAP, roadmap);
  try {
    // Гонка 3 агентов — победитель в прод
const RACERS = ['agent_1', 'agent_4', 'agent_7'];
const result = await startRace({
  boxes: RACERS,
  task: buildPrompt(stage, task),
  timeout_sec: (task.hours || 2) * 3600
});
    task.status = result.winner ? 'completed' : 'failed';
    task.completed_at = new Date().toISOString();
    if (result.winner) {
      updateTaskStatus(task.id, 'completed', { winner: result.winner, time: result.duration_sec });
      console.log(`✅ ${task.id} → completed (winner: ${result.winner})`);
    } else {
      updateTaskStatus(task.id, 'failed');
      console.log(`❌ ${task.id} → failed`);
    }
  } catch (e) { task.status = 'failed'; task.error = e.message; }
  save(ROADMAP, roadmap);
}

module.exports = { runNextTask };
if (require.main === module) {
  const loop = process.argv[2] === '--loop';
  const tick = async () => {
    await runNextTask();
    if (loop) setTimeout(tick, 10000); // EXPONENTIAL: быстрее цикл
    else process.exit(0);
  };
  tick();
}
