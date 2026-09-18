#!/usr/bin/env node
/**
 * evolution/puppeteer.test.js
 * ============================================================================
 * Smoke-тест для evolution/puppeteer.js — «Кукловод» (Puppeteer).
 *
 * Проверяет КРИТЕРИЙ приёмки:
 *   - файл существует и > 150 строк;
 *   - `node --check` проходит без синтаксических ошибок;
 *   - публичный экспорт `Puppeteer` (class) + фабрика createPuppeteer;
 *   - наблюдения pool_size/load/budget/history нормализуются устойчиво;
 *   - действия строго из {start_race, change_priority, switch_strategy};
 *   - rule-based заглушка возвращает корректные решения;
 *   - награда = w_q*quality + w_e*budget_efficiency + w_s*stability;
 *   - observe()/step() не бросают исключений на мусорных данных;
 *   - serialize()/deserialize() round-trip сохраняет состояние.
 *
 * Запуск:
 *   node evolution/puppeteer.test.js
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TARGET = path.join(__dirname, 'puppeteer.js');
const MIN_LINES = 150;

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`);
  }
}

function section(title) {
  console.log(`\n[${title}]`);
}

function near(a, b, eps = 1e-6) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= eps;
}

/* ------------------------------------------------------------------ */
/* 1. Существование и размер файла                                     */
/* ------------------------------------------------------------------ */
section('file & criterion');
ok('evolution/puppeteer.js существует', fs.existsSync(TARGET));

const src = fs.readFileSync(TARGET, 'utf8');
const lineCount = src.split('\n').length;
ok(`строк > ${MIN_LINES} (фактически ${lineCount})`, lineCount > MIN_LINES);

/* ------------------------------------------------------------------ */
/* 2. Синтаксис: node --check                                          */
/* ------------------------------------------------------------------ */
section('syntax');
let syntaxOk = true;
let syntaxMsg = '';
try {
  execFileSync(process.execPath, ['--check', TARGET], { stdio: 'pipe' });
} catch (err) {
  syntaxOk = false;
  syntaxMsg = (err && err.stderr ? err.stderr.toString() : String(err)).trim();
}
ok('node --check OK', syntaxOk, syntaxMsg);

/* ------------------------------------------------------------------ */
/* 3. Публичный API                                                    */
/* ------------------------------------------------------------------ */
section('public API');
const mod = require('./puppeteer');
ok('module.exports содержит Puppeteer', typeof mod.Puppeteer === 'function');
ok('module.exports содержит createPuppeteer', typeof mod.createPuppeteer === 'function');
ok('export ACTIONS.start_race', !!(mod.ACTIONS && mod.ACTIONS.START_RACE === 'start_race'));
ok('export ACTIONS.change_priority', !!(mod.ACTIONS && mod.ACTIONS.CHANGE_PRIORITY === 'change_priority'));
ok('export ACTIONS.switch_strategy', !!(mod.ACTIONS && mod.ACTIONS.SWITCH_STRATEGY === 'switch_strategy'));

const pup = mod.createPuppeteer({ mode: 'rule', qTableFile: null });
ok('createPuppeteer() возвращает экземпляр Puppeteer', pup instanceof mod.Puppeteer);

/* ------------------------------------------------------------------ */
/* 4. Нормализация наблюдений                                          */
/* ------------------------------------------------------------------ */
section('observation');
const obs = mod.normalizeObservation({
  pool_size: 5,
  load: 30, // проценты должны ужаться в 0..1
  budget: { total: 100, remaining: 40 },
  history: [{ quality: 0.5 }, { quality: 0.6 }, { quality: 0.7 }],
});
ok('pool_size === 5', obs.pool_size === 5, String(obs.pool_size));
ok('load 30% \u2192 0.3', near(obs.load, 0.3, 1e-9), String(obs.load));
ok('budget_ratio === 0.4', near(obs.budget_ratio, 0.4, 1e-9), String(obs.budget_ratio));
ok('quality_mean по истории', obs.quality_mean > 0.5 && obs.quality_mean < 0.7, String(obs.quality_mean));
ok('trend определён', ['up', 'down', 'flat'].includes(obs.trend), obs.trend);
ok('stability в 0..1', obs.stability >= 0 && obs.stability <= 1, String(obs.stability));

