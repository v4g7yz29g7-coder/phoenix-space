'use strict';

/**
 * agent_box.js — изолированные "боксы" (песочницы) агента Aeon.
 *
 * createBox(name, options) — создаёт бокс в boxes/<name>/, копируя ключевые
 *   модули агента, skills/ и memory/patterns/, и добавляет BOX_META.json.
 * listBoxes()              — список боксов с метаданными.
 * deleteBox(name)          — удаляет бокс.
 * getBoxPath(name)         — абсолютный путь бокса.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --- Константы ---------------------------------------------------------

const ROOT = __dirname;                       // /home/ishidin/phoenix
const BOXES_DIR = path.join(ROOT, 'boxes');   // корень всех боксов
const LOGS_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'boxes.log');

// Файлы, которые копируются в каждый бокс (из корня проекта).
const COPY_FILES = [
  'agent_responses.js',
  'agent_tools.js',
  'agent_critic.js',
  'agent_loop_v3.js',
  'llm_client.js',
  'deepseek_responses.js',
  'everos_client.js',
  'agent_manifest.json'
];

// Директории, которые копируются целиком (рекурсивно).
const COPY_DIRS = [
  'skills',
  'memory/patterns'
];

// Директории/файлы, которые НЕ копируются, а линкуются (симлинк).
const SYMLINKS = [
  { target: 'node_modules', as: 'node_modules' }
];

const DEFAULT_EVEROS_USER_ID = 'ishidin';

// --- Утилиты -----------------------------------------------------------

/**
 * Лог в logs/boxes.log (append). Никогда не бросает исключений наружу.
 */
function log(message) {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (e) {
    // Логирование не должно ломать основную логику.
    console.error('[agent_box] log error:', e.message);
  }
}

/**
 * Валидация имени бокса: только безопасные символы, без слэшей и точек.
 */
function validateName(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('Box name must be a non-empty string');
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid box name "${name}": only letters, digits, "_" and "-" are allowed`
    );
  }
  return name;
}

/**
 * Защита: любой рабочий путь обязан лежать внутри BOXES_DIR.
 * Предотвращает выход за пределы boxes/ (path traversal).
 */
function assertInsideBoxes(targetPath) {
  const resolvedBoxes = path.resolve(BOXES_DIR);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedBoxes &&
    !resolvedTarget.startsWith(resolvedBoxes + path.sep)
  ) {
    throw new Error(`Path is outside boxes/: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

/**
 * Текущий commit родительского репозитория (или 'unknown').
 */
function getParentCommit() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (e) {
    log(`WARN could not resolve parent commit: ${e.message}`);
    return 'unknown';
  }
}

/**
 * Рекурсивное копирование с перезаписью (force: true).
 */
function copyInto(src, dest) {
  if (!fs.existsSync(src)) {
    log(`WARN source not found, skipped: ${src}`);
    return false;
  }
  fs.cpSync(src, dest, { recursive: true, force: true });
  return true;
}

// --- Публичный API -----------------------------------------------------

/**
 * Абсолютный путь бокса. Ничего не создаёт.
 */
function getBoxPath(name) {
  validateName(name);
  return assertInsideBoxes(path.join(BOXES_DIR, name));
}

/**
 * Создать бокс.
 *
 * @param {string} name              имя бокса (папка внутри boxes/)
 * @param {object} [options]
 * @param {boolean} [options.force]  перезаписать существующий бокс (по умолчанию true)
 * @param {string}  [options.everos_user_id]
 * @returns {{ok:boolean, name:string, path:string, meta:object, copied:string[], linked:string[], warnings:string[]}}
 */
