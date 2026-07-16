// Foldery użytkownika: schemat, walidacja nazw, CRUD i usuwanie bez gubienia poczty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, now } from '../server/db.js';
import {
  MAX_FOLDER_NAME, normalizeName, listFolders, createFolder, renameFolder, deleteFolder,
} from '../server/folders.js';
import { listMessages, updateMessage, unreadCounts, deleteMessage, BUILTIN_FOLDERS } from '../server/mail.js';

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

// Wiadomość w folderze własnym: wartownik + folder_id. Wstawiamy wprost,
// bo mail.js dostaje o tym wiedzieć dopiero w Task 4.
function wiadomoscWFolderze(db, ownerId, folderId, { folder = 'custom' } = {}) {
  return Number(
    db.prepare(
      `INSERT INTO messages (owner_id, folder, folder_id, from_addr, subject, sent_at)
       VALUES (?, ?, ?, 'kto@example.com', 'Temat', ?)`
    ).run(ownerId, folder, folderId, now()).lastInsertRowid
  );
}

test('deleteFolder przenosi wiadomości do Archiwum, nie do Odebranych', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  wiadomoscWFolderze(db, id, f.id);
  wiadomoscWFolderze(db, id, f.id);

  const wynik = deleteFolder(db, id, f.id);
  assert.equal(wynik.moved, 2);
  assert.equal(wynik.name, 'Faktury');
  assert.equal(listFolders(db, id).length, 0);

  const wiersze = db.prepare('SELECT folder, folder_id FROM messages WHERE owner_id = ?').all(id);
  assert.equal(wiersze.length, 2, 'żadna wiadomość nie może zniknąć');
  for (const w of wiersze) {
    assert.equal(w.folder, 'archive');
    assert.equal(w.folder_id, null, 'folder_id musi zejść razem z folderem');
  }
  db.close();
});

test('deleteFolder nie rusza wiadomości w koszu, których folder_id jest już NULL', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  // Wiadomość wyrzucona do kosza z tego folderu: folder='trash', folder_id już NULL.
  const wKoszu = wiadomoscWFolderze(db, id, null, { folder: 'trash' });
  wiadomoscWFolderze(db, id, f.id);

  assert.equal(deleteFolder(db, id, f.id).moved, 1);
  assert.equal(db.prepare('SELECT folder FROM messages WHERE id = ?').get(wKoszu).folder, 'trash');
  db.close();
});

test('deleteFolder woli głośny błąd niż ciche wskrzeszenie listu z kosza', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  // Stan łamiący niezmiennik: w koszu, ale folder_id wciąż wskazuje folder.
  // Strażnik „AND folder = 'custom'" pomija taki wiersz w UPDATE, więc DELETE
  // trafia na klucz obcy i cała transakcja się wycofuje. O to chodzi:
  // wolimy hałas niż wiadomość, która sama wraca z kosza do Archiwum.
  db.prepare(
    `INSERT INTO messages (owner_id, folder, folder_id, from_addr, subject, sent_at)
     VALUES (?, 'trash', ?, 'kto@example.com', 'Temat', ?)`
  ).run(id, f.id, now());

  assert.throws(() => deleteFolder(db, id, f.id), /FOREIGN KEY|constraint/i);
  assert.equal(listFolders(db, id).length, 1, 'transakcja musi się wycofać');
  db.close();
});

test('deleteFolder pustego folderu przenosi zero wiadomości', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Pusty').folder;
  assert.equal(deleteFolder(db, id, f.id).moved, 0);
  db.close();
});

test('deleteFolder nie dotyka cudzego folderu', () => {
  const db = openMemoryDb();
  const a = konto(db, 'ala');
  const b = konto(db, 'bob');
  const f = createFolder(db, a, 'Faktury').folder;
  assert.ok(deleteFolder(db, b, f.id).notFound);
  assert.equal(listFolders(db, a).length, 1);
  db.close();
});

test('listFolders liczy wiadomości w folderze', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  assert.equal(listFolders(db, id)[0].count, 0);
  wiadomoscWFolderze(db, id, f.id);
  assert.equal(listFolders(db, id)[0].count, 1);
  db.close();
});

