// Jednostkowe testy generatora samopodpisanego certyfikatu: czy to, co
// wypluwa enkoder DER, jest naprawdę poprawnym X.509, a nie tylko wygląda.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { generateSelfSigned } from '../server/x509.js';

test('certyfikat parsuje się i opisuje żądaną nazwę', () => {
  const { certPem } = generateSelfSigned({ hostname: 'mx.twojadomena.pl' });
  const cert = new crypto.X509Certificate(certPem);

  assert.equal(cert.subject, 'CN=mx.twojadomena.pl');
  assert.equal(cert.issuer, 'CN=mx.twojadomena.pl', 'samopodpisany: wystawca to on sam');
  assert.equal(cert.subjectAltName, 'DNS:mx.twojadomena.pl');
  // checkHost zwraca nazwę przy trafieniu i undefined przy pudle, nie boolean.
  assert.equal(cert.checkHost('mx.twojadomena.pl'), 'mx.twojadomena.pl');
  assert.equal(cert.checkHost('zly.example.com'), undefined);
});

test('podpis pod certyfikatem jest poprawny (DER naprawdę się zgadza)', () => {
  const { certPem, keyPem } = generateSelfSigned({ hostname: 'mx.twojadomena.pl' });
  const cert = new crypto.X509Certificate(certPem);

  // Najważniejszy test w tym pliku: verify liczy podpis po bajtach TBSCertificate.
  // Przejdzie tylko wtedy, gdy nasze kodowanie DER jest poprawne co do bajtu.
  assert.equal(cert.verify(cert.publicKey), true);
  assert.equal(cert.checkPrivateKey(crypto.createPrivateKey(keyPem)), true);
});

test('klucz to ECDSA P-256 w PKCS#8', () => {
  const { keyPem } = generateSelfSigned({ hostname: 'mx.twojadomena.pl' });
  assert.match(keyPem, /^-----BEGIN PRIVATE KEY-----/);
  const key = crypto.createPrivateKey(keyPem);
  assert.equal(key.asymmetricKeyType, 'ec');
  assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('rozszerzenia: nie jest CA, służy do uwierzytelniania serwera', () => {
  const { certPem } = generateSelfSigned({ hostname: 'mx.twojadomena.pl' });
  const cert = new crypto.X509Certificate(certPem);

  assert.equal(cert.ca, false);
  // Uwaga: X509Certificate.keyUsage zwraca extKeyUsage (OID-y), nie bity keyUsage.
  assert.deepEqual(cert.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'serverAuth');
});

test('ważność liczy się od teraz o zadaną liczbę dni', () => {
  const { certPem } = generateSelfSigned({ hostname: 'mx.twojadomena.pl', days: 30 });
  const cert = new crypto.X509Certificate(certPem);

  const dni = (cert.validToDate.getTime() - Date.now()) / 86400_000;
  assert.ok(dni > 29.9 && dni < 30.1, `spodziewane ~30 dni, jest ${dni}`);
  // notBefore cofnięty o godzinę: tolerancja na rozjechane zegary.
  assert.ok(cert.validFromDate.getTime() < Date.now() - 3500_000);
});

test('days ujemne dają certyfikat już wygasły (potrzebne do testów odnawiania)', () => {
  const { certPem } = generateSelfSigned({ hostname: 'mx.twojadomena.pl', days: -1 });
  const cert = new crypto.X509Certificate(certPem);
  assert.ok(cert.validToDate.getTime() < Date.now());
});

test('numer seryjny jest dodatni i losowy', () => {
  const a = new crypto.X509Certificate(generateSelfSigned({ hostname: 'a.pl' }).certPem);
  const b = new crypto.X509Certificate(generateSelfSigned({ hostname: 'a.pl' }).certPem);

  assert.notEqual(a.serialNumber, b.serialNumber);
  // Najstarszy bit wygaszony, więc DER nie zakoduje liczby ujemnej.
  assert.doesNotMatch(a.serialNumber, /^[89a-f]/i);
  assert.doesNotMatch(b.serialNumber, /^[89a-f]/i);
});

test('certyfikat naprawdę obsługuje handshake TLS', async () => {
  const { certPem, keyPem } = generateSelfSigned({ hostname: 'mx.twojadomena.pl' });
  const ctx = tls.createSecureContext({ cert: certPem, key: keyPem });

  const serwer = net.createServer((socket) => {
    const bezpieczny = new tls.TLSSocket(socket, { isServer: true, secureContext: ctx });
    bezpieczny.on('error', () => bezpieczny.destroy());
    bezpieczny.on('secure', () => bezpieczny.write('ok'));
  });
  await new Promise((r) => serwer.listen(0, '127.0.0.1', r));

  try {
    const klient = tls.connect({ port: serwer.address().port, host: '127.0.0.1', rejectUnauthorized: false });
    await new Promise((r, j) => {
      klient.once('secureConnect', r);
      klient.once('error', j);
    });
    const odp = await new Promise((r) => klient.once('data', (c) => r(c.toString())));
    assert.equal(odp, 'ok');
    assert.equal(klient.getPeerCertificate().subject.CN, 'mx.twojadomena.pl');
    klient.destroy();
  } finally {
    serwer.close();
  }
});
