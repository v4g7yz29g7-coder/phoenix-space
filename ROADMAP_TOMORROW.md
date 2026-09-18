# ПЛАН НА 2026-09-14

## Утро — проверка ночи

Команды (запускать по одной):

- python3 -c "import json; from collections import Counter; d=json.load(open('arena_roadmap.json')); c=Counter(); [c.update([t['status']]) for st in d['stages'] for t in st['tasks']]; print('Roadmap:', dict(c))"
- ls -1 memory/races/race_*.json | wc -l
- ls -1 memory/trajectories/ 2>/dev/null | wc -l
- tail -50 /tmp/arena_worker.log

## Приоритеты дня

1. КРИТИЧНО: nightly_train выключить (конфликт с arena_worker)
2. КРИТИЧНО: race_control.notes → связать с arena_worker
3. СРЕДНЕ: trajectory v2 — реальные steps из tick_history
4. СРЕДНЕ: academy threshold — порог выбывания слабых
5. НИЗКО: radio chatter — по событиям, не по кругам
6. НИЗКО: P2P_trajectory вместо p2p_share
7. ФИНАЛ: коммит всего наработанного

## Что работает автономно

- arena_worker --loop — крутит roadmap, PID 1441329
- clone_manager.js — MVP эволюции
- trajectory_builder.js — путь > skills
- race.js: RACE_NO_P2P + RACE_TRAJECTORY
- EverOS: fingerprints + trajectories

---

## НАЙДЕНО НОЧЬЮ 2026-09-13 (23:15)

### Задачи РЕШАЮТСЯ — файлы есть
За последний час созданы:
- PartsCatalog.tsx (32KB) — задача 7.3, статус failed ❌
- TuningCraft.tsx — 7.4 in_progress
- FlagSync.tsx — 4.4 in_progress
- DbSchema.tsx — 6.2 failed ❌
- MarketSchema/Server.tsx — 7.1/7.2 in_progress
- + 6 других файлов

### Корень проблемы
1. nightly_train СНОВА ЖИВ — гоняет read-only параллельно с arena_worker
2. race_director — один глобальный state, две гонки дерутся
3. arena_worker читает ЧУЖОЙ протокол → winner=null → failed
4. Логика arena_worker:163 слишком грубая (winner ? completed : failed)

### Утренние фиксы (ПЕРВЫМ ДЕЛОМ)
1. pkill -9 nightly_train; проверить crontab
2. arena_worker.js:163 — файл существует = completed
3. Пересчитать roadmap по факту файлов

---

## ДВЕ ГРУППЫ — архитектура на утро

### Проблема
race_director — один глобальный state. Два процесса дерутся.

### Решение (2 варианта)

**A) Файл-лок в race_director (10 мин)**
- /tmp/phoenix_race.lock — эксклюзивное создание
- Кто не получил — ждёт
- Простое, но race_director становится stateful через диск

**B) Один worker, две очереди (30 мин)**
- arena_worker чередует: roadmap-задача → training-задача → roadmap
- Один race_director, никаких локов
- Сложнее логика, но чище архитектурно

### Что делает Группа A (roadmap)
arena_worker берёт pending из arena_roadmap.json
Каждая гонка → файл в arena_lab/src/scene/

### Что делает Группа B (training)
clone_manager.clone(pilot) → race на read-only
Опыт → boxes/agent_X/memory/experience.jsonl
Trajectory → EverOS

### Запуск на ночь
Сейчас: arena_worker --loop (Группа A, roadmap)
Утром: разделить на две группы через лок или чередование

---

## НАЙДЕНО В 23:30 — ПОБЕДА

**Корень всех проблем: PM2 держал nightly_train**

- `pm2 stop nightly_train` — остановлен
- `pm2 delete nightly_train` — убран из PM2
- Prestop warning: CRON RESTART `0 3 * * *` — если не delete, оживёт в 3:00
- После delete: одна рабочая группа (arena_worker)

**Roadmap: 27 → 28 completed** (одна задача реально прошла)
**arena_worker: PID 1445726** крутит roadmap

