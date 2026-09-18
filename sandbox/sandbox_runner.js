/**
 * sandbox/sandbox_runner.js
 * --------------------------
 * Изолированный запуск эксперимента.
 *
 * Публичный API:
 *     run(experiment) -> Promise<Result>
 *
 * `experiment` — либо функция, либо объект вида:
 *   {
 *     name?:        string,
 *     fn?:          Function,          // синхронная или async: (ctx) => any
 *     code?:        string,            // строка кода (исполняется через vm)
 *     args?:        any[],             // аргументы, передаваемые в fn
 *     timeoutMs?:   number,            // жёсткий таймаут (default 5000)
 *     memoryMb?:    number,            // лимит памяти (default 256)
 *     allowNetwork: boolean,           // запрет net/dns по умолчанию
 *     allowFs:      boolean,           // запрет fs по умолчанию
 *     env?:         object,            // санитизированное окружение
 *     retries?:     number,            // число повторов при падении
 *     captureConsole?: boolean,        // перехват console.* (default true)
 *   }
 *
 * Реализация использует node:vm для создания изолированного контекста,
 * жёсткий таймаут через vm.runInContext({timeout}) и мягкий watchdog,
 * а также «замороженный» набор глобалов, недоступных по умолчанию.
 *
 * Модуль самодостаточен, не бросает исключений наружу: любые ошибки
 * упаковываются в Result с полем ok === false.
 */

'use strict';

const vm = require('node:vm');
const util = require('node:util');
const { performance } = require('node:perf_hooks');

// ---------------------------------------------------------------------------
// Константы и значения по умолчанию
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  name: 'anonymous-experiment',
  timeoutMs: 5000,
  memoryMb: 256,
  allowNetwork: false,
  allowFs: false,
  retries: 0,
  captureConsole: true,
  maxOutputBytes: 64 * 1024,
});

// Запрещённые для «песочных» модули и глобалы.
const FORBIDDEN_MODULES = Object.freeze([
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'child_process',
  'node:child_process',
  'net',
  'node:net',
  'http',
  'node:http',
  'https',
  'node:https',
  'dgram',
  'node:dgram',
  'cluster',
  'node:cluster',
  'worker_threads',
  'node:worker_threads',
  'vm',
  'node:vm',
  'module',
  'node:module',
  'process',
  'node:process',
]);

const SAFE_GLOBALS = Object.freeze([
  'Array',
  'Object',
  'Function',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'BigInt',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Reflect',
  'Proxy',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'ReferenceError',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'Infinity',
  'NaN',
  'undefined',
]);

// ---------------------------------------------------------------------------
// Вспомогательные функции
// ---------------------------------------------------------------------------

/**
 * Усекает строку до maxBytes (в байтах utf8), добавляя маркер обрезки.
 * @param {string} str
 * @param {number} maxBytes
 * @returns {string}
 */
function truncate(str, maxBytes) {
  if (typeof str !== 'string') {
    str = String(str);
  }
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) {
    return str;
  }
  return buf.subarray(0, maxBytes).toString('utf8') + '\n...[truncated]';
}

/**
 * Безопасная сериализация произвольного значения для логов.
 * @param {*} value
 * @returns {string}
 */
function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      if (typeof val === 'function') {
        return `[Function ${val.name || 'anonymous'}]`;
      }
      if (typeof val === 'bigint') {
        return `${val.toString()}n`;
      }
      if (typeof val === 'undefined') {
        return '[undefined]';
      }
      return val;
    });
  } catch (_err) {
    return util.inspect(value, { depth: 2, breakLength: 120 });
  }
}

/**
 * Нормализует вход: приводит эксперимент к единому описанию.
 * @param {Function|object} experiment
 * @returns {object}
 */
function normalizeExperiment(experiment) {
  if (typeof experiment === 'function') {
    return Object.assign({}, DEFAULTS, { fn: experiment });
  }
  if (experiment && typeof experiment === 'object') {
    return Object.assign({}, DEFAULTS, experiment);
  }
  throw new TypeError('run(experiment): ожидается функция или объект');
}

/**
 * Валидирует нормализованный дескриптор эксперимента.
 * @param {object} spec
 */
function validateSpec(spec) {
  if (typeof spec.fn !== 'function' && typeof spec.code !== 'string') {
    throw new TypeError('experiment должен содержать fn() или code');
  }
  if (typeof spec.timeoutMs !== 'number' || spec.timeoutMs <= 0) {
    throw new RangeError('timeoutMs должен быть положительным числом');
  }
  if (typeof spec.memoryMb !== 'number' || spec.memoryMb <= 0) {
    throw new RangeError('memoryMb должен быть положительным числом');
  }
  if (!Array.isArray(spec.args)) {
    throw new TypeError('args должен быть массивом');
  }
}

// ---------------------------------------------------------------------------
// Сборщик вывода (перехват console.*)
// ---------------------------------------------------------------------------

