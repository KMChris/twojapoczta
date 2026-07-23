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

// --- CRUD z kolejnoscia --------------------------------------------------------

import { listRules, createRule, updateRule, deleteRule, moveRule } from '../server/reguly.js';

test('createRule waliduje kryteria i akcje, nadaje kolejne pozycje', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  assert.match(createRule(db, u, { criteria: {}, actions: { archive: true } }).error, /kryterium/);
  assert.match(createRule(db, u, { criteria: { from: 'x' }, actions: {} }).error, /akcj/);
  const pierwsza = createRule(db, u, { name: 'Archiwum faktur', criteria: { from: 'faktury@' }, actions: { archive: true } });
  const druga = createRule(db, u, { criteria: { subject: 'raport' }, actions: { star: true } });
  assert.equal(pierwsza.rule.position, 1);
  assert.equal(druga.rule.position, 2);
  const lista = listRules(db, u.id);
  assert.deepEqual(lista.map((r) => r.name), ['Archiwum faktur', '']);
  assert.deepEqual(lista[0].criteria, { from: 'faktury@' });
  assert.deepEqual(lista[1].actions, { star: true });
  db.close();
});

test('updateRule podmienia pola i pilnuje cudzych regul', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  const { rule } = createRule(db, ala, { criteria: { from: 'x' }, actions: { archive: true } });
  assert.equal(updateRule(db, ala, rule.id, { name: 'Nowa', is_active: 0 }).rule.is_active, 0);
  assert.match(updateRule(db, ala, rule.id, { criteria: {} }).error, /kryterium/);
  assert.ok(updateRule(db, bob, rule.id, { name: 'Cudza' }).notFound);
  db.close();
});

test('updateRule: aktywacja reguly bez akcji odmawia', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const { rule } = createRule(db, u, { criteria: { from: 'x' }, actions: { archive: true } });
  // Symulacja stanu po skasowaniu folderu: cel wyczyszczony, zero akcji, nieaktywna.
  db.prepare("UPDATE rules SET actions = '{}', is_active = 0 WHERE id = ?").run(rule.id);
  assert.match(updateRule(db, u, rule.id, { is_active: 1 }).error, /akcj/);
  assert.equal(listRules(db, u.id)[0].is_active, 0);
  db.close();
});

test('moveRule zamienia pozycje z sasiadem i nie wypada za kraniec', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const a = createRule(db, u, { name: 'A', criteria: { from: 'a' }, actions: { archive: true } }).rule;
  createRule(db, u, { name: 'B', criteria: { from: 'b' }, actions: { archive: true } });
  const c = createRule(db, u, { name: 'C', criteria: { from: 'c' }, actions: { archive: true } }).rule;
  assert.deepEqual(moveRule(db, u.id, c.id, 'up').rules.map((r) => r.name), ['A', 'C', 'B']);
  assert.deepEqual(moveRule(db, u.id, a.id, 'up').rules.map((r) => r.name), ['A', 'C', 'B']);
  assert.deepEqual(moveRule(db, u.id, a.id, 'down').rules.map((r) => r.name), ['C', 'A', 'B']);
  db.close();
});

test('deleteRule kasuje tylko swoje', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  const { rule } = createRule(db, ala, { criteria: { from: 'x' }, actions: { archive: true } });
  assert.ok(deleteRule(db, bob.id, rule.id).notFound);
  assert.ok(deleteRule(db, ala.id, rule.id).deleted);
  assert.equal(listRules(db, ala.id).length, 0);
  db.close();
});
