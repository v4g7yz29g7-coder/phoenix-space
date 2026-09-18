// architect_worker.js — Автономный цикл Архитектора
// Каждые N минут: читает контекст → ставит задачи → добавляет в night_pool
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = __dirname;
const agent = require('./architect/agent');
const pool_lock = require('./memory/pool_lock');
const POOL = path.join(ROOT, 'tasks_night_pool.json');
const LOG = path.join(ROOT, 'memory', 'architect_worker.log');
const REPORT = path.join(ROOT, 'memory', 'architect_worker_report.json');

function log(m) {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

// ============ 1. СБОР КОНТЕКСТА ============
function collectContext() {
  const ctx = {
    ts: new Date().toISOString(),
    roadmap: null,
    lastReport: null,
    audit: null,
    gitLog: '',
    poolStats: { total: 0, completed: 0, failed: 0, pending: 0, in_progress: 0 },
    topFailures: [],
  };

  // Roadmap
  try {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'arena_roadmap.json'), 'utf8'));
    let done = 0, total = 0, pending = [], failed = [];
    for (const st of r.stages || []) {
      for (const t of st.tasks || []) {
        total++;
        if (t.status === 'completed') done++;
        else if (t.status === 'pending') pending.push(t.id + ': ' + t.title);
        else if (t.status === 'failed') failed.push(t.id + ': ' + t.title);
      }
    }
    ctx.roadmap = { done, total, pending: pending.slice(0, 10), failed };
  } catch (e) {}

  // Последний отчёт night_evolution
  try {
    ctx.lastReport = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'night_evolution_report.json'), 'utf8'));
  } catch (e) {}

  // Аудит
  try {
    ctx.audit = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'audit_report.json'), 'utf8'));
  } catch (e) {}

  // Git log
  try {
    ctx.gitLog = execSync('git log --oneline -15', { cwd: ROOT, encoding: 'utf8', timeout: 5000 });

    // 16.09: МАЯК — стратегический контекст для Архитектора
    try {
      const mayak = fs.readFileSync(path.join(ROOT, 'docs', 'MAYAK.md'), 'utf8');
      ctx.mayak = mayak.slice(0, 4000);  // первые 4000 символов
    } catch (e) { ctx.mayak = null; }

    // 16.09: Топ-10 fitness — кто сильнее всех
    try {
      const fit = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'fitness.json'), 'utf8'));
      ctx.fitnessTop10 = Object.values(fit.agents || {})
        .sort((a, b) => b.fitness - a.fitness)
        .slice(0, 10)
        .map(a => `${a.box}(${a.fitness.toFixed(2)})`);
    } catch (e) { ctx.fitnessTop10 = []; }

    // 16.09: 20 свежих completed задач — что уже сделано
    try {
      const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'tasks_night_pool.json'), 'utf8'));
      ctx.recentCompleted = (pool.tasks || [])
        .filter(t => t.status === 'completed')
        .slice(-20)
        .map(t => t.id + ': ' + (t.file || ''));
    } catch (e) { ctx.recentCompleted = []; }

    // 15.09: Sensors — системные метрики
    try {
      const metrics = require('./sensors/system_metrics');
      ctx.systemMetrics = typeof metrics.snapshot === 'function' ? metrics.snapshot() : metrics.getMetrics ? metrics.getMetrics() : null;
    } catch (e) { ctx.systemMetrics = null; }

    // 15.09: Trajectory — пути последних гонок
    try {
      const pb = require('./trajectory/path_builder');
      const fsx = require('fs');
      const raceFiles = fsx.readdirSync(path.join(ROOT, 'memory', 'races'))
        .filter(f => f.startsWith('race_') && f.endsWith('.json'))
        .map(f => ({ f, m: fsx.statSync(path.join(ROOT, 'memory', 'races', f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)
        .slice(0, 5);
      ctx.recentRaces = raceFiles.map(({ f }) => {
        try {
          const r = JSON.parse(fsx.readFileSync(path.join(ROOT, 'memory', 'races', f), 'utf8'));
          return { race_id: r.race_id, winner: r.winner, duration: r.duration_sec, tasks: (r.task || '').slice(0, 60) };
        } catch (e) { return null; }
      }).filter(Boolean);
    } catch (e) { ctx.recentRaces = []; }

    // 15.09: Fitness — топ агентов
    try {
      const fit = JSON.parse(fs.readFileSync(path.join(ROOT, 'memory', 'fitness.json'), 'utf8'));
      ctx.fitnessTop = Object.values(fit.agents || {})
        .sort((a, b) => b.fitness - a.fitness)
        .slice(0, 3)
        .map(a => ({ box: a.box, fitness: a.fitness, runs: a.runs_total, wins: a.wins_total }));
    } catch (e) { ctx.fitnessTop = []; }
  } catch (e) {}

  // Пул
  try {
    const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
    const tasks = pool.tasks || [];
    ctx.poolStats.total = tasks.length;
    for (const t of tasks) {
      const s = t.status || 'pending';
      ctx.poolStats[s] = (ctx.poolStats[s] || 0) + 1;
    }
    ctx.topFailures = tasks.filter(t => t.status === 'failed').slice(0, 5).map(t => t.id + ': ' + t.file);
  } catch (e) {}

  return ctx;
}

// ============ 2. ПРОМПТ АРХИТЕКТОРУ ============
function buildPrompt(ctx, tasksToAsk = 5) {
  return `Брат, я — твой Архитектор-автоном. Собрал контекст проекта. Прошу: **поставь ${tasksToAsk} конкретных задач** для команды пилотов.

## Контекст

**Roadmap:** ${ctx.roadmap ? `${ctx.roadmap.done}/${ctx.roadmap.total} готово` : '—'}
**Pending:** ${ctx.roadmap && ctx.roadmap.pending.length ? ctx.roadmap.pending.join(' | ') : '—'}
**Failed:** ${ctx.roadmap && ctx.roadmap.failed.length ? ctx.roadmap.failed.join(' | ') : '—'}

**Ночной пул:** ${ctx.poolStats.total} задач | ✅ ${ctx.poolStats.completed || 0} | 🔄 ${ctx.poolStats.in_progress || 0} | ⏳ ${ctx.poolStats.pending || 0} | ❌ ${ctx.poolStats.failed || 0}

**Свежие failures:** ${ctx.topFailures.length ? ctx.topFailures.join(' | ') : '—'}

**Система:** CPU ${ctx.systemMetrics ? (ctx.systemMetrics.cpu || '—') : '—'}% | RAM ${ctx.systemMetrics ? (ctx.systemMetrics.mem || '—') : '—'}% | load ${ctx.systemMetrics ? (ctx.systemMetrics.load || '—') : '—'}

**Fitness топ-3:** ${ctx.fitnessTop && ctx.fitnessTop.length ? ctx.fitnessTop.map(a => `${a.box}(${a.fitness})`).join(' | ') : '—'}

**Свежие гонки:** ${ctx.recentRaces && ctx.recentRaces.length ? ctx.recentRaces.map(r => `${r.race_id}: ${r.winner || '—'} (${r.duration || '—'}s)`).join(' | ') : '—'}

**Git (последние 15):**
\`\`\`
${ctx.gitLog.slice(0, 1200)}
\`\`\`

## Что нужно

Поставь **ровно ${tasksToAsk} задач**. Формат ответа — строго JSON, без прозы:

\`\`\`json
{
  "reasoning": "1-2 предложения: почему именно эти задачи",
  "tasks": [
    {"id": "AUTO-1", "file": "path/to/file.js", "min_lines": 150, "prompt": "Что сделать. КРИТЕРИЙ: ..."},
    {"id": "AUTO-2", "file": "...", "min_lines": 120, "prompt": "..."},
    {"id": "AUTO-3", "file": "...", "min_lines": 100, "prompt": "..."},
    {"id": "AUTO-4", "file": "...", "min_lines": 150, "prompt": "..."},
    {"id": "AUTO-5", "file": "...", "min_lines": 100, "prompt": "..."}
  ]
}
\`\`\`

Правила:
1. Задачи — **реальные**, не «сделай хорошо». Файл, критерий, метрика.
2. Не повторяй то, что уже pending/completed.
3. Ставь то, что **двигает проект вперёд**: тесты, стабилизация, документация, недостающие модули.
4. Каждая задача — на 2-4 минуты гонки (min_lines 100-200).`;
}

// ============ 3. ПАРСИНГ ОТВЕТА ============
function parseTasks(answer) {
  // 16.09: не парсим JSON целиком (битый). Извлекаем задачи regex-ом.
  let clean = String(answer || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // 1. Reasoning — через regex
  const reasoningMatch = clean.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const reasoning = reasoningMatch ? reasoningMatch[1] : '—';

  // 2. Задачи — ищем объекты {"id": "AUTO-N", ...} без жадности
  const taskRegex = /\{\s*"id"\s*:\s*"(AUTO-\d+)"\s*,\s*"file"\s*:\s*"([^"]+)"\s*,\s*"min_lines"\s*:\s*(\d+)\s*,\s*"prompt"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

  const tasks = [];
  let m;
  while ((m = taskRegex.exec(clean)) !== null) {
    tasks.push({
      id: m[1],
      file: m[2],
      min_lines: parseInt(m[3]),
      prompt: m[4].replace(/\\"/g, '"').replace(/\\n/g, '\n'),
    });
  }

  if (!tasks.length) {
    console.error('[parseTasks] задач не найдено, length=' + clean.length);
    return null;
  }

  console.log(`[parseTasks] ✅ извлечено задач: ${tasks.length}`);
  return { reasoning, tasks };
}

// ============ 4. ДОБАВЛЕНИЕ В ПУЛ ============
function appendToPool(parsed) {
  return pool_lock.withLock(() => _appendToPoolLocked(parsed));
}

function _appendToPoolLocked(parsed) {
  const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
  const existingIds = new Set((pool.tasks || []).map(t => t.id));

  const newTasks = [];
  for (const t of parsed.tasks) {
    if (!t.id || !t.file || !t.prompt) continue;
    // Уникальный ID
    let id = t.id;
    let n = 1;
    while (existingIds.has(id)) { id = t.id + '-' + (++n); }
    existingIds.add(id);

    newTasks.push({
      id,
      group: 'architect_auto',
      file: t.file,
      min_lines: t.min_lines || 100,
      prompt: t.prompt,
      status: 'pending',
      created_by: 'architect_worker',
      created_at: new Date().toISOString(),
    });
  }

  pool.tasks = (pool.tasks || []).concat(newTasks);
  pool.updated_at = new Date().toISOString();
  fs.writeFileSync(POOL, JSON.stringify(pool, null, 2));
  return newTasks;
}

// ============ 5. ГЛАВНЫЙ ЦИКЛ ============
async function tick() {
  log('⏳ Собираю контекст...');
  const ctx = collectContext();
  log(`   roadmap: ${ctx.roadmap ? ctx.roadmap.done + '/' + ctx.roadmap.total : '—'} | пул: ${ctx.poolStats.total} | pending: ${ctx.poolStats.pending || 0}`);

  // 16.09: динамика — сколько ставить задач
  const pending = ctx.poolStats.pending || 0;
  let tasksToAsk = 5;
  if (pending < 20) tasksToAsk = 15;
  else if (pending < 50) tasksToAsk = 5;
  else {
    log('⏸  Pending > 50, ждём разгрузки');
    return { skipped: true, reason: 'pool_overloaded' };
  }
  log(`   Pending: ${pending} → ставлю ${tasksToAsk} задач`);

  log('🧠 Спрашиваю Архитектора...');
  const prompt = buildPrompt(ctx, tasksToAsk);
  const t0 = Date.now();
  const response = await agent.respond(prompt);
  const ms = Date.now() - t0;
  log(`   Архитектор ответил за ${ms}ms | режим: ${response.mode} | DNA: ${response.dna} | RAG: ${response.ragHits}`);

  const parsed = parseTasks(response.answer);
  if (!parsed) {
    log('❌ Не распарсил JSON из ответа. Первые 500 символов:');
    log(response.answer.slice(0, 500));
    return { error: 'parse_failed' };
  }

  log(`📋 Reasoning: ${parsed.reasoning || '—'}`);
  const added = appendToPool(parsed);
  log(`✅ Добавлено ${added.length} задач в пул:`);
  for (const t of added) log(`   ${t.id} → ${t.file} (min ${t.min_lines})`);

  // Отчёт
  const report = {
    ts: new Date().toISOString(),
    mode: response.mode,
    dna: response.dna,
    ragHits: response.ragHits,
    ms,
    reasoning: parsed.reasoning,
    added: added.map(t => ({ id: t.id, file: t.file, min_lines: t.min_lines })),
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  return report;
}

// ============ CLI ============
if (require.main === module) {
  const loop = process.argv.includes('--loop');
  const interval = 30 * 60 * 1000; // 30 минут

  (async () => {
    try {
      await tick();
      if (loop) {
        log(`🔄 Следующий цикл через 30 минут`);
        setInterval(() => {
          tick().catch(e => log('❌ ' + e.message));
        }, interval);
      } else {
        process.exit(0);
      }
    } catch (e) {
      log('❌ FATAL: ' + e.message);
      // 14.09: даже если первый tick упал — не выходим, а планируем следующий.
      // Иначе async IIFE завершается, handles=0, Node умирает сам.
      if (loop) {
        log('🔄 Планирую следующий цикл через 30 минут (после ошибки)');
        setInterval(() => {
          tick().catch(err => log('❌ ' + err.message));
        }, interval);
      } else {
        process.exit(1);
      }
    }
  })();
}

module.exports = { tick, collectContext, buildPrompt, parseTasks, appendToPool };
