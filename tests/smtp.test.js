// Bramka SMTP: parser MIME, serwer przychodzący, pętla zwrotna out→in, odbicia.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openMemoryDb } from '../server/db.js';
import { seedIfEmpty } from '../server/seed.js';
import { startSmtpServer } from '../server/smtp.js';
import { parseMessage } from '../server/mime.js';
import { buildRawMessage, deliverToServer } from '../server/smtp-out.js';
import { listMessages, getMessage, sendMessage } from '../server/mail.js';
import { listAttachments, getAttachment } from '../server/attachments.js';

const DEMO_ID = 1; // kolejność seedu: demo, zespol, ania, michal, biuro
const ANIA_ID = 3;

let db;
let smtp;
let port;

before(async () => {
  db = openMemoryDb();
  await seedIfEmpty(db);
  smtp = startSmtpServer(db, {
    port: 0,
    host: '127.0.0.1',
    log: { log() {}, error() {} },
  });
  await new Promise((resolve) => smtp.once('listening', resolve));
  port = smtp.address().port;
});

after(() => new Promise((resolve) => smtp.close(resolve)));

// Miniaturowy klient SMTP do rozmowy z serwerem.
function polacz() {
  const socket = net.connect({ host: '127.0.0.1', port });
  let bufor = '';
  let oczekujacy = null;

  socket.on('data', (chunk) => {
    bufor += chunk.toString('utf8');
    sprawdz();
  });

  function sprawdz() {
    if (!oczekujacy) return;
    const linie = bufor.split('\r\n');
    for (let i = 0; i < linie.length; i++) {
      if (/^\d{3}( |$)/.test(linie[i])) {
        const odpowiedz = linie.slice(0, i + 1).join('\n');
        bufor = linie.slice(i + 1).join('\r\n');
        const czekal = oczekujacy;
        oczekujacy = null;
        czekal(odpowiedz);
        return;
      }
    }
  }

  const read = () =>
    new Promise((resolve) => {
      oczekujacy = resolve;
      sprawdz();
    });
  const cmd = (tekst) => {
    socket.write(tekst + '\r\n');
    return read();
  };
  return { read, cmd, end: () => socket.end() };
}

// --- Parser MIME -------------------------------------------------------------

test('mime: dekoduje encoded-words i quoted-printable w iso-8859-2', () => {
  const raw = Buffer.from(
    [
      'From: =?UTF-8?B?QW5uYSDFu8OzxYJ3?= <anna@example.com>',
      'To: demo@twojapoczta.com',
      'Subject: =?UTF-8?Q?Zaproszenie_na_=C5=BCagl=C3=B3wk=C4=99?=',
      'Content-Type: text/plain; charset=iso-8859-2',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'Cze=B6=E6 Janku!',
    ].join('\r\n'),
    'latin1'
  );
  const m = parseMessage(raw);
  assert.equal(m.subject, 'Zaproszenie na żaglówkę');
  assert.equal(m.from.name, 'Anna Żółw');
  assert.equal(m.from.addr, 'anna@example.com');
  assert.equal(m.body, 'Cześć Janku!');
});

test('mime: multipart z html-owym tekstem i załącznikiem base64', () => {
  const zawartosc = Buffer.from('testowe bajty załącznika 123');
  const raw = Buffer.from(
    [
      'From: nadawca@example.com',
      'Subject: Zdjecia',
      'Content-Type: multipart/mixed; boundary="granica123"',
      '',
      '--granica123',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Czesc! <b>Zdjecia</b> w zalaczniku.<br>Pozdrawiam</p>',
      '--granica123',
      'Content-Type: application/octet-stream',
      "Content-Disposition: attachment; filename*=UTF-8''zdj%C4%99cie.bin",
      'Content-Transfer-Encoding: base64',
      '',
      zawartosc.toString('base64'),
      '--granica123--',
    ].join('\r\n'),
    'latin1'
  );
  const m = parseMessage(raw);
  assert.match(m.body, /Czesc! Zdjecia w zalaczniku\./);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'zdjęcie.bin');
  assert.ok(Buffer.from(m.attachments[0].data).equals(zawartosc));
});

// --- Serwer przychodzący ---------------------------------------------------------

