#!/usr/bin/env node
'use strict';

/**
 * memory/race_validator.js — валидатор протоколов гонок.
 * ============================================================================
 * Проблема: свежие гонки в статусе «agent: —, time: —s» — протоколы пишутся
 * пустыми (winner=null, пустые/битые results). Нужна проверка полей.
 *
 * Контракт:
 *   validateRace(obj) -> { ok:boolean, missing:string[], empty:boolean,
 *                          agents:number, duration_ms:number }
 *       ok        — true, если протокол валиден (нет пропущенных полей).
 *       missing   — список отсутствующих/некорректных полей.
 *   scan(dir) -> { total, empty, valid, broken, invalid, files:{...} }
 *
 * Правила (КРИТЕРИЙ):
 *   1. winner            — непустая строка (победитель определён);
 *   2. duration_ms       — у каждой гонки/агента duration_ms > 0;
 *   3. agents            — минимум 1 агент (results.length >= 1).
 *
 * Запуск CLI:  node memory/race_validator.js [dir]
 *   node memory/race_validator.js                 # memory/races (по умолчанию)
 *   node memory/race_validator.js memory/races
 *
 * Dependency-free: только встроенные модули Node.js.
 */

const fs = require('fs');
const path = require('path');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Проверяет один объект протокола гонки.
 * @param {*} obj распарсенный JSON протокола
 * @returns {{ok:boolean, missing:string[], empty:boolean, agents:number, duration_ms:number}}
 */
function validateRace(obj) {
  if (!isObj(obj)) {
    return {
      ok: false,
      missing: ['__object__'],
      empty: true,
      agents: 0,
      duration_ms: 0,
    };
  }

  const missing = [];

  // 1. winner — непустая строка
  const winner = obj.winner;
  if (typeof winner !== 'string' || winner.trim() === '') {
    missing.push('winner');
  }

  // 3. agents — минимум 1 участник
  const results = Array.isArray(obj.results) ? obj.results : [];
  const agents = results.length;
  if (agents < 1) {
    missing.push('agents');
  }

  // 2. duration_ms > 0 у каждой гонки/агента
  let maxDuration = 0;
  let durationOk = 0;
  results.forEach((r, i) => {
    const d = isObj(r) ? r.duration_ms : undefined;
    if (typeof d === 'number' && isFinite(d) && d > 0) {
      durationOk += 1;
      if (d > maxDuration) maxDuration = d;
    } else {
      missing.push('results[' + i + '].duration_ms');
    }
  });

  // Если агенты есть, но ни у одного нет валидного duration_ms —
  // фиксируем обобщённый пропуск поля.
  if (agents >= 1 && durationOk === 0 && !missing.some((m) => m.startsWith('results['))) {
    missing.push('duration_ms');
  }

  const ok = missing.length === 0;
  return {
    ok,
    missing,
    empty: !ok,
    agents,
    duration_ms: maxDuration,
  };
}

/**
 * Читает и проверяет объект из файла. Битый JSON -> broken=true.
 * @param {string} file
 * @returns {{file:string, broken:boolean, result:object}}
 */
function validateFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return {
      file,
      broken: true,
      result: { ok: false, missing: ['__read__'], empty: true, agents: 0, duration_ms: 0 },
    };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return {
      file,
      broken: true,
      result: { ok: false, missing: ['__json__'], empty: true, agents: 0, duration_ms: 0 },
    };
  }
  return { file, broken: false, result: validateRace(obj) };
}

/**
 * Сканирует директорию с протоколами и возвращает сводку.
 * @param {string} dir путь к memory/races
 * @returns {{total:number, empty:number, valid:number, broken:number, invalid:number,
 *            files:{valid:string[], empty:string[], broken:string[]}}}
 */
function scan(dir) {
  const summary = {
    total: 0,
    empty: 0,
    valid: 0,
    broken: 0,
    invalid: 0,
    files: { valid: [], empty: [], broken: [] },
  };

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return summary; // каталога нет — пустая сводка
  }

  const jsonFiles = entries
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort();

  summary.total = jsonFiles.length;

  for (const name of jsonFiles) {
    const full = path.join(dir, name);
    const { broken, result } = validateFile(full);
    if (broken) {
      summary.broken += 1;
      summary.empty += 1; // битый = невалидный протокол
      summary.files.broken.push(name);
      summary.files.empty.push(name); // пустой = всё, что не valid
      continue;
    }
    if (result.ok) {
      summary.valid += 1;
      summary.files.valid.push(name);
    } else {
      summary.empty += 1;
      summary.invalid += 1;
      summary.files.empty.push(name);
    }
  }

  return summary;
}

module.exports = { validateRace, validateFile, scan };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, 'races');
  const s = scan(dir);
  console.log('📊 Race validator: ' + dir);
  console.log('  total : ' + s.total);
  console.log('  valid : ' + s.valid);
  console.log('  empty : ' + s.empty + (s.invalid ? ' (' + s.invalid + ' invalid)' : ''));
  console.log('  broken: ' + s.broken);
  if (s.total > 0) {
    const pct = ((s.valid / s.total) * 100).toFixed(1);
    console.log('  valid%: ' + pct + '%');
  }
  process.exitCode = s.total > 0 && s.valid > 0 ? 0 : 1;
}