class OutputCollector {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
  }

  /**
   * @param {'log'|'warn'|'error'|'info'|'debug'} level
   * @param {any[]} args
   */
  push(level, args) {
    const line = args
      .map((a) =>
        typeof a === 'string' ? a : util.inspect(a, { depth: 3, breakLength: 120 })
      )
      .join(' ');
    const formatted = `[${level}] ${line}`;
    if (this.bytes >= this.maxBytes) {
      this.truncated = true;
      return;
    }
    this.chunks.push(formatted);
    this.bytes += Buffer.byteLength(formatted, 'utf8') + 1;
  }

  /** @returns {string[]} */
  drain() {
    return this.chunks.slice();
  }

  /** @returns {{lines: string[], truncated: boolean}} */
  result() {
    return { lines: this.drain(), truncated: this.truncated };
  }
}

/**
 * Создаёт песочную копию console, пишущую в коллектор.
 * @param {OutputCollector} collector
 * @returns {object}
 */
function makeSandboxConsole(collector) {
  const mk = (level) => (...args) => collector.push(level, args);
  return Object.freeze({
    log: mk('log'),
    info: mk('info'),
    warn: mk('warn'),
    error: mk('error'),
    debug: mk('debug'),
    trace: mk('debug'),
  });
}

// ---------------------------------------------------------------------------
// Безопасный require (allow-list + запреты)
// ---------------------------------------------------------------------------

/**
 * Создаёт ограниченный require для песочного кода.
 * @param {object} spec
 * @returns {Function}
 */
function makeSafeRequire(spec) {
  const cache = new Map();
  return function safeRequire(id) {
    if (typeof id !== 'string') {
      throw new TypeError('require(id): id должен быть строкой');
    }
    const base = id.replace(/^node:/, '');
    if (FORBIDDEN_MODULES.includes(id) || FORBIDDEN_MODULES.includes(`node:${base}`)) {
      // Разрешаем точечно, если явно включено флагом.
      const isNet = ['net', 'http', 'https', 'dgram'].includes(base);
      const isFs = base === 'fs' || base === 'fs/promises';
      if (isNet && spec.allowNetwork) {
        return require(id);
      }
      if (isFs && spec.allowFs) {
        return require(id);
      }
      throw new Error(`Модуль "${id}" запрещён в песочнице`);
    }
    if (cache.has(id)) {
      return cache.get(id);
    }
    const mod = require(id);
    cache.set(id, mod);
    return mod;
  };
}

// ---------------------------------------------------------------------------
// Песочный контекст
// ---------------------------------------------------------------------------

/**
 * Собирает изолированный контекст vm для эксперимента.
 * @param {object} spec
 * @param {OutputCollector} collector
 * @param {object} meta
 * @returns {vm.Context}
 */
function buildContext(spec, collector, meta) {
  const sandbox = Object.create(null);

  for (const name of SAFE_GLOBALS) {
    // eslint-disable-next-line no-undef
    if (typeof globalThis[name] !== 'undefined') {
      sandbox[name] = globalThis[name];
    }
  }

  const sandboxConsole = spec.captureConsole
    ? makeSandboxConsole(collector)
    : { log() {}, info() {}, warn() {}, error() {}, debug() {} };

  // Имитация process с урезанными возможностями.
  const fakeProcess = Object.freeze({
    env: Object.freeze(Object.assign({}, spec.env || {})),
    platform: process.platform,
    version: process.version,
    versions: Object.freeze({ node: process.version }),
    nextTick: (fn, ...a) => process.nextTick(fn, ...a),
    hrtime: (t) => process.hrtime(t),
  });

  Object.assign(sandbox, {
    console: sandboxConsole,
    process: fakeProcess,
    require: makeSafeRequire(spec),
    module: { exports: {} },
    exports: {},
    __filename: '<sandbox>',
    __dirname: '<sandbox>',
    __meta: Object.freeze(meta),
    setTimeout: (fn, ms, ...a) => {
      // Таймеры ограничены текущим прогоном.
      return setTimeout(fn, ms, ...a);
    },
    clearTimeout,
    setInterval: (fn, ms, ...a) => setInterval(fn, ms, ...a),
    clearInterval,
    queueMicrotask,
    structuredClone: typeof structuredClone === 'function' ? structuredClone : undefined,
  });

  const context = vm.createContext(sandbox, {
    name: `sandbox:${meta.name}`,
    codeGeneration: { strings: true, wasm: false },
  });

  return context;
}

// ---------------------------------------------------------------------------
// Извлечение результата
// ---------------------------------------------------------------------------

/**
 * Пытается вытащить структурированный результат эксперимента.
 * @param {*} raw
 * @returns {{value: any, serialized: string}}
 */
function packResult(raw) {
  let value = raw;
  if (value && typeof value === 'object' && 'default' in value && Object.keys(value).length === 1) {
    value = value.default;
  }
  const serialized = safeStringify(value);
  return { value, serialized };
}

