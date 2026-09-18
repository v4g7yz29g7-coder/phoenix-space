# JWT в Node.js / Express — практическое исследование и best practices

> **Проект:** Phoenix Academy (`phoenix-academy`), Node.js `v22`, Express 4, CommonJS.
> **Уже установлено:** `jsonwebtoken@9.0.3`, `cookie-parser@1.4.7`, `better-sqlite3@9.6.0`,
> `bcryptjs`, `express-rate-limit`. Примеры ниже написаны **под этот стек** (CJS + SQLite),
> а не под абстрактный Postgres/ESM.
>
> **Источники:** RFC 7519 (JWT), RFC 7515 (JWS), RFC 8725 (JWT Best Current Practices),
> RFC 6749/6819 (OAuth 2.0 и threat model), OWASP JWT Cheat Sheet и ASVS v4.0,
> документация `auth0/node-jsonwebtoken` и `panva/jose`, статьи Auth0/Panva о refresh token rotation.

---

## 0. TL;DR — что делать

| Вопрос | Рекомендация |
|---|---|
| Библиотека | `jose` — для новых проектов (ESM, Web Crypto, edge, JWKS). **В этом репо уже `jsonwebtoken@9.0.3` → оставить, но обязательно `algorithms` allowlist.** |
| Access token | Короткоживущий (5–15 мин), stateless, клиент держит **в памяти** (не `localStorage`). |
| Refresh token | Долгоживущий (7–30 дней), **rotation + reuse detection**, в БД хранится только **хеш**, доставка — в `httpOnly` cookie. |
| Хранение | refresh — `httpOnly; Secure; SameSite=Strict` cookie с узким `path`; access — либо память + `Authorization: Bearer`, либо тоже `httpOnly` cookie. |
| Алгоритм | `HS256` (монолит, один сервис) или `RS256`/`ES256` (много сервисов, JWKS). **Никогда не доверять `alg` из токена.** |
| Обязательные claims | `exp`, `iat`, `sub`, `jti`, фиксированные `iss`/`aud`, `token_type`. |
| Запрещено | `alg: none`, `localStorage` для refresh, приём токена из query-string, секреты в коде/git, дефолтные секреты. |

---

## 1. Библиотеки: `jsonwebtoken` vs `jose`

### 1.1 `jsonwebtoken` (auth0/node-jsonwebtoken)

- Самый популярный пакет для JWT в Node (десятки миллионов загрузок/неделю), простой API.
- **CommonJS-first**, построен на `node:crypto`, работает синхронно (`jwt.sign/verify`) и асинхронно (`jwt.sign/verify` с callback).
- Поддерживает `HS256/384/512`, `RS*`, `PS*`, `ES*`, но **не** работает в браузере/edge.
- История CVE (напр. CVE-2022-23529 — небезопасная обработка `secretOrPublicKey`), поэтому:
  - держите версию актуальной (`npm audit`);
  - **всегда** передавайте `algorithms: [...]` при `verify`;
  - не подставляйте в `secretOrPublicKey` данные из запроса.
- **Этот репозиторий уже использует `jsonwebtoken@9.0.3`** — оставаться на нём нормально для монолита.

```bash
npm i jsonwebtoken          # уже стоит (^9.0.3)
npm i -D @types/jsonwebtoken
```

### 1.2 `jose` (panva/jose)

- Современная библиотека, строго по стандартам, **ESM + CJS**, async API на Web Crypto API.
- Работает в Node, браузере, Deno, Bun, Cloudflare Workers, Vercel/Netlify Edge.
- Полноценные JWK / JWKS (`createRemoteJWKSet`), JWS и **JWE** (шифрование, а не только подпись).
- Активно поддерживается, минимальная поверхность CVE.
- **Рекомендуется для новых проектов** и для сценария «access токен подписывает IdP по RS256, мы проверяем через JWKS».

```bash
npm i jose
```

### 1.3 Сравнение

