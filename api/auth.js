'use strict';

/**
 * api/auth.js
 * ---------------------------------------------------------------------------
 * Minimal, dependency-free JSON Web Token (JWT) implementation.
 *
 * Only Node.js built-ins are used (`crypto`). No npm dependencies.
 * Implements JWS Compact Serialization (RFC 7515) and JWT claims (RFC 7519)
 * for the HMAC family: HS256 (default), HS384, HS512.
 *
 * Required public API:
 *   - generateToken(payload, options) -> string          (signed compact JWT)
 *   - verifyToken(token, options)     -> object          (decoded claims; throws on failure)
 *
 * Extra helpers:
 *   - sign / verify                    low-level primitives
 *   - decode / decodeToken             decode WITHOUT signature verification
 *   - isExpired(token)                 boolean convenience check
 *   - refreshToken(token, options)     issue a new token from an old one
 *   - generateAccessToken / generateRefreshToken
 *   - bearerAuthMiddleware             Express-compatible middleware
 *   - base64UrlEncode / base64UrlDecode
 *   - JwtError + subclasses
 * ---------------------------------------------------------------------------
 */

const crypto = require('crypto');

/* ============================== Constants ================================ */

const ALGORITHMS = Object.freeze({
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
});

// Backwards-compatible alias used by some callers/tests.
const ALGO_MAP = ALGORITHMS;

const DEFAULT_ALGORITHM = 'HS256';
const SECRET_ENV_VAR = 'JWT_SECRET';
const MIN_SECRET_LENGTH = 16;

const ACCESS_TOKEN_TTL = 900; // 15 minutes
const REFRESH_TOKEN_TTL = 604800; // 7 days
const REFRESH_MAX_TOLERANCE = 315360000; // 10 years of leeway for expired tokens

const DEFAULTS = Object.freeze({
  algorithm: DEFAULT_ALGORITHM,
  expiresIn: 3600, // seconds, or a string such as "15m", "1h", "7d"
  notBefore: 0, // seconds, or a duration string
  issuer: null,
  audience: null,
  subject: null,
  clockTolerance: 0, // seconds of leeway applied to exp / nbf
});

/* ================================ Errors ================================= */

class JwtError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'JwtError';
    this.code = code || 'JWT_ERROR';
  }
}

class MalformedTokenError extends JwtError {
  constructor(message) {
    super(message || 'Malformed token', 'MALFORMED_TOKEN');
    this.name = 'MalformedTokenError';
  }
}

class TokenExpiredError extends JwtError {
  constructor(message) {
    super(message || 'Token has expired', 'TOKEN_EXPIRED');
    this.name = 'TokenExpiredError';
  }
}

class TokenNotBeforeError extends JwtError {
  constructor(message) {
    super(message || 'Token is not active yet', 'TOKEN_NOT_ACTIVE');
    this.name = 'TokenNotBeforeError';
  }
}

class SignatureError extends JwtError {
  constructor(message) {
    super(message || 'Signature verification failed', 'INVALID_SIGNATURE');
    this.name = 'SignatureError';
  }
}

class AlgorithmError extends JwtError {
  constructor(message) {
    super(message || 'Unsupported algorithm', 'UNSUPPORTED_ALGORITHM');
    this.name = 'AlgorithmError';
  }
}

/* =============================== Helpers ================================= */

/**
 * Encode a Buffer/string into an unpadded base64url string.
 */
function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Decode an unpadded base64url string back into a Buffer.
 */
function base64UrlDecode(str) {
  if (typeof str !== 'string') {
    throw new TypeError('base64UrlDecode expects a string');
  }
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  return Buffer.from(s, 'base64');
}

function jsonEncode(obj) {
  return base64UrlEncode(JSON.stringify(obj));
}

