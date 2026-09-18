// flag_status.js — Уровни готовности AI-1 ARMY
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ROADMAP = path.join(ROOT, 'arena_roadmap.json');
const FLAG_STATUS_FILE = path.join(ROOT, 'memory', 'flag_status.json');

// === УРОВНИ ГОТОВНОСТИ ===
const FLAG_STATUS = {
  5: {
    name: '🟢 GREEN — всё под контролем',
    color: '🟢',
    conditions: ['progress >= 60%', 'failed <= 5', 'no_stuck'],
    actions: ['нормальный режим', 'исследования', 'разработка']
  },
  4: {
    name: '🟡 YELLOW — есть проблемы',
    color: '🟡',
    conditions: ['progress < 60%', 'failed > 5'],
    actions: ['усилить worker', 'активировать резервы', 'AAR']
  },
  3: {
    name: '🟠 ORANGE — много провалов',
    color: '🟠',
    conditions: ['failed > 10', 'stuck > 3'],
    actions: ['оборонительный режим', 'аудит', 'патруль']
  },
  2: {
    name: '🔴 RED — критично',
    color: '🔴',
    conditions: ['failed > 20', 'progress < 30%'],
    actions: ['ВСЁ НА ОБОРОНУ', 'только критические задачи']
  },
  1: {
    name: '⚫ BLACK — стоп',
    color: '⚫',
    conditions: ['security_breach', 'key_leak', 'total_failure'],
    actions: ['СТОП РАБОТЫ', 'СОХРАНИТЬ ДАННЫЕ', 'УВЕДОМИТЬ']
  }
};

// === ОЦЕНКА СИТУАЦИИ ===
function assess() {
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  const stats = { total: 0, completed: 0, failed: 0, pending: 0, in_progress: 0 };
  
  for (const stage of d.stages) {
    for (const task of stage.tasks) {
      stats.total++;
      stats[task.status] = (stats[task.status] || 0) + 1;
    }
  }
  
  const progress = stats.completed / stats.total * 100;
  
  // Считаем stuck
  const now = Date.now();
  const stuck = d.stages.flatMap(s => s.tasks).filter(t => 
    t.status === 'in_progress' && t.started_at && 
    (now - new Date(t.started_at).getTime()) > 3600000
  ).length;
  
  // Определяем FLAG_STATUS
  let level = 5;
  if (stats.failed > 20 || progress < 30) level = 2;
  else if (stats.failed > 10 || stuck > 3) level = 3;
  else if (stats.failed > 5 || progress < 60) level = 4;
  
  return { stats, progress, stuck, level };
}

// === ОПОВЕЩЕНИЕ ===
function alert(level) {
  const d = FLAG_STATUS[level];
  const line = `${d.name}`;
  console.log(line);
  console.log(`   Действия: ${d.actions.join(' → ')}`);
  
  // Сохраняем в файл
  const report = {
    ts: new Date().toISOString(),
    level,
    name: d.name,
    color: d.color,
    actions: d.actions,
  };
  fs.writeFileSync(FLAG_STATUS_FILE, JSON.stringify(report, null, 2));
  
  // Отправляем в board
  const BOARD = path.join(ROOT, 'arena_board.json');
  if (fs.existsSync(BOARD)) {
    const board = JSON.parse(fs.readFileSync(BOARD, 'utf8'));
    board.notes = board.notes || [];
    board.notes.push({
      ts: new Date().toISOString(),
      type: 'defcon',
      level,
      message: line
    });
    fs.writeFileSync(BOARD, JSON.stringify(board, null, 2));
  }
  
  return report;
}

// === ГЛАВНАЯ ФУНКЦИЯ ===
function patrol() {
  const a = assess();
  console.log(`\n🏁 FLAG STATUS: оценка ситуации`);
  console.log(`   Прогресс: ${a.progress.toFixed(1)}%`);
  console.log(`   Провалов: ${a.stats.failed}`);
  console.log(`   Stuck: ${a.stuck}`);
  
  const report = alert(a.level);
  return { ...a, report };
}

module.exports = { FLAG_STATUS, assess, alert, patrol };

// === CLI ===
if (require.main === module) {
  const loop = process.argv[2] === '--loop';
  patrol();
  if (loop) {
    console.log('\n🔄 Следующая проверка через 5 минут...');
    setInterval(patrol, 5 * 60 * 1000);
  }
}
