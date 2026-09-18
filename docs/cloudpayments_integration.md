# Интеграция CloudPayments

Полное руководство по подключению платежей CloudPayments к проекту **Phoenix / Aeon Agents**:
регистрация мерчанта, получение `Public ID` и `API Secret`, платёжный виджет на лендинге,
webhook для payment notifications и рекуррентные платежи для подписок.

> Актуальная версия API: `https://api.cloudpayments.ru`
> Документация виджета: `https://developers.cloudpayments.ru/#widget`
> Личный кабинет: `https://merchant.cloudpayments.ru`

## Содержание

1. [Регистрация мерчанта](#1-регистрация-мерчанта)
2. [Получение Public ID и API Secret](#2-получение-public-id-и-api-secret)
3. [Виджет на лендинге](#3-виджет-на-лендинге)
4. [Webhook для payment notifications](#4-webhook-для-payment-notifications)
5. [Рекуррентные платежи для подписок](#5-рекуррентные-платежи-для-подписок)
6. [Тестовый режим](#6-тестовый-режим)
7. [Безопасность](#7-безопасность)
8. [Чек-лист внедрения](#8-чек-лист-внедрения)

---

## 1. Регистрация мерчанта

1. Откройте [https://cloudpayments.ru](https://cloudpayments.ru) и нажмите **«Подключиться»**.
2. Заполните данные организации:
   - название (как в банковской выписке), ИНН, ОГРН/ОГРНИП;
   - юридический адрес и контактные данные;
   - расчётный счёт для выплат (эквайринг перечисляет деньги на р/с).
3. Загрузите документы: устав, выписка ЕГРЮЛ, паспорт подписанта.
4. Пройдите проверку (обычно 1–3 рабочих дня).
5. После одобрения получите доступ в личный кабинет и раздел **Настройки → API**.

> Для самозанятых и ИП доступен упрощённый онбординг.

---

## 2. Получение Public ID и API Secret

Личный кабинет → **Настройки → API → Ключи доступа**.

- **Public ID** — публичный идентификатор мерчанта. Можно вставлять в клиентский JS.
- **API Secret** — приватный ключ. Только на сервере, никогда в браузере и не в git.

```text
Public ID:  pk_1234567890abcdef
API Secret: sk_0987654321fedcba   # НЕ публиковать
```

Сохраните секреты в переменных окружения:

```bash
# .env  (добавить в .gitignore!)
CLOUDPAYMENTS_PUBLIC_ID=pk_1234567890abcdef
CLOUDPAYMENTS_API_SECRET=sk_0987654321fedcba
CLOUDPAYMENTS_API_URL=https://api.cloudpayments.ru
# Секрет для проверки подписи входящих webhook
CLOUDPAYMENTS_WEBHOOK_SECRET=change-me-random-32-char-hex
```

---

## 3. Виджет на лендинге

Виджет — готовая платёжная форма. Подключите скрипт и инициализируйте оплату кликом.

### HTML

```html
<!-- index.html -->
<button id="pay-btn" data-plan="pro">Оплатить 1990 ₽</button>
<script src="https://widget.cloudpayments.ru/bundles/cloudpayments.js"></script>
<script src="/js/payment.js"></script>
```

### JS — одноразовый платёж

```javascript
// js/payment.js
const PUBLIC_ID = 'pk_1234567890abcdef'; // Public ID из личного кабинета
const widget = new cp.CloudPayments({ language: 'ru-RU' });

document.getElementById('pay-btn').addEventListener('click', function () {
  const plan = this.dataset.plan; // 'pro' | 'business'

  widget.pay(
    'charge', // charge — одностадийная оплата, auth — двухстадийная
    {
      publicId: PUBLIC_ID,
      description: 'Подписка Phoenix, тариф ' + plan,
      amount: 1990.0,                       // сумма в рублях
      currency: 'RUB',
      invoiceId: 'ORDER-' + Date.now(),     // ваш идентификатор заказа
      accountId: 'user_42',                 // ID пользователя в вашей системе
      email: 'customer@example.com',
      skin: 'modern',                       // 'mini' | 'classic' | 'modern'
      data: {
        // Произвольные поля — вернутся в webhook для сверки
        plan: plan,
        source: 'landing'
      }
    },
    {
      onSuccess: function (options) {
        console.log('Оплата успешна', options.invoiceId);
        window.location.href = '/success.html?invoiceId=' + options.invoiceId;
      },
      onFail: function (reason, options) {
        console.error('Ошибка оплаты', reason, options);
        alert('Оплата не прошла: ' + reason);
      },
      onComplete: function (paymentResult, options) {
        // Вызывается всегда: success / fail / cancel
        console.log('Завершено', paymentResult);
      }
    }
  );
});
```

### HTML — кнопки тарифов

```html
<div class="tariffs">
  <div class="tariff">
    <h3>Free</h3><p>0 ₽</p>
  </div>
  <div class="tariff">
    <h3>Pro</h3><p>1990 ₽ / мес</p>
    <button class="pay" data-plan="pro">Подключить</button>
  </div>
  <div class="tariff">
    <h3>Business</h3><p>4900 ₽ / мес</p>
    <button class="pay" data-plan="business">Подключить</button>
  </div>
</div>
```

---

## 4. Webhook для payment notifications

Личный кабинет → **Настройки → Уведомления (Webhooks)**. Укажите URL для каждого события.
CloudPayments отправляет POST-уведомления при изменении статуса платежа.

| Событие (`Type`) | Когда приходит                       | Пример URL                            |
|------------------|--------------------------------------|---------------------------------------|
| `Pay`            | Платёж успешно завершён              | `https://api.example.com/cp/pay`      |
| `Fail`           | Платёж неуспешен                     | `https://api.example.com/cp/fail`     |
| `Recurrent`      | Успешный рекуррентный платёж         | `https://api.example.com/cp/recurrent`|
| `RecurrentFail`  | Неуспешный рекуррентный платёж       | `https://api.example.com/cp/recfail`  |
| `Refund`         | Возврат средств                      | `https://api.example.com/cp/refund`   |
| `Confirm`        | Подтверждение двухстадийной оплаты   | `https://api.example.com/cp/confirm`  |
| `Check`          | Проверка возможности оплаты          | `https://api.example.com/cp/check`    |

### Проверка подписи (HMAC-SHA256)

Каждый запрос содержит заголовок `Content-HMAC` — HMAC-SHA256 от **сырого тела** запроса,
ключ = `API Secret`. Сравнивайте в постоянном времени.

```javascript
// server/webhook.js (Express)
const express = require('express');
const crypto = require('crypto');

const app = express();
// ВАЖНО: обычный express.json() ломает подпись — нужен сырой body
app.use(express.raw({ type: '*/*' }));

const API_SECRET = process.env.CLOUDPAYMENTS_API_SECRET;

function verifyHmac(rawBody, headerHmac) {
  const expected = crypto
    .createHmac('sha256', API_SECRET)
    .update(rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(headerHmac || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/cp/pay', (req, res) => {
  const raw = req.body.toString('utf8');
  const hmac = req.get('Content-HMAC') || req.get('X-Content-HMAC');

  if (!verifyHmac(raw, hmac)) {
    console.warn('Webhook: неверная подпись');
    return res.status(403).json({ code: 13 });
  }

  const body = JSON.parse(raw);
  const { Type, InvoiceId, AccountId, Amount, Data, SubscriptionId } = body;

  switch (Type) {
    case 'Pay':
    case 'Recurrent':
      activateTariff(AccountId, Data && Data.plan, Amount, InvoiceId);
      break;
    case 'Fail':
    case 'RecurrentFail':
      markPaymentFailed(AccountId, InvoiceId);
      break;
    case 'Refund':
      revokeTariff(AccountId, InvoiceId);
      break;
  }

  // code: 0 — успешно обработано, иначе CloudPayments повторит запрос
  res.json({ code: 0 });
});

app.listen(3000, () => console.log('Webhook listening on :3000'));
```

### Пример тела webhook

```json
{
  "TransactionId": 12345678,
  "Amount": 1990.0,
  "Currency": "RUB",
  "Status": "Completed",
  "InvoiceId": "ORDER-1024",
  "AccountId": "user_42",
  "Email": "customer@example.com",
  "SubscriptionId": "sc_9f8e7d6c",
  "Data": { "plan": "pro", "source": "landing" }
}
```

### Идемпотентная обработка

```javascript
function activateTariffIdempotent(db, userId, plan, amount, invoiceId, cb) {
  db.get('SELECT id FROM payments WHERE invoice_id = ?', [invoiceId], (err, row) => {
    if (row) return cb(null, { alreadyProcessed: true });
    db.run(
      'INSERT INTO payments (user_id, plan, amount, status, invoice_id) VALUES (?,?,?,?,?)',
      [userId, plan, amount, 'paid', invoiceId],
      (e) => db.run('UPDATE users SET plan = ? WHERE id = ?', [plan, userId], cb)
    );
  });
}
```

---

## 5. Рекуррентные платежи для подписок

Для подписок используйте двухстадийную оплату `auth` при первом платеже,
затем списывайте `charge` по сохранённому `Token`.

### Шаг 1. Первый платёж — получение токена

```javascript
// Виджет создаёт токен при типе операции 'auth'
widget.pay('auth', {
  publicId: PUBLIC_ID,
  amount: 1990.0,
  currency: 'RUB',
  email: 'customer@example.com',
  accountId: 'user_42',
  invoiceId: 'SUB-FIRST-' + Date.now(),
  data: { plan: 'pro', recurring: true }
}, {
  onSuccess: (options) => location.href = '/success.html'
});
```

### Шаг 2. Списание по токену (сервер)

```javascript
// server/recurrent.js
const axios = require('axios');

const API_URL = process.env.CLOUDPAYMENTS_API_URL || 'https://api.cloudpayments.ru';
const AUTH = Buffer
  .from(`pk_1234567890abcdef:${process.env.CLOUDPAYMENTS_API_SECRET}`)
  .toString('base64');

async function chargeByToken(token, accountId, amount) {
  const { data } = await axios.post(
    `${API_URL}/payments/token/charge`,
    {
      Amount: amount,
      Currency: 'RUB',
      AccountId: accountId,
      Token: token,
      InvoiceId: `SUB-${Date.now()}`,
      Description: 'Подписка Phoenix Pro',
      IpAddress: '1.2.3.4',
      Email: 'customer@example.com'
    },
    { headers: { Authorization: `Basic ${AUTH}` } }
  );
  return data;
}

module.exports = { chargeByToken };
```

### Шаг 3. Планировщик продлений

```javascript
// server/scheduler.js — раз в сутки проверяем активные подписки
const cron = require('node-cron');
const { chargeByToken } = require('./recurrent');
const db = require('./db');

cron.schedule('0 6 * * *', async () => {
  const subs = await db.all(
    "SELECT id, user_id, token, price FROM subscriptions WHERE status = 'active' AND next_charge <= date('now')"
  );
  for (const s of subs) {
    try {
      const result = await chargeByToken(s.token, s.user_id, s.price);
      if (result && result.Success) {
        await db.run('UPDATE subscriptions SET next_charge = date(next_charge, "+1 month") WHERE id = ?', [s.id]);
      } else {
        await db.run("UPDATE subscriptions SET status = 'past_due' WHERE id = ?", [s.id]);
      }
    } catch (err) {
      console.error('Recurrent charge failed', s.id, err.message);
    }
  }
});
```

### Отмена подписки

```javascript
async function cancelSubscription(subscriptionId) {
  return axios.post(
    `${API_URL}/subscriptions/cancel`,
    { Id: subscriptionId },
    { headers: { Authorization: `Basic ${AUTH}` } }
  );
}
```

---

## 6. Тестовый режим

Используйте тестовые карты (срок — любой будущий, CVC — `123`):

```text
Успешная оплата: 4242 4242 4242 4242
3-D Secure:      4000 0000 0000 0002
Отказ банка:     4000 0000 0000 0006
```

### Локальная отладка webhook

CloudPayments должен достучаться до webhook по HTTPS. Для локальной разработки — туннель:

```bash
cloudflared tunnel --url http://localhost:3000
# либо
ngrok http 3000
```

Ручная проверка обработчика:

```bash
curl -X POST http://localhost:3000/cp/pay \
  -H "Content-Type: application/json" \
  -H "Content-HMAC: <base64-hmac>" \
  -d '{"Type":"Pay","InvoiceId":"ORDER-1","AccountId":"user_42","Amount":1990,"Data":{"plan":"pro"}}'
```

---

## 7. Безопасность

- Никогда не храните `API Secret` на фронтенде и не коммитьте в git.
- Всегда проверяйте `Content-HMAC` во входящих webhook (constant-time сравнение).
- Только HTTPS; домен webhook — из белого списка.
- Сверяйте `Amount` из webhook с ожидаемой ценой тарифа (защита от подмены на клиенте).
- Идемпотентность: повторный webhook с тем же `InvoiceId`/`TransactionId` не должен дублировать записи.
- Логируйте `TransactionId` для сверки с кабинетом и поддержкой.
- Ведите таблицу `payments (id, user_id, plan, amount, status, invoice_id, created_at)` для аудита.

---

## Полезные ссылки

- Документация CloudPayments: https://developers.cloudpayments.ru/
- Виджет: https://developers.cloudpayments.ru/#widget
- API: https://developers.cloudpayments.ru/#api
- HTTP-уведомления (webhook): https://developers.cloudpayments.ru/#uvedomleniya
- Рекуррентные платежи: https://developers.cloudpayments.ru/#rekurrentnye-platezhi
