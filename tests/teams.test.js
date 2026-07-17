// Jednostkowe testy skrzynek zespołowych: skład, prawo wysyłki, CRUD.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, now } from '../server/db.js';
import {
  findTeam, teamById, teamMailboxes, teamMembers, userTeams, canSendAs,
  listTeams, createTeam, renameTeam, deleteTeam, setMember, removeMember,
} from '../server/teams.js';
import { resolveDelivery, addressTaken, sendMessage, SYSTEM_SENDER } from '../server/mail.js';

function konto(db, login) {
  return Number(
    db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(login, login, 'x', now()).lastInsertRowid
  );
}

test('createTeam i findTeam: zespół żyje pod swoją częścią lokalną', () => {
  const db = openMemoryDb();
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  assert.equal(zespol.local_part, 'sprzedaz');
  assert.equal(zespol.name, 'Dział Sprzedaży');
  assert.equal(findTeam(db, 'sprzedaz').id, zespol.id);
  assert.equal(findTeam(db, 'nie-ma'), null);
  assert.equal(teamById(db, zespol.id).name, 'Dział Sprzedaży');
  db.close();
});

test('setMember jest idempotentne i przełącza prawo wysyłki', () => {
  const db = openMemoryDb();
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  const jan = konto(db, 'jan');

  setMember(db, zespol.id, jan, false);
  setMember(db, zespol.id, jan, false);
  assert.equal(teamMembers(db, zespol.id).length, 1, 'dwukrotne dopisanie daje jednego członka');
  assert.equal(teamMembers(db, zespol.id)[0].can_send, false);

  setMember(db, zespol.id, jan, true);
  assert.equal(teamMembers(db, zespol.id).length, 1);
  assert.equal(teamMembers(db, zespol.id)[0].can_send, true, 'can_send wraca jako boolean, nie 1');
  db.close();
});

test('teamMailboxes zwraca wszystkich członków, także zablokowanych', () => {
  const db = openMemoryDb();
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  setMember(db, zespol.id, jan, true);
  setMember(db, zespol.id, ania, false);
  db.prepare('UPDATE users SET is_blocked = 1 WHERE id = ?').run(ania);

  // Poczta na adres wprost też ignoruje blokadę (findMailbox), więc zespół nie filtruje.
  assert.deepEqual(teamMailboxes(db, zespol.id).map((s) => s.login), ['ania', 'jan']);
  assert.deepEqual(teamMailboxes(db, 999), []);
  db.close();
});

test('canSendAs: tylko członek z prawem wysyłki, tylko swój zespół', () => {
  const db = openMemoryDb();
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  const obcy = konto(db, 'obcy');
  setMember(db, zespol.id, jan, true);
  setMember(db, zespol.id, ania, false);

  assert.equal(canSendAs(db, jan, 'sprzedaz').name, 'Dział Sprzedaży');
  assert.equal(canSendAs(db, ania, 'sprzedaz'), null, 'bez prawa wysyłki nie wolno nadawać');
  assert.equal(canSendAs(db, obcy, 'sprzedaz'), null, 'obcy zespół nie istnieje dla nadawcy');
  assert.equal(canSendAs(db, jan, 'nie-ma'), null);
  db.close();
});

test('userTeams pokazuje przynależność konta z prawem wysyłki', () => {
  const db = openMemoryDb();
  const sprzedaz = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  const wsparcie = createTeam(db, { localPart: 'wsparcie', name: 'Wsparcie' });
  const jan = konto(db, 'jan');
  setMember(db, sprzedaz.id, jan, true);
  setMember(db, wsparcie.id, jan, false);

  assert.deepEqual(userTeams(db, jan).map((t) => [t.local_part, t.can_send]), [
    ['sprzedaz', true],
    ['wsparcie', false],
  ]);
  assert.deepEqual(userTeams(db, konto(db, 'sam')), []);
  db.close();
});

