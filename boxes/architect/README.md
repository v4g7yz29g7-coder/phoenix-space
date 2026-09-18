# Architect Box

Автономный мозг проекта AI-1.

## Что это

Цифровой двойник Архитектора. Думает как брат, ставит задачи пилотам,
выбирает режим из 12 осей, публикует trajectory.

## Структура

- agent.js — главный модуль
- router_v7.js — 12 осей DAS
- modes/ — 5 режимов
- rag_indexer.js — RAG (Xenova, 384-dim)
- prompts/ — ДНК (v3, v4-tech, v4-style, v4-full)
- memory/ — логи решений

## Запуск

cd boxes/architect
node agent.js "как поставить задачу с критерием?"
