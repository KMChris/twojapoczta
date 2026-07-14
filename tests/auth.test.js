// Jednostkowe testy uwierzytelniania: hasła scrypt, sesje, ciasteczka, limit prób.
// Każdy test dostaje świeżą bazę in-memory: pełna izolacja stanu.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, now } from '../server/db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, getSessionUser,
  parseCookies, sessionCookie, loginAllowed, recordLoginFailure, clearLoginFailures,
  SESSION_COOKIE,
} from '../server/auth.js';

function freshDbWithUser(login = 'ala') {
  const db = openMemoryDb();
  const r = db
    .prepare('INSERT INTO users (login, name, password_hash, signature, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(login, 'Ala Testowa', 'x', '', 'system', now());
  return { db, userId: Number(r.lastInsertRowid) };
}

// --- Hasła -------------------------------------------------------------------

test('hashPassword produkuje format scrypt$N$r$p$sól$klucz i weryfikuje się', async () => {
  const stored = await hashPassword('tajne-hasło-123');
  const parts = stored.split('$');
  assert.equal(parts.length, 6);
  assert.equal(parts[0], 'scrypt');
  assert.equal(parts[1], '16384');
  assert.equal(await verifyPassword(stored, 'tajne-hasło-123'), true);
});

test('verifyPassword odrzuca złe hasło', async () => {
  const stored = await hashPassword('poprawne');
  assert.equal(await verifyPassword(stored, 'niepoprawne'), false);
});

test('verifyPassword odrzuca nieznany schemat bez rzucania wyjątku', async () => {
  assert.equal(await verifyPassword('bcrypt$1$2$3$sol$klucz', 'cokolwiek'), false);
  assert.equal(await verifyPassword('zupełnie-niepoprawny-ciąg', 'cokolwiek'), false);
});

test('dwa hasze tego samego hasła różnią się (losowa sól)', async () => {
  const a = await hashPassword('to-samo');
  const b = await hashPassword('to-samo');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(a, 'to-samo'), true);
  assert.equal(await verifyPassword(b, 'to-samo'), true);
});

// --- Sesje -------------------------------------------------------------------

test('createSession + getSessionUser zwraca zalogowanego użytkownika', () => {
  const { db, userId } = freshDbWithUser();
  const sid = createSession(db, userId);
  const req = { headers: { cookie: `${SESSION_COOKIE}=${sid}` } };
  const user = getSessionUser(db, req);
  assert.ok(user);
  assert.equal(user.login, 'ala');
  assert.equal(user.session_id, sid);
  db.close();
});

test('getSessionUser zwraca null bez ciasteczka', () => {
  const { db } = freshDbWithUser();
  assert.equal(getSessionUser(db, { headers: {} }), null);
  db.close();
});

test('getSessionUser zwraca null dla nieznanej sesji', () => {
  const { db } = freshDbWithUser();
  const req = { headers: { cookie: `${SESSION_COOKIE}=nieistnieje` } };
  assert.equal(getSessionUser(db, req), null);
  db.close();
});

test('getSessionUser kasuje i odrzuca wygasłą sesję', () => {
  const { db, userId } = freshDbWithUser();
  const sid = 'przeterminowana';
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(sid, userId, '2000-01-01T00:00:00.000Z', now());
  const req = { headers: { cookie: `${SESSION_COOKIE}=${sid}` } };
  assert.equal(getSessionUser(db, req), null);
  // po odrzuceniu sesja znika z bazy
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(sid).n, 0);
  db.close();
});

test('destroySession usuwa sesję', () => {
  const { db, userId } = freshDbWithUser();
  const sid = createSession(db, userId);
  destroySession(db, sid);
  assert.equal(getSessionUser(db, { headers: { cookie: `${SESSION_COOKIE}=${sid}` } }), null);
  db.close();
});

// --- Ciasteczka --------------------------------------------------------------

test('parseCookies rozbija nagłówek na pary', () => {
  assert.deepEqual(parseCookies('a=1; b=2;c = 3'), { a: '1', b: '2', c: '3' });
});

test('parseCookies radzi sobie z pustym i wadliwym wejściem', () => {
  assert.deepEqual(parseCookies(), {});
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('bezrownania; x=1'), { x: '1' });
});

test('sessionCookie: domyślnie HttpOnly+SameSite, bez Secure', () => {
  const c = sessionCookie('SID', { headers: {} });
  assert.match(c, /^tp_session=SID/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Max-Age=2592000/);
  assert.doesNotMatch(c, /Secure/);
});

test('sessionCookie: Secure gdy proxy zgłasza https', () => {
  const c = sessionCookie('SID', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(c, /Secure/);
});

test('sessionCookie: Secure gdy TP_SECURE=1', () => {
  process.env.TP_SECURE = '1';
  try {
    assert.match(sessionCookie('SID', { headers: {} }), /Secure/);
  } finally {
    delete process.env.TP_SECURE;
  }
});

test('sessionCookie: clear czyści wartość i zeruje Max-Age', () => {
  const c = sessionCookie('SID', { headers: {} }, { clear: true });
  assert.match(c, /^tp_session=;/);
  assert.match(c, /Max-Age=0/);
});

// --- Limit prób logowania ----------------------------------------------------

test('loginAllowed przepuszcza do 5 nieudanych prób, potem blokuje', () => {
  const ip = '203.0.113.7';
  const login = `unit-rate-${Date.now()}`;
  for (let i = 0; i < 5; i++) {
    assert.equal(loginAllowed(ip, login), true, `próba ${i + 1}`);
    recordLoginFailure(ip, login);
  }
  assert.equal(loginAllowed(ip, login), false);
});

test('clearLoginFailures resetuje licznik', () => {
  const ip = '203.0.113.8';
  const login = `unit-clear-${Date.now()}`;
  for (let i = 0; i < 5; i++) recordLoginFailure(ip, login);
  assert.equal(loginAllowed(ip, login), false);
  clearLoginFailures(ip, login);
  assert.equal(loginAllowed(ip, login), true);
});

test('limit jest osobny dla różnych par ip|login', () => {
  const login = `unit-split-${Date.now()}`;
  for (let i = 0; i < 5; i++) recordLoginFailure('198.51.100.1', login);
  assert.equal(loginAllowed('198.51.100.1', login), false);
  assert.equal(loginAllowed('198.51.100.2', login), true);
});
