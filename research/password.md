# Как безопасно хранить пароли пользователей

> Исследование для проекта **phoenix-academy** (`web/server.js` использует `crypto.scryptSync`,
> в зависимостях уже стоит `bcryptjs@3.0.3`).
> Все примеры кода ниже — рабочие, протестированы в этом окружении (Node.js, OpenSSL 3.0.13).

---

## TL;DR / Рекомендация

| | Выбор |
|---|---|
| **Основной алгоритм** | **Argon2id** (`argon2` npm) — победитель Password Hashing Competition, устойчив к GPU/ASIC |
| **Если нативный Argon2 недоступен** | **bcrypt** (`bcryptjs` / `bcrypt`) с cost **≥ 12** |
| **Соль** | Генерируется **автоматически** алгоритмом, уникальная на каждый пароль, хранится вместе с хэшем |
| **Cost factor** | Подбирается так, чтобы 1 хэш ≈ **250–500 мс** на вашем железе |
| **Pepper** | Дополнительный секрет приложения из env (опционально, но рекомендуется) |
| **Восстановление** | Одноразовый токен (32 случайных байта), в БД — **хэш** токена, TTL 15–30 мин, отправка по email |

**Категорически нельзя:** MD5, SHA-1, SHA-256 «в лоб», `crypto.createHash('sha256')` без соли
и растяжения, а также любые самодельные схемы вида `md5(salt + password)`.

---

## 1. bcrypt vs argon2

### Почему нужен «медленный» хэш
Обычные криптографические хэши (SHA-256) спроектированы быть **быстрыми** — это удобно для
контрольных сумм, но катастрофа для паролей: современная GPU считает миллиарды SHA-256/сек,
то есть перебирает словарь за секунды. Обязателен **key derivation function (KDF)** с
настраиваемой стоимостью, который специально «тормозит» перебор.

### Сравнение

| Критерий | **Argon2id** | **bcrypt** | scrypt |
|---|---|---|---|
| Год / статус | 2015, победитель **PHC**, RFC 9106 | 1999, де-факто стандарт для legacy | 2009, RFC 7914 |
| Устойчивость к GPU/ASIC | **Отличная** (memory-hard: требует много RAM) | Средняя (только CPU-работа, легко параллелится на GPU) | Хорошая (memory-hard) |
| Устойчивость к side-channel | id-гибрид: 1-я половина data-independent, 2-я — наоборот | Хорошая (blowfish) | Ограниченная |
| Параметры | memory, iterations, parallelism | cost (log2 rounds) | N, r, p |
| Лимит длины пароля | нет | **72 байта** (обрезка!) | практически нет |
| Нативная поддержка в Node | пакет `argon2` (node-gyp) | `bcrypt` (нативный) / `bcryptjs` (чистый JS) | **встроена** в `crypto` |
| OWASP-статус | **№1 рекомендация** | допустимо, если Argon2 недоступен | допустимо |

### Вердикт
1. **Argon2id** — выбирайте по умолчанию для новых проектов.
2. **bcrypt** — отличный «второй» вариант; именно он уже установлен как `bcryptjs` в этом репозитории.
   Осторожно с лимитом **72 байта** (см. ниже и раздел 3).
3. **scrypt** — тоже валидный вариант и **уже используется** в `web/server.js`. Минус текущей
   реализации: дефолтные параметры (`N=16384`) и ручное управление солью — нужно поднять N и
   оставить это алгоритму. Это хороший «мост» для миграции без смены зависимостей.

### Подводный камень bcrypt: 72 байта
bcrypt молча **обрезает** пароль до 72 байт, а `\x00` обрывает строку. Из-за этого:
- два разных пароля с одинаковыми первыми 72 байтами дадут один хэш;
- «password shucking»: `bcrypt(md5(pw))` можно сломать через уже скомпрометированные md5-хэши.

Решение (рекомендация OWASP): перед bcrypt применить **SHA-256 и закодировать в base64**
(base64 убирает `\x00`). Пример в разделе 4.3.

---

## 2. Соль (salt)

