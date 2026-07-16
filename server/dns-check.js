// Weryfikacja rekordów DNS domeny pocztowej: MX, A, SPF, DKIM, DMARC.
// Resolver wstrzykiwany: testy nie dotykają sieci, produkcyjnie node:dns.

import { promises as nodeDns } from 'node:dns';

const BRAK_REKORDU = new Set(['ENOTFOUND', 'ENODATA']);

const opisBledu = (err) => (err?.code ? String(err.code) : String(err?.message ?? err));

// TXT przychodzi pocięty na chunki (limit 255 bajtów), więc sklejamy w całe rekordy.
const txtJoin = (rekordy) => rekordy.map((czesci) => czesci.join(''));

// Wartość p= z rekordu DKIM, znormalizowana (bez spacji i cudzysłowów).
function kluczDkim(rekord) {
  const m = String(rekord).replace(/["\s]/g, '').match(/p=([A-Za-z0-9+/=]*)/);
  return m ? m[1] : '';
}

async function sprawdz(id, expected, dzialanie) {
  try {
    return { id, expected, ...(await dzialanie()) };
  } catch (err) {
    const status = BRAK_REKORDU.has(err?.code) ? 'missing' : 'error';
    return { id, expected, status, found: status === 'error' ? opisBledu(err) : null };
  }
}

// Zwraca listę kontroli: { id, status: ok|missing|mismatch|error|skipped, expected, found }.
export async function checkDns({ domain, hostname, dkim = null, resolver = nodeDns }) {
  const host = String(hostname).toLowerCase();

  return Promise.all([
    sprawdz('mx', `${domain} MX → 10 ${host}`, async () => {
      const wpisy = await resolver.resolveMx(domain);
      if (!wpisy.length) return { status: 'missing', found: null };
      const trafiony = wpisy.some((w) => String(w.exchange).toLowerCase().replace(/\.$/, '') === host);
      return {
        status: trafiony ? 'ok' : 'mismatch',
        found: wpisy.map((w) => `${w.priority} ${w.exchange}`).join(', '),
      };
    }),

    sprawdz('a', `${host} A → adres IP serwera`, async () => {
      const adresy = await resolver.resolve4(host);
      if (!adresy.length) return { status: 'missing', found: null };
      return { status: 'ok', found: adresy.join(', ') };
    }),

    sprawdz('spf', `${domain} TXT → v=spf1 a mx -all`, async () => {
      const rekordy = txtJoin(await resolver.resolveTxt(domain));
      const spf = rekordy.find((r) => r.toLowerCase().startsWith('v=spf1'));
      if (!spf) return { status: 'missing', found: null };
      return { status: 'ok', found: spf };
    }),

    dkim
      ? sprawdz('dkim', `${dkim.name} TXT → ${dkim.value}`, async () => {
          const rekordy = txtJoin(await resolver.resolveTxt(dkim.name));
          const wpis = rekordy.find((r) => r.toUpperCase().includes('V=DKIM1'));
          if (!wpis) return { status: 'missing', found: null };
          return {
            status: kluczDkim(wpis) === kluczDkim(dkim.value) ? 'ok' : 'mismatch',
            found: wpis,
          };
        })
      : Promise.resolve({
          id: 'dkim',
          status: 'skipped',
          expected: 'najpierw wygeneruj klucz DKIM',
          found: null,
        }),

    sprawdz('dmarc', `_dmarc.${domain} TXT → v=DMARC1; p=quarantine`, async () => {
      const rekordy = txtJoin(await resolver.resolveTxt(`_dmarc.${domain}`));
      const wpis = rekordy.find((r) => r.toUpperCase().startsWith('V=DMARC1'));
      if (!wpis) return { status: 'missing', found: null };
      return { status: 'ok', found: wpis };
    }),
  ]);
}
