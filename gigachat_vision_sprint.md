# GIGACHAT VISION DIRECTOR — agent_27

## ЗАДАЧА
Создать модуль для анализа 3D-скриншотов через GigaChat Vision API.

## ENV ПЕРЕМЕННЫЕ (уже в .env)
- GIGACHAT_AUTH_KEY=base64(client_id:client_secret)
- GIGACHAT_CLIENT_ID=01a09a9e-4e66-7919-b63a-79e1a365484d
- GIGACHAT_CLIENT_SECRET=b84ae774-fd18-4147-800d-f9280f30eb73
- GIGACHAT_SCOPE=GIGACHAT_API_PERS
- FORMULA_URL=http://localhost:3020/3d/

## GIGACHAT API
1. OAuth (получение access_token):
   POST https://ngw.devices.sberbank.ru:9443/api/v2/oauth
   Headers: Authorization: Basic ${GIGACHAT_AUTH_KEY}, RqUID: ${randomUUID()}
   Body: scope=${GIGACHAT_SCOPE}
   Response: { access_token, expires_at }

2. Upload файла (изображения):
   POST https://gigachat.devices.sberbank.ru/api/v1/files
   Headers: Authorization: Bearer ${access_token}
   multipart/form-data: file=@screenshot.png; purpose=general
   Response: { id: "file_id" }

3. Chat с изображением:
   POST https://gigachat.devices.sberbank.ru/api/v1/chat/completions
   Headers: Authorization: Bearer ${access_token}
   Body: { model: "GigaChat-Pro", messages: [{ role: "user", content: "Что на скриншоте?", attachments: ["file_id"] }] }

## ФАЙЛЫ ДЛЯ СОЗДАНИЯ
- gigachat_client.js — OAuth + upload + chat
- vision_capture.js — Puppeteer: скриншот из FORMULA_URL
- agent_27_vision_director.js — оркестратор: capture → upload → analyze → JSON

## АРХИТЕКТУРА agent_27_vision_director.js
```
const result = await directVisualCycle();
// result = {
//   screenshot: "/tmp/formula_i1.png",
//   analysis: "Описание сцены от GigaChat",
//   issues: ["Трибуны без текстуры", "Камера низко"],
//   fixes: { camera_trackside: [60, 8, 30] }
// }
```

## ЗАВИСИМОСТИ
- puppeteer (проверить: npm ls puppeteer)
- Если нет: npm install puppeteer --save

## КРИТЕРИИ
1. node --check на каждом файле → OK
2. node agent_27_vision_director.js → выводит JSON с анализом
3. Скриншот сохраняется в /tmp/formula_i1.png (1920x1080, >50 KB)
4. GigaChat возвращает описание сцены >100 символов

## ОГРАНИЧЕНИЯ
- Только новые файлы в корне ~/phoenix/
- Не трогать: race.js, race_director.js, web/, arena_lab/
- Использовать https модуль Node.js (не fetch, если не уверен)
- rejectUnauthorized: false для ngw.devices.sberbank.ru (Russian Trusted CA)