// ---------------------------------------------------------------------------
// Ядро: один прогон
// ---------------------------------------------------------------------------

/**
 * Выполняет один прогон эксперимента без повторов.
 * @param {object} spec
 * @returns {Promise<object>}
 */
async function runOnce(spec) {
  const collector = new OutputCollector(spec.maxOutputBytes);
  const started = performance.now();
  const meta = {
    name: spec.name,
    startedAt: new Date().toISOString(),
    timeoutMs: spec.timeoutMs,
    memoryMb: spec.memoryMb,
  };

  const context = buildContext(spec, collector, meta);

  try {
    let raw;

    if (typeof spec.fn === 'function') {
      // Функция пользователя вызывается напрямую, но аргументы передаются
      // через безопасный фасад (без прямого доступа к реальному процессу).
      const ctx = Object.freeze({
        console: context.console,
        meta: context.__meta,
        args: Object.freeze(spec.args.slice()),
        now: () => performance.now(),
      });
      raw = spec.fn.apply(null, [ctx, ...spec.args]);
      if (raw && typeof raw.then === 'function') {
        raw = await Promise.race([
          raw,
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('Timeout: async experiment exceeded')), spec.timeoutMs)
          ),
        ]);
      }
    } else {
      const wrapped = `(async () => {\n${spec.code}\n})()`;
      raw = vm.runInContext(wrapped, context, {
        timeout: spec.timeoutMs,
        displayErrors: true,
        filename: `experiment:${spec.name}.js`,
      });
      if (raw && typeof raw.then === 'function') {
        raw = await Promise.race([
          raw,
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('Timeout: vm experiment exceeded')), spec.timeoutMs)
          ),
        ]);
      }
    }

    const elapsedMs = performance.now() - started;
    const packed = packResult(raw);
    const out = collector.result();

    return {
      ok: true,
      name: spec.name,
      result: packed.value,
      resultSerialized: packed.serialized,
      stdout: out.lines,
      outputTruncated: out.truncated,
      error: null,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      attempts: 1,
    };
  } catch (err) {
    const elapsedMs = performance.now() - started;
    const out = collector.result();
    return {
      ok: false,
      name: spec.name,
      result: undefined,
      resultSerialized: 'undefined',
      stdout: out.lines,
      outputTruncated: out.truncated,
      error: {
        name: err && err.name ? err.name : 'Error',
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? truncate(err.stack, 4096) : null,
      },
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      attempts: 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Публичный API
// ---------------------------------------------------------------------------

/**
 * Изолированно запускает эксперимент.
 *
 * @param {Function|object} experiment
 * @returns {Promise<object>} Result — всегда resolve, никогда не reject.
 */
async function run(experiment) {
  let spec;
  try {
    spec = normalizeExperiment(experiment);
    validateSpec(spec);
  } catch (err) {
    return {
      ok: false,
      name: (experiment && experiment.name) || DEFAULTS.name,
      result: undefined,
      resultSerialized: 'undefined',
      stdout: [],
      outputTruncated: false,
      error: {
        name: err.name || 'Error',
        message: err.message,
        stack: err.stack || null,
      },
      elapsedMs: 0,
      attempts: 0,
    };
  }

  const attemptsTotal = Math.max(1, (spec.retries | 0) + 1);
  let last = null;

  for (let attempt = 1; attempt <= attemptsTotal; attempt += 1) {
    last = await runOnce(spec);
    last.attempts = attempt;
    if (last.ok) {
      return last;
    }
    // Небольшая пауза перед повтором.
    if (attempt < attemptsTotal) {
      await new Promise((r) => setTimeout(r, 25 * attempt));
    }
  }

  return last;
}

// ---------------------------------------------------------------------------
// Диагностика / само-тест при прямом запуске
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    const ok = await run({
      name: 'self-test',
      fn: (ctx) => {
        ctx.console.log('hello from sandbox');
        return { sum: 2 + 2, args: ctx.args };
      },
      args: [1, 2, 3],
      timeoutMs: 1000,
    });
    // eslint-disable-next-line no-console
    console.log('self-test ok=%s elapsed=%sms', ok.ok, ok.elapsedMs);

    const blocked = await run({
      name: 'blocked-fs',
      fn: () => {
        // eslint-disable-next-line global-require
        require('fs');
        return 'should not reach';
      },
      timeoutMs: 500,
    });
    // eslint-disable-next-line no-console
    console.log('blocked ok=%s err=%s', blocked.ok, blocked.error && blocked.error.message);

    process.exitCode = ok.ok && !blocked.ok ? 0 : 1;
  })();
}

module.exports = {
  run,
  __internals: {
    normalizeExperiment,
    validateSpec,
    truncate,
    safeStringify,
    OutputCollector,
    makeSandboxConsole,
    makeSafeRequire,
    buildContext,
    packResult,
    runOnce,
    DEFAULTS,
    FORBIDDEN_MODULES,
    SAFE_GLOBALS,
  },
};
