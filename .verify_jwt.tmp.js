// TEMP verification of research/jwt.md examples. Deleted after run.
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const ACCESS_SECRET = 'a'.repeat(64);
const REFRESH_SECRET = 'b'.repeat(64);
const ISSUER = 'phoenix-academy';
const AUDIENCE = 'phoenix-web';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

function issueAccessToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role || 'user', token_type: 'access' },
    ACCESS_SECRET,
    { algorithm: 'HS256', expiresIn: '15m', issuer: ISSUER, audience: AUDIENCE, jwtid: crypto.randomUUID() }
  );
}
function verifyAccessToken(token) {
  return jwt.verify(token, ACCESS_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, clockTolerance: 5 });
}
function issueTokens(user, { familyId } = {}) {
  const family = familyId || crypto.randomUUID();
  const refreshJti = crypto.randomUUID();
  const access = issueAccessToken(user);
  const refresh = jwt.sign(
    { sub: String(user.id), family_id: family, token_type: 'refresh' },
    REFRESH_SECRET,
    { algorithm: 'HS256', expiresIn: '7d', issuer: ISSUER, audience: AUDIENCE, jwtid: refreshJti }
  );
  return { access, refresh, refreshJti, familyId: family, refreshHash: sha256(refresh) };
}
function verifyRefreshToken(token) {
  const p = jwt.verify(token, REFRESH_SECRET, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE, clockTolerance: 5 });
  if (p.token_type !== 'refresh') throw new Error('Wrong token type');
  return p;
}

const db = new Database(':memory:');
db.exec(`CREATE TABLE refresh_tokens (
  jti TEXT PRIMARY KEY, user_id INTEGER NOT NULL, family_id TEXT NOT NULL,
  token_hash TEXT NOT NULL, user_agent TEXT, ip TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);`);
const RT = {
  create({ jti, userId, familyId, tokenHash }) {
    const now = Date.now();
    db.prepare('INSERT INTO refresh_tokens (jti,user_id,family_id,token_hash,created_at,expires_at,revoked) VALUES (?,?,?,?,?,?,0)')
      .run(jti, userId, familyId, tokenHash, now, now + 7 * 864e5);
  },
  findByJti: (jti) => db.prepare('SELECT * FROM refresh_tokens WHERE jti = ?').get(jti),
  findAliveByFamily: (f) => db.prepare('SELECT 1 FROM refresh_tokens WHERE family_id=? AND revoked=0 AND expires_at>? LIMIT 1').get(f, Date.now()),
  revoke: (jti) => db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE jti=?').run(jti),
  revokeFamily: (f) => db.prepare('UPDATE refresh_tokens SET revoked=1 WHERE family_id=?').run(f),
};

function rotate(token, user) {
  const payload = verifyRefreshToken(token);
  const stored = RT.findByJti(payload.jti);
  if (!stored) {
    if (RT.findAliveByFamily(payload.family_id)) RT.revokeFamily(payload.family_id);
    throw new Error('refresh revoked (reuse, not found)');
  }
  if (stored.token_hash !== sha256(token) || stored.revoked || stored.expires_at < Date.now()) {
    RT.revokeFamily(payload.family_id);
    throw new Error('refresh revoked (reuse)');
  }
  RT.revoke(stored.jti);
  const t = issueTokens(user, { familyId: stored.family_id });
  RT.create({ jti: t.refreshJti, userId: user.id, familyId: t.familyId, tokenHash: t.refreshHash });
  return t;
}

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log('  OK   ' + name)) : (fail++, console.log('  FAIL ' + name)); };

console.log('1) access sign/verify + claims');
const user = { id: 42, role: 'user' };
const access = issueAccessToken(user);
const ap = verifyAccessToken(access);
check('sub === "42"', ap.sub === '42');
check('iss/aud set', ap.iss === ISSUER && ap.aud === AUDIENCE);
check('token_type=access', ap.token_type === 'access');
check('jti present', typeof ap.jti === 'string' && ap.jti.length > 0);

console.log('2) negative: wrong secret & alg:none');
check('wrong secret rejected', (() => { try { jwt.verify(access, 'x'.repeat(64), { algorithms: ['HS256'] }); return false; } catch { return true; } })());
check('alg:none rejected', (() => {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ sub: '42', token_type: 'access' })).toString('base64url');
  try { jwt.verify(h + '.' + p + '.', ACCESS_SECRET, { algorithms: ['HS256'] }); return false; } catch { return true; }
})());

console.log('3) access vs refresh separated');
const t1 = issueTokens(user);
check('refresh verifies with refresh secret', verifyRefreshToken(t1.refresh).sub === '42');
check('refresh NOT valid as access', (() => { try { verifyAccessToken(t1.refresh); return false; } catch { return true; } })());
RT.create({ jti: t1.refreshJti, userId: user.id, familyId: t1.familyId, tokenHash: t1.refreshHash });

console.log('4) rotation + reuse detection');
const t2 = rotate(t1.refresh, user);
check('rotation returns new refresh', t2.refresh !== t1.refresh);
check('same family kept', verifyRefreshToken(t2.refresh).family_id === t1.familyId);
RT.create({ jti: t2.refreshJti, userId: user.id, familyId: t2.familyId, tokenHash: t2.refreshHash });
check('old refresh revoked', RT.findByJti(t1.refreshJti).revoked === 1);
check('reuse of old refresh throws', (() => { try { rotate(t1.refresh, user); return false; } catch { return true; } })());
check('family fully revoked after reuse', RT.findAliveByFamily(t1.familyId) === undefined);
check('newest token in family revoked too', RT.findByJti(t2.refreshJti).revoked === 1);

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