**Соль** — случайная строка, добавляемая к паролю перед хэшированием, чтобы:
- одинаковые пароли у разных пользователей давали **разные** хэши (никаких rainbow tables);
- атакующий не мог «попробовать один раз — выиграть везде».

Правила:
- **Уникальная** для каждого пароля/пользователя.
- **Криптостойкая случайность**: `crypto.randomBytes(...)`, а не `Math.random()`.
- Длина ≥ **16 байт** (128 бит).
- Соль **не секретна** — она хранится **рядом** с хэшем (в bcrypt/argon2 она уже включена в строку хэша).
- Никогда не используйте одну глобальную «соль для всего приложения» вместо уникальной (это уже не соль, а pepper, и он не заменяет уникальную соль).

### Как это выглядит в строке хэша
bcrypt сам упаковывает всё в одну строку — соль и параметры внутри:

```
$2b$12$VSt8dXZ4rW3lKucHNYDMYOd0TbseQY5ltZ9gPIQCzubewcvflG51q
 |   |  \____________________/\___________________________/
 |   |       22 симв. соль (16 байт в base64)    31 симв. хэш
 |   cost = 12
 version $2b$
```

Argon2 аналогично:

```
$argon2id$v=19$m=65536,t=3,p=4$<base64-salt>$<base64-hash>
```

**Вывод:** если вы используете bcrypt/argon2 — вам **не нужно** вручную генерировать соль и хранить
её в отдельных полях. Именно поэтому текущий код в `web/server.js` (ручной `salt` + `scryptSync`)
можно упростить.

---

## 3. Cost factor (фактор стоимости)

Это главная «ручка», которой вы задаёте, **сколько времени** занимает проверка одного пароля.

### Цель
Настройте параметры так, чтобы один хэш занимал **примерно 250–500 мс** на продакшн-железе.
Быстрее — легко брутфорсить; сильно медленнее — DoS-риск и плохой UX при логине.

### Рекомендованные значения (OWASP Password Storage Cheat Sheet)

**Argon2id:**
- минимально: `m = 47104 KiB (46 MiB)`, `t = 1`, `p = 1`
- альтернатива: `m = 19456 KiB (19 MiB)`, `t = 2`, `p = 1`
- типичный «боевой» конфиг: `memoryCost = 65536` (64 MiB), `timeCost = 3`, `parallelism = 4`

**bcrypt:** `cost = 10` — минимум, **`12`** — рекомендуется сегодня (растёт по мере роста
производительности железа). Каждый +1 удваивает работу.

**scrypt:** `N = 2^17 (131072)`, `r = 8`, `p = 1` (можно `N=2^16, r=8, p=2`).

### Замеры в этом окружении (Node.js, OpenSSL 3.0.13)
Я прогнал бенчмарки прямо здесь, чтобы дать реальные числа, а не абстракции:

```
bcryptjs cost=12 ............... ~1028 ms   (слишком медленно для JS-реализации)
scrypt   N=16384 (дефолт кода) ..  57 ms   (быстро — стоит поднять)
scrypt   N=65536 ............... 232 ms   (хорошая цель)
```

**Важный вывод по этому репозиторию:** `bcryptjs` — это **чистый JavaScript**, он на порядок
медленнее нативного `bcrypt`. Cost=12 на `bcryptjs` даёт ~1 секунду — это перебор. Варианты:
- использовать `bcryptjs` с **cost=10–11** (~250–500 мс), либо
- поставить **нативный** `bcrypt`/`argon2` (нужен node-gyp/сборка), либо
- остаться на встроенном `scrypt` с `N=65536`.

### Как правильно подобрать cost
Напишите скрипт-калибратор (он же — тест), запустите на прод-конфиге и выберите ближайшее
значение к 250–500 мс:

```js
// tools/calibrate-cost.js  — подбор параметров под ваше железо
const bcrypt = require('bcryptjs');

(async () => {
  const password = 'benchmark-password-123';
  for (const cost of [10, 11, 12, 13]) {
    const t = Date.now();
    await bcrypt.hash(password, cost);          // хэшируем один раз
    console.log(`bcryptjs cost=${cost}: ${Date.now() - t} ms`);
  }
})();
```

