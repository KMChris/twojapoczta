// Samopodpisany certyfikat X.509 (RFC 5280) dla STARTTLS. Node nie umie
// wystawiać certyfikatów: X509Certificate tylko czyta, generateKeyPair daje
// same klucze. Strukturę kodujemy więc DER-em sami. SubjectPublicKeyInfo
// bierzemy gotowe z eksportu SPKI, więc ręcznie kodujemy wyłącznie szkielet
// certyfikatu, nigdy wnętrzności klucza.

import crypto from 'node:crypto';

// --- Prymitywy DER ----------------------------------------------------------

function dlugosc(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bajty = [];
  let x = n;
  while (x > 0) {
    bajty.unshift(x & 0xff);
    x >>= 8;
  }
  return Buffer.from([0x80 | bajty.length, ...bajty]);
}

function tlv(tag, tresc) {
  const body = Buffer.isBuffer(tresc) ? tresc : Buffer.concat(tresc);
  return Buffer.concat([Buffer.from([tag]), dlugosc(body.length), body]);
}

const seq = (...czesci) => tlv(0x30, czesci.flat());
const set = (...czesci) => tlv(0x31, czesci.flat());
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octetString = (buf) => tlv(0x04, buf);
const utf8String = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
// Kontekstowy [nr] w formie konstruowanej (EXPLICIT).
const explicit = (nr, ...czesci) => tlv(0xa0 | nr, czesci.flat());

function int(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0x00 && !(b[i + 1] & 0x80)) i++; // bez zer wiodących
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]); // dodatni, nie ujemny
  return tlv(0x02, b);
}

function bitString(buf, nieuzywaneBity = 0) {
  return tlv(0x03, Buffer.concat([Buffer.from([nieuzywaneBity]), buf]));
}

function oid(tekst) {
  const czesci = tekst.split('.').map(Number);
  const bajty = [czesci[0] * 40 + czesci[1]]; // dwa pierwsze człony w jednym bajcie
  for (const n of czesci.slice(2)) {
    if (n < 0x80) {
      bajty.push(n);
      continue;
    }
    const stos = [];
    let x = n;
    stos.unshift(x & 0x7f);
    x >>= 7;
    while (x > 0) {
      stos.unshift(0x80 | (x & 0x7f)); // base-128, bit ciągłości na starszych
      x >>= 7;
    }
    bajty.push(...stos);
  }
  return tlv(0x06, Buffer.from(bajty));
}

// UTCTime (YYMMDDHHMMSSZ) jest poprawny do 2049 roku, więc przy pięcioletniej
// ważności mieścimy się z zapasem. Po 2049 RFC 5280 każe użyć GeneralizedTime.
function utcTime(data) {
  const p = (n) => String(n).padStart(2, '0');
  const s =
    p(data.getUTCFullYear() % 100) + p(data.getUTCMonth() + 1) + p(data.getUTCDate()) +
    p(data.getUTCHours()) + p(data.getUTCMinutes()) + p(data.getUTCSeconds()) + 'Z';
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

// --- Certyfikat -------------------------------------------------------------

const OID_CN = '2.5.4.3';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SAN = '2.5.29.17';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

// Przy ECDSA parametry AlgorithmIdentifier MUSZĄ być nieobecne (RFC 5758 §3.2).
// RSA wymaga w tym miejscu jawnego NULL. Node połknie oba, część parserów nie.
const algId = () => seq(oid(OID_ECDSA_SHA256));

const nazwaWyrozniona = (cn) => seq(set(seq(oid(OID_CN), utf8String(cn))));

function rozszerzenie(id, krytyczne, wartosc) {
  const czesci = [oid(id)];
  if (krytyczne) czesci.push(bool(true)); // DEFAULT FALSE: fałszu się nie koduje
  czesci.push(octetString(wartosc));
  return seq(...czesci);
}

export function generateSelfSigned({ hostname, days = 1825 }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f; // numer seryjny musi być dodatni

  const teraz = Date.now();
  const notBefore = new Date(teraz - 3600_000); // godzina luzu na rozjechane zegary
  const notAfter = new Date(teraz + days * 86400_000);

  const rozszerzenia = explicit(
    3,
    seq(
      rozszerzenie(OID_BASIC_CONSTRAINTS, true, seq()), // cA=FALSE: wartość domyślna, puste SEQUENCE
      // Sam digitalSignature. keyEncipherment opisuje transport klucza RSA
      // i przy ECDHE_ECDSA nie ma sensu. Bit 0 → 0x80 z siedmioma nieużywanymi.
      rozszerzenie(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)),
      rozszerzenie(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))),
      rozszerzenie(OID_SAN, false, seq(tlv(0x82, Buffer.from(hostname, 'ascii')))) // [2] dNSName
    )
  );

  const tbs = seq(
    explicit(0, int(Buffer.from([2]))), // wersja v3
    int(serial),
    algId(),
    nazwaWyrozniona(hostname), // issuer
    seq(utcTime(notBefore), utcTime(notAfter)),
    nazwaWyrozniona(hostname), // subject: ten sam, bo samopodpisany
    spki,
    rozszerzenia
  );

  // Dla klucza EC Node zwraca podpis od razu jako DER SEQUENCE { r, s },
  // czyli dokładnie w formacie, którego chce X.509. Żadnej konwersji.
  const podpis = crypto.sign('sha256', tbs, privateKey);

  return {
    certPem: pem('CERTIFICATE', seq(tbs, algId(), bitString(podpis))),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function pem(typ, der) {
  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${typ}-----\n${b64}\n-----END ${typ}-----\n`;
}
