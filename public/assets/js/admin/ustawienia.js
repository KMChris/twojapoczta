// Ustawienia instancji: rejestracja, polityka haseł, catch-all, komunikat
// do wszystkich oraz podgląd konfiguracji środowiskowej (read-only).

import { api } from './api.js';
import { el, ikona, toast } from '../app/ui.js';

export function initUstawienia() {
  const kontener = document.querySelector('[data-widok="ustawienia"]');

  async function pokaz() {
    let dane;
    try {
      dane = await api.ustawienia();
    } catch (blad) {
      return toast(blad.message, { blad: true });
    }
    renderuj(dane);
  }

  function renderuj({ settings, env }) {
    kontener.replaceChildren(
      el('div', { class: 'sekcja-naglowek' }, el('h1', {}, 'Ustawienia')),
      zbudujFormularz(settings),
      zbudujBroadcast(),
      zbudujEnv(env)
    );
  }

  function zbudujFormularz(settings) {
    const formularz = el('form', { class: 'ustawienia-formularz formularz-admina', style: 'padding: 1.1rem 1.2rem' },
      el('fieldset', { class: 'pole' },
        el('legend', {}, 'Rejestracja nowych kont'),
        el('div', { class: 'radio-rzad' },
          el('label', {}, el('input', { type: 'radio', name: 'rejestracja', value: '1' }), ' Otwarta'),
          el('label', {}, el('input', { type: 'radio', name: 'rejestracja', value: '0' }), ' Zamknięta (konta zakłada administrator)')
        )
      ),
      el('label', { class: 'pole' },
        el('span', {}, 'Minimalna długość hasła'),
        el('input', { name: 'minHasla', type: 'number', min: '4', max: '128', step: '1', value: String(settings.password_min) })
      ),
      el('label', { class: 'pole' },
        el('span', {}, 'Catch-all (poczta na nieistniejące adresy w domenie)'),
        el('input', { name: 'catchall', type: 'text', autocapitalize: 'none', spellcheck: 'false', placeholder: 'login skrzynki zbiorczej, puste = odbijaj', value: settings.catchall ?? '' })
      ),
      el('footer', { class: 'modal-stopka', style: 'padding: 0.4rem 0 0' },
        el('button', { type: 'submit', class: 'btn-zapisz' }, 'Zapisz ustawienia')
      )
    );
    formularz.rejestracja.value = settings.registration ? '1' : '0';

    formularz.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api.zapiszUstawienia({
          registration: formularz.rejestracja.value === '1',
          password_min: Number(formularz.minHasla.value),
          catchall: formularz.catchall.value.trim() || null,
        });
        toast('Zapisano ustawienia', { ikonaNazwa: 'ustawienia' });
        pokaz();
      } catch (blad) {
        toast(blad.message, { blad: true });
      }
    });

    return el('div', { class: 'karta' },
      el('div', { class: 'karta-naglowek' }, el('h2', {}, 'Zasady instancji')),
      formularz
    );
  }

  function zbudujBroadcast() {
    const formularz = el('form', { class: 'ustawienia-formularz formularz-admina', style: 'padding: 1.1rem 1.2rem' },
      el('label', { class: 'pole' },
        el('span', {}, 'Temat'),
        el('input', { name: 'temat', type: 'text', maxlength: '200', required: '', placeholder: 'np. Przerwa techniczna w sobotę' })
      ),
      el('label', { class: 'pole' },
        el('span', {}, 'Treść'),
        el('textarea', { name: 'tresc', rows: '4', required: '', placeholder: 'Wiadomość trafi do folderu Odebrane każdego konta.' })
      ),
      el('footer', { class: 'modal-stopka', style: 'padding: 0.4rem 0 0' },
        el('button', { type: 'submit', class: 'btn-zapisz' }, 'Nadaj komunikat')
      )
    );

    formularz.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { delivered } = await api.broadcast({ subject: formularz.temat.value.trim(), body: formularz.tresc.value });
        toast(`Komunikat doręczony do ${delivered} skrzynek`, { ikonaNazwa: 'send' });
        formularz.reset();
      } catch (blad) {
        toast(blad.message, { blad: true });
      }
    });

    return el('div', { class: 'karta' },
      el('div', { class: 'karta-naglowek' },
        el('h2', {}, 'Komunikat do wszystkich'),
        el('div', { class: 'prawa' }, el('span', { class: 'naklejka' }, 'Nadawca · Zespół TwojaPoczta'))
      ),
      formularz
    );
  }

  function zbudujEnv(env) {
    const wpisy = [
      ['Domena (TP_DOMAIN)', env.domain],
      ['Katalog danych (TP_DATA_DIR)', env.data_dir ?? '—'],
      ['SMTP przychodzący (TP_SMTP_PORT)', env.smtp_port ? `port ${env.smtp_port}` : 'wyłączony'],
      ['Nazwa hosta MX (TP_SMTP_HOSTNAME)', env.smtp_hostname],
      ['Wysyłka na zewnątrz (TP_EXTERNAL)', env.external ? 'włączona' : 'wyłączona'],
      ['Smarthost (TP_SMTP_ROUTE)', env.smtp_route ?? '— (bezpośrednio do MX)'],
      ['Walidacja TLS (TP_TLS_VERIFY)', env.tls_verify ? 'wymuszona' : 'oportunistyczna'],
      ['Konta demo (TP_SEED)', env.seed ? 'włączone' : 'wyłączone'],
    ];

    const definicje = el('dl', { class: 'definicje' });
    for (const [nazwa, wartosc] of wpisy) {
      definicje.append(el('dt', {}, nazwa), el('dd', { class: 'mono' }, String(wartosc)));
    }

    return el('div', { class: 'karta' },
      el('div', { class: 'karta-naglowek' },
        el('h2', {}, 'Środowisko (tylko podgląd)'),
        el('div', { class: 'prawa' }, el('span', { class: 'naklejka naklejka-uwaga' }, 'Zmiana wymaga restartu usługi'))
      ),
      el('div', { class: 'karta-tresc' },
        definicje,
        el('p', { class: 'karta-opis' }, 'Te wartości ustawia się zmiennymi środowiskowymi (np. w pliku systemd). Szczegóły w dokumentacji: docs/konfiguracja.md.')
      )
    );
  }

  return { pokaz };
}
