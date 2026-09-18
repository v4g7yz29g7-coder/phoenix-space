# AI-1: RESEARCH AUDIT

## ЦЕЛЬ
Изучить 4 open-source репозитория и выдать рекомендации — что взять в AI-1.

## РЕПОЗИТОРИИ
- `research/racing-game` — pmndrs/racing-game (React Three Fiber + Cannon)
- `research/nebula-rush` — Nebula-Rush (F-Zero style, React + Three.js)
- `research/drift-and-drive` — Car-Game-ThreeJS (React Three Fiber + Rapier)
- `research/kenney-racing` — KenneyNL/Starter-Kit-Racing (Godot, ассеты)

## ЧТО АНАЛИЗИРОВАТЬ
Для каждого репо:
1. **Архитектура** — структура папок, ключевые модули
2. **Физика** — как реализована, библиотека (Cannon / Rapier / другое)
3. **Камеры** — какие есть, как переключаются, cinematic?
4. **Трассы** — spline? mesh? процедурные?
5. **VFX** — dust, trails, skids, shaders
6. **UI** — leaderboards, intros, HUD
7. **Лицензия** — можно ли брать? (MIT / GPL / CC0?)
8. **Что брать** — конкретные файлы / компоненты

## ВЫХОД
`research/audit.md` — свод с рекомендациями:
- ТОП-3 приёма из каждого репо
- Что берём в AI-1
- Что не берём и почему

## КРИТЕРИИ
- Конкретные файлы, не общие слова
- Указание лицензий
- Оценка усилий на интеграцию (1ч / 4ч / 1д)
