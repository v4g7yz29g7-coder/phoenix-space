# 🧠 MEMORY.md — Долгосрочная память Aeon

## Ключевые решения
- Используем DeepSeek API (deepseek-chat) для всех LLM-задач.
- Самоизменение через инструменты read/write/edit/apply_patch.
- Оркестрация — по образцу OpenClaw (Gateway + клиенты + ноды).
- Telegram-бот будет обходить блокировки через Cloudflare Worker.

## История
- 2026-09-09: Начали обсуждать самоизменяющегося агента.
- 2026-09-10: Составлен ARCHITECTURE.md, agent_manifest.json, KNOWLEDGE.md.
