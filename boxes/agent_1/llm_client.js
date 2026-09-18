const axios = require('/home/ishidin/phoenix/node_modules/axios');

async function askDeepSeek(systemPrompt, userPrompt, maxTokens = 2000) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.7
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    }
  });

  return response.data.choices[0].message.content.trim();
}

async function askDeepSeekChat(messages, maxTokens = 2000) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY not set');

  const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
    model: 'deepseek-chat',
    messages: messages,
    max_tokens: maxTokens,
    temperature: 0.3
  }, {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    }
  });

  return response.data.choices[0].message.content.trim();
}

module.exports = { askDeepSeek, askDeepSeekChat };
