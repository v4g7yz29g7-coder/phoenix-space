# Отчёт: все вызовы `exec(` в проекте

Задача: «Найди в проекте все вызовы `exec(` через `search_code`».
Метод: `search_code(query="exec(")` (первичный поиск, выдача инструмента усечена на **50**
совпадениях) + полная верификация `grep` по текущему дереву `$HOME/phoenix`.

## Метод

1. `search_code(query="exec(")` — первичный поиск. Инструмент отдаёт максимум 50 строк,
   поэтому полный список добирается `grep`'ом.
2. Верификация: `grep -rn "exec("` по дереву + проверка `require('child_process')`.
3. Исключено из основного контура: `node_modules`, `.git`, `logs/`, `memory/`, `*.bak_*`,
   `web/public/*` (бандлы), `everos/.venv/` (vendored), крупные `*.tmp/*.txt` дампы.

## Итоговые счётчики (проверено grep, ревизия 2026-09-13)

| Область | Кол-во |
|---------|--------|
| **A. Реальные shell-вызовы `child_process.exec()` — основной контур** | **22** |
| B. `RegExp.prototype.exec()` — не shell | 8 |
| C. `db.exec()` (SQLite DDL/DML) — не shell | 12 |
| D. Строки промптов / HTML `onclick` / тексты задач — не вызовы Node | 13 |
| E. Определение функции `exec` (не вызов) | 1 |
| G. Python `exec()` / методы `.exec()` / regex-паттерн — вне Node-контура | 4 |
| F. Изолированные копии / benchmarks / vendored (не runtime проекта) | много |

---

## A. Реальные вызовы `child_process.exec()` — 22

В каждом файле есть `const { exec } = require('child_process')`.

| # | Файл | Строка | Вызов |
|---|------|--------|-------|
| 1 | `aeon_agents_server.js` | 87 | `exec(text, …)` — endpoint `/vps-control/process-text` (разрешённая команда) |
| 2 | `aeon_agents_server.js` | 101 | `exec(llmAnswer, …)` — та же ручка, команда от LLM |
| 3 | `aeon_agents_server.js` | 128 | `exec(command, …)` — endpoint `/vps-control/exec` |
| 4 | `aeon_agents_server.js` | 706 | `exec(cmd, …)` — фолбэк на bash-агента |
| 5 | `aeon_agents_server.js` | 1251 | `` exec(`bash ~/phoenix/generate_project.sh "${type}" "${tz}"`) `` |
| 6 | `aeon_agents_server.js` | 1279 | `` exec(`pm2 start ${projectPath} --name ${name}`) `` |
| 7 | `aeon_agents_server.js` | 1289 | `` exec(`pm2 delete ${name}`) `` |
| 8 | `aeon_agents_server.js` | 1321 | `exec('cd ~/phoenix && git status --short', …)` |
| 9 | `aeon_agents_server.js` | 1325 | `exec('cd ~/phoenix && git add -A && git commit … && git push origin main', …)` |
| 10 | `agent_tools.js` | 95 | `exec(cmd, { cwd: WORKSPACE, timeout: 30000, maxBuffer: 1MB }, …)` |
| 11 | `agent_tools.js` | 105 | `` exec(`cd ${WORKSPACE} && git add -A && git commit -m "…"`) `` |
| 12 | `gardener.js` | 12 | `exec(cmd, { cwd: os.homedir() }, …)` |
| 13 | `gardener_agents.js` | 5 | `exec('echo "Авто-создано агентом Coder" > ~/phoenix/logs/coder_output.txt', …)` |
| 14 | `gardener_agents.js` | 14 | `exec('grep -R "IO.inspect" ~/phoenix …')` |
| 15 | `gardener_agents.js` | 24 | `` exec(`mkdir -p ~/phoenix/logs && echo "${text}" >> ${log}`) `` |
| 16 | `vps_bot.js` | 32 | `exec('pm2 status', …)` |
| 17 | `vps_bot.js` | 39 | `exec('pm2 logs aeon_agents --lines 20 --nostream', …)` |
| 18 | `vps_bot.js` | 46 | `exec('df -h', …)` |
| 19 | `vps_bot.js` | 53 | `exec('free -h', …)` |
| 20 | `vps_bot.js` | 60 | `exec('uptime', …)` |
| 21 | `sentinel.js` | 16 | `exec('pm2 jlist', …)` |
| 22 | `sentinel.js` | 34 | `exec('pm2 restart ' + p.name, …)` |

По файлам: `aeon_agents_server.js` — 9, `vps_bot.js` — 5, `gardener_agents.js` — 3,
`agent_tools.js` — 2, `sentinel.js` — 2, `gardener.js` — 1. **Итого 22.**

> Прочие файлы с `require('child_process')` (`agent_17/18/19/28/29*.js`, `clone_manager.js`,
> `tournament*.js`, `race*.js`, `stadium.js`, `patrol_loop.js`, `agent_box.js`,
> `everos_client.js` и др.) не содержат вызова `exec(` — используют иные API
> (`spawn`/`execFile`) или подключают модуль косвенно.

## B. `RegExp.prototype.exec()` — не shell (8)

| Файл | Строки |
|------|--------|
| `agent_14.js` | 132, 135 (`re2.exec`), 211, 215 (`quoteRe.exec`) |
| `agent_tools.js` | 221 (`regex.exec(html)`) |
| `skills_hub/bin/install.js` | 32 (`regex.exec(content)`) |
| `skills_hub/skills/writing-skills/render-graphs.js` | 25 (`regex.exec(markdown)`) |
| `skills_hub/skills/algorithmic-art/templates/generator_template.js` | 133 (hex-regex) |