test('renameTeam zmienia nazwę, adres zostaje', () => {
  const db = openMemoryDb();
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  assert.equal(renameTeam(db, zespol.id, 'Sprzedaż i Obsługa'), true);
  assert.equal(teamById(db, zespol.id).name, 'Sprzedaż i Obsługa');
  assert.equal(teamById(db, zespol.id).local_part, 'sprzedaz');
  assert.equal(renameTeam(db, 999, 'Nikt'), false);
  db.close();
});

test('kaskady: usunięcie zespołu czyści skład, usunięcie konta wypisuje z zespołów', () => {
  const db = openMemoryDb();
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  setMember(db, zespol.id, jan, true);
  setMember(db, zespol.id, ania, true);

  db.prepare('DELETE FROM users WHERE id = ?').run(ania);
  assert.deepEqual(teamMembers(db, zespol.id).map((m) => m.login), ['jan'], 'konto znika ze składu');

  assert.equal(removeMember(db, zespol.id, jan), true);
  assert.equal(removeMember(db, zespol.id, jan), false, 'drugie wypisanie nic nie zmienia');

  setMember(db, zespol.id, jan, true);
  assert.equal(deleteTeam(db, zespol.id), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM team_members').get().n, 0, 'skład idzie kaskadą');
  assert.equal(deleteTeam(db, 999), false);
  db.close();
});

test('listTeams: zespoły po adresie, każdy ze swoim składem', () => {
  const db = openMemoryDb();
  const wsparcie = createTeam(db, { localPart: 'wsparcie', name: 'Wsparcie' });
  createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, wsparcie.id, konto(db, 'jan'), true);

  const lista = listTeams(db);
  assert.deepEqual(lista.map((t) => t.local_part), ['sprzedaz', 'wsparcie']);
  assert.deepEqual(lista[0].members, [], 'zespół bez członków ma pusty skład, nie null');
  assert.equal(lista[1].members[0].login, 'jan');
  db.close();
});

test('resolveDelivery: konto, alias, zespół i adres nieznany', () => {
  const db = openMemoryDb();
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(jan, 'biuro', now());
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, true);
  setMember(db, zespol.id, ania, false);

  assert.equal(resolveDelivery(db, 'nie-ma'), null);

  const konto1 = resolveDelivery(db, 'jan');
  assert.equal(konto1.kind, 'user');
  assert.equal(konto1.team, null);
  assert.deepEqual(konto1.mailboxes.map((s) => s.login), ['jan']);

  const przezAlias = resolveDelivery(db, 'biuro');
  assert.equal(przezAlias.kind, 'user');
  assert.deepEqual(przezAlias.mailboxes.map((s) => s.login), ['jan']);

  const przezZespol = resolveDelivery(db, 'sprzedaz');
  assert.equal(przezZespol.kind, 'team');
  assert.equal(przezZespol.team.name, 'Dział Sprzedaży');
  assert.deepEqual(przezZespol.mailboxes.map((s) => s.login), ['ania', 'jan']);
  db.close();
});

test('resolveDelivery: zespół bez członków istnieje, ale nie ma dokąd doręczyć', () => {
  const db = openMemoryDb();
  createTeam(db, { localPart: 'pusty', name: 'Pusty' });
  const cel = resolveDelivery(db, 'pusty');
  assert.equal(cel.kind, 'team', 'adres istnieje, więc nie null');
  assert.deepEqual(cel.mailboxes, [], 'ale nikt go nie obsługuje');
  db.close();
});

test('addressTaken: login, alias, zespół i adres systemowy w jednej przestrzeni nazw', () => {
  const db = openMemoryDb();
  const jan = konto(db, 'jan');
  db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(jan, 'biuro', now());
  createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });

  assert.equal(addressTaken(db, 'jan'), true);
  assert.equal(addressTaken(db, 'biuro'), true);
  assert.equal(addressTaken(db, 'sprzedaz'), true);
  // Adres nadawcy listów systemowych jest zastrzeżony nawet bez konta w bazie
  // (przy TP_SEED=0 seed go nie zakłada, a deliverSystemMessage i tak z niego nadaje).
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE login = ?').get(SYSTEM_SENDER.login).n, 0);
  assert.equal(addressTaken(db, SYSTEM_SENDER.login), true);
  assert.equal(addressTaken(db, 'wolny'), false);
  db.close();
});

