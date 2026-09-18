// clone_manager.js — Пилот / Клон / Отпечаток
// MVP: 1 клон на пилота, temp dir, EverOS fingerprint
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = __dirname;
const BOXES_DIR = path.join(ROOT, 'boxes');
const CLONES_TMP = '/tmp/phoenix_clones';
const REGISTRY = path.join(ROOT, 'memory', 'clones.json');
const RACES_DIR = path.join(ROOT, 'memory', 'races');

// === УТИЛИТЫ ===
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function loadRegistry() {
  ensureDir(path.dirname(REGISTRY));
  if (!fs.existsSync(REGISTRY)) return { active: [] };
  try { return JSON.parse(fs.readFileSync(REGISTRY, 'utf8')); }
  catch (e) { return { active: [] }; }
}

function saveRegistry(r) {
  fs.writeFileSync(REGISTRY, JSON.stringify(r, null, 2));
}

function log(msg) { console.log('🧬 ' + msg); }
function err(msg) { console.error('❌ ' + msg); }

// === ДНК ===
// Что копируем: всё кроме memory/, *.bak*, node_modules (симлинк)
const DNA_JS_FILES = [
  '_runner.js',
  'agent_loop_v3.js',
  'agent_responses.js',
  'agent_critic.js',
  'agent_tools.js',
  'agent_pilot.js',
  'agent_purpose.js',
  'agent_prophet.js',
  'agent_architect.js',
  'skills_loader.js',
  'rag_context.js',
  'deepseek_responses.js',
  'llm_client.js',
  'everos_client.js',
];

const DNA_JSON_FILES = [
  'agent_manifest.json',
  'BOX_META.json',
];

const SYMLINK_DIRS = [
  'node_modules',
  'skills',
  'skills_hub',
  'skills_graph',
];

function computeDnaHash(pilotBox) {
  const srcDir = path.join(BOXES_DIR, pilotBox);
  const hash = crypto.createHash('sha256');
  const entries = [];

  // JS файлы
  for (const f of DNA_JS_FILES) {
    const full = path.join(srcDir, f);
    if (fs.existsSync(full)) entries.push(full);
  }
  // JSON
  for (const f of DNA_JSON_FILES) {
    const full = path.join(srcDir, f);
    if (fs.existsSync(full)) entries.push(full);
  }
  // Prompts — вся папка
  const promptsDir = path.join(srcDir, 'prompts');
  if (fs.existsSync(promptsDir)) {
    for (const f of fs.readdirSync(promptsDir).sort()) {
      if (f.endsWith('.md') && !f.includes('.bak')) {
        entries.push(path.join(promptsDir, f));
      }
    }
  }

  for (const f of entries.sort()) {
    hash.update(path.basename(f));
    hash.update(fs.readFileSync(f));
  }

  return { hash: 'sha256:' + hash.digest('hex').slice(0, 16), files: entries.length };
}

function copyDNA(pilotBox, targetDir) {
  const srcDir = path.join(BOXES_DIR, pilotBox);
  ensureDir(targetDir);

  let copied = 0;

  // JS
  for (const f of DNA_JS_FILES) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetDir, f));
      copied++;
    }
  }

  // JSON
  for (const f of DNA_JSON_FILES) {
    const src = path.join(srcDir, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(targetDir, f));
      copied++;
    }
  }

  // .env
  const envFile = path.join(srcDir, '.env');
  if (fs.existsSync(envFile)) {
    fs.copyFileSync(envFile, path.join(targetDir, '.env'));
    copied++;
  }

  // prompts/
  const srcPrompts = path.join(srcDir, 'prompts');
  const dstPrompts = path.join(targetDir, 'prompts');
  if (fs.existsSync(srcPrompts)) {
    ensureDir(dstPrompts);
    for (const f of fs.readdirSync(srcPrompts)) {
      if (f.endsWith('.md') && !f.includes('.bak')) {
        fs.copyFileSync(path.join(srcPrompts, f), path.join(dstPrompts, f));
        copied++;
      }
    }
  }

  // Пустая memory/ — изоляция
  ensureDir(path.join(targetDir, 'memory', 'patterns'));
  ensureDir(path.join(targetDir, 'memory', 'races'));

  // Симлинки — общие ресурсы read-only
  for (const dir of SYMLINK_DIRS) {
    const src = path.join(ROOT, dir);
    const dst = path.join(targetDir, dir);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.symlinkSync(src, dst, 'dir'); copied++; }
      catch (e) { /* тихо */ }
    }
  }

  return copied;
}

