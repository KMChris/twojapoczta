// Wychodzący SMTP: budowanie wiadomości RFC 822/MIME i doręczanie do MX odbiorcy.
// STARTTLS oportunistycznie (jak typowy MTA), bez zewnętrznych zależności.

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { resolveMx } from 'node:dns/promises';

const COMMAND_TIMEOUT_MS = 15_000;

// --- Kodowanie treści ---------------------------------------------------------

export function encodeQuotedPrintable(text) {
  const bajty = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8');
  let wynik = '';
  let liniaLen = 0;
  for (let i = 0; i < bajty.length; i++) {
    const b = bajty[i];
    let kawalek;
    if (b === 0x0d && bajty[i + 1] === 0x0a) {
      wynik += '\r\n';
      liniaLen = 0;
      i += 1;
      continue;
    }
    const zwykly = (b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9;
    kawalek = zwykly ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
    if (liniaLen + kawalek.length > 73) {
      wynik += '=\r\n';
      liniaLen = 0;
    }
    wynik += kawalek;
    liniaLen += kawalek.length;
  }
  return wynik;
}

export function encodeHeaderWord(text) {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function base64Lines(buffer) {
  const b64 = buffer.toString('base64');
  const linie = [];
  for (let i = 0; i < b64.length; i += 76) linie.push(b64.slice(i, i + 76));
  return linie.join('\r\n');
}

function rfc822Date(data = new Date()) {
  const dni = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const miesiace = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${dni[data.getUTCDay()]}, ${p(data.getUTCDate())} ${miesiace[data.getUTCMonth()]} ` +
    `${data.getUTCFullYear()} ${p(data.getUTCHours())}:${p(data.getUTCMinutes())}:${p(data.getUTCSeconds())} +0000`
  );
}

// --- Budowanie surowej wiadomości -----------------------------------------------

function czescTekstowa(body) {
  return [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    encodeQuotedPrintable(body ?? ''),
  ];
}

function czescHtml(html) {
  return [
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    encodeQuotedPrintable(html),
  ];
}

// Tekst + HTML jako multipart/alternative (klient odbiorcy wybiera bogatszą wersję).
function czescAlternatywna(body, html) {
  const boundary = `----=_tp_alt_${crypto.randomBytes(12).toString('hex')}`;
  const linie = [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...czescTekstowa(body),
    `--${boundary}`,
    ...czescHtml(html),
    `--${boundary}--`,
  ];
  return linie;
}

export function buildRawMessage({ domain, from, to, cc = [], subject, body, html, attachments = [] }) {
  const naglowki = [
    `Date: ${rfc822Date()}`,
    `From: ${from.name ? `${encodeHeaderWord(from.name)} ` : ''}<${from.addr}>`,
    `To: ${to.join(', ')}`,
  ];
  if (cc.length) naglowki.push(`Cc: ${cc.join(', ')}`);
  naglowki.push(
    `Subject: ${encodeHeaderWord(subject || '(bez tematu)')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0'
  );

  // Sama treść: zwykły tekst albo alternative, gdy jest wersja HTML.
  const trescLinie = html ? czescAlternatywna(body, html) : czescTekstowa(body);

  if (!attachments.length) {
    // trescLinie[0] to Content-Type, więc nagłówki treści lądują wśród nagłówków wiadomości.
    const [typ, ...reszta] = trescLinie;
    naglowki.push(typ);
    if (html) {
      return naglowki.join('\r\n') + '\r\n' + reszta.join('\r\n');
    }
    naglowki.push(reszta[0]); // Content-Transfer-Encoding
    return naglowki.join('\r\n') + '\r\n\r\n' + reszta.slice(2).join('\r\n');
  }

  const boundary = `----=_tp_${crypto.randomBytes(12).toString('hex')}`;
  naglowki.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const czesci = [`--${boundary}`, ...trescLinie];
  for (const zalacznik of attachments) {
    const asciiNazwa = zalacznik.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    czesci.push(
      `--${boundary}`,
      `Content-Type: ${zalacznik.mime}; name="${asciiNazwa}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${asciiNazwa}"; filename*=UTF-8''${encodeURIComponent(zalacznik.filename)}`,
      '',
      base64Lines(Buffer.isBuffer(zalacznik.data) ? zalacznik.data : Buffer.from(zalacznik.data))
    );
  }
  czesci.push(`--${boundary}--`);
  return naglowki.join('\r\n') + '\r\n\r\n' + czesci.join('\r\n');
}

// --- Dialog SMTP ------------------------------------------------------------------

function createReader(socket) {
  let bufor = '';
  let oczekujacy = null;

  const dane = (chunk) => {
    bufor += chunk.toString('latin1');
    sprawdz();
  };

  function sprawdz() {
    if (!oczekujacy) return;
    const linie = bufor.split('\r\n');
    // odpowiedź pełna, gdy ostatnia niepusta linia ma format "NNN tekst"
    for (let i = 0; i < linie.length; i++) {
      const m = linie[i].match(/^(\d{3}) (.*)$/) ?? linie[i].match(/^(\d{3})$/);
      if (m) {
        const zebrane = linie.slice(0, i + 1);
        bufor = linie.slice(i + 1).join('\r\n');
        const { resolve, timer } = oczekujacy;
        oczekujacy = null;
        clearTimeout(timer);
        resolve({ code: Number(m[1]), text: zebrane.join(' ') });
        return;
      }
    }
  }

  function read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        oczekujacy = null;
        reject(new Error('Przekroczono czas oczekiwania na odpowiedź serwera.'));
      }, COMMAND_TIMEOUT_MS);
      oczekujacy = { resolve, timer };
      sprawdz();
    });
  }

  return { dane, read, przenies: () => bufor };
}