| Критерий | `jsonwebtoken` | `jose` |
|---|---|---|
| API | sync + async (callback) | async (Promise) |
| Модули | CJS | ESM + CJS |
| Браузер / Edge | ❌ | ✅ |
| Крипто-бэкенд | `node:crypto` | Web Crypto API |
| JWK / JWKS | ограниченно | полноценно |
| JWE (шифрование) | ❌ | ✅ (`CompactEncrypt`, `jwtDecrypt`) |
| Поддержка | стабильная, maintenance | активная |
| Вывод | legacy / монолит | новые проекты, микросервисы |

**Решение для Phoenix:** оставить `jsonwebtoken` (минимум изменений, монолит), но:
1. ввести allowlist алгоритмов;
2. рассмотреть миграцию на `jose` только если появится RS256/JWKS или edge-рантайм.

---

## 2. Структура токена

JWT — это три base64url-сегмента, соединённые точками:

```
base64url(header) . base64url(payload) . base64url(signature)
```

### 2.1 Header

```json
{ "alg": "HS256", "typ": "JWT", "kid": "2024-06-key-1" }
```

`kid` (key id) нужен при ротации ключей: по нему выбирается нужный публичный/секретный ключ.

### 2.2 Payload (claims)

Стандартные (registered) claims:

| claim | смысл | обязателен |
|---|---|---|
| `iss` | issuer — кто выдал | да (проверяем) |
| `sub` | subject — чей токен (id пользователя) | да |
| `aud` | audience — для кого | да (проверяем) |
| `exp` | expiration time (Unix seconds) | **да** |
| `nbf` | not before | рекомендуется |
| `iat` | issued at | да |
| `jti` | уникальный id токена (для отзыва/дедупликации) | да |

Пользовательские (private) claims — держите минимальными:

```json
{
  "sub": "42",
  "iss": "phoenix-academy",
  "aud": "phoenix-web",
  "iat": 1718000000,
  "exp": 1718000900,
  "jti": "b1f9c8e2-...-uuid",
  "role": "user",
  "token_type": "access"
}
```

**Правила:**
- Payload **только подписан, но не зашифрован** — любой может прочитать base64. **Не кладите туда PII, пароли, секреты, номера карт.** Для конфиденциальности нужен JWE.
- Держите access-токен маленьким: чем больше claims, тем больше заголовок и нагрузка на сеть.
- `token_type` (`access`/`refresh`) защищает от подстановки refresh-токена вместо access (и наоборот).
- Разные секреты для access и refresh — обязательное правило (компрометация одного не ломает другой).

### 2.3 Signature

```
HMACSHA256(base64url(header) + "." + base64url(payload), secret)
```

Для `HS256` секрет должен быть **случайным ≥ 32 байт** (`openssl rand -hex 32`). Для `RS256`/`ES256` приватный ключ подписывает, публичный — проверяет (клиенты и другие сервисы получают только публичный ключ).

### 2.4 Создание/проверка — `jsonwebtoken` (вариант этого репо)

```js
// src/auth/tokens.js (фрагмент)
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const ISSUER = process.env.JWT_ISSUER || 'phoenix-academy';
const AUDIENCE = process.env.JWT_AUDIENCE || 'phoenix-web';

function issueAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role || 'user', token_type: 'access' },
    ACCESS_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: '15m',
      issuer: ISSUER,
      audience: AUDIENCE,
      jwtid: crypto.randomUUID(),          // jti
    }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET, {
    algorithms: ['HS256'],                 // ← allowlist: обязательно!
    issuer: ISSUER,
    audience: AUDIENCE,
    clockTolerance: 5,                     // секунд, на рассинхрон часов
  });
}
```

### 2.5 Создание/проверка — `jose` (для сравнения)

```js
const { SignJWT, jwtVerify } = require('jose');

const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);

async function signAccessToken(user) {
  return await new SignJWT({ role: user.role, token_type: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(user.id))
    .setJti(crypto.randomUUID())
    .setIssuer('phoenix-academy')
    .setAudience('phoenix-web')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
    issuer: 'phoenix-academy',
    audience: 'phoenix-web',
  });
  return payload;
}
```

