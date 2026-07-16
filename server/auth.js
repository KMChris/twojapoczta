// Authentication: scrypt password hashing, cookie sessions, login rate limiting.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { now } from './db.js';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'tp_session';

export async function hashPassword(password) {
  const salt = crypto.randomBytes(24);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(stored, password) {
  const [scheme, N, r, p, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(keyB64, 'base64url');
  const key = await scrypt(password, salt, expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

// --- Sessions -------------------------------------------------------------

export function createSession(db, userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(id, userId, expires, now());
  return id;
}

export function destroySession(db, sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function getSessionUser(db, req) {
  const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!sessionId) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.login, u.name, u.signature, u.theme, u.is_admin, u.is_blocked,
              s.id AS session_id, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`
    )
    .get(sessionId);
  if (!row) return null;
  if (row.expires_at < now() || row.is_blocked) {
    destroySession(db, sessionId);
    return null;
  }
  return row;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function sessionCookie(sessionId, req, { clear = false } = {}) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.TP_SECURE === '1';
  const parts = [
    `${SESSION_COOKIE}=${clear ? '' : sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : SESSION_DAYS * 86400}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// --- Login rate limiting ---------------------------------------------------

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const attempts = new Map();

export function loginAllowed(ip, login) {
  const key = `${ip}|${login}`;
  const cutoff = Date.now() - WINDOW_MS;
  const list = (attempts.get(key) ?? []).filter((t) => t > cutoff);
  attempts.set(key, list);
  return list.length < MAX_ATTEMPTS;
}

export function recordLoginFailure(ip, login) {
  const key = `${ip}|${login}`;
  const list = attempts.get(key) ?? [];
  list.push(Date.now());
  attempts.set(key, list);
}

export function clearLoginFailures(ip, login) {
  attempts.delete(`${ip}|${login}`);
}