function dotStuff(raw) {
  return raw
    .split(/\r?\n/)
    .map((linia) => (linia.startsWith('.') ? '.' + linia : linia))
    .join('\r\n');
}

// TP_TLS_VERIFY=1 wymusza walidację certyfikatu MX (fail-closed: brak zaufania = odbicie).
// Domyślnie TLS oportunistyczny jak w typowych MTA (Postfix "may"): szyfruj, gdy się da,
// bo alternatywą przy nieufnym certyfikacie byłby zwykły tekst.
const VERIFY_TLS = process.env.TP_TLS_VERIFY === '1';

// Pełny dialog dostarczenia do konkretnego serwera.
export async function deliverToServer({ host, port = 25, ehloName, mailFrom, rcptTo, raw, useTls = true, verifyTls = VERIFY_TLS }) {
  let socket = net.connect({ host, port });
  socket.setTimeout(COMMAND_TIMEOUT_MS * 2, () => socket.destroy(new Error('Timeout połączenia SMTP.')));

  let reader = createReader(socket);
  socket.on('data', (c) => reader.dane(c));

  const czekajNaPolaczenie = new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  await czekajNaPolaczenie;

  async function komenda(tekst, oczekiwany) {
    if (tekst != null) socket.write(tekst + '\r\n');
    const odpowiedz = await reader.read();
    if (oczekiwany && odpowiedz.code !== oczekiwany) {
      throw new Error(odpowiedz.text || `Kod ${odpowiedz.code}`);
    }
    return odpowiedz;
  }

  try {
    await komenda(null, 220); // powitanie
    let ehlo = await komenda(`EHLO ${ehloName}`, 250);

    if (useTls && /STARTTLS/i.test(ehlo.text)) {
      await komenda('STARTTLS', 220);
      socket.removeAllListeners('data');
      socket = tls.connect({ socket, servername: host, rejectUnauthorized: verifyTls });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      reader = createReader(socket);
      socket.on('data', (c) => reader.dane(c));
      ehlo = await komenda(`EHLO ${ehloName}`, 250);
    }

    await komenda(`MAIL FROM:<${mailFrom}>`, 250);
    for (const adres of rcptTo) {
      await komenda(`RCPT TO:<${adres}>`, 250);
    }
    await komenda('DATA', 354);
    await komenda(dotStuff(raw) + '\r\n.', 250);
    await komenda('QUIT').catch(() => {});
    return true;
  } finally {
    socket.destroy();
  }
}

// Doręczenie do dowolnych zewnętrznych adresatów przez ich rekordy MX.
export async function deliverExternal({ domain, ehloName, mailFrom, recipients, raw }) {
  const wgDomen = new Map();
  for (const adres of recipients) {
    const domenaOdbiorcy = adres.split('@')[1];
    if (!wgDomen.has(domenaOdbiorcy)) wgDomen.set(domenaOdbiorcy, []);
    wgDomen.get(domenaOdbiorcy).push(adres);
  }

  // TP_SMTP_ROUTE=host[:port] kieruje całość przez smarthost (relay/testy).
  const route = process.env.TP_SMTP_ROUTE;

  const porazki = [];
  for (const [domenaOdbiorcy, adresy] of wgDomen) {
    let cele;
    if (route) {
      const [host, port] = route.split(':');
      cele = [{ host, port: Number(port ?? 25) }];
    } else {
      let hosty = [];
      try {
        const mx = await resolveMx(domenaOdbiorcy);
        hosty = mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
      } catch {
        hosty = []; // brak MX, spróbujemy rekordu A (RFC 5321 §5.1)
      }
      if (!hosty.length) hosty = [domenaOdbiorcy];
      cele = hosty.slice(0, 3).map((host) => ({ host, port: 25 }));
    }

    let doreczono = false;
    let ostatniPowod = 'Brak serwera pocztowego odbiorcy.';
    for (const cel of cele) {
      try {
        await deliverToServer({ host: cel.host, port: cel.port, ehloName: ehloName ?? domain, mailFrom, rcptTo: adresy, raw });
        doreczono = true;
        break;
      } catch (err) {
        ostatniPowod = err.message;
      }
    }
    if (!doreczono) {
      for (const adres of adresy) porazki.push({ adres, powod: ostatniPowod });
    }
  }
  return { porazki };
}
