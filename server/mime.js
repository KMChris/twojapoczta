// Parser wiadomości RFC 822/MIME dla poczty przychodzącej.
// Obsługuje: encoded-words (RFC 2047), quoted-printable, base64,
// multipart (rekurencyjnie), text/html jako zapas, załączniki z limitami.

import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE } from './attachments.js';

const MAX_DEPTH = 5;

// --- Nagłówki -----------------------------------------------------------------

export function parseHeaders(text) {
  const headers = {};
  const lines = text.split(/\r?\n/);
  let activeKey = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && activeKey) {
      headers[activeKey] += ' ' + line.trim(); // dociągnij złamaną kontynuację
      continue;
    }
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const name = line.slice(0, sep).trim().toLowerCase();
    if (name in headers) {
      activeKey = null; // pierwszy wygrywa, kolejne wystąpienie i jego kontynuacje pomijamy
      continue;
    }
    headers[name] = line.slice(sep + 1).trim();
    activeKey = name;
  }
  // znormalizuj białe znaki w sklejonych wartościach
  for (const key of Object.keys(headers)) {
    headers[key] = headers[key].replace(/\s+/g, ' ').trim();
  }
  return headers;
}

// Nagłówki z parametrami: `text/plain; charset="utf-8"; name=plik.txt`
export function parseParams(value = '') {
  const [glowna, ...czesci] = value.split(';');
  const params = {};
  for (const czesc of czesci) {
    const sep = czesc.indexOf('=');
    if (sep === -1) continue;
    const klucz = czesc.slice(0, sep).trim().toLowerCase();
    let wartosc = czesc.slice(sep + 1).trim();
    if (wartosc.startsWith('"') && wartosc.endsWith('"')) wartosc = wartosc.slice(1, -1);
    params[klucz] = wartosc;
  }
  return { value: glowna.trim().toLowerCase(), params };
}

// Content-ID: `<logo@fir.ma>` → `logo@fir.ma`. Do tej wartości odwołuje się
// potem `<img src="cid:logo@fir.ma">` w treści listu.
export function parseContentId(value) {
  const surowy = String(value ?? '').trim();
  if (!surowy) return null;
  const bez = surowy.replace(/^<|>$/g, '').trim();
  return bez || null;
}

