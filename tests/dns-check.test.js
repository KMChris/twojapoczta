// Jednostkowe testy weryfikacji DNS: MX, A, SPF, DKIM, DMARC.
// Resolver wstrzykiwany: żadnych zapytań sieciowych.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDns } from '../server/dns-check.js';

function fakeResolver(map) {
  const oddaj = (klucz) => {
    const wartosc = map[klucz];
    if (wartosc instanceof Error) throw wartosc;
    if (wartosc === undefined) throw Object.assign(new Error('queryNotFound'), { code: 'ENOTFOUND' });
    return wartosc;
  };
  return {
    async resolveMx(name) { return oddaj(`MX ${name}`); },
    async resolve4(name) { return oddaj(`A ${name}`); },
    async resolveTxt(name) { return oddaj(`TXT ${name}`); },
  };
}

const DKIM = {
  name: 'tp1._domainkey.przyklad.pl',
  value: 'v=DKIM1; k=rsa; p=ABCDEF0123',
};

function znajdz(checks, id) {
  return checks.find((c) => c.id === id);
}

test('komplet poprawnych rekordów → wszystkie ok (chunki TXT sklejane)', async () => {
  const resolver = fakeResolver({
    'MX przyklad.pl': [{ priority: 10, exchange: 'mx.przyklad.pl' }],
    'A mx.przyklad.pl': ['203.0.113.7'],
    'TXT przyklad.pl': [['v=spf1 a mx -all']],
    'TXT tp1._domainkey.przyklad.pl': [['v=DKIM1; k=rsa; ', 'p=ABCDEF0123']],
    'TXT _dmarc.przyklad.pl': [['v=DMARC1; p=quarantine']],
  });
  const checks = await checkDns({ domain: 'przyklad.pl', hostname: 'mx.przyklad.pl', dkim: DKIM, resolver });

  for (const id of ['mx', 'a', 'spf', 'dkim', 'dmarc']) {
    assert.equal(znajdz(checks, id).status, 'ok', `rekord ${id}`);
  }
  assert.match(znajdz(checks, 'mx').found, /mx\.przyklad\.pl/);
});

test('pusta strefa → wszystko missing, a bez klucza DKIM check jest skipped', async () => {
  const resolver = fakeResolver({});
  const checks = await checkDns({ domain: 'przyklad.pl', hostname: 'mx.przyklad.pl', dkim: DKIM, resolver });
  for (const id of ['mx', 'a', 'spf', 'dkim', 'dmarc']) {
    assert.equal(znajdz(checks, id).status, 'missing', `rekord ${id}`);
  }

  const bezKlucza = await checkDns({ domain: 'przyklad.pl', hostname: 'mx.przyklad.pl', dkim: null, resolver });
  assert.equal(znajdz(bezKlucza, 'dkim').status, 'skipped');
});

test('MX wskazujący obcy serwer → mismatch z pokazaniem zastanego', async () => {
  const resolver = fakeResolver({
    'MX przyklad.pl': [{ priority: 10, exchange: 'poczta.obcy.pl' }],
  });
  const checks = await checkDns({ domain: 'przyklad.pl', hostname: 'mx.przyklad.pl', dkim: null, resolver });
  const mx = znajdz(checks, 'mx');
  assert.equal(mx.status, 'mismatch');
  assert.match(mx.found, /poczta\.obcy\.pl/);
});

test('opublikowany inny klucz DKIM → mismatch; kropka na końcu MX nie przeszkadza', async () => {
  const resolver = fakeResolver({
    'MX przyklad.pl': [{ priority: 10, exchange: 'MX.przyklad.pl.' }],
    'TXT tp1._domainkey.przyklad.pl': [['v=DKIM1; k=rsa; p=INNYKLUCZ']],
  });
  const checks = await checkDns({ domain: 'przyklad.pl', hostname: 'mx.przyklad.pl', dkim: DKIM, resolver });
  assert.equal(znajdz(checks, 'mx').status, 'ok');
  assert.equal(znajdz(checks, 'dkim').status, 'mismatch');
});

test('awaria resolvera (inny kod niż brak rekordu) → status error', async () => {
  const resolver = fakeResolver({
    'MX przyklad.pl': Object.assign(new Error('ETIMEOUT'), { code: 'ETIMEOUT' }),
  });
  const checks = await checkDns({ domain: 'przyklad.pl', hostname: 'mx.przyklad.pl', dkim: null, resolver });
  const mx = znajdz(checks, 'mx');
  assert.equal(mx.status, 'error');
  assert.match(mx.found, /ETIMEOUT/);
});

test('SPF: rekord TXT bez v=spf1 nie liczy się jako SPF', async () => {
  const resolver = fakeResolver({
    'TXT przyklad.pl': [['google-site-verification=xyz']],
  });
  const checks = await checkDns({ domain: 'przyklad.pl', hostname: 'mx.przyklad.pl', dkim: null, resolver });
  assert.equal(znajdz(checks, 'spf').status, 'missing');
});