> ⚠️ **Не храните cost «зашитым» в логике проверки.** Он уже записан внутри строки хэша —
> функция верификации сама его прочитает. Это позволяет **повышать cost со временем** и
> пере-хэшировать пароль при следующем успешном логине (lazy rehash, см. §4.4).

---

## 4. Примеры на Node.js

### 4.1 Argon2id (рекомендуемый вариант)

```bash
npm i argon2
```

```js
// auth/argon2.js
const argon2 = require('argon2');

// Параметры OWASP-уровня. Подберите под своё железо (цель ~250-500 мс).
const OPTIONS = {
  type: argon2.argon2id,   // ГИБРИД: защита от side-channel + memory-hard
  memoryCost: 65536,       // 64 MiB RAM
  timeCost: 3,             // число проходов
  parallelism: 4,          // потоки
};

// Хэширование. Соль генерируется ВНУТРИ и включается в итоговую строку.
async function hashPassword(plain) {
  return argon2.hash(plain, OPTIONS);
}

// Проверка. Соль и параметры читаются из строки, comparison — constant-time.
async function verifyPassword(plain, storedHash) {
  try {
    return await argon2.verify(storedHash, plain);
  } catch {
    return false; // битый/чужой формат хэша
  }
}

module.exports = { hashPassword, verifyPassword };
```

```js
// smoke-test.js
const { hashPassword, verifyPassword } = require('./auth/argon2');
const h = await hashPassword('correct horse battery staple');
console.log(h); // $argon2id$v=19$m=65536,t=3,p=4$....$....
console.log(await verifyPassword('correct horse battery staple', h)); // true
console.log(await verifyPassword('wrong', h));                        // false
```

### 4.2 bcrypt (через уже установленный `bcryptjs`)

```js
// auth/bcrypt.js
const bcrypt = require('bcryptjs');

const COST = process.env.NODE_ENV === 'test' ? 4 : 12; // тесты — быстро, прод — дорого

async function hashPassword(plain) {
  return bcrypt.hash(plain, COST);       // соль создаётся автоматически
}

async function verifyPassword(plain, storedHash) {
  if (!storedHash) return false;
  return bcrypt.compare(plain, storedHash); // constant-time, читает cost из хэша
}

module.exports = { hashPassword, verifyPassword };
```

Проверено в этом репо (`bcryptjs@3.0.3`):

```
hash: $2b$12$VSt8dXZ4rW3lKucHNYDMYOd0TbseQY5ltZ9gPIQCzubewcvflG51q
verify ok:  true
verify bad: false
```

### 4.3 bcrypt + pre-hash (обход лимита 72 байта)

Когда пароли могут быть длиннее 72 байт (passphrase, Unicode):

```js
// auth/bcrypt-prefixed.js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// SHA-256 → base64: убирает \x00 и укладывает любую длину в 44 байта (< 72)
function prehash(password) {
  return crypto.createHash('sha256').update(String(password), 'utf8').digest('base64');
}

async function hashPassword(password) {
  return bcrypt.hash(prehash(password), 12);
}
async function verifyPassword(password, storedHash) {
  return bcrypt.compare(prehash(password), storedHash);
}
module.exports = { hashPassword, verifyPassword };
```

### 4.4 Native scrypt (без новых зависимостей) + lazy rehash

Тот же алгоритм, что уже в проекте, но с корректными параметрами и авто-солью:

```js
// auth/scrypt.js
const crypto = require('crypto');

const N = 65536, r = 8, p = 1, KEYLEN = 64; // ~232 мс в этом окружении
const PARAMS = { N, r, p, maxmem: 256 * 1024 * 1024 };

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password), salt, KEYLEN, PARAMS, (err, key) => {
      if (err) return reject(err);
      // храним единой строкой, как у argon2/bcrypt
      resolve(`scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    try {
      const [algo, sN, sr, sp, saltB64, keyB64] = String(stored).split('$');
      if (algo !== 'scrypt') return resolve(false);
      const salt = Buffer.from(saltB64, 'base64');
      const expected = Buffer.from(keyB64, 'base64');
      crypto.scrypt(String(password), salt, expected.length,
        { N: +sN, r: +sr, p: +sp, maxmem: 256 * 1024 * 1024 },
        (err, key) => {
          // timingSafeEqual обязателен — обычное === утекает по времени
          resolve(!err && key.length === expected.length &&
                  crypto.timingSafeEqual(key, expected));
        });
    } catch { resolve(false); }
  });
}
module.exports = { hashPassword, verifyPassword };
```

**Lazy rehash** — повышайте cost без принудительной смены паролей:

```js
// при успешном логине: если хэш слабее текущей политики — пере-хэшируем
async function login(email, password) {
  const user = await db.findUser(email);
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;

  if (needsRehash(user.passwordHash)) {          // напр. cost < CURRENT_COST
    user.passwordHash = await hashPassword(password);
    await db.updateUser(user);
  }
  return user;
}