## C. `db.exec()` (SQLite DDL/DML) — не shell (12)

| Файл | Строки |
|------|--------|
| `addLanguages.js` | 4, 7 |
| `addSeeds.js` | 2 |
| `migrate.js` | 4 |
| `.verify_jwt.tmp.js` | 40 |
| `src/config/db.js` | 5 |
| `src/middleware/audit.js` | 2 |
| `src/models/User.js` | 4 |
| `src/models/Reputation.js` | 3 |
| `src/models/Artifact.js` | 4 |
| `src/models/Message.js` | 3 |
| `skills_hub/skills/loki-mode/examples/todo-app-generated/backend/src/db/migrations.ts` | 13 |

Итого строк: 12 (в `addLanguages.js` два вызова в строках 4 и 7).

## D. Строки / HTML / промпты — не вызовы Node (13)

| Файл | Строка | Что это |
|------|--------|---------|
| `aeon_agents_server.js` | 368–372 | HTML `<button onclick="exec('pm2 status')">` и др. — 5 кнопок, **браузерный** JS |
| `aeon_agents_server.js` | 1378 | системный промпт: `Tools: read(...), exec(cmd), commit(...)` |
| `agent_critic.js` | 32 | промпт: `You have tools: exec(cmd) for verification` |
| `arena_worker.js` | 74, 102 | промпт: `ПРОВЕРЬ: exec("cd arena_lab && npx tsc --noEmit")` |
| `worker_pool.js` | 112 | промпт: `Пиши через write, проверяй через exec("cd arena_lab && npx tsc --noEmit")` |
| `patch_strategy.py` | 32 | промпт: `Всегда проверяй: exec("cd arena_lab && npx tsc --noEmit")` |
| `night_master.sh` | 14 | текст задачи: `«Найди в проекте все вызовы exec( через search_code»` |
| `day_races.sh` | 10 | текст задачи: `«Найди в проекте все вызовы 'exec(' через search_code»` |

Итого вхождений: 13 (кнопки 368–372 считаны поштучно).
Близкое совпадение (не `exec(`, а `exec (` с пробелом): `race_engineer.js:36` —
`'Prefer exec (grep/find) over multiple reads.'` (в промпте).

## E. Определение функции (не вызов) — 1

`aeon_agents_server.js:427` — `async function exec(cmd){ … fetch('/vps-control/exec') … }`.
Это **браузерная** функция внутри HTML-шаблона (отдаётся как `<script>`), она лишь делает
fetch к серверному эндпоинту. Строки 368–372 вызывают именно её, а НЕ `child_process.exec()`.

## G. Python `exec()` / методы `.exec()` / regex-паттерн — вне Node-контура (4)

| Файл | Строка | Что это |
|------|--------|---------|
| `everos/tests/unit/test_benchmark_add_failure_gate.py` | 64 | Python builtin `exec(_source_of(...), ns)` в тесте |
| `terminal-bench/adapters/USACO/template/tests/judges/usaco_utils.py` | 141 | Python builtin `exec(check_program, exec_globals)` |
| `terminal-bench/original-tasks/protein-assembly/solution.sh` | 30 | `q.exec()` — метод очереди в оригинальной задаче benchmark'а |
| `skills_hub/skills/vulnerability-scanner/scripts/security_scan.py` | 64 | regex-паттерн `r'exec\s*\('` — детектор, не вызов |

## F. Generated-копии, benchmark-артефакты и vendored-код

- `boxes/agent_*/` и `arena/sandboxes/sandbox_{1,2}/` — изолированные копии агентов
  (`agent_tools.js`, `agent_critic.js`, `agent_14.js`), не самостоятельный код проекта:
  каждый `agent_tools.js` даёт те же 3 совпадения (2 shell + 1 regex), `agent_critic.js` — 1 промпт.
- `skills_hub/skills/loki-mode/benchmarks/results/**` и `.../*.patch` — дампы результатов
  SWE-bench (Python `exec(options['command'])` из Django) — не наш runtime.
- `skills_hub/skills/*/SKILL.md` — примеры/доки скиллов с упоминанием `exec(`.
- `web/public/arena3d/assets/` — минифицированные three.js/socket.io/r3f бандлы.
- `everos/.venv/` — vendored Python-зависимости (PEP 397).

---

## Выводы

1. Реальный контур запуска shell-команд — `child_process.exec()`: **22 вызова в 6 файлах**
   основного дерева (подтверждено `search_code` + grep + проверкой `require('child_process')`).
2. Максимальная концентрация — `aeon_agents_server.js` (9), в т.ч. HTTP-эндпоинты
   `/vps-control/*`, принимающие команду от LLM — зона повышенного риска (RCE).
3. `regex.exec(` (8) и `db.exec(` (12) — не shell-исполнение.
4. Строки промптов, HTML `onclick` и тексты задач (13) вызовами Node.js не являются;
   `aeon_agents_server.js:427` — определение браузерной функции; Python `exec()` (4) — вне контура Node.
5. Подстрока `exec(` встречается в JS/TS/SH/PY сотни раз, но реальных shell-вызовов
   в основном дереве — **22**.

**Итого реальных shell-вызовов: 22.**
