// Jednostkowe testy skrzynek zespołowych: skład, prawo wysyłki, CRUD.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb, now } from '../server/db.js';
import {
  findTeam, teamById, teamMailboxes, teamMembers, userTeams, canSendAs,
  listTeams, createTeam, renameTeam, deleteTeam, setMember, removeMember,
} from '../server/teams.js';
import {
  resolveDelivery, addressTaken, resolveSender, saveDraft, sendMessage, fireScheduled,
  setForwarding, getForwarding, SYSTEM_SENDER,
} from '../server/mail.js';

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

  const wynik = sendMessage(db, nadawca, { to: 'jan@twojapoczta.com, sprzedaz@twojapoczta.com', subject: 'Raz', body: 'x' });
  assert.equal(wynik.error, undefined);
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
  assert.match(pelny.error, /sprzedaz@twojapoczta\.com.*pełna/s, 'błąd mówi o adresie zespołu…');
  assert.doesNotMatch(pelny.error, /jan@|ania@/, '…i nie zdradza nadawcy, kto siedzi w zespole');
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

test('członek wpisany wprost trzyma swój zespół w zasięgu', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, false);
  setMember(db, zespol.id, ania, false);
  db.prepare('UPDATE users SET quota_mb = 0 WHERE id = ?').run(ania);

  // Zasięg zespołu liczy się po jego prawdziwym składzie, nie po tym, co zostało
  // z viaTeam: adres wprost zabiera je Janowi, więc licząc po nim w grupie zostaje
  // sama pełna Ania i wysyłka pada, choć jest komu doręczyć.
  const wprostPierwszy = sendMessage(db, nadawca, {
    to: 'jan@twojapoczta.com, sprzedaz@twojapoczta.com',
    subject: 'Idzie',
    body: 'x',
  });
  assert.equal(wprostPierwszy.error, undefined, 'Ania pełna, ale Jan ma miejsce i jest w zespole');

  const zespolPierwszy = sendMessage(db, nadawca, {
    to: 'sprzedaz@twojapoczta.com, jan@twojapoczta.com',
    subject: 'Też idzie',
    body: 'x',
  });
  assert.equal(zespolPierwszy.error, undefined, 'kolejność adresów nie zmienia zasięgu zespołu');

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(jan).n,
    2,
    'Jan dostaje oba listy'
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(ania).n, 0);
  db.close();
});

test('drugi zespół w kopercie odmawia, zamiast zniknąć w deduplikacji', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  const sprzedaz = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  const wsparcie = createTeam(db, { localPart: 'wsparcie', name: 'Wsparcie' });
  setMember(db, sprzedaz.id, jan, false);
  setMember(db, sprzedaz.id, ania, false);
  setMember(db, wsparcie.id, jan, false);
  db.prepare('UPDATE users SET quota_mb = 0 WHERE id = ?').run(jan);

  // Jan należy do obu zespołów, ale w rozdzielniku zostaje raz, z viaTeam tego
  // pierwszego z koperty. Wsparcie ma tylko jego i nie ma dokąd doręczyć, więc
  // nadawca musi dostać błąd zamiast cichego „wysłano".
  const wynik = sendMessage(db, nadawca, {
    to: 'sprzedaz@twojapoczta.com, wsparcie@twojapoczta.com',
    subject: 'Halo',
    body: 'x',
  });
  assert.ok(wynik.error, 'zespół, do którego nikt nie odbierze, nie może zostać połknięty po cichu');
  assert.match(wynik.error, /wsparcie@twojapoczta\.com.*pełna/s, 'błąd nazywa nieosiągalny zespół');
  assert.doesNotMatch(wynik.error, /jan@|ania@/, 'i nie zdradza składu zespołu');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(ania).n,
    0,
    'odmowa jest całkowita: nikt nie dostaje kopii'
  );
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

test('zaplanowany list na adres zespołu rozchodzi się do członków', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, false);
  setMember(db, zespol.id, ania, false);

  sendMessage(db, nadawca, {
    to: 'sprzedaz@twojapoczta.com',
    subject: 'Za chwilę',
    body: 'x',
    scheduledAt: new Date(Date.now() + 1000).toISOString(),
  });
  // Cofamy termin zamiast czekać: strażnik patrzy wyłącznie na scheduled_at.
  db.prepare("UPDATE messages SET scheduled_at = ? WHERE folder = 'scheduled'").run(new Date(Date.now() - 1000).toISOString());
  assert.equal(fireScheduled(db), 1);

  for (const id of [jan, ania]) {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(id).n,
      1,
      'członek dostaje zaplanowany list'
    );
  }
  db.close();
});

