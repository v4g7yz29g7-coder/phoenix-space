const { createResponse } = require('./deepseek_responses');
const tools = require('./agent_tools');
const skillsLoader = require('./skills_loader');
const rag = require('./rag_context');
const selfaware = require('./selfaware');
const fs = require('fs');

const MAX_STEPS = 10;

// Гурджиев: САМОВОСПОМИНАНИЕ. Каждые N шагов агент останавливается и
// задаёт себе мета-вопрос: «Что ты делаешь? Соответствует ли цели?».
// Это возвращает внимание к исходной цели и не даёт «уснуть» в процессе.
const SELF_REMEMBER_INTERVAL = parseInt(process.env.SELF_REMEMBER_INTERVAL || '3', 10);
const SELF_REMEMBER_QUESTION = 'Что ты делаешь? Соответствует ли цели?';

const TOOLS_SPEC = [
  {
    type: 'function',
    name: 'read',
    description: 'Read file content',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  },
  {
    type: 'function',
    name: 'write',
    description: 'Write content to file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  },
  {
    type: 'function',
    name: 'edit',
    description: 'Replace fragment in file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old: { type: 'string' },
        new: { type: 'string' }
      },
      required: ['path', 'old', 'new']
    }
  },
  {
    type: 'function',
    name: 'exec',
    description: 'Execute bash command',
    parameters: {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd']
    }
  },
  {
    type: 'function',
    name: 'commit',
    description: 'Git commit',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message']
    }
  },
  {
    type: 'function',
    name: 'search_code',
    description: 'Search for a string across all project files',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        filePattern: { type: 'string', description: 'Optional: filter by file, e.g. *.js' }
      },
      required: ['query']
    }
  },
  {
    type: 'function',
    name: 'git_diff',
    description: 'Show git diff of current changes',
    parameters: {
      type: 'object',
      properties: { args: { type: 'string', description: 'Optional git diff args' } },
      required: []
    }
  },
  {
    type: 'function',
    name: 'send_telegram',
    description: 'Send a Telegram message to the owner',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message']
    }
  },
  {
    type: 'function',
    name: 'web_search',
    description: 'Search the internet via DuckDuckGo',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'number' }
      },
      required: ['query']
    }
  },
];

// Загружаем кастомный промпт бокса (если задан BOX_NAME)
let CUSTOM_PROMPT = '';
if (process.env.BOX_NAME) {
  const fs = require('fs');
  const promptFile = __dirname + '/prompts/' + process.env.BOX_NAME + '.md';
  try {
    if (fs.existsSync(promptFile)) {
      CUSTOM_PROMPT = fs.readFileSync(promptFile, 'utf8');
      console.log('[prompt] Загружен кастомный промпт: ' + process.env.BOX_NAME);
    }
  } catch (e) {
    console.log('[prompt] Ошибка загрузки: ' + e.message);
  }
}

const SYSTEM_INSTRUCTIONS = 'You are Aeon, a self-modifying agent living on a VPS. You have tools: read, write, edit, exec (bash), commit (git), search_code (grep project), git_diff (see changes), send_telegram (notify owner), web_search (internet search). RULES: 1. Use tools to accomplish the task. Do not just describe what you would do. 2. After each tool result, decide: call another tool OR provide a final answer. 3. When finished, respond with a clear text message (no tool call). 4. Always prefer edit over write for existing files - it preserves the rest. 5. Before committing, verify changes with exec (node --check or similar). 6. Never touch .env, node_modules, or *.db files. 7. Working directory: /home/ishidin/phoenix';

// Кэшируем SKILLS_BLOCK — загружаем один раз при старте процесса.
// Это критично для prompt caching DeepSeek: префикс должен быть стабильным.
const SKILLS_BLOCK = skillsLoader.buildSkillsPrompt();
const SYSTEM_INSTRUCTIONS_FULL = (CUSTOM_PROMPT || SYSTEM_INSTRUCTIONS) + SKILLS_BLOCK;
console.log('[cache] SKILLS_BLOCK загружен один раз: ' + SKILLS_BLOCK.length + ' символов');


async function executeTool(name, args) {
  try {
    if (name === 'read') return tools.readFile(args.path);
    if (name === 'write') return tools.writeFile(args.path, args.content);
    if (name === 'edit') return tools.editFile(args.path, args.old, args.new);
    if (name === 'exec') return await tools.runCommand(args.cmd);
    if (name === 'commit') return await tools.gitCommit(args.message);
    if (name === 'search_code') return tools.searchCode(args.query, { filePattern: args.filePattern });
    if (name === 'git_diff') return tools.gitDiff(args.args || '');
    if (name === 'send_telegram') return await tools.sendTelegram(args.message);
    if (name === 'web_search') return await tools.webSearch(args.query, args.maxResults || 5);
    return { error: 'Unknown tool: ' + name };
  } catch (e) {
    return { error: e.message };
  }
}