// === КЛОНИРОВАНИЕ ===
function clone(pilotBox) {
  const srcDir = path.join(BOXES_DIR, pilotBox);
  if (!fs.existsSync(srcDir)) {
    err('Пилот ' + pilotBox + ' не найден в boxes/');
    return null;
  }

  const ts = Date.now();
  const cloneId = pilotBox + '_clone_' + ts;
  const tempDir = path.join(CLONES_TMP, cloneId);
  const symlinkPath = path.join(BOXES_DIR, cloneId);

  // Чистим если осталось
  if (fs.existsSync(tempDir)) execSync('rm -rf ' + JSON.stringify(tempDir));
  if (fs.existsSync(symlinkPath) || fs.lstatSync(symlinkPath, { throwIfNoEntry: false })) {
    try { fs.unlinkSync(symlinkPath); } catch (e) {}
  }

  log('Клонирую ' + pilotBox + ' → ' + cloneId);

  const copied = copyDNA(pilotBox, tempDir);
  const dnaInfo = computeDnaHash(pilotBox);
  const dnaHash = dnaInfo.hash;

  // Симлинк в boxes/ — для race.js
  fs.symlinkSync(tempDir, symlinkPath, 'dir');

  const entry = {
    clone_id: cloneId,
    pilot: pilotBox,
    dir: tempDir,
    symlink: symlinkPath,
    created_at: new Date().toISOString(),
    dna_hash: dnaHash,
    dna_files: dnaInfo.files,
    files_copied: copied,
    status: 'ready',
  };

  const reg = loadRegistry();
  reg.active = reg.active.filter(c => c.clone_id !== cloneId);
  reg.active.push(entry);
  saveRegistry(reg);

  log('✅ Готов: ' + cloneId);
  log('   ДНК: ' + dnaHash);
  log('   Файлов: ' + copied);
  log('   Race boxes: ' + cloneId);

  return entry;
}

// === СПИСОК ===
function list() {
  const reg = loadRegistry();
  if (!reg.active.length) {
    log('Активных клонов нет');
    return reg.active;
  }
  console.log('\n🧬 Активные клоны:');
  for (const c of reg.active) {
    console.log('  ' + c.clone_id);
    console.log('     pilot: ' + c.pilot + ' | status: ' + c.status);
    console.log('     dir:   ' + c.dir);
    console.log('     dna:   ' + c.dna_hash);
  }
  return reg.active;
}

// === ВОЗВРАТ ОПЫТА ===
function experience(cloneId, raceId) {
  const reg = loadRegistry();
  const entry = reg.active.find(c => c.clone_id === cloneId);
  if (!entry) {
    err('Клон ' + cloneId + ' не найден в реестре');
    return null;
  }

  const attempts = [];
  const insightsMap = new Map();

  // Паттерны: ищем race_<id>.json в КОРНЕ memory/patterns/ (там их пишет race.js)
  // Fallback: в клоне (если что-то успело записаться до clean)
  const patternFiles = [];

  if (raceId) {
    const rootPattern = path.join(ROOT, 'memory', 'patterns', raceId + '.json');
    if (fs.existsSync(rootPattern)) patternFiles.push(rootPattern);
  }

  const clonePatternsDir = path.join(entry.dir, 'memory', 'patterns');
  if (fs.existsSync(clonePatternsDir)) {
    for (const f of fs.readdirSync(clonePatternsDir)) {
      if (f.endsWith('.json')) patternFiles.push(path.join(clonePatternsDir, f));
    }
  }

  for (const patternFile of patternFiles) {
    try {
      const p = JSON.parse(fs.readFileSync(patternFile, 'utf8'));
      const r = (p.results || []).find(x => x.box === cloneId);
      if (r) {
        attempts.push({
          task: (p.task || '').slice(0, 200),
          ok: !!r.ok,
          score: r.score,
          time_ms: r.duration_ms,
          tools_used: r.tools_used || [],
        });
      }
      for (const ins of (p.insights || [])) {
        const key = ins.pattern || ins.text || JSON.stringify(ins).slice(0, 100);
        insightsMap.set(key, (insightsMap.get(key) || 0) + 1);
      }
    } catch (e) { /* тихо */ }
  }

  const okCount = attempts.filter(a => a.ok).length;
  const scores = attempts.map(a => a.score).filter(s => typeof s === 'number');
  const scoreAvg = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  const insights = [...insightsMap.entries()].map(([pattern, n]) => ({ pattern, n }));

  const delta = {
    clone_id: cloneId,
    pilot: entry.pilot,
    race_id: raceId || null,
    dna_hash: entry.dna_hash,
    attempts,
    insights,
    score_avg: scoreAvg ? +scoreAvg.toFixed(2) : null,
    ok_count: okCount,
    total_tasks: attempts.length,
    archived_at: new Date().toISOString(),
  };

  // 1. Дописываем в опыт пилота (JSONL append)
  const expFile = path.join(BOXES_DIR, entry.pilot, 'memory', 'experience.jsonl');
  ensureDir(path.dirname(expFile));
  fs.appendFileSync(expFile, JSON.stringify(delta) + '\n');

  // 2. Архив гонки
  if (raceId) {
    const raceDir = path.join(RACES_DIR, raceId);
    ensureDir(raceDir);
    fs.writeFileSync(
      path.join(raceDir, 'clone_snapshot.json'),
      JSON.stringify(delta, null, 2)
    );
  }

  // 3. EverOS — markdown fingerprint
  const everosResult = writeEverOSFingerprint(delta);

  // 4. Чистим temp + симлинк
  try {
    if (fs.existsSync(entry.symlink) || fs.lstatSync(entry.symlink, { throwIfNoEntry: false })) {
      fs.unlinkSync(entry.symlink);
    }
  } catch (e) {}
  try { execSync('rm -rf ' + JSON.stringify(entry.dir)); } catch (e) {}

  // 5. Обновляем реестр
  entry.status = 'done';
  entry.archived_at = delta.archived_at;
  const reg2 = loadRegistry();
  reg2.active = reg2.active.filter(c => c.clone_id !== cloneId);
  saveRegistry(reg2);

  log('✅ Опыт возвращён: ' + cloneId);
  log('   attempts: ' + attempts.length + ' | ok: ' + okCount + ' | score_avg: ' + (scoreAvg || '—'));
  log('   → boxes/' + entry.pilot + '/memory/experience.jsonl');
  if (raceId) log('   → memory/races/' + raceId + '/clone_snapshot.json');
  if (everosResult.ok) log('   → EverOS: ' + everosResult.path);
  else log('   ⚠️  EverOS: ' + (everosResult.error || 'skip'));
  log('   🧹 Temp очищен');

  return delta;
}

