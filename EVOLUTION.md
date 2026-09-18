# 🧬 EVOLUTION.md — Эволюционная мультиагентная среда Aeon

## Команда агентов

| Агент | Файл | Роль |
|-------|------|------|
| **Исполнитель v2** | agent_responses.js | Делает работу через Responses API |
| **Критик** | agent_critic.js | Проверяет, ставит оценку 1-10 |
| **Loop v3** | agent_loop_v3.js | Исполнитель + Критик, до 3 попыток |
| **Pilot** | agent_pilot.js | Оркестратор: цель → подзадачи |
| **Purpose** | agent_purpose.js | Оценка прогресса (phi 0-10) |
| **Prophet** | agent_prophet.js | Анализ паттернов, insights |
| **Architect** | agent_architect.js | Меняет правила среды (с dry-run) |

## Sleep Protocol

После каждой подзадачи Pilot записывает паттерн:
- `memory/patterns/success_*.json` — успех
- `memory/patterns/failure_*.json` — провал

Прогнозист читает эти паттерны и предлагает улучшения.

## API-роуты

- `POST /agent/think` — v1 (Chat Completions)
- `POST /agent/think-v2` — v2 (Responses API)
- `POST /agent/think-v3` — v3 (Исполнитель + Критик)
- `POST /agent/team` — Pilot: цель → подзадачи
- `POST /agent/evolve` — Prophet → Architect → apply (dry-run)

## Инструменты

read, write, edit, exec, commit, search_code, git_diff, send_telegram, web_search

## Философия (Медведев)

- Проектировать будущее, а не только реагировать
- Помнить успехи и провалы
- Измерять прогресс (Purpose Function)
- Рефлексировать (Sleep Protocol)
- Эволюционировать (Prophet + Architect)