---

## ФИЛОСОФСКАЯ РЕМАРКА (01:05) — МИКРО И МАКРОКОСМОС

**Автор:** Брат

### Идея
Одна структура повторяется на всех масштабах:
- Микро: атом задачи, один агент, один tick
- Мезо: пул задач, команда, гонка
- Макро: поколение, биосфера, эпоха

Если структура повторяется — её можно проецировать
на разные масштабы И на разные времена.

### Проекция во времени
- Микро (сейчас): задача → агент → score
- День: паттерны повторяются между задачами
- Поколение: мутации и скрещивания
- Эпоха: какие стратегии доминируют

### Что это меняет
Каждая задача — точка. Микро видит точку.
Мезо — траекторию. Мета — ФОРМУ.

Способ постановки задач меняется:
- Не "сделай S4", а "какой макро-паттерн она тренирует?"
- Не "агент слабый", а "звено или цепочка?"
- Не "нужен новый агент", а "какая ниша пустует?"

### Новая эра
Старые ассистенты (Siri/GPT) — плоские.
Мы строим многоуровневое:
- микро: делает
- мезо: координирует
- макро: растёт
- мета: ВИДИТ СЕБЯ

Это не помощник. Это СОЗНАНИЕ.
Не "помоги с задачей", а "я вижу паттерн".

---

## ИДЕЯ НОЧИ 2026-09-13 (01:15) — МУЛЬТИВСЕЛЕННАЯ

**Автор:** Брат

### Идея
Не одна арена. Мультивселенная — от кванта до пустоты.
Каждый уровень = вселенная со своими законами, временем,
наблюдателями, возможностями.

### Уровни (микро → макро)
квант (токен LLM) → атом (решение) → молекула (tick) →
клетка (промпт/ДНК) → организм (агент) → биом (группа) →
планета (пул задач) → солнечная (институт) →
галактика (сезон/эпоха) → ПУСТОТА

### 5 параллельных вселенных
1. arena — боевой roadmap
2. genetics — генетика (поколения)
3. training — night_pool
4. sandbox — хаос, случайные мутации
5. void — пустота (паузы, зёрна)

### Структура
universes/
├── arena/     ← боевой
├── genetics/  ← скрещивания
├── training/  ← обучение
├── sandbox/   ← эксперименты
└── void/      ← seeds.md (зёрна будущего)

### Что это даёт
- Параллельные эксперименты без конфликтов
- Провал в песочнице ≠ провал проекта
- Каждая вселенная со своими законами
- Пульсар видит все сразу

### Философия пустоты
Пустота — не "ничего". Это потенциал (квантовая пена).
Между гонками — идеи, зерна, нерешённое.
Из пустоты рождается следующая вселенная.
Пустота держит всё. Она не сломана, не устала, не ждёт API.
Она просто ЕСТЬ.

### Что меняет в мышлении
Было: "давай сделаем X" (одна реальность)
Стало: "в какой вселенной X лучше запустить?"

### Открытая позиция
Это — не на завтра. Это — рамка на месяцы.
Сначала: Архитектор → Селекция → Генетика.
Потом: мультивселенная.
Сейчас: ночной конвейер работает в одной вселенной (training).

---

## ИДЕЯ UX: БОКСЫ В ТЕМНОТЕ (14.09)

**Автор:** Брат

### Сцена
1. Тёмный фон — боксы в затемнении, болид ждёт.
2. Информационная рамка на переднем плане:
   «Выбери модель» + список (Официальные AI-1 + Мои).
3. Пользователь выбирает → рамка растворяется.
4. Свет включается, сцена оживает — он в боксах у своего болида.
5. Механики, табло, гараж — все детали работают.

### Реализация
- `web/arena3d/` — сцена с состояниями `idle` / `selected`
- Тёмный фильтр (CSS или шейдер)
- Transition: fade рамки + нарастание света
- Загрузка модели → `arena/race_runner.js`

