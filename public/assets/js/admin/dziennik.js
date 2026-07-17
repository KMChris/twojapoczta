// Dziennik zdarzeń: działania administratorów i logowania, z filtrem po akcji.

import { api } from './api.js';
import { el, toast, krotkiCzas, pelnaData } from '../app/ui.js';

const AKCJE = {
  'login': 'Logowanie',
  'login.failed': 'Nieudane logowanie',
  'user.register': 'Rejestracja konta',
  'user.create': 'Założenie konta',
  'user.update': 'Zmiana danych',
  'user.admin': 'Zmiana roli',
  'user.block': 'Blokada konta',
  'user.unblock': 'Odblokowanie konta',
  'user.quota': 'Zmiana limitu miejsca',
  'user.alias_limit': 'Zmiana limitu aliasów',
  'user.password': 'Zmiana hasła',
  'user.logout': 'Wylogowanie konta',
  'user.delete': 'Usunięcie konta',
  'alias.create': 'Dodanie aliasu',
  'alias.delete': 'Usunięcie aliasu',
  'team.create': 'Założenie zespołu',
  'team.update': 'Zmiana nazwy zespołu',
  'team.delete': 'Usunięcie zespołu',
  'team.member.add': 'Dopisanie do zespołu',
  'team.member.remove': 'Wypisanie z zespołu',
  'team.member.send': 'Zmiana prawa wysyłki',
  'settings.update': 'Zmiana ustawień',
  'broadcast.send': 'Komunikat do wszystkich',
  'dkim.generate': 'Klucz DKIM',
};

const GROZNE = new Set(['login.failed', 'user.block', 'user.delete']);

export function initDziennik() {
  const kontener = document.querySelector('[data-widok="dziennik"]');
  let filtr = '';

  async function pokaz() {
    let events;
    try {
      ({ events } = await api.dziennik(filtr));
    } catch (blad) {
      return toast(blad.message, { blad: true });
    }
    renderuj(events);
  }

  function renderuj(events) {
    const wybor = el('select', { class: 'filtr-dziennika', 'aria-label': 'Filtruj po typie zdarzenia' },
      el('option', { value: '' }, 'Wszystkie zdarzenia'),
      ...Object.entries(AKCJE).map(([wartosc, etykieta]) =>
        el('option', { value: wartosc }, etykieta)
      )
    );
    wybor.value = filtr;
    wybor.addEventListener('change', () => {
      filtr = wybor.value;
      pokaz();
    });

    kontener.replaceChildren(
      el('div', { class: 'sekcja-naglowek' },
        el('h1', {}, 'Dziennik zdarzeń'),
        el('div', { class: 'prawa' },
          wybor,
          el('button', { class: 'btn-drugi', onclick: pokaz }, 'Odśwież')
        )
      ),
      zbudujTabele(events),
      el('p', { class: 'karta-opis' }, 'Dziennik przechowuje zdarzenia z ostatnich 90 dni. Wpisy przeżywają usunięcie konta.')
    );
  }

  function zbudujTabele(events) {
    if (!events.length) {
      return el('div', { class: 'karta' }, el('p', { class: 'tabela-pusta' }, 'Dziennik jest pusty. Jeszcze nic się nie wydarzyło.'));
    }

    const wiersze = events.map((w) =>
      el('tr', {},
        el('td', { class: 'mono', title: pelnaData(w.created_at) }, krotkiCzas(w.created_at)),
        el('td', { class: 'mono' }, w.actor_login),
        el('td', {}, el('span', { class: `naklejka${GROZNE.has(w.action) ? ' naklejka-blokada' : ''}` }, AKCJE[w.action] ?? w.action)),
        el('td', { class: 'mono' }, w.target || '—'),
        el('td', {}, w.details || '—'),
        el('td', { class: 'mono' }, w.ip || '—')
      )
    );

    return el('div', { class: 'karta tabela-zwoj' },
      el('table', { class: 'tabela' },
        el('thead', {}, el('tr', {},
          el('th', {}, 'Kiedy'),
          el('th', {}, 'Kto'),
          el('th', {}, 'Zdarzenie'),
          el('th', {}, 'Cel'),
          el('th', {}, 'Szczegóły'),
          el('th', {}, 'IP')
        )),
        el('tbody', {}, ...wiersze)
      )
    );
  }

  return { pokaz };
}