// === EverOS FINGERPRINT ===
function writeEverOSFingerprint(delta) {
  try {
    const EVEROS_ROOT = process.env.EVEROS_ROOT || '/home/ishidin/.everos';
    const date = new Date().toISOString().slice(0, 10);
    const agentDir = path.join(EVEROS_ROOT, 'aeon', 'phoenix', 'agents', delta.pilot);
    ensureDir(agentDir);
    const file = path.join(agentDir, date + '.md');

    const lines = [];
    lines.push('');
    lines.push('## ' + (delta.race_id || 'training') + ' — ' + new Date().toISOString());
    lines.push('');
    lines.push('**Pilot:** ' + delta.pilot);
    lines.push('**Clone:** ' + delta.clone_id);
    lines.push('**DNA:** ' + delta.dna_hash);
    lines.push('**Score avg:** ' + (delta.score_avg || '—') + ' (n=' + delta.total_tasks + ')');
    lines.push('**OK:** ' + delta.ok_count + '/' + delta.total_tasks);
    lines.push('');
    if (delta.attempts.length) {
      lines.push('### Attempts');
      for (const a of delta.attempts) {
        const icon = a.ok ? '✅' : '❌';
        lines.push('- ' + icon + ' ' + (a.task || '').slice(0, 80) +
          ' | score: ' + (a.score || '—') + ' | ' + (a.time_ms || '—') + 'ms');
      }
      lines.push('');
    }
    if (delta.insights.length) {
      lines.push('### Insights');
      for (const ins of delta.insights) {
        lines.push('- ' + ins.pattern + ' (n=' + ins.n + ')');
      }
      lines.push('');
    }

    fs.appendFileSync(file, lines.join('\n'));
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// === ОЧИСТКА ===
function cleanup(cloneId) {
  const reg = loadRegistry();
  const entry = reg.active.find(c => c.clone_id === cloneId);
  if (!entry) {
    err('Клон ' + cloneId + ' не найден');
    return false;
  }
  if (entry.status === 'racing') {
    err('Клон сейчас в гонке — не удаляю');
    return false;
  }

  try {
    if (fs.existsSync(entry.symlink) || fs.lstatSync(entry.symlink, { throwIfNoEntry: false })) {
      fs.unlinkSync(entry.symlink);
    }
  } catch (e) {}
  try { execSync('rm -rf ' + JSON.stringify(entry.dir)); } catch (e) {}

  const reg2 = loadRegistry();
  reg2.active = reg2.active.filter(c => c.clone_id !== cloneId);
  saveRegistry(reg2);

  log('🗑️  Удалён: ' + cloneId);
  return true;
}

// === CLI ===
if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === 'clone') {
    const pilot = args[0];
    if (!pilot) { err('Использование: clone <pilot>'); process.exit(1); }
    const r = clone(pilot);
    if (!r) process.exit(1);
  } else if (cmd === 'list') {
    list();
  } else if (cmd === 'experience') {
    const [cloneId, raceId] = args;
    if (!cloneId) { err('Использование: experience <clone_id> [race_id]'); process.exit(1); }
    const r = experience(cloneId, raceId);
    if (!r) process.exit(1);
  } else if (cmd === 'cleanup') {
    const cloneId = args[0];
    if (!cloneId) { err('Использование: cleanup <clone_id>'); process.exit(1); }
    cleanup(cloneId);
  } else {
    console.log('🧬 clone_manager.js — Pilot / Clone / Fingerprint');
    console.log('');
    console.log('  node clone_manager.js clone <pilot>               → создать клон');
    console.log('  node clone_manager.js list                        → список активных');
    console.log('  node clone_manager.js experience <id> [race_id]   → вернуть опыт + EverOS');
    console.log('  node clone_manager.js cleanup <id>                → удалить клон');
    console.log('');
    console.log('  Пример:');
    console.log('    node clone_manager.js clone agent_1');
    console.log('    RACE_BOXES=agent_1_clone_<ts>,agent_4,agent_7 node race.js');
    console.log('    node clone_manager.js experience agent_1_clone_<ts> race_<id>');
  }
}

module.exports = { clone, list, experience, cleanup, computeDnaHash };
