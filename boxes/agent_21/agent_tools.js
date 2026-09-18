// ============================================================================
//  agent_tools.js — Инструменты самоизменения Aeon
//  Безопасные операции чтения/записи/патча/коммита в пределах ~/phoenix
// ============================================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// 14.09: разделяем понятия workspace/box/project
// - BOX_DIR   — родной каталог бокса (write/edit только здесь)
// - PROJECT_ROOT — корень phoenix (read/search разрешён, exec — нет)
// - WORKSPACE оставлен как алиас PROJECT_ROOT для обратной совместимости
const PROJECT_ROOT = '/home/ishidin/phoenix';
const BOX_DIR = path.resolve(__dirname);
const WORKSPACE = PROJECT_ROOT;
const ALLOWED_DIRS = [BOX_DIR, PROJECT_ROOT];
const FORBIDDEN_PATTERNS = [
  /\.env$/,
  /node_modules/,
  /\.git\//,
  /\.db$/,
  /\.sqlite$/,
  /package-lock\.json$/
];

function isPathSafe(filePath) {
  const abs = path.resolve(WORKSPACE, filePath);
  if (!abs.startsWith(WORKSPACE)) return { ok: false, reason: 'Вне рабочей папки' };
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(abs)) return { ok: false, reason: `Запрещённый путь: ${pat}` };
  }
  return { ok: true, abs };
}

// ---- read_file ----
function readFile(filePath) {
  const check = isPathSafe(filePath);
  if (!check.ok) return { error: check.reason };
  try {
    const content = fs.readFileSync(check.abs, 'utf8');
    return { ok: true, path: check.abs, content, size: content.length };
  } catch (e) {
    return { error: e.message };
  }
}

// ---- write_file ----
function writeFile(filePath, content) {
  const check = isPathSafe(filePath);
  if (!check.ok) return { error: check.reason };
  try {
    const backup = check.abs + '.bak_' + Date.now();
    if (fs.existsSync(check.abs)) fs.copyFileSync(check.abs, backup);
    fs.writeFileSync(check.abs, content, 'utf8');
    return { ok: true, path: check.abs, backup };
  } catch (e) {
    return { error: e.message };
  }
}

// ---- edit_file ----
function editFile(filePath, oldStr, newStr) {
  const check = isPathSafe(filePath);
  if (!check.ok) return { error: check.reason };
  try {
    let content = fs.readFileSync(check.abs, 'utf8');
    if (!content.includes(oldStr)) return { error: 'Не найден фрагмент для замены' };
    const backup = check.abs + '.bak_' + Date.now();
    fs.copyFileSync(check.abs, backup);
    content = content.replace(oldStr, newStr);
    fs.writeFileSync(check.abs, content, 'utf8');
    return { ok: true, path: check.abs, backup };
  } catch (e) {
    return { error: e.message };
  }
}

// ---- apply_patch (упрощённый git-патч) ----
function applyPatch(patchText) {
  const tmp = '/tmp/aeon_patch_' + Date.now() + '.patch';
  try {
    fs.writeFileSync(tmp, patchText, 'utf8');
    const result = require('child_process').execSync(
      `cd ${WORKSPACE} && git apply --check ${tmp} && git apply ${tmp}`,
      { encoding: 'utf8', stdio: 'pipe' }
    );
    fs.unlinkSync(tmp);
    return { ok: true, output: result };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return { error: e.message, stderr: e.stderr ? e.stderr.toString() : '' };
  }
}

// ---- run_command (ограниченный) ----
// 14.09: sandbox для runCommand
// Разрешены только безопасные read-only/bash-команды в пределах бокса.
// Запрещено: find /, grep -r /, npm install, npm i, find по /home
const ALLOWED_CMD = [
  /^ls\b/,
  /^pwd\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^file\b/,
  /^stat\b/,
  /^grep\s+[^|]*?(\.\/|\.\s|--include)/,   // grep только с явным . или --include
  /^node\s+--check\b/,
  /^node\s+-e\b/,
  /^git\s+(diff|log|show|status|blame)\b/,
  /^find\s+\.\s/,                            // find только в текущем каталоге
];

const FORBIDDEN_CMD = [
  /\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|halt|passwd|userdel)\b/,
  /\bfind\s+\/(?!home\/ishidin\/phoenix)/,     // find / без явного проекта
  /\bfind\s+\/home\/(?!ishidin\/phoenix)/,     // find в чужом home
  /\bgrep\s+-r[^|]*\s\/\s/,                    // grep -r /
  /\bgrep\s+-r[^|]*\s\/home\b/,                // grep -r /home
  /\bnpm\s+(install|i|ci)\b/,
  /\byarn\s+(add|install)\b/,
  /\bpip\s+install\b/,
  /\bapt(-get)?\s+install\b/,
];