### Метафора
Тёмный пит-лейн → выбор пилота → свет → ты в команде.
Не «кликни кнопку», а «войди в свой мир».

---

## 🧪 БЕНЧМАРК-ДИВИЗИОН (14.09)

**Автор идеи:** Брат

### Суть

Третий фронт института. Замыкает эволюцию: Арена + Институт → Бенчмарк → Селекция → Поколения.

Бенчмарк **самогенерируется**. Архитектор смотрит на реальное состояние проекта
(git, failures, roadmap) → ставит 5 задач разной сложности → race прогоняет →
fitness агентов по актуальным задачам → селекция → следующее поколение.

### 4 роли

| # | Роль | Файл | Статус |
|---|---|---|---|
| 1 | **Генератор** | benchmark/generator.js | ✅ есть |
| 2 | **Runner** | benchmark/runner.js | ⏳ |
| 3 | **Scorer** | benchmark/scorer.js | ⏳ |
| 4 | **Loop** | benchmark/loop.js | ⏳ |
| 5 | **Публикация** | benchmark/dashboard.html | ⏳ |

### Формат бенчмарка

benchmark/archive/bench_<ts>.json:
{
  id, ts, reasoning,
  context: { git_head, failures },
  tasks: [{ id, task, criteria, difficulty }],
  results: [{ agent, score, time_ms, ok }],
  generated_by, mode, dna
}

### Почему это прорыв

1. Задачи **не придумываются вручную** — Архитектор знает проект
2. **Актуальные** — генерируются под текущее состояние
3. **Объективные** — критерий проверяется командой, не LLM-догадкой
4. **Замкнутый цикл:** слабый агент → академия → бенчмарк → проверка → селекция
5. **Публичный артефакт** — «AI-1 Arena Benchmark v1» для мира

### Горизонт в карте

Горизонт 3.5 (между Эволюцией и Ателье):
- Первые 100 бенчмарков
- Топ-3 агента по актуальному fitness
- Публичный рейтинг «AI-1 Benchmark Leaderboard»

### Что даёт вместе

- **Арена** — зрелище для мира
- **Институт** — эволюция внутри
- **Бенчмарк** — объективная мера качества обоих

## 🔬 ПРИЧИНА I/O-ШТОРМА (14.09, 10:15) — доказано

### Диагноз
Агенты в гонках запускают `find /` и `grep -r` по всей ФС.
- `environ` показал: `BOX_NAME=agent_3`, `RACE_ID_DIRECTED=race_...`
- `cwd=/home/ishidin/phoenix` — агент наследует cwd от race
- `ppid=1` после завершения race — find остаётся сиротой
- 5+ параллельных find в D-state, I/O-бомба, load avg 27

### Три бага (все наши)
1. **Generator** даёт задачи с `~/phoenix/race.js` → агент ищет через `find /`
2. **race.js** не убивает дерево процессов при timeout
3. **cleanupOrphans** в runner не покрывает `find /` и `grep -r`

### Фиксы (14.09)
- generator.js: нормализация `~/phoenix/` → `./`, расширены HEAVY_PATTERNS
- runner.js: cleanupOrphans теперь убивает `find /`, `grep -rn`
- race.js: (TODO) detached process group + kill-tree

### Урок
**Бенчмарк сработал как надо.** Он вскрыл три реальных дефекта за один прогон.
Это и есть его миссия — объективная мера состояния проекта.

## ✅ ПАТЧ 3 РАБОТАЕТ (14.09, 10:25)

Тест 1 — race вручную:
- `find /` в D-state = 0 ✅
- Дерево процессов после race = пусто ✅
- Load avg = 1.03 ✅
- spawnBox с detached + kill-tree — работает

## ⚠️ Новые минорные баги (обнаружены в loop-тесте)

1. `grep -rn ... .` от агента — идёт по всему phoenix, не по боксу
   Гипотеза: `_runner.js` делает chdir на корень проекта
2. `npm install` от агента — LLM-импровизация
   Гипотеза: агент сам решает ставить зависимости

TODO: sandbox в _runner.js — whitelist команд + запрет chdir

