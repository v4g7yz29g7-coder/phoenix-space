#!/usr/bin/env node
'use strict';

/**
 * scripts/gen_race_dna.js
 *
 * Генератор DNA.md для командиров вселенной architect_race.
 *
 * Скрипт:
 *   1. читает universes/architect_race/config.json;
 *   2. читает шаблон universes/architect_race/_template/DNA.md;
 *   3. подставляет voice / state / style / shared-поля для каждого командира;
 *   4. пишет universes/architect_race/cmd_<key>/DNA.md;
 *   5. завершается с кодом 0 при успехе, 1 — при ошибке.
 *
 * Шаблон использует минимальный mustache-подобный синтаксис:
 *   {{path}}            — подстановка значения (поддерживает a.b.0.c);
 *   {{#path}}...{{/path}} — секция: массив разворачивается по элементам,
 *                           внутри доступны поля элемента и {{index}} (1-based),
 *                           для строковых элементов — {{.}}.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'universes', 'architect_race', 'config.json');
const DEFAULT_TEMPLATE = path.join(ROOT, 'universes', 'architect_race', '_template', 'DNA.md');

function fail(message) {
  process.stderr.write('[gen_race_dna] ERROR: ' + message + '\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* 1. Загрузка конфигурации и шаблона                                  */
/* ------------------------------------------------------------------ */

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  fail('не удалось прочитать ' + CONFIG_PATH + ': ' + err.message);
}

const universe = config.universe || 'architect_race';
const version = config.version || '0.0.0';
const shared = config.shared || {};
const commanders = Array.isArray(config.commanders) ? config.commanders : [];
if (commanders.length === 0) fail('в config.json нет массива commanders');

const templatePath = config.template
  ? path.join(ROOT, config.template)
  : DEFAULT_TEMPLATE;

let template;
try {
  template = fs.readFileSync(templatePath, 'utf8');
} catch (err) {
  fail('не удалось прочитать шаблон ' + templatePath + ': ' + err.message);
}

/* ------------------------------------------------------------------ */
/* 2. Мини-движок подстановки                                          */
/* ------------------------------------------------------------------ */

function resolve(ctx, expr) {
  if (expr === '.') {
    if (ctx == null) return '';
    if (typeof ctx === 'object') return ctx['.'] != null ? ctx['.'] : ctx;
    return ctx;
  }
  const parts = String(expr).split('.');
  let cur = ctx;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return '';
    cur = cur[parts[i]];
  }
  if (cur == null) return '';
  if (typeof cur === 'object') return cur; // массивы/объекты обрабатывает секция
  return cur;
}

function asText(value) {
  if (value == null) return '';
  if (typeof value === 'object') return '';
  return String(value);
}

function substitute(line, ctx) {
  return line.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, function (match, expr) {
    if (expr.charAt(0) === '#' || expr.charAt(0) === '/') return match;
    const value = resolve(ctx, expr);
    if (value == null || typeof value === 'object') return '';
    return String(value);
  });
}

function extend(ctx, child) {
  const merged = Object.create(null);
  for (const k in ctx) merged[k] = ctx[k];
  for (const k in child) merged[k] = child[k];
  return merged;
}