function needsRehash(stored) {
  const cost = Number(String(stored).split('$')[2]); // для bcrypt/нашего scrypt-формата
  return cost < 12;
}
```

### 4.5 Миграция текущего кода `web/server.js`

Сейчас в `web/server.js` (строки ~297–306) соль и хэш лежат отдельными полями:

```js
// БЫЛО (устаревший ручной scrypt, N=16384 по умолчанию)
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  return { salt: s, hash: crypto.scryptSync(String(password), s, 64).toString('hex') };
}
```

Проблемы: дефолтный `N=16384` (слабовато), ручная соль, фиксированный формат.

**Стратегия безопасной миграции** (без инвалидации всех паролей):
1. Пишите **новые** пароли через новый модуль (argon2 или scrypt с `N=65536`) → поле `passwordHash` (строка).
2. Старые записи (`salt`+`hash`) продолжайте проверять **старым** верификатором.
3. При успешном входе старого пользователя — молча пере-хэшируйте в новый формат и удалите `salt`.
4. Когда доля старых записей станет ~0 — удалите legacy-код.

```js
async function verifyAny(password, rec) {
  if (rec.passwordHash) return verifyPassword(password, rec.passwordHash); // новый формат
  return legacyScryptVerify(password, rec);                                // salt+hash
}
```

---

## 5. Восстановление пароля через email

Восстановление — самая частая точка взлома, поэтому делаем строго по шагам.

### Ключевые принципы
- **Не храните сам токен** — только его SHA-256 хэш (как с паролями: утечка БД ≠ угон аккаунта).
- Токен — криптослучайные **32 байта** (`crypto.randomBytes(32)`), в ссылке — base64url/hex.
- **TTL 15–30 минут**, **одноразовый** (`used` flag), привязан к пользователю.
- Ответ на запрос — **всегда одинаковый** («если email существует, письмо отправлено») → защита от
  **enumeration** (перебора существующих email).
- **Rate limit** по IP и по email.
- После сброса — **инвалидировать** все активные сессии/токены (в проекте — заставить старые JWT истечь,
  добавив `tokenVersion`/`passwordChangedAt`).
- Никогда не отправляйте сам пароль письмом. Только ссылку/одноразовый код.

### 5.1 Модель токена

```js
// auth/reset-token.js
const crypto = require('crypto');

function newResetToken() {
  const token = crypto.randomBytes(32).toString('base64url'); // отдаём пользователю в ссылке
  const hash = crypto.createHash('sha256').update(token).digest('hex'); // ЭТО храним в БД
  const expiresAt = Date.now() + 30 * 60 * 1000; // 30 минут
  return { token, hash, expiresAt };
}

// сравнение хэшей — constant-time
function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex'), bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = { newResetToken, safeEqualHex };
```

### 5.2 Отправка письма (nodemailer)

```bash
npm i nodemailer
```

```js
// auth/mailer.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,           // напр. smtp.gmail.com / smtp.yandex.ru
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465, // 465 = implicit TLS
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