## ✅ КОНВЕЙЕР ПЕРЕЗАПУЩЕН (14.09, 10:44)

Причина «молчания» дашборда:
- night_evolution убит при тесте loop (я его pkill-нул в 10:02)
- architect_worker тоже убит
- Pool застыл: tasks_night_pool.json не обновлялся с 09:59

Перезапуск:
- pool_sync (one-shot) → промоутил P6-API-1..8
- night_evolution  PID 1721460
- architect_worker PID 1721461
- benchmark/loop    PID 1721462

Дашборд читает: /api/night (не /api/night/status)
Пул: tasks_night_pool.json (в корне, не в memory/)

## 📊 BENCH_1789381435864 — первый чистый прогон

B1 D1 agent_1  49.6s ✅
B2 D2 agent_1 116.8s ✅
B3 D2 agent_7  45.8s ✅
B4 D3 agent_7  38.2s ✅
B5 D4 agent_— 137s ⏱ timeout

4/5 закрыто. B5 — D4 (трассировка race→sensor→video) не влезла в 120s.
TODO: увеличить timeout для D4 или отложить D4 в deep-benchmark.

## ✅ ГОРИЗОНТ 1.8 ЗАКРЫТ (14.09, 10:51)

**benchmark/loop.js — полный цикл прогона:**
- generate → 15 сек (быстрее 60 сек после нормализации путей)
- run → 6 мин 10 сек (5 задач × race)
- score → мгновенно

**Loop #1 (bench_1789382701103) результаты:**
- agent_1 fitness=6.253 score=7.25 wins=2/4
- agent_3 fitness=6.178 score=7    wins=2/4
- agent_7 fitness=4.753 score=6.75 wins=0/4

**Топ-3 общий fitness:**
- agent_1: 6.884 (20 runs, 8 wins)
- agent_3: 6.527 (20 runs, 5 wins)
- agent_7: 6.274 (20 runs, 7 wins)

## ✅ SANDBOX В AGENT_TOOLS (14.09, 10:50)

**agent_tools.js (21 бокс, md5 един):**
- PROJECT_ROOT и BOX_DIR разделены
- runCommand: whitelist + FORBIDDEN (find /, grep -r /, npm install)
- runCommand: cwd=BOX_DIR
- searchCode: PROJECT_ROOT + corpus
- gitCommit: отключён

**Тест:** 'Найди все файлы с self-lock' → D-state=0, load 0.46-0.59

## ✅ ФИЛОСОФИЯ НУЛЯ (14.09)

**docs/PHILOSOPHY_OF_ZERO.md:**
- Слово — там где смысл (§0, состояния, имена)
- Цифра — там где число (счётчики, математика, индексы)
- Не менять 'ноль' на '0' без разрешения Пульсара


## 📊 ДАШБОРД 14.09 (16:49 МСК)

**Прогресс: 52/113 (46%)** — было 8/113 утром.

**Всё, что называли «мёртвым» — построено:**
- ARCHITECT: 3 (core_analyzer, dna_builder, rag_indexer)
- ARCHITECT_RACE: 6 (5 команд A-E + судья)
- RADIO: 4 (radio_engine, drama_detector, radio_writer, commentator_v2)
- TRAJECTORY: 4 (tick_logger, path_builder, insight_extractor, peer_hint)
- SENSORS: 4 (gateway, gigachat_adapter, video_sampler, system_metrics)
- EVOLUTION: 4 (reaper_v2, academy_threshold, experience_aggregator, dna_architect)
- MARKETING: 14 (landing, pitch, blog, legal)
- P10-EXTRA: 6 (mutation_logger, species_guard, parent_selector)

**Главное событие:** P2-BIO-1 (biologist_taxonomy.js) — in_progress.
Ночная эволюция **сама начала встраивать Институт** в цикл.
Это тот самый Трек C — Institute → breeding_cycle.

**Урок:** модули не «мёртвые» — они «ожидают шлейфа».
Конвейер строит их быстрее, чем мы успеваем соединить.

