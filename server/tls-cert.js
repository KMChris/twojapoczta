// Certyfikat TLS dla bramki SMTP. Dwie drogi: wskazany w TP_TLS_CERT/TP_TLS_KEY
// (certbot) albo samopodpisany, generowany do {TP_DATA_DIR}/tls/. Kontekst
// przebudowuje się leniwie, po zmianie mtime pliku, więc odnowienie certyfikatu
// nie wymaga restartu usługi. Stan modułu jak w dkim.js.

import crypto from 'node:crypto';
import tls from 'node:tls';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateSelfSigned } from './x509.js';

const DNI_WAZNOSCI = 1825; // 5 lat: samopodpisanego i tak nikt nie sprawdza
const PROG_ODNOWIENIA_DNI = 30;

// { hostname, katalog, zrodlo, mtime, context, cert, ostrzezenie, zly, nazwaBezPokrycia }
let konfiguracja = null;

export function initTls(dataDir, { hostname }) {
  konfiguracja = {
    hostname,
    katalog: path.join(dataDir, 'tls'),
    zrodlo: null,
    mtime: null,
    context: null,
    cert: null,
    ostrzezenie: null,
    zly: null, // { certPath, mtime } pliku, który się nie wczytał
    nazwaBezPokrycia: false, // samopodpisany nie obejmuje hostname i nic na to nie poradzimy
  };
  // Budujemy od razu, żeby błąd konfiguracji był widoczny w logu przy starcie,
  // a nie dopiero przy pierwszym liście ze świata.
  secureContext();
  return {
    source: konfiguracja.zrodlo?.wskazany ? 'file' : 'self-signed',
    certPath: konfiguracja.zrodlo?.certPath ?? null,
  };
}

// Do testów i nietypowych wdrożeń: stan bez dotykania dysku.
export function configureTls(cfg) {
  konfiguracja = cfg;
}

export function secureContext() {
  if (!konfiguracja) return null;
  try {
    const zrodlo = wybierzZrodlo();
    const kontekst = zbuduj(zrodlo);
    // Wskazany plik zawiódł, a w pamięci nie ma nic dobrego: schodzimy na
    // zapasowy jeszcze w tym wywołaniu, bo zepsuty plik nie może zdjąć
    // szyfrowania. Jest już zapamiętany jako zły, więc wybór go ominie.
    if (!kontekst && zrodlo.wskazany) return zbuduj(wybierzZrodlo());
    return kontekst;
  } catch (err) {
    // Dysk tylko do odczytu, brak miejsca na klucz: nie wywracamy połączenia.
    console.error('[tls] nie udało się przygotować certyfikatu:', err.message);
    return konfiguracja.context;
  }
}

// Kontekst z podanego źródła albo, gdy plik zawiódł, ostatni dobry (bywa null).
// Nie rzuca: błąd pliku nie może przerwać obsługi połączenia.
function zbuduj(zrodlo) {
  if (konfiguracja.context && konfiguracja.zrodlo?.certPath === zrodlo.certPath && konfiguracja.mtime === zrodlo.mtime) {
    return konfiguracja.context; // nic się nie zmieniło: bez parsowania PEM-a
  }
  try {
    const certPem = readFileSync(zrodlo.certPath, 'utf8');
    const keyPem = readFileSync(zrodlo.keyPath, 'utf8');
    konfiguracja.context = tls.createSecureContext({ cert: certPem, key: keyPem });
    // Przy fullchain z certbota X509Certificate bierze pierwszy blok, czyli leafa.
    konfiguracja.cert = new crypto.X509Certificate(certPem);
    konfiguracja.zrodlo = zrodlo;
    konfiguracja.mtime = zrodlo.mtime;
    if (zrodlo.wskazany) ostrzez(null); // plik wczytany: ostrzeżenie straciło powód
    return konfiguracja.context;
  } catch (err) {
    // Plik mógł zniknąć albo być w połowie zapisu. Zostajemy przy ostatnim dobrym.
    console.error('[tls] nie udało się wczytać certyfikatu:', err.message);
    if (zrodlo.wskazany) zapamietajZly(zrodlo);
    return konfiguracja.context;
  }
}

export function tlsStatus() {
  if (!konfiguracja) return { enabled: false, reason: 'smtp-off' };
  const kontekst = secureContext();
  if (!kontekst || !konfiguracja.cert) {
    return { enabled: false, reason: 'no-cert', warning: konfiguracja.ostrzezenie };
  }
  const cert = konfiguracja.cert;
  return {
    enabled: true,
    source: konfiguracja.zrodlo.wskazany ? 'file' : 'self-signed',
    hostname: konfiguracja.hostname,
    // Przy wielu RDN-ach Node rozdziela człony znakiem nowej linii.
    subject: cert.subject.replace(/\n/g, ', '),
    issuer: cert.issuer.replace(/\n/g, ', '),
    notAfter: cert.validToDate.toISOString(),
    daysLeft: Math.floor((cert.validToDate.getTime() - Date.now()) / 86400_000),
    fingerprint: cert.fingerprint256,
    warning: konfiguracja.ostrzezenie,
  };
}

// --- Wybór źródła ------------------------------------------------------------

// Zdanie o przyczynie plus zdanie o skutku: w panelu widać jedno i drugie.
const ZAPASOWY = 'Działa certyfikat zapasowy, samopodpisany.';
const brakPliku = (p) => `TP_TLS_CERT albo TP_TLS_KEY wskazuje na plik, którego nie ma (${p}).`;
const zlyPlik = (p) => `TP_TLS_CERT albo TP_TLS_KEY wskazuje na plik, którego nie da się wczytać (${p}).`;

