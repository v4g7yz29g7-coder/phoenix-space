// stadium.js — Aeon Stadium: изолированные песочницы для экспериментов
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = '/home/ishidin/phoenix';
const ARENA = path.join(ROOT, 'arena');
const SANDBOXES = path.join(ARENA, 'sandboxes');
const RESULTS = path.join(ARENA, 'results');
const LOG = path.join(ARENA, 'logs', 'stadium.log');

// Файлы, которые КОПИРУЕМ в sandbox (симлинки — для node_modules)
const COPY_FILES = [
  'agent_responses.js', 'agent_tools.js', 'agent_critic.js',
  'agent_loop_v3.js', 'agent_pilot.js', 'agent_prophet.js',
  'agent_architect.js', 'agent_purpose.js',
  'deepseek_responses.js', 'llm_client.js', 'skills_loader.js',
  'rag_context.js', 'everos_client.js',
  'race.js', 'race_engineer.js', 'performance_engineer.js',
  'champion_tracker.js', 'smart_race.js', 'mission_control.js',
  'p2p_share.js', 'phoenix_guide.js',
  '.env', 'package.json', 'agent_manifest.json',
  'tasks_pool.json'
];

const COPY_DIRS = ['skills', 'prompts', 'memory'];

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch (e) {}
}

// Создаёт sandbox с указанным именем
function createSandbox(name) {
  const sbPath = path.join(SANDBOXES, name);
  if (fs.existsSync(sbPath)) {
    log('⚠️  sandbox ' + name + ' уже существует — удаляю');
    fs.rmSync(sbPath, { recursive: true, force: true });
  }
  fs.mkdirSync(sbPath, { recursive: true });

  // 1. Копируем файлы
  let copied = 0;
  for (const f of COPY_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(sbPath, f));
      copied++;
    }
  }

  // 2. Копируем папки (кроме node_modules)
  for (const d of COPY_DIRS) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) {
      copyDir(src, path.join(sbPath, d));
    }
  }

  // 3. Симлинк на node_modules (экономия места!)
  const nmLink = path.join(sbPath, 'node_modules');
  if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), nmLink);
  }

  // 4. Копируем boxes/ — обязательно для race.js
  const boxesSrc = path.join(ROOT, 'boxes');
  if (fs.existsSync(boxesSrc)) {
    const boxesDest = path.join(sbPath, 'boxes');
    fs.mkdirSync(boxesDest, { recursive: true });
    const boxNames = fs.readdirSync(boxesSrc, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('agent_'))
      .map(e => e.name);

    for (const boxName of boxNames) {
      const boxSrc = path.join(boxesSrc, boxName);
      const boxDest = path.join(boxesDest, boxName);
      fs.mkdirSync(boxDest, { recursive: true });

      // Копируем все .js и .json (кроме node_modules и skills)
      const entries = fs.readdirSync(boxSrc, { withFileTypes: true });
      for (const e of entries) {
        const s = path.join(boxSrc, e.name);
        const d = path.join(boxDest, e.name);
        if (e.name === 'node_modules') continue;
        if (e.name === 'skills' || e.name === 'skills_hub') continue;
        if (e.isFile()) {
          try { fs.copyFileSync(s, d); } catch (err) {}
        } else if (e.isDirectory()) {
          copyDir(s, d);
        }
      }

      // Симлинки для тяжёлых папок
      if (fs.existsSync(path.join(boxSrc, 'node_modules'))) {
        try { fs.symlinkSync(path.join(boxSrc, 'node_modules'), path.join(boxDest, 'node_modules')); } catch (e) {}
      } else if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
        try { fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(boxDest, 'node_modules')); } catch (e) {}
      }
      if (fs.existsSync(path.join(ROOT, 'skills'))) {
        try { fs.symlinkSync(path.join(ROOT, 'skills'), path.join(boxDest, 'skills')); } catch (e) {}
      }
      if (fs.existsSync(path.join(ROOT, 'skills_hub'))) {
        try { fs.symlinkSync(path.join(ROOT, 'skills_hub'), path.join(boxDest, 'skills_hub')); } catch (e) {}
      }
    }
    log('   Скопировано boxes: ' + boxNames.length + ' (' + boxNames.join(', ') + ')');
  }

  // 4. Мета
  const meta = {
    name,
    created_at: new Date().toISOString(),
    parent_commit: execSync('cd ' + ROOT + ' && git rev-parse HEAD', { encoding: 'utf8' }).trim(),
    files_copied: copied,
    type: 'sandbox'
  };
  fs.writeFileSync(path.join(sbPath, 'SANDBOX_META.json'), JSON.stringify(meta, null, 2));

  log('✅ Sandbox создан: ' + name + ' (' + copied + ' файлов)');
  return { ok: true, path: sbPath, meta };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      copyDir(s, d);
    } else if (e.isFile()) {
      try { fs.copyFileSync(s, d); } catch (err) {}
    }
  }
}

