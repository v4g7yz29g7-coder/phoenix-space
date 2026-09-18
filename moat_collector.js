'use strict';
// moat_collector.js — собирает удачные решения в Ров
// Запуск: node moat_collector.js
// Логика: проходит по memory/races/*.json, берёт winner+score>=7, сохраняет в memory/moat/solutions/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const RACES_DIR = path.join(ROOT, 'memory', 'races');
const MOAT_DIR = path.join(ROOT, 'memory', 'moat');
const SOLUTIONS_DIR = path.join(MOAT_DIR, 'solutions');
const INDEX_FILE = path.join(MOAT_DIR, 'index.json');
const LOG_FILE = path.join(MOAT_DIR, 'collector.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function ensureDirs() {
  for (const d of [MOAT_DIR, SOLUTIONS_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) return { version: '1.0', solutions: [], updated_at: null };
  try { return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); }
  catch (e) { return { version: '1.0', solutions: [], updated_at: null }; }
}

function saveIndex(idx) {
  idx.updated_at = new Date().toISOString();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2));
}

function hashSolution(task, winner) {
  // Хэш: файл + тип задачи + первые 100 символов промпта
  const key = (task.file || '') + '|' + (winner.box || '') + '|' + (task.prompt || '').slice(0, 100);
  return crypto.createHash('md5').update(key).digest('hex').slice(0, 12);
}

function extractFile(task) {
  if (!task || !task.prompt) return null;
  const m = task.prompt.match(/[a-zA-Z0-9_\-/]+\.(js|md|json|ts)/);
  return m ? m[0] : null;
}

function collect() {
  ensureDirs();
  const index = loadIndex();
  const existingHashes = new Set(index.solutions.map(s => s.hash));

  const files = fs.readdirSync(RACES_DIR).filter(f => f.endsWith('.json'));
  let added = 0;
  let skipped = 0;

  for (const f of files) {
    try {
      const race = JSON.parse(fs.readFileSync(path.join(RACES_DIR, f), 'utf8'));
      if (!race.winner || race.winner_score === null || race.winner_score < 7) { skipped++; continue; }
      if (!race.task || typeof race.task !== 'string') { skipped++; continue; }
      if (race.task.indexOf('\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u0439') === 0) { skipped++; continue; }

      const taskFile = extractFile({ prompt: race.task });
      if (!taskFile) { skipped++; continue; }

      const winnerResult = (race.results || []).find(r => r.box === race.winner);
      if (!winnerResult || !winnerResult.answer || !winnerResult.ok) { skipped++; continue; }

      const hash = hashSolution({ file: taskFile, prompt: race.task }, { box: race.winner });
      if (existingHashes.has(hash)) continue;

      const solution = {
        hash,
        race_id: race.race_id,
        ts: race.ts,
        task_file: taskFile,
        task_prompt: race.task.slice(0, 500),
        winner: race.winner,
        winner_score: race.winner_score,
        winner_time_ms: race.winner_time || winnerResult.duration_ms,
        answer: (winnerResult.answer || '').slice(0, 10000),
        steps_count: winnerResult.steps_count || 0,
        collected_at: new Date().toISOString(),
      };

      fs.writeFileSync(path.join(SOLUTIONS_DIR, hash + '.json'), JSON.stringify(solution, null, 2));
      index.solutions.push({
        hash,
        race_id: race.race_id,
        task_file: taskFile,
        winner: race.winner,
        winner_score: race.winner_score,
        ts: race.ts,
      });
      existingHashes.add(hash);
      added++;
    } catch (e) {
      // битый файл — пропускаем
    }
  }

  saveIndex(index);
  log(`Собрано: ${added} новых | Индекс: ${index.solutions.length} | Пропущено: ${skipped}`);
  return { added, total: index.solutions.length, skipped };
}

if (require.main === module) collect();
module.exports = { collect, loadIndex };
