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

// --- Wpiecie w doreczanie i przebieg wsadowy ------------------------------------

import { applyRuleToExisting } from '../server/reguly.js';
import { deliverInbound, sendMessage, deliverSystemMessage, listMessages } from '../server/mail.js';

test('doreczenie z SMTP przechodzi przez reguly, a przekierowanie skrzynki milknie po archiwizacji', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  setForwarding(db, ala, { to: 'bob@twojapoczta.com', keepCopy: true });
  createRule(db, ala, { criteria: { from: 'newsletter@' }, actions: { archive: true, markRead: true } });

  const id = deliverInbound(db, ala.id, {
    from: { name: 'Gazetka', addr: 'newsletter@example.com' },
    subject: 'Wydanie 7', body: 'tresc', html: '', attachments: [],
  }, { toAddr: 'ala@twojapoczta.com' });

  const list = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  assert.equal(list.folder, 'archive');
  assert.equal(list.is_read, 1);
  // forwardDelivered sprawdza folder w bazie: zarchiwizowany list nie jedzie do Boba.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ?').get(bob.id).n, 0);
  db.close();
});

test('wysylka wewnetrzna: reguly dzialaja u odbiorcy, nie u nadawcy', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  createRule(db, bob, { criteria: { subject: 'oferta' }, actions: { delete: true } });
  createRule(db, ala, { criteria: { subject: 'oferta' }, actions: { star: true } });

  sendMessage(db, ala, { to: 'bob@twojapoczta.com', subject: 'oferta specjalna', body: 'tresc' });

  const uBoba = db.prepare(`SELECT * FROM messages WHERE owner_id = ? AND folder != 'sent'`).all(bob.id);
  assert.equal(uBoba.length, 1);
  assert.equal(uBoba[0].folder, 'trash', 'regula Boba skasowala');
  const wyslana = db.prepare(`SELECT * FROM messages WHERE owner_id = ? AND folder = 'sent'`).get(ala.id);
  assert.equal(wyslana.is_starred, 0, 'reguly nie ruszaja kopii w Wyslanych');
  db.close();
});

test('wiadomosci systemowe nie przechodza przez reguly', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  createRule(db, u, { criteria: { has: 'Zwrot' }, actions: { delete: true } });
  deliverSystemMessage(db, u.id, { subject: 'Zwrot do nadawcy: test', body: 'Zwrot' });
  const list = db.prepare('SELECT * FROM messages WHERE owner_id = ?').get(u.id);
  assert.equal(list.folder, 'inbox', 'zwrot zostal w Odebranych mimo reguly usun');
  db.close();
});

test('przebieg wsadowy stosuje akcje bez przekazywania dalej', () => {
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  wiadomoscW(db, ala.id, { subject: 'faktura 1', folder: 'inbox' });
  wiadomoscW(db, ala.id, { subject: 'faktura 2', folder: 'archive' });
  wiadomoscW(db, ala.id, { subject: 'faktura 3', folder: 'trash' });
  wiadomoscW(db, ala.id, { subject: 'inny temat' });
  const { rule } = createRule(db, ala, {
    criteria: { subject: 'faktura' },
    actions: { markRead: true, forwardTo: 'bob@twojapoczta.com' },
  });

  const wynik = applyRuleToExisting(db, ala, rule.id);
  assert.equal(wynik.applied, 2, 'inbox + archive; kosz poza domyslnym zasiegiem kryteriow');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND is_read = 1').get(ala.id).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ?').get(bob.id).n, 0, 'zero przekazan');
  db.close();
});

test('przebieg wsadowy na wylaczonej regule odmawia', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const { rule } = createRule(db, u, { criteria: { subject: 'x' }, actions: { star: true } });
  updateRule(db, u, rule.id, { is_active: 0 });
  assert.match(applyRuleToExisting(db, u, rule.id).error, /wyłączona/i);
  db.close();
});