### 2.6 Декодирование без проверки (для отладки)

```js
// НИКОГДА не используйте decode для авторизации — подпись не проверяется!
const parts = token.split('.');
console.log(JSON.parse(Buffer.from(parts[0], 'base64url').toString())); // header
console.log(JSON.parse(Buffer.from(parts[1], 'base64url').toString())); // payload
```

---

## 3. Refresh tokens (rotation + reuse detection)

### 3.1 Зачем

- Access-токен нельзя отозвать мгновенно (он stateless). Поэтому делают его **коротким** (5–15 мин): если украдут — окно атаки мало.
- Чтобы не заставлять пользователя логиниться каждые 15 минут, вводят **refresh-токен**: долгоживущий, но **stateful** (хранится в БД, можно отозвать).

### 3.2 Схема ротации и обнаружения повторного использования

```text
login        → access(15m)  +  refresh#1 (7d, family=F)
refresh #1   → помечаем refresh#1 revoked, выдаём access + refresh#2 (family=F)
refresh #2   → помечаем refresh#2 revoked, выдаём access + refresh#3 (family=F)
...
Атака/утечка: предъявлен уже revoked refresh#1
             → это reuse! Отзываем ВСЮ семью F → жертву разлогинивает везде.
```

**Ключевые правила:**
1. Refresh-токен одноразовый: при каждом использовании — новый, старый инвалидируется.
2. Повторное предъявление старого токена = признак кражи → отзыв всей «семьи» (family) токенов пользователя.
3. В БД хранится **только хеш** токена (SHA-256), не сам токен.
4. Refresh-токен можно делать просто случайной строкой (`crypto.randomBytes(48)`), а не JWT — JWT тут не обязателен. Vanilla-random + hash в БД даже надёжнее. В этом репо используем JWT ради `family_id`/`jti` в самом токене.
5. Ротацию лучше выполнять в транзакции (в SQLite — `db.transaction`).

### 3.3 Схема таблицы (SQLite — под `better-sqlite3` этого репо)

```sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
  jti         TEXT PRIMARY KEY,     -- jti токена (uuid)
  user_id     INTEGER NOT NULL,
  family_id   TEXT NOT NULL,        -- цепочка ротаций
  token_hash  TEXT NOT NULL,        -- sha256(raw token) — только хеш!
  user_agent  TEXT,                 -- для аудита/привязки к устройству
  ip          TEXT,
  created_at  INTEGER NOT NULL,     -- ms epoch
  expires_at  INTEGER NOT NULL,     -- ms epoch
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rt_hash   ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_rt_user   ON refresh_tokens(user_id);
```

> В Postgres было бы `UUID/BOOLEAN/TIMESTAMPTZ`, но проект на SQLite, поэтому `TEXT/INTEGER` и ms-epoch (совпадает со стилем `User.js`).

### 3.4 Сервис токенов (`src/auth/tokens.js`, целиком)

```js
// src/auth/tokens.js
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const ACCESS_SECRET  = process.env.JWT_ACCESS_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
if (!ACCESS_SECRET || !REFRESH_SECRET) {
  console.error('❌ JWT_ACCESS_SECRET / JWT_REFRESH_SECRET не заданы в .env!');
  console.error('   Сгенерируйте: openssl rand -hex 32');
  process.exit(1);
}

const ISSUER   = process.env.JWT_ISSUER   || 'phoenix-academy';
const AUDIENCE = process.env.JWT_AUDIENCE || 'phoenix-web';
const ACCESS_TTL  = '15m';
const REFRESH_TTL = '7d';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function issueAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role || 'user', token_type: 'access' },
    ACCESS_SECRET,
    { algorithm: 'HS256', expiresIn: ACCESS_TTL, issuer: ISSUER, audience: AUDIENCE, jwtid: crypto.randomUUID() }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET, {
    algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, clockTolerance: 5,
  });
}

/** Выпускает пару access+refresh. familyId сохраняется при ротации. */
function issueTokens(user, { familyId } = {}) {
  const family = familyId || crypto.randomUUID();
  const refreshJti = crypto.randomUUID();
  const access = issueAccessToken(user);
  const refresh = jwt.sign(
    { sub: String(user.id), family_id: family, token_type: 'refresh' },
    REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: REFRESH_TTL, issuer: ISSUER, audience: AUDIENCE, jwtid: refreshJti }
  );
  return { access, refresh, refreshJti, familyId: family, refreshHash: sha256(refresh) };
}

function verifyRefreshToken(token) {
  const payload = jwt.verify(token, REFRESH_SECRET, {
    algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, clockTolerance: 5,
  });
  if (payload.token_type !== 'refresh') throw new Error('Wrong token type');
  return payload;
}

module.exports = { issueAccessToken, verifyAccessToken, issueTokens, verifyRefreshToken, sha256 };
```

