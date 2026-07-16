// Jednostkowe testy poczty wychodzącej: kodowania, budowa wiadomości, doręczanie.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  encodeQuotedPrintable, encodeHeaderWord, buildRawMessage, deliverExternal, deliverToServer,
} from '../server/smtp-out.js';
import { decodeQuotedPrintable, parseMessage } from '../server/mime.js';

// Fałszywy, przyjmujący wszystko serwer SMTP (bez STARTTLS) do testów doręczania.
function startFake() {
  const odebrane = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let daneWiadomosci = '';
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            odebrane.push(daneWiadomosci);
            daneWiadomosci = '';
            sock.write('250 2.0.0 delivered\r\n');
          } else {
            daneWiadomosci += line + '\r\n';
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 fake.local\r\n');
        else if (cmd === 'MAIL') sock.write('250 2.1.0 ok\r\n');
        else if (cmd === 'RCPT') sock.write('250 2.1.5 ok\r\n');
        else if (cmd === 'DATA') { sock.write('354 go ahead\r\n'); inData = true; }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => sock.destroy());
  });
  return { server, odebrane };
}

let fake;
let fakePort;

before(async () => {
  fake = startFake();
  await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
  fakePort = fake.server.address().port;
});

after(() => new Promise((r) => fake.server.close(r)));

// --- encodeQuotedPrintable ---------------------------------------------------

test('encodeQuotedPrintable: znaki zwykłe przechodzą, „=” jest kodowane', () => {
  assert.equal(encodeQuotedPrintable('Ala ma kota'), 'Ala ma kota');
  assert.equal(encodeQuotedPrintable('a=b'), 'a=3Db');
});

test('encodeQuotedPrintable: round-trip z polskimi znakami i nowymi liniami', () => {
  const tekst = 'Zażółć gęślą jaźń.\nDruga linia.';
  const zakodowane = encodeQuotedPrintable(tekst);
  const odkodowane = decodeQuotedPrintable(zakodowane).toString('utf8');
  assert.equal(odkodowane, tekst.replace(/\n/g, '\r\n'));
});

test('encodeQuotedPrintable: łamie długie linie miękkim „=”', () => {
  const dlugie = 'ż'.repeat(40); // każdy znak → =C5=BC, szybko przekracza 73
  const out = encodeQuotedPrintable(dlugie);
  assert.match(out, /=\r\n/);
  for (const linia of out.split('\r\n')) assert.ok(linia.length <= 76, `linia ${linia.length}`);
});

// --- encodeHeaderWord --------------------------------------------------------

test('encodeHeaderWord: ASCII bez zmian, reszta w base64', () => {
  assert.equal(encodeHeaderWord('Zwykly temat'), 'Zwykly temat');
  assert.equal(encodeHeaderWord('Zażółć'), `=?UTF-8?B?${Buffer.from('Zażółć', 'utf8').toString('base64')}?=`);
});

// --- buildRawMessage ---------------------------------------------------------

test('buildRawMessage: bez załączników → text/plain + quoted-printable', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'Jan', addr: 'jan@twojapoczta.com' },
    to: ['a@b.pl', 'c@d.pl'],
    subject: 'Temat',
    body: 'treść z ogonkami: żółć',
  });
  assert.match(raw, /^From: Jan <jan@twojapoczta\.com>$/m);
  assert.match(raw, /^To: a@b\.pl, c@d\.pl$/m);
  assert.match(raw, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(raw, /Content-Transfer-Encoding: quoted-printable/);
  const m = parseMessage(Buffer.from(raw, 'utf8'));
  assert.match(m.body, /żółć/);
});

test('buildRawMessage: z HTML → multipart/alternative z tekstem i HTML-em', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'Jan', addr: 'jan@twojapoczta.com' },
    to: ['a@b.pl'],
    cc: ['c@d.pl', 'e@f.pl'],
    subject: 'Bogata',
    body: 'wersja tekstowa',
    html: '<p>wersja <strong>bogata</strong></p>',
  });
  assert.match(raw, /^Cc: c@d\.pl, e@f\.pl$/m);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="/);
  assert.match(raw, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(raw, /Content-Type: text\/html; charset=utf-8/);
  const m = parseMessage(Buffer.from(raw, 'utf8'));
  assert.match(m.body, /wersja tekstowa/);
});

