// Foldery użytkownika: schemat, walidacja nazw, CRUD i usuwanie bez gubienia poczty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, now } from '../server/db.js';

// Konto pod testy: minimum kolumn, resztę dosypuje schemat.
function konto(db, login) {
  return Number(
    db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(login, login, 'x', now()).lastInsertRowid
  );
}

test('schemat: tabela folders i kolumna messages.folder_id', () => {
  const db = openMemoryDb();
  const kolumny = db.prepare('PRAGMA table_info(folders)').all().map((k) => k.name);
  assert.deepEqual(kolumny, ['id', 'user_id', 'name', 'position', 'created_at']);
  const wiadomosci = db.prepare('PRAGMA table_info(messages)').all().map((k) => k.name);
  assert.ok(wiadomosci.includes('folder_id'), 'messages musi mieć folder_id');
  db.close();
});

test('schemat: UNIQUE(user_id, name) blokuje duplikat w koncie, ale nie między kontami', () => {
  const db = openMemoryDb();
  const a = konto(db, 'ala');
  const b = konto(db, 'bob');
  const wstaw = (userId, name) =>
    db.prepare('INSERT INTO folders (user_id, name, position, created_at) VALUES (?, ?, 0, ?)')
      .run(userId, name, now());
  wstaw(a, 'Faktury');
  assert.throws(() => wstaw(a, 'Faktury'), /UNIQUE|constraint/i);
  wstaw(b, 'Faktury'); // inne konto: wolno
  db.close();
});

test('schemat: usunięcie konta kasuje jego foldery', () => {
  const db = openMemoryDb();
  const id = konto(db, 'znikam');
  db.prepare('INSERT INTO folders (user_id, name, position, created_at) VALUES (?, ?, 0, ?)')
    .run(id, 'Faktury', now());
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM folders').get().n, 0);
  db.close();
});