function createBox(name, options = {}) {
  validateName(name);

  const force = options.force !== false; // по умолчанию true
  const boxPath = getBoxPath(name);
  const warnings = [];
  const copied = [];
  const linked = [];

  const created = fs.existsSync(boxPath);
  if (created && !force) {
    throw new Error(`Box "${name}" already exists (force=false)`);
  }

  // При force — очищаем предыдущее содержимое, но НЕ трогаем сам корень boxes/.
  if (created && force) {
    assertInsideBoxes(boxPath);
    fs.rmSync(boxPath, { recursive: true, force: true });
  }

  fs.mkdirSync(boxPath, { recursive: true });

  // 1. Копируем файлы.
  for (const file of COPY_FILES) {
    const src = path.join(ROOT, file);
    const dest = path.join(boxPath, file);
    if (copyInto(src, dest)) {
      copied.push(file);
    } else {
      warnings.push(`missing file: ${file}`);
    }
  }

  // 2. Копируем директории.
  for (const dir of COPY_DIRS) {
    const src = path.join(ROOT, dir);
    const dest = path.join(boxPath, dir);
    if (!fs.existsSync(src)) {
      warnings.push(`missing dir: ${dir}`);
      log(`WARN source dir not found, skipped: ${src}`);
      continue;
    }
    // Убеждаемся, что родительская папка dest существует.
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    copyInto(src, dest);
    copied.push(dir + '/');
  }

  // 3. Симлинки (node_modules — не копируем, линкуем).
  for (const link of SYMLINKS) {
    const target = path.join(ROOT, link.target);
    const linkPath = path.join(boxPath, link.as);
    if (!fs.existsSync(target)) {
      warnings.push(`missing symlink target: ${link.target}`);
      log(`WARN symlink target not found: ${target}`);
      continue;
    }
    try {
      fs.symlinkSync(target, linkPath, 'dir');
      linked.push(link.as + ' -> ' + target);
    } catch (e) {
      // Фолбэк: если symlink не удался — оставляем предупреждение.
      warnings.push(`symlink failed for ${link.as}: ${e.message}`);
      log(`WARN symlink failed for ${link.as}: ${e.message}`);
    }
  }

  // 4. Метаданные бокса.
  const meta = {
    name,
    created_at: new Date().toISOString(),
    parent_commit: getParentCommit(),
    everos_user_id: options.everos_user_id || process.env.EVEROS_USER_ID || DEFAULT_EVEROS_USER_ID
  };
  fs.writeFileSync(
    path.join(boxPath, 'BOX_META.json'),
    JSON.stringify(meta, null, 2) + '\n',
    'utf8'
  );

  log(
    `CREATE box="${name}" path="${boxPath}" force=${force} ` +
      `copied=${copied.length} linked=${linked.length} warnings=${warnings.length}`
  );

  return { ok: true, name, path: boxPath, meta, copied, linked, warnings };
}

/**
 * Список боксов с метаданными.
 */
function listBoxes() {
  if (!fs.existsSync(BOXES_DIR)) {
    return [];
  }

  const entries = fs.readdirSync(BOXES_DIR, { withFileTypes: true });
  const boxes = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const boxPath = path.join(BOXES_DIR, entry.name);
    let meta = null;
    const metaPath = path.join(boxPath, 'BOX_META.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (e) {
        log(`WARN failed to parse BOX_META.json for "${entry.name}": ${e.message}`);
      }
    }

    boxes.push({
      name: entry.name,
      path: boxPath,
      meta
    });
  }

  // Стабильная сортировка по имени.
  boxes.sort((a, b) => a.name.localeCompare(b.name));
  log(`LIST boxes=${boxes.length}`);
  return boxes;
}

/**
 * Удалить бокс.
 *
 * @param {string} name
 * @returns {{ok:boolean, name:string, path:string, existed:boolean}}
 */
function deleteBox(name) {
  validateName(name);
  const boxPath = getBoxPath(name);
  const existed = fs.existsSync(boxPath);

  if (existed) {
    assertInsideBoxes(boxPath);
    fs.rmSync(boxPath, { recursive: true, force: true });
    log(`DELETE box="${name}" path="${boxPath}"`);
  } else {
    log(`DELETE box="${name}" not found`);
  }

  return { ok: true, name, path: boxPath, existed };
}

module.exports = {
  createBox,
  listBoxes,
  deleteBox,
  getBoxPath,
  // вспомогательные (для тестов/отладки)
  BOXES_DIR,
  LOG_FILE
};
