# Чтение почты через IMAP в Node.js

Практическое руководство: библиотеки, подключение к Gmail/Yandex, парсинг писем,
поиск паролей и ссылок, готовые примеры кода.

---

## 0. TL;DR — что выбрать

| Задача | Библиотека | Почему |
|---|---|---|
| Просто и надёжно, современный API, Promise/async | **`imapflow`** ✅ рекомендуется | Живой проект, async/await, авто-разбор структуры письма, IDLE, OAuth2 «из коробки» |
| Классика, много примеров в интернете, callback-стиль | `imap` (node-imap) | Старый, но стабильный; много легаси-кода |
| Разбор MIME/тела/вложений | **`mailparser`** | Де-факто стандарт парсинга RFC822 |
| Альтернатива парсеру | `emailjs-mime-parser`, `postal-mime` | postal-mime — лёгкий, современный, ESM |

Рекомендуемый стек: **`imapflow` + `mailparser`** (или `imap` + `mailparser` для легаси).

```bash
npm init -y
npm install imapflow mailparser
# легаси-вариант:
npm install imap mailparser
# для OAuth2 (Gmail):
npm install googleapis
```

Node.js >= 18 (есть нативный fetch и стабильный ESM).

---

## 1. Библиотеки

### 1.1 `imapflow`
- Репозиторий: https://github.com/postalsys/imapflow
- Плюсы: async/await, поддержка IDLE (push-уведомления о новых письмах),
  OAuth2, управление флагами, работа с несколькими ящиками, TLS по умолчанию.
- Минус: требует Node >= 16 (лучше 18+).

```js
import { ImapFlow } from 'imapflow';
```

### 1.2 `imap` (node-imap)
- Репозиторий: https://github.com/mscdex/node-imap
- Callback/событийная модель: `imap.once('ready', ...)`, `imap.on('mail', ...)`.
- Используется во множестве старых гайдов; обёртки — `emailjs-imap-client`.

```js
import Imap from 'imap';        // CJS
const Imap = require('imap');   // либо так
```

### 1.3 `mailparser`
- Репозиторий: https://github.com/nodemailer/mailparser
- Вход: `Buffer`/stream исходного письма (RFC822). Выход: объект с
  `subject`, `from`, `to`, `date`, `text`, `html`, `attachments`.

```js
import { simpleParser } from 'mailparser';
const parsed = await simpleParser(rawMessageBuffer);
```

---

## 2. Подключение к Gmail / Yandex

### 2.1 Общие параметры серверов

| Провайдер | IMAP host | Port (SSL) | Port (STARTTLS) |
|---|---|---|---|
| Gmail | `imap.gmail.com` | 993 | 143 |
| Yandex | `imap.yandex.ru` | 993 | 143 |
| Mail.ru | `imap.mail.ru` | 993 | 143 |
| Outlook/Hotmail | `outlook.office365.com` | 993 | 143 |

### 2.2 Gmail — важные нюансы

1. **Пароль от аккаунта НЕ подходит.** Нужен один из вариантов:
   - **App Password** (пароль приложения): включить 2FA →
     https://myaccount.google.com/apppasswords → создать пароль для «Mail».
     16 символов вида `abcd efgh ijkl mnop` (пробелы можно убрать).
   - **OAuth2** (для продакшена / Google Workspace).
2. IMAP должен быть включён: Gmail → Настройки → «Пересылка и POP/IMAP» →
   «Включить IMAP».
3. Google может отклонить вход из «небезопасного» региона — тогда нужен
   OAuth2 или прокси.

**App Password (просто):**

```js
const client = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER,          // you@gmail.com
    pass: process.env.GMAIL_APP_PASSWORD,  // 16-символьный app password
  },
  logger: false,
});
```

### 2.3 Yandex — важные нюансы

1. Нужно **включить IMAP в веб-интерфейсе**: Яндекс.Почта → Настройки →
   «Почтовые программы» → включить «С сервера imap.yandex.ru по протоколу IMAP».
