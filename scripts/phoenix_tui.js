#!/usr/bin/env node
// phoenix_tui.js v2 — простой TUI без alt-screen (работает везде)
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// ANSI escape codes
const E = {
  clear: '\x1b[2J\x1b[H',       // очистить + курсор в начало
  home:  '\x1b[H',              // курсор в начало
  hide:  '\x1b[?25l',           // спрятать курсор
  show:  '\x1b[?25h',           // показать
  reset: '\x1b[0m',
};

const C = {
  fire:   '\x1b[38;2;255;100;0m',
  gold:   '\x1b[38;2;255;200;50m',
  green:  '\x1b[38;2;80;220;120m',
  red:    '\x1b[38;2;255;80;80m',
  blue:   '\x1b[38;2;80;180;255m',
  purple: '\x1b[38;2;200;100;255m',
  dim:    '\x1b[38;2;100;100;120m',
  white:  '\x1b[38;2;240;240;250m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',     // ← 16.09: добавлено — не было, давал undefined
};

function bar(value, max, width = 30) {
  const p = Math.max(0, Math.min(1, value / (max || 1)));
  const filled = Math.round(p * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function readJSON(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) { return fallback; }
}

function getCtx() {
  const ctx = {};
  const pool = readJSON(path.join(ROOT, 'tasks_night_pool.json'), {});
  const tasks = pool.tasks || [];
  ctx.pool = {
    total: tasks.length,
    completed: tasks.filter(t => t.status === 'completed').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    pending: tasks.filter(t => t.status === 'pending').length,
    failed: tasks.filter(t => t.status === 'failed').length,
  };
  const fit = readJSON(path.join(ROOT, 'memory', 'fitness.json'), { agents: {} });
  ctx.fitness = Object.values(fit.agents || {}).sort((a, b) => b.fitness - a.fitness).slice(0, 3);
  ctx.budget = readJSON(path.join(ROOT, 'memory', 'deepseek_budget.json'), {});
  const racesDir = path.join(ROOT, 'memory', 'races');
  if (fs.existsSync(racesDir)) {
    const hourAgo = Date.now() - 3600 * 1000;
    ctx.racesRecent = fs.readdirSync(racesDir)
      .filter(f => f.startsWith('race_') && f.endsWith('.json'))
      .map(f => path.join(racesDir, f))
      .filter(p => fs.statSync(p).mtimeMs > hourAgo).length;
  } else ctx.racesRecent = 0;
  if (typeof ctx.racesRecent !== 'number') ctx.racesRecent = 0;
  try {
    ctx.gitLog = execSync('git log --oneline -5', { cwd: ROOT, encoding: 'utf8', timeout: 3000 }).trim().split('\n');
  } catch (e) { ctx.gitLog = []; }
  try {
    ctx.uptime = execSync('uptime -p', { cwd: ROOT, encoding: 'utf8', timeout: 2000 }).trim();
  } catch (e) { ctx.uptime = '—'; }
  if (!ctx.uptime || ctx.uptime === 'undefined') ctx.uptime = '—';
  try {
    const aw = fs.readFileSync(path.join(ROOT, 'memory', 'architect_worker.log'), 'utf8');
    const lines = aw.trim().split('\n');
    ctx.lastArchitect = lines.filter(l => l.includes('Добавлено')).slice(-1)[0] || '—';
  } catch (e) { ctx.lastArchitect = '—'; }
  return ctx;
}

let lastRender = '';

function render() {
  const ctx = getCtx();
  const p = ctx.pool;
  const total = p.total || 1;
  const used = (ctx.budget && ctx.budget.cost) || 0;
  const limit = (ctx.budget && ctx.budget.limit_usd) || 3;

  const lines = [];

  lines.push(`${C.fire}  🐦‍🔥  ${C.gold}${C.bold}PHOENIX · AI-1 EVOLUTION ARENA${C.reset}   ${C.dim}${new Date().toLocaleString('ru-RU')}${C.reset}`);
  lines.push(`${C.dim}  ${'─'.repeat(72)}${C.reset}`);
  lines.push('');
  lines.push(`${C.purple}${C.bold}  📋 НОЧНОЙ ПУЛ${C.reset}`);
  lines.push('');
  lines.push(`${C.white}     Всего:       ${C.gold}${C.bold}${p.total}${C.reset}`);
  lines.push(`${C.white}     Прогресс:    ${C.green}${bar(p.completed, total, 30)}  ${Math.round(p.completed / total * 100)}%${C.reset}`);
  lines.push(`${C.white}     ✅ Готово:    ${C.green}${C.bold}${p.completed}${C.reset}     ${C.white}🔄 Сейчас:  ${C.gold}${C.bold}${p.in_progress}${C.reset}`);
  lines.push(`${C.white}     ⏳ Ожидают:  ${C.blue}${C.bold}${p.pending}${C.reset}     ${C.white}❌ Failed:  ${C.red}${C.bold}${p.failed}${C.reset}`);
  lines.push('');
  lines.push(`${C.gold}${C.bold}  🏆 ТОП-3 АГЕНТА${C.reset}`);
  lines.push('');
  const medals = ['🥇', '🥈', '🥉'];
  const fitnessList = ctx.fitness || [];
  for (let i = 0; i < fitnessList.length; i++) {
    const a = fitnessList[i];
    lines.push(`${C.white}     ${medals[i]} ${C.blue}${C.bold}${a.box.padEnd(10)}${C.reset}${C.dim}fitness ${C.green}${C.bold}${a.fitness.toFixed(2).padStart(6)}${C.reset}${C.dim}  wins ${C.gold}${String(a.wins_total).padStart(3)}/${String(a.runs_total).padStart(3)}${C.reset}`);
  }
  lines.push('');
  lines.push(`${C.purple}${C.bold}  💰 БЮДЖЕТ LLM${C.reset}`);
  lines.push('');
  if (ctx.budget && ctx.budget.date) {
    lines.push(`${C.white}     Сегодня:    ${C.gold}${C.bold}$${used.toFixed(4)}${C.reset}${C.dim} / $${limit}${C.reset}`);
    lines.push(`${C.white}     Вызовов:    ${C.blue}${C.bold}${ctx.budget.calls || 0}${C.reset}${C.dim}   статус: ${used < limit * 0.5 ? C.green + '✅ норма' : C.gold + '⚠️ близко' }${C.reset}`);
  } else {
    lines.push(`${C.dim}     (нет данных за сегодня)${C.reset}`);
  }
  lines.push('');
  lines.push(`${C.blue}${C.bold}  🏁 ГОНКИ${C.reset}`);
  lines.push('');
  lines.push(`${C.white}     За час:     ${C.green}${C.bold}${ctx.racesRecent}${C.reset}${C.dim}  гонок${C.reset}`);
  lines.push('');
  lines.push(`${C.fire}${C.bold}  🧠 АРХИТЕКТОР${C.reset}`);
  lines.push('');
  lines.push(`${C.white}     Последнее:  ${C.dim}${ctx.lastArchitect.slice(0, 70)}${C.reset}`);
  lines.push('');
  lines.push(`${C.purple}${C.bold}  📦 СВЕЖИЕ КОММИТЫ${C.reset}`);
  lines.push('');
  for (const line of ctx.gitLog.slice(0, 5)) {
    const [hash, ...rest] = line.split(' ');
    lines.push(`${C.dim}     ${hash}  ${C.white}${rest.join(' ').slice(0, 60)}${C.reset}`);
  }
  lines.push('');
  lines.push(`${C.dim}  ${'─'.repeat(72)}${C.reset}`);
  lines.push(`${C.dim}  Uptime: ${ctx.uptime}   |   Обновление каждые 5 сек   |   Ctrl+C — выход${C.reset}`);

  const output = E.clear + lines.join('\n') + '\n';

  // Пишем всё сразу — clear делает сброс
  process.stdout.write(output);
}

process.stdout.write(E.hide);
render();
const timer = setInterval(render, 5000);

process.on('SIGINT', () => {
  clearInterval(timer);
  process.stdout.write(E.show);
  process.stdout.write(E.clear);
  console.log('\n  👋 До встречи, Пульсар.\n');
  process.exit(0);
});
