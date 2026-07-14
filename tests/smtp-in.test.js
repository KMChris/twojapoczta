// Jednostkowe testy przychodzącego serwera SMTP: komendy sterujące,
// ścieżki błędów protokołu i doręczanie do wielu skrzynek. Świeża baza in-memory.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openMemoryDb, now } from '../server/db.js';
import { startSmtpServer, MAX_MESSAGE_BYTES } from '../server/smtp.js';
import { listMessages } from '../server/mail.js';

let db;
let smtp;
let port;
const ids = {};

before(async () => {
  db = openMemoryDb();
  for (const login of ['demo', 'ania']) {
    ids[login] = Number(
      db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(login, login, 'x', now()).lastInsertRowid
    );
  }
  smtp = startSmtpServer(db, { port: 0, host: '127.0.0.1', log: { log() {}, error() {} } });
  await new Promise((r) => smtp.once('listening', r));
  port = smtp.address().port;
});

after(() => new Promise((r) => smtp.close(r)));

function polacz() {
  const socket = net.connect({ host: '127.0.0.1', port });
  let bufor = '';
  let oczekujacy = null;
  socket.on('error', () => {}); // serwer może zamknąć połączenie w trakcie dużego zapisu
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

test('EHLO ogłasza SIZE i 8BITMIME, HELO odpowiada 250', async () => {
  const k = polacz();
  assert.match(await k.read(), /^220 /);
  const ehlo = await k.cmd('EHLO tester');
  assert.match(ehlo, /SIZE 10485760/);
  assert.match(ehlo, /8BITMIME/);
  assert.match(await k.cmd('HELO tester'), /^250 /);
  k.end();
});

test('komendy sterujące: RSET, NOOP, VRFY, nieznane', async () => {
  const k = polacz();
  await k.read();
  assert.match(await k.cmd('NOOP'), /^250 /);
  assert.match(await k.cmd('RSET'), /^250 /);
  assert.match(await k.cmd('VRFY ktos'), /^252 /);
  assert.match(await k.cmd('FOOBAR cokolwiek'), /^500 /);
  k.end();
});

test('MAIL: błędna składnia → 501', async () => {
  const k = polacz();
  await k.read();
  assert.match(await k.cmd('MAIL FROM bezNawiasow'), /^501 /);
  k.end();
});

test('MAIL z deklarowanym SIZE ponad limit → 552', async () => {
  const k = polacz();
  await k.read();
  assert.match(await k.cmd(`MAIL FROM:<a@b.pl> SIZE=${MAX_MESSAGE_BYTES + 1}`), /^552 /);
  k.end();
});

test('RCPT przed MAIL → 503', async () => {
  const k = polacz();
  await k.read();
  assert.match(await k.cmd('RCPT TO:<demo@twojapoczta.com>'), /^503 /);
  k.end();
});

test('RCPT: błędna składnia i pusty adres → 501', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('MAIL FROM:<a@b.pl>');
  assert.match(await k.cmd('RCPT TO: bezNawiasow'), /^501 /);
  assert.match(await k.cmd('RCPT TO:<>'), /^501 /);
  k.end();
});

test('RCPT: relay obcej domeny → 554, nieznana skrzynka → 550', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('MAIL FROM:<a@b.pl>');
  assert.match(await k.cmd('RCPT TO:<ktos@gmail.com>'), /^554 /);
  assert.match(await k.cmd('RCPT TO:<niema@twojapoczta.com>'), /^550 /);
  k.end();
});

test('doręcza do wielu skrzynek, dedupikuje powtórzonego adresata', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('MAIL FROM:<szef@example.com>');
  assert.match(await k.cmd('RCPT TO:<demo@twojapoczta.com>'), /^250 /);
  assert.match(await k.cmd('RCPT TO:<demo@twojapoczta.com>'), /^250 /); // duplikat
  assert.match(await k.cmd('RCPT TO:<ania@twojapoczta.com>'), /^250 /);
  assert.match(await k.cmd('DATA'), /^354 /);
  const odp = await k.cmd([
    'From: Szef <szef@example.com>',
    'Subject: Do dwoch',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'tresc',
    '.',
  ].join('\r\n'));
  assert.match(odp, /^250 /);
  k.end();

  const demo = listMessages(db, ids.demo, { folder: 'inbox' }).filter((m) => m.subject === 'Do dwoch');
  const ania = listMessages(db, ids.ania, { folder: 'inbox' }).filter((m) => m.subject === 'Do dwoch');
  assert.equal(demo.length, 1, 'demo dostaje jedną kopię mimo duplikatu RCPT');
  assert.equal(ania.length, 1);
});

test('DATA ponad limit rozmiaru → 552 po zakończeniu', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('MAIL FROM:<szef@example.com>');
  await k.cmd('RCPT TO:<demo@twojapoczta.com>');
  assert.match(await k.cmd('DATA'), /^354 /);
  // jedna gigantyczna linia ponad 10 MB, ale poniżej twardego progu bufora (11 MB)
  const wielka = 'a'.repeat(MAX_MESSAGE_BYTES + 512 * 1024);
  const odp = await k.cmd(wielka + '\r\n.');
  assert.match(odp, /^552 /);
  k.end();
});

test('przepełnienie bufora połączenia (ponad 11 MB) → 552 i zamknięcie', async () => {
  const k = polacz();
  await k.read();
  // ponad MAX+1MB bez znaku nowej linii: twardy strażnik na poziomie gniazda
  const zalew = 'a'.repeat(MAX_MESSAGE_BYTES + 1024 * 1024 + 4096);
  assert.match(await k.cmd(zalew), /^552 /);
  k.end();
});

test('QUIT kończy połączenie 221', async () => {
  const k = polacz();
  await k.read();
  assert.match(await k.cmd('QUIT'), /^221 /);
  k.end();
});
