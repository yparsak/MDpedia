// Admin sessions stored in MariaDB (roadmap Phase 1).
//   - The cookie holds a random token. The table holds only its SHA-256, so a
//     leaked database does not contain working session cookies.
//   - Two limits: idle (last_seen_at) and absolute (expires_at). Both are
//     checked by the database clock, so there is one clock and no time-zone mismatch.
//   - A new session is created on every login, and the old one is dropped.

import crypto from 'node:crypto';
import { newToken } from './csrf.js';

export const COOKIE_NAME = 'mdpedia_sid';

// last_seen_at is refreshed at most this often, to avoid a write on every request.
const TOUCH_AFTER_SECONDS = 15;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name && !(name in out)) {
      try {
        out[name] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        // A malformed value is treated as absent.
      }
    }
  }
  return out;
}

export function cookieOptions(config) {
  return { httpOnly: true, sameSite: 'strict', secure: config.session.cookieSecure, path: '/' };
}

export function setSessionCookie(res, config, token) {
  res.cookie(COOKIE_NAME, token, cookieOptions(config));
}

export function clearSessionCookie(res, config) {
  res.clearCookie(COOKIE_NAME, cookieOptions(config));
}

export async function createSession(pool, config, adminId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = newToken();
  await pool.query(
    `INSERT INTO sessions (id, admin_id, csrf_token, expires_at)
     VALUES (?, ?, ?, NOW() + INTERVAL ? HOUR)`,
    [hashToken(token), adminId, csrfToken, config.session.maxHours],
  );
  return { token, csrfToken };
}

// Returns { id, adminId, username, csrfToken, expiresAt } or null.
export async function loadSession(pool, config, token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const id = hashToken(token);
  const [rows] = await pool.query(
    `SELECT s.id, s.admin_id, s.csrf_token, s.expires_at, a.username,
            TIMESTAMPDIFF(SECOND, s.last_seen_at, NOW()) AS idle_seconds
       FROM sessions s
       JOIN admin_users a ON a.id = s.admin_id
      WHERE s.id = ?
        AND s.expires_at > NOW()
        AND s.last_seen_at > NOW() - INTERVAL ? MINUTE`,
    [id, config.session.idleMinutes],
  );
  const row = rows[0];
  if (!row) return null;

  if (Number(row.idle_seconds) >= TOUCH_AFTER_SECONDS) {
    await pool.query('UPDATE sessions SET last_seen_at = NOW() WHERE id = ?', [id]);
  }
  return {
    id,
    adminId: row.admin_id,
    username: row.username,
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
  };
}

export async function destroySessionByToken(pool, token) {
  if (typeof token !== 'string' || token === '') return;
  await pool.query('DELETE FROM sessions WHERE id = ?', [hashToken(token)]);
}

export async function destroyAllForAdmin(pool, adminId) {
  await pool.query('DELETE FROM sessions WHERE admin_id = ?', [adminId]);
}

// Housekeeping, run at login so the table cannot grow without bound.
export async function purgeDead(pool, config) {
  await pool.query(
    'DELETE FROM sessions WHERE expires_at <= NOW() OR last_seen_at <= NOW() - INTERVAL ? MINUTE',
    [config.session.idleMinutes],
  );
}
