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

// --- Silnik ---------------------------------------------------------------------

import { applyRules } from '../server/reguly.js';

function wiadomoscW(db, ownerId, nadpisy = {}) {
  const w = {
    folder: 'inbox', folder_id: null, from_name: '', from_addr: 'kto@example.com',
    to_addr: '', cc_addr: '', subject: 'Temat', body: 'Tresc',
    is_read: 0, is_starred: 0, is_priority: 0, attachments_count: 0, sent_at: now(),
    ...nadpisy,
  };
  return Number(db.prepare(
    `INSERT INTO messages (owner_id, folder, folder_id, from_name, from_addr, to_addr, cc_addr,
                           subject, body, is_read, is_starred, is_priority, attachments_count, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ownerId, w.folder, w.folder_id, w.from_name, w.from_addr, w.to_addr, w.cc_addr,
        w.subject, w.body, w.is_read, w.is_starred, w.is_priority, w.attachments_count, w.sent_at).lastInsertRowid);
}

function poId(db, id) {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

test('silnik: dopasowanie i akcje jednej reguly', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  createRule(db, u, { criteria: { from: 'faktury@' }, actions: { markRead: true, star: true } });
  const trafiona = wiadomoscW(db, u.id, { from_addr: 'faktury@firma.com' });
  const obok = wiadomoscW(db, u.id, { from_addr: 'inny@firma.com' });
  assert.equal(applyRules(db, u.id, trafiona).matched, 1);
  assert.equal(applyRules(db, u.id, obok).matched, 0);
  assert.deepEqual([poId(db, trafiona).is_read, poId(db, trafiona).is_starred], [1, 1]);
  assert.deepEqual([poId(db, obok).is_read, poId(db, obok).is_starred], [0, 0]);
  db.close();
});

test('silnik: nieaktywna regula nie dziala', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const { rule } = createRule(db, u, { criteria: { from: 'x@' }, actions: { archive: true } });
  updateRule(db, u, rule.id, { is_active: 0 });
  const id = wiadomoscW(db, u.id, { from_addr: 'x@example.com' });
  assert.equal(applyRules(db, u.id, id).matched, 0);
  assert.equal(poId(db, id).folder, 'inbox');
  db.close();
});

test('silnik: precedencja celu, kolejnosc regul bez znaczenia', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  db.prepare('INSERT INTO folders (user_id, name, position, created_at) VALUES (?, ?, 1, ?)').run(u.id, 'Faktury', now());
  const folderId = db.prepare('SELECT id FROM folders WHERE user_id = ?').get(u.id).id;

  createRule(db, u, { criteria: { from: 'a@' }, actions: { delete: true } });
  createRule(db, u, { criteria: { from: 'a@' }, actions: { moveTo: folderId } });
  const skasowana = wiadomoscW(db, u.id, { from_addr: 'a@example.com' });
  applyRules(db, u.id, skasowana);
  assert.deepEqual([poId(db, skasowana).folder, poId(db, skasowana).folder_id], ['trash', null]);

  createRule(db, u, { criteria: { from: 'b@' }, actions: { archive: true } });
  createRule(db, u, { criteria: { from: 'b@' }, actions: { moveTo: folderId } });
  const przeniesiona = wiadomoscW(db, u.id, { from_addr: 'b@example.com' });
  applyRules(db, u.id, przeniesiona);
  assert.deepEqual([poId(db, przeniesiona).folder, poId(db, przeniesiona).folder_id], ['custom', folderId]);
  db.close();
});

test('silnik: sprzeczny priorytet rozstrzyga wyzsza pozycja', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  createRule(db, u, { criteria: { from: 'vip@' }, actions: { priority: 'always' } });
  createRule(db, u, { criteria: { subject: 'spamik' }, actions: { priority: 'never' } });
  const obie = wiadomoscW(db, u.id, { from_addr: 'vip@example.com', subject: 'spamik w temacie' });
  applyRules(db, u.id, obie);
  assert.equal(poId(db, obie).is_priority, 0, 'pozniej zdefiniowana regula (wyzsza pozycja) wygrywa');
  db.close();
});

test('silnik: zepsuta regula jest pomijana i nie blokuje pozostalych', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const zepsuta = createRule(db, u, { criteria: { from: 'x@' }, actions: { archive: true } }).rule;
  db.prepare(`UPDATE rules SET criteria = '{"folder":"nieistnieje"}' WHERE id = ?`).run(zepsuta.id);
  createRule(db, u, { criteria: { from: 'x@' }, actions: { star: true } });
  const id = wiadomoscW(db, u.id, { from_addr: 'x@example.com' });
  assert.equal(applyRules(db, u.id, id).matched, 1);
  assert.equal(poId(db, id).is_starred, 1);
  assert.equal(poId(db, id).folder, 'inbox');
  db.close();
});

test('silnik: forwardTo kopiuje do lokalnej skrzynki i zostawia oryginal', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  createRule(db, ala, { criteria: { subject: 'kopia' }, actions: { forwardTo: 'bob@twojapoczta.com' } });
  const id = wiadomoscW(db, ala.id, { subject: 'kopia dla boba', body: 'tresc' });
  applyRules(db, ala.id, id);
  assert.equal(poId(db, id).folder, 'inbox', 'oryginal zostaje');
  const uBoba = db.prepare('SELECT * FROM messages WHERE owner_id = ?').all(bob.id);
  assert.equal(uBoba.length, 1);
  assert.equal(uBoba[0].subject, 'kopia dla boba');
  assert.equal(uBoba[0].folder, 'inbox');
  db.close();
});

test('silnik: reguly nie odpalaja sie na kopii z przekazania, petla A-B-A gasnie', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  createRule(db, ala, { criteria: { subject: 'ping' }, actions: { forwardTo: 'bob@twojapoczta.com' } });
  createRule(db, bob, { criteria: { subject: 'ping' }, actions: { forwardTo: 'ala@twojapoczta.com' } });
  const id = wiadomoscW(db, ala.id, { subject: 'ping' });
  applyRules(db, ala.id, id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ?').get(bob.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ?').get(ala.id).n, 1, 'nic nie wrocilo do Ali');
  db.close();
});

test('silnik: skipForward zbiera przekazania, ale ich nie wykonuje', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  createRule(db, ala, { criteria: { subject: 'wsad' }, actions: { forwardTo: 'bob@twojapoczta.com', star: true } });
  const id = wiadomoscW(db, ala.id, { subject: 'wsad' });
  const wynik = applyRules(db, ala.id, id, { skipForward: true });
  assert.equal(wynik.skippedForward, 1);
  assert.equal(poId(db, id).is_starred, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ?').get(bob.id).n, 0);
  db.close();
});
