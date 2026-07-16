// Jednostkowe testy limitu aliasów: odczyt limitu konta, liczenie i polska odmiana.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, now } from '../server/db.js';
import { aliasLimit, aliasCount, aliasesWord, DEFAULT_ALIAS_LIMIT } from '../server/aliases.js';

function konto(db, login, { limit = undefined } = {}) {
  const id = Number(
    db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(login, login, 'x', now()).lastInsertRowid
  );
  if (limit !== undefined) db.prepare('UPDATE users SET alias_limit = ? WHERE id = ?').run(limit, id);
  return id;
}

test('aliasLimit: nowe konto dostaje domyślny limit, NULL znaczy bez limitu', () => {
  const db = openMemoryDb();
  assert.equal(aliasLimit(db, konto(db, 'domyslny')), DEFAULT_ALIAS_LIMIT);
  assert.equal(aliasLimit(db, konto(db, 'wlasny', { limit: 12 })), 12);
  assert.equal(aliasLimit(db, konto(db, 'zero', { limit: 0 })), 0);
  assert.equal(aliasLimit(db, konto(db, 'bez.limitu', { limit: null })), null);
  db.close();
});

test('aliasCount liczy aliasy konta', () => {
  const db = openMemoryDb();
  const id = konto(db, 'liczony');
  assert.equal(aliasCount(db, id), 0);
  for (const alias of ['biuro', 'sklep']) {
    db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(id, alias, now());
  }
  assert.equal(aliasCount(db, id), 2);
  db.close();
});

test('aliasesWord odmienia liczebnik po polsku', () => {
  assert.equal(aliasesWord(1), 'alias');
  assert.equal(aliasesWord(2), 'aliasy');
  assert.equal(aliasesWord(4), 'aliasy');
  assert.equal(aliasesWord(5), 'aliasów');
  assert.equal(aliasesWord(0), 'aliasów');
  // Nastolatki idą z dopełniaczem, mimo końcówki 2–4.
  assert.equal(aliasesWord(12), 'aliasów');
  assert.equal(aliasesWord(14), 'aliasów');
  assert.equal(aliasesWord(22), 'aliasy');
  assert.equal(aliasesWord(25), 'aliasów');
  assert.equal(aliasesWord(100), 'aliasów');
});
