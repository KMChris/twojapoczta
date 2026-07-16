// Limity miejsca i catch-all: zużycie skrzynki, odmowa uploadu, odmowa doręczenia
// wewnętrznego, SMTP 552 przy pełnej skrzynce i doręczenie catch-all.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openMemoryDb, now } from '../server/db.js';
import { storageUsage, hasRoom } from '../server/quota.js';
import { saveUpload } from '../server/attachments.js';
import { sendMessage, listMessages, getMessage, fireScheduled, forwardDelivered, addressOf } from '../server/mail.js';
import { setSetting } from '../server/settings.js';
import { startSmtpServer } from '../server/smtp.js';

function uzytkownik(db, login, { quota = null } = {}) {
  return Number(
    db.prepare('INSERT INTO users (login, name, password_hash, created_at, quota_mb) VALUES (?, ?, ?, ?, ?)')
      .run(login, login, 'x', now(), quota).lastInsertRowid
  );
}

// Wypełnia skrzynkę treścią o zadanym rozmiarze (domyślnie ponad 1 MB).
function zapchaj(db, userId, bytes = 1_100_000) {
  db.prepare(
    "INSERT INTO messages (owner_id, folder, from_addr, body, snippet, sent_at) VALUES (?, 'inbox', 'ktos@example.com', ?, '', ?)"
  ).run(userId, 'x'.repeat(bytes), now());
}

// --- Zużycie i decyzja o przyjęciu ------------------------------------------------

test('storageUsage liczy bajty treści i załączników', () => {
  const db = openMemoryDb();
  const id = uzytkownik(db, 'mierzony');
  assert.equal(storageUsage(db, id), 0);

  db.prepare(
    "INSERT INTO messages (id, owner_id, folder, from_addr, body, snippet, sent_at) VALUES (77, ?, 'inbox', 'a@b.pl', 'treść', '', ?)"
  ).run(id, now());
  db.prepare("INSERT INTO blobs (hash, data, size) VALUES ('h1', x'00', 1)").run();
  db.prepare("INSERT INTO attachments (message_id, filename, mime, size, blob_hash) VALUES (77, 'p.bin', 'application/octet-stream', 4000, 'h1')").run();

  // „treść" = 7 bajtów UTF-8 (ś i ć po 2 bajty) + 4000 bajtów załącznika
  assert.equal(storageUsage(db, id), 4007);
  db.close();
});

test('hasRoom: bez limitu zawsze tak, z limitem szanuje zużycie i dokładane bajty', () => {
  const db = openMemoryDb();
  const bezLimitu = uzytkownik(db, 'wolny');
  zapchaj(db, bezLimitu, 5_000_000);
  assert.equal(hasRoom(db, bezLimitu, 10_000_000), true);

  const zLimitem = uzytkownik(db, 'ciasny', { quota: 1 });
  assert.equal(hasRoom(db, zLimitem, 500_000), true);
  assert.equal(hasRoom(db, zLimitem, 2_000_000), false, 'dokładka ponad limit');
  zapchaj(db, zLimitem);
  assert.equal(hasRoom(db, zLimitem, 0), false, 'zużycie ponad limit');
  db.close();
});

// --- Upload załącznika ---------------------------------------------------------------

test('saveUpload odmawia, gdy limit miejsca wyczerpany', () => {
  const db = openMemoryDb();
  const id = uzytkownik(db, 'pelny.upload', { quota: 1 });
  zapchaj(db, id);
  const wynik = saveUpload(db, id, { filename: 'p.txt', mime: 'text/plain', buffer: Buffer.from('abc') });
  assert.match(wynik.error, /miejsca/i);

  const luzny = uzytkownik(db, 'luzny.upload', { quota: 100 });
  const ok = saveUpload(db, luzny, { filename: 'p.txt', mime: 'text/plain', buffer: Buffer.from('abc') });
  assert.ok(ok.upload);
  db.close();
});

// --- Doręczenie wewnętrzne --------------------------------------------------------------

test('sendMessage: pełna skrzynka odbiorcy blokuje wysyłkę z czytelnym błędem', () => {
  const db = openMemoryDb();
  const nadawcaId = uzytkownik(db, 'nadawca');
  const nadawca = { id: nadawcaId, login: 'nadawca', name: 'Nadawca' };
  const pelnyId = uzytkownik(db, 'pelny', { quota: 1 });
  zapchaj(db, pelnyId);

  const wynik = sendMessage(db, nadawca, { to: addressOf('pelny'), subject: 'Nie wejdzie', body: 'x' });
  assert.match(wynik.error, /pełna/i);
  assert.match(wynik.error, /pelny@/);

  uzytkownik(db, 'przyjmie', { quota: 100 });
  const ok = sendMessage(db, nadawca, { to: addressOf('przyjmie'), subject: 'Wejdzie', body: 'x' });
  assert.ok(ok.message);
  db.close();
});

