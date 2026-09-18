#!/usr/bin/env node
// hybrid_race/runner.js — гонки 3 гибридов ДНК на 20 задачах
'use strict';
const fs = require('fs');
const path = require('path');
const agent = require('../../architect/agent');

const HERE = __dirname;
const TASKS = JSON.parse(fs.readFileSync(path.join(HERE, '_tasks', 'tasks.json'), 'utf8')).tasks;
const MODES = ['tech', 'style', 'full'];
const RESULTS = path.join(HERE, '_judge', 'results.json');

async function run() {
  const results = [];
  for (let i = 0; i < TASKS.length; i++) {
    const t = TASKS[i];
    console.log(`\n[${i + 1}/${TASKS.length}] ${t.id}: ${t.q.slice(0, 60)}`);
    
    const row = { id: t.id, type: t.type, q: t.q, answers: {} };
    
    for (const mode of MODES) {
      // Переключаем ДНК для каждого режима
      const dnaFile = path.join(HERE, mode, 'DNA.md');
      process.env.ARCHITECT_DNA = dnaFile;
      
      try {
        const t0 = Date.now();
        const r = await agent.respond(t.q);
        row.answers[mode] = {
          mode: r.mode,
          answer: r.answer,
          ragHits: r.ragHits,
          ms: Date.now() - t0,
          len: (r.answer || '').length,
        };
        console.log(`  ${mode}: ${r.mode} | ${row.answers[mode].len} chars | ${row.answers[mode].ms}ms`);
      } catch (e) {
        row.answers[mode] = { error: e.message };
        console.log(`  ${mode}: ❌ ${e.message}`);
      }
    }
    results.push(row);
    
    // Сохраняем после каждой задачи (устойчивость к падениям)
    fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2));
  }
  
  console.log(`\n✅ Готово: ${RESULTS}`);
  console.log(`   Задач: ${results.length}, режимов: ${MODES.length}`);
}

if (require.main === module) {
  run().catch(e => { console.error('❌ FATAL:', e); process.exit(1); });
}

module.exports = { run };
