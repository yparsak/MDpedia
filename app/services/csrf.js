// CSRF tokens (brainstorm 5.11). Two kinds, because the login form exists
// before there is a session:
//   - logged-in forms carry the token stored with the session row;
//   - the login form carries a signed, time-limited token (HMAC with the
//     session secret), which needs no server-side state.
// SameSite=Strict cookies are the first line of defence; these tokens are the second.

import crypto from 'node:crypto';

export const FIELD = '_csrf';
const LOGIN_TOKEN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Constant-time comparison that also copes with different lengths and non-strings.
export function tokensEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(`login-form:${payload}`).digest('hex');
}

export function makeLoginToken(secret, now = Date.now()) {
  const payload = `${now}.${crypto.randomBytes(12).toString('hex')}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyLoginToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [issued, nonce, signature] = parts;
  if (!tokensEqual(signature, sign(secret, `${issued}.${nonce}`))) return false;
  const age = now - Number(issued);
  return Number.isFinite(age) && age >= 0 && age <= LOGIN_TOKEN_MAX_AGE_MS;
}