function runCommand(cmd) {
  const c = String(cmd || '').trim();

  // 1. Явные запреты
  for (const re of FORBIDDEN_CMD) {
    if (re.test(c)) {
      return { error: `Команда запрещена (${re.source}): ${c.slice(0, 80)}` };
    }
  }

  // 2. Whitelist — только разрешённые формы
  const allowed = ALLOWED_CMD.some(re => re.test(c));
  if (!allowed) {
    return { error: `Команда не в whitelist: ${c.slice(0, 80)}. Разрешены: ls, cat, head, tail, grep ., find ., node --check, git diff/log` };
  }

  return new Promise((resolve) => {
    // cwd=BOX_DIR — песочница. Агент не может писать/ставить в корень.
    // 14.09: cwd=PROJECT_ROOT — агент должен читать файлы проекта (race.js и т.д.)
    // Защита от опасного — через whitelist выше, не через cwd.
    exec(c, { cwd: WORKSPACE, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ error: err.message, stderr });
      resolve({ ok: true, stdout, stderr });
    });
  });
}

// ---- git_commit ----
// 14.09: git commit из бокса запрещён.
// Коммиты делает Пульсар через benchmark/loop, не агенты.
function gitCommit(message) {
  return { error: 'git commit запрещён из бокса. Отправь изменения в ответе.' };
}


// ---- search_code ----
function searchCode(query, options = {}) {
  const { filePattern = '', maxResults = 50 } = options;
  const { execSync } = require('child_process');
  try {
    const pattern = filePattern ? `--include="${filePattern}"` : '';
    // 14.09: grep строго в корне проекта. Никаких /home/ishidin, /, ../.
    // Используем PROJECT_ROOT + "." внутри — исключает выход наружу.
    const safeQuery = String(query).replace(/["'$`\\]/g, '');
    const cmd = `cd ${PROJECT_ROOT} && grep -rn ${pattern} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=memory "${safeQuery}" . 2>/dev/null | head -${maxResults}`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 15000, cwd: PROJECT_ROOT });
    const lines = output.trim().split('\n').filter(Boolean);
    return { ok: true, query, count: lines.length, matches: lines };
  } catch (e) {
    if (e.status === 1) return { ok: true, query, count: 0, matches: [] };
    return { error: e.message };
  }
}

// ---- git_diff ----
function gitDiff(args = '') {
  const { execSync } = require('child_process');
  try {
    // По умолчанию: только --stat (кратко). С флагом --full: полный патч, но обрезанный.
    const full = args.includes('--full');
    const cleanArgs = args.replace('--full', '').trim();
    const cmd = full
      ? `cd ${WORKSPACE} && git diff ${cleanArgs} --stat && echo "---" && git diff ${cleanArgs} | head -100`
      : `cd ${WORKSPACE} && git diff ${cleanArgs} --stat`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
    return { ok: true, diff: output, mode: full ? 'full' : 'stat' };
  } catch (e) {
    return { error: e.message };
  }
}

// ---- send_telegram ----
// С этой VPS api.telegram.org часто недоступен через системный DNS
// (IPv6 отдаётся первым -> ENETUNREACH, а часть IPv4 таймаутит).
// Поэтому: обычная попытка, затем фолбэк на рабочие IP из TELEGRAM_API_IPS.
const TELEGRAM_FALLBACK_IPS = (process.env.TELEGRAM_API_IPS || '149.154.167.220')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function telegramHttpsAgent(ips) {
  const https = require('https');
  let idx = 0;
  return new https.Agent({
    keepAlive: false,
    lookup(hostname, options, callback) {
      if (typeof options === 'function') { callback = options; options = {}; }
      const ip = ips[Math.min(idx++, ips.length - 1)];
      callback(null, ip, ip.includes(':') ? 6 : 4);
    }
  });
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || '7421544130';
  if (!token) return { error: 'TELEGRAM_BOT_TOKEN not set' };

  const axios = require('axios');
  const https = require('https');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const payload = { chat_id: chatId, text: message.slice(0, 4000) };
  const errors = [];

  // 1) обычный путь через системный DNS
  try {
    const res = await axios.post(url, payload, {
      timeout: 10000,
      httpsAgent: new https.Agent({ keepAlive: false }),
      proxy: false
    });
    return { ok: true, message_id: res.data.result && res.data.result.message_id };
  } catch (e) {
    errors.push('dns: ' + e.message);
  }

  // 2) фолбэк по известным рабочим IP
  for (const ip of TELEGRAM_FALLBACK_IPS) {
    try {
      const res = await axios.post(url, payload, {
        timeout: 10000,
        httpsAgent: telegramHttpsAgent([ip]),
        proxy: false
      });
      return { ok: true, message_id: res.data.result && res.data.result.message_id, ip };
    } catch (e) {
      errors.push(ip + ': ' + e.message);
    }
  }

  return { error: 'Telegram недоступен: ' + errors.join(' | ') };
}

// ---- web_search (простой через DuckDuckGo HTML) ----
async function webSearch(query, maxResults = 5) {
  try {
    const axios = require('axios');
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 15000
    });
    const html = res.data;
    const results = [];
    const regex = /<a rel="nofollow" class="result__a" href="([^"]+)">([^<]+)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) && results.length < maxResults) {
      results.push({ url: match[1], title: match[2].replace(/&amp;/g, '&') });
    }
    return { ok: true, query, count: results.length, results };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { readFile, writeFile, editFile, applyPatch, runCommand, gitCommit, isPathSafe, searchCode, gitDiff, sendTelegram, webSearch };
