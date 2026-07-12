// Parser wiadomości RFC 822/MIME dla poczty przychodzącej.
// Obsługuje: encoded-words (RFC 2047), quoted-printable, base64,
// multipart (rekurencyjnie), text/html jako zapas, załączniki z limitami.

import { MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE } from './attachments.js';

const MAX_DEPTH = 5;

// --- Nagłówki -----------------------------------------------------------------

export function parseHeaders(text) {
  const headers = {};
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      current.value += ' ' + line.trim();
      continue;
    }
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    current = { name: line.slice(0, sep).trim().toLowerCase(), value: line.slice(sep + 1).trim() };
    if (!(current.name in headers)) headers[current.name] = current.value;
    else current = { name: current.name, value: headers[current.name] }; // pierwszy wygrywa
  }
  // dociągnij sklejone kontynuacje
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

  const jestZalacznikiem = attachmentDisposition || (filename && !ct.value.startsWith('text/'));
  if (jestZalacznikiem && filename) {
    if (wynik.attachments.length >= MAX_FILES_PER_MESSAGE) return;
    if (dane.length === 0 || dane.length > MAX_FILE_BYTES) return;
    wynik.attachments.push({ filename, mime: ct.value, data: dane });
    return;
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
    attachments: wynik.attachments,
    date: headers.date ?? null,
  };
}
