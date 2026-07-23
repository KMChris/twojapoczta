// Zespoły: skrzynki funkcyjne instancji. Zakładanie, nazwa, skład i prawo wysyłki.

import { api } from './api.js';
import { el, ikona, toast } from '../app/ui.js';

export function initZespoly(stan) {
  const kontener = document.querySelector('[data-widok="zespoly"]');
  const domena = () => stan.user.address.split('@')[1];
  let zespoly = [];
  let konta = [];

  async function odswiez() {
    const [{ teams }, { users }] = await Promise.all([api.zespoly(), api.uzytkownicy()]);
    zespoly = teams;
    konta = users;
  }

  function czlonek(zespol, m) {
    return el('li', { class: 'czlonek' },
      el('span', {}, m.name),
      el('span', { class: 'mono' }, m.address),
      el('label', { class: 'czlonek-prawo' },
        el('input', {
          name: 'moze_wysylac',
          type: 'checkbox',
          ...(m.can_send ? { checked: 'checked' } : {}),
          onchange: async (e) => {
            try {
              await api.ustawCzlonka(zespol.id, m.user_id, e.target.checked);
              toast(e.target.checked ? 'Może wysyłać' : 'Tylko odbiera', { ikonaNazwa: 'mail' });
              await odswiez();
              rysuj();
            } catch (err) {
              toast(err.message, { blad: true });
            }
          },
        }),
        'może wysyłać'
      ),
      el('button', {
        class: 'alias-usun',
        'aria-label': `Wypisz ${m.address} z zespołu`,
        onclick: async () => {
          try {
            await api.usunCzlonka(zespol.id, m.user_id);
            toast('Wypisano z zespołu', { ikonaNazwa: 'trash' });
            await odswiez();
            rysuj();
          } catch (err) {
            toast(err.message, { blad: true });
          }
        },
      }, ikona('trash'))
    );
  }

  function karta(zespol) {
    const wybor = el('select', { name: 'dopisz_konto' },
      el('option', { value: '' }, 'Dopisz konto…'),
      ...konta
        .filter((u) => !zespol.members.some((m) => m.user_id === u.id))
        .map((u) => el('option', { value: String(u.id) }, `${u.name} · ${u.address}`))
    );

    // Usunięcie zwalnia adres na zawsze, więc pytamy tak jak przy koncie: pierwszy
    // klik uzbraja i podmienia napis, drugi wykonuje. Karta i tak przerysowuje się
    // przy każdym rysuj(), więc flaga sama zeruje się po zmianie listy.
    let potwierdzenie = false;
    const usun = el('button', {
      class: 'btn-drugi grozny',
      onclick: async () => {
        if (!potwierdzenie) {
          potwierdzenie = true;
          usun.replaceChildren(ikona('trash'), `Na pewno? Adres ${zespol.address} zwolni się`);
          return;
        }
        try {
          await api.usunZespol(zespol.id);
          toast('Usunięto zespół', { ikonaNazwa: 'trash' });
          await odswiez();
          rysuj();
        } catch (err) {
          toast(err.message, { blad: true });
        }
      },
    }, ikona('trash'), 'Usuń zespół');

    return el('article', { class: 'zespol-karta' },
      el('header', {},
        el('b', {}, zespol.name),
        el('span', { class: 'mono' }, zespol.address)
      ),
      el('div', { class: 'zespol-tresc' },
        // Zespół bez członków odbija pocztę 550, a to jedyne miejsce, gdzie admin
        // może się o tym dowiedzieć, zanim dowie się od nadawcy.
        zespol.members.length
          ? null
          : el('p', { class: 'ostrzezenie' }, 'Ten zespół nie ma członków. Poczta na jego adres jest odrzucana.'),
        el('ul', { class: 'czlonkowie' }, ...zespol.members.map((m) => czlonek(zespol, m))),
        el('div', { class: 'zespol-akcje' },
          wybor,
          el('button', {
            class: 'btn-drugi',
            onclick: async () => {
              if (!wybor.value) return;
              try {
                await api.ustawCzlonka(zespol.id, Number(wybor.value), false);
                toast('Dopisano do zespołu', { ikonaNazwa: 'mail' });
                await odswiez();
                rysuj();
              } catch (err) {
                toast(err.message, { blad: true });
              }
            },
          }, 'Dopisz'),
          usun
        )
      )
    );
  }

  function rysuj() {
    const nazwa = el('input', { name: 'nazwa', type: 'text', placeholder: 'Dział Sprzedaży', maxlength: '60' });
    const adres = el('input', { name: 'adres', type: 'text', placeholder: 'sprzedaz', maxlength: '30' });

    kontener.replaceChildren(
      el('div', { class: 'sekcja-naglowek' }, el('h1', {}, 'Zespoły')),
      el('p', { class: 'karta-opis' },
        'Skrzynka zespołowa to wspólny adres z własną nazwą. Poczta na niego rozchodzi się do wszystkich członków, a wysyłka podpisuje się nazwą zespołu.'),
      el('section', { class: 'zespol-nowy' },
        el('h2', {}, 'Nowy zespół'),
        el('div', { class: 'zespol-nowy-pola' },
          el('label', { class: 'zespol-pole' }, el('span', {}, 'Nazwa zespołu'), nazwa),
          el('label', { class: 'zespol-pole' },
            el('span', {}, 'Adres'),
            el('span', { class: 'zespol-adres-wiersz' },
              adres,
              el('span', { class: 'mono zespol-domena', 'aria-hidden': 'true' }, `@${domena()}`)
            )
          ),
          el('button', {
            class: 'btn-glowny',
            onclick: async () => {
              try {
                await api.dodajZespol({ local_part: adres.value.trim().toLowerCase(), name: nazwa.value.trim() });
                toast('Założono zespół', { ikonaNazwa: 'mail' });
                await odswiez();
                rysuj();
              } catch (err) {
                toast(err.message, { blad: true });
              }
            },
          }, 'Załóż zespół')
        )
      ),
      zespoly.length
        ? el('div', { class: 'zespoly-lista' }, ...zespoly.map(karta))
        : el('p', { class: 'karta-opis' }, 'Nie ma jeszcze żadnego zespołu.')
    );
  }

  return {
    async pokaz() {
      try {
        await odswiez();
        rysuj();
      } catch (err) {
        toast(err.message, { blad: true });
      }
    },
  };
}