test('listMessages zwraca wiadomości z folderu własnego po folderId', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  const g = createFolder(db, id, 'Umowy').folder;
  wiadomoscWFolderze(db, id, f.id);
  wiadomoscWFolderze(db, id, g.id);

  assert.equal(listMessages(db, id, { folderId: f.id }).length, 1);
  assert.equal(listMessages(db, id, { folderId: g.id }).length, 1);
  // Bez folderId Odebrane zostają puste: obie wiadomości są w folderach własnych.
  assert.equal(listMessages(db, id, { folder: 'inbox' }).length, 0);
  db.close();
});

// Wartownik jest wartością wewnętrzną, nie folderem do przeglądania.
test('listMessages nie pozwala przeglądać wszystkiego przez folder=custom', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  wiadomoscWFolderze(db, id, f.id);
  assert.deepEqual(listMessages(db, id, { folder: 'custom' }), []);
  assert.ok(!BUILTIN_FOLDERS.includes('custom'));
  db.close();
});

test('listMessages: gwiazdka pokazuje też wiadomości z folderów własnych', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  const w = wiadomoscWFolderze(db, id, f.id);
  db.prepare('UPDATE messages SET is_starred = 1 WHERE id = ?').run(w);
  assert.equal(listMessages(db, id, { folder: 'starred' }).length, 1);
  db.close();
});

test('updateMessage przenosi do folderu własnego i ustawia wartownika sam', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  const w = wiadomoscWFolderze(db, id, null, { folder: 'inbox' });

  const po = updateMessage(db, id, w, { folder_id: f.id });
  assert.equal(po.folder, 'custom');
  assert.equal(po.folder_id, f.id);
  db.close();
});

// To jest ta pułapka: gołe folder='custom' zostawiłoby wiadomość nigdzie.
test('updateMessage odrzuca folder=custom bez wskazania folderu', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const w = wiadomoscWFolderze(db, id, null, { folder: 'inbox' });
  assert.equal(updateMessage(db, id, w, { folder: 'custom' }), null);
  assert.equal(db.prepare('SELECT folder FROM messages WHERE id = ?').get(w).folder, 'inbox');
  db.close();
});

test('updateMessage odrzuca cudzy folder', () => {
  const db = openMemoryDb();
  const a = konto(db, 'ala');
  const b = konto(db, 'bob');
  const cudzy = createFolder(db, b, 'Cudze').folder;
  const w = wiadomoscWFolderze(db, a, null, { folder: 'inbox' });
  assert.equal(updateMessage(db, a, w, { folder_id: cudzy.id }), null);
  assert.equal(db.prepare('SELECT folder FROM messages WHERE id = ?').get(w).folder, 'inbox');
  db.close();
});

test('updateMessage: powrót do folderu wbudowanego zeruje folder_id', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  const w = wiadomoscWFolderze(db, id, f.id);
  const po = updateMessage(db, id, w, { folder: 'inbox' });
  assert.equal(po.folder, 'inbox');
  assert.equal(po.folder_id, null);
  db.close();
});

// Bez tego usunięcie folderu wskrzesiłoby wiadomości z kosza do Archiwum.
test('deleteMessage zeruje folder_id przy przenoszeniu do kosza', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  const w = wiadomoscWFolderze(db, id, f.id);
  deleteMessage(db, id, w);
  const po = db.prepare('SELECT folder, folder_id FROM messages WHERE id = ?').get(w);
  assert.equal(po.folder, 'trash');
  assert.equal(po.folder_id, null);
  db.close();
});

test('unreadCounts liczy nieprzeczytane w folderach własnych', () => {
  const db = openMemoryDb();
  const id = konto(db, 'ala');
  const f = createFolder(db, id, 'Faktury').folder;
  const przeczytana = wiadomoscWFolderze(db, id, f.id);
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(przeczytana);
  wiadomoscWFolderze(db, id, f.id);

  const liczniki = unreadCounts(db, id);
  assert.equal(liczniki.custom[f.id], 1);
  assert.equal(liczniki.inbox, 0);
  db.close();
});
