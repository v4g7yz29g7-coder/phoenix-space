const { simpleParser } = require('mailparser');
const { ImapFlow } = require('imapflow');

const raw = Buffer.from([
  'From: "Acme Service" <noreply@acme.example>',
  'To: user@example.com',
  'Subject: Ваш пароль и код подтверждения',
  'Date: Mon, 01 Sep 2025 10:00:00 +0000',
  'MIME-Version: 1.0',
  'Content-Type: multipart/alternative; boundary="BND"',
  '',
  '--BND',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Здравствуйте!',
  'Пароль: Qw3rty!pass',
  'Код подтверждения: 483920',
  'Подтвердите: https://acme.example/verify?token=abc123',
  'Отписаться: https://click.acme.example/unsubscribe?u=9',
  '--BND',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><body><p>Здравствуйте!</p><b>Пароль: Qw3rty!pass</b>',
  '<p>Код: 483920</p>',
  '<a href="https://acme.example/verify?token=abc123">verify</a>',
  '<a href="https://click.acme.example/unsubscribe?u=9">unsub</a>',
  '</body></html>',
  '--BND--',
].join('\r\n'), 'utf8');

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const CODE_RE = /\b\d{4,8}\b/g;
const PASS_RE = /(?:partol|password|pass|пароль|код)\s*[:\-–]\s*([^\s<>\n]{6,64})/gi;
const OTP_RE = /(?:код|code|otp)\D{0,20}(\d{4,8})/gi;
const BAD_HOSTS = ['unsubscribe','track','click.','email.','mailchimp','sendgrid','list-manage','utm_'];
function isUsefulUrl(u){ const low=u.toLowerCase(); if(BAD_HOSTS.some(b=>low.includes(b)))return false; if(low.includes('unsubscribe'))return false; return true; }

function extract(text) {
  return {
    urls: [...new Set(text.match(URL_RE) || [])],
    codes: text.match(CODE_RE) || [],
    otp: [...text.matchAll(OTP_RE)].map(m => m[1]),
    passwords: [...text.matchAll(PASS_RE)].map(m => m[1]),
  };
}

(async () => {
  const p = await simpleParser(raw);
  console.log('== simpleParser output ==');
  console.log('subject       :', p.subject);
  console.log('from.address  :', p.from && p.from.value && p.from.value[0] && p.from.value[0].address);
  console.log('from.text     :', p.from && p.from.text);
  console.log('date is Date  :', p.date instanceof Date);
  console.log('text present  :', !!p.text);
  console.log('html present  :', !!p.html);
  console.log('attachments   :', Array.isArray(p.attachments), p.attachments.length);
  console.log('headers is Map:', p.headers instanceof Map);
  console.log('textAsHtml    :', typeof p.textAsHtml);

  console.log('\n== htmlToText ==');
  const asText = htmlToText(p.html);
  console.log(asText.replace(/\n/g, ' | '));

  console.log('\n== extract (plain text) ==');
  const e = extract(p.text);
  console.log(JSON.stringify(e, null, 2));
  console.log('useful urls   :', e.urls.filter(isUsefulUrl));

  console.log('\n== extract (html->text) ==');
  const e2 = extract(asText);
  console.log('otp           :', e2.otp);
  console.log('passwords     :', e2.passwords);
  console.log('useful urls   :', e2.urls.filter(isUsefulUrl));

  console.log('\n== imapflow API ==');
  const c = new ImapFlow({ host: 'imap.example.com', port: 993, secure: true,
    auth: { user: 'u', pass: 'p' }, logger: false });
  ['connect','logout','list','getMailboxLock','search','fetch','fetchOne','idle']
    .forEach(m => console.log(('has ' + m + '()').padEnd(18), typeof c[m] === 'function'));

  const ok = {
    subject: p.subject === 'Ваш пароль и код подтверждения',
    from: p.from && p.from.value && p.from.value[0] && p.from.value[0].address === 'noreply@acme.example',
    otp_plain: e.otp.indexOf('483920') !== -1,
    pass_plain: e.passwords.some(x => x.indexOf('Qw3rty') !== -1),
    filters_tracking: !e.urls.filter(isUsefulUrl).some(u => u.indexOf('unsubscribe') !== -1),
  };
  console.log('\n== ASSERTIONS ==', JSON.stringify(ok, null, 2));
  console.log(Object.values(ok).every(Boolean) ? 'RESULT: ALL OK' : 'RESULT: FAIL');
})().catch(err => { console.error('ERROR', err); process.exit(1); });
