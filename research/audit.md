# AI-1 — Research Audit: 4 racing repos

> Изучены локальные копии в `research/*`. Все выводы — по конкретным файлам.
> Легенда усилий на интеграцию: **1ч** (мелкая адаптация), **4ч** (портирование модуля), **1д** (переписать/подключить подсистему).

---

## 0. Итоговая матрица

| Репо | Стек | Физика | Трассы | Камеры | Лицензия | Вердикт |
|---|---|---|---|---|---|---|
| `racing-game` (pmndrs) | R3F + `@react-three/cannon` | RaycastVehicle (cannon-es), 4 колеса | Статичный GLTF-mesh + Heightfield + Ramp | 3 режима (DEFAULT/FIRST_PERSON/BIRD_EYE) | **MIT** (код), ассеты смешанные CC0/**CC-BY-4.0** | **БРАТЬ** (база) |
| `nebula-rush` | React 19 + Three 0.181 + TS | **Кастомная** (`PhysicsEngine.ts`), без lib | **Процедурные CatmullRom spline** | 1 умная камера (bank/FOV/buffet) | **НЕТ ЛИЦЕНЗИИ** (`private:true`) | **ТОЛЬКО РЕФЕРЕНС** |
| `drift-and-drive` | R3F + React 19 | **НЕТ физики** (кинематика; README врёт про Rapier) | Бесконечная процедурная дорога (не круг) | Follow-камера | **НЕТ ЛИЦЕНЗИИ** | **НЕ БРАТЬ** |
| `kenney-racing` | Godot 4.6 | RigidBody3D sphere + RayCast3D (аркада) | GridMap из GLB-плиток | Node3D follow + speed-zoom | **MIT** (код) + **CC0** (ассеты) | **БРАТЬ ассеты/приёмы** |

---

## 1. `research/racing-game` — pmndrs/racing-game

**Лицензия:** `LICENSE.md` → **MIT** (code, ©2021 pmdrs/contributors).
⚠️ Ассеты смешанные: `src/models/vehicle/Chassis.tsx` (Classic Muscle car, Alexus16) и `src/models/track/Track.tsx` (Desert Race Map, Batuhan13), `Train.tsx` (NIKCORE) помечены **CC-BY-4.0** — при использовании модели обязательна атрибуция. Остальное заявлено CC0 в README.

**Архитектура:** `src/App.tsx`, `src/store.ts` (Zustand + отдельный мутируемый `mutation` объект для per-frame без re-render), папки `models/`, `effects/`, `ui/`, `controls/`.

**Физика:** `@react-three/cannon` (cannon-es). `useRaycastVehicle` в `src/models/vehicle/Vehicle.tsx`; конфиг в `store.ts` (`vehicleConfig`: force 1800 / maxBrake 65 / maxSpeed 88 / steer 0.3, `wheelInfo`: suspensionStiffness 30, frictionSlip 1.5, radius 0.38). Кузов — `useBox` (`Chassis.tsx`, mass 500, args [2,1.1,4.7]), 4 колеса — отдельные тела (`Wheel.tsx`). Сила/руль/тормоз применяются через API в `useFrame`; `api.sliding` подписан на `mutation.sliding` для VFX.

**Камеры:** `src/effects/Cameras.tsx` — `PerspectiveCamera` + `OrthographicCamera`, 3 режима `DEFAULT / FIRST_PERSON / BIRD_EYE` (`store.ts`, переключение клавишей `c`, `actions.camera`). Движение и «тряска» — в `Vehicle.tsx`: `position.lerp`, sway по скорости, `rotation.z += sin(t*swaySpeed)*swayValue` (vibration при boost).

**Трассы:** не spline — статичный `public/models/track-draco.glb` (`Track.tsx`) + отдельный `Heightmap.tsx` (`useHeightfield` из PNG `/textures/heightmap_1024.png`) + `Ramp.tsx` (static box) + `Train.tsx`. Есть `Editor`/layer-система.

**VFX:** все на `instancedMesh`:
- `effects/Dust.tsx` — 200 сфер-«пыли» из задних колёс, scale по `intensity = sliding*speed`.
- `effects/Skid.tsx` — 500 чёрных плоскостей-следов при торможении (`speed>10`).
- `effects/Boost.tsx` — 12 боксов-искр за выхлопом при `boost`.

**UI/Audio:** `ui/Intro.tsx` (загрузка + «Click to start» + Supabase auth), `ui/LeaderBoard.tsx` (`readableTime`, `getScores`/`insertScore`), `ui/Finished.tsx`, `ui/Checkpoint.tsx` (split-время зелёный/красный), `ui/Speed/` (Gauge/Text/Boost), `ui/Minimap.tsx`, `ui/Clock.tsx`, `ui/Keys.tsx`, `ui/PickColor.tsx`. Звук — `effects/audio/*` через `<PositionalAudio>` (Engine/Brake/Honk/Accelerate/Boost).

**ТОП-3 приёма:**
1. Готовый 4-колёсный RaycastVehicle + пресеты руля/подвески — `Vehicle.tsx` + `Chassis.tsx` + `Wheel.tsx` + `store.ts` (`vehicleConfig`, `wheelInfo`).
2. Speed-scaled camera (lerp + sway + vibration) и переключение 3 режимов — `Cameras.tsx` + блок в `Vehicle.tsx`.
3. Инстансные дешёвые VFX (trail-пул одним буфером) — `Dust.tsx`, `Skid.tsx`, `Boost.tsx`.

**Что взять в AI-1:** `src/models/vehicle/*`, `src/store.ts`, `src/effects/Cameras.tsx`, `src/effects/{Dust,Skid,Boost}.tsx`, `src/ui/{Intro,Clock,Minimap,LeaderBoard,Checkpoint}.tsx`, `src/controls/*`. Усилие: **4ч** на порт машины, **4ч** на VFX, **1д** на UI-набор.

---

## 2. `research/nebula-rush` — EdwardAThomson/Nebula-Rush

**Лицензия:** ⛔ файла LICENSE нет, `package.json` → `"private": true`. Юридически **нельзя** копировать код/ассеты без разрешения автора. Рассматривать **как источник идей**, реализации писать свои.

**Архитектура:** ~8 тыс. строк игровой логики. `src/game/` — движок (`PhysicsEngine.ts` 458, `TrackFactory.ts` 678, `ShipFactory.ts` 1128, `EnvironmentManager.ts` 812, `TrackDefinitions.ts` 884, `CanyonTerrain.ts` 964, `OpponentManager.ts`, `WindSystem.ts`, `AudioManager.ts` 395). `src/components/` — экраны (Game.tsx 1348, CupSelection, PilotSelection, Leaderboard, TutorialOverlay…). React 19 + Three 0.181 + TS + Tailwind, Vite 7.

**Физика:** **кастомная, без библиотеки**. `PhysicsEngine.ts` — состояние в 2D (`velocity.x` поперёк / `velocity.y` вперёд, `yaw`, `hoverHeight`, `throttle` с ramp/decay, `boostTimer`, `energy`). Чистая функция `updatePhysics(state, input, trackLength, pads, dt, …)`: страйф `strafeSpeed`, yaw-дрифт, `wallContact` (отлипание от стен), клиренс по `lateralLimit(t)`. Дешёво и детерминировано, «on-rails» по кривой.

**Камеры:** `Game.tsx` (~строки 926–975). Одна камера: позиция от касательной трека, `CAMERA_YAW_FOLLOW = 0.5` (нос поворачивается не полностью — мир стабилен), `cameraDist = 12 + 3.5*boostCamLevel`, высота 5, **FOV расширяется на boost**, `camera.up = normal` (наклон на banked-поворотах), «gust buffet»-shake, жёсткий лок на высокой скорости против ghosting.

**Трассы:** **процедурные spline**. `TrackFactory.ts`: `createTrackCurve(points)` → `THREE.CatmullRomCurve3(points, true, 'centripetal')`; `getTrackFrame(curve, t, bank)` даёт `position/normal/binormal` + наклон в поворот; `createTrackMesh` генерит дорожное полотно, борта, центральную линию, checker-финиш; boost-пады/`hazard`/recharge-полоса/светофор строятся вдоль той же кривой. Окружение — `WorldReference` (космо-сетка) или `CanyonTerrain` (процедурные скалы, `widthProfile`, туннели). `WindSystem` — латеральный ветер-порывы.

**VFX:** `Ship.ts` — пламя (outer flame + core) с `AdditiveBlending`, цвет cyan→orange по `boostLevel`, boost-аура (сфера-shell), молнии (`THREE.Line`), flicker по `performance.now()`. `EnvironmentManager` — дождь/снег/туман, звёздное поле, небула, sandstorm-haze.

**UI:** `components/Leaderboard.tsx` (rank/points/campaign), `CupSelection`, `PilotSelection`, `TutorialOverlay` (пошаговый онбординг с dwell/read-gate), `Minimap`, светофор-старт, «race photos» с галереей/zip.

**AI:** `OpponentManager.ts` — `AIInputController` (P-регулятор по `lateralPosition - targetLateral`, deadzone 1.0), 19 соперников, раздача полос.

**ТОП-3 приёма:**
1. Процедурный spline-пайплайн трасс — `TrackFactory.ts` (`createTrackCurve` / `getTrackFrame` / `createTrackMesh`).
2. Аркадная экономика энергия/boost/hazard без движка — `PhysicsEngine.ts` (`energy`, `boostTimer`, `HAZARD_BLOCK_DEPTH`, `RECHARGE_ZONE`, `ENERGY_*`).
3. «Ощущение скорости» камерой — банк по `normal`, FOV на boost, yaw-follow, buffet-shake (блок в `Game.tsx`).

**Что взять в AI-1:** **только концепции** (spline-трек, энерго-экономика, camera-feel) — переписать на своей базе. Усилие: **1д** на spline-генератор, **4ч** на energy-систему, **1ч** на camera-tuning (идеи).

---

## 3. `research/drift-and-drive` — Yashparmar1125/Car-Game-ThreeJS

**Лицензия:** ⛔ LICENSE отсутствует. Копировать нельзя.

**Критично:** README заявляет «Rapier Physics» и «realistic suspension/friction», но по факту:
- `grep rapier` по `src/` и `package.json` → **0 совпадений**;
- нет ни `useBox`, ни `useSphere`, ни `<Physics>` в `src/`;
- `src/components/Car.jsx` — **чистая кинематика**: `newSpeed = lerp(speed,target)`, `position.add(direction*moveSpeed)`, подвеска = `sin(clock*5)*0.05`, колёса крутятся по скорости. `@react-three/cannon` указан в `package.json`, но **не используется**.
Документация не соответствует коду.

**Архитектура:** крошечная — `src/components/{Car,Scene,UI,Checkpoint}.jsx`, `src/App.jsx`.

**Камеры:** `VehicleCamera` в `Scene.jsx` — offset за машиной, `offset.applyQuaternion(car.quaternion)`, `position.lerp(…, 0.1)`.

**Трассы:** `InfiniteRoad` (`Scene.jsx`) — сегменты 20×20 спавнятся/удаляются, случайный `curve`; это **не круг**, а бесконечная дорога.

**VFX:** нет (только emissive-борта). **UI:** `UI.jsx` через `@react-three/drei` `<Html>` (Speed/Score/LapTime).

**ТОП-3 приёма:**
1. Pooling бесконечной дороги сегментами (`InfiniteRoad` в `Scene.jsx`) — но для lap-рейсера не нужен.
2. `<Html>`-HUD из drei — проще, но у racing-game CSS-HUD богаче.
3. Ничего существенного.

**Что взять в AI-1:** **ничего.** Лицензии нет, физики нет, README вводит в заблуждение; как пример — уступает `racing-game`.

---

## 4. `research/kenney-racing` — KenneyNL/Starter-Kit-Racing

**Лицензия:** ✅ `LICENSE` → **MIT** (код, ©2026 Kenney). Ассеты (2D-спрайты, 3D-модели, звуки) → **CC0** (README). Самая чистая по правам связка.

**Архитектура (Godot 4.6):** `scenes/` (`main.tscn`, `vehicle.tscn`, `vehicle-motorcycle.tscn`), `scripts/` (`vehicle.gd`, `view.gd`), `models/` (GLB + `Library/mesh-library.tres` GridMap), `audio/` (`engine.ogg`, `skid.ogg`, `impact.ogg`), `sprites/smoke.png`, `models/Textures/colormap.png`.

**Физика:** аркадная, без VehicleBody: `RigidBody3D`-сфера (mass 1000, `gravity_scale 1.5`, `continuous_cd`) + `RayCast3D` «Ground». `scripts/vehicle.gd`: `steering_grip = clamp(|speed|,0.2,1)`, `lerp_angle` для наклона, выравнивание по нормали (`align_with_y`), `linear_speed` lerp, `effect_wheels/effect_trails/effect_engine`.

**Камеры:** `scripts/view.gd` — `position.lerp(target, delta*4)`, зум камеры по скорости: `target_z = remap(speed, 0..1, 10..20)`.

**Трассы:** `GridMap` из GLB-плиток (`track-straight/corner/finish/bump.glb`) + `collision-track-*.fbx` — модульный tile-конструктор.

**VFX:** `GPUParticles3D` `TrailLeft`/`TrailRight` (billboard-материал, `smoke.png`), emission по `drift_intensity`.

**Аудио-логика (ценный рецепт):** `engine_sound.pitch_scale = remap(speed, 0..1, 0.5, 3)`; screech-громкость от `drift_intensity`; `impact_sound.volume_db = remap(impact_velocity, 0..6, -20, 0)`.

**Ассеты:** 4 цвета грузовика, мотоцикл, куски трассы + декор (лес/палатки), 4 звука, текстуры.

**ТОП-3 приёма:**
1. **CC0-ассеты** — GLB-модели/плитки/звуки/smoke, конвертируемые в glTF для R3F.
2. **Аркадные паттерны `vehicle.gd`** — наклон `lerp_angle`, `steering_grip` от скорости, выравнивание по нормали, `drift_intensity → trail/screech`.
3. **Аудио-рецепты** — pitch/volume remap по скорости дрейфа (легко портируются на Web Audio / `<PositionalAudio>`).

**Что взять в AI-1:** ассеты (CC0) + паттерны `vehicle.gd`/`view.gd`, переписанные на TS/R3F. Усилие: **4ч** конвертация моделей, **1д** порт handling-логики, **4ч** аудио.

---

## 5. Рекомендация для AI-1

**База:** `racing-game` (MIT) — берём целиком его каркас: RaycastVehicle, store, camera, instanced-VFX, UI-набор; заменяем CC-BY модели на CC0 из `kenney-racing`.
**Улучшения:** из `nebula-rush` **переписываем** spline-генератор трасс, energy/boost/hazard-экономику и camera-feel (код не копируем — лицензии нет).
**Ассеты:** `kenney-racing` (CC0) + handling/audio-паттерны из его `vehicle.gd`.

### Порядок интеграции
| Шаг | Источник | Файлы | Усилие |
|---|---|---|---|
| 1. Каркас + машина | racing-game | `src/models/vehicle/*`, `src/store.ts` | 4ч |
| 2. Камеры | racing-game (+идеи nebula) | `src/effects/Cameras.tsx`, блок в `Vehicle.tsx` | 1ч |
| 3. VFX | racing-game | `Dust/Skid/Boost.tsx` | 4ч |
| 4. Spline-трассы | nebula-rush (переписать) | `TrackFactory.ts` | 1д |
| 5. Energy/boost/hazard | nebula-rush (переписать) | `PhysicsEngine.ts` | 4ч |
| 6. Ассеты CC0 | kenney-racing | `models/*.glb`, `audio/*.ogg`, `smoke.png` | 4ч |
| 7. Handling + аудио паттерны | kenney-racing | `scripts/vehicle.gd`, `view.gd` → TS | 1д |
| 8. UI | racing-game | `ui/*` | 1д |

### Что НЕ берём
- **`nebula-rush` код/ассеты напрямую** — нет LICENSE (`private:true`); только референс, реализации свои.
- **`drift-and-drive` целиком** — нет LICENSE, физики нет (README врёт про Rapier), уступает racing-game.
- **CC-BY-4.0 модели racing-game** (chassis/track/train) без атрибуции — либо атрибутировать, либо заменить на CC0 из kenney.
- **Godot-сцены kenney** (`*.tscn`, `GridMap`) — движок другой; берём только импортируемые GLB/OGG/PNG и логику.

### Риски
- `nebula-rush` и `drift-and-drive` — **юридически грязные** (без лицензии). Любой перенос кода/ассетов из них — риск. Держать строго как «идеи».
- `racing-game` тянет Supabase-авторизацию в `Intro/Finished/Auth` — при интеграции вырезать или заменить локальным лидербордом.
- `racing-game` использует `@react-three/cannon` (cannon-es) — апстрим заморожен с 2023; для нового проекта рассмотреть `@react-three/rapier`, но тогда Vehicle-модуль придётся адаптировать (+4ч).
