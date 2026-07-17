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

test('buildRawMessage: Reply-To trafia do nagłówków (przesyłanie dalej)', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'Ania Nowakowska', addr: 'demo@twojapoczta.com' },
    replyTo: 'ania@obca.pl',
    to: ['ja-prywatnie@gdzieindziej.pl'],
    subject: 'Przesłane',
    body: 'tresc',
  });
  assert.match(raw, /^Reply-To: <ania@obca\.pl>$/m);
  assert.match(raw, /^From: .* <demo@twojapoczta\.com>$/m);
  // bez replyTo nagłówek nie ma prawa się pojawić
  const bez = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'Jan', addr: 'jan@twojapoczta.com' },
    to: ['a@b.pl'],
    subject: 'Zwykła',
    body: 'x',
  });
  assert.ok(!/Reply-To:/.test(bez));
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

test('buildRawMessage: obrazek osadzony → multipart/related, kotwica przeżywa round-trip', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: 'Jan', addr: 'jan@twojapoczta.com' },
    to: ['ktos@example.com'],
    subject: 'Z obrazkiem',
    body: 'wersja tekstowa',
    html: '<p>Logo: <img src="cid:logo@fir.ma"></p>',
    attachments: [{ filename: 'logo.png', mime: 'image/png', data: Buffer.from('png-bajty'), contentId: 'logo@fir.ma' }],
  });
  assert.match(raw, /Content-Type: multipart\/related;.*type="multipart\/alternative"/);
  const m = parseMessage(Buffer.from(raw, 'utf8'));
  assert.equal(m.html, '<p>Logo: <img src="cid:logo@fir.ma"></p>');
  assert.equal(m.body, 'wersja tekstowa');
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].contentId, 'logo@fir.ma');
  assert.equal(m.attachments[0].data.toString(), 'png-bajty');
});

test('buildRawMessage: osadzony obok zwykłego załącznika → related w mixed', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: '', addr: 'jan@twojapoczta.com' },
    to: ['ktos@example.com'],
    subject: 'Oba',
    body: 'tekst',
    html: '<p><img src="cid:logo@fir.ma"></p>',
    attachments: [
      { filename: 'logo.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'logo@fir.ma' },
      { filename: 'umowa.pdf', mime: 'application/pdf', data: Buffer.from('pdf') },
    ],
  });
  assert.match(raw, /Content-Type: multipart\/mixed;/);
  assert.match(raw, /Content-Type: multipart\/related;/);
  const m = parseMessage(Buffer.from(raw, 'utf8'));
  assert.equal(m.attachments.length, 2);
  assert.equal(m.attachments.find((z) => z.filename === 'logo.png').contentId, 'logo@fir.ma');
  assert.equal(m.attachments.find((z) => z.filename === 'umowa.pdf').contentId, null);
});

// Test charakteryzujący: przechodził już przed dołożeniem `related`, więc nie jest dowodem
// regresji dla tej zmiany. Pilnuje go, bo `inline` z niecytowanym `cid:` jest u odbiorcy
// niewidoczny, a dziś taki załącznik jest widoczny — to zachowanie ma przeżyć zmianę.
test('buildRawMessage: Content-ID, którego HTML nie cytuje, nadal zostaje zwykłym załącznikiem', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: '', addr: 'jan@twojapoczta.com' },
    to: ['ktos@example.com'],
    subject: 'Sierota',
    body: 'tekst',
    html: '<p>Bez obrazków</p>',
    attachments: [{ filename: 'sierota.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'sierota@fir.ma' }],
  });
  // inline z cid:, którego nikt nie cytuje, byłby u odbiorcy niewidoczny
  assert.doesNotMatch(raw, /multipart\/related/);
  const m = parseMessage(Buffer.from(raw, 'utf8'));
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'sierota.png');
});

// Odbiorca wiąże `cid:` dokładnie, a lokalna część identyfikatora jest case-sensitive.
// Przy niezgodzie wielkości liter chowanie do `related` dałoby naraz pusty obrazek
// i niewidoczny załącznik, więc do `related` idzie tylko to, co na pewno się zwiąże.
test('buildRawMessage: Content-ID różniący się wielkością liter od cid: zostaje zwykłym załącznikiem', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: '', addr: 'jan@twojapoczta.com' },
    to: ['ktos@example.com'],
    subject: 'Wielkość liter',
    body: 'tekst',
    html: '<p><img src="cid:logo@fir.ma"></p>',
    attachments: [{ filename: 'logo.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'LOGO@fir.ma' }],
  });
  assert.doesNotMatch(raw, /multipart\/related/);
  assert.match(raw, /Content-Disposition: attachment; filename="logo\.png"/);
  const m = parseMessage(Buffer.from(raw, 'utf8'));
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'logo.png');
});

