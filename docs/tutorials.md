# Учебники Phoenix / Aeon

Полное практическое руководство из **пяти учебников** для разработчиков
платформы Phoenix Space / Aeon — самоизменяющейся системы с автономными
агентами и «гонками» изолированных песочниц (боксов).

Каждый учебник самодостаточен и построен по единой схеме:

- **Цель** — что вы получите в конце.
- **Предпосылки** — что должно быть готово заранее.
- **Шаги** — пошаговые команды и код.
- **Проверка** — как убедиться, что всё работает.
- **Типичные ошибки** — что делать, если не получилось.
- **Упражнения** — задания для закрепления.

## Содержание

1. [Учебник 1. Быстрый старт: окружение и первый запуск](#учебник-1-быстрый-старт-окружение-и-первый-запуск)
2. [Учебник 2. Свой агент и запуск гонки](#учебник-2-свой-агент-и-запуск-гонки)
3. [Учебник 3. REST API, WebSocket и SDK](#учебник-3-rest-api-websocket-и-sdk)
4. [Учебник 4. Данные, память гонок и аналитика](#учебник-4-данные-память-гонок-и-аналитика)
5. [Учебник 5. Развёртывание, PM2 и эксплуатация](#учебник-5-развёртывание-pm2-и-эксплуатация)

Справочные документы: [`quickstart.md`](quickstart.md),
[`api_reference.md`](api_reference.md), [`architecture.md`](architecture.md),
[`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../ROADMAP.md`](../ROADMAP.md).

---

## Учебник 1. Быстрый старт: окружение и первый запуск

### Цель

Поднять рабочее окружение с нуля, установить зависимости, запустить основной
сервер Phoenix (порт 3000) и сервер Aeon Agents (порт 3001), убедиться, что оба
отвечают на `/health`.

### Предпосылки

- Node.js `>= 18` (рекомендуется LTS 20) и npm `>= 9`.
- git `>= 2.30`.
- Свободные порты 3000 и 3001.
- Опционально: Python `>= 3.10` для SDK и вспомогательных скриптов.

Проверьте окружение одной командой:

```bash
node -v && npm -v && git --version
```

Ожидаемый вывод — три строки с версиями, например `v20.11.1`, `10.2.4`,
`git version 2.34.1`.

### Шаг 1. Клонирование репозитория

```bash
git clone https://github.com/v4g7yz29g7-coder/phoenix-space.git phoenix
cd phoenix
```

Убедитесь, что вы в правильной директории — ключевые файлы на месте:

```bash
ls -la server.js aeon_agents_server.js race.js package.json
```

### Шаг 2. Установка зависимостей

```bash
npm install
```

Если вы уже работаете внутри бокса агента, `node_modules` может быть подключён
симлинком на общий кеш хост-системы:

```bash
ls -la node_modules
# node_modules -> /home/ishidin/phoenix/node_modules
```

Для чистого окружения без `package.json` поставьте ключевые пакеты вручную:

```bash
npm init -y
npm i express socket.io socket.io-client better-sqlite3 dotenv jsonwebtoken
```

### Шаг 3. Переменные окружения

Скопируйте шаблон и заполните значения:

```bash
cp .env.example .env
```

Минимально 필요한 переменные:

```dotenv
PORT=3000
AEON_PORT=3001
ADMIN_KEY=change-me
JWT_SECRET=change-me-too
DB_PATH=./phoenix.db
LOG_LEVEL=info
```

Никогда не коммитьте `.env` — он уже должен быть в `.gitignore`.

### Шаг 4. Запуск основного сервера

```bash
node server.js
```

В отдельном терминале запустите сервер агентов:

```bash
node aeon_agents_server.js
```

Для фонового запуска используйте nohup или PM2 (см. учебник 5):

```bash
nohup node server.js > logs/server.out 2>&1 &
nohup node aeon_agents_server.js > logs/aeon.out 2>&1 &
```

### Шаг 5. Проверка здоровья (health-check)

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3001/health
```

Ожидаемый ответ — JSON со статусом `ok`:

```json
{ "status": "ok", "uptime": 12.34, "db": "connected" }
```

### Проверка результата

- `node -v` показывает версию ≥ 18.
- `npm install` завершается без ошибок.
- Оба `/health` отвечают `status: ok`.
- В корне появились `phoenix.db` и директория `logs/`.

### Типичные ошибки

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `EADDRINUSE` | порт занят | `lsof -i :3000` и завершите процесс, либо смените `PORT` |
| `Cannot find module 'express'` | не выполнен `npm install` | выполните `npm install` в корне проекта |
| `SQLITE_CANTOPEN` | нет прав на `DB_PATH` | задайте путь в домашней директории |
| `JWT_SECRET is required` | переменные не загружены | проверьте наличие и синтаксис `.env` |

### Упражнения

1. Запустите оба сервера через один npm-скрипт `npm run dev`.
2. Добавьте в `/health` вывод версии из `package.json`.
3. Настройте `nodemon` для автоперезапуска при изменении файлов.

---

## Учебник 2. Свой агент и запуск гонки

### Цель

Написать собственного агента, зарегистрировать его в системе и запустить
«гонку» — соревнование нескольких агентов в изолированных боксах.

### Предпосылки

- Пройден учебник 1, оба сервера запущены.
- Понимание базового JavaScript (async/await).
- Свободное место на диске для боксов (минимум 2 ГБ).

### Шаг 1. Структура агента

Каждый агент — это модуль, экспортирующий объект с методами жизненного цикла.
Создайте `agents/my_agent.js`:

```javascript
module.exports = {
  name: "my_agent",
  version: "0.1.0",

  // Инициализация: агент получает доступ к песочнице
  async init(ctx) {
    this.ctx = ctx;
    ctx.log("Агент инициализирован");
    return true;
  },

  // Основной шаг: агент решает задачу итеративно
  async step(task) {
    const plan = await this.think(task);
    const result = await this.act(plan);
    return { ok: true, result };
  },

  // Рефлексия: агент оценивает свой результат
  async reflect(result) {
    return { score: result.ok ? 1 : 0 };
  },

  async think(task) {
    return { approach: "greedy", target: task.id };
  },

  async act(plan) {
    return { applied: plan.approach, target: plan.target };
  },
};
```

### Шаг 2. Регистрация агента

Добавьте агента в манифест или реестр (в зависимости от версии сборки):

```bash
node -e "require('./agents/my_agent.js')"   # проверка синтаксиса и загрузки
```

Зарегистрируйте через API каталога агентов:

```bash
curl -s -X POST http://localhost:3001/agents \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Key: change-me' \
  -d '{"name":"my_agent","entry":"agents/my_agent.js"}'
```

### Шаг 3. Запуск гонки

Простейший запуск гонки между несколькими агентами:

```bash
node race.js --agents my_agent,agent_8,agent_9 --task tasks_pool.json
```

Расширенный запуск с числом боксов и таймаутом:

```bash
node race.js \
  --agents agent_10,agent_11,agent_12 \
  --pool tasks_night_pool.json \
  --boxes 3 \
  --timeout 300 \
  --out memory/races/
```

### Шаг 4. Наблюдение за ходом гонки

Подпишитесь на поток событий через WebSocket:

```javascript
const { io } = require("socket.io-client");
const socket = io("http://localhost:3001");

socket.on("race:start", (e) => console.log("Старт:", e.raceId));
socket.on("race:step", (e) => console.log("Шаг:", e.agent, e.progress));
socket.on("race:finish", (e) => console.log("Финиш:", e.winner, e.scores));
```

Либо следите за статусом из CLI:

```bash
node race_status.js
```

### Шаг 5. Определение победителя

Победитель выбирается по суммарному счёту (score), который вычисляется из
метрик шага: успех задачи, затраченное время, потребление ресурсов. Результат
сохраняется в `memory/races/<raceId>.json`.

```bash
cat memory/races/$(ls -t memory/races | head -1)
```

### Проверка результата

- Агент загружается без ошибок синтаксиса.
- Гонка завершается и пишет файл в `memory/races/`.
- События `race:start/step/finish` приходят по WebSocket.
- В файле результата есть поле `winner`.

### Типичные ошибки

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `Agent not found` | неверный `--agents` | проверьте имя и путь файла |
| Гонка «зависла» | нет `timeout` | задайте `--timeout` |
| Пустой результат | агент падает в `step` | оберните тело в try/catch |
| `EACCES` при записи | нет прав на `memory/` | `chmod -R u+w memory` |

### Упражнения

1. Добавьте в агента стратегию `random` и сравните со `greedy`.
2. Реализуйте раннюю остановку при достижении целевого score.
3. Запустите гонку из 5 агентов и постройте таблицу лидеров.

---

## Учебник 3. REST API, WebSocket и SDK

### Цель

Научиться работать с основным сервером Phoenix через REST и WebSocket, а также
использовать клиентские SDK (JavaScript и Python).

### Предпосылки

- Пройден учебник 1, сервер на порту 3000 запущен.
- Получен JWT-токен (см. шаг 1).

### Шаг 1. Аутентификация

Получите токен:

```bash
curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"did":"did:phoenix:demo","signature":"..."}'
```

Сохраните токен в переменную окружения для последующих запросов:

```bash
export TOKEN="eyJhbGciOi..."
```

### Шаг 2. Базовые REST-запросы

Чтение профиля:

```bash
curl -s http://localhost:3000/api/profile/me \
  -H "Authorization: Bearer $TOKEN"
```

Создание артефакта в Мастерской:

```bash
curl -s -X POST http://localhost:3000/api/artifacts \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Мой артефакт","type":"text","body":"hello"}'
```

Загрузка файла (multipart):

```bash
curl -s -X POST http://localhost:3000/api/artifacts/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F 'file=@./sample.png' \
  -F 'title=Картинка'
```

### Шаг 3. Пагинация и фильтры

```bash
curl -s "http://localhost:3000/api/artifacts?limit=20&offset=0&type=text" \
  -H "Authorization: Bearer $TOKEN"
```

Ответ содержит `total`, `limit`, `offset` и массив `items`.

### Шаг 4. WebSocket / Socket.IO

```javascript
const { io } = require("socket.io-client");
const socket = io("http://localhost:3000", {
  auth: { token: process.env.TOKEN },
});

socket.on("connect", () => {
  console.log("Подключено:", socket.id);
  socket.emit("subscribe", { channel: "workshop" });
});

socket.on("artifact:created", (a) => console.log("Новый артефакт:", a.id));
socket.on("disconnect", (r) => console.log("Отключено:", r));
```

### Шаг 5. JavaScript SDK

```javascript
const { PhoenixClient } = require("./sdk/js");

const client = new PhoenixClient({
  baseUrl: "http://localhost:3000",
  token: process.env.TOKEN,
});

(async () => {
  const me = await client.profile.me();
  console.log("Профиль:", me.did);

  const art = await client.artifacts.create({ title: "SDK", type: "text" });
  console.log("Создано:", art.id);
})();
```

### Шаг 6. Python SDK

```python
from phoenix_sdk import PhoenixClient

client = PhoenixClient(base_url="http://localhost:3000", token="...")
me = client.profile.me()
print("Профиль:", me["did"])

artifact = client.artifacts.create(title="Из Python", type="text")
print("Создано:", artifact["id"])
```

Установка Python SDK:

```bash
pip install phoenix-sdk
# либо из исходников
pip install -e ./sdk/python
```

### Проверка результата

- Запросы без токена возвращают `401`.
- С токеном операции возвращают `success: true`.
- WebSocket присылает события не позднее чем через 5 секунд после действия.
- Оба SDK выполняют одинаковый сценарий без ошибок.

### Типичные ошибки

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `401 Unauthorized` | истёк или отсутствует токен | обновите токен, проверьте заголовок |
| `429 Too Many Requests` | превышен rate limit | снизьте частоту, добавьте backoff |
| `CORS` в браузере | origin не разрешён | добавьте origin в белый список |
| WebSocket не подключается | неверный токен в `auth` | передайте `auth: { token }` |

### Упражнения

1. Напишите обёртку с автоматическим retry и backoff.
2. Реализуйте real-time ленту артефактов на WebSocket.
3. Опишите все ошибки API в собственном `errors.md`.

---

## Учебник 4. Данные, память гонок и аналитика

### Цель

Научиться читать, агрегировать и визуализировать результаты гонок из
`memory/races/` и базы `phoenix.db`.

### Предпосылки

- Пройдены учебники 1–2, есть хотя бы одна завершённая гонка.
- Установлен Python с pandas (см. ниже).

### Шаг 1. Установка инструментов анализа

```bash
pip install pandas pyarrow matplotlib
python3 -c "import pandas; print(pandas.__version__)"
```

Если pip недоступен (голая Ubuntu), используйте `uv`:

```bash
curl -LsSf https://astral.sh/uv/0.7.13/install.sh | sh
source $HOME/.local/bin/env
uv init
uv add pandas pyarrow matplotlib
```

### Шаг 2. Чтение результатов гонок

```python
import glob, json
import pandas as pd

rows = []
for path in glob.glob("memory/races/*.json"):
    with open(path, encoding="utf-8") as f:
        race = json.load(f)
    for agent, score in race.get("scores", {}).items():
        rows.append({
            "race": race.get("raceId"),
            "agent": agent,
            "score": score,
            "steps": race.get("steps", {}).get(agent, 0),
            "duration": race.get("duration", 0),
        })

df = pd.DataFrame(rows)
print(df.head())
print(df.dtypes)
```

### Шаг 3. Очистка данных

```python
# Удаляем полностью пустые строки
df = df.dropna(how="all")

# Заполняем пропуски в числовых колонках медианой
numeric = df.select_dtypes(include="number").columns
df[numeric] = df[numeric].fillna(df[numeric].median())

# Убираем дубликаты
df = df.drop_duplicates()
```

### Шаг 4. Агрегация по агентам

```python
summary = df.groupby("agent").agg(
    races=("race", "count"),
    total_score=("score", "sum"),
    avg_score=("score", "mean"),
    avg_steps=("steps", "mean"),
).reset_index().sort_values("avg_score", ascending=False)

print(summary)
```

### Шаг 5. Экспорт в Parquet

```python
df.to_parquet("memory/races_summary.parquet", index=False)
check = pd.read_parquet("memory/races_summary.parquet")
assert check.shape == df.shape, "Размеры не совпадают!"
print("Сохранено строк:", len(df))
```

### Шаг 6. Визуализация

```python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.figure(figsize=(10, 6))
plt.barh(summary["agent"], summary["avg_score"])
plt.xlabel("Средний score")
plt.title("Рейтинг агентов")
plt.tight_layout()
plt.savefig("memory/leaderboard.png", dpi=120)
print("График сохранён")
```

### Шаг 7. Прямые запросы к SQLite

```bash
sqlite3 phoenix.db "SELECT agent, COUNT(*), AVG(score) FROM race_results GROUP BY agent;"
```

### Проверка результата

- Скрипт собирает данные из `memory/races/*.json` без ошибок.
- `races_summary.parquet` создан и читается обратно.
- График `leaderboard.png` сохранён.
- SQL-запрос возвращает агрегаты по агентам.

### Типичные ошибки

| Ошибка | Причина | Решение |
|--------|---------|---------|
| `ArrowNotImplementedError` | нет pyarrow | `pip install pyarrow` |
| Ошибка кодировки | не utf-8 | `encoding="utf-8"` в `open` |
| Пустой DataFrame | нет файлов гонок | запустите гонку (учебник 2) |
| `sqlite3: command not found` | нет пакета | `apt-get install sqlite3` |

### Упражнения

1. Посчитайте медианный score по каждому агенту.
2. Постройте динамику score по датам гонок.
3. Сравните два агента статистическим тестом.

---

## Учебник 5. Развёртывание, PM2 и эксплуатация

### Цель

Развернуть платформу в продакшне под управлением PM2, настроить Nginx как
reverse-proxy, автозапуск и бэкапы.

### Предпосылки

- Пройдены учебники 1–4.
- Сервер Ubuntu с правами `sudo`.
- Домен (или IP) для доступа извне.

### Шаг 1. Установка PM2

```bash
sudo npm i -g pm2
pm2 -v
```

### Шаг 2. Файл экосистемы

Создайте `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: "phoenix",
      script: "server.js",
      env: { NODE_ENV: "production", PORT: 3000 },
      max_memory_restart: "500M",
      instances: 1,
    },
    {
      name: "aeon-agents",
      script: "aeon_agents_server.js",
      env: { NODE_ENV: "production", AEON_PORT: 3001 },
      max_memory_restart: "500M",
      instances: 1,
    },
  ],
};
```

### Шаг 3. Запуск и автозапуск

```bash
pm2 start ecosystem.config.js
pm2 status
pm2 save
pm2 startup
# выполните команду, которую выведет pm2 startup
```

Проверка статуса:

```bash
pm2 logs phoenix --lines 50
pm2 logs aeon-agents --lines 50
```

### Шаг 4. Nginx как reverse-proxy

Создайте `/etc/nginx/sites-available/phoenix`:

```nginx
server {
    listen 80;
    server_name phoenix.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /aeon/ {
        proxy_pass http://127.0.0.1:3001/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Активируйте конфигурацию:

```bash
sudo ln -s /etc/nginx/sites-available/phoenix /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Для WebSocket обязательно оставьте заголовки `Upgrade` и `Connection: upgrade`,
иначе Socket.IO не подключится через прокси.

### Шаг 5. HTTPS (Let's Encrypt)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d phoenix.example.com
sudo systemctl status certbot.timer
```

### Шаг 6. Ротация логов

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

### Шаг 7. Бэкапы

Ежедневный бэкап баз данных:

```bash
mkdir -p /var/backups/phoenix
sqlite3 /home/ishidin/phoenix/phoenix.db ".backup '/var/backups/phoenix/phoenix-$(date +%F).db'"
sqlite3 /home/ishidin/phoenix/gardener.db ".backup '/var/backups/phoenix/gardener-$(date +%F).db'"
```

Добавьте в cron (см. учебник 3):

```cron
0 4 * * * /home/ishidin/phoenix/backup.sh >> /var/log/phoenix-backup.log 2>&1
```

### Шаг 8. Финальная верификация

```bash
curl -s http://localhost:3000/health
curl -s http://localhost:3001/health
curl -sI https://phoenix.example.com
pm2 status
```

Все процессы должны быть в статусе `online`, HTTPS должен отвечать `200`.

### Проверка результата

- `pm2 status` показывает оба приложения как `online`.
- Nginx проксирует 3000 и 3001 без ошибок.
- `pm2 save` выполнен, автозапуск включён.
- HTTPS-сертификат установлен и автоматически продлевается.
- Бэкапы создаются ежедневно.

### Типичные ошибки

| Ошибка | Причина | Решение |
|--------|---------|---------|
| Процесс перезапускается | падение при старте | `pm2 logs phoenix --err` |
| Nginx отдаёт `502` | сервис не слушает порт | проверьте `pm2 status` и `PORT` |
| Нет автозапуска | `pm2 save` не выполнен | `pm2 save && pm2 startup` |
| Закончилось место | логи не ротируются | настройте `pm2-logrotate` |
| WebSocket отваливается | нет `Upgrade`-заголовков | проверьте блок `proxy_set_header` |

### Упражнения

1. Настройте zero-downtime деплой (`pm2 reload`).
2. Добавьте мониторинг доступности с внешним пингером.
3. Опишите процедуру отката на предыдущую версию.

---

## Заключение

Вы прошли пять учебников и теперь умеете:

1. Поднимать окружение и запускать оба сервера.
2. Писать агентов и запускать гонки боксов.
3. Работать с REST API, WebSocket и клиентскими SDK.
4. Анализировать результаты гонок из `memory/races/` и базы `phoenix.db`.
5. Разворачивать и эксплуатировать систему под PM2 + Nginx.

Дальше: загляните в [`api_reference.md`](api_reference.md) для полного списка
эндпоинтов, в [`architecture.md`](architecture.md) для карты системы и в
[`../ROADMAP.md`](../ROADMAP.md) для планов развития платформы.

**Мы строим Ковчег. Присоединяйся.**
