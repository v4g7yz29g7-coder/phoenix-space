// ============================================================================
//  agent_tools.js — Инструменты самоизменения Aeon
//  Безопасные операции чтения/записи/патча/коммита в пределах ~/phoenix
// ============================================================================

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const WORKSPACE = '/home/ishidin/phoenix';
const ALLOWED_DIRS = [WORKSPACE];
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
function runCommand(cmd) {
  const FORBIDDEN_CMD = /\b(rm\s+-rf|mkfs|dd\s+if=|shutdown|reboot|halt|passwd|userdel)\b/;
  if (FORBIDDEN_CMD.test(cmd)) return { error: 'Команда запрещена' };
  return new Promise((resolve) => {
    exec(cmd, { cwd: WORKSPACE, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return resolve({ error: err.message, stderr });
      resolve({ ok: true, stdout, stderr });
    });
  });
}

// ---- git_commit ----
function gitCommit(message) {
  return new Promise((resolve) => {
    exec(`cd ${WORKSPACE} && git add -A && git commit -m "${message.replace(/"/g, '\\"')}"`, (err, stdout, stderr) => {
      if (err) return resolve({ error: err.message, stderr });
      resolve({ ok: true, stdout });
    });
  });
}


// ---- search_code ----
function searchCode(query, options = {}) {
  const { filePattern = '', maxResults = 50 } = options;
  const { execSync } = require('child_process');
  try {
    const pattern = filePattern ? `--include="${filePattern}"` : '';
    const cmd = `cd ${WORKSPACE} && grep -rn ${pattern} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=memory "${query.replace(/"/g, '\\"')}" . 2>/dev/null | head -${maxResults}`;
    const output = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
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