test('zaplanowany list na pusty zespół wraca zwrotem, nie znika', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  const jan = konto(db, 'jan');
  setMember(db, zespol.id, jan, false);

  sendMessage(db, nadawca, {
    to: 'sprzedaz@twojapoczta.com',
    subject: 'Sierota',
    body: 'x',
    scheduledAt: new Date(Date.now() + 1000).toISOString(),
  });
  // Skład znika między zaplanowaniem a nadaniem.
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(zespol.id);
  db.prepare("UPDATE messages SET scheduled_at = ? WHERE folder = 'scheduled'").run(new Date(Date.now() - 1000).toISOString());
  fireScheduled(db);

  const zwrot = db
    .prepare("SELECT * FROM messages WHERE owner_id = ? AND folder = 'inbox' AND subject LIKE 'Zwrot%'")
    .get(nadawca.id);
  assert.ok(zwrot, 'nadawca dostaje zwrot');
  assert.match(zwrot.body, /nie ma członków/);
  db.close();
});

test('zaplanowany list na zespół z samych pełnych skrzynek wraca zwrotem o zespole', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, false);
  setMember(db, zespol.id, ania, false);

  sendMessage(db, nadawca, {
    to: 'sprzedaz@twojapoczta.com',
    subject: 'Do pełnych',
    body: 'x',
    scheduledAt: new Date(Date.now() + 1000).toISOString(),
  });
  // Skrzynki zapełniają się dopiero PO zaplanowaniu: gdyby były pełne wcześniej,
  // sendMessage odmówiłby od razu i nic nie trafiłoby do Zaplanowanych.
  db.prepare('UPDATE users SET quota_mb = 0 WHERE id IN (?, ?)').run(jan, ania);
  db.prepare("UPDATE messages SET scheduled_at = ? WHERE folder = 'scheduled'").run(new Date(Date.now() - 1000).toISOString());
  fireScheduled(db);

  const zwrot = db
    .prepare("SELECT * FROM messages WHERE owner_id = ? AND folder = 'inbox' AND subject LIKE 'Zwrot%'")
    .get(nadawca.id);
  assert.ok(zwrot, 'nadawca dostaje zwrot');
  assert.match(zwrot.body, /skrzynka zespołu jest pełna/, 'zwrot nazywa pełny zespół, nie pojedynczego odbiorcę');
  assert.doesNotMatch(zwrot.body, /jan@|ania@/, 'zwrot nie zdradza nadawcy, kto siedzi w zespole');
  for (const id of [jan, ania]) {
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(id).n,
      0,
      'pełny członek nie dostaje kopii'
    );
  }
  db.close();
});

// Kontrola dla gałęzi obok: zwykłe konto ma po przepisaniu pętli na resolveDelivery
// zachowywać się dokładnie jak przed fan-outem. Ten test i ten wyżej pinują oba
// ramiona tego samego ternarnego wyboru powodu zwrotu.
test('zaplanowany list na pełną skrzynkę konta wraca zwrotem o odbiorcy', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const ania = konto(db, 'ania');

  sendMessage(db, nadawca, {
    to: 'ania@twojapoczta.com',
    subject: 'Do pełnej',
    body: 'x',
    scheduledAt: new Date(Date.now() + 1000).toISOString(),
  });
  db.prepare('UPDATE users SET quota_mb = 0 WHERE id = ?').run(ania);
  db.prepare("UPDATE messages SET scheduled_at = ? WHERE folder = 'scheduled'").run(new Date(Date.now() - 1000).toISOString());
  fireScheduled(db);

  const zwrot = db
    .prepare("SELECT * FROM messages WHERE owner_id = ? AND folder = 'inbox' AND subject LIKE 'Zwrot%'")
    .get(nadawca.id);
  assert.ok(zwrot, 'nadawca dostaje zwrot');
  assert.match(zwrot.body, /skrzynka odbiorcy jest pełna/, 'konto odpowiada za siebie, nie za żaden zespół');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(ania).n,
    0,
    'pełne konto nie dostaje kopii'
  );
  db.close();
});

