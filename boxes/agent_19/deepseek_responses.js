require('dotenv').config({ path: require('path').join(__dirname, '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');
const budget = require('./budget_guard');

const DEEPSEEK_BASE = 'https://api.deepseek.com';

async function createResponse(params) {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  // === BUDGET GUARD ===
  const _chk = budget.checkBudget();
  if (!_chk.ok) {
    throw new Error('BUDGET_EXCEEDED: spent $' + _chk.spent.toFixed(4) + ' / limit $' + _chk.limit);
  }

  const response = await axios.post(
    `${DEEPSEEK_BASE}/responses`,
    {
      model: 'deepseek-flash',
      ...params,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }
  );

  // Логируем usage — DeepSeek использует input_tokens_details.cached_tokens
  if (response.data && response.data.usage) {
    const u = response.data.usage;
    const cached = (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
    const total_in = u.input_tokens || 0;
    const fresh = total_in - cached;
    const pct = total_in > 0 ? Math.round((cached / total_in) * 100) : 0;
    const logLine = '[usage] in=' + total_in +
      ' cached=' + cached + ' (' + pct + '%)' +
      ' fresh=' + fresh +
      ' out=' + (u.output_tokens || 0);
    console.log(logLine);
    try {
      require('fs').appendFileSync('/home/ishidin/phoenix/logs/usage.log',
        new Date().toISOString() + ' ' + logLine + '\n');
    } catch (e) {}
  }

  // === BUDGET GUARD: записать траты ===
  if (response.data && response.data.usage) {
    const _u = response.data.usage;
    budget.recordUsage(_u.input_tokens || 0, _u.output_tokens || 0);
  }

  return response.data;
}

// === BUDGET GUARD: записать траты ===
if (typeof response !== 'undefined' && response && response.data && response.data.usage) {
  // noop — recordUsage вызывается в try выше
}
// === BUDGET GUARD: записать траты ===
if (typeof response !== 'undefined' && response && response.data && response.data.usage) {
  // noop — recordUsage вызывается в try выше
}
module.exports = { createResponse };
