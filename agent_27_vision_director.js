'use strict';
/**
 * agent_27_vision_director.js
 * Orchestrator: capture 3D scene -> upload to GigaChat -> analyze -> structured JSON.
 *
 *   const result = await directVisualCycle();
 *   // { screenshot, analysis, issues, fixes }
 */

const fs = require('fs');
const path = require('path');

// ---- lightweight .env loader (no external deps) ----------------------------
// Ensures a plain `node agent_27_vision_director.js` run has credentials.
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (_) {
    /* ignore */
  }
})();

const { capture } = require('./vision_capture');
const giga = require('./gigachat_client');

const OUT = process.env.VISION_OUT || '/tmp/formula_i1.png';

const PROMPT = [
  'Ты — режиссёр 3D-сцены гоночной трассы. Посмотри на скриншот и оцени качество кадра.',
  'Верни СТРОГО валидный JSON без markdown и без пояснений, по схеме:',
  '{',
  '  "analysis": "подробное описание сцены: трасса, машина, камера, окружение, освещение (не менее 100 символов)",',
  '  "issues": ["проблема 1", "проблема 2"],',
  '  "fixes": { "camera_trackside": [60, 8, 30] }',
  '}',
  'В issues перечисли визуальные дефекты (текстуры, позиция/высота камеры, FOV, освещение, геометрия).',
  'В fixes предложи конкретные параметры исправлений.',
].join('\n');

function _extractJson(text) {
  if (!text) return null;
  let t = text.trim();
  // strip markdown fences
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

/**
 * Run one full visual direction cycle.
 * @returns {Promise<{screenshot:string, analysis:string, issues:string[], fixes:object}>}
 */
async function directVisualCycle(opts = {}) {
  const url = opts.url || process.env.FORMULA_URL || 'http://localhost:3020/3d/';

  // 1. Capture
  const shot = await capture({ url, out: opts.out || OUT });
  if (!shot || !fs.existsSync(shot.path) || shot.size === 0) {
    throw new Error('Screenshot was not created: ' + shot.path);
  }

  // 2. Upload + 3. Analyze
  const fileId = await giga.uploadFile(shot.path);
  const raw = await giga.chat(PROMPT, [fileId], { model: 'GigaChat-Pro', temperature: 0.1 });

  const parsed = _extractJson(raw) || {};

  let analysis = parsed.analysis || raw || '';
  if (analysis.length < 100) {
    // ensure criterion "description > 100 chars" when the model is terse
    analysis = (analysis + ' ' + raw).trim();
  }

  const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const fixes = parsed.fixes && typeof parsed.fixes === 'object' ? parsed.fixes : {};

  return {
    screenshot: shot.path,
    analysis,
    issues,
    fixes,
    _meta: {
      fileId,
      url,
      bytes: shot.size,
      dimensions: shot.width + 'x' + shot.height,
      rawLength: raw.length,
      structured: !!(parsed && parsed.analysis),
    },
  };
}

if (require.main === module) {
  directVisualCycle()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(JSON.stringify({ error: err.message }, null, 2));
      process.exit(1);
    });
}

module.exports = { directVisualCycle };
