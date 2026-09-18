# TODO Audit — agent_7

Дата: отчёт по задаче «Найди все TODO в коде».
Область сканирования: рабочий код проекта (исключены `node_modules`, `.venv/site-packages`, `skills_hub`, `logs`, `backups`, `.bak_*`, `arena/sandboxes`, `generated_*`).

## 1. Реальные TODO в исходниках — JS-агенты (заглушки `/* TODO */`)

Все это пустые тела функций-заглушек (каркас агентов, код не реализован):

| Файл | Кол-во |
|------|-------:|
| `agent_9.js`  | 3 |
| `agent_11.js` | 6 |
| `agent_12.js` | 5 |
| `agent_13.js` | 9 |
| `agent_15.js` | 2 |
| `agent_18.js` | 14 |
| **Итого (root)** | **39** |

Зеркала в `boxes/` (сборки агентов):
`boxes/agent_9` = 3, `boxes/agent_11` = 6, `boxes/agent_12` = 5,
`boxes/agent_13` = 15, `boxes/agent_15` = 2.
⚠️ `boxes/agent_13` (15) расходится с корневым `agent_13.js` (9) — сборка/версия разъехались.

Примеры (agent_9.js):
- L98 `buildFalsificationPrompt()`, L108 `pickWinner()`, L118 `runAgent()` — пустые.

## 2. Реальные TODO в Python-исходниках everos (не venv)

- `everos/src/everos/memory/extract/pipeline/user_memory.py:133` — `TODO: catch a typed ...`
- `everos/src/everos/memory/strategies/extract_user_profile.py:256` — `TODO(profile-counter): race ...`
- `everos/src/everos/infra/ome/_dispatch/_state.py:10` — `TODO: sys._getframe walk ...`

## 3. Не код / не дефекты

- `tasks_pool.json`, `day_races.sh:13`, `night_master.sh:17` — текст самой задачи («Найди все TODO в коде»), не технический долг.
- `skills/skill_decompose_codegen.md:24` — пример в документации.
- `memory/**` (races, patterns, *_report.md, journal) — прошлые отчёты агентов/логи гонок, прогонявших эту задачу.
- `terminal-bench/original-tasks/make-doom-for-mips/task-deps/vm.js` — 8 TODO, сторонний бенчмарк-фикстур (не проект).
- `everos/tests/fixtures/*.json` — дампы траекторий, содержат чужой FIXME/XXX внутри текста.
- `XXX` в lock-файлах — часть base64-хэшей, ложные срабатывания.
- `HACK` по проекту не найдено.

## Вывод

Технический долг в коде проекта = **39 TODO-заглушек в 6 корневых агентах** (+ зеркала в `boxes/`) и **3 TODO в python-исходниках everos**. Требуют внимания: нереализованные функции агентов 9/11/12/13/15/18 и рассинхрон `agent_13.js` ↔ `boxes/agent_13`.