const junk = mod.normalizeObservation(null);
ok('normalizeObservation(null) не бросает', !!junk && typeof junk === 'object');
ok('junk.pool_size >= 0', junk.pool_size >= 0);
ok('junk.budget_ratio в 0..1', junk.budget_ratio >= 0 && junk.budget_ratio <= 1);

/* ------------------------------------------------------------------ */
/* 5. Rule-based заглушка: действия и решения                          */
/* ------------------------------------------------------------------ */
section('rule policy');
const idle = mod.createPuppeteer({ mode: 'rule', qTableFile: null });
let decision = null;
let decidedThrew = null;
try {
  decision = idle.decide({ pool_size: 6, load: 0.2, budget: { total: 100, remaining: 90 }, history: [] });
} catch (err) {
  decidedThrew = err;
}
ok('decide() не бросает исключение', !decidedThrew, decidedThrew && decidedThrew.message);
ok('decide() возвращает объект', !!decision && typeof decision === 'object');
ok('action входит в ACTION_LIST', !!(decision && mod.ACTION_LIST.includes(decision.action)), decision && decision.action);
ok('по умолчанию источник rule', !!(decision && decision.source === 'rule'), decision && decision.source);
ok('свободный пул \u2192 start_race', !!(decision && decision.action === 'start_race'), decision && decision.action);

const busy = mod.createPuppeteer({ mode: 'rule', qTableFile: null });
const dBusy = busy.decide({ pool_size: 6, load: 0.95, budget: { total: 100, remaining: 90 }, history: [] });
ok('перегруз \u2192 switch_strategy', dBusy.action === 'switch_strategy', dBusy.action);
ok('перегруз \u2192 стратегия throttle', !!(dBusy.params && dBusy.params.strategy === 'throttle'), JSON.stringify(dBusy.params));

const poor = mod.createPuppeteer({ mode: 'rule', qTableFile: null });
const dPoor = poor.decide({ pool_size: 6, load: 0.2, budget: { total: 100, remaining: 5 }, history: [] });
ok('бедный бюджет \u2192 switch_strategy', dPoor.action === 'switch_strategy', dPoor.action);
ok('бедный бюджет \u2192 budget_first', !!(dPoor.params && dPoor.params.strategy === 'budget_first'), JSON.stringify(dPoor.params));

// Детерминизм заглушки: одинаковый вход \u2192 одинаковый выход.
const a1 = idle.rulePolicy(idle.observeState({ pool_size: 6, load: 0.2, budget: 90, history: [] }));
const a2 = idle.rulePolicy(idle.observeState({ pool_size: 6, load: 0.2, budget: 90, history: [] }));
ok('rulePolicy детерминирован', a1.action === a2.action && JSON.stringify(a1.params) === JSON.stringify(a2.params));

/* ------------------------------------------------------------------ */
/* 6. Награда                                                          */
/* ------------------------------------------------------------------ */
section('reward');
const rw = mod.computeReward({ quality: 0.8, budget_efficiency: 0.5, stability: 0.9 }, { quality: 0.5, budget_efficiency: 0.3, stability: 0.2 });
const expected = 0.5 * 0.8 + 0.3 * 0.5 + 0.2 * 0.9;
ok('reward = взвешенная сумма компонент', near(rw.reward, expected, 2e-3), `${rw.reward} vs ${expected}`);
ok('компоненты присутствуют', !!(rw.components && rw.components.quality != null && rw.components.budget_efficiency != null && rw.components.stability != null));
ok('reward в разумных границах 0..1', rw.reward >= 0 && rw.reward <= 1, String(rw.reward));