test('fireScheduled: skrzynka zapełniona przed terminem nadania → zwrot do nadawcy', () => {
  const db = openMemoryDb();
  const nadawcaId = uzytkownik(db, 'planista');
  const nadawca = { id: nadawcaId, login: 'planista', name: 'Planista' };
  const pelnyId = uzytkownik(db, 'pelny.termin', { quota: 1 });

  const wynik = sendMessage(db, nadawca, {
    to: addressOf('pelny.termin'),
    subject: 'Na później',
    body: 'x',
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.ok(wynik.scheduled, 'wiadomość czeka w Zaplanowanych');

  // Skrzynka odbiorcy zapełnia się między zaplanowaniem a nadaniem.
  zapchaj(db, pelnyId);
  db.prepare("UPDATE messages SET scheduled_at = ? WHERE folder = 'scheduled'").run(new Date(Date.now() - 1000).toISOString());
  assert.equal(fireScheduled(db), 1);

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(pelnyId).n,
    1,
    'u odbiorcy tylko zapchajka, doręczenie wstrzymane'
  );
  const zwrot = listMessages(db, nadawcaId, { folder: 'inbox' }).find((w) => w.subject.startsWith('Zwrot do nadawcy'));
  assert.ok(zwrot, 'nadawca dostał zwrot');
  assert.match(getMessage(db, nadawcaId, zwrot.id).body, /pełna/i);
  db.close();
});

test('przekierowanie do pełnej skrzynki jest pomijane, oryginał zostaje w Odebranych', () => {
  const db = openMemoryDb();
  const zrodloId = uzytkownik(db, 'zrodlo');
  const pelnyId = uzytkownik(db, 'cel.pelny', { quota: 1 });
  zapchaj(db, pelnyId);
  db.prepare('UPDATE users SET forward_to = ?, forward_keep = 0 WHERE id = ?').run(addressOf('cel.pelny'), zrodloId);

  const msgId = Number(
    db.prepare(
      "INSERT INTO messages (owner_id, folder, from_addr, to_addr, subject, body, snippet, sent_at) VALUES (?, 'inbox', 'ktos@example.com', ?, 'Ważne', 'treść', '', ?)"
    ).run(zrodloId, addressOf('zrodlo'), now()).lastInsertRowid
  );

  assert.equal(forwardDelivered(db, zrodloId, msgId), null, 'przekierowanie pominięte');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'inbox'").get(pelnyId).n,
    1,
    'u celu tylko zapchajka'
  );
  assert.equal(getMessage(db, zrodloId, msgId).folder, 'inbox', 'oryginał nie powędrował do Archiwum');
  db.close();
});

// --- SMTP: 552 przy pełnej skrzynce i catch-all --------------------------------------------

let db;
let smtp;
let port;
let demoId;

before(async () => {
  db = openMemoryDb();
  demoId = uzytkownik(db, 'demo');
  const przepelnionyId = uzytkownik(db, 'przepelniony', { quota: 1 });
  zapchaj(db, przepelnionyId);
  smtp = startSmtpServer(db, { port: 0, host: '127.0.0.1', log: { log() {}, error() {} } });
  await new Promise((r) => smtp.once('listening', r));
  port = smtp.address().port;
});

after(() => new Promise((r) => smtp.close(r)));

function polacz() {
  const socket = net.connect({ host: '127.0.0.1', port });
  let bufor = '';
  let oczekujacy = null;
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    bufor += chunk.toString('utf8');
    sprawdz();
  });
  function sprawdz() {
    if (!oczekujacy) return;
    const linie = bufor.split('\r\n');
    for (let i = 0; i < linie.length; i++) {
      if (/^\d{3}( |$)/.test(linie[i])) {
        const odp = linie.slice(0, i + 1).join('\n');
        bufor = linie.slice(i + 1).join('\r\n');
        const cb = oczekujacy;
        oczekujacy = null;
        cb(odp);
        return;
      }
    }
  }
  const read = () => new Promise((resolve) => { oczekujacy = resolve; sprawdz(); });
  const cmd = (t) => { socket.write(t + '\r\n'); return read(); };
  return { read, cmd, end: () => socket.end() };
}

test('RCPT do pełnej skrzynki → 552 5.2.2', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('EHLO tester');
  await k.cmd('MAIL FROM:<ktos@example.com>');
  assert.match(await k.cmd('RCPT TO:<przepelniony@twojapoczta.com>'), /^552 5\.2\.2/);
  k.end();
});

test('RCPT na nieznany adres: 550 bez catch-all, doręczenie z catch-all', async () => {
  const bez = polacz();
  await bez.read();
  await bez.cmd('EHLO tester');
  await bez.cmd('MAIL FROM:<ktos@example.com>');
  assert.match(await bez.cmd('RCPT TO:<nieznany@twojapoczta.com>'), /^550 /);
  bez.end();

  setSetting(db, 'catchall', 'demo');
  try {
    const z = polacz();
    await z.read();
    await z.cmd('EHLO tester');
    await z.cmd('MAIL FROM:<ktos@example.com>');
    assert.match(await z.cmd('RCPT TO:<nieznany@twojapoczta.com>'), /^250 /);
    await z.cmd('DATA');
    const wynik = await z.cmd(['Subject: Do wszystkich', 'From: Ktos <ktos@example.com>', '', 'zlapane przez catch-all', '.'].join('\r\n'));
    assert.match(wynik, /^250 /);
    z.end();

    const inbox = listMessages(db, demoId, { folder: 'inbox' });
    assert.ok(inbox.some((w) => w.subject === 'Do wszystkich'));
  } finally {
    setSetting(db, 'catchall', null);
  }
});

test('catch-all wskazujący usunięte konto nie wskrzesza doręczenia', async () => {
  setSetting(db, 'catchall', 'duch');
  try {
    const k = polacz();
    await k.read();
    await k.cmd('EHLO tester');
    await k.cmd('MAIL FROM:<ktos@example.com>');
    assert.match(await k.cmd('RCPT TO:<nieznany@twojapoczta.com>'), /^550 /);
    k.end();
  } finally {
    setSetting(db, 'catchall', null);
  }
});
