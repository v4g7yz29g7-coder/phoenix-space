# Инфраструктура AI-1 — снимок 2026-09-14

## PM2 (6 онлайн)
- aeon_agents (605461)
- aeon_commentator (1122442)
- aeon_dashboard (1595729) — порт 3020
- aeon_tunnel (1057075)
- ivashi_agent_bot (1159)
- sentinel (1166)

## Порты (LISTEN)
- 22 (ssh), 80 (http), 443 (https)
- 3001 (aeon_agents), 3020 (dashboard)
- 8099, 8199, 20241, 38805, 9050
- 4369 (epmd — Erlang?)

## Docker
- Нет контейнеров
- Плана Docker пока нет

## Git
- HEAD: 816903f docs: whitepaper v2.0
- За ночь: whitepaper v2, mycologist_network, dendrologist_rings

## Стратегическое решение
- 5 миров (arena, genetics, training, sandbox, void)
- Несколько машин (уточняется)

## Стратегическое решение — A + C

**A)** Сейчас: 1 VPS (compute-vm-2-2-20-ssd)
**C)** Архитектурно: поддерживать любое количество машин

### Что это значит для трека B

- **Сегодня:** все 5 миров на одной машине → изоляция через **порты**
- **Завтра:** вынести genetics/training на отдельный VPS → **сети + DNS + WireGuard**
- **Критерий:** новый мир поднимается ОДНОЙ командой и не трогает соседей
- **Контракт:** каждый мир = свой порт-диапазон + свой .env + своя БД

### Реестр портов (по мирам)

| Мир | Порты | Сервис |
|---|---|---|
| arena | 3020-3029 | dashboard, race control |
| genetics | 3030-3039 | breeding, generations |
| training | 3040-3049 | night_evolution |
| sandbox | 3050-3059 | experiments |
| void | — | archive (S3) |