const rwJunk = mod.computeReward(null);
ok('computeReward(null) не бросает', !!rwJunk && typeof rwJunk.reward === 'number');

const learner = mod.createPuppeteer({ mode: 'rule', qTableFile: null });
learner.decide({ pool_size: 5, load: 0.3, budget: { total: 100, remaining: 80 }, history: [] });
let observeThrew = null;
let observed = null;
try {
  observed = learner.observe({ quality: 0.7, spent: 20, budget: 100, stability: 0.8 });
} catch (err) {
  observeThrew = err;
}
ok('observe() не бросает', !observeThrew, observeThrew && observeThrew.message);
ok('observe() возвращает reward', !!(observed && typeof observed.reward === 'number'));
ok('stats().steps вырос', learner.stats().steps >= 1, String(learner.stats().steps));

/* ------------------------------------------------------------------ */
/* 7. Эпизод step()/runEpisode()                                       */
/* ------------------------------------------------------------------ */
section('episode');
(async () => {
  const agent = mod.createPuppeteer({ mode: 'hybrid', qTableFile: null });

  const stepRes = await agent.step(
    { pool_size: 5, load: 0.3, budget: { total: 100, remaining: 90 }, history: [] },
    () => ({ metrics: { quality: 0.6, spent: 10, budget: 100, stability: 0.9 }, nextState: { pool_size: 5, load: 0.5, budget: 80 } }),
  );
  ok('step() возвращает action+reward', !!(stepRes && stepRes.action && typeof stepRes.reward === 'number'));

  let episodeThrew = null;
  let log = null;
  try {
    log = await agent.runEpisode(
      () => ({ pool_size: 5, load: 0.3, budget: { total: 100, remaining: 90 }, history: [] }),
      () => ({ metrics: { quality: 0.6, spent: 10, budget: 100, stability: 0.9 }, nextState: { pool_size: 5, load: 0.4, budget: 80 } }),
      5,
    );
  } catch (err) {
    episodeThrew = err;
  }
  ok('runEpisode() не бросает', !episodeThrew, episodeThrew && episodeThrew.message);
  ok('runEpisode() вернул 5 шагов', !!(Array.isArray(log) && log.length === 5), log && String(log.length));

  /* ---------------------------------------------------------------- */
  /* 8. Персистенция                                                  */
  /* ---------------------------------------------------------------- */
  section('persistence');
  const saved = agent.serialize();
  ok('serialize() содержит version', !!(saved && saved.version != null));
  ok('serialize() содержит q', !!(saved && Array.isArray(saved.q)));
  const restored = mod.Puppeteer.deserialize(saved, { qTableFile: null });
  ok('deserialize() восстанавливает strategy', restored.strategy === agent.strategy);
  ok('deserialize() восстанавливает steps', restored.steps === agent.steps, `${restored.steps} vs ${agent.steps}`);
  ok('deserialize() восстанавливает Q-таблицу', restored.q.size === agent.q.size, `${restored.q.size} vs ${agent.q.size}`);

  /* ---------------------------------------------------------------- */
  /* 9. CLI smoke (--demo --json)                                     */
  /* ---------------------------------------------------------------- */
  section('cli');
  let cliOk = true;
  let cliMsg = '';
  try {
    const out = execFileSync(process.execPath, [TARGET, '--demo', '--steps', '5', '--json'], { stdio: 'pipe', timeout: 20000 });
    const parsed = JSON.parse(out.toString());
    if (!parsed || !parsed.stats) cliOk = false;
  } catch (err) {
    cliOk = false;
    cliMsg = (err && err.message) || String(err);
  }
  ok('node puppeteer.js --demo --json отдаёт JSON', cliOk, cliMsg);

  /* ---------------------------------------------------------------- */
  console.log('\n' + '='.repeat(60));
  console.log(`puppeteer.test.js: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  process.exitCode = failed ? 1 : 0;
})();
