'use strict';
// security/guardian.js — аудит входов/выходов агентов
// Использование:
//   const guardian = require('./security/guardian');
//   guardian.inspectInput(task, box);
//   guardian.inspectCommand(cmd, box);
//   guardian.inspectOutput(answer, box);

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LOG = path.join(__dirname, 'logs', 'audit.log');
const INCIDENTS = path.join(__dirname, 'incidents');

// Паттерны опасного
const BLACKLIST = [
  { name: 'deepseek_key', re: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'openai_key', re: /sk-proj-[a-zA-Z0-9_\-]{40,}/ },
  { name: 'telegram_token', re: /\d{10}:[A-Za-z0-9_\-]{30,}/ },
  { name: 'bearer_token', re: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/ },
  { name: 'password_field', re: /password\s*[:=]\s*['"][^'"]+['"]/i },
  { name: 'private_key', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { name: 'rm_rf', re: /\brm\s+-rf\s+\// },
  { name: 'eval_call', re: /\beval\s*\(/ },
  { name: 'curl_external', re: /\bcurl\s+https?:\/\// },
  { name: 'wget_external', re: /\bwget\s+https?:\/\// },
  { name: 'chmod_777', re: /chmod\s+777/ },
];

function ensureDirs() {
  for (const d of [path.join(__dirname, 'logs'), INCIDENTS]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function log(event) {
  ensureDirs();
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

function inspect(text, box, phase) {
  if (!text) return { ok: true, flags: [] };
  const s = String(text);
  const flags = [];
  for (const pat of BLACKLIST) {
    if (pat.re.test(s)) flags.push(pat.name);
  }
  if (flags.length > 0) {
    log({ box, phase, flags, text: s.slice(0, 500), status: 'flagged' });
    // Записываем инцидент
    try {
      const inc = path.join(INCIDENTS, `${Date.now()}_${box}_${phase}.json`);
      fs.writeFileSync(inc, JSON.stringify({ ts: new Date().toISOString(), box, phase, flags, text: s.slice(0, 2000) }, null, 2));
    } catch (e) {}
  } else {
    log({ box, phase, status: 'ok' });
  }
  return { ok: flags.length === 0, flags };
}

function inspectInput(task, box) { return inspect(task, box, 'input'); }
function inspectCommand(cmd, box) { return inspect(cmd, box, 'command'); }
function inspectOutput(answer, box) { return inspect(answer, box, 'output'); }

function stats() {
  ensureDirs();
  if (!fs.existsSync(LOG)) return { total: 0, flagged: 0 };
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  let flagged = 0;
  const byFlag = {};
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (e.status === 'flagged') {
        flagged++;
        for (const f of (e.flags || [])) byFlag[f] = (byFlag[f]||0)+1;
      }
    } catch (e) {}
  }
  return { total: lines.length, flagged, byFlag };
}

if (require.main === module) {
  console.log(JSON.stringify(stats(), null, 2));
}

module.exports = { inspectInput, inspectCommand, inspectOutput, inspect, stats };