// Запускает эксперимент в sandbox
function runExperiment(sandboxName, task, options = {}) {
  const sbPath = path.join(SANDBOXES, sandboxName);
  if (!fs.existsSync(sbPath)) {
    return { ok: false, error: 'sandbox не существует: ' + sandboxName };
  }

  const expId = 'exp_' + Date.now();
  const expFile = path.join(RESULTS, expId + '.json');
  const start = Date.now();

  log('🧪 Эксперимент ' + expId + ' в ' + sandboxName);
  log('   Задача: ' + task.slice(0, 100));

  let result;
  try {
    // Запускаем race.js внутри sandbox
    const output = execSync('node race.js', {
      cwd: sbPath,
      encoding: 'utf8',
      timeout: 600000,
      maxBuffer: 50 * 1024 * 1024,
      env: {
        ...process.env,
        EARLY_STOP: options.earlyStop ? 'true' : 'false',
        RACE_BOXES: options.boxes || 'agent_1,agent_3,agent_7',
        RACE_TASK: task
      }
    });

    const duration = Date.now() - start;

    // Извлекаем race_id из вывода и читаем протокол
    const raceMatch = output.match(/race_\d+/);
    let raceData = null;
    if (raceMatch) {
      // Ищем race-файл в sandbox — может быть несколько, берём последний
      const racesDir = path.join(sbPath, 'memory', 'races');
      if (fs.existsSync(racesDir)) {
        const files = fs.readdirSync(racesDir).filter(f => f.endsWith('.json')).sort();
        if (files.length > 0) {
          const latest = files[files.length - 1];
          try {
            raceData = JSON.parse(fs.readFileSync(path.join(racesDir, latest), 'utf8'));
          } catch (e) { console.error('parse race error:', e.message); }
        }
      }
    }

    result = {
      ok: true,
      exp_id: expId,
      sandbox: sandboxName,
      task: task.slice(0, 300),
      duration_ms: duration,
      race_id: raceMatch ? raceMatch[0] : null,
      winner: raceData ? raceData.winner : null,
      winner_score: raceData ? raceData.winner_score : null,
      results: raceData ? raceData.results : null,
      p2p: raceData ? raceData.p2p : null,
      raw_output: output.slice(-2000)
    };

    log('✅ Эксперимент завершён за ' + duration + 'ms');
  } catch (e) {
    result = {
      ok: false,
      exp_id: expId,
      sandbox: sandboxName,
      task: task.slice(0, 300),
      duration_ms: Date.now() - start,
      error: e.message.slice(0, 500)
    };
    log('❌ Эксперимент упал: ' + e.message.slice(0, 200));
  }

  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(expFile, JSON.stringify(result, null, 2));
  log('📄 Результат: ' + expFile);
  return result;
}

// Список sandbox'ов
function listSandboxes() {
  if (!fs.existsSync(SANDBOXES)) return [];
  return fs.readdirSync(SANDBOXES, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const metaPath = path.join(SANDBOXES, e.name, 'SANDBOX_META.json');
      let meta = null;
      try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (err) {}
      return { name: e.name, path: path.join(SANDBOXES, e.name), meta };
    });
}

// Удаление sandbox
function deleteSandbox(name) {
  const sbPath = path.join(SANDBOXES, name);
  if (!fs.existsSync(sbPath)) return { ok: false, error: 'not found' };
  fs.rmSync(sbPath, { recursive: true, force: true });
  log('🗑️  Sandbox удалён: ' + name);
  return { ok: true };
}

module.exports = { createSandbox, runExperiment, listSandboxes, deleteSandbox };

// CLI
if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'create') {
    console.log(JSON.stringify(createSandbox(args[0] || 'sandbox_1'), null, 2));
  } else if (cmd === 'list') {
    console.log(JSON.stringify(listSandboxes(), null, 2));
  } else if (cmd === 'run') {
    console.log(JSON.stringify(runExperiment(args[0], args.slice(1).join(' ')), null, 2));
  } else if (cmd === 'delete') {
    console.log(JSON.stringify(deleteSandbox(args[0]), null, 2));
  } else {
    console.log('Usage:');
    console.log('  node stadium.js create <name>');
    console.log('  node stadium.js list');
    console.log('  node stadium.js run <name> "task"');
    console.log('  node stadium.js delete <name>');
  }
}
