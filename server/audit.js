// Dziennik zdarzeń: działania administratorów i zdarzenia logowania.
// Aktor trzymany jako login-tekst, więc wpisy przeżywają usunięcie konta.

import { now } from './db.js';

export const RETENTION_DAYS = 90;

export function logEvent(db, { actor, action, target = '', details = '', ip = '' }) {
  // Retencja czyszczona leniwie: przy każdym zapisie, po indeksie created_at.
  const granica = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  db.prepare('DELETE FROM audit_log WHERE created_at < ?').run(granica);
  db.prepare(
    'INSERT INTO audit_log (actor_login, action, target, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(actor, action, target, details, ip, now());
}

export function listEvents(db, { action = null, limit = 200 } = {}) {
  const ile = Math.min(Math.max(Number(limit) || 200, 1), 500);
  if (action) {
    return db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT ?').all(action, ile);
  }
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(ile);
}
