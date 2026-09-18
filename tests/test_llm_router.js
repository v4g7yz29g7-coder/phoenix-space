// tests/test_llm_router.js
// Тесты для lib/llm_router.js (коммит f06ad628 — единый llm_router: логирование + бюджет).
//
// Покрытие:
//   1) роутинг model='chat' → model='flash' при перегрузке/ошибке primary;
//   2) логирование usage (tokens_in, tokens_out, model) в logs/llm_usage.jsonl;
//   3) превышение дневного бюджета → {ok:false, reason:'budget_exceeded'} БЕЗ сетевого запроса;
//   4) fallback не зацикливается — максимум 1 ретрай (ровно 2 сетевых попытки при полном отказе).
//
// Все сетевые вызовы замоканы (global.fetch). Реальных API-запросов нет.
//
// Критерий: `node tests/test_llm_router.js` → exit 0 и печать 'PASS 4/4'.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// --- Изоляция окружения ДО require модуля ---
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-router-test-'));
const USAGE_LOG = path.join(TMP, 'llm_usage.jsonl');
const BUDGET_FILE = path.join(TMP, 'llm_budget.json');

process.env.LLM_USAGE_LOG = USAGE_LOG;
process.env.LLM_BUDGET_FILE = BUDGET_FILE;
process.env.LLM_DAILY_LIMIT_USD = '3';
process.env.LLM_API_URL = 'https://mock.invalid/v1/chat/completions';
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';

const router = require('../lib/llm_router');

// ---------------- helpers ----------------

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function resetBudget(cost = 0) {
  // Пишем бюджет-файл напрямую (изоляция без правок в lib/llm_router.js).
  fs.writeFileSync(
    BUDGET_FILE,
    JSON.stringify({ date: todayStr(), cost, calls: 0 })
  );
}

function clearLog() {
  try { fs.unlinkSync(USAGE_LOG); } catch (e) { /* ignore */ }
}

function readLog() {
  if (!fs.existsSync(USAGE_LOG)) return [];
  return fs
    .readFileSync(USAGE_LOG, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

// Мок fetch: handler(body, attemptNumber) -> Response-подобный объект.
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, model: body.model, body });
    return handler(body, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function okResponse(tokensIn, tokensOut) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
      };
    },
  };
}

function errResponse(status) {
  return {
    ok: false,
    status,
    async json() { return {}; },
    async text() { return 'err ' + status; },
  };
}

const MSGS = [{ role: 'user', content: 'ping' }];

// ---------------- tests ----------------

const tests = [
  {
    name: '1. роутинг chat → flash при перегрузке primary',
    async fn() {
      resetBudget(0);
      clearLog();
      // primary (chat) перегружен → 503; fallback (flash) отвечает успешно.
      global.fetch = makeFetch((body) => {
        if (body.model === 'chat') return errResponse(503);
        return okResponse(12, 7);
      });

      const res = await router.call(MSGS, { model: 'chat' });

      assert(res.ok === true, 'ожидался ok:true, получено ' + JSON.stringify(res));
      assert(res.model === 'flash', 'ожидался model=flash (fallback), получено ' + res.model);
      assert(global.fetch.calls.length === 2, 'ожидалось 2 попытки, получено ' + global.fetch.calls.length);
      assert(global.fetch.calls[0].model === 'chat', 'первая попытка должна быть chat');
      assert(global.fetch.calls[1].model === 'flash', 'вторая попытка должна быть flash (роутинг)');
    },
  },
  {
    name: '2. логирование usage в logs/llm_usage.jsonl',
    async fn() {
      resetBudget(0);
      clearLog();
      global.fetch = makeFetch(() => okResponse(33, 44));

      const res = await router.call(MSGS, { model: 'chat' });
      assert(res.ok === true, 'ожидался ok:true');

      const lines = readLog();
      assert(lines.length === 1, 'ожидалась ровно 1 строка в логе, получено ' + lines.length);

      const entry = lines[0];
      assert(entry.model === 'chat', 'в логе model должен быть chat, получено ' + entry.model);
      assert(entry.tokens_in === 33, 'в логе tokens_in=33, получено ' + entry.tokens_in);
      assert(entry.tokens_out === 44, 'в логе tokens_out=44, получено ' + entry.tokens_out);
    },
  },
  {
    name: '3. превышение бюджета → budget_exceeded без сетевого запроса',
    async fn() {
      resetBudget(999); // заведомо больше дневного лимита $3
      clearLog();
      let networkHit = 0;
      global.fetch = makeFetch(() => { networkHit += 1; return okResponse(1, 1); });

      const res = await router.call(MSGS, { model: 'chat' });

      assert(res.ok === false, 'ожидался ok:false, получено ' + JSON.stringify(res));
      assert(res.reason === 'budget_exceeded', "ожидался reason='budget_exceeded', получено " + res.reason);
      assert(networkHit === 0, 'сетевой запрос НЕ должен выполняться при превышении бюджета');
      assert(global.fetch.calls.length === 0, 'fetch не должен вызываться при превышении бюджета');
      assert(readLog().length === 0, 'при превышении бюджета лог не должен пополняться');
    },
  },
  {
    name: '4. fallback не зацикливается — максимум 1 ретрай',
    async fn() {
      resetBudget(0);
      clearLog();
      // Все попытки падают → ровно 2 сетевых вызова (primary + 1 ретрай), затем выход.
      global.fetch = makeFetch(() => errResponse(500));

      const res = await router.call(MSGS, { model: 'chat' });

      assert(res.ok === false, 'ожидался ok:false при полном отказе');
      assert(global.fetch.calls.length === 2,
        'ожидалось ровно 2 попытки (1 primary + 1 ретрай), получено ' + global.fetch.calls.length);
      assert(global.fetch.calls[0].model === 'chat', 'первая попытка — chat');
      assert(global.fetch.calls[1].model === 'flash', 'ретрай — flash');
    },
  },
];

// ---------------- runner ----------------

(async () => {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log('ok - ' + t.name);
    } catch (e) {
      console.log('not ok - ' + t.name + ' :: ' + e.message);
    }
  }

  const summary = (passed === tests.length ? 'PASS ' : 'FAIL ') + passed + '/' + tests.length;
  console.log(summary);
  process.exit(passed === tests.length ? 0 : 1);
})();
