// Jednostkowe testy zarządcy certyfikatu: wybór źródła, generowanie zapasowego,
// leniwe odnawianie po mtime, awaryjne zejście przy złej ścieżce, status.
// Certyfikaty lądują w katalogu tymczasowym, stan modułu sprzątamy w finally.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initTls, secureContext, tlsStatus, configureTls } from '../server/tls-cert.js';
import { generateSelfSigned } from '../server/x509.js';

const HOST = 'mx.twojadomena.pl';

function tymczasowy() {
  return mkdtempSync(path.join(os.tmpdir(), 'tp-tls-'));
}

// Zdejmuje stan modułu i zmienne środowiskowe po każdym teście.
function posprzataj(dir) {
  configureTls(null);
  delete process.env.TP_TLS_CERT;
  delete process.env.TP_TLS_KEY;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

test('bez initTls: brak kontekstu, status wyłączony z powodem', () => {
  configureTls(null);
  assert.equal(secureContext(), null);
  assert.deepEqual(tlsStatus(), { enabled: false, reason: 'smtp-off' });
});

test('bez wskazanego certyfikatu generuje samopodpisany do tls/', () => {
  const dir = tymczasowy();
  try {
    const wynik = initTls(dir, { hostname: HOST });
    assert.equal(wynik.source, 'self-signed');

    const certPath = path.join(dir, 'tls', 'self-signed-cert.pem');
    const keyPath = path.join(dir, 'tls', 'self-signed-key.pem');
    assert.ok(existsSync(certPath), 'certyfikat powstał na dysku');
    assert.ok(existsSync(keyPath), 'klucz powstał na dysku');
    assert.ok(secureContext(), 'kontekst się zbudował');

    const cert = new crypto.X509Certificate(readFileSync(certPath));
    assert.equal(cert.checkHost(HOST), HOST);
  } finally {
    posprzataj(dir);
  }
});

test('klucz samopodpisanego ma prawa 0600', { skip: process.platform === 'win32' }, () => {
  const dir = tymczasowy();
  try {
    initTls(dir, { hostname: HOST });
    const tryb = statSync(path.join(dir, 'tls', 'self-signed-key.pem')).mode & 0o777;
    assert.equal(tryb, 0o600);
  } finally {
    posprzataj(dir);
  }
});

test('drugi start wczytuje istniejący certyfikat, nie generuje nowego', () => {
  const dir = tymczasowy();
  try {
    initTls(dir, { hostname: HOST });
    const pierwszy = readFileSync(path.join(dir, 'tls', 'self-signed-cert.pem'), 'utf8');
    configureTls(null);

    initTls(dir, { hostname: HOST });
    const drugi = readFileSync(path.join(dir, 'tls', 'self-signed-cert.pem'), 'utf8');
    assert.equal(drugi, pierwszy, 'ten sam certyfikat, bez regeneracji');
  } finally {
    posprzataj(dir);
  }
});

test('wskazany TP_TLS_CERT wygrywa z samopodpisanym', () => {
  const dir = tymczasowy();
  try {
    const { certPem, keyPem } = generateSelfSigned({ hostname: 'wskazany.example.com' });
    const certPath = path.join(dir, 'wskazany-cert.pem');
    const keyPath = path.join(dir, 'wskazany-key.pem');
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, keyPem);
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    const wynik = initTls(dir, { hostname: HOST });
    assert.equal(wynik.source, 'file');
    assert.ok(!existsSync(path.join(dir, 'tls', 'self-signed-cert.pem')), 'zapasowy nie powstaje niepotrzebnie');

    const status = tlsStatus();
    assert.equal(status.source, 'file');
    assert.equal(status.subject, 'CN=wskazany.example.com');
  } finally {
    posprzataj(dir);
  }
});

test('certbotowy fullchain: status opisuje leafa, kontekst się buduje', () => {
  const dir = tymczasowy();
  try {
    const leaf = generateSelfSigned({ hostname: 'mx.twojadomena.pl' });
    const posredni = generateSelfSigned({ hostname: 'udawany-posredni' });
    const certPath = path.join(dir, 'fullchain.pem');
    const keyPath = path.join(dir, 'privkey.pem');
    writeFileSync(certPath, leaf.certPem + posredni.certPem); // dwa bloki, jak u certbota
    writeFileSync(keyPath, leaf.keyPem);
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    initTls(dir, { hostname: HOST });
    assert.ok(secureContext(), 'createSecureContext łyka łańcuch');
    assert.equal(tlsStatus().subject, 'CN=mx.twojadomena.pl', 'opisujemy leafa, nie pośredniego');
  } finally {
    posprzataj(dir);
  }
});

test('zepsuta ścieżka w TP_TLS_CERT: zapasowy samopodpisany plus ostrzeżenie', () => {
  const dir = tymczasowy();
  try {
    process.env.TP_TLS_CERT = path.join(dir, 'nie-ma-mnie.pem');
    process.env.TP_TLS_KEY = path.join(dir, 'mnie-tez-nie.pem');

    const wynik = initTls(dir, { hostname: HOST });
    assert.equal(wynik.source, 'self-signed', 'literówka nie zdejmuje szyfrowania');

    const status = tlsStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.source, 'self-signed');
    assert.match(status.warning, /TP_TLS_CERT/, 'panel mówi prawdę o pomyłce');
  } finally {
    posprzataj(dir);
  }
});

