// Logika panelu administratora: uprawnienia, przegląd kont, statystyki instancji.
// Wyłącznie liczby i metadane, nigdy treści wiadomości (tajemnica korespondencji).

import { now } from './db.js';
import { addressOf } from './mail.js';
import { storageUsage } from './quota.js';
import { gcBlobs } from './attachments.js';

export function grantAdmin(db, login) {
  const result = db
    .prepare('UPDATE users SET is_admin = 1 WHERE login = ?')
    .run(String(login ?? '').trim().toLowerCase());
  return result.changes > 0;
}

export function adminCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
}

export function revokeSessions(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

export function createUser(db, { login, name, passwordHash }) {
  const result = db
    .prepare('INSERT INTO users (login, name, password_hash, signature, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(login, name, passwordHash, '', 'system', now());
  return Number(result.lastInsertRowid);
}

// Usunięcie konta: wiadomości, aliasy, sesje i uploady idą kaskadą (FK),
// osierocone bloby załączników sprząta GC.
export function deleteUser(db, userId) {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  if (result.changes) gcBlobs(db);
  return result.changes > 0;
}

export function userAliases(db, userId) {
  return db
    .prepare('SELECT id, alias FROM aliases WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map((a) => ({ ...a, address: addressOf(a.alias) }));
}

const USER_FIELDS =
  'id, login, name, is_admin, is_blocked, quota_mb, alias_limit, created_at, last_login_at';

function decorate(db, row) {
  return {
    ...row,
    is_admin: !!row.is_admin,
    is_blocked: !!row.is_blocked,
    address: addressOf(row.login),
    messages: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ?').get(row.id).n,
    storage_bytes: storageUsage(db, row.id),
    aliases: userAliases(db, row.id),
  };
}

export function getUserView(db, id) {
  const row = db.prepare(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`).get(id);
  return row ? decorate(db, row) : null;
}

export function listUsers(db) {
  return db
    .prepare(`SELECT ${USER_FIELDS} FROM users ORDER BY login`)
    .all()
    .map((row) => decorate(db, row));
}

// --- Statystyki instancji ------------------------------------------------------

export function trafficByDay(db, days = 14) {
  const od = new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT substr(sent_at, 1, 10) AS day,
              SUM(CASE WHEN folder = 'sent' THEN 1 ELSE 0 END) AS sent,
              SUM(CASE WHEN folder IN ('inbox', 'spam') THEN 1 ELSE 0 END) AS received
       FROM messages WHERE sent_at >= ? GROUP BY day`
    )
    .all(od);
  const poDniu = new Map(rows.map((r) => [r.day, r]));
  const wynik = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    wynik.push({ date, sent: poDniu.get(date)?.sent ?? 0, received: poDniu.get(date)?.received ?? 0 });
  }
  return wynik;
}

export function instanceStats(db) {
  const users = db
    .prepare('SELECT COUNT(*) AS total, COALESCE(SUM(is_blocked), 0) AS blocked, COALESCE(SUM(is_admin), 0) AS admins FROM users')
    .get();
  const messages = db.prepare('SELECT COUNT(*) AS total FROM messages').get();
  const zalaczniki = db.prepare('SELECT COALESCE(SUM(size), 0) AS bytes FROM attachments').get();
  const tresci = db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS bytes FROM messages').get();
  const aliases = db.prepare('SELECT COUNT(*) AS n FROM aliases').get();
  const sessions = db.prepare('SELECT COUNT(*) AS active FROM sessions WHERE expires_at > ?').get(now());

  return {
    users: { total: users.total, blocked: users.blocked, admins: users.admins },
    messages: { total: messages.total },
    storage: { bytes: tresci.bytes + zalaczniki.bytes, attachments: zalaczniki.bytes },
    aliases: aliases.n,
    sessions: { active: sessions.active },
    traffic: trafficByDay(db),
  };
}