### 3.5 Модель БД (`src/models/RefreshToken.js`)

```js
// src/models/RefreshToken.js
const db = require('../config/db');

db.exec(`
  CREATE TABLE IF NOT EXISTS refresh_tokens (
    jti TEXT PRIMARY KEY, user_id INTEGER NOT NULL, family_id TEXT NOT NULL,
    token_hash TEXT NOT NULL, user_agent TEXT, ip TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_rt_hash   ON refresh_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family_id);
  CREATE INDEX IF NOT EXISTS idx_rt_user   ON refresh_tokens(user_id);
`);

const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = {
  create({ jti, userId, familyId, tokenHash, userAgent, ip }) {
    const now = Date.now();
    db.prepare(`
      INSERT INTO refresh_tokens
        (jti, user_id, family_id, token_hash, user_agent, ip, created_at, expires_at, revoked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(jti, userId, familyId, tokenHash, userAgent || null, ip || null, now, now + REFRESH_TTL_MS);
  },
  findByJti: (jti) => db.prepare('SELECT * FROM refresh_tokens WHERE jti = ?').get(jti),
  findAliveByFamily: (familyId) => db.prepare(
    'SELECT 1 FROM refresh_tokens WHERE family_id = ? AND revoked = 0 AND expires_at > ? LIMIT 1'
  ).get(familyId, Date.now()),
  revoke:  (jti) => db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE jti = ?').run(jti),
  revokeFamily: (familyId) => db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE family_id = ?').run(familyId),
  revokeAllForUser: (userId) => db.prepare('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?').run(userId),
  // чистка просроченных (вызывать по cron)
  purgeExpired: () => db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(Date.now()),
};
```

---

## 4. Безопасность

### 4.1 Где хранить токены на клиенте

| Хранилище | XSS-риск | CSRF-риск | Комментарий |
|---|---|---|---|
| `localStorage` / `sessionStorage` | **высокий** (любой JS читает) | отсутствует | ❌ для refresh. Для access — допустимо, но не идеально. |
| Обычная (не-httpOnly) cookie | средний | **высокий** | ❌ |
| `httpOnly` cookie | **нет** (JS не читает) | да → нужен CSRF-токен | ✅ для refresh (и можно для access) |
| Память JS (переменная) | нет после перезагрузки | нет | ✅ для access |

**Рекомендуемый гибрид:**
- `refresh_token` → `httpOnly` cookie (недоступен для JS, живёт между перезагрузками).
- `access_token` → в памяти JS + заголовок `Authorization: Bearer` (или тоже httpOnly cookie, если проще).

### 4.2 Флаги cookie

| Флаг | Значение | Зачем |
|---|---|---|
| `httpOnly` | `true` | JS (`document.cookie`) не может прочитать → защита от XSS-кражи |
| `secure` | `true` в prod | cookie только по HTTPS |
| `sameSite` | `'strict'` (или `'lax'` при OAuth-редиректах) | защита от CSRF |
| `path` | `/api/auth` для refresh | cookie не улетает на каждый запрос |
| `maxAge` | совпадает с TTL токена | срок жизни cookie |
| `domain` | не задавать шире необходимого | не отдавать cookie поддомену |

```js
// src/auth/cookies.js
const isProd = process.env.NODE_ENV === 'production';