test('zaplanowany list omija pełnego członka i doręcza reszcie zespołu bez zwrotu', () => {
  const db = openMemoryDb();
  const nadawca = { id: konto(db, 'klient'), login: 'klient', name: 'Klient' };
  const jan = konto(db, 'jan');
  const ania = konto(db, 'ania');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, jan, false);
  setMember(db, zespol.id, ania, false);

  sendMessage(db, nadawca, {
    to: 'sprzedaz@twojapoczta.com',
    subject: 'Do połowy',
    body: 'x',
    scheduledAt: new Date(Date.now() + 1000).toISOString(),
  });
  // Jan zapełnia skrzynkę między zaplanowaniem a nadaniem; zespół zostaje w zasięgu.
  db.prepare('UPDATE users SET quota_mb = 0 WHERE id = ?').run(jan);
  db.prepare("UPDATE messages SET scheduled_at = ? WHERE folder = 'scheduled'").run(new Date(Date.now() - 1000).toISOString());
  fireScheduled(db);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(ania).n,
    1,
    'członek z miejscem dostaje list'
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(jan).n,
    0,
    'pełny członek wypada z rozdzielnika'
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox' AND subject LIKE 'Zwrot%'").get(nadawca.id).n,
    0,
    'jeden pełny członek to nie powód do zwrotu'
  );
  db.close();
});

test('wysyłka jako zespół: pole Od niesie nazwę zespołu, nie imię nadawcy', () => {
  const db = openMemoryDb();
  const janId = konto(db, 'jan');
  const jan = { id: janId, login: 'jan', name: 'Jan Kowalski' };
  const klient = konto(db, 'klient');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, janId, true);

  assert.deepEqual(resolveSender(db, jan, 'sprzedaz@twojapoczta.com'), {
    addr: 'sprzedaz@twojapoczta.com',
    name: 'Dział Sprzedaży',
  });

  sendMessage(db, jan, { to: 'klient@twojapoczta.com', from: 'sprzedaz@twojapoczta.com', subject: 'Oferta', body: 'x' });
  const uKlienta = db.prepare("SELECT * FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(klient);
  assert.equal(uKlienta.from_name, 'Dział Sprzedaży', 'klient pisze do firmy, nie do Jana');
  assert.equal(uKlienta.from_addr, 'sprzedaz@twojapoczta.com', 'odpowiedź wraca na zespół');
  db.close();
});

test('bez prawa wysyłki i w cudzym zespole nadawać nie wolno', () => {
  const db = openMemoryDb();
  const aniaId = konto(db, 'ania');
  const ania = { id: aniaId, login: 'ania', name: 'Ania Nowak' };
  const obcyId = konto(db, 'obcy');
  const obcy = { id: obcyId, login: 'obcy', name: 'Obcy' };
  konto(db, 'klient');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, aniaId, false);

  assert.equal(resolveSender(db, ania, 'sprzedaz@twojapoczta.com'), null);
  assert.equal(resolveSender(db, obcy, 'sprzedaz@twojapoczta.com'), null);

  const wynik = sendMessage(db, ania, {
    to: 'klient@twojapoczta.com',
    from: 'sprzedaz@twojapoczta.com',
    subject: 'Nie wolno',
    body: 'x',
  });
  assert.match(wynik.error, /prawo wysyłki/);
  db.close();
});

test('wersja robocza pisana jako zespół trzyma tożsamość zespołu', () => {
  const db = openMemoryDb();
  const janId = konto(db, 'jan');
  const jan = { id: janId, login: 'jan', name: 'Jan Kowalski' };
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, janId, true);

  const draft = saveDraft(db, jan, { from: 'sprzedaz@twojapoczta.com', subject: 'Szkic', body: 'x' });
  assert.equal(draft.from_addr, 'sprzedaz@twojapoczta.com');
  assert.equal(draft.from_name, 'Dział Sprzedaży', 'Wersje robocze pokazują, kim będzie ten list');
  db.close();
});

test('przełączenie nadawcy na zespół w zapisanym szkicu przestawia też nazwę', () => {
  const db = openMemoryDb();
  const janId = konto(db, 'jan');
  const jan = { id: janId, login: 'jan', name: 'Jan Kowalski' };
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, janId, true);

  // Autozapis okna pisania zakłada szkic, zanim padnie wybór nadawcy, a każdy
  // następny idzie już z `id` (kompozycja.js). Nazwa musi jechać z adresem przez
  // UPDATE, inaczej „Wersje robocze" pokazują Jana pod adresem zespołu.
  const szkic = saveDraft(db, jan, { subject: 'Szkic', body: 'x' });
  assert.equal(szkic.from_name, 'Jan Kowalski');

  const poZmianie = saveDraft(db, jan, { id: szkic.id, from: 'sprzedaz@twojapoczta.com', subject: 'Szkic', body: 'x' });
  assert.equal(poZmianie.from_addr, 'sprzedaz@twojapoczta.com');
  assert.equal(poZmianie.from_name, 'Dział Sprzedaży', 'nazwa idzie za adresem, nie zostaje przy autorze');
  db.close();
});