function jsonDecode(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Parse a duration expressed either as a number of seconds or as a string
 * such as "30s", "15m", "1h", "7d", "2w".
 */
function parseDuration(value) {
  if (typeof value === 'number' && isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const m = /^(-?\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i.exec(value.trim());
    if (!m) throw new JwtError('Invalid duration: ' + value, 'INVALID_DURATION');
    const amount = parseFloat(m[1]);
    const unit = (m[2] || 's').toLowerCase();
    const multiplier = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
    return Math.trunc(amount * multiplier);
  }
  throw new JwtError('Invalid duration: ' + String(value), 'INVALID_DURATION');
}

/**
 * Resolve the signing secret from options, falling back to the environment.
 * Enforces a minimum length to avoid trivially weak keys.
 */
function resolveSecret(options) {
  const provided = options ? options.secret : undefined;
  const secret = provided !== undefined ? provided : process.env[SECRET_ENV_VAR];
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new JwtError(
      'JWT secret is required (pass options.secret or set ' + SECRET_ENV_VAR + ')',
      'MISSING_SECRET'
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new JwtError(
      'JWT secret is too weak (min ' + MIN_SECRET_LENGTH + ' chars)',
      'WEAK_SECRET'
    );
  }
  return secret;
}

function normalizeOptions(options) {
  return Object.assign({}, DEFAULTS, options || {});
}

/**
 * HMAC-sign the given data and return the base64url-encoded signature.
 */
function sign(data, secret, algorithm) {
  const hash = ALGORITHMS[algorithm];
  if (!hash) throw new AlgorithmError('Unsupported algorithm: ' + algorithm);
  return base64UrlEncode(crypto.createHmac(hash, secret).update(data).digest());
}

/**
 * Constant-time comparison to mitigate timing attacks.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (_e) {
    return false;
  }
}

/* ============================== Core API ================================= */

/**
 * Generate a signed JWT.
 *
 * @param {object} payload   Claims to embed (e.g. { sub: '42', role: 'admin' }).
 * @param {object} [options] { algorithm, expiresIn, issuer, audience, subject,
 *                            notBefore, jti, secret }
 * @returns {string} Compact JWS: header.payload.signature
 */
function generateToken(payload, options) {
  const opts = normalizeOptions(options);
  const algorithm = opts.algorithm || DEFAULT_ALGORITHM;

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('generateToken: payload must be a plain object');
  }
  if (!ALGORITHMS[algorithm]) {
    throw new AlgorithmError('generateToken: unsupported algorithm "' + algorithm + '"');
  }

  const secret = resolveSecret(options);
  const header = { alg: algorithm, typ: 'JWT' };
  const iat = nowSeconds();

  const claims = Object.assign({}, payload, { iat });

  if (opts.issuer) claims.iss = opts.issuer;
  if (opts.audience) claims.aud = opts.audience;
  if (opts.subject && claims.sub === undefined) claims.sub = opts.subject;

  if (opts.expiresIn !== undefined && opts.expiresIn !== null) {
    claims.exp = iat + parseDuration(opts.expiresIn);
  }
  if (opts.notBefore !== undefined && opts.notBefore !== null) {
    claims.nbf = iat + parseDuration(opts.notBefore);
  }

  claims.jti = opts.jti !== undefined ? opts.jti : crypto.randomBytes(16).toString('hex');

  const encodedHeader = jsonEncode(header);
  const encodedPayload = jsonEncode(claims);
  const signingInput = encodedHeader + '.' + encodedPayload;
  const signature = sign(signingInput, secret, algorithm);

  return signingInput + '.' + signature;
}

/**
 * Verify a JWT and validate its claims. Returns the decoded claims object.
 * Throws a JwtError subclass when the token is invalid.
 *
 * @param {string} token
 * @param {object} [options] { secret, algorithm, algorithms, issuer, audience,
 *                            clockTolerance }
 * @returns {object} decoded claims
 */
function verifyToken(token, options) {
  const opts = normalizeOptions(options);
  const secret = resolveSecret(options);

  if (typeof token !== 'string' || token.length === 0) {
    throw new MalformedTokenError('token must be a non-empty string');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new MalformedTokenError('token must have 3 dot-separated parts');
  }

  const encodedHeader = parts[0];
  const encodedPayload = parts[1];
  const providedSignature = parts[2];

  let header;
  let payload;
  try {
    header = jsonDecode(base64UrlDecode(encodedHeader));
    payload = jsonDecode(base64UrlDecode(encodedPayload));
  } catch (err) {
    throw new MalformedTokenError('malformed token: ' + err.message);
  }

  if (!header || typeof header !== 'object') {
    throw new MalformedTokenError('missing header');
  }
  if (!payload || typeof payload !== 'object') {
    throw new MalformedTokenError('missing payload');
  }

  const algorithm = header.alg;
  if (!ALGORITHMS[algorithm]) {
    throw new AlgorithmError('unsupported or missing alg: ' + algorithm);
  }
  if (header.typ && header.typ !== 'JWT') {
    throw new MalformedTokenError('unexpected typ: ' + header.typ);
  }

  const allowed = opts.algorithms
    ? opts.algorithms
    : opts.algorithm
    ? [opts.algorithm]
    : [algorithm];
  if (allowed.indexOf(algorithm) === -1) {
    throw new AlgorithmError('algorithm "' + algorithm + '" not allowed');
  }

  const expectedSignature = sign(encodedHeader + '.' + encodedPayload, secret, algorithm);
  if (!timingSafeEqual(expectedSignature, providedSignature)) {
    throw new SignatureError('signature verification failed');
  }

  const tolerance = typeof opts.clockTolerance === 'number' ? opts.clockTolerance : 0;
  const now = nowSeconds();

  if (typeof payload.exp === 'number' && now > payload.exp + tolerance) {
    throw new TokenExpiredError();
  }
  if (typeof payload.nbf === 'number' && now + tolerance < payload.nbf) {
    throw new TokenNotBeforeError();
  }
  if (opts.issuer && payload.iss && payload.iss !== opts.issuer) {
    throw new JwtError('issuer mismatch: ' + payload.iss, 'INVALID_ISSUER');
  }
  if (opts.audience) {
    const aud = payload.aud;
    const ok = Array.isArray(aud)
      ? aud.indexOf(opts.audience) !== -1
      : aud === opts.audience;
    if (!ok) {
      throw new JwtError('audience mismatch', 'INVALID_AUDIENCE');
    }
  }

  return payload;
}

/* =========================== Decode utilities ============================ */

/**
 * Decode a token WITHOUT verifying the signature. Useful for inspection.
 * Returns null when the token is not a well-formed JWS.
 */
function decode(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: jsonDecode(base64UrlDecode(parts[0])),
      payload: jsonDecode(base64UrlDecode(parts[1])),
      signature: parts[2],
    };
  } catch (_e) {
    return null;
  }
}