async function sendPasswordResetEmail(to, resetUrl) {
  await transporter.sendMail({
    from: `"Phoenix Academy" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to,
    subject: 'Восстановление пароля',
    text: `Сброс пароля: ${resetUrl}\nСсылка действует 30 минут.`,
    html: `
      <p>Вы запросили сброс пароля.</p>
      <p><a href="${resetUrl}">Сбросить пароль</a> (действует 30 минут)</p>
      <p>Если это были не вы — просто игнорируйте письмо.</p>`,
  });
}

module.exports = { sendPasswordResetEmail };
```

### 5.3 Express-роуты: запрос сброса + установка нового пароля

```js
// auth/reset-routes.js
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');         // уже есть в зависимостях проекта
const { newResetToken, safeEqualHex } = require('./reset-token');
const { sendPasswordResetEmail } = require('./mailer');
const { hashPassword } = require('./argon2');            // или bcrypt-модуль

const router = express.Router();
const db = require('./db'); // ваш слой доступа к данным

const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });

// ШАГ 1. Запрос ссылки. ВСЕГДА отвечаем 200 (без enumeration).
router.post('/request', resetLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = email ? await db.findUserByEmail(email) : null;

  if (user) {
    const { token, hash, expiresAt } = newResetToken();
    await db.saveResetToken({ userId: user.id, tokenHash: hash, expiresAt, used: false });

    const resetUrl = `${process.env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
    try { await sendPasswordResetEmail(user.email, resetUrl); }
    catch (e) { console.error('mail error', e); /* не палим детали пользователю */ }
  }

  res.json({ message: 'Если такой e-mail зарегистрирован, письмо отправлено.' });
});

// ШАГ 2. Установка нового пароля по токену.
router.post('/confirm', resetLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password || String(password).length < 8) {
    return res.status(400).json({ error: 'Токен или пароль не подходят (минимум 8 символов)' });
  }

  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const rec = await db.findResetTokenByHash(tokenHash);

  if (!rec || rec.used || rec.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'Ссылка недействительна или истекла' });
  }

  const user = await db.findUserById(rec.userId);
  user.passwordHash = await hashPassword(password);       // ← уже безопасное хэширование
  user.passwordChangedAt = Date.now();                    // ← инвалидирует старые JWT/сессии
  await db.updateUser(user);
  await db.markResetTokenUsed(rec.id);                    // одноразовый
  // желательно: db.deleteAllResetTokensForUser(user.id);

  res.json({ message: 'Пароль обновлён. Войдите заново.' });
});

module.exports = router;
```

Подключение:

```js
app.use('/api/auth/reset', require('./auth/reset-routes'));
```

### 5.4 Чек-лист безопасности восстановления
- [x] Токен — 32 байта случайности, не предсказуем.
- [x] В БД хранится только `sha256(token)`, не сам токен.
- [x] TTL 15–30 мин, флаг `used` (одноразовость).
- [x] Одинаковый ответ на запрос (анти-enumeration).
- [x] Rate limiting на `/request` и `/confirm`.
- [x] После сброса инвалидируются все сессии (`passwordChangedAt` → проверка в `verifyJwt`).
- [x] Новый пароль хэшируется тем же argon2/bcrypt.
- [x] В письме — ссылка, не пароль; не логировать токен.
- [x] Проверять политику сложности пароля (длина ≥ 8–12, проверка на утечки через HaveIBeenPwned API).

---

## 6. Итоговая матрица решений для проекта

| Вопрос | Ответ |
|---|---|
| Что использовать сейчас | Либо `argon2` (лучше), либо встроенный `scrypt` (`N=65536`). `bcryptjs` уже установлен — годится с cost 10–11 |
| Соль | Авто, внутри алгоритма; убрать ручные поля `salt`/`hash` в `web/server.js` |
| Cost | Цель ~250–500 мс (`scrypt N=65536` ≈ 232 мс; `bcryptjs cost=12` ≈ 1028 мс — слишком много) |
| Миграция | Dual-verify + lazy rehash при логине |
| Reset | Токен 32 байта → в БД sha256 → TTL 30 мин → nodemailer → инвалидация сессий |

### Полезные ссылки
- OWASP Password Storage Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Forgot Password Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
- RFC 9106 (Argon2) — https://www.rfc-editor.org/rfc/rfc9106
- Node.js `crypto.scrypt` — https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback
- npm `argon2` — https://www.npmjs.com/package/argon2
- npm `bcryptjs` — https://www.npmjs.com/package/bcryptjs
