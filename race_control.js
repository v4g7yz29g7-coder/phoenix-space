// army_command.js — Центральный командный модуль AI-1 RACE CONTROL
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const ARMY = JSON.parse(fs.readFileSync(path.join(__dirname, 'race_control_structure.json'), 'utf8'));
const BOARD = path.join(ROOT, 'arena_board.json');
const ROADMAP = path.join(ROOT, 'arena_roadmap.json');

// === УТИЛИТЫ ===
function readBoard() {
  if (!fs.existsSync(BOARD)) return { notes: [] };
  return JSON.parse(fs.readFileSync(BOARD, 'utf8'));
}
function writeBoard(b) {
  fs.writeFileSync(BOARD, JSON.stringify(b, null, 2));
}
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const LOG = path.join(ROOT, 'memory', 'race_control.log');
  fs.appendFileSync(LOG, line + '\n');
}

// === ПРИКАЗ (от Race Directorа к Stewardу) ===
function issueOrder(fromId, toId, mission, priority = 'normal') {
  const board = readBoard();
  board.notes = board.notes || [];
  board.notes.push({
    ts: new Date().toISOString(),
    type: 'order',
    from: fromId,
    to: toId,
    mission,
    priority,
    status: 'issued'
  });
  writeBoard(board);
  log(`🎖️ ПРИКАЗ: ${fromId} → ${toId} [${priority}]: ${mission.slice(0, 80)}`);
}

// === ДОКЛАД (от подчинённого к командиру) ===
function reportTo(fromId, toId, content, type = 'report') {
  const board = readBoard();
  board.notes.push({
    ts: new Date().toISOString(),
    type,
    from: fromId,
    to: toId,
    content
  });
  writeBoard(board);
  log(`📋 ДОКЛАД: ${fromId} → ${toId} [${type}]: ${content.slice(0, 80)}`);
}

// === OODA LOOP RACE DIRECTORА ===
function generalOODA() {
  const d = JSON.parse(fs.readFileSync(ROADMAP, 'utf8'));
  const stats = { total: 0, completed: 0, failed: 0, pending: 0, in_progress: 0 };
  
  for (const stage of d.stages) {
    for (const task of stage.tasks) {
      stats.total++;
      stats[task.status] = (stats[task.status] || 0) + 1;
    }
  }
  
  const progress = (stats.completed / stats.total * 100).toFixed(1);
  
  log(`\n🎖️ RACE DIRECTOR OODA LOOP`);
  log(`   OBSERVE: ${stats.completed}/${stats.total} (${progress}%) | провалов: ${stats.failed}`);
  
  // ORIENT
  const direction = progress >= 80 ? 'ФИНАЛ' :
                    progress >= 60 ? 'НАСТУПЛЕНИЕ' :
                    progress >= 40 ? 'ПРОДВИЖЕНИЕ' : 'МОБИЛИЗАЦИЯ';
  log(`   ORIENT: ${direction}`);
  
  // DECIDE
  const decisions = [];
  if (stats.failed > 10) decisions.push('УСИЛИТЬ ОБОРОНУ (снизить провалы)');
  if (stats.pending > 5) decisions.push('АКТИВИРОВАТЬ РЕЗЕРВЫ');
  if (stats.in_progress > 5) decisions.push('ПРОВЕРИТЬ ЗАСТРЯВШИХ');
  
  // ACT
  for (const decision of decisions) {
    log(`   DECIDE: ${decision}`);
  }
  
  // Приказы stewardам
  if (stats.pending > 5) {
    const businessCol = ARMY.directions.find(d => d.id === 'business');
    issueOrder('agent_30_general', businessCol.colonel, 
      'Активировать резервы для Stage 6/7 (регистрация, БД, API)', 'high');
  }
  
  if (stats.failed > 10) {
    const defenseCol = ARMY.directions.find(d => d.id === 'defense');
    issueOrder('agent_30_general', defenseCol.colonel,
      'Усилить аудит: 11+ провалов — проверить качество', 'high');
  }
  
  return { stats, progress, direction, decisions };
}

// === STEWARD — OODA НАПРАВЛЕНИЯ ===
function colonelOODA(directionId) {
  const dir = ARMY.directions.find(d => d.id === directionId);
  if (!dir) return null;
  
  log(`\n🎖️ STEWARD "${dir.name}" — OODA`);
  
  if (directionId === 'science') {
    const research = JSON.parse(fs.readFileSync(path.join(ROOT, 'arena_research.json'), 'utf8'));
    const rs = {
      total: research.tasks.length,
      completed: research.tasks.filter(t => t.status === 'completed').length,
      in_progress: research.tasks.filter(t => t.status === 'in_progress').length
    };
    log(`   📊 Research: ${rs.completed}/${rs.total} (в работе: ${rs.in_progress})`);
    
    if (rs.completed < rs.total) {
      issueOrder(dir.colonel, 'major_jwt', 
        'Продолжить исследования: ' + (rs.completed + 1) + '/' + rs.total, 'normal');
    }
  }
  
  if (directionId === 'business') {
    log(`   📊 Landing + Pitch — готовы`);
    issueOrder(dir.colonel, 'major_pricing', 
      'Подготовить документы для CloudPayments после ОКВЭД', 'normal');
  }
  
  if (directionId === 'sport') {
    log(`   📊 5/5 киберпанк-кар, 7/7 трассы, 3/4 cinematic`);
    issueOrder(dir.colonel, 'major_cams', 
      'Завершить 4.4 (синхронизация с флагом)', 'normal');
  }
  
  if (directionId === 'defense') {
    const patrol = fs.existsSync(path.join(ROOT, 'memory', 'patrol_report.json')) 
      ? JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'patrol_report.json'), 'utf8')) 
      : null;
    if (patrol) {
      log(`   📊 Дисциплина: ${patrol.passed}/4`);
    }
  }
  
  return dir;
}

// === ГЛАВНЫЙ ЦИКЛ ===
async function mainLoop() {
  log('\n═══════════════════════════════════');
  log('🎖️ AI-1 RACE CONTROL COMMAND — запуск');
  log('═══════════════════════════════════');
  
  // Race Director
  const generalReport = generalOODA();
  
  // Stewardи
  for (const dir of ARMY.directions) {
    colonelOODA(dir.id);
  }
  
  log('\n✅ Цикл командования завершён');
  return generalReport;
}

// === ПРОВЕРКА ПУЛА ВОРКЕРОВ ===
function checkWorkerPool() {
  const POOL_FILE = path.join(ROOT, 'memory', 'pool_status.json');
  if (!fs.existsSync(POOL_FILE)) {
    return { workers: [], busy: 0, idle: 0 };
  }
  const pool = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
  return {
    workers: pool.workers || [],
    busy: pool.workers.filter(w => w.status === 'busy').length,
    idle: pool.workers.filter(w => w.status === 'idle').length,
  };
}

module.exports = { issueOrder, reportTo, generalOODA, colonelOODA, mainLoop, checkWorkerPool };

// === CLI ===
if (require.main === module) {
  const loop = process.argv[2] === '--loop';
  
  mainLoop().then(() => {
    if (loop) {
      log('\n🔄 Следующий цикл через 5 минут...');
      setInterval(mainLoop, 5 * 60 * 1000);
    } else {
      process.exit(0);
    }
  }).catch(e => {
    log('❌ FATAL: ' + e.message);
    process.exit(1);
  });
}
