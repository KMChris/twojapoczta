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
let smtpKrotki;
let port;
let portBezTls;
let portKrotki;
let demoId;

const cichy = { log() {}, error() {} };

// Trzeci serwer ma limit czasu skrócony do ułamka sekundy · inaczej test limitu
// musiałby czekać 60 sekund produkcyjnego IDLE_TIMEOUT_MS. Handshake na pętli
// zwrotnej mieści się w ~30 ms, więc 500 ms to kilkunastokrotny zapas.
const KROTKI_LIMIT_MS = 500;

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

  smtpKrotki = startSmtpServer(db, {
    port: 0,
    host: '127.0.0.1',
    log: cichy,
    secureContext: () => kontekst,
    idleTimeoutMs: KROTKI_LIMIT_MS,
  });
  await new Promise((r) => smtpKrotki.once('listening', r));
  portKrotki = smtpKrotki.address().port;
});

after(async () => {
  await new Promise((r) => smtp.close(r));
  await new Promise((r) => smtpBezTls.close(r));
  await new Promise((r) => smtpKrotki.close(r));
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

  // Zwraca CN certyfikatu, który podał serwer · po tym poznajemy, czy kontekst
  // został pobrany teraz, czy zapamiętany kiedyś na starcie.
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
    return bezpieczne.getPeerCertificate()?.subject?.CN;
  }

  return {
    read,
    cmd,
    zapiszSurowo,
    podnies,
    end: () => socket.end(),
    zniszcz: () => socket.destroy(),
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

test('zawieszony handshake jest zrywany, i to bez plaintextu', async () => {
  const k = polacz(portKrotki);
  await k.read();
  await k.cmd('EHLO tester');
  assert.match(await k.cmd('STARTTLS'), /^220 /);

  // Po 220 nie zaczynamy handshake'u i milkniemy. Bez limitu na okno handshake'u
  // takie połączenie wisiałoby bez końca: jedna linia czystego tekstu przypina
  // gniazdo i deskryptor, bez uwierzytelnienia (slowloris na porcie 25).
  // Serwer ma zerwać · i ani słowa czystym tekstem, bo partner jest w środku
  // negocjacji TLS i każda linia 4xx byłaby tam śmieciem.
  const co = await Promise.race([
    k.read().then((odp) => `plaintext: ${odp}`),
    k.zamkniete().then(() => 'zamkniete'),
    new Promise((r) => setTimeout(() => r('wisi'), KROTKI_LIMIT_MS * 8)),
  ]);
  assert.equal(co, 'zamkniete', 'zawieszony handshake ma zostać zerwany, bez odpowiedzi w czystym tekście');
});

// Te dwa testy pilnują jedynego powodu, dla którego `secureContext` jest funkcją,
// a nie gotowym kontekstem: proces MX żyje miesiącami, certyfikat z certbota trzy.
// Kontekst zapamiętany na starcie znaczy, że po odnowieniu w dniu 60. serwer dalej
// podaje stary · każdy partner negocjujący STARTTLS dostaje wygasły certyfikat,
// poczta się odracza, a potem odbija. Bez zmiany kontekstu MIĘDZY wywołaniami
// pobranie przy handshake i zapamiętanie na starcie są nie do odróżnienia.
test('certyfikat, który pojawia się w biegu, jest ogłaszany bez restartu', async (t) => {
  let biezacy = null; // certbota jeszcze nie było
  const serwer = startSmtpServer(db, {
    port: 0,
    host: '127.0.0.1',
    log: cichy,
    secureContext: () => biezacy,
  });
  await new Promise((r) => serwer.once('listening', r));
  const p = serwer.address().port;
  // Sprzątamy bezwarunkowo · inaczej pierwszy nietrafiony assert zostawia serwer
  // nasłuchujący i cały plik wisi zamiast czerwienić się uczciwie.
  const klienci = [];
  t.after(async () => {
    for (const k of klienci) k.zniszcz();
    await new Promise((r) => serwer.close(r));
  });

  const przed = polacz(p);
  klienci.push(przed);
  await przed.read();
  assert.doesNotMatch(await przed.cmd('EHLO tester'), /STARTTLS/, 'bez certyfikatu nie ma czego ogłaszać');
  assert.match(await przed.cmd('STARTTLS'), /^454 /);
  przed.end();

  // Certyfikat pojawia się w trakcie życia procesu, bez restartu.
  const { certPem, keyPem } = generateSelfSigned({ hostname: 'swiezy.twojapoczta.com' });
  biezacy = tls.createSecureContext({ cert: certPem, key: keyPem });

  const po = polacz(p);
  klienci.push(po);
  await po.read();
  assert.match(
    await po.cmd('EHLO tester'),
    /STARTTLS/,
    'secureContext ma być pytany przy każdym EHLO · zapamiętany na starcie zostałby nullem na zawsze'
  );
  assert.match(await po.cmd('STARTTLS'), /^220 /);
  assert.equal(await po.podnies(), 'swiezy.twojapoczta.com', 'handshake ma podać certyfikat, który właśnie istnieje');
  po.end();
});

test('rotacja certyfikatu: handshake podaje nowy, bez restartu', async (t) => {
  const stary = generateSelfSigned({ hostname: 'stary.twojapoczta.com' });
  const nowy = generateSelfSigned({ hostname: 'nowy.twojapoczta.com' });
  let biezacy = tls.createSecureContext({ cert: stary.certPem, key: stary.keyPem });

  const serwer = startSmtpServer(db, {
    port: 0,
    host: '127.0.0.1',
    log: cichy,
    secureContext: () => biezacy,
  });
  await new Promise((r) => serwer.once('listening', r));
  const p = serwer.address().port;
  const klienci = [];
  t.after(async () => {
    for (const k of klienci) k.zniszcz();
    await new Promise((r) => serwer.close(r));
  });

  // Podnosi połączenie do TLS i mówi, czyj certyfikat zobaczył klient.
  async function cnPoHandshake() {
    const k = polacz(p);
    klienci.push(k);
    await k.read();
    await k.cmd('EHLO tester');
    assert.match(await k.cmd('STARTTLS'), /^220 /);
    const cn = await k.podnies();
    k.end();
    return cn;
  }

  assert.equal(await cnPoHandshake(), 'stary.twojapoczta.com');

  // Certbot odnawia w dniu 60., proces żyje dalej.
  biezacy = tls.createSecureContext({ cert: nowy.certPem, key: nowy.keyPem });

  assert.equal(
    await cnPoHandshake(),
    'nowy.twojapoczta.com',
    'kontekst musi być pobierany przy handshake · zapamiętany raz podawałby po odnowieniu wygasły certyfikat'
  );
});

test('po udanym TLS zwykły limit czasu nadal działa (421, nie nagłe zerwanie)', async () => {
  const k = polacz(portKrotki);
  await k.read();
  await k.cmd('EHLO tester');
  await k.cmd('STARTTLS');
  await k.podnies();
  await k.cmd('EHLO tester');

  // Timer okna handshake'u musi zostać oddany gniazdu szyfrowanemu. Gdyby został
  // uzbrojony na gnieździe surowym, ruch po TLS odświeżałby oba (łańcuch _parent)
  // i na ciszy zerwanie ścigałoby się z 421.
  assert.match(await k.read(), /^421 4\.4\.2 Idle timeout/);
  await k.zamkniete();
});
