# SPRINT 2: CIRCULAR RACING + LAP COUNTER

## ЦЕЛЬ
Гонка по кругу. 1 задача = 1 круг. Обгон на круг = cinematic.

## ЗАДАЧА 1: F1Car движение по кривой
Файл: web/arena3d/src/scene/F1Car.tsx
- import { getTrackProgress } from "./Track"
- Убрать targetX = -20 + progress * 40
- Заменить на: const pos = getTrackProgress(progress % 1)
- group.position.set(pos.x, pos.y + 0.25, pos.z)
- Направление: rotation.y смотрит по кривой
  const ahead = getTrackProgress((progress + 0.01) % 1)
  group.rotation.y = Math.atan2(ahead.x - pos.x, ahead.z - pos.z)

## ЗАДАЧА 2: LAP Counter в UI
Файл: web/arena3d/src/App.tsx
- В leaderboard новый столбец "LAP"
- Формат: "2/3" (текущий/всего)
- Если отставание >= 1 круг → красный бейдж "+1"

## ЗАДАЧА 3: race.js считает круги
Файл: race.js
- После каждой задачи: agent.lap += 1
- Emit race:tick с полями lap и progress
- Обгон: если a.lap - b.lap >= 1 → emit race:overtake

## ЗАДАЧА 4: Overtake UI
Файл: web/arena3d/src/App.tsx
- Подписка на race:overtake
- Баннер "🔵 LAPPED! agent_X обошёл agent_Y" на 3 сек

## КРИТЕРИИ
1. npx tsc --noEmit → 0 ошибок
2. Болиды едут по овалу (не по прямой)
3. Носы смотрят по траектории
4. LAP счётчик работает
5. Overtake баннер появляется

## ОГРАНИЧЕНИЯ
Трогать: F1Car.tsx, App.tsx, race.js
НЕ трогать: Track.tsx, Tribunes.tsx, Arena.tsx, useTVDirector.ts