const BASE = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'strict',
};

const ACCESS_COOKIE  = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

function setAuthCookies(res, { access, refresh }) {
  res.cookie(ACCESS_COOKIE, access, { ...BASE, maxAge: 15 * 60 * 1000, path: '/' });
  // refresh ограничен путём /api/auth — не отправляется на остальные запросы
  res.cookie(REFRESH_COOKIE, refresh, { ...BASE, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/api/auth' });
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE,  { path: '/' });
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
}

module.exports = { setAuthCookies, clearAuthCookies, ACCESS_COOKIE, REFRESH_COOKIE };
```

### 4.3 CSRF (обязательно при cookie-аутентификации)

Cookie отправляются браузером автоматически → злоумышленник может инициировать запрос от имени жертвы. `SameSite` покрывает большинство сценариев, но для мутирующих методов добавьте **double-submit CSRF token**:

```js
// при логине: кладём читаемую (не httpOnly) cookie + отдаём токен в ответе
res.cookie('csrf_token', crypto.randomUUID(), {
  httpOnly: false, secure: isProd, sameSite: 'strict', path: '/',
});

// middleware для POST/PUT/PATCH/DELETE
function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || cookieToken !== headerToken) {
    return res.status(403).json({ success: false, error: 'CSRF token mismatch' });
  }
  next();
}
```

> Альтернатива: библиотека `csurf` устарела, лучше ручной double-submit или `csrf-csrf`.

### 4.4 Классические атаки на JWT и защита

| Атака | Суть | Защита |
|---|---|---|
| `alg: none` | атакующий ставит `alg:none` и пустую подпись | **всегда** `algorithms: ['HS256']` при verify |
| Algorithm confusion | `HS256` проверяют публичным RSA-ключом | фиксировать алгоритм, не выводить его из header |
| Слабый секрет | брутфорс HMAC-секрета | секрет ≥ 32 случайных байта; ротация |
| Replay / кража | токен украден и переиспользован | короткий TTL, `jti` + денилист, rotation + reuse detection |
| XSS-кража | токен читается из `localStorage` | `httpOnly` cookie |
| CSRF | cookie шлётся автоматически | `SameSite` + CSRF-токен |
| Токен в URL | попадает в логи/referer/историю | только заголовок `Authorization` или cookie |
| Утечка через claims | PII видна всем | не класть секреты; при нужде — JWE |
| Подмена refresh↔access | один токен вместо другого | claim `token_type` + разные секреты |

### 4.5 Секреты

```bash
# .env — НИКОГДА не коммитить (уже в .gitignore)
JWT_ACCESS_SECRET=$(openssl rand -hex 32)
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
JWT_ISSUER=phoenix-academy
JWT_AUDIENCE=phoenix-web
```

- Разные секреты для access и refresh; разные для dev/staging/prod.
- В продакшене — секрет-менеджер (Vault, AWS Secrets Manager, Doppler), не `.env` на диске.
- Компрометация секрета = мгновенная ротация + отзыв токенов (`jti`/family).
- Пароли — только `bcrypt`/`argon2` (в репо уже `bcryptjs`, `genSalt(10)`).

### 4.6 Прочее

- **HTTPS + HSTS** обязательно (`helmet` + `Strict-Transport-Security`).
- **Rate limiting** на `/login`, `/register`, `/refresh` (в репо уже `authLimiter`).
- **Логирание** — в БД храним `ip`/`user_agent` refresh-токена (в `RefreshToken` уже есть).
- Единый формат ошибок: не раскрывать, существует ли email.
- Тайминг-атаки: сравнивать хеши через `crypto.timingSafeEqual`.
- `clockTolerance` маленький (5 сек), чтобы не ловить рассинхрон часов.
- Не логировать сами токены и заголовок `Authorization`.

---

## 5. Примеры кода — полный Express-стек под этот репозиторий

### 5.1 `.env` (добавить к `.env.example`)

```env
JWT_ACCESS_SECRET=replace-with-openssl-rand-hex-32
JWT_REFRESH_SECRET=replace-with-openssl-rand-hex-32
JWT_ISSUER=phoenix-academy
JWT_AUDIENCE=phoenix-web
```

### 5.2 `src/middleware/auth.js` — защита маршрутов (cookie + Bearer)

```js
// src/middleware/auth.js
const { verifyAccessToken } = require('../auth/tokens');