// Czym odwołanie `cid:` może się legalnie przedłużyć poza nasz klucz: atext RFC 5322 §3.2.3
// (ALPHA / DIGIT / ! # $ % & ' * + - / = ? ^ _ ` { | } ~) plus `.` i `@`, które rozdzielają
// części identyfikatora. Bez apostrofu · jest naraz legalnym atextem i ogranicznikiem
// atrybutu, więc w pełnym zbiorze `src='cid:logo@fir.ma'` przestaje się dopasowywać:
// lookahead bierze zamykający apostrof za dalszy ciąg identyfikatora. Surowy regex po
// stringu nie rozstrzygnie, które z dwóch znaczeń apostrofu ma przed sobą, więc wybieramy
// stronę, która nie psuje pospolitego HTML-a.
const PRZEDLUZENIE_CONTENT_ID = /[\w!#$%&*+\-/=?^`{|}~.@]/;

// Czy ten HTML naprawdę cytuje ten `cid:`. Pytają o to obie strony: wysyłka (co schować
// do `related`) i odbiór (co przenieść do mapy `cid`) · w obu wypadkach załącznik z
// martwym Content-ID ma zostać zwykłym, widocznym załącznikiem.
export function htmlCytujeCid(html, contentId) {
  if (!html || !contentId) return false;
  const wzorzec = contentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Dopasowanie dokładne, bo lokalna część identyfikatora jest case-sensitive i klient
  // wiąże `cid:` dokładnie · przy niezgodzie lepiej zostawić widoczny załącznik niż
  // `inline` (albo wpis w mapie) z martwym `cid:`.
  // Lookahead pilnuje, żeby `cid:logo@fir.ma` nie złapało się na `cid:logo@fir.mail`
  // ani na `cid:logo@fir.ma~2` · klucz krótszy niż odwołanie to martwa kotwica.
  return new RegExp(`cid:${wzorzec}(?!${PRZEDLUZENIE_CONTENT_ID.source})`).test(html);
}

// Część osadzona bywa bez nazwy pliku, a nazwa jest wymagana przez zapis
// załącznika. Robimy ją z Content-ID, żeby dało się ją potem rozpoznać okiem.
// Tylko dla części osadzonych: text/* z Content-ID to nadal treść listu, a nie
// plik do pobrania, więc nazwy mu nie dorabiamy · inaczej zniknęłoby ciało listu.
function syntetycznaNazwa(contentId, mime) {
  if (!contentId || mime.startsWith('text/')) return null;
  const rozszerzenie = (mime.split('/')[1] ?? 'bin').replace(/\W/g, '').slice(0, 8) || 'bin';
  const rdzen = contentId.replace(/[^\w.-]/g, '_').slice(0, 60);
  return `osadzony-${rdzen}.${rozszerzenie}`;
}

// --- Kodowania ------------------------------------------------------------------

function normalizeCharset(charset = 'utf-8') {
  const c = charset.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (c === 'utf8' || c === '') return 'utf-8';
  return c;
}

export function decodeCharset(buffer, charset) {
  try {
    return new TextDecoder(normalizeCharset(charset), { fatal: false }).decode(buffer);
  } catch {
    return buffer.toString('latin1');
  }
}

export function decodeQuotedPrintable(text, { header = false } = {}) {
  let wejscie = text;
  if (header) wejscie = wejscie.replace(/_/g, ' ');
  wejscie = wejscie.replace(/=\r?\n/g, ''); // miękkie łamania
  const bajty = [];
  for (let i = 0; i < wejscie.length; i++) {
    if (wejscie[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(wejscie.slice(i + 1, i + 3))) {
      bajty.push(parseInt(wejscie.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bajty.push(wejscie.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bajty);
}

// RFC 2047: =?charset?B|Q?dane?=
export function decodeEncodedWords(text = '') {
  // białe znaki między sąsiednimi encoded-words się pomija
  const sklejone = text.replace(/\?=\s+=\?/g, '?==?');
  return sklejone.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, typ, dane) => {
    try {
      const buf =
        typ.toLowerCase() === 'b'
          ? Buffer.from(dane.replace(/\s+/g, ''), 'base64')
          : decodeQuotedPrintable(dane, { header: true });
      return decodeCharset(buf, charset);
    } catch {
      return _;
    }
  });
}

function decodeTransfer(buffer, encoding = '7bit') {
  const enc = encoding.trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(buffer.toString('latin1').replace(/\s+/g, ''), 'base64');
  if (enc === 'quoted-printable') return decodeQuotedPrintable(buffer.toString('latin1'));
  return buffer;
}

// --- Adresy ------------------------------------------------------------------------

export function parseAddress(value = '') {
  const odkodowane = decodeEncodedWords(value).trim();
  const match = odkodowane.match(/^(.*?)<([^<>]+)>\s*$/);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, '').trim();
    return { name, addr: match[2].trim().toLowerCase() };
  }
  return { name: '', addr: odkodowane.replace(/^<|>$/g, '').trim().toLowerCase() };
}

// --- HTML → tekst (awaryjnie, gdy brak części text/plain) -----------------------------

export function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Części MIME ------------------------------------------------------------------------

function splitHeadBody(buffer) {
  let sep = buffer.indexOf('\r\n\r\n');
  let dlugosc = 4;
  if (sep === -1) {
    sep = buffer.indexOf('\n\n');
    dlugosc = 2;
  }
  if (sep === -1) return { head: buffer.toString('latin1'), body: Buffer.alloc(0) };
  return { head: buffer.subarray(0, sep).toString('latin1'), body: buffer.subarray(sep + dlugosc) };
}

function splitMultipart(body, boundary) {
  const znacznik = `--${boundary}`;
  const czesci = [];
  const tekst = body.toString('latin1');
  let start = tekst.indexOf(znacznik);
  while (start !== -1) {
    const poZnaczniku = start + znacznik.length;
    if (tekst.startsWith('--', poZnaczniku)) break; // znacznik końcowy
    const koniecLinii = tekst.indexOf('\n', poZnaczniku);
    if (koniecLinii === -1) break;
    const nastepny = tekst.indexOf(znacznik, koniecLinii);
    const koniec = nastepny === -1 ? tekst.length : nastepny;
    // utnij końcowe \r\n należące do granicy
    czesci.push(body.subarray(koniecLinii + 1, koniec).subarray(0, Math.max(0, koniec - koniecLinii - 1)));
    if (nastepny === -1) break;
    start = nastepny;
  }
  return czesci.map((c) => {
    let koniec = c.length;
    while (koniec > 0 && (c[koniec - 1] === 0x0a || c[koniec - 1] === 0x0d)) koniec--;
    return c.subarray(0, koniec);
  });
}

function extractFilename(dispositionValue, contentTypeParams) {
  const { params } = parseParams(dispositionValue ?? '');
  if (params['filename*']) {
    // RFC 2231: UTF-8''nazwa%C5%BC.pdf
    const match = params['filename*'].match(/^([^']*)'[^']*'(.*)$/);
    if (match) return decodeURIComponentSafe(match[2], match[1]);
  }
  const surowa = params.filename ?? contentTypeParams?.name;
  return surowa ? decodeEncodedWords(surowa) : null;
}

function decodeURIComponentSafe(text, charset) {
  const bajty = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bajty.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bajty.push(text.charCodeAt(i) & 0xff);
    }
  }
  return decodeCharset(Buffer.from(bajty), charset || 'utf-8');
}

function walkPart(buffer, wynik, depth) {
  if (depth > MAX_DEPTH) return;
  const { head, body } = splitHeadBody(buffer);
  const headers = parseHeaders(head);
  const ct = parseParams(headers['content-type'] ?? 'text/plain; charset=us-ascii');
  const disposition = headers['content-disposition'] ?? '';
  const filename = extractFilename(disposition, ct.params);
  const attachmentDisposition = /^\s*attachment/i.test(disposition);

  if (ct.value.startsWith('multipart/')) {
    if (!ct.params.boundary) return;
    for (const czesc of splitMultipart(body, ct.params.boundary)) {
      walkPart(czesc, wynik, depth + 1);
    }
    return;
  }

  const dane = decodeTransfer(body, headers['content-transfer-encoding']);
  const contentId = parseContentId(headers['content-id']);

  // Osadzone obrazki (`cid:`) to też załącznik, nawet gdy nie mają nazwy pliku
  // ani `Content-Disposition`. Wcześniej wypadały na końcu funkcji.
  const jestZalacznikiem =
    attachmentDisposition ||
    (filename && !ct.value.startsWith('text/')) ||
    (contentId && !ct.value.startsWith('text/'));

  if (jestZalacznikiem) {
    const nazwa = filename ?? syntetycznaNazwa(contentId, ct.value);
    // Bez nazwy nie ma czego zapisać, więc spadamy do gałęzi tekstowych, tak jak
    // przed dołożeniem cid: część text/* oznaczona jako załącznik, ale bez nazwy,
    // ma dalej zostać treścią listu, a nie zniknąć.
    if (nazwa) {
      if (wynik.attachments.length >= MAX_FILES_PER_MESSAGE) return;
      if (dane.length === 0 || dane.length > MAX_FILE_BYTES) return;
      wynik.attachments.push({ filename: nazwa, mime: ct.value, data: dane, contentId });
      return;
    }
  }

  if (ct.value === 'text/plain' && wynik.body == null) {
    wynik.body = decodeCharset(dane, ct.params.charset);
    return;
  }
  if (ct.value === 'text/html' && wynik.html == null) {
    wynik.html = decodeCharset(dane, ct.params.charset);
    return;
  }
  // inne typy bez nazwy pliku pomijamy
}

// --- Główne wejście ------------------------------------------------------------------------

export function parseMessage(raw) {
  const { head, body } = splitHeadBody(raw);
  const headers = parseHeaders(head);
  const wynik = { attachments: [], body: null, html: null };

  const ct = parseParams(headers['content-type'] ?? 'text/plain');
  if (ct.value.startsWith('multipart/') || ct.value.startsWith('text/')) {
    walkPart(raw, wynik, 0);
  } else {
    // pojedyncza część nietekstowa, potraktuj jak załącznik
    walkPart(raw, wynik, 0);
  }

  const from = parseAddress(headers.from ?? '');
  const subject = decodeEncodedWords(headers.subject ?? '').trim();
  const to = decodeEncodedWords(headers.to ?? '').trim();

  let tekst = wynik.body;
  if (tekst == null && wynik.html != null) tekst = htmlToText(wynik.html);
  if (tekst == null) tekst = body.toString('utf8');

  return {
    from,
    to,
    subject,
    body: tekst.replace(/\r\n/g, '\n').trim(),
    html: wynik.html,
    attachments: wynik.attachments,
    date: headers.date ?? null,
  };
}
