// Foldery użytkownika: schemat, walidacja nazw, CRUD i usuwanie bez gubienia poczty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, now } from '../server/db.js';
import {
  MAX_FOLDER_NAME, normalizeName, listFolders, createFolder, renameFolder,
} from '../server/folders.js';

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

test('normalizeName przycina i zbija białe znaki', () => {
  assert.equal(normalizeName('  Moje   faktury '), 'Moje faktury');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
});

test('createFolder tworzy folder i nadaje kolejne pozycje', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const pierwszy = createFolder(db, id, 'Faktury');
  assert.equal(pierwszy.folder.name, 'Faktury');
  assert.equal(pierwszy.folder.position, 1);
  assert.equal(createFolder(db, id, 'Umowy').folder.position, 2);
  assert.deepEqual(listFolders(db, id).map((f) => f.name), ['Faktury', 'Umowy']);
  db.close();
});

test('createFolder odrzuca pustą i za długą nazwę', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  assert.match(createFolder(db, id, '   ').error, /Podaj nazwę/);
  assert.match(createFolder(db, id, 'x'.repeat(MAX_FOLDER_NAME + 1)).error, /najwyżej/);
  assert.equal(listFolders(db, id).length, 0);
  db.close();
});

// SQLite składa wielkość liter tylko dla ASCII, więc bez fałdowania w JS
// „Łódź" i „łódź" przeszłyby jako dwa foldery. To jest test tej pułapki.
test('createFolder składa wielkość liter, także dla polskich znaków', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  createFolder(db, id, 'Faktury');
  assert.match(createFolder(db, id, 'faktury').error, /Masz już folder/);
  assert.match(createFolder(db, id, 'FAKTURY').error, /Masz już folder/);
  createFolder(db, id, 'Łódź');
  assert.match(createFolder(db, id, 'łódź').error, /Masz już folder/);
  assert.match(createFolder(db, id, 'ŁÓDŹ').error, /Masz już folder/);
  assert.equal(listFolders(db, id).length, 2);
  db.close();
});

test('createFolder nie pozwala udawać folderu wbudowanego', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  assert.match(createFolder(db, id, 'Archiwum').error, /wbudowanego/);
  assert.match(createFolder(db, id, 'kosz').error, /wbudowanego/);
  assert.match(createFolder(db, id, 'Wersje robocze').error, /wbudowanego/);
  db.close();
});

test('createFolder: ta sama nazwa na dwóch kontach jest w porządku', () => {
  const db = openMemoryDb();
  const a = konto(db, 'ala');
  const b = konto(db, 'bob');
  assert.ok(createFolder(db, a, 'Faktury').folder);
  assert.ok(createFolder(db, b, 'Faktury').folder);
  db.close();
});

test('renameFolder zmienia nazwę, pilnuje kolizji i cudzych folderów', () => {
  const db = openMemoryDb();
  const a = konto(db, 'ala');
  const b = konto(db, 'bob');
  const f = createFolder(db, a, 'Faktury').folder;
  createFolder(db, a, 'Umowy');

  assert.equal(renameFolder(db, a, f.id, 'Rachunki').folder.name, 'Rachunki');
  assert.match(renameFolder(db, a, f.id, 'umowy').error, /Masz już folder/);
  // Zmiana na własną nazwę (tylko inna wielkość liter) nie jest kolizją ze sobą.
  assert.equal(renameFolder(db, a, f.id, 'RACHUNKI').folder.name, 'RACHUNKI');

  const obcy = renameFolder(db, b, f.id, 'Cudze');
  assert.ok(obcy.notFound);
  assert.equal(listFolders(db, a).find((x) => x.id === f.id).name, 'RACHUNKI');
  db.close();
});