test('smtp-in: przyjmuje pocztę dla lokalnej skrzynki (z dot-stuffingiem)', async () => {
  const k = polacz();
  assert.match(await k.read(), /^220 /);
  assert.match(await k.cmd('EHLO nadawca.example.com'), /250 8BITMIME/);
  assert.match(await k.cmd('MAIL FROM:<szef@example.com>'), /^250/);
  assert.match(await k.cmd('RCPT TO:<demo@twojapoczta.com>'), /^250/);
  assert.match(await k.cmd('DATA'), /^354/);
  const odpowiedz = await k.cmd(
    [
      'From: Szef <szef@example.com>',
      'To: demo@twojapoczta.com',
      'Subject: =?UTF-8?Q?Pilne_zam=C3=B3wienie?=',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Prosze o wycene.',
      '..z kropka na poczatku',
      '.',
    ].join('\r\n')
  );
  assert.match(odpowiedz, /^250/);
  k.end();

  const inbox = listMessages(db, DEMO_ID, { folder: 'inbox' });
  const skrot = inbox.find((m) => m.subject === 'Pilne zamówienie');
  assert.ok(skrot, 'wiadomość powinna być w Odebranych');
  assert.equal(skrot.is_read, 0);
  const pelna = getMessage(db, DEMO_ID, skrot.id);
  assert.equal(pelna.from_addr, 'szef@example.com');
  assert.match(pelna.body, /^\.z kropka na poczatku$/m);
});

test('smtp-in: odmawia relayu i nieistniejących skrzynek', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('HELO tester');
  await k.cmd('MAIL FROM:<a@b.pl>');
  assert.match(await k.cmd('RCPT TO:<ktos@gmail.com>'), /^554/);
  assert.match(await k.cmd('RCPT TO:<niktturbo@twojapoczta.com>'), /^550/);
  assert.match(await k.cmd('DATA'), /^503/);
  assert.match(await k.cmd('QUIT'), /^221/);
  k.end();
});

// --- Pętla zwrotna: nasz klient → nasz serwer --------------------------------------

test('smtp-out → smtp-in: pełna pętla z polskimi znakami i załącznikiem', async () => {
  const dane = Buffer.from('Zawartość załącznika: żółw 🐢', 'utf8');
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'Jan Demowski', addr: 'demo@twojapoczta.com' },
    to: ['ania@twojapoczta.com'],
    subject: 'Pętla zwrotna · żółć',
    body: 'Treść z polskimi znakami: żółć, źdźbło.\n\n.kropka na początku linii.',
    attachments: [{ filename: 'żółw.txt', mime: 'text/plain', data: dane }],
  });

  await deliverToServer({
    host: '127.0.0.1',
    port,
    ehloName: 'test.local',
    mailFrom: 'demo@twojapoczta.com',
    rcptTo: ['ania@twojapoczta.com'],
    raw,
    useTls: false,
  });

  const inbox = listMessages(db, ANIA_ID, { folder: 'inbox' });
  const skrot = inbox.find((m) => m.subject === 'Pętla zwrotna · żółć');
  assert.ok(skrot);
  assert.equal(skrot.attachments_count, 1);
  assert.equal(skrot.from_name, 'Jan Demowski');

  const pelna = getMessage(db, ANIA_ID, skrot.id);
  assert.match(pelna.body, /żółć, źdźbło/);
  assert.match(pelna.body, /^\.kropka na początku linii\.$/m);

  const zalaczniki = listAttachments(db, ANIA_ID, skrot.id);
  assert.equal(zalaczniki[0].filename, 'żółw.txt');
  const pobrany = getAttachment(db, ANIA_ID, skrot.id, zalaczniki[0].id);
  assert.ok(Buffer.from(pobrany.data).equals(dane));
});

// --- Odbicia ---------------------------------------------------------------------------

test('wysyłka zewnętrzna: porażka wraca jako zwrot do nadawcy', async () => {
  process.env.TP_EXTERNAL = '1';
  process.env.TP_SMTP_ROUTE = '127.0.0.1:9'; // martwy port
  try {
    const user = db.prepare('SELECT * FROM users WHERE login = ?').get('demo');
    const wynik = sendMessage(db, user, {
      to: 'ktos@zewnetrzna-domena.example',
      subject: 'Na zewnątrz',
      body: 'Ta wiadomość nie ma prawa wyjść.',
    });
    assert.ok(wynik.message, 'kopia ląduje w Wysłanych od razu');
    assert.equal(wynik.message.folder, 'sent');

    let odbicie = null;
    for (let i = 0; i < 60 && !odbicie; i++) {
      await new Promise((r) => setTimeout(r, 50));
      odbicie = listMessages(db, user.id, { folder: 'inbox' }).find((m) =>
        m.subject.startsWith('Zwrot do nadawcy')
      );
    }
    assert.ok(odbicie, 'odbicie powinno trafić do Odebranych');
    const pelne = getMessage(db, user.id, odbicie.id);
    assert.match(pelne.body, /ktos@zewnetrzna-domena\.example/);
  } finally {
    delete process.env.TP_EXTERNAL;
    delete process.env.TP_SMTP_ROUTE;
  }
});

test('wysyłka zewnętrzna: domyślnie wyłączona', () => {
  const user = db.prepare('SELECT * FROM users WHERE login = ?').get('demo');
  const wynik = sendMessage(db, user, { to: 'ktos@gmail.com', subject: 'x', body: 'x' });
  assert.match(wynik.error, /tylko w domenie/);
});
