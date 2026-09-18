# 🔮 Все упоминания `Prophet` в проекте Phoenix

Отчёт сгенерирован read-only сканированием (`grep -rIni "Prophet"`).
Исключены: `.git`, `node_modules`, `.venv`, `everos/.venv`, `.aider.tags.cache.v4`,
каталоги `logs/` и `memory/` (там только шум задач гонок), а также `*.bak*`.
Поиск регистронезависимый — поэтому ловит и `Prophet`, и `agent_prophet`, и `last_prophet`.

---

## 🎯 Ядро — агент Prophet (исполняемый код)

### `agent_prophet.js` — сам агент
| Строка | Содержимое |
|--------|-----------|
| 1 | `// Prophet: анализирует паттерны из memory/patterns/, предлагает улучшения.` |
| 7 | `const PROPHET_INSTRUCTIONS = \`You are Prophet, an analyst. You read past patterns ...\`` |
| 76 | `instructions: PROPHET_INSTRUCTIONS,` |

### `agent_architect.js` — потребитель инсайтов Prophet
| Строка | Содержимое |
|--------|-----------|
| 6 | `const ARCHITECT_INSTRUCTIONS = \`You are Architect. You receive insights from Prophet ...\`` |

### `aeon_agents_server.js` — эволюционный цикл Prophet → Architect → apply
| Строка | Содержимое |
|--------|-----------|
| 1509 | `//  EVOLUTION LOOP: Prophet → Architect → apply (dry-run by default)` |
| 1515 | `const prophet = require('./agent_prophet');` |
| 1518 | `const analysis = await prophet.analyze(goal);` |
| 1527 | `res.json({ ok: true, prophet: analysis.analysis, architect_plan: plan, applied });` |

### Где ещё код ссылается на файл `agent_prophet.js`
| Файл | Строка | Содержимое |
|------|--------|-----------|
| `race.js` | 209 | `// Также пишем в memory/patterns/ — чтобы Prophet видел гонки` |
| `clone_manager.js` | 43 | `'agent_prophet.js',` (список клонируемых агентов) |
| `stadium.js` | 15 | `'agent_loop_v3.js', 'agent_pilot.js', 'agent_prophet.js',` |

---

## ⚙️ Скрипты оркестрации (shell)

| Файл | Строки | Содержимое |
|------|--------|-----------|
| `race_12apostles.sh` | 31 | `# Prophet анализ` |
| `nightly_train.sh` | 28, 30 | `# Prophet анализ`, `echo "🧠 Prophet analysis..."` |
| `night_tasks.sh` | 11, 14, 17, 38, 40, 45, 114, 116 | Задача «Фикс Prophet», запись/чтение `agent_prophet.js`, `node --check agent_prophet.js`, финальный Prophet-анализ |
| `race_5agents.sh` | 28 | `# Prophet` |
| `day_races.sh` | 35 | `# Prophet анализ` |
| `race_100.sh` | 29 | `# Prophet анализ` |
| `arena_daemon.sh` | 11, 56, 59 | `"last_prophet": 0` в state, `# Prophet каждые 20 гонок`, `🧠 Prophet анализ (каждые 20 гонок)` |
| `quick_races.sh` | 9 | задача: `"Найди все упоминания 'Prophet' в проекте..."` |

---

## 📚 Документация и описания

| Файл | Строки |
|------|--------|
| `EVOLUTION.md` | 12, 29, 41 |
| `ROADMAP.md` | 52 |
| `ROADMAP_12APOSTLES.md` | 33, 49 |
| `AEON_ARENA_WHITEPAPER.md` | 12, 26, 62, 69, 85, 146, 162 |

### Навыки (skills_hub) — здесь `Prophet` это БИБЛИОТЕКА прогнозирования, не агент
| Файл | Строки |
|------|--------|
| `skills_hub/skills/data-scientist/SKILL.md` | 39 (`ARIMA, Prophet, seasonal decomposition`) |
| `skills_hub/skills/ml-engineer/SKILL.md` | 112 |
| `skills_hub/skills/denario/references/examples.md` | 181, 297, 356 |
| `skills_hub/skills/exploratory-data-analysis/references/proteomics_metabolomics_formats.md` | 66, 79 (`PeptideProphet` / `ProteinProphet`) |

---

## 🗂️ Данные и копии в песочницах арены

- `tasks_pool.json:23` — сама задача `"Найди все упоминания Prophet в коде."`
- `arena/sandboxes/sandbox_1/`: `agent_prophet.js:1,7`, `agent_architect.js:6`, `race.js:84`, `tasks_pool.json:23`, + `memory/*`
- `arena/sandboxes/sandbox_2/`: `agent_prophet.js:1,7`, `agent_architect.js:6`, `race.js:84`, `tasks_pool.json:23`, + `memory/*`
- `snapshots/*.md` — исторические снапшоты с этой же задачей.

### Прочий шум (не код продукта)
- `memory/patterns/*.json` — ~30 файлов с `"task": "Найди все упоминания Prophet в коде."`
- `memory/races/*.json` — ~33 файла с той же задачей
- `logs/nightly_train.log` — ~89 строк (`🧠 Prophet analysis...` + условие задачи)
- `*.bak*` — резервные копии `race.js`, `clone_manager.js`, отчёты и т.п.

---

## 📄 Сгенерированные отчёты (тоже содержат `Prophet` как путь `agent_prophet`)

| Файл | Строки |
|------|--------|
| `REQUIRE_CALLS_REPORT.md` | 286, 1742, 1816, 1817, 1851, 1852, 2195, 2196 (упоминания `./agent_prophet`) |
| `REQUIRE_CALLS_REPORT.txt` | те же данные в текстовом виде |

---

## ✅ Итог

- **Ядро агента:** `agent_prophet.js` — определение и инструкции агента (строки 1, 7, 76).
- **Потребители/цикл:** `agent_architect.js` (1), `aeon_agents_server.js` (4), плюс ссылки на файл-модуль в `race.js`, `clone_manager.js`, `stadium.js`.
- **Скрипты оркестрации:** 8 shell-скриптов (`race_12apostles.sh`, `race_5agents.sh`, `race_100.sh`, `nightly_train.sh`, `night_tasks.sh`, `day_races.sh`, `arena_daemon.sh`, `quick_races.sh`).
- **Документация:** 4 корневых `.md` (`EVOLUTION.md`, `ROADMAP.md`, `ROADMAP_12APOSTLES.md`, `AEON_ARENA_WHITEPAPER.md`) + 4 файла в `skills_hub` (часть — про библиотеку прогнозирования Prophet, а не агента).
- **Данные/отчёты:** `tasks_pool.json`, `REQUIRE_CALLS_REPORT.md/.txt` + дубликаты в `arena/sandboxes/sandbox_1..2` + снапшоты.
- **Шум:** `memory/**` и `logs/**` — только тексты задач гонок.

> **Итог по коду** (js/sh/json/md, регистронезависимо; без `logs/`, `memory/`,
> `.bak*`, `snapshots/`, `arena/sandboxes/`, `.venv`) —
> **58 строк** в **24 уникальных файлах**.
> С учётом песочниц `arena/sandboxes/*`, снапшотов и памяти — совпадений заметно больше.
