// Domena i DNS: klucze DKIM (generowanie, rotacja, rekord TXT) oraz żywa
// weryfikacja rekordów MX / A / SPF / DKIM / DMARC.

import { api } from './api.js';
import { el, ikona, toast } from '../app/ui.js';

const STATUSY = {
  ok: ['Zgodny', 'ok', 'check'],
  missing: ['Brak rekordu', 'zle', 'close'],
  mismatch: ['Niezgodny', 'zle', 'spam'],
  error: ['Błąd sprawdzania', 'uwaga', 'spam'],
  skipped: ['Pominięty', 'uwaga', 'block'],
};

const NAZWY_REKORDOW = { mx: 'MX', a: 'A', spf: 'SPF (TXT)', dkim: 'DKIM (TXT)', dmarc: 'DMARC (TXT)' };

async function kopiuj(tekst) {
  try {
    await navigator.clipboard.writeText(tekst);
    toast('Skopiowano do schowka', { ikonaNazwa: 'copy' });
  } catch {
    toast('Nie udało się skopiować. Zaznacz i skopiuj ręcznie.', { blad: true });
  }
}

function przyciskKopiuj(tekst) {
  return el('button', { class: 'ikona-btn', title: 'Kopiuj', 'aria-label': 'Kopiuj do schowka', onclick: () => kopiuj(tekst) }, ikona('copy'));
}

