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
    assert.equal(wynik.certPath, certPath, 'i mówi, gdzie go położył: z tej ścieżki korzysta bramka');
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
    assert.equal(wynik.certPath, certPath, 'wskazana ścieżka wraca do wołającego, nie null');
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

// Zepsuty plik jest gorszy od brakującego: statSync go widzi, więc dawniej
// wchodziliśmy w gałąź „wskazany" i zostawaliśmy bez żadnego certyfikatu.
test('uszkodzony plik w TP_TLS_CERT: zapasowy samopodpisany plus ostrzeżenie', () => {
  const dir = tymczasowy();
  try {
    const { certPem, keyPem } = generateSelfSigned({ hostname: 'z-certbota.example.com' });
    const certPath = path.join(dir, 'fullchain.pem');
    const keyPath = path.join(dir, 'privkey.pem');
    writeFileSync(certPath, certPem.slice(0, 120)); // ucięty: nagłówek PEM i śmieć
    writeFileSync(keyPath, keyPem);
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    const wynik = initTls(dir, { hostname: HOST });
    assert.equal(wynik.source, 'self-signed', 'zepsuty plik traktujemy jak brakujący');
    assert.equal(wynik.certPath, path.join(dir, 'tls', 'self-signed-cert.pem'), 'i nie kłamiemy o ścieżce');

    const status = tlsStatus();
    assert.equal(status.enabled, true, 'szyfrowanie zostaje na nogach');
    assert.equal(status.source, 'self-signed');
    assert.equal(status.subject, `CN=${HOST}`);
    assert.match(status.warning, /nie da się wczytać/, 'panel mówi, dlaczego zszedł na zapasowy');
  } finally {
    posprzataj(dir);
  }
});

test('uszkodzony plik zapamiętany: bez czytania i logu na każde połączenie', () => {
  const dir = tymczasowy();
  const pierwotnyLog = console.error;
  const linie = [];
  try {
    const { certPem, keyPem } = generateSelfSigned({ hostname: 'z-certbota.example.com' });
    const certPath = path.join(dir, 'fullchain.pem');
    const keyPath = path.join(dir, 'privkey.pem');
    writeFileSync(certPath, certPem.slice(0, 120));
    writeFileSync(keyPath, keyPem);
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    console.error = (...czesci) => linie.push(czesci.join(' '));
    initTls(dir, { hostname: HOST });
    const kontekst = secureContext();
    linie.length = 0; // start ma prawo krzyczeć, liczymy dopiero ruch

    // EHLO i STARTTLS wołają secureContext() na każde połączenie.
    for (let i = 0; i < 50; i++) assert.equal(secureContext(), kontekst, 'stabilny kontekst');
    assert.deepEqual(linie, [], 'zły plik zapamiętany: żadnego odczytu ani linii w logu na połączenie');
  } finally {
    console.error = pierwotnyLog;
    posprzataj(dir);
  }
});

test('uszkodzony plik naprawia się później: źródło wraca na plik', () => {
  const dir = tymczasowy();
  try {
    const { certPem, keyPem } = generateSelfSigned({ hostname: 'z-certbota.example.com' });
    const certPath = path.join(dir, 'fullchain.pem');
    const keyPath = path.join(dir, 'privkey.pem');
    writeFileSync(certPath, certPem.slice(0, 120));
    writeFileSync(keyPath, keyPem);
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    initTls(dir, { hostname: HOST });
    assert.equal(tlsStatus().source, 'self-signed', 'na starcie plik jest do niczego');

    // certbot dopisuje resztę: nowy mtime zdejmuje pamięć o złym pliku
    writeFileSync(certPath, certPem);
    const przyszlosc = new Date(Date.now() + 2000);
    utimesSync(certPath, przyszlosc, przyszlosc);

    const status = tlsStatus();
    assert.equal(status.source, 'file', 'pamięć o złym pliku nie zakleszcza źródła');
    assert.equal(status.subject, 'CN=z-certbota.example.com');
    assert.equal(status.warning, null, 'ostrzeżenie znika razem z przyczyną');
  } finally {
    posprzataj(dir);
  }
});

