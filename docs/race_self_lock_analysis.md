# Анализ self-lock в race.js

## Источники
- Репозиторий: `/home/ishidin/phoenix` (файл `race.js`)
- Коммит `3babbd2` — `feat(race): self-lock — только один race.js за раз`
- Коммит `0cc6a8f` — `fix(race): lock — async sleep вместо busy-wait`

## Механизм (коммит 3babbd2)
Файловый лок `/tmp/phoenix_race.lock`.
- В лок пишется PID владельца (`fs.openSync(..., 'wx')` + `fs.writeSync`).
- Второй процесс при `EEXIST` проверяет, жив ли владелец через `process.kill(owner, 0)`.
- Если владелец мёртв — лок удаляется (`unlinkSync`), попытка захвата повторяется.
- TTL ожидания — 5 минут (`TIMEOUT_MS = 5 * 60 * 1000`).
- Лок удаляется на `exit`/`SIGINT`/`SIGTERM`.

### Проблема первой версии (busy-wait)
Ожидание было реализовано синхронным busy-wait:
```js
const until = Date.now() + 500;
while (Date.now() < until) {}   // ~92% CPU
```
Процесс-ожидающий крутился в цикле и жёг CPU.

## Исправление (коммит 0cc6a8f)
Ожидание заменено на **async sleep** (асинхронную паузу):
```js
// Ждём 500мс (async, не жжёт CPU)
await new Promise(r => setTimeout(r, 500));
```
Дополнительно:
- функция `acquireRaceLock()` стала `async function`;
- убран top-level вызов `acquireRaceLock()` (он был до async);
- вызов перенесён внутрь IIFE: `await acquireRaceLock();`

## Ответ на вопрос
**Имя функции:** `acquireRaceLock()` (объявлена как `async function acquireRaceLock()`).
**Механизм ожидания освобождения лока после коммита 0cc6a8f:** **async sleep** —
`await new Promise(r => setTimeout(r, 500))`. Busy-wait (`while (Date.now() < until) {}`)
удалён. CPU при ожидании: 92% → 0.7%. После 0cc6a8f файл `race.js` больше не менялся
(`git log 0cc6a8f..HEAD -- race.js` пуст), т.е. в текущем коде именно async sleep.

## Детали
- Файл лока: `/tmp/phoenix_race.lock`, содержимое — PID владельца.
- Захват: `fs.openSync(RACE_LOCK, 'wx')` (флаг `wx` → атомарно, ошибка `EEXIST`, если занят).
- Проверка живости владельца: `process.kill(owner, 0)`.
- Интервал опроса: 500 мс.
- Таймаут ожидания: 5 минут, при превышении — `process.exit(1)`.