test('ta sama sciezka: werdykt wsadowy rowna sie werdyktowi wyszukiwarki', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const wSpamie = wiadomoscW(db, u.id, { from_addr: 'faktury@firma.com', subject: 'Faktura 9', folder: 'spam' });
  wiadomoscW(db, u.id, { from_addr: 'faktury@firma.com', subject: 'Faktura 7' });
  wiadomoscW(db, u.id, { from_addr: 'faktury@firma.com', subject: 'Newsletter' });
  wiadomoscW(db, u.id, { from_addr: 'inni@firma.com', subject: 'Faktura 8' });
  const kryteria = { from: 'faktury@', subject: 'faktura' };
  const { rule } = createRule(db, u, { criteria: kryteria, actions: { star: true } });
  applyRuleToExisting(db, u, rule.id);

  const zSilnika = new Set(
    db.prepare('SELECT id FROM messages WHERE owner_id = ? AND is_starred = 1').all(u.id).map((r) => r.id)
  );
  const zWyszukiwarki = new Set(listMessages(db, u.id, { kryteria }).map((r) => r.id));
  assert.deepEqual(zSilnika, zWyszukiwarki, 'jedna sciezka kodu: silnik == wyszukiwarka');
  assert.ok(zSilnika.size > 0, 'cos naprawde zostalo oznaczone');
  assert.ok(!zSilnika.has(wSpamie), 'spam poza domyslnym zasiegiem obu');
  db.close();
});

test('updateRule podmienia akcje z pelna walidacja', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const { rule } = createRule(db, u, { criteria: { from: 'x' }, actions: { archive: true } });
  const po = updateRule(db, u, rule.id, { actions: { star: true, markRead: true } });
  assert.deepEqual(po.rule.actions, { star: true, markRead: true });
  assert.match(updateRule(db, u, rule.id, { actions: {} }).error, /akcj/);
  assert.deepEqual(listRules(db, u.id)[0].actions, { star: true, markRead: true }, 'bledny patch niczego nie zmienil');
  db.close();
});

test('silnik: regula z niepoprawnym JSON-em jest pomijana', () => {
  const db = openMemoryDb();
  const u = uzytkownik(db, 'ala');
  const zepsuta = createRule(db, u, { criteria: { from: 'x@' }, actions: { archive: true } }).rule;
  db.prepare(`UPDATE rules SET criteria = 'to nie jest json' WHERE id = ?`).run(zepsuta.id);
  createRule(db, u, { criteria: { from: 'x@' }, actions: { star: true } });
  const id = wiadomoscW(db, u.id, { from_addr: 'x@example.com' });
  assert.equal(applyRules(db, u.id, id).matched, 1);
  assert.equal(poId(db, id).is_starred, 1);
  db.close();
});

test('nadanie zaplanowanej wysylki tez przechodzi przez reguly odbiorcy', async () => {
  const { fireScheduled } = await import('../server/mail.js');
  const db = openMemoryDb();
  const ala = uzytkownik(db, 'ala');
  const bob = uzytkownik(db, 'bob');
  createRule(db, bob, { criteria: { subject: 'terminowa' }, actions: { star: true, markRead: true } });
  // Zaplanowana z terminem w przeszlosci: straznik podejmie ja od reki.
  db.prepare(
    `INSERT INTO messages (owner_id, folder, from_name, from_addr, to_addr, subject, body,
                           is_read, scheduled_at, sent_at)
     VALUES (?, 'scheduled', 'Ala', 'ala@twojapoczta.com', 'bob@twojapoczta.com', 'terminowa', 'tresc',
             1, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`
  ).run(ala.id);
  assert.equal(fireScheduled(db), 1);
  const uBoba = db.prepare('SELECT * FROM messages WHERE owner_id = ?').get(bob.id);
  assert.equal(uBoba.is_starred, 1, 'regula Boba zadzialala na kopii z zaplanowanej wysylki');
  assert.equal(uBoba.is_read, 1);
  db.close();
});