test('odebranie prawa wysyłki zatrzymuje list zaplanowany wcześniej', () => {
  const db = openMemoryDb();
  const janId = konto(db, 'jan');
  const jan = { id: janId, login: 'jan', name: 'Jan Kowalski' };
  konto(db, 'klient');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, janId, true);

  sendMessage(db, jan, {
    to: 'klient@twojapoczta.com',
    from: 'sprzedaz@twojapoczta.com',
    subject: 'Późna oferta',
    body: 'x',
    scheduledAt: new Date(Date.now() + 1000).toISOString(),
  });
  setMember(db, zespol.id, janId, false); // administrator odbiera prawo wysyłki
  db.prepare("UPDATE messages SET scheduled_at = ? WHERE folder = 'scheduled'").run(new Date(Date.now() - 1000).toISOString());
  fireScheduled(db);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox' AND subject = 'Późna oferta'")
      .get(db.prepare('SELECT id FROM users WHERE login = ?').get('klient').id).n,
    0,
    'list nie idzie'
  );
  const wersja = db.prepare("SELECT * FROM messages WHERE owner_id = ? AND folder = 'drafts'").get(janId);
  assert.ok(wersja, 'praca autora ląduje w Wersjach roboczych, nie w koszu');
  assert.equal(wersja.scheduled_at, null, 'wyzerowany termin wypisuje ją ze strażnika');
  const powiadomienie = db
    .prepare('SELECT * FROM messages WHERE owner_id = ? AND subject = ?')
    .get(janId, 'Nie wysłano: Późna oferta');
  assert.ok(powiadomienie, 'autor dowiaduje się, że listu nie nadano');
  assert.match(powiadomienie.body, /Wersjach roboczych/, 'powiadomienie nazywa folder, w którym list naprawdę leży');
  assert.doesNotMatch(powiadomienie.body, /Wysłane/, 'listu tam nie ma, więc nie wolno tam autora odsyłać');
  assert.match(powiadomienie.body, /prawa wysyłki/, 'i nazywa powód');
  assert.match(powiadomienie.body, /sprzedaz@twojapoczta\.com/, 'oraz adres, z którego nadawać już nie wolno');
  db.close();
});

test('przesyłanie dalej na adres zespołu odmawia, ale nie kłamie', () => {
  const db = openMemoryDb();
  const janId = konto(db, 'jan');
  const jan = { id: janId, login: 'jan', name: 'Jan' };
  createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });

  const wynik = setForwarding(db, jan, { to: 'sprzedaz@twojapoczta.com' });
  assert.match(wynik.error, /Nie można przesyłać poczty na adres zespołu/);
  assert.doesNotMatch(wynik.error, /Nie znaleziono/, 'ten adres istnieje, więc nie udajemy, że go nie ma');
  assert.equal(getForwarding(db, janId).to, '', 'odmowa nie zapisuje przekierowania');

  // Kontrola gałęzi obok: adres, którego naprawdę u nas nie ma, dalej dostaje
  // swój własny komunikat · strażnik zespołu nie może go przykryć.
  const nieznany = setForwarding(db, jan, { to: 'nie-ma@twojapoczta.com' });
  assert.match(nieznany.error, /Nie znaleziono skrzynki/);
  db.close();
});

test('przemianowanie zespołu po zaplanowaniu: list idzie nową nazwą', () => {
  const db = openMemoryDb();
  const janId = konto(db, 'jan');
  const jan = { id: janId, login: 'jan', name: 'Jan Kowalski' };
  const klient = konto(db, 'klient');
  const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
  setMember(db, zespol.id, janId, true);

  sendMessage(db, jan, {
    to: 'klient@twojapoczta.com',
    from: 'sprzedaz@twojapoczta.com',
    subject: 'Oferta',
    body: 'x',
    scheduledAt: new Date(Date.now() + 1000).toISOString(),
  });
  renameTeam(db, zespol.id, 'Sprzedaż i Obsługa');
  db.prepare("UPDATE messages SET scheduled_at = ? WHERE folder = 'scheduled'").run(new Date(Date.now() - 1000).toISOString());
  fireScheduled(db);

  const uKlienta = db.prepare("SELECT * FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(klient);
  assert.equal(uKlienta.from_name, 'Sprzedaż i Obsługa');
  db.close();
});