test('plik psuje się w locie: zostaje ostatni dobry kontekst', () => {
  const dir = tymczasowy();
  try {
    const dobry = generateSelfSigned({ hostname: 'z-certbota.example.com' });
    const certPath = path.join(dir, 'fullchain.pem');
    const keyPath = path.join(dir, 'privkey.pem');
    writeFileSync(certPath, dobry.certPem);
    writeFileSync(keyPath, dobry.keyPem);
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    initTls(dir, { hostname: HOST });
    const dobryKontekst = secureContext();
    assert.equal(tlsStatus().source, 'file');

    // certbot przyłapany w połowie zapisu: plik jest, ale nie da się go sparsować
    writeFileSync(certPath, dobry.certPem.slice(0, 120));
    const przyszlosc = new Date(Date.now() + 2000);
    utimesSync(certPath, przyszlosc, przyszlosc);

    // Pytamy panel jako pierwszy: to dokładnie jedno secureContext(), więc
    // ostrzeżenie musi być świeże już po pierwszej nieudanej próbie odczytu.
    const status = tlsStatus();
    assert.equal(status.source, 'file', 'trzymamy ostatni dobry, nie schodzimy na zapasowy');
    assert.equal(status.subject, 'CN=z-certbota.example.com');
    assert.match(status.warning, /nie da się wczytać/, 'i to od razu, nie dopiero przy drugim pytaniu');
    assert.equal(secureContext(), dobryKontekst, 'połowa zapisu nie zdejmuje szyfrowania');
    assert.ok(!existsSync(path.join(dir, 'tls', 'self-signed-cert.pem')), 'zapasowy niepotrzebny, skoro mamy dobry');
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

// Samopodpisany ma te same dwie dziury co wskazany, tylko po drugiej stronie
// rozgałęzienia: certyfikat z pamięci przykrywa to, co stało się z plikiem.
test('skasowany samopodpisany odtwarza się sam, bez logu na połączenie', () => {
  const dir = tymczasowy();
  const pierwotnyLog = console.error;
  const linie = [];
  try {
    initTls(dir, { hostname: HOST });
    const certPath = path.join(dir, 'tls', 'self-signed-cert.pem');

    // Operator czyści tls/, żeby wymusić świeży certyfikat. Albo sprzątaczka /tmp.
    rmSync(path.join(dir, 'tls'), { recursive: true, force: true });

    console.error = (...czesci) => linie.push(czesci.join(' '));
    for (let i = 0; i < 20; i++) secureContext();
    console.error = pierwotnyLog;

    assert.ok(existsSync(certPath), 'certyfikat wraca na dysk sam, bez restartu usługi');
    assert.deepEqual(linie, [], 'i bez linii w logu na każde połączenie');
    assert.equal(tlsStatus().enabled, true, 'szyfrowanie ani na chwilę nie siada');
  } finally {
    console.error = pierwotnyLog;
    posprzataj(dir);
  }
});

test('uszkodzony samopodpisany odtwarza się sam, bez logu na połączenie', () => {
  const dir = tymczasowy();
  const pierwotnyLog = console.error;
  const linie = [];
  try {
    initTls(dir, { hostname: HOST });
    const certPath = path.join(dir, 'tls', 'self-signed-cert.pem');

    writeFileSync(certPath, '-----BEGIN CERTIFICATE-----\nśmieć\n');
    const przyszlosc = new Date(Date.now() + 2000);
    utimesSync(certPath, przyszlosc, przyszlosc);

    console.error = (...czesci) => linie.push(czesci.join(' '));
    for (let i = 0; i < 20; i++) secureContext();
    console.error = pierwotnyLog;

    const naDysku = new crypto.X509Certificate(readFileSync(certPath)); // rzuci, jeśli dalej śmieć
    assert.equal(naDysku.checkHost(HOST), HOST, 'na dysku znów jest prawdziwy certyfikat na naszą nazwę');
    assert.deepEqual(linie, [], 'bez linii w logu na każde połączenie');
    assert.equal(tlsStatus().enabled, true);
  } finally {
    console.error = pierwotnyLog;
    posprzataj(dir);
  }
});

test('naprawiony sam klucz wraca na plik, bez restartu', () => {
  const dir = tymczasowy();
  try {
    const { certPem, keyPem } = generateSelfSigned({ hostname: 'z-certbota.example.com' });
    const certPath = path.join(dir, 'fullchain.pem');
    const keyPath = path.join(dir, 'privkey.pem');
    writeFileSync(certPath, certPem);
    writeFileSync(keyPath, 'to-nie-klucz'); // zepsuta jest druga połowa pary
    process.env.TP_TLS_CERT = certPath;
    process.env.TP_TLS_KEY = keyPath;

    initTls(dir, { hostname: HOST });
    assert.equal(tlsStatus().source, 'self-signed', 'zły klucz schodzi na zapasowy jak zły certyfikat');
    assert.match(tlsStatus().warning, /privkey\.pem/, 'ostrzeżenie pokazuje klucz, bo to on jest zepsuty');

    // Operator poprawia sam klucz: mtime certyfikatu ani drgnie.
    const mtimeCertu = statSync(certPath).mtimeMs;
    writeFileSync(keyPath, keyPem);
    const przyszlosc = new Date(Date.now() + 2000);
    utimesSync(keyPath, przyszlosc, przyszlosc);
    assert.equal(statSync(certPath).mtimeMs, mtimeCertu, 'certyfikat nietknięty: o to w tym teście chodzi');

    const status = tlsStatus();
    assert.equal(status.source, 'file', 'naprawa klucza wystarcza, pamięć o złej parze puszcza');
    assert.equal(status.subject, 'CN=z-certbota.example.com');
    assert.equal(status.warning, null, 'ostrzeżenie znika razem z przyczyną');
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

// Bramka nazwy w trzebaWygenerowac nie ma punktu stałego dla nazwy spoza ASCII:
// x509.js koduje SAN jako ascii, więc checkHost nigdy jej nie dopasuje, choćby
// generować bez końca. Świeży certyfikat musi domykać pętlę, nie zaczynać nową.
test('nazwa spoza ASCII: generujemy raz i ostrzegamy, zamiast kręcić keygenem', () => {
  const dir = tymczasowy();
  try {
    const wynik = initTls(dir, { hostname: 'mx.żółć.pl' });
    assert.equal(wynik.source, 'self-signed');

    const certPath = path.join(dir, 'tls', 'self-signed-cert.pem');
    const poStarcie = readFileSync(certPath, 'utf8');
    const kontekst = secureContext();
    for (let i = 0; i < 20; i++) secureContext(); // EHLO i STARTTLS na każde połączenie

    assert.equal(readFileSync(certPath, 'utf8'), poStarcie, 'ani jednego keygenu po starcie');
    assert.equal(secureContext(), kontekst, 'i ten sam kontekst, bez przebudowy na połączenie');

    const status = tlsStatus();
    assert.equal(status.enabled, true, 'MTA-to-MTA nie sprawdza nazwy: szyfrowanie działa mimo wszystko');
    assert.equal(status.subject, 'CN=mx.żółć.pl');
    assert.match(status.warning, /mx\.żółć\.pl/, 'panel widzi problem, zamiast cichej pętli');

    // Restart: bramka nadal nie do przejścia, ale certyfikat jest nasz i na tę
    // właśnie nazwę, więc drugi start ma go wczytać, a nie palić keygenu.
    // Inaczej każdy restart podmienia odcisk w panelu.
    configureTls(null);
    initTls(dir, { hostname: 'mx.żółć.pl' });
    assert.equal(readFileSync(certPath, 'utf8'), poStarcie, 'drugi start też nie generuje nowego');
    assert.match(tlsStatus().warning, /mx\.żółć\.pl/, 'a ostrzeżenie wraca bez keygenu');
  } finally {
    posprzataj(dir);
  }
});

// Rozpoznanie własnego wyrobu nie może opierać się na renderowanym subject:
// RFC 2253 każe escapować przecinek i spółkę, więc dla takiej nazwy tekstowe
// porównanie nigdy nie trafi i keygen kręciłby się w kółko mimo poprawki wyżej.
test('nazwa spoza ASCII ze znakiem do escapowania: też ani jednego keygenu w kółko', () => {
  const dir = tymczasowy();
  try {
    initTls(dir, { hostname: 'mx,żółć.pl' });
    const certPath = path.join(dir, 'tls', 'self-signed-cert.pem');
    const poStarcie = readFileSync(certPath, 'utf8');

    for (let i = 0; i < 20; i++) secureContext();
    assert.equal(readFileSync(certPath, 'utf8'), poStarcie, 'ani jednego keygenu po starcie');
    assert.equal(tlsStatus().enabled, true, 'szyfrowanie działa mimo dziwnej nazwy');

    configureTls(null);
    initTls(dir, { hostname: 'mx,żółć.pl' });
    assert.equal(readFileSync(certPath, 'utf8'), poStarcie, 'i drugi start też go nie podmienia');
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
