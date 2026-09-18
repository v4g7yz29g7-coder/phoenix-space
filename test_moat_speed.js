'use strict';
// test_moat_speed.js — замер скорости Рва vs LLM
// Прогоняет одну задачу 2 раза: с отключённым Рвом и с включённым
// Считает время, токены, источник

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BOX = path.join(ROOT, 'boxes', 'agent_1');
const LOG = path.join(ROOT, 'memory', 'moat_speed_test.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
}

// Прогон задачи в боксе с указанным состоянием Рва
function runTask(task, moatEnabled) {
  const env = {
    ...process.env,
    RACE_TASK: task,
    MOAT_DISABLED: moatEnabled ? '0' : '1',
  };

  const start = Date.now();
  let output = '';
  try {
    output = execSync('timeout 90 node _runner.js 2>&1', {
      cwd: BOX,
      env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    output = (e.stdout || '') + (e.stderr || '');
  }
  const ms = Date.now() - start;

  // Парсим финальный JSON
  const lines = output.split('\n').filter(Boolean);
  let parsed = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { parsed = JSON.parse(lines[i]); break; } catch (e) {}
  }

  // Извлекаем usage из логов (in=X cached=Y fresh=Z out=W)
  const usageMatch = output.match(/\[usage\][^\n]*/g) || [];
  let totalIn = 0, totalOut = 0, totalFresh = 0, calls = 0;
  for (const u of usageMatch) {
    const m = u.match(/in=(\d+)\s+cached=(\d+)\s*\([^)]*\)\s+fresh=(\d+)\s+out=(\d+)/);
    if (m) {
      totalIn += parseInt(m[1]);
      totalFresh += parseInt(m[3]);
      totalOut += parseInt(m[4]);
      calls++;
    }
  }

  return {
    ms,
    ok: parsed ? parsed.ok : null,
    source: parsed ? (parsed.source || 'unknown') : 'no-json',
    winner: parsed ? parsed.moat_winner : null,
    tokens: { in: totalIn, fresh: totalFresh, out: totalOut, calls },
    outputTail: output.split('\n').slice(-3).join('\n').slice(0, 500),
  };
}

// === Тестовые задачи ===
const tasks = [
  {
    name: 'A: файл есть в ФС (быстрый путь)',
    task: 'Создай файл alerting.js — детектор ошибок',
  },
  {
    name: 'B: файл есть в Рве (средний путь)',
    task: 'Создай файл observability/agent_health.js — метрики агента',
  },
  {
    name: 'C: нет ни в ФС, ни в Рве (LLM)',
    task: 'Скажи привет',
  },
];

async function main() {
  log('════════ MOAT SPEED TEST ════════');

  const results = [];
  for (const t of tasks) {
    log(`\n--- ${t.name} ---`);
    log(`Task: ${t.task.slice(0, 100)}`);

    // 1. С Рвом
    log('Запуск С РВОМ...');
    const withMoat = runTask(t.task, true);
    log(`С Рвом: ${withMoat.ms}ms | source=${withMoat.source} | tokens in=${withMoat.tokens.in} fresh=${withMoat.tokens.fresh} out=${withMoat.tokens.out} calls=${withMoat.tokens.calls}`);

    // 2. Без Рва (для сравнения — только если задача C)
    let withoutMoat = null;
    if (t.name.startsWith('C')) {
      log('Запуск БЕЗ РВА (для сравнения)...');
      withoutMoat = runTask(t.task, false);
      log(`Без Рва: ${withoutMoat.ms}ms | source=${withoutMoat.source} | tokens in=${withoutMoat.tokens.in} fresh=${withoutMoat.tokens.fresh} out=${withoutMoat.tokens.out} calls=${withoutMoat.tokens.calls}`);
    }

    results.push({ name: t.name, withMoat, withoutMoat });
  }

  log('\n════════ РЕЗУЛЬТАТЫ ════════');
  for (const r of results) {
    log(`\n${r.name}`);
    log(`  С Рвом: ${r.withMoat.ms}ms | ${r.withMoat.source} | tokens=${r.withMoat.tokens.in}→${r.withMoat.tokens.out} | calls=${r.withMoat.tokens.calls}`);
    if (r.withoutMoat) {
      log(`  Без Рва: ${r.withoutMoat.ms}ms | ${r.withoutMoat.source} | tokens=${r.withoutMoat.tokens.in}→${r.withoutMoat.tokens.out} | calls=${r.withoutMoat.tokens.calls}`);
      const speedup = (r.withoutMoat.ms / Math.max(r.withMoat.ms, 1)).toFixed(1);
      log(`  Ускорение: ×${speedup}`);
    }
  }
}

main().catch(e => console.error(e));
