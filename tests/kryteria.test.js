// Kryteria wyszukiwania: normalizacja, walidacja i kompilacja do jednego SQL.
// Ta sama kompilacja obsłuży w fazie 3 silnik reguł, więc pilnujemy jej ostro.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../server/db.js';
import { normalizujKryteria, kompilujKryteria, MAX_POLE_KRYTERIUM } from '../server/kryteria.js';

test('normalizacja: przycina białe znaki i długość, gubi puste pola', () => {
  const { kryteria } = normalizujKryteria({
    from: '  faktury@  ',
    subject: 'x'.repeat(MAX_POLE_KRYTERIUM + 50),
    to: '   ',
    has: '',
  });
  assert.deepEqual(Object.keys(kryteria).sort(), ['from', 'subject']);
  assert.equal(kryteria.from, 'faktury@');
  assert.equal(kryteria.subject.length, MAX_POLE_KRYTERIUM);
});

test('normalizacja: puste kryteria to błąd, nie „pasuje wszystko"', () => {
  assert.match(normalizujKryteria({}).error, /przynajmniej jedno/);
  assert.match(normalizujKryteria({ from: '  ', to: '' }).error, /przynajmniej jedno/);
  assert.match(normalizujKryteria(null).error, /przynajmniej jedno/);
});

test('normalizacja: folder i folderId wykluczają się', () => {
  assert.match(normalizujKryteria({ folder: 'inbox', folderId: 3 }).error, /nie oba naraz/);
});

test('normalizacja: folder tylko wbudowany', () => {
  assert.equal(normalizujKryteria({ folder: 'archive' }).kryteria.folder, 'archive');
  for (const zly of ['wszedzie', 'starred', 'custom', 'INBOX']) {
    assert.match(normalizujKryteria({ folder: zly }).error, /Nieznany folder/);
  }
});

test('normalizacja: folderId musi być dodatnią liczbą całkowitą', () => {
  assert.equal(normalizujKryteria({ folderId: '12' }).kryteria.folderId, 12);
  for (const zly of ['abc', '-3', '1.5', 0]) {
    assert.match(normalizujKryteria({ folderId: zly }).error, /folder/i);
  }
});