test('buildRawMessage: osadzony obrazek o nazwie spoza ASCII zachowuje ją po round-tripie', () => {
  const raw = buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: '', addr: 'jan@twojapoczta.com' },
    to: ['ktos@example.com'],
    subject: 'Osadzony żółw',
    body: 'tekst',
    html: '<p><img src="cid:logo@fir.ma"></p>',
    attachments: [{ filename: 'żółw-logo.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'logo@fir.ma' }],
  });
  assert.match(raw, /multipart\/related/);
  // ASCII-owy fallback nazwy nie ma znaków spoza zakresu, nazwa pełna idzie w filename*
  assert.match(raw, /Content-Disposition: inline; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
  const m = parseMessage(Buffer.from(raw, 'utf8'));
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'żółw-logo.png');
});

// --- filename* (RFC 2231) na bajtach -----------------------------------------

// Te testy patrzą na surowy nagłówek, a nie przez `parseMessage`. Nasz parser wybacza
// złamaną ramkę (`mime.js`, regex z zachłannym `.*`) i odtwarza nazwę mimo niej, więc
// round-trip przez własny kod świecił na zielono także wtedy, gdy na drut szedł surowy
// apostrof. Dowodem jest wyłącznie to, co realnie wychodzi na drut.

function rawZNazwa(filename, typ) {
  return buildRawMessage({
    domain: 'twojapoczta.com',
    from: { name: '', addr: 'jan@twojapoczta.com' },
    to: ['ktos@example.com'],
    subject: 'Nazwa pliku',
    body: 'tekst',
    html: typ === 'inline' ? '<p><img src="cid:logo@fir.ma"></p>' : undefined,
    attachments: [{
      filename,
      mime: 'image/png',
      data: Buffer.from('png'),
      ...(typ === 'inline' ? { contentId: 'logo@fir.ma' } : {}),
    }],
  });
}

function extValue(raw, typ) {
  const linia = raw.split('\r\n').find((l) => l.startsWith(`Content-Disposition: ${typ};`));
  assert.ok(linia, `brak nagłówka Content-Disposition: ${typ}`);
  const m = /; filename\*=(.*)$/.exec(linia);
  assert.ok(m, `brak filename* w: ${linia}`);
  return m[1];
}

// Ręczne dekodowanie ramki `charset'język'wartość` — bez naszego parsera. Rozbicie na
// dokładnie trzy sekcje jest częścią asercji: surowy apostrof dałby ich więcej.
function odkodujExtValue(wartosc) {
  const czesci = wartosc.split("'");
  assert.equal(czesci.length, 3, `ramka RFC 2231 rozbita na ${czesci.length} sekcji: ${wartosc}`);
  assert.equal(czesci[0], 'UTF-8');
  // Wielkich liter w %XX żaden RFC nie wymaga: literały w ABNF są case-insensitive, a RFC 3986
  // §2.1 to SHOULD. Przypinamy je, bo trzymają bajty na drucie identyczne z poprzednim wydaniem
  // dla nazw spoza ASCII · to dlatego zmiana kodera nie ruszyła żadnego istniejącego testu.
  // Sprawdzane tu, a nie w pojedynczym teście, bo `decodeURIComponent` przyjmuje oba rozmiary
  // liter i sam round-trip przepuściłby małe — a nazwa spoza ASCII jest jedyną próbką z A-F.
  assert.match(czesci[2], /^(?:[A-Za-z0-9!#$&+\-.^_`|{}~]|%[0-9A-F]{2})+$/);
  return decodeURIComponent(czesci[2]);
}

for (const typ of ['attachment', 'inline']) {
  test(`buildRawMessage (${typ}): filename* nie przemyca surowego apostrofu do ramki`, () => {
    const wartosc = extValue(rawZNazwa("Kate's-logo.png", typ), typ);
    // Ramce wolno mieć dokładnie dwa apostrofy. Trzeci rozbija ją na dodatkową sekcję,
    // a klient czytający `filename*` (RFC 6266 §4.1) dostaje wtedy samo „Kate”.
    assert.equal((wartosc.match(/'/g) ?? []).length, 2, `nadmiarowy apostrof w: ${wartosc}`);
    assert.equal(odkodujExtValue(wartosc), "Kate's-logo.png");
  });

  test(`buildRawMessage (${typ}): nazwa z nawiasami i apostrofem koduje się w całości`, () => {
    // Spacja, nawiasy i apostrof zostawione surowe ucinają nazwę u ścisłego klienta —
    // kształt wartości pilnuje `odkodujExtValue`.
    const wartosc = extValue(rawZNazwa("raport (1) Kate's.png", typ), typ);
    assert.equal(odkodujExtValue(wartosc), "raport (1) Kate's.png");
  });

  test(`buildRawMessage (${typ}): nazwa spoza ASCII nadal przeżywa w filename*`, () => {
    assert.equal(odkodujExtValue(extValue(rawZNazwa('żółw-logo.png', typ), typ)), 'żółw-logo.png');
  });
}

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