2. Пароль: либо пароль от аккаунта, либо **пароль приложения**
   (https://id.yandex.ru/security/app-passwords), если включена 2FA.
   Вид: `abcdefghijklmnop` (16 символов, генерируется приложением).
3. Возможна блокировка по подозрительной активности — используйте
   пароль приложения.

```js
const client = new ImapFlow({
  host: 'imap.yandex.ru',
  port: 993,
  secure: true,
  auth: {
    user: 'you@yandex.ru',
    pass: process.env.YANDEX_APP_PASSWORD,
  },
});
```

### 2.4 OAuth2 для Gmail (XOAUTH2)

Токен получаем через `googleapis` + refresh_token. `imapflow` умеет:

```js
import { ImapFlow } from 'imapflow';
import { google } from 'googleapis';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'https://developers.google.com/oauthplayground' // redirect
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const { token } = await oauth2Client.getAccessToken();

const client = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: {
    user: 'you@gmail.com',
    accessToken: token,        // imapflow сам сделает XOAUTH2
  },
});
```

Scope для Gmail: `https://mail.google.com/`.

---

## 3. Подключение и базовые операции (imapflow)

### 3.1 Connect / lock / list

```js
import { ImapFlow } from 'imapflow';

const client = new ImapFlow({
  host: 'imap.yandex.ru',
  port: 993,
  secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
  logger: false,
});

await client.connect();
console.log('Connected');

// список папок
for (const box of await client.list()) {
  console.log(box.path, box.specialUse || '');
}

// открыть INBOX (readOnly: true — не ставит \Seen)
const lock = await client.getMailboxLock('INBOX');
try {
  console.log('Messages:', client.mailbox.exists);
} finally {
  lock.release();
}

await client.logout();
```

### 3.2 Чтение последнего письма

```js
const lock = await client.getMailboxLock('INBOX');
try {
  // UID последнего письма
  const lastUid = client.mailbox.uidNext - 1;

  for await (const msg of client.fetch(`${lastUid}`, {
    source: true,      // полное письмо (RFC822) для mailparser
    envelope: true,
  })) {
    const parsed = await simpleParser(msg.source);
    console.log('From:', parsed.from?.text);
    console.log('Subject:', parsed.subject);
    console.log('Text:', parsed.text?.slice(0, 200));
  }
} finally {
  lock.release();
}
```

### 3.3 Поиск писем (search)

```js
// письма за последние 7 дней
const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
const uids = await client.search({ since });

// письма от конкретного адреса с непрочитанными
const uids2 = await client.search({ from: 'noreply@github.com', unseen: true });

// по теме (substring, регистронезависимо на большинстве серверов)
const uids3 = await client.search({ subject: 'пароль' });

console.log('Found:', uids3.length);
```

Синтаксис поиска (`SearchObject`): `seen`, `unseen`, `answered`, `flagged`,
`from`, `to`, `cc`, `bcc`, `subject`, `body`, `text`, `since`, `before`,
`on`, `larger`, `smaller`, `uid`, `header`.

### 3.4 Скачивание вложений

```js
const parsed = await simpleParser(msg.source);
for (const att of parsed.attachments) {
  console.log(att.filename, att.contentType, att.size);
  // fs.writeFileSync(`/tmp/${att.filename}`, att.content);
}
```

---

## 4. Парсинг писем (mailparser)

`simpleParser` принимает `Buffer`, строку или stream. Разбирает MIME,
декодирует base64/quoted-printable, склеивает multipart.

```js
import { simpleParser } from 'mailparser';

const parsed = await simpleParser(rawSource);
/*
parsed = {
  from: { value: [{address, name}], text: 'Name <a@b.c>' },
  to, cc, bcc,
  subject: string,
  date: Date,
  messageId, inReplyTo, references,
  text: string,          // plain text
  textAsHtml: string,
  html: string | false,  // HTML
  attachments: [{ filename, content: Buffer, contentType, size, cid }],
  headers: Map,
}
*/
```

Полезные поля:
- `parsed.from.value[0].address` — чистый e-mail отправителя.
- `parsed.html` — HTML-версия (нужно чистить от тегов, см. ниже).
- `parsed.headers.get('received')` — заголовки, иногда содержат IP.

### 4.1 Конвертация HTML → текст

```js
function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')          // остальные теги
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const body = parsed.text || htmlToText(parsed.html || '');
```

---

## 5. Поиск паролей и ссылок в письмах

Типовая задача: «пришло письмо о регистрации/сбросе пароля — вытащить
ссылку и/или код подтверждения».

### 5.1 Регулярки

```js
// URL (http/https) — аккуратный вариант
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

// Код подтверждения: 4–8 цифр
const CODE_RE = /\b\d{4,8}\b/g;

// Пароль: "пароль: XXXX", "password: XXXX", "Password - XXXX"
const PASS_RE = /(?:partol|password|pass|пароль|код)\s*[:\-–]\s*([^\s<>\n]{6,64})/gi;

// Пароль в HTML-письме, часто внутри <b> или <td>
const PASS_HTML_RE = /(?:pass|password|пароль)\D{0,20}([A-Za-z0-9!@#$%^&*._-]{6,64})/gi;

// OTP/код из текста
const OTP_RE = /(?:код|code|otp)\D{0,20}(\d{4,8})/gi;

function extract(text) {
  return {
    urls: [...new Set(text.match(URL_RE) || [])],
    codes: text.match(CODE_RE) || [],
    otp: [...text.matchAll(OTP_RE)].map(m => m[1]),
    passwords: [...text.matchAll(PASS_RE)].map(m => m[1]),
  };
}
```

### 5.2 Отсев мусорных ссылок

Письма полны трекинговых/отписочных ссылок. Полезно фильтровать:

```js
const BAD_HOSTS = [
  'unsubscribe', 'track', 'click.', 'email.', 'mailchimp',
  'sendgrid', 'list-manage', 'utm_',
];

function isUsefulUrl(u) {
  const low = u.toLowerCase();
  if (BAD_HOSTS.some(b => low.includes(b))) return false;
  if (low.includes('unsubscribe')) return false;
  return true;
}

const links = extractUrls(text).filter(isUsefulUrl);
```

### 5.3 Универсальный «детектор секретов» письма

```js
function analyzeLetter(parsed) {
  const text = parsed.text || htmlToText(parsed.html || '');
  const subject = parsed.subject || '';
  const haystack = `${subject}\n${text}`;

  const urls = (haystack.match(URL_RE) || []).filter(isUsefulUrl);
  const passwords = [...haystack.matchAll(PASS_RE)].map(m => m[1]);
  const otp = [...haystack.matchAll(OTP_RE)].map(m => m[1]);

  // часто пароль стоит отдельной строкой после слова на предыдущей строке
  const lines = text.split(/\r?\n/).map(s => s.trim());
  for (let i = 0; i < lines.length; i++) {
    if (/^(пароль|password|pass)/i.test(lines[i]) && lines[i + 1]) {
      const cand = lines[i + 1];
      if (cand.length >= 6 && cand.length <= 64 && !/\s/.test(cand)) {
        passwords.push(cand);
      }
    }
  }

  return {
    subject,
    from: parsed.from?.value?.[0]?.address,
    date: parsed.date,
    urls: [...new Set(urls)],
    otp: [...new Set(otp)],
    passwords: [...new Set(passwords)],
  };
}
```

---

## 6. Полные рабочие примеры

### 6.1 Пример A: последние N писем, вывод + анализ (imapflow + mailparser)

```js
// read-mail.mjs  →  node read-mail.mjs
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const HOST = process.env.IMAP_HOST || 'imap.yandex.ru';
const USER = process.env.IMAP_USER;
const PASS = process.env.IMAP_PASS;
const LIMIT = Number(process.env.LIMIT || 5);

const client = new ImapFlow({
  host: HOST, port: 993, secure: true,
  auth: { user: USER, pass: PASS },
  logger: false,
});

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

await client.connect();
const lock = await client.getMailboxLock('INBOX');
try {
  const exists = client.mailbox.exists;
  const start = Math.max(1, exists - LIMIT + 1);
  // seq range: например '1:5' — первые 5 (старые). Для последних:
  const range = `${start}:*`;

  for await (const msg of client.fetch(range, { source: true })) {
    const parsed = await simpleParser(msg.source);
    const text = parsed.text || '';
    const urls = [...new Set(text.match(URL_RE) || [])];

    console.log('─'.repeat(60));
    console.log('UID:', msg.uid);
    console.log('From:', parsed.from?.text);
    console.log('Subject:', parsed.subject);
    console.log('Date:', parsed.date?.toISOString());
    console.log('URLs:', urls.slice(0, 5));
    console.log('Text:', text.replace(/\s+/g, ' ').slice(0, 160));
  }
} finally {
  lock.release();
  await client.logout();
}
```

Запуск:
```bash
IMAP_HOST=imap.yandex.ru IMAP_USER=you@yandex.ru IMAP_PASS=xxxx LIMIT=10 node read-mail.mjs
```

### 6.2 Пример B: поиск письма по теме и вытаскивание кода/ссылки

```js
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

async function findRecentBySubject(subject, host, user, pass) {
  const client = new ImapFlow({
    host, port: 993, secure: true, auth: { user, pass }, logger: false,
  });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = await client.search({ subject, since: new Date(Date.now() - 36e5 * 24) });
    if (!uids.length) return null;

    const uid = uids.sort((a, b) => b - a)[0]; // самый свежий
    const msg = await client.fetchOne(uid, { source: true });
    const parsed = await simpleParser(msg.source);
    const text = parsed.text || htmlToText(parsed.html || '');

    return {
      subject: parsed.subject,
      text,
      otp: [...text.matchAll(/(?:code|код)\D{0,15}(\d{4,8})/gi)].map(m => m[1]),
      links: [...new Set(text.match(URL_RE) || [])],
    };
  } finally {
    lock.release();
    await client.logout();
  }
}
```

### 6.3 Пример C: слежение за новыми письмами (IDLE) + парсинг

```js
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const client = new ImapFlow({
  host: 'imap.gmail.com', port: 993, secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
  logger: false,
});

await client.connect();
const lock = await client.getMailboxLock('INBOX');

client.on('exists', async (data) => {
  console.log('New message(s):', data.count);
  // забрать последние письма
  for await (const msg of client.fetch('1:*', { source: true, uid: true })) {
    const parsed = await simpleParser(msg.source);
    console.log('→', parsed.subject, '|', parsed.from?.text);
  }
});

await client.idle(); // блокирует до disconnect
```

### 6.4 Пример D: легаси на `imap` + `mailparser`

```js
import Imap from 'imap';
import { simpleParser } from 'mailparser';

const imap = new Imap({
  user: process.env.IMAP_USER,
  password: process.env.IMAP_PASS,
  host: 'imap.yandex.ru',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false }, // только для отладки!
});

function openInbox(cb) {
  imap.openBox('INBOX', true, cb); // true = readOnly
}

imap.once('ready', () => {
  openInbox((err, box) => {
    if (err) throw err;

    // последние 5 писем
    const total = box.messages.total;
    const fetch = imap.seq.fetch(`${Math.max(1, total - 4)}:${total}`, {
      bodies: '',        // всё письмо целиком
      struct: true,
    });

    fetch.on('message', (msg) => {
      msg.on('body', async (stream) => {
        const parsed = await simpleParser(stream);
        console.log(parsed.subject, '|', parsed.from?.text);
        const links = (parsed.text || '').match(/https?:\/\/\S+/g) || [];
        console.log('links:', links);
      });
    });

    fetch.once('end', () => imap.end());
    fetch.once('error', (e) => { console.error(e); imap.end(); });
  });
});

imap.once('error', (err) => console.error('IMAP error:', err));
imap.once('end', () => console.log('Connection ended'));
imap.connect();
```

### 6.5 Пример E: CLI-утилита «достань OTP/пароль из свежего письма»

```js
// otp.mjs — node otp.mjs "subject-fragment"
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const [, , subj = ''] = process.argv;
const client = new ImapFlow({
  host: process.env.IMAP_HOST, port: 993, secure: true,
  auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
  logger: false,
});

await client.connect();
const lock = await client.getMailboxLock('INBOX');
try {
  const uids = await client.search({ subject: subj, since: new Date(Date.now() - 3 * 36e5) });
  if (!uids.length) { console.log('NOT FOUND'); process.exit(2); }
  const uid = uids.sort((a, b) => b - a)[0];
  const msg = await client.fetchOne(uid, { source: true });
  const p = await simpleParser(msg.source);
  const t = (p.text || '') + '\n' + (p.html || '');
  const codes = [...t.matchAll(/\b\d{4,8}\b/g)].map(m => m[0]);
  console.log(JSON.stringify({ subject: p.subject, codes: [...new Set(codes)] }, null, 2));
} finally {
  lock.release();
  await client.logout();
}
```

```bash
IMAP_HOST=imap.gmail.com IMAP_USER=you@gmail.com IMAP_PASS=app-pass \
  node otp.mjs "verify your email"
```

---

## 7. Частые подводные камни

| Проблема | Причина / решение |
|---|---|
| `Invalid credentials` у Gmail | Обычный пароль вместо **App Password** / не включён IMAP / 2FA выключена |
| `AUTHENTICATIONFAILED` у Yandex | IMAP не включён в веб-настройках или нужен пароль приложения |
| Письма помечаются прочитанными | Открывайте папку `readOnly: true` (`openBox('INBOX', true)` / `getMailboxLock(..., {readOnly: true})`) |
| Кракозябры в теме | Не задан charset: у `imapflow` это решается само; у старого `imap` используйте `mailparser` (он декодирует RFC2047) |
| `self signed certificate` в тестах | `tls: { rejectUnauthorized: false }` (не для продакшена) |
| Долгое `connect()` | Проверьте сеть/файрвол: IMAPS — порт **993** (не 143) |
| `UID` vs sequence number | Всегда работайте с **UID** (`fetchOne(uid, {uid:true})` — в imapflow fetch по умолчанию по UID в `fetchOne`, а `fetch` — по sequence или UID в зависимости от переданного) |
| Пустое `parsed.text` | Письмо только HTML; конвертируйте `parsed.html` через `htmlToText` |
| Антибот-блокировка | Используйте пароль приложения + стабильный IP (VPS), либо OAuth2 |

### Безопасность
- Никогда не хардкодьте пароли: `.env` + `dotenv` или переменные окружения.
- Пароли приложений можно отозвать в любой момент.
- Не логируйте тела писем целиком в прод-логи (PII, токены).
- Для Gmail OAuth2 храните `refresh_token` в секрете.

---

## 8. Мини-шпаргалка

```bash
npm i imapflow mailparser
```

| Действие | imapflow |
|---|---|
| Подключиться | `await client.connect()` |
| Открыть папку | `const lock = await client.getMailboxLock('INBOX'); … lock.release()` |
| Поиск | `await client.search({ from, since, unseen })` |
| Получить письмо | `await client.fetchOne(uid, { source: true })` |
| Разобрать | `await simpleParser(msg.source)` |
| Ждать новые | `await client.idle()` + `client.on('exists', …)` |
| Выйти | `await client.logout()` |

**Запомни главное:**
1. Gmail → App Password (или OAuth2), Yandex → включить IMAP + пароль приложения.
2. `imapflow` для new-code, `mailparser` для парсинга.
3. `readOnly` если не хотите ставить `\Seen`.
4. Секреты ищите регулярками по `parsed.text`, а при HTML — сначала конвертируйте через `htmlToText`.