module.exports = function auth(req, res, next) {
  // 1) httpOnly cookie (веб), 2) fallback Bearer (мобильные/внешние API)
  let token = req.cookies?.access_token;
  if (!token) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) token = header.slice(7);
  }
  if (!token) return res.status(401).json({ success: false, error: 'Требуется авторизация' });

  try {
    const decoded = verifyAccessToken(token);
    req.user = { id: Number(decoded.sub), role: decoded.role, jti: decoded.jti };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, error: 'Токен истёк', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ success: false, error: 'Невалидный токен' });
  }
};
```

### 5.3 `src/routes/auth.js` — register / login / refresh / logout

```js
// src/routes/auth.js
const express = require('express');
const bcrypt = require('bcryptjs');
const { authLimiter } = require('../middleware/rateLimiter');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');
const { issueTokens, verifyRefreshToken, sha256 } = require('../auth/tokens');
const { setAuthCookies, clearAuthCookies } = require('../auth/cookies');

const router = express.Router();

// --- Регистрация ---
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'Все поля обязательны' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ success: false, error: 'Пароль минимум 8 символов' });
    }
    if (User.findByEmail(email)) {
      return res.status(409).json({ success: false, error: 'Пользователь уже существует' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = User.create(username, email, passwordHash);
    const user = { id: Number(result.lastInsertRowid), username, email, role: 'user' };

    const t = issueTokens(user);
    RefreshToken.create({
      jti: t.refreshJti, userId: user.id, familyId: t.familyId,
      tokenHash: t.refreshHash, userAgent: req.get('user-agent'), ip: req.ip,
    });
    setAuthCookies(res, t);
    res.status(201).json({ success: true, user: { id: user.id, username, email } }); // токенов в теле нет!
  } catch (err) {
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// --- Вход ---
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email и пароль обязательны' });
    }
    const user = User.findByEmail(email);
    if (!user) return res.status(401).json({ success: false, error: 'Неверные учётные данные' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ success: false, error: 'Неверные учётные данные' });

    const t = issueTokens(user);
    RefreshToken.create({
      jti: t.refreshJti, userId: user.id, familyId: t.familyId,
      tokenHash: t.refreshHash, userAgent: req.get('user-agent'), ip: req.ip,
    });
    setAuthCookies(res, t);
    res.json({ success: true, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Ошибка сервера' });
  }
});

// --- Обновление (ротация + reuse detection) ---
router.post('/refresh', authLimiter, (req, res) => {
  const token = req.cookies?.refresh_token;
  if (!token) return res.status(401).json({ success: false, error: 'Нет refresh-токена' });

  let payload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    clearAuthCookies(res);
    return res.status(401).json({ success: false, error: 'Невалидный refresh-токен' });
  }

  const stored = RefreshToken.findByJti(payload.jti);

  // Токен не найден, но семейство живо → этот токен уже был использован/отозван => REUSE!
  if (!stored) {
    if (RefreshToken.findAliveByFamily(payload.family_id)) {
      RefreshToken.revokeFamily(payload.family_id);   // отзываем всю семью
    }
    clearAuthCookies(res);
    return res.status(401).json({ success: false, error: 'Refresh-токен отозван' });
  }

  // Дополнительно сверяем хеш и срок
  if (
    stored.token_hash !== sha256(token) ||
    stored.revoked ||
    stored.expires_at < Date.now()
  ) {
    RefreshToken.revokeFamily(payload.family_id);
    clearAuthCookies(res);
    return res.status(401).json({ success: false, error: 'Refresh-токен отозван' });
  }

  const user = User.findById(stored.user_id);
  if (!user) {
    clearAuthCookies(res);
    return res.status(401).json({ success: false, error: 'Пользователь не найден' });
  }

  // Ротация: старый отзываем, выдаём новую пару в том же family
  RefreshToken.revoke(stored.jti);
  const t = issueTokens(user, { familyId: stored.family_id });
  RefreshToken.create({
    jti: t.refreshJti, userId: user.id, familyId: t.familyId,
    tokenHash: t.refreshHash, userAgent: req.get('user-agent'), ip: req.ip,
  });
  setAuthCookies(res, t);
  res.json({ success: true });
});

