const axios = require('axios');

const DEEPSEEK_BASE = 'https://api.deepseek.com';

async function createResponse(params) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
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

  return response.data;
}

module.exports = { createResponse };