const decodeToken = decode;

/**
 * Boolean convenience check: has the token already expired?
 * Unreadable tokens are treated as expired.
 */
function isExpired(token) {
  const decoded = decode(token);
  if (!decoded || !decoded.payload) return true;
  if (typeof decoded.payload.exp !== 'number') return false;
  return decoded.payload.exp <= nowSeconds();
}

/* ========================== Token lifecycle ============================== */

/**
 * Refresh an existing token: keep its custom claims but reset iat/exp/jti.
 * Expired tokens are accepted (within a generous leeway) so a client can
 * rotate a token that has just lapsed.
 */
function refreshToken(token, options) {
  const opts = Object.assign({}, options || {}, { clockTolerance: REFRESH_MAX_TOLERANCE });
  const claims = verifyToken(token, opts);

  const clean = Object.assign({}, claims);
  delete clean.iat;
  delete clean.exp;
  delete clean.nbf;
  delete clean.jti;
  delete clean.iss;
  delete clean.aud;

  return generateToken(clean, options);
}

function generateAccessToken(payload, options) {
  return generateToken(payload, Object.assign({ expiresIn: ACCESS_TOKEN_TTL }, options || {}));
}

function generateRefreshToken(payload, options) {
  return generateToken(payload, Object.assign({ expiresIn: REFRESH_TOKEN_TTL }, options || {}));
}

/* ============================== Middleware ============================== */

/**
 * Express-compatible Bearer-token middleware.
 * Attaches the decoded claims to `req.user` and forwards errors to `next`.
 */
function bearerAuthMiddleware(options) {
  const opts = options || {};
  return function authMiddleware(req, res, next) {
    const headerSource =
      (req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const match = /^Bearer\s+(.+)$/i.exec(String(headerSource));

    if (!match) {
      const error = new JwtError('Missing Bearer token', 'NO_TOKEN');
      if (typeof next === 'function') return next(error);
      if (res && typeof res.status === 'function') {
        return res.status(401).json({ error: error.message });
      }
      throw error;
    }

    try {
      const claims = verifyToken(match[1], opts);
      if (req && typeof req === 'object') req.user = claims;
      if (typeof next === 'function') return next();
      return claims;
    } catch (err) {
      if (typeof next === 'function') return next(err);
      if (res && typeof res.status === 'function') {
        return res.status(401).json({ error: err.message });
      }
      throw err;
    }
  };
}

/* ================================ Exports ================================ */

module.exports = {
  // required public API
  generateToken,
  verifyToken,
  // low-level primitives
  sign,
  verify: verifyToken,
  // helpers
  decode,
  decodeToken,
  isExpired,
  refreshToken,
  generateAccessToken,
  generateRefreshToken,
  bearerAuthMiddleware,
  base64UrlEncode,
  base64UrlDecode,
  parseDuration,
  // config / errors
  ALGORITHMS,
  ALGO_MAP,
  DEFAULTS,
  ACCESS_TOKEN_TTL,
  REFRESH_TOKEN_TTL,
  JwtError,
  MalformedTokenError,
  TokenExpiredError,
  TokenNotBeforeError,
  SignatureError,
  AlgorithmError,
};

module.exports.default = module.exports;

/* ------------------------------------------------------------------ */
/* Self-test when executed directly: node api/auth.js                  */
/* ------------------------------------------------------------------ */

if (require.main === module) {
  const secret = 'test-secret-1234567890';
  const token = generateToken({ sub: 'user-1', role: 'admin' }, { secret, expiresIn: 60 });
  const claims = verifyToken(token, { secret });
  console.log('token:', token);
  console.log('claims:', claims);

  let rejected = false;
  try {
    verifyToken(token, { secret: 'wrong-secret-1234567890' });
  } catch (_e) {
    rejected = true;
  }
  console.log('wrong secret rejected:', rejected);
}