test('normalizacja: daty w formacie RRRR-MM-DD i realne w kalendarzu', () => {
  const { kryteria } = normalizujKryteria({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
  assert.equal(kryteria.dateFrom, '2026-01-01');
  assert.equal(kryteria.dateTo, '2026-12-31');
  for (const zla of ['31-12-2026', '2026-2-3', '2026-02-30', 'wczoraj']) {
    assert.match(normalizujKryteria({ dateFrom: zla }).error, /RRRR-MM-DD/);
    assert.match(normalizujKryteria({ dateTo: zla }).error, /RRRR-MM-DD/);
  }
});

test('normalizacja: odwrócony zakres dat to błąd, równe daty nie', () => {
  assert.match(
    normalizujKryteria({ dateFrom: '2026-05-02', dateTo: '2026-05-01' }).error,
    /odwrócony/
  );
  assert.ok(normalizujKryteria({ dateFrom: '2026-05-01', dateTo: '2026-05-01' }).kryteria);
});

test('normalizacja: hasAttachment przyjmuje tylko jawne „tak"', () => {
  for (const tak of [true, 'true', '1', 1]) {
    assert.equal(normalizujKryteria({ hasAttachment: tak }).kryteria.hasAttachment, true);
  }
  for (const nie of [false, 'false', '', '0', undefined]) {
    const wynik = normalizujKryteria({ hasAttachment: nie, from: 'x' });
    assert.equal(wynik.kryteria.hasAttachment, undefined);
  }
});

// --- Kompilacja: wykonujemy wynik na żywej bazie, nie zgadujemy SQL-a --------

function konto(db, login) {
  return Number(
    db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(login, login, 'x', '2026-07-01T00:00:00.000Z').lastInsertRowid
  );
}

function wiadomosc(db, ownerId, nadpisy = {}) {
  const w = {
    folder: 'inbox', folder_id: null,
    from_name: 'Jan Nadawca', from_addr: 'jan@example.com',
    to_addr: 'ala@twojapoczta.com', cc_addr: '',
    subject: 'Temat listu', body: 'Treść listu',
    attachments_count: 0,
    sent_at: '2026-07-10T12:00:00.000Z',
    ...nadpisy,
  };
  return Number(
    db.prepare(
      `INSERT INTO messages (owner_id, folder, folder_id, from_name, from_addr, to_addr,
                             cc_addr, subject, body, attachments_count, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ownerId, w.folder, w.folder_id, w.from_name, w.from_addr, w.to_addr,
          w.cc_addr, w.subject, w.body, w.attachments_count, w.sent_at).lastInsertRowid
  );
}

// Kontrakt fragmentu: wpinany po owner_id przez AND — dokładnie tak użyje go
// listMessages dziś i silnik reguł w fazie 3.
function szukaj(db, ownerId, surowe) {
  const { kryteria, error } = normalizujKryteria(surowe);
  assert.equal(error, undefined, `kryteria mają być poprawne: ${error}`);
  const { sql, params } = kompilujKryteria(kryteria);
  return db
    .prepare(`SELECT id FROM messages WHERE owner_id = ? AND ${sql} ORDER BY id`)
    .all(ownerId, ...params)
    .map((r) => r.id);
}

test('kompilacja: from łapie adres i nazwę nadawcy', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  const a = wiadomosc(db, ja, { from_addr: 'faktury@firma.com', from_name: 'Ktoś' });
  const b = wiadomosc(db, ja, { from_addr: 'inny@firma.com', from_name: 'Dział Faktury' });
  wiadomosc(db, ja, { from_addr: 'obcy@example.com', from_name: 'Obcy' });
  assert.deepEqual(szukaj(db, ja, { from: 'faktury' }), [a, b]);
  db.close();
});

test('kompilacja: to łapie adresata i kopię', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  const a = wiadomosc(db, ja, { to_addr: 'biuro@twojapoczta.com' });
  const b = wiadomosc(db, ja, { to_addr: 'kto@example.com', cc_addr: 'biuro@twojapoczta.com' });
  wiadomosc(db, ja, { to_addr: 'kto@example.com' });
  assert.deepEqual(szukaj(db, ja, { to: 'biuro@' }), [a, b]);
  db.close();
});

test('kompilacja: subject nie zagląda do treści', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  const a = wiadomosc(db, ja, { subject: 'Faktura za lipiec' });
  wiadomosc(db, ja, { subject: 'Inny temat', body: 'w treści jest faktura' });
  assert.deepEqual(szukaj(db, ja, { subject: 'faktura' }), [a]);
  db.close();
});

test('kompilacja: has przeszukuje temat, treść, nadawcę i adresata — jak q', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  // LIKE w SQLite fałduje wielkość liter tylko dla ASCII: „Termin Płatności"
  // łapie się na „termin płatności", bo T i P są ASCII, a ł jest identyczne.
  const trafienia = [
    wiadomosc(db, ja, { subject: 'termin płatności' }),
    wiadomosc(db, ja, { body: 'mija termin płatności' }),
    wiadomosc(db, ja, { from_name: 'Termin Płatności Sp. z o.o.' }),
    wiadomosc(db, ja, { from_addr: 'termin-platnosci@example.com' }),
    wiadomosc(db, ja, { to_addr: 'termin-platnosci@twojapoczta.com' }),
  ];
  wiadomosc(db, ja, { subject: 'nic z tych rzeczy' });
  assert.deepEqual(szukaj(db, ja, { has: 'termin płatności' }), trafienia.slice(0, 3));
  assert.deepEqual(szukaj(db, ja, { has: 'termin-platnosci' }), trafienia.slice(3));
  db.close();
});

test('kompilacja: hasNot odwraca has i nie gubi wiadomości z pustymi polami', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  wiadomosc(db, ja, { subject: 'oferta specjalna' });
  // Kolumny tekstowe są NOT NULL DEFAULT '', więc NOT (LIKE …) nie ma pułapki NULL.
  const gola = wiadomosc(db, ja, { subject: '', body: '', from_name: '', to_addr: '' });
  const zwykla = wiadomosc(db, ja, { subject: 'raport' });
  assert.deepEqual(szukaj(db, ja, { hasNot: 'oferta' }), [gola, zwykla]);
  db.close();
});

test('kompilacja: eskejpowanie LIKE — %, _ i \\ są literałami', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  const procent = wiadomosc(db, ja, { subject: 'rabat 100% na wszystko' });
  const podkreslnik = wiadomosc(db, ja, { subject: 'plik raport_roczny.pdf' });
  const backslash = wiadomosc(db, ja, { subject: 'ścieżka C:\\poczta' });
  wiadomosc(db, ja, { subject: 'rabat 100 zł, raportXroczny, C:poczta' });
  assert.deepEqual(szukaj(db, ja, { subject: '100%' }), [procent]);
  assert.deepEqual(szukaj(db, ja, { subject: 'raport_' }), [podkreslnik]);
  assert.deepEqual(szukaj(db, ja, { subject: 'C:\\' }), [backslash]);
  db.close();
});

test('kompilacja: granice zakresu dat — dateTo obejmuje cały dzień', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  wiadomosc(db, ja, { sent_at: '2026-06-30T23:59:59.000Z' });
  const pierwsza = wiadomosc(db, ja, { sent_at: '2026-07-01T00:00:00.000Z' });
  const ostatnia = wiadomosc(db, ja, { sent_at: '2026-07-15T23:59:59.000Z' });
  wiadomosc(db, ja, { sent_at: '2026-07-16T00:00:00.000Z' });
  assert.deepEqual(
    szukaj(db, ja, { dateFrom: '2026-07-01', dateTo: '2026-07-15' }),
    [pierwsza, ostatnia]
  );
  db.close();
});

test('kompilacja: bez kryterium folderu omija Kosz i Spam, z jawnym — szuka w nich', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  const wSkrzynce = wiadomosc(db, ja, { subject: 'faktura', folder: 'inbox' });
  const wArchiwum = wiadomosc(db, ja, { subject: 'faktura', folder: 'archive' });
  const wKoszu = wiadomosc(db, ja, { subject: 'faktura', folder: 'trash' });
  const wSpamie = wiadomosc(db, ja, { subject: 'faktura', folder: 'spam' });
  assert.deepEqual(szukaj(db, ja, { subject: 'faktura' }), [wSkrzynce, wArchiwum]);
  assert.deepEqual(szukaj(db, ja, { subject: 'faktura', folder: 'trash' }), [wKoszu]);
  assert.deepEqual(szukaj(db, ja, { subject: 'faktura', folder: 'spam' }), [wSpamie]);
  db.close();
});

test('kompilacja: folderId zawęża do folderu własnego', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  db.prepare('INSERT INTO folders (user_id, name, position, created_at) VALUES (?, ?, 1, ?)')
    .run(ja, 'Faktury', '2026-07-01T00:00:00.000Z');
  const folderId = Number(db.prepare('SELECT id FROM folders WHERE user_id = ?').get(ja).id);
  const wFolderze = wiadomosc(db, ja, { folder: 'custom', folder_id: folderId, subject: 'faktura' });
  wiadomosc(db, ja, { subject: 'faktura' });
  assert.deepEqual(szukaj(db, ja, { subject: 'faktura', folderId }), [wFolderze]);
  db.close();
});

test('kompilacja: hasAttachment wymaga załącznika', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  const zZalacznikiem = wiadomosc(db, ja, { attachments_count: 2 });
  wiadomosc(db, ja, { attachments_count: 0 });
  assert.deepEqual(szukaj(db, ja, { hasAttachment: '1' }), [zZalacznikiem]);
  db.close();
});

test('kompilacja: kryteria składają się przez AND', () => {
  const db = openMemoryDb();
  const ja = konto(db, 'ala');
  const trafiona = wiadomosc(db, ja, { from_addr: 'faktury@firma.com', subject: 'Faktura 7/2026' });
  wiadomosc(db, ja, { from_addr: 'faktury@firma.com', subject: 'Newsletter' });
  wiadomosc(db, ja, { from_addr: 'kto@example.com', subject: 'Faktura 8/2026' });
  assert.deepEqual(szukaj(db, ja, { from: 'faktury@', subject: 'faktura' }), [trafiona]);
  db.close();
});

test('kompilacja: deterministyczna — dwa przebiegi dają identyczny SQL i parametry', () => {
  const { kryteria } = normalizujKryteria({
    from: 'a', to: 'b', subject: 'c', has: 'd', hasNot: 'e',
    dateFrom: '2026-01-01', dateTo: '2026-12-31', folderId: 7, hasAttachment: true,
  });
  assert.deepEqual(kompilujKryteria(kryteria), kompilujKryteria(kryteria));
});

test('kompilacja: puste kryteria to błąd programisty, nie „pasuje wszystko"', () => {
  assert.throws(() => kompilujKryteria({}), /puste/i);
});
