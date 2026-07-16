// Użytkownicy: tabela kont z metadanymi, zakładanie kont, edycja w modalu
// (rola, blokada, limit, hasło, aliasy, sesje, usunięcie).

import { api } from './api.js';
import { el, ikona, toast, formatujRozmiar, krotkiCzas, bezOgonkow } from '../app/ui.js';

export function initUzytkownicy(stan) {
  const kontener = document.querySelector('[data-widok="uzytkownicy"]');
  const modalNowe = document.querySelector('[data-modal-nowe]');
  const modalKonta = document.querySelector('[data-modal-konta]');
  const domena = () => stan.user.address.split('@')[1];

  let lista = [];
  let filtr = '';

  async function odswiez() {
    const { users } = await api.uzytkownicy();
    lista = users;
  }

  async function pokaz() {
    try {
      await odswiez();
    } catch (blad) {
      return toast(blad.message, { blad: true });
    }
    renderuj();
  }

  function przefiltrowani() {
    if (!filtr) return lista;
    const igla = bezOgonkow(filtr);
    return lista.filter((u) =>
      bezOgonkow(`${u.login} ${u.name} ${u.aliases.map((a) => a.alias).join(' ')}`).includes(igla)
    );
  }

  function renderuj() {
    const szukajInput = el('input', {
      type: 'search',
      placeholder: 'Filtruj konta…',
      'aria-label': 'Filtruj konta',
      value: filtr,
      oninput: (e) => {
        filtr = e.target.value.trim();
        renderuj();
        // Ponowne renderowanie gubi fokus, więc oddaj go polu filtra.
        const swieze = kontener.querySelector('input[type="search"]');
        swieze.focus();
        swieze.setSelectionRange(swieze.value.length, swieze.value.length);
      },
    });

    kontener.replaceChildren(
      el('div', { class: 'sekcja-naglowek' },
        el('h1', {}, 'Użytkownicy'),
        el('div', { class: 'prawa' },
          el('button', { class: 'btn-glowny', onclick: otworzNowe }, ikona('plus'), 'Dodaj konto')
        )
      ),
      el('div', { class: 'narzedzia' },
        el('div', { class: 'szukaj' }, ikona('users'), szukajInput),
        el('span', { class: 'naklejka' }, `${lista.length} kont`)
      ),
      zbudujTabele()
    );
  }

  function zbudujTabele() {
    const konta = przefiltrowani();
    if (!konta.length) {
      return el('div', { class: 'karta' }, el('p', { class: 'tabela-pusta' }, 'Brak kont pasujących do filtra.'));
    }

    const naglowek = el('tr', {},
      el('th', {}, 'Konto'),
      el('th', {}, 'Status'),
      el('th', {}, 'Wiadomości'),
      el('th', {}, 'Zajętość'),
      el('th', {}, 'Aliasy'),
      el('th', {}, 'Ostatnie logowanie')
    );

    const wiersze = konta.map((u) =>
      el('tr', {
        dataset: { klik: '1' },
        tabindex: '0',
        role: 'button',
        'aria-label': `Zarządzaj kontem ${u.address}`,
        onclick: () => otworzKonto(u.id),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            otworzKonto(u.id);
          }
        },
      },
        el('td', { class: 'komorka-adres' }, el('b', {}, u.name), el('span', {}, u.address)),
        el('td', {},
          u.is_admin ? el('span', { class: 'naklejka naklejka-admin' }, 'Admin') : null,
          u.is_blocked ? el('span', { class: 'naklejka naklejka-blokada' }, 'Zablokowane') : null,
          !u.is_admin && !u.is_blocked ? el('span', { class: 'naklejka' }, 'Aktywne') : null
        ),
        el('td', { class: 'mono' }, String(u.messages)),
        el('td', { class: 'mono' }, formatujRozmiar(u.storage_bytes) + (u.quota_mb ? ` / ${u.quota_mb} MB` : '')),
        el('td', { class: 'mono' }, String(u.aliases.length) + (u.alias_limit == null ? '' : ` / ${u.alias_limit}`)),
        el('td', { class: 'mono' }, u.last_login_at ? krotkiCzas(u.last_login_at) : '—')
      )
    );

    return el('div', { class: 'karta tabela-zwoj' },
      el('table', { class: 'tabela' }, el('thead', {}, naglowek), el('tbody', {}, ...wiersze))
    );
  }

  // --- Nowe konto ---------------------------------------------------------------

  function otworzNowe() {
    const formularz = el('form', { class: 'ustawienia-formularz formularz-admina' },
      el('label', { class: 'pole' },
        el('span', {}, 'Login'),
        el('div', { class: 'alias-dodawanie' },
          el('input', { name: 'login', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '30', required: '' }),
          el('span', { 'aria-hidden': 'true' }, `@${domena()}`)
        )
      ),
      el('label', { class: 'pole' },
        el('span', {}, 'Imię i nazwisko'),
        el('input', { name: 'imie', type: 'text', maxlength: '60', required: '' })
      ),
      el('label', { class: 'pole' },
        el('span', {}, 'Hasło startowe'),
        el('input', { name: 'haslo', type: 'password', autocomplete: 'new-password', required: '' })
      ),
      el('footer', { class: 'modal-stopka' },
        el('button', { type: 'submit', class: 'btn-zapisz' }, 'Załóż konto')
      )
    );

    formularz.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { user } = await api.dodajKonto({
          login: formularz.login.value.trim().toLowerCase(),
          name: formularz.imie.value.trim(),
          password: formularz.haslo.value,
        });
        modalNowe.close();
        toast(`Założono konto ${user.address}`, { ikonaNazwa: 'users' });
        await odswiez();
        renderuj();
      } catch (blad) {
        toast(blad.message, { blad: true });
      }
    });

    modalNowe.replaceChildren(
      el('header', { class: 'modal-naglowek' },
        el('h2', {}, 'Nowe konto'),
        el('button', { class: 'ikona-btn', 'aria-label': 'Zamknij', onclick: () => modalNowe.close() }, ikona('close'))
      ),
      formularz
    );
    modalNowe.showModal();
    formularz.login.focus();
  }

  // --- Edycja konta ----------------------------------------------------------------

  function otworzKonto(id) {
    const u = lista.find((x) => x.id === id);
    if (!u) return;
    renderujKonto(u);
    modalKonta.showModal();
  }

  async function zastosuj(id, operacja, komunikat) {
    try {
      const wynik = await operacja();
      await odswiez();
      renderuj();
      const swiezy = lista.find((x) => x.id === id);
      if (swiezy && modalKonta.open) renderujKonto(swiezy);
      if (komunikat) toast(komunikat, { ikonaNazwa: 'users' });
      return wynik;
    } catch (blad) {
      toast(blad.message, { blad: true });
      return null;
    }
  }

  function renderujKonto(u) {
    const toJa = u.login === stan.user.login;

    // Dane podstawowe
    const imie = el('input', { type: 'text', value: u.name, maxlength: '60', 'aria-label': 'Imię i nazwisko' });
    const daneRzad = el('div', { class: 'konto-rzad' },
      el('div', { class: 'pole-obok', style: 'flex: 1' },
        imie,
        el('button', { class: 'btn-drugi', onclick: () => zastosuj(u.id, () => api.zmienKonto(u.id, { name: imie.value.trim() }), 'Zapisano imię') }, 'Zapisz')
      )
    );

    // Rola i blokada
    const rola = el('button', {
      class: 'btn-drugi',
      onclick: () => zastosuj(u.id, () => api.zmienKonto(u.id, { is_admin: !u.is_admin }), u.is_admin ? 'Odebrano rolę administratora' : 'Nadano rolę administratora'),
    }, ikona('shield'), u.is_admin ? 'Odbierz rolę administratora' : 'Nadaj rolę administratora');

    const blokada = toJa ? null : el('button', {
      class: `btn-drugi${u.is_blocked ? '' : ' grozny'}`,
      onclick: () => zastosuj(u.id, () => api.zmienKonto(u.id, { is_blocked: !u.is_blocked }), u.is_blocked ? 'Odblokowano konto' : 'Zablokowano konto'),
    }, ikona('block'), u.is_blocked ? 'Odblokuj konto' : 'Zablokuj konto');

    // Limit miejsca
    const limit = el('input', { type: 'number', min: '1', step: '1', value: u.quota_mb ?? '', placeholder: 'bez', 'aria-label': 'Limit miejsca w MB' });
    const limitRzad = el('div', { class: 'konto-rzad' },
      limit,
      el('span', {}, 'MB'),
      el('button', {
        class: 'btn-drugi',
        onclick: () => {
          const surowe = limit.value.trim();
          const wartosc = surowe === '' ? null : Number(surowe);
          zastosuj(u.id, () => api.zmienKonto(u.id, { quota_mb: wartosc }), 'Zapisano limit miejsca');
        },
      }, 'Zapisz limit'),
      el('p', { class: 'opis' }, `Zajęte: ${formatujRozmiar(u.storage_bytes)}. Puste pole = bez limitu. Pełna skrzynka przestaje przyjmować pocztę, ale nadal może wysyłać.`)
    );

    // Hasło
    const haslo = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Nowe hasło', 'aria-label': 'Nowe hasło' });
    const hasloRzad = el('div', { class: 'konto-rzad' },
      el('div', { class: 'pole-obok', style: 'flex: 1' },
        haslo,
        el('button', {
          class: 'btn-drugi',
          onclick: async () => {
            const ok = await zastosuj(u.id, () => api.ustawHaslo(u.id, haslo.value), 'Ustawiono nowe hasło');
            if (ok) haslo.value = '';
          },
        }, 'Ustaw hasło')
      ),
      el('p', { class: 'opis' }, toJa ? 'Zmiana własnego hasła nie wylogowuje z tej sesji.' : 'Nowe hasło wylogowuje konto ze wszystkich urządzeń.')
    );

    // Aliasy: limit konta + lista z dodawaniem
    const limitAliasow = el('input', {
      type: 'number', min: '0', step: '1', value: u.alias_limit ?? '', placeholder: 'bez',
      'aria-label': 'Maksymalna liczba aliasów',
    });
    const limitAliasowRzad = el('div', { class: 'konto-rzad' },
      limitAliasow,
      el('span', {}, 'aliasów'),
      el('button', {
        class: 'btn-drugi',
        onclick: () => {
          const surowe = limitAliasow.value.trim();
          zastosuj(u.id, () => api.zmienKonto(u.id, { alias_limit: surowe === '' ? null : Number(surowe) }), 'Zapisano limit aliasów');
        },
      }, 'Zapisz limit'),
      el('p', { class: 'opis' }, 'Puste pole = bez limitu (użytkownik nie zobaczy wtedy żadnej liczby). Zero wyłącza aliasy. Obniżenie limitu nie kasuje aliasów, które konto już ma.')
    );

    const aliasInput = el('input', { type: 'text', maxlength: '30', autocapitalize: 'none', spellcheck: 'false', placeholder: 'np. biuro', 'aria-label': 'Nowy alias' });
    const aliasyLista = el('ul', { class: 'aliasy' },
      ...(u.aliases.length
        ? u.aliases.map((a) =>
            el('li', { class: 'alias' },
              el('span', {}, a.address),
              el('button', {
                type: 'button',
                class: 'alias-usun',
                'aria-label': `Usuń alias ${a.address}`,
                onclick: () => zastosuj(u.id, () => api.usunAlias(u.id, a.id), 'Usunięto alias'),
              }, ikona('close'))
            )
          )
        : [el('li', { class: 'aliasy-brak' }, 'Bez aliasów.')])
    );
    const aliasyBlok = el('div', {},
      aliasyLista,
      el('div', { class: 'alias-dodawanie' },
        aliasInput,
        el('span', { 'aria-hidden': 'true' }, `@${domena()}`),
        el('button', {
          type: 'button',
          class: 'alias-dodaj',
          onclick: () => {
            const alias = aliasInput.value.trim().toLowerCase();
            if (!alias) return aliasInput.focus();
            zastosuj(u.id, () => api.dodajAlias(u.id, alias), 'Dodano alias');
          },
        }, 'Dodaj')
      )
    );

    // Sesje i usunięcie
    const wylogujWszedzie = el('button', {
      class: 'btn-drugi',
      onclick: () => zastosuj(u.id, () => api.wylogujKonto(u.id), 'Wylogowano ze wszystkich urządzeń'),
    }, 'Wyloguj ze wszystkich urządzeń');

    let potwierdzenie = false;
    const usun = toJa ? null : el('button', {
      class: 'btn-drugi grozny',
      onclick: async () => {
        if (!potwierdzenie) {
          potwierdzenie = true;
          usun.replaceChildren(ikona('trash'), `Na pewno? Zniknie ${u.messages} wiadomości`);
          return;
        }
        try {
          await api.usunKonto(u.id);
          modalKonta.close();
          toast(`Usunięto konto ${u.address}`, { ikonaNazwa: 'trash' });
          await odswiez();
          renderuj();
        } catch (blad) {
          toast(blad.message, { blad: true });
        }
      },
    }, ikona('trash'), 'Usuń konto z całą pocztą');

    modalKonta.replaceChildren(
      el('header', { class: 'modal-naglowek' },
        el('div', {},
          el('h2', {}, u.name),
          el('span', { class: 'konto-naglowek-adres' }, u.address)
        ),
        el('button', { class: 'ikona-btn', 'aria-label': 'Zamknij', onclick: () => modalKonta.close() }, ikona('close'))
      ),
      el('div', { class: 'konto-siatka' },
        el('div', { class: 'konto-rzad' },
          u.is_admin ? el('span', { class: 'naklejka naklejka-admin' }, 'Admin') : null,
          u.is_blocked ? el('span', { class: 'naklejka naklejka-blokada' }, 'Zablokowane') : null,
          el('span', { class: 'naklejka' }, `Od ${new Date(u.created_at).toLocaleDateString('pl-PL')}`),
          el('span', { class: 'naklejka' }, `${u.messages} wiad.`)
        ),
        el('p', { class: 'grupa-tytul' }, 'Dane'),
        daneRzad,
        el('p', { class: 'grupa-tytul' }, 'Uprawnienia i dostęp'),
        el('div', { class: 'konto-rzad' }, rola, blokada, wylogujWszedzie),
        el('p', { class: 'grupa-tytul' }, 'Limit miejsca'),
        limitRzad,
        el('p', { class: 'grupa-tytul' }, 'Hasło'),
        hasloRzad,
        el('p', { class: 'grupa-tytul' }, 'Aliasy'),
        limitAliasowRzad,
        aliasyBlok,
        usun ? el('p', { class: 'grupa-tytul' }, 'Strefa ostrożności') : null,
        usun ? el('div', { class: 'konto-rzad' }, usun) : null
      )
    );
  }

  return { pokaz };
}
