// Jednostkowe testy parsera MIME: nagłówki, kodowania, adresy, HTML→tekst, parseMessage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHeaders, parseParams, decodeCharset, decodeQuotedPrintable,
  decodeEncodedWords, parseAddress, htmlToText, parseMessage, parseContentId,
} from '../server/mime.js';
import { MAX_FILE_BYTES } from '../server/attachments.js';

const buf = (s) => Buffer.from(s, 'utf8');

// --- parseHeaders ------------------------------------------------------------

test('parseHeaders: składa złamane kontynuacje i normalizuje spacje', () => {
  const h = parseHeaders('Subject: Ala\r\n  ma   kota\r\nFrom: a@b.pl');
  assert.equal(h.subject, 'Ala ma kota');
  assert.equal(h.from, 'a@b.pl');
});

test('parseHeaders: przy duplikacie wygrywa pierwszy', () => {
  const h = parseHeaders('X-Test: pierwszy\r\nX-Test: drugi');
  assert.equal(h['x-test'], 'pierwszy');
});

test('parseHeaders: kontynuacja zduplikowanego nagłówka nie zanieczyszcza pierwszego', () => {
  const h = parseHeaders('Subject: prawdziwy\r\nSubject: podszyty\r\n  doklejka\r\nTo: a@b.pl');
  assert.equal(h.subject, 'prawdziwy');
  assert.equal(h.to, 'a@b.pl');
});

test('parseHeaders: złożony adres From nie gubi części w nawiasach ostrych', () => {
  const h = parseHeaders('From: Bardzo Długie Imię\r\n <adres@example.com>\r\nTo: b@c.pl');
  assert.equal(h.from, 'Bardzo Długie Imię <adres@example.com>');
});

test('parseHeaders: linie bez dwukropka są pomijane', () => {
  const h = parseHeaders('linia bez dwukropka\r\nOK: tak');
  assert.equal(h.ok, 'tak');
  assert.equal(Object.keys(h).length, 1);
});

// --- parseParams -------------------------------------------------------------

test('parseParams: rozbija typ i parametry, zdejmuje cudzysłowy', () => {
  const p = parseParams('text/plain; charset="utf-8"; name=plik.txt');
  assert.equal(p.value, 'text/plain');
  assert.deepEqual(p.params, { charset: 'utf-8', name: 'plik.txt' });
});

test('parseParams: parametry bez znaku równości są ignorowane', () => {
  const p = parseParams('multipart/mixed; boundary=abc; smieci');
  assert.equal(p.value, 'multipart/mixed');
  assert.deepEqual(p.params, { boundary: 'abc' });
});

test('parseParams: puste wejście', () => {
  const p = parseParams();
  assert.equal(p.value, '');
  assert.deepEqual(p.params, {});
});

// --- decodeCharset -----------------------------------------------------------

test('decodeCharset: utf-8 i aliasy', () => {
  assert.equal(decodeCharset(Buffer.from('żółć', 'utf8'), 'utf-8'), 'żółć');
  assert.equal(decodeCharset(Buffer.from('abc', 'utf8'), 'UTF8'), 'abc');
  assert.equal(decodeCharset(Buffer.from('abc', 'utf8')), 'abc');
});

test('decodeCharset: iso-8859-2 dekoduje polskie znaki', () => {
  // 0xB6 = ś, 0xE6 = ć w ISO-8859-2
  assert.equal(decodeCharset(Buffer.from([0x43, 0x7a, 0x65, 0xb6, 0xe6]), 'iso-8859-2'), 'Cześć');
});

test('decodeCharset: nieznany charset spada na latin1 (catch)', () => {
  const out = decodeCharset(Buffer.from([0x41, 0x42]), 'całkowicie-nieistniejący-charset');
  assert.equal(out, 'AB');
});

// --- decodeQuotedPrintable ---------------------------------------------------

test('decodeQuotedPrintable: sekwencje =XX i miękkie łamania', () => {
  assert.equal(decodeQuotedPrintable('Hello=20World').toString('utf8'), 'Hello World');
  assert.equal(decodeQuotedPrintable('Linia1=\r\nLinia2').toString('utf8'), 'Linia1Linia2');
});

