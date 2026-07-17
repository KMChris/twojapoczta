// Przychodzący SMTP (RFC 5321 w zakresie MX): EHLO, MAIL, RCPT, DATA.
// Przyjmuje pocztę wyłącznie dla lokalnych skrzynek (zero relayu),
// parsuje MIME i doręcza do folderu Odebrane.

import net from 'node:net';
import tls from 'node:tls';
import { DOMAIN, resolveDelivery, deliverInbound } from './mail.js';
import { parseMessage } from './mime.js';
import { hasRoom } from './quota.js';
import { catchallLogin } from './settings.js';

export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
const MAX_RECIPIENTS = 50;
const IDLE_TIMEOUT_MS = 60_000;
const CRLF = Buffer.from('\r\n');

export function startSmtpServer(
  db,
  {
    port,
    host = '0.0.0.0',
    hostname = `mx.${DOMAIN}`,
    log = console,
    secureContext = () => null,
    idleTimeoutMs = IDLE_TIMEOUT_MS,
  } = {}
) {
  const server = net.createServer((socket) => {
    let gniazdo = socket;      // po STARTTLS wskazuje na gniazdo szyfrowane
    let szyfrowane = false;
    let podnoszenie = false;   // wstrzymuje parser na czas handshake'u
    let bufor = Buffer.alloc(0);
    let wDanych = false;
    let linieDanych = [];
    let rozmiarDanych = 0;
    let przepelnione = false;
    const koperta = { mailFrom: null, rcpt: [], adresy: new Set() };

    const wyslij = (tekst) => {
      if (!gniazdo.destroyed) gniazdo.write(tekst + '\r\n');
    };

    function odbierz(chunk) {
      bufor = Buffer.concat([bufor, chunk]);
      if (bufor.length > MAX_MESSAGE_BYTES + 1024 * 1024) {
        wyslij('552 5.3.4 Message too big');
        gniazdo.end();
        return;
      }
      try {
        przetworzBufor();
      } catch (err) {
        log.error('[smtp]', err);
        wyslij('451 4.3.0 Processing error');
        gniazdo.end();
      }
    }

    // Wołane drugi raz po podniesieniu do TLS: TLSSocket to inny obiekt,
    // a nasłuchy zostają na gnieździe pod spodem.
    function podepnij(s) {
      s.setTimeout(idleTimeoutMs, () => {
        wyslij('421 4.4.2 Idle timeout');
        s.end();
      });
      s.on('data', odbierz);
    }

    socket.on('error', () => socket.destroy());
    podepnij(socket);
    wyslij(`220 ${hostname} ESMTP TwojaPoczta`);

    function przetworzBufor() {
      while (!podnoszenie) {
        const idx = bufor.indexOf(0x0a);
        if (idx === -1) return;
        let linia = bufor.subarray(0, idx);
        bufor = bufor.subarray(idx + 1);
        if (linia.length && linia[linia.length - 1] === 0x0d) {
          linia = linia.subarray(0, linia.length - 1);
        }
        if (wDanych) obsluzDane(linia);
        else obsluzKomende(linia.toString('utf8'));
      }
    }

    function resetujTransakcje() {
      koperta.mailFrom = null;
      koperta.rcpt = [];
      koperta.adresy = new Set();
      linieDanych = [];
      rozmiarDanych = 0;
      przepelnione = false;
    }

    function podnies(kontekst) {
      const surowe = gniazdo;               // za chwilę `gniazdo` wskaże na TLS-a
      surowe.removeAllListeners('data');    // dalsze bajty należą do TLS-a, nie do parsera komend
      // Stary limit czasu odpowiadał plaintextowym 421, a partner jest już w środku
      // negocjacji TLS · taka linia byłaby śmieciem w protokole. Zdejmujemy go i na czas
      // handshake'u pilnujemy gniazda surowego: bez tego klient, który wysłał STARTTLS
      // i zamilkł, trzymałby połączenie bez końca (slowloris na porcie 25).
      surowe.removeAllListeners('timeout');
      surowe.setTimeout(idleTimeoutMs, () => surowe.destroy());
      const bezpieczne = new tls.TLSSocket(surowe, { isServer: true, secureContext: kontekst });
      bezpieczne.on('error', () => bezpieczne.destroy()); // także zerwany handshake
      bezpieczne.once('secure', () => {
        // RFC 3207 §4.2: po TLS zapominamy wszystko sprzed niego, łącznie z EHLO.
        // Ruch po TLS odświeża też timer gniazda pod spodem (łańcuch _parent), więc
        // zostawiony tu zrywałby ciszę zamiast uprzejmego 421 · oddajemy go szyfrowanemu.
        surowe.setTimeout(0);
        gniazdo = bezpieczne;
        szyfrowane = true;
        bufor = Buffer.alloc(0);
        wDanych = false;
        resetujTransakcje();
        podnoszenie = false;
        podepnij(bezpieczne);
      });
    }

    function obsluzKomende(linia) {
      const komenda = linia.slice(0, 4).toUpperCase();

      if (komenda === 'EHLO') {
        wyslij(`250-${hostname}`);
        wyslij(`250-SIZE ${MAX_MESSAGE_BYTES}`);
        if (!szyfrowane && secureContext()) wyslij('250-STARTTLS');
        wyslij('250 8BITMIME');
        return;
      }
      if (komenda === 'HELO') return wyslij(`250 ${hostname}`);

      // Uwaga: dispatcher bierze cztery znaki, więc STARTTLS wpada tu jako 'STAR'.
      if (komenda === 'STAR') {
        if (!/^STARTTLS\s*$/i.test(linia)) return wyslij('501 5.5.4 Syntax: STARTTLS');
        if (szyfrowane) return wyslij('503 5.5.1 TLS already active');
        const kontekst = secureContext();
        if (!kontekst) return wyslij('454 4.7.0 TLS not available');
        // Cokolwiek przyszło razem z komendą, jest wstrzyknięciem poleceń
        // w czystym tekście: po 220 te bajty udawałyby komendy sprzed szyfru
        // (klasa CVE-2011-0411). Sprawdzamy PRZED odpowiedzią 220.
        podnoszenie = true;
        if (bufor.length) {
          wyslij('501 5.5.4 Syntax error (pipelining after STARTTLS)');
          gniazdo.end();
          return;
        }
        wyslij('220 2.0.0 Ready to start TLS');
        podnies(kontekst);
        return;
      }

      if (komenda === 'MAIL') {
        const match = linia.match(/^MAIL FROM:\s*<([^>]*)>(.*)$/i);
        if (!match) return wyslij('501 5.5.4 Syntax: MAIL FROM:<address>');
        const size = match[2].match(/SIZE=(\d+)/i);
        if (size && Number(size[1]) > MAX_MESSAGE_BYTES) return wyslij('552 5.3.4 Message too big');
        resetujTransakcje();
        koperta.mailFrom = match[1].trim().toLowerCase();
        return wyslij('250 2.1.0 OK');
      }

      if (komenda === 'RCPT') {
        if (koperta.mailFrom === null) return wyslij('503 5.5.1 MAIL first');
        const match = linia.match(/^RCPT TO:\s*<([^>]+)>/i);
        if (!match) return wyslij('501 5.5.4 Syntax: RCPT TO:<address>');
        const adres = match[1].trim().toLowerCase();
        const [local, domena] = adres.split('@');
        if (!domena || domena !== DOMAIN) return wyslij('554 5.7.1 Relay access denied');
        // Nieznany adres w domenie próbuje jeszcze skrzynki catch-all (o ile ustawiona).
        let cel = resolveDelivery(db, local);
        if (!cel) {
          const zbiorczy = catchallLogin(db);
          if (zbiorczy) cel = resolveDelivery(db, zbiorczy);
        }
        // Zespół bez członków odpowiada tak samo jak adres nieistniejący: obcemu
        // serwerowi nie mamy nic do powiedzenia o naszym składzie osobowym.
        if (!cel || !cel.mailboxes.length) return wyslij('550 5.1.1 No such mailbox');
        const zMiejscem = cel.mailboxes.filter((s) => hasRoom(db, s.id));
        if (!zMiejscem.length) return wyslij('552 5.2.2 Mailbox full');
        // Limit liczy adresy z koperty, nie skrzynki: chroni przed nadawcą
        // adresującym 50 rzeczy, a nie przed naszym własnym rozdzielnikiem.
        if (koperta.adresy.size >= MAX_RECIPIENTS && !koperta.adresy.has(adres)) {
          return wyslij('452 4.5.3 Too many recipients');
        }
        koperta.adresy.add(adres);
        for (const skrzynka of zMiejscem) {
          if (!koperta.rcpt.some((r) => r.id === skrzynka.id)) koperta.rcpt.push({ ...skrzynka, adres });
        }
        return wyslij('250 2.1.5 OK');
      }

      if (komenda === 'DATA') {
        if (!koperta.rcpt.length) return wyslij('503 5.5.1 RCPT first');
        wDanych = true;
        linieDanych = [];
        rozmiarDanych = 0;
        przepelnione = false;
        return wyslij('354 End data with <CR><LF>.<CR><LF>');
      }

      if (komenda === 'RSET') {
        resetujTransakcje();
        return wyslij('250 2.0.0 OK');
      }
      if (komenda === 'NOOP') return wyslij('250 2.0.0 OK');
      if (komenda === 'VRFY') return wyslij('252 2.1.5 Cannot VRFY');
      if (komenda === 'QUIT') {
        wyslij('221 2.0.0 Bye');
        // Kończymy to gniazdo, do którego przed chwilą pisaliśmy · po STARTTLS jest nim
        // TLSSocket. FIN na gnieździe pod spodem działa tylko dzięki kolejności flushu
        // i przy zatorze na wysyłce wyprzedziłby zakolejkowany rekord TLS.
        gniazdo.end();
        return;
      }
      wyslij('500 5.5.2 Command not recognized');
    }

    function obsluzDane(linia) {
      // koniec danych: samotna kropka
      if (linia.length === 1 && linia[0] === 0x2e) {
        wDanych = false;
        if (przepelnione) {
          resetujTransakcje();
          return wyslij('552 5.3.4 Message too big');
        }
        zakonczOdbior();
        return;
      }
      // dot-stuffing: ".." na początku linii → "."
      if (linia.length >= 2 && linia[0] === 0x2e && linia[1] === 0x2e) {
        linia = linia.subarray(1);
      }
      rozmiarDanych += linia.length + 2;
      if (rozmiarDanych > MAX_MESSAGE_BYTES) {
        przepelnione = true;
        linieDanych = [];
        return;
      }
      linieDanych.push(linia);
    }

    function zakonczOdbior() {
      const czesci = [];
      for (const [i, linia] of linieDanych.entries()) {
        if (i > 0) czesci.push(CRLF);
        czesci.push(linia);
      }
      const raw = Buffer.concat(czesci);
      linieDanych = [];

      let parsed;
      try {
        parsed = parseMessage(raw);
      } catch (err) {
        log.error('[smtp] parse', err);
        resetujTransakcje();
        return wyslij('451 4.3.0 Message parse error');
      }

      if (!parsed.from.addr) parsed.from = { name: parsed.from.name, addr: koperta.mailFrom || 'nieznany@nadawca' };

      let doreczono = 0;
      for (const odbiorca of koperta.rcpt) {
        try {
          deliverInbound(db, odbiorca.id, parsed, { toAddr: parsed.to || odbiorca.adres });
          doreczono += 1;
        } catch (err) {
          log.error('[smtp] deliver', err);
        }
      }
      resetujTransakcje();
      if (!doreczono) return wyslij('451 4.3.0 Delivery failed');
      wyslij('250 2.0.0 OK, delivered');
    }
  });

  server.listen(port, host, () => {
    // secureContext() pytamy przy każdym EHLO i handshake, więc to zdanie opisuje wyłącznie
    // chwilę startu · certyfikat, który pojawi się później, zostanie ogłoszony bez restartu.
    // Log, który mówiłby „bez STARTTLS” o żywym serwerze, kłamałby operatorowi w oczy.
    const szyfr = secureContext() ? 'na starcie z certyfikatem' : 'na starcie bez certyfikatu';
    log.log(`  \u{1F4E5} SMTP nasluchuje na ${host}:${port} (domena ${DOMAIN}, STARTTLS ${szyfr})`);
  });
  return server;
}