// --- Выход ---
router.post('/logout', (req, res) => {
  const token = req.cookies?.refresh_token;
  if (token) {
    try {
      const p = verifyRefreshToken(token);
      RefreshToken.revoke(p.jti);
    } catch { /* игнорируем */ }
  }
  clearAuthCookies(res);
  res.json({ success: true });
});

module.exports = router;
```

### 5.4 `server.js` — подключение

```js
const cookieParser = require('cookie-parser');
// ...
app.use(cookieParser());
app.use('/api/auth', require('./src/routes/auth'));
// если фронт с другого origin и cookie нужны:
// app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
```

### 5.5 Клиент (`fetch`) — cookie + авто-refresh + CSRF

```js
// credentials: 'include' обязателен, иначе браузер не пошлёт httpOnly cookie
async function api(path, options = {}, _retried = false) {
  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': getCookie('csrf_token'),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && !_retried) {
    const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (r.ok) return api(path, options, true); // один повтор после refresh
  }
  return res;
}

const getCookie = (name) =>
  document.cookie.split('; ').find((c) => c.startsWith(name + '='))?.split('=')[1];
```

### 5.6 Вариант `jose` + RS256/JWKS (для микросервисов и внешнего IdP)

```js
// npm i jose
const { SignJWT, jwtVerify, importPKCS8, importSPKI, createRemoteJWKSet } = require('jose');

// Симметрично (HMAC):
const secret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET);

async function signAccess(user) {
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuer('phoenix-academy').setAudience('phoenix-web')
    .setJti(crypto.randomUUID()).setIssuedAt().setExpirationTime('15m')
    .sign(secret);
}

// Асимметрично (RS256) с внешним IdP через JWKS:
// const JWKS = createRemoteJWKSet(new URL('https://idp.example.com/.well-known/jwks.json'));
// const { payload } = await jwtVerify(token, JWKS, {
//   issuer: 'https://idp.example.com', audience: 'phoenix-web',
// });
```

### 5.7 Тест (Jest / supertest) — фиксируем инварианты безопасности

```js
const request = require('supertest');
const app = require('../server');

test('login sets httpOnly cookies and returns NO token in body', async () => {
  const res = await request(app).post('/api/auth/login')
    .send({ email: 'u@example.com', password: 'correct horse battery staple' });
  expect(res.status).toBe(200);
  expect(res.body.token).toBeUndefined();
  const cookies = res.headers['set-cookie'].join(';');
  expect(cookies).toMatch(/access_token=.*HttpOnly/);
  expect(cookies).toMatch(/refresh_token=.*HttpOnly/);
});