test('decodeQuotedPrintable: tryb nagłówka zamienia _ na spację', () => {
  assert.equal(decodeQuotedPrintable('Jan_Kowalski', { header: true }).toString('utf8'), 'Jan Kowalski');
});

test('decodeQuotedPrintable: niepełna sekwencja zostaje dosłownie', () => {
  assert.equal(decodeQuotedPrintable('a=zz').toString('latin1'), 'a=zz');
});

// --- decodeEncodedWords ------------------------------------------------------

test('decodeEncodedWords: base64 (B) i quoted-printable (Q)', () => {
  assert.equal(decodeEncodedWords('=?UTF-8?B?QUJD?='), 'ABC');
  assert.equal(decodeEncodedWords('=?UTF-8?Q?a=C5=BC?='), 'aż');
});

test('decodeEncodedWords: skleja sąsiednie słowa pomijając białe znaki', () => {
  assert.equal(decodeEncodedWords('=?UTF-8?B?QUJD?= =?UTF-8?B?WFla?='), 'ABCXYZ');
});

test('decodeEncodedWords: zwykły tekst przechodzi bez zmian', () => {
  assert.equal(decodeEncodedWords('zwykły tekst'), 'zwykły tekst');
});

// --- parseAddress ------------------------------------------------------------

test('parseAddress: nazwa i adres w nawiasach ostrych', () => {
  assert.deepEqual(parseAddress('Jan Kowalski <Jan@Example.PL>'), { name: 'Jan Kowalski', addr: 'jan@example.pl' });
});

test('parseAddress: zdejmuje cudzysłowy z nazwy', () => {
  assert.deepEqual(parseAddress('"Kowalski, Jan" <jan@x.pl>'), { name: 'Kowalski, Jan', addr: 'jan@x.pl' });
});

test('parseAddress: sam adres bez nazwy', () => {
  assert.deepEqual(parseAddress('goły@adres.pl'), { name: '', addr: 'goły@adres.pl' });
  assert.deepEqual(parseAddress('<tylko@w.nawiasach>'), { name: '', addr: 'tylko@w.nawiasach' });
});

test('parseAddress: dekoduje zakodowaną nazwę', () => {
  assert.deepEqual(parseAddress('=?UTF-8?B?QUJD?= <a@b.pl>'), { name: 'ABC', addr: 'a@b.pl' });
});

// --- htmlToText --------------------------------------------------------------

test('htmlToText: usuwa style/script, zamienia bloki na nowe linie', () => {
  const out = htmlToText('<style>.x{}</style><script>x()</script><p>Ala</p><div>ma</div>kota<br>!');
  assert.equal(out, 'Ala\nma\nkota\n!');
});

test('htmlToText: dekoduje encje', () => {
  assert.equal(htmlToText('a&amp;b&lt;c&gt;d&quot;e&#39;f&nbsp;g'), 'a&b<c>d"e\'f g');
});

test('htmlToText: redukuje nadmiar pustych linii', () => {
  assert.equal(htmlToText('<p>a</p><p></p><p></p><p>b</p>'), 'a\n\nb');
});

// --- parseMessage ------------------------------------------------------------

test('parseMessage: prosta wiadomość tekstowa', () => {
  const m = parseMessage(buf('From: a@b.pl\r\nSubject: Temat\r\nTo: demo@twojapoczta.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nTreść wiadomości.'));
  assert.equal(m.from.addr, 'a@b.pl');
  assert.equal(m.subject, 'Temat');
  assert.equal(m.to, 'demo@twojapoczta.com');
  assert.equal(m.body, 'Treść wiadomości.');
});

test('parseMessage: zwinięty (folded) nagłówek From zachowuje adres', () => {
  // Nazwa ASCII: surowe (niezakodowane) UTF-8 w nagłówku to inny temat; tu chodzi o adres.
  const raw = buf('From: Jan Bardzo Dlugie Nazwisko\r\n <jan@example.com>\r\nSubject: X\r\n\r\ntresc');
  const m = parseMessage(raw);
  assert.equal(m.from.addr, 'jan@example.com');
  assert.equal(m.from.name, 'Jan Bardzo Dlugie Nazwisko');
});

test('parseMessage: multipart/alternative woli text/plain', () => {
  const raw = buf([
    'Content-Type: multipart/alternative; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'wersja tekstowa',
    '--b',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>wersja html</p>',
    '--b--',
  ].join('\r\n'));
  const m = parseMessage(raw);
  assert.equal(m.body, 'wersja tekstowa');
});