export function initDomena() {
  const kontener = document.querySelector('[data-widok="domena"]');
  let ostatnieCzeki = null;

  async function pokaz() {
    let dkim;
    let ustawienia;
    try {
      [dkim, ustawienia] = await Promise.all([api.dkim(), api.ustawienia()]);
    } catch (blad) {
      return toast(blad.message, { blad: true });
    }
    renderuj(dkim, ustawienia.env);
  }

  function renderuj(dkim, env) {
    kontener.replaceChildren(
      el('div', { class: 'sekcja-naglowek' },
        el('h1', {}, 'Domena i DNS'),
        el('div', { class: 'prawa' },
          el('span', { class: 'naklejka' }, env.domain),
          el('span', { class: 'naklejka' }, `MX · ${env.smtp_hostname}`)
        )
      ),
      zbudujDkim(dkim, env),
      zbudujDns(env),
      el('div', { class: 'karta' },
        el('div', { class: 'karta-naglowek' }, el('h2', {}, 'PTR (revDNS)')),
        el('div', { class: 'karta-tresc' },
          el('p', { class: 'karta-opis' },
            `Rekord PTR dla adresu IP serwera ustawia się w panelu dostawcy VPS i powinien wskazywać ${env.smtp_hostname}. `,
            'Bez poprawnego PTR duzi odbiorcy (Gmail, Outlook) chętniej odrzucają pocztę.')
        )
      )
    );
  }

  // --- DKIM ------------------------------------------------------------------------

  function zbudujDkim(dkim, env) {
    const tresc = el('div', { class: 'karta-tresc' });

    if (!dkim.configured) {
      tresc.append(
        el('p', {}, 'Klucz DKIM nie jest jeszcze wygenerowany. Podpisy DKIM uwierzytelniają pocztę wychodzącą i są warunkiem dostarczalności do dużych odbiorców.'),
        el('div', { class: 'konto-rzad', style: 'margin-top: 0.8rem' },
          el('button', { class: 'btn-glowny', onclick: () => generuj() }, ikona('key'), 'Wygeneruj klucz DKIM')
        ),
        env.external ? null : el('p', { class: 'karta-opis' }, 'Wysyłka na zewnątrz jest wyłączona (brak TP_EXTERNAL=1). Klucz można przygotować już teraz, podpisy ruszą po włączeniu wysyłki.')
      );
    } else {
      const selektor = el('input', { type: 'text', maxlength: '31', placeholder: 'np. tp2', autocapitalize: 'none', spellcheck: 'false', 'aria-label': 'Nowy selektor' });
      tresc.append(
        el('p', {}, 'Dodaj w DNS rekord TXT o nazwie i wartości:'),
        el('div', { class: 'rekord-wiersz' }, el('code', { class: 'rekord' }, dkim.record.nazwa), przyciskKopiuj(dkim.record.nazwa)),
        el('div', { class: 'rekord-wiersz' }, el('code', { class: 'rekord' }, dkim.record.wartosc), przyciskKopiuj(dkim.record.wartosc)),
        el('div', { class: 'konto-rzad', style: 'margin-top: 1rem' },
          el('div', { class: 'alias-dodawanie' },
            selektor,
            el('button', {
              type: 'button',
              class: 'alias-dodaj',
              onclick: () => {
                const nowy = selektor.value.trim().toLowerCase();
                if (!nowy) return selektor.focus();
                generuj(nowy);
              },
            }, 'Rotuj klucz')
          ),
          el('p', { class: 'opis' }, 'Rotacja tworzy nowy klucz pod nowym selektorem. Stary rekord TXT można usunąć z DNS po kilku dniach.')
        )
      );
    }

    return el('div', { class: 'karta' },
      el('div', { class: 'karta-naglowek' },
        el('h2', {}, 'DKIM'),
        el('div', { class: 'prawa' },
          dkim.configured
            ? el('span', { class: 'naklejka naklejka-ok' }, `Selektor · ${dkim.selector}`)
            : el('span', { class: 'naklejka naklejka-uwaga' }, 'Brak klucza')
        )
      ),
      tresc
    );
  }

  async function generuj(selector) {
    try {
      const wynik = await api.generujDkim(selector);
      toast(wynik.generated ? `Wygenerowano klucz (selektor ${wynik.selector})` : `Wczytano istniejący klucz ${wynik.selector}`, { ikonaNazwa: 'key' });
      ostatnieCzeki = null;
      pokaz();
    } catch (blad) {
      toast(blad.message, { blad: true });
    }
  }

  // --- Weryfikacja DNS ------------------------------------------------------------------

  function zbudujDns() {
    const cel = el('div', { class: 'karta-tresc' });
    if (ostatnieCzeki) {
      cel.replaceChildren(tabelaCzekow(ostatnieCzeki));
    } else {
      cel.append(el('p', { class: 'karta-opis' }, 'Sprawdź, czy rekordy DNS domeny wskazują ten serwer: MX, A, SPF, DKIM i DMARC. Zapytania idą z tego serwera, więc widzisz to, co widzą inni.'));
    }

    const przycisk = el('button', {
      class: 'btn-glowny',
      onclick: async () => {
        przycisk.disabled = true;
        przycisk.replaceChildren(ikona('refresh'), 'Sprawdzam…');
        try {
          const { checks } = await api.sprawdzDns();
          ostatnieCzeki = checks;
          cel.replaceChildren(tabelaCzekow(checks));
        } catch (blad) {
          toast(blad.message, { blad: true });
        } finally {
          przycisk.disabled = false;
          przycisk.replaceChildren(ikona('refresh'), 'Sprawdź rekordy');
        }
      },
    }, ikona('refresh'), 'Sprawdź rekordy');

    return el('div', { class: 'karta' },
      el('div', { class: 'karta-naglowek' },
        el('h2', {}, 'Weryfikacja DNS'),
        el('div', { class: 'prawa' }, przycisk)
      ),
      cel
    );
  }

  function tabelaCzekow(checks) {
    const wiersze = checks.map((c) => {
      const [etykieta, klasa, ikonaNazwa] = STATUSY[c.status] ?? STATUSY.error;
      return el('tr', {},
        el('td', {}, el('b', {}, NAZWY_REKORDOW[c.id] ?? c.id)),
        el('td', {}, el('span', { class: `dns-status ${klasa}` }, ikona(ikonaNazwa), etykieta)),
        el('td', {},
          el('div', { class: 'rekord-wiersz', style: 'margin-top: 0' },
            el('code', { class: 'rekord' }, c.expected),
            przyciskKopiuj(c.expected)
          ),
          c.found && c.status !== 'ok'
            ? el('p', { class: 'karta-opis' }, `Zastane: ${c.found}`)
            : null
        )
      );
    });

    return el('div', { class: 'tabela-zwoj' },
      el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Rekord'), el('th', {}, 'Stan'), el('th', {}, 'Oczekiwana wartość'))),
        el('tbody', {}, ...wiersze)
      )
    );
  }

  return { pokaz };
}
