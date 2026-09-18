// benchmark/generator.js — Архитектор генерирует тесты для гонок
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const agent = require(path.join(ROOT, 'architect', 'agent'));
const ARCHIVE = path.join(__dirname, 'archive');
const LOG = path.join(ROOT, 'memory', 'benchmark.log');

if (!fs.existsSync(ARCHIVE)) fs.mkdirSync(ARCHIVE, { recursive: true });

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

function collectContext() {
  const ctx = { git: '', failures: [], roadmap: null };

  try {
    ctx.git = execSync('git log --oneline -10', { cwd: ROOT, encoding: 'utf8', timeout: 3000 });
  } catch (e) {}

  try {
    const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'tasks_night_pool.json'), 'utf8'));
    ctx.failures = (pool.tasks || [])
      .filter(t => t.status === 'failed')
      .slice(0, 5)
      .map(t => `${t.id}: ${t.file}`);
  } catch (e) {}

  return ctx;
}

function buildPrompt(ctx) {
  return `Брат, ты — Архитектор. Собери **бенчмарк из 5 задач** для гонки агентов.

## Контекст

**Git (последние 10):**
\`\`\`
${ctx.git.slice(0, 800)}
\`\`\`

**Failures:**
${ctx.failures.length ? ctx.failures.join(' | ') : '(нет)'}

## Что нужно

Сгенерируй 5 задач **для гонки**. Каждая:
- Проверяемая (команда + ожидание)
- Разной сложности (2 лёгкие, 2 средние, 1 сложная)
- На русском

Формат — строго JSON:

\`\`\`json
{
  "reasoning": "1 предложение",
  "tasks": [
    {"id": "B1", "task": "Прочитай X и ответь Y", "criteria": "ответ содержит Z", "difficulty": 1},
    {"id": "B2", "task": "...", "criteria": "...", "difficulty": 2},
    {"id": "B3", "task": "...", "criteria": "...", "difficulty": 2},
    {"id": "B4", "task": "...", "criteria": "...", "difficulty": 3},
    {"id": "B5", "task": "...", "criteria": "...", "difficulty": 4}
  ]
}
\`\`\`

Только JSON, без прозы.`;
}

function parseJson(answer) {
  const m = answer.match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if (!m) return null;
  try {
    const raw = m[0].replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (e) { return null; }
}

async function generate() {
  log('⏳ Собираю контекст...');
  const ctx = collectContext();

  log('🧠 Спрашиваю Архитектора...');
  const t0 = Date.now();
  const resp = await agent.respond(buildPrompt(ctx));
  const ms = Date.now() - t0;
  log(`   Ответ за ${ms}ms | режим: ${resp.mode} | DNA: ${resp.dna}`);

  const parsed = parseJson(resp.answer);
  if (!parsed) {
    log('❌ не распарсил JSON');
    return null;
  }

  const bench = {
    id: 'bench_' + Date.now(),
    ts: new Date().toISOString(),
    reasoning: parsed.reasoning,
    tasks: (function() {
    const r = sanitizeTasks(parsed.tasks || []);
    if (r.rejected.length) {
      console.log(`⚠️  sanitizeTasks: отфильтровано ${r.rejected.length} тяжёлых задач:`);
      for (const x of r.rejected) console.log(`   - ${x.id}: ${x.pattern} | ${x.task}`);
    }
    return r.clean;
  })(),
    context: { git_head: ctx.git.split('\n')[0], failures: ctx.failures },
    results: [],
    generated_by: 'architect',
    mode: resp.mode,
    dna: resp.dna,
  };

  const file = path.join(ARCHIVE, bench.id + '.json');
  fs.writeFileSync(file, JSON.stringify(bench, null, 2));

  log(`✅ Бенчмарк: ${file}`);
  log(`   Reasoning: ${bench.reasoning}`);
  for (const t of bench.tasks) {
    log(`   [D${t.difficulty}] ${t.id}: ${t.task.slice(0, 60)}`);
  }

  return { bench, file };
}

if (require.main === module) {
  generate()
    .then(r => r ? process.exit(0) : process.exit(1))
    .catch(e => { console.error('❌', e.message); process.exit(1); });
}


// === Фильтр тяжёлых задач (14.09: найдено бенчмарком) ===
// Задачи, требующие npm build/vite/webpack — блокируют race на минуты,
// плодят orphan-процессы. Заменяем на эквивалент без сборки.
const HEAVY_PATTERNS = [
  /npm\s+run\s+build/i,
  /vite\s+build/i,
  /webpack/i,
  /npm\s+install/i,
  /yarn\s+build/i,
  /tsc\s+--?p/i,
  /rollup/i,
  /сборк[аи]\s+arena3d/i,
  /собери\s+.*arena3d/i,
  /npm\s+run\s+dev/i,
  /find\s+\/(?!home)/i,        // find по корню ФС — провокация I/O
];

function sanitizeTasks(tasks) {
  const clean = [];
  const rejected = [];
  for (const t of tasks) {
    // Нормализуем пути: убираем ~/phoenix/ и /home/*/phoenix/ из текста
    // Причина: агент в боксе не знает корень проекта → запускает find /
    const normalize = (s) => (s || '')
      .replace(/~\/phoenix\//g, './')
      .replace(/\/home\/[^\s/]+\/phoenix\//g, './')
      .replace(/\/home\/ishidin\/phoenix\//g, './');
    t.task = normalize(t.task);
    t.criteria = normalize(t.criteria);

    const blob = (t.task || '') + ' ' + (t.criteria || '');
    const hit = HEAVY_PATTERNS.find(re => re.test(blob));
    if (hit) {
      rejected.push({ id: t.id, pattern: hit.source, task: t.task.slice(0, 80) });
      // Меняем критерий: вместо сборки — проверка существования артефакта
      t.task = t.task.replace(/npm\s+run\s+build[^.]*/gi, 'проверь конфигурацию сборки');
      t.criteria = (t.criteria || '').replace(/npm\s+run\s+build[^.]*/gi, 'файлы конфига существуют');
      t._sanitized = true;
    }
    clean.push(t);
  }
  return { clean, rejected };
}

module.exports = { sanitizeTasks, generate, collectContext, buildPrompt, parseJson };
