// arena/team_builder.js — превращает пользовательскую модель в бокс для гонки
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_BOX = path.join(ROOT, 'boxes', 'agent_1');  // эталон для копирования
const USERS_DIR = path.join(ROOT, 'boxes', 'users');

// Файлы, которые копируем из agent_1 в новый бокс
const BASE_FILES = [
  '_runner.js',
  'agent_loop_v3.js',
  'agent_critic.js',
  'agent_responses.js',
  'agent_tools.js',
  'deepseek_responses.js',
  'llm_client.js',
  'rag_context.js',
  'everos_client.js',
  'skills_loader.js',
  '.env',
];

// Симлинки на общие ресурсы
const SYMLINK_DIRS = [
  ['node_modules', path.join(ROOT, 'node_modules')],
  ['skills_hub', path.join(ROOT, 'skills_hub')],
  ['skills_graph', path.join(ROOT, 'skills_graph')],
  ['research', path.join(ROOT, 'research')],
  ['corpus', path.join(ROOT, 'corpus')],
];

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

/**
 * Создаёт бокс из модели пользователя.
 * @param {string} userId — UUID пользователя
 * @param {string} modelId — id модели (model_<ts>)
 * @param {object} modelRecord — запись из arena_models.json (пути к файлам)
 * @returns {{ok: boolean, boxPath?: string, boxName?: string, error?: string}}
 */
function buildBoxFromModel(userId, modelId, modelRecord) {
  try {
    const modelDir = path.join(ROOT, modelRecord.path);
    if (!fs.existsSync(modelDir)) {
      return { ok: false, error: 'Model dir not found: ' + modelDir };
    }

    const ts = Date.now();
    const boxName = 'team_' + modelId.replace('model_', '') + '_' + String(ts).slice(-6);
    const runtimeDir = path.join(USERS_DIR, 'user_' + userId, '_runtime');
    const boxPath = path.join(runtimeDir, boxName);

    // Чистим если уже есть
    if (fs.existsSync(boxPath)) {
      fs.rmSync(boxPath, { recursive: true, force: true });
    }
    ensureDir(boxPath);

    // 1. Копируем базовые файлы
    for (const f of BASE_FILES) {
      const src = path.join(BASE_BOX, f);
      if (fs.existsSync(src)) {
        copyFile(src, path.join(boxPath, f));
      }
    }

    // 2. Создаём пустую memory/
    ensureDir(path.join(boxPath, 'memory', 'patterns'));
    ensureDir(path.join(boxPath, 'memory', 'races'));

    // 3. Симлинки на общие ресурсы
    for (const [name, target] of SYMLINK_DIRS) {
      const dst = path.join(boxPath, name);
      if (!fs.existsSync(dst)) {
        try { fs.symlinkSync(target, dst, 'dir'); } catch (e) {}
      }
    }

    // 4. Skills: если у пользователя есть skills/ — используем их; иначе симлинк на общий
    const userSkillsDir = path.join(modelDir, 'skills');
    const boxSkillsDir = path.join(boxPath, 'skills');
    if (fs.existsSync(userSkillsDir)) {
      // Копируем skills пользователя
      ensureDir(boxSkillsDir);
      const copySkills = (src, dst) => {
        for (const f of fs.readdirSync(src)) {
          const s = path.join(src, f);
          const d = path.join(dst, f);
          if (fs.statSync(s).isDirectory()) {
            ensureDir(d);
            copySkills(s, d);
          } else {
            fs.copyFileSync(s, d);
          }
        }
      };
      copySkills(userSkillsDir, boxSkillsDir);
    } else {
      // Симлинк на общий skills/
      try { fs.symlinkSync(path.join(ROOT, 'skills'), boxSkillsDir, 'dir'); } catch (e) {}
    }

    // 5. ДНК пользователя → prompts/<boxName>.md (это то, что читает agent_responses.js)
    ensureDir(path.join(boxPath, 'prompts'));
    const systemPrompt = path.join(modelDir, 'system_prompt.md');
    let dnaContent = '';
    if (fs.existsSync(systemPrompt)) {
      dnaContent = fs.readFileSync(systemPrompt, 'utf8');
    } else {
      // Fallback: собираем из manifest
      const manifest = path.join(modelDir, 'manifest.json');
      dnaContent = '# ' + (modelRecord.name || 'Agent') + '\n\n';
      if (fs.existsSync(manifest)) {
        try {
          const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
          dnaContent = '# ' + (m.name || 'Agent') + ' v' + (m.version || '0.0.0') + '\n\n';
          if (m.description) dnaContent += m.description + '\n\n';
          if (m.strategy) dnaContent += 'Стратегия: ' + m.strategy + '\n';
        } catch (e) {}
      }
    }
    // Двойное сохранение: и под именем бокса (как читает runner), и как agent.md (для совместимости)
    fs.writeFileSync(path.join(boxPath, 'prompts', boxName + '.md'), dnaContent);
    fs.writeFileSync(path.join(boxPath, 'prompts', 'agent.md'), dnaContent);

    // 6. BOX_META.json
    fs.writeFileSync(path.join(boxPath, 'BOX_META.json'), JSON.stringify({
      name: boxName,
      owner_user_id: userId,
      source_model_id: modelId,
      created_at: new Date().toISOString(),
      kind: 'user_model',
    }, null, 2));

    // 7. Симлинк в boxes/ — race.js ищет боксы как boxes/<name>
    const boxSymlink = path.join(ROOT, 'boxes', boxName);
    try {
      if (fs.existsSync(boxSymlink) || fs.lstatSync(boxSymlink, { throwIfNoEntry: false })) {
        fs.unlinkSync(boxSymlink);
      }
      fs.symlinkSync(boxPath, boxSymlink, 'dir');
    } catch (e) {
      console.error('[team_builder] symlink error:', e.message);
    }

    return { ok: true, boxPath, boxName, boxSymlink };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Удаляет бокс после гонки.
 */
function cleanupBox(boxPath, boxName) {
  try {
    // 1. Удалить симлинк
    if (boxName) {
      const link = path.join(ROOT, 'boxes', boxName);
      try {
        if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
          fs.unlinkSync(link);
        }
      } catch (e) {}
    }
    // 2. Удалить реальную папку
    if (fs.existsSync(boxPath)) {
      fs.rmSync(boxPath, { recursive: true, force: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { buildBoxFromModel, cleanupBox };

// CLI-тест
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Использование: node arena/team_builder.js <user_id> <model_id>');
    process.exit(0);
  }
  const [userId, modelId] = args;
  const registry = require(path.join(ROOT, 'memory', 'arena_models.json'));
  const model = registry[modelId];
  if (!model) { console.error('Model not found'); process.exit(1); }
  const r = buildBoxFromModel(userId, modelId, model);
  console.log(JSON.stringify(r, null, 2));
}