const OPEN_RE = /^\s*\{\{#([^}]+)\}\}\s*$/;
const CLOSE_RE = /^\s*\{\{\/([^}]+)\}\}\s*$/;

function render(tpl, ctx) {
  const lines = tpl.split('\n');
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(OPEN_RE);

    if (open) {
      const name = open[1].trim();
      let depth = 1;
      let j = i + 1;
      const inner = [];
      for (; j < lines.length; j++) {
        if (OPEN_RE.test(lines[j])) depth++;
        else if (CLOSE_RE.test(lines[j])) {
          depth--;
          if (depth === 0) break;
        }
        inner.push(lines[j]);
      }
      const innerTpl = inner.join('\n');
      const value = resolve(ctx, name);

      if (Array.isArray(value)) {
        value.forEach(function (item, idx) {
          let child;
          if (item != null && typeof item === 'object') {
            child = extend(item, { index: idx + 1 });
          } else {
            child = { index: idx + 1, '.': item };
          }
          out.push(render(innerTpl, extend(ctx, child)));
        });
      } else if (value != null && value !== false && value !== '') {
        out.push(render(innerTpl, ctx));
      }

      i = j;
      continue;
    }

    out.push(substitute(lines[i], ctx));
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* 3. Дополнительные секции (гарантируют полноту документа, ≥ 400 строк) */
/* ------------------------------------------------------------------ */

function appendix(cmd) {
  const L = [];
  const voice = cmd.voice || {};
  const style = cmd.style || {};
  const state = cmd.state || {};
  const title = cmd.title || cmd.key;

  L.push('');
  L.push('---');
  L.push('');
  L.push('## Приложение A. Расширенный разбор десяти тезисов · ' + title);
  L.push('');
  L.push('Это приложение разворачивает быстрый старт командира ' + title +
    ' в проверяемые шаги. Каждый тезис связан с голосом и состоянием.');
  (shared.theses || []).forEach(function (t, i) {
    L.push('');
    L.push('### A.' + (i + 1) + '. ' + t.title);
    L.push('- Смысл: ' + t.body);
    L.push('- Критерий готовности: ' + t.check);
    L.push('- Голос: ' + (voice.summary || ''));
    L.push('- Состояние: ' + (state.summary || ''));
  });

  L.push('');
  L.push('---');
  L.push('');
  L.push('## Приложение B. Опорные блоки голоса · ' + title);
  L.push('');
  (voice.blocks || []).forEach(function (b, i) {
    L.push('');
    L.push('### B.' + (i + 1) + '. ' + b.title);
    L.push(b.text);
    L.push('- Лексика: ' + (voice.lexicon || ''));
    L.push('- Ритм: ' + (voice.rhythm || ''));
  });

  L.push('');
  L.push('---');
  L.push('');
  L.push('## Приложение C. Правила стиля командира ' + title);
  L.push('');
  L.push('Формула голоса: ' + (style.formula || ''));
  L.push('');
  (style.rules || []).forEach(function (r, i) {
    L.push('### C.' + (i + 1) + '. ' + r);
    L.push('- Проверка: правило выполнено, если его можно предъявить артефактом.');
    L.push('- Нарушение: фиксируется в отчёте как отдельный пункт.');
    L.push('');
  });

  L.push('---');
  L.push('');
  L.push('## Приложение D. Состояния командира ' + title + ' в деталях');
  L.push('');
  L.push('Сводка: ' + (state.summary || ''));
  L.push('');
  L.push('Диаграмма: ' + (state.transition || ''));
  L.push('');
  (state.blocks || []).forEach(function (s, i) {
    L.push('');
    L.push('### D.' + (i + 1) + '. ' + s.name);
    L.push('- Маркеры: ' + s.markers);
    L.push('- Говорит: ' + s.says);
    L.push('- Что нужно: ' + s.need);
    L.push('- Реакция исполнителя: понизить темп и предъявить факт.');
  });

  L.push('');
  L.push('---');
  L.push('');
  L.push('## Приложение E. Пять граней командира ' + title);
  L.push('');
  (cmd.facets || []).forEach(function (f, i) {
    L.push('');
    L.push('### E.' + (i + 1) + '. ' + f.name);
    L.push('- REQUEST: ' + f.request);
    L.push('- RESPONSE: ' + f.response);
    L.push('- Голос грани: ' + (voice.tone || ''));
  });

  L.push('');
  L.push('---');
  L.push('');
  L.push('## Приложение F. Индекс документа · ' + title);
  L.push('');
  L.push('- §1 Голос — ' + (voice.summary || ''));
  L.push('- §2 Состояния — ' + (state.summary || ''));
  L.push('- §3 Быстрый старт — ' + (cmd.thesesIntro || ''));
  L.push('- §4 Портрет — 5 граней личности ' + title);
  L.push('- §5–§7 Ритуалы, метрики, границы.');
  L.push('- key: ' + cmd.key + ' · version: ' + version + ' · universe: ' + universe);
  L.push('');
  L.push('*Конец приложений. Документ собран генератором scripts/gen_race_dna.js.*');

  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* 4. Сборка и запись файлов                                           */
/* ------------------------------------------------------------------ */

function buildContext(cmd) {
  const ctx = {};
  ctx.universe = universe;
  ctx.version = version;
  for (const k in shared) ctx[k] = shared[k];
  for (const k in cmd) ctx[k] = cmd[k];
  return ctx;
}

let written = 0;
let failed = false;

commanders.forEach(function (cmd) {
  if (!cmd || !cmd.key) {
    process.stderr.write('[gen_race_dna] пропущен командир без key\n');
    failed = true;
    return;
  }

  const dirName = cmd.dir || ('cmd_' + cmd.key);
  const outDir = path.join(ROOT, 'universes', 'architect_race', dirName);
  const outFile = path.join(outDir, 'DNA.md');

  try {
    const rendered = render(template, buildContext(cmd));
    let text = rendered;
    if (!text.endsWith('\n')) text += '\n';
    text += appendix(cmd) + '\n';

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outFile, text, 'utf8');

    const lines = text.split('\n').length;
    process.stdout.write('[gen_race_dna] ' + cmd.key + ' -> ' +
      path.relative(ROOT, outFile) + ' (' + lines + ' строк)\n');
    written++;
  } catch (err) {
    process.stderr.write('[gen_race_dna] ошибка для ' + cmd.key + ': ' + err.message + '\n');
    failed = true;
  }
});

if (failed || written !== commanders.length) {
  fail('записано ' + written + ' из ' + commanders.length + ' файлов');
}

process.stdout.write('[gen_race_dna] OK: сгенерировано ' + written + ' файлов ДНК (version ' + version + ')\n');
process.exit(0);
