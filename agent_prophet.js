// Prophet: анализирует паттерны из memory/patterns/, предлагает улучшения.
const { createResponse } = require('./deepseek_responses');
const fs = require('fs');

const PATTERNS_DIR = '/home/ishidin/phoenix/memory/patterns';

const PROPHET_INSTRUCTIONS = `You are Prophet, an analyst. You read past patterns (successes and failures) and predict what will work in the future.

Reply ONLY with JSON:
{
  "insights": [
    {"finding": "concrete observation", "evidence": "from patterns", "recommendation": "action to take"}
  ],
  "risk_score": 5,
  "summary": "one-sentence summary in Russian"
}

Rules:
- Base insights ONLY on the patterns provided
- risk_score 0-10 (10 = high risk of failure soon)
- Be specific: not "improve memory" but "add web_search result caching to reduce DeepSeek calls"`;

function loadPatterns(limit = 20) {
  try {
    const files = fs.readdirSync(PATTERNS_DIR).filter(f => f.endsWith('.json'));
    
    // Читаем все JSON
    const all = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(PATTERNS_DIR + '/' + f, 'utf8'));
        data._file = f;
        return data;
      } catch (e) {
        return { _file: f, error: 'parse failed' };
      }
    });
    
    // Сортируем по ts (новые первыми)
    all.sort((a, b) => {
      const ta = a.ts || a._file || '';
      const tb = b.ts || b._file || '';
      return tb.localeCompare(ta);
    });
    
    // Race-паттерны в приоритете
    const races = all.filter(d => d._file && d._file.startsWith('race_'));
    const others = all.filter(d => !d._file || !d._file.startsWith('race_'));
    const selected = races.slice(0, limit).concat(others.slice(0, Math.max(0, limit - races.length)));
    
    return selected;
  } catch (e) {
    return [];
  }
}

async function analyze(goal) {
  const patterns = loadPatterns(40);
  
  // Сжимаем паттерны: только ключевые поля для экономии контекста
  const compressed = patterns.map(p => ({
    winner: p.winner || p.box || '?',
    score: p.winner_score || p.score || '?',
    task: (p.task || '').slice(0, 80),
    ts: p.ts || '',
    type: p.type || (p._file && p._file.startsWith('race_') ? 'race' : 'other')
  }));
  if (patterns.length === 0) {
    return { ok: false, error: 'No patterns yet. Run some tasks first.' };
  }

  const input = 'CURRENT GOAL: ' + (goal || 'improve the system') + '\n\n' +
    'PATTERNS (' + compressed.length + '):\n' + JSON.stringify(compressed).slice(0, 20000);

  const response = await createResponse({
    model: 'deepseek-flash',
    instructions: PROPHET_INSTRUCTIONS,
    input: [{ role: 'user', content: input }]
  });

  let text = '';
  for (const item of response.output || []) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text') text += part.text;
      }
    }
  }

  const cleaned = text.replace(/```json|```/g, '').trim();
  let depth = 0, start = -1;
  for (let k = 0; k < cleaned.length; k++) {
    if (cleaned[k] === '{') { if (depth === 0) start = k; depth++; }
    else if (cleaned[k] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(cleaned.slice(start, k + 1));
          return { ok: true, patterns_count: patterns.length, analysis: parsed };
        } catch (e) {}
        break;
      }
    }
  }

  return { ok: false, error: 'parse failed', raw: text };
}

module.exports = { analyze, loadPatterns };
