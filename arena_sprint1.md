# FORMULA I1 — SPRINT 1: TRACKS + TRIBUNES + TV DIRECTOR

## ЦЕЛЬ
Превратить прямую арену в FORMULA I1-трассу с трибунами и авто-режиссурой кадров.

## ЗАДАЧА 1: TRACK (трасса)
Файл: arena_lab/src/scene/Track.tsx

- Читает arena_lab/src/data/tracks.json
- Строит трассу по path через CatmullRomCurve3
- Материалы (PBR):
  - Асфальт: #1a1a1a, metalness 0.3, roughness 0.7
  - Бордюры: красно-белая полоса сбоку
  - Разметка: жёлтая линия по центру
- Экспорт: getTrackProgress(t: 0..1) — позиция {x, y, z} на кривой

## ЗАДАЧА 2: TRIBUNES (трибуны)
Файл: arena_lab/src/scene/Tribunes.tsx

- 3 яруса вокруг трассы
- Каждый ярус: ступени + сиденья + крыша
- Зрители: InstancedMesh — 10000 спрайтов
  - 4 цвета (красный, синий, зелёный, жёлтый)
  - Анимация: лёгкое болтание через useFrame
- Реакция: при flag === 'green' — pulse

## ЗАДАЧА 3: TV DIRECTOR (6 камер)
Файл: arena_lab/src/hooks/useTVDirector.ts

6 камер:
- onboard: chase, target=leader, offset [0, 0.5, 0]
- chase: chase, target=leader, offset [4, 2, -4]
- wide: orbit, center=track, radius=60
- helicam: orbit, center=leader, radius=20, height=15
- trackside: static, position [40, 2, 15], lookAt=leader
- finishline: static, position [0, 3, 0], lookAt=finish

Логика:
- Авто-переключение каждые 8-15 сек
- При finish -> камера finishline + slow-mo (0.3x)
- При failure -> trackside

## ФАЙЛЫ
- arena_lab/src/scene/Track.tsx (новый)
- arena_lab/src/scene/Tribunes.tsx (новый)
- arena_lab/src/hooks/useTVDirector.ts (новый)
- arena_lab/src/App.tsx (правки)

## КРИТЕРИИ
1. npx tsc --noEmit -> 0 ошибок
2. Трасса рендерится (кривая, не прямая)
3. Трибуны с толпой видны
4. 6 камер переключаются
5. Slow-mo при финише

## ОГРАНИЧЕНИЯ
- Не трогать: AgentCube.tsx, store/arena.ts, hooks/useSocket.ts
