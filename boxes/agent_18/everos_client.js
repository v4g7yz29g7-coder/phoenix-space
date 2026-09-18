// EverOS Client — обёртка для агента Aeon
const axios = require('axios');
const { execSync } = require('child_process');

const EVEROS_URL = process.env.EVEROS_URL || 'http://127.0.0.1:8000';
const EVEROS_ROOT = '/home/ishidin/.everos';
const APP_ID = 'aeon';
const PROJECT_ID = 'phoenix';
const USER_ID = process.env.EVEROS_USER_ID || 'ishidin';

async function health() {
  try {
    const res = await axios.get(EVEROS_URL + '/health', { timeout: 5000 });
    return res.data;
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

async function addMemory(content, sessionId) {
  const ts = Date.now();
  try {
    const res = await axios.post(EVEROS_URL + '/api/v2/memory/add', {
      user_id: USER_ID,
      session_id: sessionId || ('aeon-' + ts),
      app_id: APP_ID,
      project_id: PROJECT_ID,
      messages: [{ sender_id: USER_ID, role: 'user', timestamp: ts, content: content }]
    }, { timeout: 15000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function flushMemory(sessionId) {
  try {
    const res = await axios.post(EVEROS_URL + '/api/v2/memory/flush', {
      user_id: USER_ID, session_id: sessionId, app_id: APP_ID, project_id: PROJECT_ID
    }, { timeout: 30000 });
    return { ok: true, data: res.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Поиск через grep (мгновенно, надёжно)
function searchGrep(query, maxResults = 10) {
  try {
    const safeQuery = query.replace(/"/g, '\\"');
    const cmd = `grep -rl "${safeQuery}" ${EVEROS_ROOT}/ --include="*.md" 2>/dev/null | head -${maxResults}`;
    const files = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean);
    const results = [];
    for (const file of files) {
      const content = execSync(`grep -A 3 -B 1 "${safeQuery}" "${file}" | head -20`, { encoding: 'utf8' });
      results.push({ file: file.replace(EVEROS_ROOT, '~/.everos'), preview: content.trim() });
    }
    return { ok: true, count: results.length, results };
  } catch (e) {
    return { ok: true, count: 0, results: [] };
  }
}

async function recordTask(prompt, result, criticVerdict) {
  const sessionId = 'task-' + Date.now();
  const taskText = 'TASK: ' + prompt.slice(0, 500) +
    '\nRESULT: ' + (result.answer || '(no answer)').slice(0, 500) +
    '\nSCORE: ' + ((criticVerdict && criticVerdict.score) || 'n/a') +
    '\nVERDICT: ' + ((criticVerdict && criticVerdict.verdict) || 'n/a');

  const added = await addMemory(taskText, sessionId);
  if (added.ok) await flushMemory(sessionId);
  return { ok: added.ok, session_id: sessionId };
}

module.exports = { health, addMemory, flushMemory, searchGrep, recordTask };
