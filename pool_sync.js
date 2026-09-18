// pool_sync.js — Синхронизация статусов задач с файловой системой
// Если файл существует и >= min_lines → completed
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const POOL = path.join(ROOT, 'tasks_night_pool.json');
const REPORT = path.join(ROOT, 'memory', 'pool_sync_report.json');

function log(m) { console.log('🔄 ' + m); }

// Читаем пул
const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
const tasks = pool.tasks || [];

let promoted = [];
let alreadyDone = 0;
let stillPending = [];
let stillFailed = [];
let missing = [];

for (const t of tasks) {
  const full = path.join(ROOT, t.file);
  const minLines = t.min_lines || 100;
  const exists = fs.existsSync(full);
  const size = exists ? fs.statSync(full).size : 0;

  // Считаем строки, если файл существует
  let lines = 0;
  if (exists && size > 0) {
    try {
      const content = fs.readFileSync(full, 'utf8');
      lines = content.split('\n').length;
    } catch (e) { lines = 0; }
  }

  const isDone = exists && lines >= minLines;
  const current = t.status || 'pending';

  // Промоутим completed если файл есть
  if (isDone && current !== 'completed') {
    t.status = 'completed';
    t.completed_at = t.completed_at || new Date().toISOString();
    t.promoted_by = 'pool_sync';
    t.actual_lines = lines;
    promoted.push({ id: t.id, file: t.file, lines, min: minLines });
  } else if (isDone && current === 'completed') {
    alreadyDone++;
  } else if (!exists && current !== 'completed') {
    missing.push({ id: t.id, file: t.file, status: current });
  } else if (exists && lines < minLines && current !== 'completed') {
    if (current === 'failed') stillFailed.push({ id: t.id, lines, min: minLines });
    else stillPending.push({ id: t.id, lines, min: minLines });
  } else if (current === 'completed' && !isDone) {
    // Файл был удалён — откатываем
    t.status = 'failed';
    t.failed_reason = 'file_removed_after_completion';
    stillFailed.push({ id: t.id, file: t.file });
  }
}

// Сохраняем
pool.updated_at = new Date().toISOString();
fs.writeFileSync(POOL, JSON.stringify(pool, null, 2));

// Сводка
const stats = {
  total: tasks.length,
  promoted: promoted.length,
  already_done: alreadyDone,
  still_pending: stillPending.length,
  still_failed: stillFailed.length,
  missing: missing.length,
  promoted_list: promoted,
  still_pending_list: stillPending,
  still_failed_list: stillFailed,
  missing_list: missing,
  ts: new Date().toISOString(),
};
fs.writeFileSync(REPORT, JSON.stringify(stats, null, 2));

// Отчёт
console.log('');
console.log('═══════════════════════════════════════');
console.log('  POOL SYNC REPORT');
console.log('═══════════════════════════════════════');
console.log(`  Всего задач:     ${stats.total}`);
console.log(`  ✅ Промоутил:    ${stats.promoted}`);
console.log(`  ✅ Уже было:     ${stats.already_done}`);
console.log(`  ⏳ Ещё pending:  ${stats.still_pending}`);
console.log(`  ❌ Failed:       ${stats.still_failed}`);
console.log(`  ⚠️  Нет файлов:  ${stats.missing}`);
console.log('');

if (promoted.length > 0) {
  console.log('🎉 Промоутил в completed:');
  for (const p of promoted) {
    console.log(`   ${p.id.padEnd(15)} ${p.file} (${p.lines}/${p.min})`);
  }
  console.log('');
}

if (missing.length > 0) {
  console.log('⚠️  Файлов нет (проверить):');
  for (const m of missing.slice(0, 10)) {
    console.log(`   ${m.id.padEnd(15)} ${m.file} [${m.status}]`);
  }
  if (missing.length > 10) console.log(`   ... и ещё ${missing.length - 10}`);
  console.log('');
}

console.log(`📋 Отчёт: ${REPORT}`);
