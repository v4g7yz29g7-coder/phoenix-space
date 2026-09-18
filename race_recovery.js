#!/usr/bin/env node
/**
 * race_recovery.js — Авто-восстановление незавершённых гонок.
 *
 * При старте сканирует race_*.json (или equivalent store), находит записи
 * без поля winner, у которых finished_at старше 90 секунд, и помечает их
 * status='abandoned', записывая причину (timeout / no_runner / crash).
 *
 * Эвристика причины:
 *   crash     — файл нечитаем / невалидный JSON;
 *   timeout   — возраст > 600с без завершения;
 *   no_runner — нет финального события ни от одного агента (нет ok/score/verdict);
 *   crash     — рекорд есть, финал есть, но гонка всё равно без winner.
 *
 * CLI:
 *   node race_recovery.js --dry-run [dir]   # печатает таблицу id|age|reason|action
 *   node race_recovery.js [dir]             # пишет изменения + backup .bak
 *
 * Каждое действие логируется строкой: [RECOVERY] <id> <reason>
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STALE_MS = 90 * 1000;     // записи свежее 90с не трогаем
const TIMEOUT_MS = 600 * 1000;  // > 600с без финала → timeout

// --- Парсинг аргументов -----------------------------------------------------
function parseArgs(argv) {
  const args = argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dir = args.find((a) => !a.startsWith('--')) || null;
  return { dryRun, dir };
}

// --- Выбор каталога хранилища гонок ----------------------------------------
// 1) явный аргумент; 2) memory/races; 3) текущий каталог.
function resolveDir(dirArg) {
  if (dirArg) return path.resolve(dirArg);
  const candidates = [path.join(__dirname, 'memory', 'races'), process.cwd()];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch (_) { /* next */ }
  }
  return process.cwd();
}

// --- Возраст записи в мс ----------------------------------------------------
function recordAgeMs(rec, stat) {
  const candidates = [rec && rec.finished_at, rec && rec.finishedAt, rec && rec.ts, rec && rec.started_at];
  for (const c of candidates) {
    if (c === undefined || c === null) continue;
    if (typeof c === 'number') return Date.now() - c;
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return Date.now() - t;
  }
  // fallback — mtime файла
  return stat ? Date.now() - stat.mtimeMs : 0;
}

// --- Эвристика причины ------------------------------------------------------
function classify(rec, parsed, ageMs) {
  if (!parsed) return 'crash';
  if (ageMs > TIMEOUT_MS) return 'timeout';
  const results = Array.isArray(rec.results) ? rec.results : [];
  const anyFinal = results.some(
    (r) => r && (r.ok === true || typeof r.score === 'number' || typeof r.verdict === 'string')
  );
  if (!anyFinal) return 'no_runner';
  return 'crash';
}

// --- Похоже ли на гонку -----------------------------------------------------
function looksLikeRace(rec) {
  return rec && typeof rec === 'object' && (
    'race_id' in rec || 'winner' in rec || Array.isArray(rec.results) ||
    'finished_at' in rec || 'finishedAt' in rec
  );
}

// --- Список кандидатов ------------------------------------------------------
function listRaceFiles(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json') && !n.endsWith('.bak'))
    // приоритет race_*.json, но берём и эквивалентные записи (с одним race-объектом)
    .map((n) => path.join(dir, n));
}

function isFinished(rec) {
  return rec && rec.winner !== undefined && rec.winner !== null && rec.winner !== '';
}

// --- Анализ одного файла ----------------------------------------------------
function analyzeFile(filePath) {
  const id = path.basename(filePath, '.json');
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { stat = null; }

  let raw = null;
  let rec = null;
  let parsed = true;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
    rec = JSON.parse(raw);
  } catch (_) {
    parsed = false;
  }

  if (parsed && !looksLikeRace(rec)) return null; // не гонка
  if (parsed && isFinished(rec)) return null;      // уже завершена

  const raceId = (rec && (rec.race_id || rec.id)) || id;
  const ageMs = recordAgeMs(rec || {}, stat);
  const ageSec = Math.max(0, Math.round(ageMs / 1000));

  if (parsed && ageMs < STALE_MS) return null;     // слишком свежая

  const reason = classify(rec || {}, parsed, ageMs);
  return { filePath, raceId, rec, parsed, raw, ageSec, reason };
}

// --- Запись изменений (с backup .bak) ---------------------------------------
function applyRecovery(item, log) {
  const backup = item.filePath + '.bak';
  try {
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, item.raw != null ? item.raw : '', 'utf8');
  } catch (e) {
    log(`[RECOVERY] ${item.raceId} ${item.reason} backup-failed:${e.message}`);
  }

  const rec = item.parsed && item.rec ? item.rec : {};
  rec.status = 'abandoned';
  rec.reason = item.reason;
  rec.abandoned_at = new Date().toISOString();
  try {
    fs.writeFileSync(item.filePath, JSON.stringify(rec, null, 2), 'utf8');
  } catch (e) {
    log(`[RECOVERY] ${item.raceId} ${item.reason} write-failed:${e.message}`);
  }
}

// --- Основная функция восстановления ----------------------------------------
function recoverRaces(opts = {}) {
  const dir = resolveDir(opts.dir || null);
  const dryRun = !!opts.dryRun;
  const lines = [];
  const log = opts.log || ((s) => { console.log(s); lines.push(s); });

  const files = listRaceFiles(dir);
  const findings = [];
  for (const f of files) {
    const item = analyzeFile(f);
    if (item) findings.push(item);
  }

  // Таблица для dry-run
  if (dryRun) {
    console.log('id|age|reason|action');
    for (const it of findings) {
      console.log(`${it.raceId}|${it.ageSec}s|${it.reason}|would_abandon`);
    }
  } else {
    for (const it of findings) {
      applyRecovery(it, log);
      log(`[RECOVERY] ${it.raceId} ${it.reason}`);
    }
    console.log(`Отсканировано: ${files.length}, помечено abandoned: ${findings.length}, dir=${dir}`);
  }

  return { dir, scanned: files.length, recovered: findings.length, findings, lines };
}

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const { dryRun, dir } = parseArgs(process.argv);
  recoverRaces({ dryRun, dir });
}

module.exports = { recoverRaces, analyzeFile, classify, recordAgeMs, resolveDir };
