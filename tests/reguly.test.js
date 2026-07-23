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

// --- Walidacja akcji -----------------------------------------------------------

import { walidujAkcje } from '../server/reguly.js';
import { setForwarding } from '../server/mail.js';

function uzytkownik(db, login) {
  const id = konto(db, login);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

test('akcje: pusty zestaw to błąd, nie cicha awaria', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  assert.match(walidujAkcje(db, u, {}).error, /przynajmniej jedn/i);
  assert.match(walidujAkcje(db, u, { archive: false, markRead: '' }).error, /przynajmniej jedn/i);
  db.close();
});

test('akcje: flagi boolowskie i priorytet z listy', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const { akcje } = walidujAkcje(db, u, {
    archive: true, markRead: 'true', star: 1, delete: true, neverSpam: true, priority: 'always',
  });
  assert.deepEqual(akcje, { archive: true, markRead: true, star: true, delete: true, neverSpam: true, priority: 'always' });
  assert.equal(walidujAkcje(db, u, { priority: 'never' }).akcje.priority, 'never');
  assert.match(walidujAkcje(db, u, { priority: 'czasem' }).error, /priorytet/i);
  db.close();
});

test('akcje: moveTo musi wskazywać własny folder', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  db.prepare('INSERT INTO folders (user_id, name, position, created_at) VALUES (?, ?, 1, ?)')
    .run(ala.id, 'Faktury', now());
  const folderId = db.prepare('SELECT id FROM folders WHERE user_id = ?').get(ala.id).id;
  assert.equal(walidujAkcje(db, ala, { moveTo: String(folderId) }).akcje.moveTo, folderId);
  assert.match(walidujAkcje(db, bob, { moveTo: folderId }).error, /folder/i);
  assert.match(walidujAkcje(db, ala, { moveTo: 9999 }).error, /folder/i);
  db.close();
});

test('akcje: forwardTo tą samą ścieżką co przekierowanie skrzynki', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  uzytkownik(db, 'bob');
  delete process.env.TP_EXTERNAL;
  assert.equal(walidujAkcje(db, ala, { forwardTo: 'Bob@twojapoczta.com ' }).akcje.forwardTo, 'bob@twojapoczta.com');
  assert.match(walidujAkcje(db, ala, { forwardTo: 'nikt@twojapoczta.com' }).error, /Nie znaleziono/);
  assert.match(walidujAkcje(db, ala, { forwardTo: 'ala@twojapoczta.com' }).error, /własny/);
  assert.match(walidujAkcje(db, ala, { forwardTo: 'obcy@example.com' }).error, /doręcza pocztę tylko/);
  db.close();
});

test('setForwarding po refaktorze odmawia jak dotąd', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  assert.match(setForwarding(db, ala, { to: 'ala@twojapoczta.com' }).error, /własny/);
  assert.match(setForwarding(db, ala, { to: 'nikt@twojapoczta.com' }).error, /Nie znaleziono/);
  assert.equal(setForwarding(db, ala, { to: '' }).forwarding.to, '');
  db.close();
});
