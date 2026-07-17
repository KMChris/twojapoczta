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
    if (zrodlo.wskazany) {
      zapamietajZly(zrodlo);
      // Zostajemy tu, bez powrotu przez wybierzZrodlo, więc ostrzeżenie trzeba
      // odświeżyć na miejscu: panel pytany raz nie może widzieć stanu sprzed awarii.
      if (konfiguracja.context && konfiguracja.zrodlo?.wskazany) ostrzez(ostatniDobry(zrodlo.certPath, zrodlo.keyPath));
    }
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
// Obie ścieżki po nazwisku, bo zepsuta bywa każda połowa pary, a operator ma
// wiedzieć która, zamiast szukać po omacku w tej dobrej.
const ZAPASOWY = 'Działa certyfikat zapasowy, samopodpisany.';
const brakPliku = (c, k) => `TP_TLS_CERT (${c}) albo TP_TLS_KEY (${k}) wskazuje na plik, którego nie ma.`;
const zlyPlik = (c, k) => `TP_TLS_CERT (${c}) albo TP_TLS_KEY (${k}) wskazuje na plik, którego nie da się wczytać.`;
const ostatniDobry = (c, k) => `${zlyPlik(c, k)} Działa ostatni poprawnie wczytany certyfikat.`;

function wybierzZrodlo() {
  const certPath = process.env.TP_TLS_CERT;
  const keyPath = process.env.TP_TLS_KEY;
  let powod = null;
  if (certPath && keyPath) {
    const mtime = mtimeAlbo(certPath);
    const mtimeKlucza = mtimeAlbo(keyPath);
    if (mtime === null || mtimeKlucza === null) {
      // Literówka nie może zatrzymać poczty ani cicho zdjąć szyfrowania:
      // schodzimy do zapasowego, ale mówimy o tym głośno w logu i w panelu.
      powod = `${brakPliku(certPath, keyPath)} ${ZAPASOWY}`;
    } else if (!znanyJakoZly(certPath, mtime, mtimeKlucza)) {
      return { certPath, keyPath, wskazany: true, mtime, mtimeKlucza };
    } else if (konfiguracja.context && konfiguracja.zrodlo?.wskazany) {
      // Zepsuty bywa zapis w połowie. Mamy z tego pliku dobry kontekst, więc
      // przy nim zostajemy i nie schodzimy na dysk, aż mtime się zmieni.
      ostrzez(ostatniDobry(certPath, keyPath));
      return konfiguracja.zrodlo;
    } else {
      // Plik jest, ale jest do niczego: dla poczty to samo co literówka.
      powod = `${zlyPlik(certPath, keyPath)} ${ZAPASOWY}`;
    }
  }
  const zapasowy = zrodloSamopodpisane();
  ostrzez([powod, ostrzezenieNazwy()].filter(Boolean).join(' · ') || null);
  return zapasowy;
}

function ostrzezenieNazwy() {
  if (!konfiguracja.nazwaBezPokrycia) return null;
  return `Samopodpisany certyfikat nie obejmuje nazwy ${konfiguracja.hostname}. Szyfrowanie działa, ale klient, który sprawdza nazwę, jej nie dopasuje.`;
}

// Parę, która raz się nie wczytała, odpuszczamy aż któryś z plików się ruszy.
// Inaczej każde połączenie kosztuje dwa odczyty, nieudane parsowanie i linię
// w logu. Klucz liczy się na równi z certyfikatem: wczytanie wywala się też
// przez zły klucz, a wtedy naprawia się sam klucz i mtime certyfikatu stoi.
function znanyJakoZly(certPath, mtime, mtimeKlucza) {
  const zly = konfiguracja.zly;
  return zly?.certPath === certPath && zly.mtime === mtime && zly.mtimeKlucza === mtimeKlucza;
}

function zapamietajZly({ certPath, mtime, mtimeKlucza }) {
  konfiguracja.zly = { certPath, mtime, mtimeKlucza };
}

function zrodloSamopodpisane() {
  const { katalog, hostname } = konfiguracja;
  const certPath = path.join(katalog, 'self-signed-cert.pem');
  const keyPath = path.join(katalog, 'self-signed-key.pem');
  // Jedno spojrzenie na dysk: to samo mtime mówi i czy plik jeszcze jest,
  // i czy wolno wierzyć certyfikatowi z pamięci.
  const cel = { certPath, keyPath, wskazany: false, mtime: mtimeAlbo(certPath) };

  if (!trzebaWygenerowac(cel)) return cel;

  const { certPem, keyPem } = generateSelfSigned({ hostname, days: DNI_WAZNOSCI });
  mkdirSync(katalog, { recursive: true });
  zapiszAtomowo(keyPath, keyPem, 0o600);
  zapiszAtomowo(certPath, certPem, 0o644);
  zdatny(new crypto.X509Certificate(certPem)); // klasyfikacja świeżego: panel ma ją mieć od razu
  return { ...cel, mtime: mtimeAlbo(certPath) };
}

function trzebaWygenerowac({ certPath, mtime }) {
  if (mtime === null) return true; // ktoś wyczyścił tls/: odtwarzamy, zamiast czytać w kółko
  // Certyfikat z tego samego pliku, a plik od tamtej pory nie drgnął: termin
  // sprawdzamy na obiekcie z pamięci, bez parsowania PEM-a na połączenie.
  const swiezy = konfiguracja.zrodlo?.certPath === certPath && konfiguracja.mtime === mtime;
  const cert = (swiezy ? konfiguracja.cert : null) ?? wczytajCert(certPath);
  if (!cert) return true; // nie ma go albo jest uszkodzony
  if (!zdatny(cert)) return true; // zmieniony TP_SMTP_HOSTNAME
  return (cert.validToDate.getTime() - Date.now()) / 86400_000 < PROG_ODNOWIENIA_DNI;
}

// Czy tym certyfikatem da się dalej służyć, i przy okazji: czy trzeba o nim
// ostrzec. Bramka checkHost patrzy na SAN, a ten dla nazwy spoza ASCII wychodzi
// z x509.js zmielony, więc dla takich nazw nie przejdzie nigdy. CN kodujemy
// jako utf8, czyli wiernie: po nim poznajemy własny wyrób na tę właśnie nazwę,
// a skoro nasz, to nowy keygen dałby dokładnie to samo. Stąd punkt stały bramki,
// ważny i po restarcie, nie tylko do końca życia procesu.
function zdatny(cert) {
  const { hostname } = konfiguracja;
  if (cert.checkHost(hostname)) {
    konfiguracja.nazwaBezPokrycia = false;
    return true;
  }
  konfiguracja.nazwaBezPokrycia = nasze(cert, hostname);
  return konfiguracja.nazwaBezPokrycia;
}

// CN bierzemy z rozłożonego obiektu, nie z tekstu subject: renderowany subject
// jest escapowany wedle RFC 2253, więc nazwa z przecinkiem wróciłaby jako
// "CN=mx\,domena.pl" i nigdy nie zgadzałaby się sama ze sobą. A wtedy keygen
// kręciłby się na każde połączenie, czyli dokładnie to, przed czym tu stoimy.
function nasze(cert, hostname) {
  return cert.toLegacyObject().subject?.CN === hostname;
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