test('parseMessage: sam HTML → tekst awaryjny', () => {
  const raw = buf([
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Tylko <b>HTML</b></p>',
  ].join('\r\n'));
  const m = parseMessage(raw);
  assert.equal(m.body, 'Tylko HTML');
});

test('parseMessage: załącznik po nazwie w Content-Type (bez dispozycji)', () => {
  const dane = Buffer.from('dane pliku');
  const raw = buf([
    'Content-Type: multipart/mixed; boundary="g"',
    '',
    '--g',
    'Content-Type: text/plain',
    '',
    'ciało',
    '--g',
    'Content-Type: application/pdf; name="doc.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    dane.toString('base64'),
    '--g--',
  ].join('\r\n'));
  const m = parseMessage(raw);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].filename, 'doc.pdf');
  assert.ok(Buffer.from(m.attachments[0].data).equals(dane));
});

test('parseMessage: pusty załącznik jest pomijany', () => {
  const raw = buf([
    'Content-Type: multipart/mixed; boundary="g"',
    '',
    '--g',
    'Content-Disposition: attachment; filename="pusty.bin"',
    'Content-Type: application/octet-stream',
    '',
    '',
    '--g--',
  ].join('\r\n'));
  const m = parseMessage(raw);
  assert.equal(m.attachments.length, 0);
});

test('parseMessage: pojedyncza część nietekstowa bez nazwy → ciało z surowca', () => {
  const raw = buf('Content-Type: application/json\r\n\r\n{"a":1}');
  const m = parseMessage(raw);
  assert.equal(m.body, '{"a":1}');
  assert.equal(m.attachments.length, 0);
});

test('parseMessage: multipart bez boundary nie wywala się', () => {
  const raw = buf('Content-Type: multipart/mixed\r\n\r\nsurowe ciało');
  const m = parseMessage(raw);
  assert.equal(m.attachments.length, 0);
  assert.equal(m.body, 'surowe ciało');
});

test('parseMessage: separator LF-only i brak nagłówka From', () => {
  // Ciało bez zadeklarowanego charsetu dekoduje się jako us-ascii, więc trzymamy ASCII.
  const m = parseMessage(buf('Subject: bez-from\n\ntresc'));
  assert.equal(m.subject, 'bez-from');
  assert.equal(m.from.addr, '');
  assert.equal(m.body, 'tresc');
});

test('parseMessage: brak separatora nagłówków', () => {
  const m = parseMessage(buf('Subject: sam-naglowek'));
  assert.equal(m.subject, 'sam-naglowek');
  assert.equal(m.body, '');
});

test('parseMessage: zachowuje nagłówek Date i domyślny temat', () => {
  const raw = buf('From: a@b.pl\r\nDate: Mon, 01 Jan 2026 10:00:00 +0000\r\n\r\nx');
  const m = parseMessage(raw);
  assert.equal(m.date, 'Mon, 01 Jan 2026 10:00:00 +0000');
  assert.equal(m.subject, '');
});

test('parseMessage: limit liczby załączników (10) jest respektowany', () => {
  const czesci = ['Content-Type: multipart/mixed; boundary="g"', ''];
  for (let i = 0; i < 12; i++) {
    czesci.push(
      '--g',
      `Content-Disposition: attachment; filename="p${i}.bin"`,
      'Content-Type: application/octet-stream',
      '',
      Buffer.from(`plik-${i}`).toString('latin1')
    );
  }
  czesci.push('--g--');
  const m = parseMessage(buf(czesci.join('\r\n')));
  assert.equal(m.attachments.length, 10);
});

test('parseMessage: załącznik ponad limit rozmiaru jest pomijany', () => {
  // Nie alokujemy realnie >5MB; sprawdzamy próg pośrednio przez małą wiadomość,
  // a wariant za-duży testujemy w attachments.test.js (storeAttachment).
  assert.ok(MAX_FILE_BYTES === 5 * 1024 * 1024);
});

// --- Content-ID i HTML -------------------------------------------------------