test('wskazany plik pojawia się po starcie: źródło przełącza się samo', () => {
  const dir = tymczasowy();
  try {
    const certPath = path.join(dir, 'poznyj-cert.pem');
    const keyPath = path.join(dir, 'poznyj-key.pem');
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    initTls(dir, { hostname: HOST });
    assert.equal(tlsStatus().source, 'self-signed', 'na starcie pliku nie ma');

    // certbot dojeżdża już po starcie usługi
    const { certPem, keyPem } = generateSelfSigned({ hostname: 'z-certbota.example.com' });
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, keyPem);

    assert.ok(secureContext());
    const status = tlsStatus();
    assert.equal(status.source, 'file', 'bez restartu usługi');
    assert.equal(status.subject, 'CN=z-certbota.example.com');
    assert.equal(status.warning, null, 'ostrzeżenie znika razem z przyczyną');
  } finally {
    posprzataj(dir);
  }
});

test('podmiana pliku przebudowuje kontekst, brak zmiany go nie rusza', () => {
  const dir = tymczasowy();
  try {
    const pierwszy = generateSelfSigned({ hostname: 'pierwszy.example.com' });
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    writeFileSync(certPath, pierwszy.certPem);
    writeFileSync(keyPath, pierwszy.keyPem);
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    initTls(dir, { hostname: HOST });
    const a = secureContext();
    assert.equal(secureContext(), a, 'bez zmiany mtime ten sam obiekt, żadnego parsowania PEM na połączenie');

    // Odnowienie: nowy plik z nowym mtime (o sekundę do przodu, bo mtime bywa gruboziarniste).
    const drugi = generateSelfSigned({ hostname: 'drugi.example.com' });
    writeFileSync(certPath, drugi.certPem);
    writeFileSync(keyPath, drugi.keyPem);
    const przyszlosc = new Date(Date.now() + 2000);
    utimesSync(certPath, przyszlosc, przyszlosc);

    const b = secureContext();
    assert.notEqual(b, a, 'zmiana mtime przebudowuje kontekst');
    assert.equal(tlsStatus().subject, 'CN=drugi.example.com', 'i to bez restartu');
  } finally {
    posprzataj(dir);
  }
});

test('samopodpisany wygasły jest regenerowany', () => {
  const dir = tymczasowy();
  try {
    // Podkładamy certyfikat sprzed epoki, zanim initTls w ogóle spojrzy w katalog.
    const stary = generateSelfSigned({ hostname: HOST, days: -1 });
    mkdirSync(path.join(dir, 'tls'), { recursive: true });
    writeFileSync(path.join(dir, 'tls', 'self-signed-cert.pem'), stary.certPem);
    writeFileSync(path.join(dir, 'tls', 'self-signed-key.pem'), stary.keyPem);

    initTls(dir, { hostname: HOST });

    const cert = new crypto.X509Certificate(readFileSync(path.join(dir, 'tls', 'self-signed-cert.pem')));
    assert.ok(cert.validToDate.getTime() > Date.now(), 'nowy certyfikat jest ważny');
    assert.ok(tlsStatus().daysLeft > 1800, 'i to na pełne pięć lat');
  } finally {
    posprzataj(dir);
  }
});

test('samopodpisany bliski wygaśnięcia (poniżej 30 dni) jest regenerowany', () => {
  const dir = tymczasowy();
  try {
    const krotki = generateSelfSigned({ hostname: HOST, days: 10 });
    mkdirSync(path.join(dir, 'tls'), { recursive: true });
    writeFileSync(path.join(dir, 'tls', 'self-signed-cert.pem'), krotki.certPem);
    writeFileSync(path.join(dir, 'tls', 'self-signed-key.pem'), krotki.keyPem);

    initTls(dir, { hostname: HOST });
    assert.ok(tlsStatus().daysLeft > 1800, 'próg 30 dni zadziałał z wyprzedzeniem');
  } finally {
    posprzataj(dir);
  }
});

test('zmiana TP_SMTP_HOSTNAME regeneruje samopodpisany na nową nazwę', () => {
  const dir = tymczasowy();
  try {
    initTls(dir, { hostname: 'stara.nazwa.pl' });
    assert.equal(tlsStatus().subject, 'CN=stara.nazwa.pl');
    configureTls(null);

    initTls(dir, { hostname: 'nowa.nazwa.pl' });
    assert.equal(tlsStatus().subject, 'CN=nowa.nazwa.pl', 'certyfikat idzie za nazwą');
  } finally {
    posprzataj(dir);
  }
});

test('status opisuje certyfikat kompletem pól dla panelu', () => {
  const dir = tymczasowy();
  try {
    initTls(dir, { hostname: HOST });
    const s = tlsStatus();

    assert.equal(s.enabled, true);
    assert.equal(s.source, 'self-signed');
    assert.equal(s.hostname, HOST);
    assert.equal(s.subject, `CN=${HOST}`);
    assert.equal(s.issuer, `CN=${HOST}`);
    assert.ok(Date.parse(s.notAfter) > Date.now(), 'notAfter to ISO w przyszłości');
    assert.ok(s.daysLeft > 1800);
    assert.match(s.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'odcisk SHA-256');
    assert.equal(s.warning, null);
  } finally {
    posprzataj(dir);
  }
});
