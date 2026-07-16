// Jednostkowe testy dziennika zdarzeń: zapis, filtrowanie, retencja.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../server/db.js';
import { logEvent, listEvents, RETENTION_DAYS } from '../server/audit.js';

test('logEvent zapisuje zdarzenie, listEvents zwraca najnowsze pierwsze', () => {
  const db = openMemoryDb();
  logEvent(db, { actor: 'demo', action: 'user.create', target: 'nowak', details: 'konto z panelu', ip: '10.0.0.1' });
  logEvent(db, { actor: 'demo', action: 'user.block', target: 'nowak' });

  const wpisy = listEvents(db);
  assert.equal(wpisy.length, 2);
  assert.equal(wpisy[0].action, 'user.block');
  assert.equal(wpisy[1].action, 'user.create');
  assert.equal(wpisy[1].actor_login, 'demo');
  assert.equal(wpisy[1].target, 'nowak');
  assert.equal(wpisy[1].details, 'konto z panelu');
  assert.equal(wpisy[1].ip, '10.0.0.1');
  assert.ok(wpisy[1].created_at);
  db.close();
});

test('listEvents filtruje po typie akcji i szanuje limit', () => {
  const db = openMemoryDb();
  for (let i = 0; i < 5; i += 1) logEvent(db, { actor: 'demo', action: 'login' });
  logEvent(db, { actor: 'demo', action: 'settings.update' });

  assert.equal(listEvents(db, { action: 'login' }).length, 5);
  assert.equal(listEvents(db, { action: 'settings.update' }).length, 1);
  assert.equal(listEvents(db, { limit: 3 }).length, 3);
  db.close();
});

test('zdarzenia starsze niż retencja znikają przy kolejnym zapisie', () => {
  const db = openMemoryDb();
  const dawno = new Date(Date.now() - (RETENTION_DAYS + 10) * 86400_000).toISOString();
  db.prepare(
    "INSERT INTO audit_log (actor_login, action, target, details, ip, created_at) VALUES ('stary', 'login', '', '', '', ?)"
  ).run(dawno);
  assert.equal(listEvents(db).length, 1);

  logEvent(db, { actor: 'demo', action: 'login' });
  const wpisy = listEvents(db);
  assert.equal(wpisy.length, 1);
  assert.equal(wpisy[0].actor_login, 'demo');
  db.close();
});