// Самовоспоминание (Гурджиев): фиксируем мета-вопрос в лог с префиксом [SELFAWARE].
function selfRemembrance(step, prompt) {
  const line = '[SELFAWARE] шаг ' + step + '/' + MAX_STEPS +
    ' | ' + SELF_REMEMBER_QUESTION +
    ' | цель: ' + String(prompt || '').replace(/\s+/g, ' ').slice(0, 160);
  console.log(line);
  // Best-effort durable log — не критично, если запись не удалась.
  try {
    const dir = __dirname + '/memory';
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    fs.appendFileSync(dir + '/selfaware.log', '[' + new Date().toISOString() + '] ' + line + '\n');
  } catch (e) {}
  return line;
}

async function runAgent(prompt) {
  const log = [];

  // RAG: обогащаем промпт релевантным контекстом из EverOS
  const enrichedPrompt = rag.enrichPrompt(prompt);
  if (enrichedPrompt.length > prompt.length) {
    console.log('[rag] контекст добавлен: +' + (enrichedPrompt.length - prompt.length) + ' символов');
  }

  const input = [{ role: 'user', content: enrichedPrompt }];
  const changedTools = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    // Гурджиев: самовоспоминание — каждые N (=3) шагов возвращаемся к цели.
    if (step > 0 && step % SELF_REMEMBER_INTERVAL === 0) {
      const meta = selfRemembrance(step, prompt);
      input.push({
        role: 'user',
        content: meta + '\nОстановись. Коротко ответь себе: что ты делаешь сейчас ' +
                 'и ведёт ли это к исходной цели? Если ты отклонился — вернись к цели.'
      });
      log.push({
        step: step,
        tool: 'self_remembrance',
        args: {},
        ok: true,
        reason: 'meta-prompt [SELFAWARE]'
      });
    }

    const response = await createResponse({
      model: 'deepseek-flash',
      instructions: SYSTEM_INSTRUCTIONS_FULL,
      input: input,
      tools: TOOLS_SPEC,
      tool_choice: 'auto'
    });

    if (!response.output || !Array.isArray(response.output)) {
      return { ok: false, error: 'No output', raw: response, steps: log };
    }

    input.push(...response.output);

    const functionCalls = response.output.filter(item => item.type === 'function_call');

    if (functionCalls.length === 0) {
      let finalText = '';
      for (const item of response.output) {
        if (item.type === 'message' && item.content) {
          for (const part of item.content) {
            if (part.type === 'output_text') finalText += part.text;
          }
        }
      }
      return { ok: true, answer: finalText, steps: log };
    }

    for (const call of functionCalls) {
      let args = {};
      try { args = JSON.parse(call.arguments || '{}'); } catch (e) {}

      const result = await executeTool(call.name, args);

      log.push({
        step: step,
        tool: call.name,
        args: args,
        ok: !result.error,
        reason: (result.error || 'OK').slice(0, 200)
      });

      if (['write', 'edit'].includes(call.name) && !result.error) {
        changedTools.push({ tool: call.name, reason: JSON.stringify(args).slice(0, 120) });
      }

      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result).slice(0, 8000)
      });
    }
  }

  return { ok: false, error: 'Max steps exceeded', steps: log };
}

async function commitAndLog(prompt, changedTools, answer) {
  if (changedTools.length === 0) return;

  // 1. Сначала пишем в память
  const today = new Date().toISOString().split('T')[0];
  const memFile = '/home/ishidin/phoenix/memory/' + today + '.md';
  const time = new Date().toISOString().split('T')[1].slice(0, 8);
  let memLog = '';
  try { memLog = fs.readFileSync(memFile, 'utf8'); } catch (e) { memLog = '# ' + today + '\n\n'; }
  memLog += '## [' + time + '] Auto self-edit (v2)\n';
  memLog += '- Prompt: ' + prompt.slice(0, 200) + '\n';
  memLog += '- Changes:\n';
  for (const s of changedTools) memLog += '  - ' + s.tool + ': ' + s.reason + '\n';
  memLog += '- Answer: ' + (answer || '').slice(0, 200) + '\n\n';
  try { fs.writeFileSync(memFile, memLog); } catch (e) {}

  // 2. Потом коммитим всё вместе (включая memory)
  try { await tools.gitCommit('auto: agent self-edit via /agent/think-v2'); } catch (e) {}
}

module.exports = { runAgent, commitAndLog };
