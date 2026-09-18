# СЕНСОРНЫЙ СЛОЙ — план

## Идея
Расширить восприятие агентов с одного сенсора (зрение/GigaChat Vision)
до мультисенсорного слоя: видео, аудио, документы, метрики.

## Архитектура
- sensor_gateway.js — универсальный интерфейс
- Обработчики pluggable: GigaChat, YandexGPT, локальный LLM
- Унифицированный event → EverOS / radio / trajectory

## Три волны

### Волна 1 — Расширить GigaChat (2-3 часа)
- documents: PDF/docx через GigaChat API
- structured output: JSON schema
- sensor_gateway.js: единый интерфейс

### Волна 2 — Видео (3-4 часа)
- video_sampler.js: ffmpeg кадры каждые N сек
- GigaChat Vision пакетом
- Применение: клипы обгонов из TV Director

### Волна 3 — Мультисенсор (день)
- Аудио: Yandex SpeechKit / Whisper
- Системные метрики VPS → здоровье арены
- Events socket.io → radio (частично есть)

## Что даёт
- Гонки = зрелище (видео обгонов с описанием)
- Trajectory богаче (путь + видео + аудио)
- Race Control видит глубже (трасса, шины, погода)
- WHITEPAPER §6.3 cross-domain tasks — реально

## Связь с существующим
- agent_27_vision_director.js — станет ЧАСТЬЮ сенсорного слоя
- race_director.js — эмитит события, sensor_layer слушает
- trajectory_builder.js — принимает sensor events
