// DKIM: wektory kanonizacji z RFC 6376 i pełna pętla podpis → niezależna weryfikacja.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  configureDkim, signMessage, canonHeaderRelaxed, canonBodyRelaxed, dnsRecord,
} from '../server/dkim.js';
import { buildRawMessage } from '../server/smtp-out.js';
import { parseMessage } from '../server/mime.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

test('kanonizacja relaxed zgodna z przykładami z RFC 6376 §3.4.5', () => {
  assert.equal(canonHeaderRelaxed('A', ' X'), 'a:X');
  assert.equal(canonHeaderRelaxed('B ', ' Y\t\r\n\tZ  '), 'b:Y Z');
  assert.equal(canonBodyRelaxed(' C \r\nD \t E\r\n\r\n\r\n'), ' C\r\nD E\r\n');
  assert.equal(canonBodyRelaxed(''), '');
  assert.equal(canonBodyRelaxed('\r\n\r\n'), '');
});

// Niezależny weryfikator: robi dokładnie to, co serwer odbiorcy:
// parsuje wyemitowane (pofoldowane) bajty, kanonizuje, liczy bh, weryfikuje b.
function zweryfikuj(raw, pub) {
  const idx = raw.indexOf('\r\n\r\n');
  const head = raw.slice(0, idx);
  const body = raw.slice(idx + 4);

  const pola = [];
  for (const linia of head.split('\r\n')) {
    if (/^[ \t]/.test(linia) && pola.length) {
      pola[pola.length - 1][1] += '\r\n' + linia;
      continue;
    }
    const sep = linia.indexOf(':');
    pola.push([linia.slice(0, sep), linia.slice(sep + 1)]);
  }
  const dkim = pola.find(([nazwa]) => nazwa.toLowerCase() === 'dkim-signature');
  assert.ok(dkim, 'brak nagłówka DKIM-Signature');

  const wartoscCanon = dkim[1].replace(/\r\n[ \t]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const tagi = Object.fromEntries(
    wartoscCanon
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)])
  );

  assert.equal(tagi.v, '1');
  assert.equal(tagi.a, 'rsa-sha256');
  assert.equal(tagi.c, 'relaxed/relaxed');

  // 1. skrót ciała
  const bh = crypto.createHash('sha256').update(canonBodyRelaxed(body), 'utf8').digest('base64');
  assert.equal(tagi.bh.replace(/\s+/g, ''), bh, 'bh nie zgadza się z treścią');

  // 2. wejście podpisu: nagłówki z h= (wybierane od dołu) + DKIM-Signature z pustym b=
  const zuzyte = new Set();
  const wejscia = [];
  for (const nazwa of tagi.h.split(':').map((n) => n.trim())) {
    for (let i = pola.length - 1; i >= 0; i--) {
      if (zuzyte.has(i) || pola[i][0].toLowerCase().trim() !== nazwa) continue;
      zuzyte.add(i);
      wejscia.push(canonHeaderRelaxed(pola[i][0], pola[i][1]));
      break;
    }
  }
  const dkimBezB = wartoscCanon.replace(/([;\s]b=)[^;]*/, '$1');
  wejscia.push(canonHeaderRelaxed('dkim-signature', dkimBezB));

  const poprawny = crypto.verify(
    'sha256',
    Buffer.from(wejscia.join('\r\n'), 'utf8'),
    pub,
    Buffer.from(tagi.b.replace(/\s+/g, ''), 'base64')
  );
  assert.ok(poprawny, 'podpis RSA nie przechodzi weryfikacji');
  return tagi;
}

test('podpis przechodzi niezależną weryfikację (multipart z załącznikiem)', () => {
  try {
    configureDkim({ privateKey, selector: 'tp1', domain: 'twojapoczta.com' });
    const raw = buildRawMessage({
      domain: 'twojapoczta.com',
      from: { name: 'Jan Żółty', addr: 'demo@twojapoczta.com' },
      to: ['ktos@example.com'],
      subject: 'Podpisany żółty temat · DKIM',
      body: 'Treść z ogonkami: źdźbło żółci.\nDruga linia.',
      attachments: [{ filename: 'ż.txt', mime: 'text/plain', data: Buffer.from('dane załącznika') }],
    });
    const podpisany = signMessage(raw);
    assert.ok(podpisany.startsWith('DKIM-Signature:'), 'podpis dokleja się na początku');

    const tagi = zweryfikuj(podpisany, publicKey);
    assert.equal(tagi.d, 'twojapoczta.com');
    assert.equal(tagi.s, 'tp1');
    assert.match(tagi.h, /^from:to:subject/);

    // higiena foldowania: żadna wyemitowana linia nie przekracza limitu RFC
    for (const linia of podpisany.split('\r\n')) {
      assert.ok(linia.length <= 998, `za długa linia: ${linia.length}`);
    }

    // podpisana wiadomość nadal normalnie się parsuje
    const m = parseMessage(Buffer.from(podpisany, 'latin1'));
    assert.equal(m.subject, 'Podpisany żółty temat · DKIM');
    assert.match(m.body, /źdźbło żółci/);
    assert.equal(m.attachments.length, 1);
  } finally {
    configureDkim(null);
  }
});

test('podpis prostej wiadomości bez załączników też się weryfikuje', () => {
  try {
    configureDkim({ privateKey, selector: 'poczta', domain: 'twojapoczta.com' });
    const raw = buildRawMessage({
      domain: 'twojapoczta.com',
      from: { name: '', addr: 'ania@twojapoczta.com' },
      to: ['a@example.com', 'b@example.com'],
      subject: 'Zwykły tekst',
      body: 'Linia pierwsza.\n\nLinia po pustej.   \n\n\n',
    });
    const tagi = zweryfikuj(signMessage(raw), publicKey);
    assert.equal(tagi.s, 'poczta');
  } finally {
    configureDkim(null);
  }
});

test('bez konfiguracji wiadomość wychodzi bez zmian', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'X', addr: 'x@twojapoczta.com' },
    to: ['y@example.com'],
    subject: 'x',
    body: 'x',
  });
  assert.equal(signMessage(raw), raw);
});

test('rekord DNS ma poprawny kształt', () => {
  try {
    configureDkim({ privateKey, selector: 'tp1', domain: 'twojapoczta.com' });
    const rekord = dnsRecord();
    assert.equal(rekord.nazwa, 'tp1._domainkey.twojapoczta.com');
    assert.match(rekord.wartosc, /^v=DKIM1; k=rsa; p=[A-Za-z0-9+/]+=*$/);
    // klucz publiczny w rekordzie odpowiada kluczowi prywatnemu
    const p = rekord.wartosc.match(/p=(.+)$/)[1];
    const zRekordu = crypto.createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' });
    const podpis = crypto.sign('sha256', Buffer.from('test'), privateKey);
    assert.ok(crypto.verify('sha256', Buffer.from('test'), zRekordu, podpis));
  } finally {
    configureDkim(null);
  }
});