test('refresh rotates; reuse of old refresh revokes the family', async () => {
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'u@example.com', password: 'correct horse battery staple' });
  const refreshCookie = login.headers['set-cookie'].find((c) => c.startsWith('refresh_token='));

  const r1 = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);
  expect(r1.status).toBe(200);

  // повторное использование старого refresh → 401 (reuse detection)
  const r2 = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);
  expect(r2.status).toBe(401);
});
```

---

## 6. Миграция текущего кода репозитория

Что найдено в коде и что нужно изменить:

| Место | Сейчас | Нужно |
|---|---|---|
| `src/routes/auth.js` | `jwt.sign({id, username}, JWT_SECRET, {expiresIn:'7d'})` — один долгий токен | `issueTokens()`: короткий access + refresh; refresh в БД |
| `src/routes/auth.js` | токен возвращается в JSON-теле (`token`) | убрать из тела → `httpOnly` cookie |
| `src/middleware/auth.js` | `jwt.verify(token, JWT_SECRET)` без `algorithms` | добавить `algorithms:['HS256'], issuer, audience` + поддержку cookie |
| `.env` | только `JWT_SECRET` | `JWT_ACCESS_SECRET` + `JWT_REFRESH_SECRET` |
| БД | нет таблицы refresh | добавить `refresh_tokens` (+ индексы) |
| Роуты | нет `/auth/refresh`, `/auth/logout` | добавить (ротация + reuse detection) |
| CSRF | отсутствует | double-submit токен + middleware на мутирующие методы |
| Нет endpoint-отзыва | logout только на клиенте | серверный `revoke` + `revokeAllForUser` |

**Пошагово:**
1. Сгенерировать секреты, обновить `.env`/`.env.example`.
2. Добавить `src/auth/tokens.js`, `src/auth/cookies.js`, `src/models/RefreshToken.js`.
3. Заменить выдачу токенов в `register`/`login`; добавить `refresh`/`logout`.
4. Обновить `src/middleware/auth.js` (cookie + Bearer, allowlist).
5. Подключить `cookieParser()` и роуты в `server.js`.
6. Добавить CSRF-токен и его проверку.
7. Покрыть тестами (инварианты: нет токена в теле, reuse → 401).

> ⚠️ Существующие access-токены (`7d`, один секрет) станут недействительны после смены схемы — это ожидаемо, пользователи перелогинятся.

---

## 7. Чек-лист безопасности

- [ ] `jose` предпочтительно; если `jsonwebtoken` — `algorithms` allowlist при каждом `verify`.
- [ ] Разные секреты ≥ 32 байт для access и refresh; секреты в ENV/секрет-менеджере, не в git.
- [ ] `iss`/`aud` фиксированы и проверяются; `exp`, `iat`, `sub`, `jti` присутствуют.
- [ ] Access TTL 5–15 мин, refresh TTL 7–30 дней.
- [ ] Refresh: rotation + reuse detection, в БД только хеш, ротация в транзакции.
- [ ] Refresh — `httpOnly; Secure; SameSite=Strict` cookie с узким `path`.
- [ ] Access — в памяти клиента, не в `localStorage`.
- [ ] CSRF-защита (double-submit) при cookie-аутентификации.
- [ ] `helmet`, HTTPS, HSTS включены.
- [ ] Rate limiting на `/login`, `/register`, `/refresh` (`authLimiter`).
- [ ] Логирование `ip`/`user_agent`; возможность отзыва по `jti`/family.
- [ ] `npm audit` в CI; зависимости обновляются.
- [ ] Пароли — `bcrypt`/`argon2`, cost ≥ 10 (лучше 12).
- [ ] Никогда не принимать токен из query-string; не логировать токены.

---

## 8. Источники

- RFC 7519 — JSON Web Token (JWT): https://datatracker.ietf.org/doc/html/rfc7519
- RFC 7515 — JSON Web Signature (JWS): https://datatracker.ietf.org/doc/html/rfc7515
- RFC 8725 — JWT Best Current Practices: https://datatracker.ietf.org/doc/html/rfc8725
- RFC 6749 / RFC 6819 — OAuth 2.0 и Threat Model
- OWASP JWT Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html
- OWASP ASVS v4.0: https://owasp.org/www-project-application-security-verification-standard/
- auth0/node-jsonwebtoken (GitHub): https://github.com/auth0/node-jsonwebtoken
- panva/jose (GitHub): https://github.com/panva/jose
- Auth0 — Refresh Token Rotation: https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation
- expressjs/cookie-parser: https://github.com/expressjs/cookie-parser

---

_Документ подготовлен для проекта Phoenix Academy; примеры проверены на Node v22, `jsonwebtoken@9.0.3`, `better-sqlite3@9.6.0` (см. также `research/audit.md`)._