function wybierzZrodlo() {
  const certPath = process.env.TP_TLS_CERT;
  const keyPath = process.env.TP_TLS_KEY;
  let powod = null;
  if (certPath && keyPath) {
    const mtime = mtimeAlbo(certPath);
    if (mtime === null || mtimeAlbo(keyPath) === null) {
      // Literówka nie może zatrzymać poczty ani cicho zdjąć szyfrowania:
      // schodzimy do zapasowego, ale mówimy o tym głośno w logu i w panelu.
      powod = `${brakPliku(certPath)} ${ZAPASOWY}`;
    } else if (!znanyJakoZly(certPath, mtime)) {
      return { certPath, keyPath, wskazany: true, mtime };
    } else if (konfiguracja.context && konfiguracja.zrodlo?.wskazany) {
      // Zepsuty bywa zapis w połowie. Mamy z tego pliku dobry kontekst, więc
      // przy nim zostajemy i nie schodzimy na dysk, aż mtime się zmieni.
      ostrzez(`${zlyPlik(certPath)} Działa ostatni poprawnie wczytany certyfikat.`);
      return konfiguracja.zrodlo;
    } else {
      // Plik jest, ale jest do niczego: dla poczty to samo co literówka.
      powod = `${zlyPlik(certPath)} ${ZAPASOWY}`;
    }
  }
  const zapasowy = zrodloSamopodpisane();
  ostrzez([powod, ostrzezenieNazwy()].filter(Boolean).join(' · ') || null);
  return { ...zapasowy, mtime: mtimeAlbo(zapasowy.certPath) };
}

function ostrzezenieNazwy() {
  if (!konfiguracja.nazwaBezPokrycia) return null;
  return `Samopodpisany certyfikat nie obejmuje nazwy ${konfiguracja.hostname}. Szyfrowanie działa, ale klient, który sprawdza nazwę, jej nie dopasuje.`;
}

// Plik, który raz się nie wczytał, odpuszczamy aż do zmiany mtime. Inaczej
// każde połączenie kosztuje dwa odczyty, nieudane parsowanie i linię w logu.
function znanyJakoZly(certPath, mtime) {
  return konfiguracja.zly?.certPath === certPath && konfiguracja.zly.mtime === mtime;
}

function zapamietajZly({ certPath, mtime }) {
  konfiguracja.zly = { certPath, mtime };
}

function zrodloSamopodpisane() {
  const { katalog, hostname } = konfiguracja;
  const certPath = path.join(katalog, 'self-signed-cert.pem');
  const keyPath = path.join(katalog, 'self-signed-key.pem');
  const cel = { certPath, keyPath, wskazany: false };

  if (!trzebaWygenerowac(certPath, hostname)) return cel;

  const { certPem, keyPem } = generateSelfSigned({ hostname, days: DNI_WAZNOSCI });
  mkdirSync(katalog, { recursive: true });
  zapiszAtomowo(keyPath, keyPem, 0o600);
  zapiszAtomowo(certPath, certPem, 0o644);
  // Domknięcie bramki nazwy: skoro świeży certyfikat jej nie przechodzi,
  // następny też nie przejdzie (SAN spoza ASCII wychodzi z x509.js zmielony).
  // Zapamiętujemy to i zostajemy przy nim, zamiast kręcić keygenem bez końca.
  konfiguracja.nazwaBezPokrycia = !new crypto.X509Certificate(certPem).checkHost(hostname);
  return cel;
}

function trzebaWygenerowac(certPath, hostname) {
  // Certyfikat już wczytany i wciąż nasz: sprawdzamy termin na obiekcie
  // z pamięci, bez schodzenia na dysk przy każdym połączeniu.
  const wPamieci = konfiguracja.zrodlo?.certPath === certPath ? konfiguracja.cert : null;
  const cert = wPamieci ?? wczytajCert(certPath);
  if (!cert) return true;
  // Bramka nazwy tylko dopóki wiadomo, że da się ją przejść: bez tego
  // generowalibyśmy w kółko certyfikat, który i tak jej nie przejdzie.
  if (!konfiguracja.nazwaBezPokrycia && !cert.checkHost(hostname)) return true; // zmieniony TP_SMTP_HOSTNAME
  return (cert.validToDate.getTime() - Date.now()) / 86400_000 < PROG_ODNOWIENIA_DNI;
}

function wczytajCert(certPath) {
  try {
    return new crypto.X509Certificate(readFileSync(certPath));
  } catch {
    return null; // nie ma go albo jest uszkodzony: wygenerujemy nowy
  }
}

function mtimeAlbo(sciezka) {
  try {
    return statSync(sciezka).mtimeMs;
  } catch {
    return null;
  }
}

// Zapis obok i przemianowanie: serwer nigdy nie przeczyta połowy pliku.
function zapiszAtomowo(sciezka, tresc, mode) {
  const tymczasowy = `${sciezka}.tmp`;
  writeFileSync(tymczasowy, tresc, { mode });
  renameSync(tymczasowy, sciezka);
}

// Log tylko przy zmianie, nie na każde połączenie.
function ostrzez(tekst) {
  if (konfiguracja.ostrzezenie === tekst) return;
  konfiguracja.ostrzezenie = tekst;
  if (tekst) console.error('[tls]', tekst);
}