test('wysyłka na adres zespołu: kopia u każdego członka, to_addr pokazuje zespół', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient Zewnętrzny' };
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, true);
  setMember(db, zespol.id, ania, false);

  const wynik = sendMessage(db, nadawca, { to: 'sprzedaz@twojapoczta.com', subject: 'Pytanie', body: 'Ile?' });
  assert.equal(wynik.error, undefined);

  for (const id of [jan, ania]) {
    const kopia = db.prepare("SELECT * FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(id);
    assert.ok(kopia, 'każdy członek ma kopię');
    assert.equal(kopia.to_addr, 'sprzedaz@twojapoczta.com', 'członek widzi, że list szedł na zespół');
  }
  db.close();
});

test('adresowanie wprost wygrywa nad członkostwem: jedna kopia, nie dwie', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, false);

  sendMessage(db, nadawca, { to: 'jan@twojapoczta.com, sprzedaz@twojapoczta.com', subject: 'Raz', body: 'x' });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(jan).n,
    1,
    'Jan dostaje jedną kopię, choć trafił w kopertę dwa razy'
  );
  db.close();
});

test('zespół bez członków odmawia zamiast po cichu połknąć list', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  createTeam(db, { localPart: 'pusty', name: 'Pusty' });

  const wynik = sendMessage(db, nadawca, { to: 'pusty@twojapoczta.com', subject: 'Halo', body: 'x' });
  assert.match(wynik.error, /nie ma jeszcze członków/);
  db.close();
});

test('pełna skrzynka członka nie blokuje zespołu, pełny zespół owszem', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, false);
  setMember(db, zespol.id, ania, false);
  // Limit 0 MB nie przejdzie walidacji panelu, ale w bazie da się go ustawić;
  // hasRoom liczy bajty, więc to najprostszy sposób na „skrzynka pełna".
  db.prepare('UPDATE users SET quota_mb = 0 WHERE id = ?').run(ania);

  const wynik = sendMessage(db, nadawca, { to: 'sprzedaz@twojapoczta.com', subject: 'Idzie', body: 'x' });
  assert.equal(wynik.error, undefined, 'Ania pełna, ale Jan dostaje list');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(jan).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(ania).n, 0);

  db.prepare('UPDATE users SET quota_mb = 0 WHERE id = ?').run(jan);
  const pelny = sendMessage(db, nadawca, { to: 'sprzedaz@twojapoczta.com', subject: 'Nie idzie', body: 'x' });
  assert.match(pelny.error, /sprzedaz@twojapoczta\.com.*pełna/s, 'błąd mówi o adresie zespołu, nie o koncie członka');
  db.close();
});

test('adresat wpisany wprost z pełną skrzynką dalej daje twardy błąd', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, false);
  db.prepare('UPDATE users SET quota_mb = 0 WHERE id = ?').run(jan);

  const wynik = sendMessage(db, nadawca, {
    to: 'jan@twojapoczta.com, sprzedaz@twojapoczta.com',
    subject: 'x',
    body: 'x',
  });
  assert.match(wynik.error, /jan@twojapoczta\.com/, 'nadawca poprosił o Jana wprost, więc dowiaduje się prawdy');
  db.close();
});

test('adresowanie wprost wygrywa też wtedy, gdy zespół stoi w kopercie pierwszy', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, false);
  db.prepare('UPDATE users SET quota_mb = 0 WHERE id = ?').run(jan);

  // Ta sama koperta co wyżej, tylko odwrócona. Zespół wciąga Jana pierwszy, więc
  // to adres wpisany wprost musi mu odebrać viaTeam; inaczej Jan wypadłby po cichu
  // z rozdzielnika, a nadawca dostałby błąd o zespole zamiast o Janie.
  const wynik = sendMessage(db, nadawca, {
    to: 'sprzedaz@twojapoczta.com, jan@twojapoczta.com',
    subject: 'x',
    body: 'x',
  });
  assert.match(wynik.error, /jan@twojapoczta\.com/, 'kolejność adresów nie zmienia tego, kto odpowiada za skrzynkę');
  db.close();
});
