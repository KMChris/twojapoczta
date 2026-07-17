// STARTTLS na przychodzącym SMTP (RFC 3207): pełny obieg na prawdziwym gnieździe
// plus przypadki obronne. Dwa serwery: jeden z certyfikatem, drugi bez.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { openMemoryDb, now } from '../server/db.js';
import { startSmtpServer } from '../server/smtp.js';
import { listMessages } from '../server/mail.js';
import { generateSelfSigned } from '../server/x509.js';

let db;
let smtp;
let smtpBezTls;
let port;
let portBezTls;
let demoId;

const cichy = { log() {}, error() {} };

before(async () => {
  db = openMemoryDb();
  demoId = Number(
    db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('demo', 'Demo', 'x', now()).lastInsertRowid
  );

  const { certPem, keyPem } = generateSelfSigned({ hostname: 'mx.twojapoczta.com' });
  const kontekst = tls.createSecureContext({ cert: certPem, key: keyPem });

  smtp = startSmtpServer(db, {
    port: 0,
    host: '127.0.0.1',
    log: cichy,
    secureContext: () => kontekst,
  });
  await new Promise((r) => smtp.once('listening', r));
  port = smtp.address().port;

  smtpBezTls = startSmtpServer(db, { port: 0, host: '127.0.0.1', log: cichy });
  await new Promise((r) => smtpBezTls.once('listening', r));
  portBezTls = smtpBezTls.address().port;
});

after(async () => {
  await new Promise((r) => smtp.close(r));
  await new Promise((r) => smtpBezTls.close(r));
  db.close();
});

// Klient SMTP, który umie podnieść własne gniazdo do TLS w połowie rozmowy.
function polacz(naPort = port) {
  let socket = net.connect({ host: '127.0.0.1', port: naPort });
  let bufor = '';
  let oczekujacy = null;

  const dane = (chunk) => {
    bufor += chunk.toString('utf8');
    sprawdz();
  };
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
  const podepnij = (s) => {
    s.on('error', () => {}); // serwer może zerwać połączenie, i to bywa treścią testu
    s.on('data', dane);
  };
  podepnij(socket);

  const read = () => new Promise((resolve) => { oczekujacy = resolve; sprawdz(); });
  const cmd = (t) => { socket.write(t + '\r\n'); return read(); };
  const zapiszSurowo = (t) => socket.write(t);

  async function podnies() {
    socket.removeAllListeners('data');
    const bezpieczne = tls.connect({ socket, rejectUnauthorized: false });
    await new Promise((resolve, reject) => {
      bezpieczne.once('secureConnect', resolve);
      bezpieczne.once('error', reject);
    });
    socket = bezpieczne;
    bufor = '';
    podepnij(socket);
  }

  return {
    read,
    cmd,
    zapiszSurowo,
    podnies,
    end: () => socket.end(),
    zamkniete: () => new Promise((r) => socket.once('close', r)),
  };
}

test('EHLO ogłasza STARTTLS, a po podniesieniu już nie', async () => {
  const k = polacz();
  assert.match(await k.read(), /^220 /);
  assert.match(await k.cmd('EHLO tester'), /STARTTLS/);

  assert.match(await k.cmd('STARTTLS'), /^220 /);
  await k.podnies();

  const poTls = await k.cmd('EHLO tester');
  assert.match(poTls, /^250/);
  assert.doesNotMatch(poTls, /STARTTLS/, 'RFC 3207: po TLS nie ogłaszamy STARTTLS');
  k.end();
});

test('drugi STARTTLS w szyfrowanym połączeniu → 503', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('EHLO tester');
  await k.cmd('STARTTLS');
  await k.podnies();
  await k.cmd('EHLO tester');
  assert.match(await k.cmd('STARTTLS'), /^503 /);
  k.end();
});

test('pełny obieg: list nadany po TLS dochodzi do Odebranych', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('EHLO tester');
  await k.cmd('STARTTLS');
  await k.podnies();

  await k.cmd('EHLO tester');
  assert.match(await k.cmd('MAIL FROM:<szef@example.com>'), /^250 /);
  assert.match(await k.cmd('RCPT TO:<demo@twojapoczta.com>'), /^250 /);
  assert.match(await k.cmd('DATA'), /^354 /);
  const odp = await k.cmd([
    'From: Szef <szef@example.com>',
    'Subject: Po szyfrze',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'tresc szyfrowana',
    '.',
  ].join('\r\n'));
  assert.match(odp, /^250 /);
  k.end();

  const listy = listMessages(db, demoId, { folder: 'inbox' }).filter((m) => m.subject === 'Po szyfrze');
  assert.equal(listy.length, 1, 'list doręczony przez szyfrowane połączenie');
});

test('koperta sprzed TLS jest zapomniana', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('EHLO tester');
  assert.match(await k.cmd('MAIL FROM:<napastnik@example.com>'), /^250 /);

  await k.cmd('STARTTLS');
  await k.podnies();
  await k.cmd('EHLO tester');

  // RFC 3207 §4.2: stan sprzed TLS znika, więc RCPT nie ma do czego się doczepić.
  assert.match(await k.cmd('RCPT TO:<demo@twojapoczta.com>'), /^503 /);
  k.end();
});

test('wstrzyknięcie poleceń za komendą STARTTLS zrywa połączenie', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('EHLO tester');

  // Jednym zapisem, więc obie linie lądują w buforze serwera razem.
  // To klasa CVE-2011-0411: po 220 te bajty udawałyby komendy sprzed szyfru.
  k.zapiszSurowo('STARTTLS\r\nMAIL FROM:<napastnik@example.com>\r\n');
  assert.match(await k.read(), /^501 /);
  await k.zamkniete();
});

test('bez certyfikatu: brak ogłoszenia i 454 na komendę', async () => {
  const k = polacz(portBezTls);
  await k.read();
  const ehlo = await k.cmd('EHLO tester');
  assert.doesNotMatch(ehlo, /STARTTLS/, 'nie ogłaszamy tego, czego nie umiemy');
  assert.match(await k.cmd('STARTTLS'), /^454 /);
  k.end();
});

test('STARTTLS z argumentem → 501', async () => {
  const k = polacz();
  await k.read();
  await k.cmd('EHLO tester');
  assert.match(await k.cmd('STARTTLS teraz'), /^501 /);
  k.end();
});
