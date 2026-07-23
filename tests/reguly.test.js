// Reguły wiadomości: schemat, walidacja akcji, CRUD, silnik i przebieg wsadowy.
// Dopasowanie reguły to TEN SAM SQL co wyszukiwarka (kryteria.js) + AND id = ?.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, now } from '../server/db.js';

function konto(db, login) {
  return Number(
    db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(login, login, 'x', now()).lastInsertRowid
  );
}

test('schemat: tabela rules i jej kolumny', () => {
  const db = openMemoryDb();
  const kolumny = db.prepare('PRAGMA table_info(rules)').all().map((k) => k.name);
  assert.deepEqual(kolumny, ['id', 'user_id', 'name', 'criteria', 'actions', 'is_active', 'position', 'created_at']);
  db.close();
});

test('schemat: usunięcie konta kasuje jego reguły', () => {
  const db = openMemoryDb();
  const id = konto(db, 'znikam');
  db.prepare(
    "INSERT INTO rules (user_id, criteria, actions, created_at) VALUES (?, '{}', '{}', ?)"
  ).run(id, now());
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rules').get().n, 0);
  db.close();
});