test('buildRawMessage: HTML + załącznik → mixed z alternative w środku', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'Jan', addr: 'jan@twojapoczta.com' },
    to: ['a@b.pl'],
    subject: 'Pełny zestaw',
    body: 'tekst',
    html: '<p>html</p>',
    attachments: [{ filename: 'notatka.txt', mime: 'text/plain', data: Buffer.from('plik') }],
  });
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(raw, /Content-Type: multipart\/alternative; boundary="/);
  assert.match(raw, /Content-Disposition: attachment/);
  const m = parseMessage(Buffer.from(raw, 'latin1'));
  assert.equal(m.attachments.length, 1);
  assert.match(m.body, /tekst/);
});

test('buildRawMessage: pusta nazwa nadawcy i pusty temat', () => {
  const raw = buildRawMessage({ domain: 'd.pl', from: { name: '', addr: 'x@y.pl' }, to: ['z@w.pl'], subject: '', body: '' });
  assert.match(raw, /^From: <x@y\.pl>$/m);
  assert.match(raw, /^Subject: \(bez tematu\)$/m);
});

test('buildRawMessage: z załącznikiem → multipart/mixed, base64, filename*', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'Jan', addr: 'jan@twojapoczta.com' },
    to: ['a@b.pl'],
    subject: 'Z plikiem',
    body: 'ciało',
    attachments: [{ filename: 'żółw.txt', mime: 'text/plain', data: Buffer.from('dane załącznika') }],
  });
  assert.match(raw, /Content-Type: multipart\/mixed; boundary="/);
  assert.match(raw, /Content-Transfer-Encoding: base64/);
  assert.match(raw, /filename\*=UTF-8''/);
  // ASCII-owy fallback nazwy nie ma znaków spoza zakresu
  assert.match(raw, /filename="[\x20-\x7e]+"/);

  const m = parseMessage(Buffer.from(raw, 'latin1'));
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'żółw.txt');
});

// --- deliverExternal ---------------------------------------------------------

test('deliverExternal: doręcza przez smarthost (brak porażek)', async () => {
  process.env.TP_SMTP_ROUTE = `127.0.0.1:${fakePort}`;
  try {
    const raw = buildRawMessage({ domain: 'twojapoczta.com', from: { name: 'Jan', addr: 'jan@twojapoczta.com' }, to: ['ktos@example.com'], subject: 'Hej', body: 'cześć' });
    const { porazki } = await deliverExternal({ domain: 'twojapoczta.com', ehloName: 'mx.twojapoczta.com', mailFrom: 'jan@twojapoczta.com', recipients: ['ktos@example.com'], raw });
    assert.deepEqual(porazki, []);
    assert.ok(fake.odebrane.some((m) => /Subject: Hej/.test(m)));
  } finally {
    delete process.env.TP_SMTP_ROUTE;
  }
});

test('deliverExternal: martwy smarthost → porażki dla adresatów', async () => {
  process.env.TP_SMTP_ROUTE = '127.0.0.1:1';
  try {
    const raw = buildRawMessage({ domain: 'd.pl', from: { name: '', addr: 'x@d.pl' }, to: ['a@b.pl'], subject: 's', body: 'b' });
    const { porazki } = await deliverExternal({ domain: 'd.pl', ehloName: 'mx.d.pl', mailFrom: 'x@d.pl', recipients: ['a@b.pl'], raw });
    assert.equal(porazki.length, 1);
    assert.equal(porazki[0].adres, 'a@b.pl');
    assert.ok(porazki[0].powod);
  } finally {
    delete process.env.TP_SMTP_ROUTE;
  }
});

test('deliverExternal: brak MX i brak rekordu A (.invalid) → porażka, bez sieci zewnętrznej', async () => {
  const raw = buildRawMessage({ domain: 'd.pl', from: { name: '', addr: 'x@d.pl' }, to: ['a@nieistnieje-tp.invalid'], subject: 's', body: 'b' });
  const { porazki } = await deliverExternal({ domain: 'd.pl', ehloName: 'mx.d.pl', mailFrom: 'x@d.pl', recipients: ['a@nieistnieje-tp.invalid'], raw });
  assert.equal(porazki.length, 1);
  assert.equal(porazki[0].adres, 'a@nieistnieje-tp.invalid');
});

test('deliverToServer: pełny dialog do przyjmującego serwera (useTls=false)', async () => {
  const raw = buildRawMessage({ domain: 'd.pl', from: { name: 'A', addr: 'a@d.pl' }, to: ['b@c.pl'], subject: 'Bezpośrednio', body: 'x' });
  const ok = await deliverToServer({
    host: '127.0.0.1', port: fakePort, ehloName: 'test.local',
    mailFrom: 'a@d.pl', rcptTo: ['b@c.pl'], raw, useTls: false,
  });
  assert.equal(ok, true);
});
