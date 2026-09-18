// Verifies the code samples from research/password.md actually run.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ---- 4.2 bcrypt (bcryptjs, cost 10 for speed in test) ----
const COST = 10;
const bcryptHash = bcrypt.hashSync('correct horse battery staple', COST);
console.log('bcrypt hash ok    :', bcryptHash.startsWith('$2'));
console.log('bcrypt verify ok  :', bcrypt.compareSync('correct horse battery staple', bcryptHash));
console.log('bcrypt verify bad :', bcrypt.compareSync('wrong', bcryptHash) === false);

// ---- 4.3 pre-hash (72-byte bypass) ----
function prehash(p) { return crypto.createHash('sha256').update(String(p), 'utf8').digest('base64'); }
const long = 'a'.repeat(200);
const ph = bcrypt.hashSync(prehash(long), COST);
console.log('prehash long ok   :', bcrypt.compareSync(prehash(long), ph));

// ---- 5.1 reset token ----
function newResetToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash, expiresAt: Date.now() + 30 * 60 * 1000 };
}
const t = newResetToken();
console.log('token bytes       :', Buffer.from(t.token, 'base64url').length);
console.log('token hash len    :', t.hash.length);
console.log('token != stored   :', t.token !== t.hash);
console.log('TTL ~30min        :', Math.round((t.expiresAt - Date.now()) / 60000));

// ---- 4.4 scrypt with N=65536, constant-time ----
const N = 65536, r = 8, p = 1, KEYLEN = 64;
function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), salt, KEYLEN, { N, r, p, maxmem: 256 * 1024 * 1024 });
}
const salt = crypto.randomBytes(16);
const key = scryptHash('pw', salt);
const key2 = scryptHash('pw', salt);
const key3 = scryptHash('nope', salt);
console.log('scrypt verify ok  :', crypto.timingSafeEqual(key, key2));
console.log('scrypt verify bad :', !crypto.timingSafeEqual(key, key3));
console.log('ALL EXAMPLES OK');
