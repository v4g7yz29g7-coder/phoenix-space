# Все TODO в собственном коде проекта (файл:строка)

Скан: полный рекурсивный grep по `*.js/ts/jsx/tsx/py/sh/go/rb/java/c/cpp/h`.
Исключено: `node_modules/`, `.venv/`, `terminal-bench/`, `skills_hub/`, `.git/`, `*.bak`.
Итого реальных маркеров: **60** = 56 JS-заглушек + 3 Python-ядра + 1 TS FIXME.

## JS-заглушки (56): `/* TODO */` без реализации

| Файл | Кол-во | Строки |
|------|--------|--------|
| `agent_11.js` | 6 | 73, 84, 97, 108, 117, 129 |
| `agent_12.js` | 5 | 36, 45, 56, 66, 76 |
| `agent_13.js` | 9 | 89, 121, 136, 145, 154, 165, 218, 358, 402 |
| `agent_15.js` | 2 | 340, 351 |
| `agent_9.js` | 3 | 98, 108, 118 |
| `boxes/agent_11/agent_11.js` | 6 | 73, 84, 97, 108, 117, 129 |
| `boxes/agent_12/agent_12.js` | 5 | 36, 45, 56, 66, 76 |
| `boxes/agent_13/agent_13.js` | 15 | 89, 103, 113, 128, 137, 146, 157, 170, 178, 187, 201, 210, 219, 227, 243 |
| `boxes/agent_15/agent_15.js` | 2 | 340, 351 |
| `boxes/agent_9/agent_9.js` | 3 | 98, 108, 118 |

> Прим.: `agent_*.js` в корне — копии/рабочие версии того же кода, что и в `boxes/agent_*/`.
> `boxes/agent_13` опережает корневой `agent_13.js` (15 против 9 заглушек).

## Python-ядро `everos/src` (3): реальные заметки об архитектуре

- `everos/src/everos/infra/ome/_dispatch/_state.py:10`
  `TODO: sys._getframe walk for a Runner.run frame is leak-proof.`
- `everos/src/everos/memory/extract/pipeline/user_memory.py:133`
  `# TODO: catch a typed ExtractionError once everalgo introduces one.`
- `everos/src/everos/memory/strategies/extract_user_profile.py:256`
  `# TODO(profile-counter): reads LanceDB and therefore races the cascade daemon.`

## TypeScript (1): реальный FIXME

- `research/racing-game/src/ui/Editor.ts:179`
  `// @ts-expect-error -- FIXME: types when using folders seem to be broken`

## Ложные срабатывания (НЕ включены в итог)

- `day_races.sh:13` — строка задачи «Найди все TODO в коде через search_code.»
- `night_master.sh:17` — строка задачи «Найди все TODO в коде через search_code.»
- `tournament.js:20` — строка задачи «Найди все TODO в коде. Верни список...»

## Не включено (сторонний код)

- `everos/.venv/**` — 2446 совпадений (pandas, numpy, pyarrow, pydantic…)
- `terminal-bench/**` — 72
- `skills_hub/**` — 38
