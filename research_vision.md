# RESEARCH: Vision API для FORMULA I1 (Россия, 2026)

## ЗАДАЧА
Найти бесплатный/дешёвый Vision API для анализа 3D-скриншотов.

## КОНТЕКСТ
- VPS: Ubuntu 24.04, Node.js 22, 2 GB RAM
- Скриншоты: PNG 1920x1080, ~200 KB
- Регион: Россия (Anthropic/OpenAI/Gemini недоступны)
- Бюджет: до 500 руб/мес, желательно бесплатно

## ЧТО ИССЛЕДОВАТЬ
1. YandexGPT (Yandex Cloud) — есть ли vision?
2. GigaChat (Sber) — vision? бесплатный tier?
3. OpenRouter — работает в РФ? дешёвые vision модели?
4. Hugging Face Inference API — доступен? BLIP/LLaVA?
5. Локальные модели — BLIP/LLaVA через transformers.js?
6. Любые альтернативы

## ФОРМАТ ОТВЕТА (JSON)
{"recommendation":"название","why":"почему","endpoint":"URL","auth":"как получить","price":"цена","example_code":"Node.js код","fallback":"альтернатива"}

## КРИТЕРИИ
- Работает в РФ без VPN
- Vision (анализ PNG)
- Дешевле 500 руб/мес
- Простой API

## ОГРАНИЧЕНИЯ
- Не создавай файлов
- Только исследование и ответ в JSON