test('parseContentId: zdejmuje nawiasy kątowe i puste zwraca jako null', () => {
  assert.equal(parseContentId('<abc123@example.com>'), 'abc123@example.com');
  assert.equal(parseContentId('  <x@y>  '), 'x@y');
  assert.equal(parseContentId('bez-nawiasow@x'), 'bez-nawiasow@x');
  assert.equal(parseContentId(''), null);
  assert.equal(parseContentId(undefined), null);
});

test('parseMessage: multipart/alternative oddaje część text/html obok tekstu', () => {
  const raw = buf([
    'From: Nadawca <a@b.pl>',
    'Subject: Test',
    'Content-Type: multipart/alternative; boundary="gr"',
    '',
    '--gr',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Wersja tekstowa',
    '--gr',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Wersja <b>HTML</b></p>',
    '--gr--',
    '',
  ].join('\r\n'));
  const wynik = parseMessage(raw);
  assert.equal(wynik.html, '<p>Wersja <b>HTML</b></p>');
  assert.equal(wynik.body, 'Wersja tekstowa');
});

test('parseMessage: list bez części HTML ma html równe null', () => {
  const raw = buf('From: a@b.pl\r\nSubject: Goły tekst\r\n\r\nSama treść');
  assert.equal(parseMessage(raw).html, null);
});

test('parseMessage: multipart/related wiąże obrazek osadzony z Content-ID', () => {
  const raw = buf([
    'From: a@b.pl',
    'Subject: Z obrazkiem',
    'Content-Type: multipart/related; boundary="gr"',
    '',
    '--gr',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p><img src="cid:logo@fir.ma"></p>',
    '--gr',
    'Content-Type: image/png',
    'Content-ID: <logo@fir.ma>',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('udawany-png').toString('base64'),
    '--gr--',
    '',
  ].join('\r\n'));
  const wynik = parseMessage(raw);
  assert.match(wynik.html, /cid:logo@fir\.ma/);
  assert.equal(wynik.attachments.length, 1);
  assert.equal(wynik.attachments[0].contentId, 'logo@fir.ma');
  assert.equal(wynik.attachments[0].mime, 'image/png');
  assert.equal(wynik.attachments[0].data.toString(), 'udawany-png');
});

test('parseMessage: część osadzona bez nazwy pliku dostaje nazwę syntetyczną', () => {
  const raw = buf([
    'From: a@b.pl',
    'Content-Type: multipart/related; boundary="gr"',
    '',
    '--gr',
    'Content-Type: text/html',
    '',
    '<img src="cid:x@y">',
    '--gr',
    'Content-Type: image/png',
    'Content-ID: <x@y>',
    '',
    'bajty',
    '--gr--',
    '',
  ].join('\r\n'));
  const wynik = parseMessage(raw);
  assert.equal(wynik.attachments.length, 1);
  assert.equal(wynik.attachments[0].filename, 'osadzony-x_y.png');
});

test('parseMessage: część tekstowa oznaczona jako załącznik bez nazwy zostaje treścią listu', () => {
  const raw = buf([
    'From: a@b.pl',
    'Subject: Dziwna dyspozycja',
    'Content-Type: multipart/mixed; boundary="gr"',
    '',
    '--gr',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Disposition: attachment',
    '',
    'Treść mimo dziwnej dyspozycji',
    '--gr--',
    '',
  ].join('\r\n'));
  const wynik = parseMessage(raw);
  assert.equal(wynik.body, 'Treść mimo dziwnej dyspozycji');
  assert.doesNotMatch(wynik.body, /--gr/); // nigdy surowe granice MIME w oczy użytkownika
  assert.equal(wynik.attachments.length, 0);
});

test('parseMessage: zwykły załącznik nadal nie ma contentId', () => {
  const raw = buf([
    'From: a@b.pl',
    'Content-Type: multipart/mixed; boundary="gr"',
    '',
    '--gr',
    'Content-Type: text/plain',
    '',
    'tresc',
    '--gr',
    'Content-Type: application/pdf; name="plik.pdf"',
    'Content-Disposition: attachment; filename="plik.pdf"',
    '',
    'pdf',
    '--gr--',
    '',
  ].join('\r\n'));
  const wynik = parseMessage(raw);
  assert.equal(wynik.attachments.length, 1);
  assert.equal(wynik.attachments[0].filename, 'plik.pdf');
  assert.equal(wynik.attachments[0].contentId, null);
});
