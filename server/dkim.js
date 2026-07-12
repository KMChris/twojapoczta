// Podpisy DKIM (RFC 6376) dla poczty wychodzącej: rsa-sha256, relaxed/relaxed.
// Klucz prywatny trzymamy w {TP_DATA_DIR}/dkim/{selektor}.pem, rekord TXT
// do DNS drukuje `npm run dkim`.

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SIGNED_HEADERS = ['from', 'to', 'subject', 'date', 'message-id', 'mime-version', 'content-type'];

let konfiguracja = null; // { privateKey, selector, domain }

export function initDkim(dataDir, { domain, selector = process.env.TP_DKIM_SELECTOR || 'tp1' }) {
  const katalog = path.join(dataDir, 'dkim');
  const plik = path.join(katalog, `${selector}.pem`);
  mkdirSync(katalog, { recursive: true });

  let pem;
  let wygenerowano = false;
  if (existsSync(plik)) {
    pem = readFileSync(plik, 'utf8');
  } else {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    writeFileSync(plik, pem, { mode: 0o600 });
    wygenerowano = true;
  }

  konfiguracja = { privateKey: crypto.createPrivateKey(pem), selector, domain };
  return { ...konfiguracja, wygenerowano, plik };
}

// Do testów i nietypowych wdrożeń: konfiguracja bez dotykania dysku.
export function configureDkim(cfg) {
  konfiguracja = cfg;
}

export function dkimConfigured() {
  return konfiguracja != null;
}

// Rekord TXT, który trzeba dodać w DNS domeny.
export function dnsRecord() {
  if (!konfiguracja) throw new Error('DKIM nie jest skonfigurowany.');
  const publiczny = crypto
    .createPublicKey(konfiguracja.privateKey)
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return {
    nazwa: `${konfiguracja.selector}._domainkey.${konfiguracja.domain}`,
    wartosc: `v=DKIM1; k=rsa; p=${publiczny}`,
  };
}

// --- Kanonizacja „relaxed" (RFC 6376 §3.4) -------------------------------------

export function canonHeaderRelaxed(name, value) {
  const nazwa = name.toLowerCase().trim();
  const wartosc = value
    .replace(/\r\n[ \t]+/g, ' ') // unfold
    .replace(/[ \t]+/g, ' ')
    .trim();
  return `${nazwa}:${wartosc}`;
}

export function canonBodyRelaxed(body) {
  let tekst = body.replace(/\r?\n/g, '\r\n');
  tekst = tekst
    .split('\r\n')
    .map((linia) => linia.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, ''))
    .join('\r\n');
  tekst = tekst.replace(/(\r\n)+$/, '');
  return tekst.length ? tekst + '\r\n' : '';
}

// --- Podpisywanie -----------------------------------------------------------------

function zbierzNaglowki(headText) {
  const pola = [];
  for (const linia of headText.split('\r\n')) {
    if (/^[ \t]/.test(linia) && pola.length) {
      pola[pola.length - 1][1] += '\r\n' + linia; // zachowaj fold, kanonizacja go zniesie
      continue;
    }
    const sep = linia.indexOf(':');
    if (sep === -1) continue;
    pola.push([linia.slice(0, sep), linia.slice(sep + 1)]);
  }
  return pola;
}

// Fold wolno wstawiać tylko tam, gdzie kanonizacja relaxed odda dokładnie to,
// co podpisaliśmy: na granicach tagów (fold ≙ pojedyncza spacja po średniku)
// oraz w środku wartości b= (usuwanej przed weryfikacją).
function zlozNaglowekDkim(wartoscBezPodpisu, podpis) {
  const tagi = wartoscBezPodpisu.split('; ');
  tagi.pop(); // końcowe puste "b="

  const linie = [];
  let linia = '';
  for (const tag of tagi) {
    if (linia && linia.length + tag.length + 2 > 74) {
      linie.push(linia + ';');
      linia = tag;
    } else {
      linia = linia ? `${linia}; ${tag}` : tag;
    }
  }
  linie.push(linia + ';');

  const czesciB = [];
  for (let i = 0; i < podpis.length; i += 70) czesciB.push(podpis.slice(i, i + 70));
  linie.push('b=' + czesciB.join('\r\n\t '));

  return linie.join('\r\n\t');
}

// Dokleja nagłówek DKIM-Signature na początek surowej wiadomości.
export function signMessage(raw) {
  if (!konfiguracja) return raw;
  const { privateKey, selector, domain } = konfiguracja;

  const idx = raw.indexOf('\r\n\r\n');
  const headText = idx === -1 ? raw : raw.slice(0, idx);
  const body = idx === -1 ? '' : raw.slice(idx + 4);

  const pola = zbierzNaglowki(headText);
  const obecne = [];
  for (const nazwa of SIGNED_HEADERS) {
    // RFC: przy wielu wystąpieniach podpisuje się od dołu, więc bierzemy ostatnie.
    const pole = [...pola].reverse().find(([n]) => n.toLowerCase().trim() === nazwa);
    if (pole) obecne.push({ nazwa, pole });
  }
  if (!obecne.length) return raw;

  const bh = crypto.createHash('sha256').update(canonBodyRelaxed(body), 'utf8').digest('base64');
  const czas = Math.floor(Date.now() / 1000);
  const wartoscBezPodpisu =
    `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; ` +
    `t=${czas}; h=${obecne.map((o) => o.nazwa).join(':')}; bh=${bh}; b=`;

  const doPodpisu =
    obecne.map((o) => canonHeaderRelaxed(o.pole[0], o.pole[1])).join('\r\n') +
    '\r\n' +
    canonHeaderRelaxed('dkim-signature', wartoscBezPodpisu);

  const podpis = crypto.sign('sha256', Buffer.from(doPodpisu, 'utf8'), privateKey).toString('base64');
  return `DKIM-Signature: ${zlozNaglowekDkim(wartoscBezPodpisu, podpis)}\r\n` + raw;
}
