// Pulpit: kafle statystyk, wykres ruchu 14 dni (SVG bez bibliotek), zdrowie serwera.

import { api } from './api.js';
import { el, toast, formatujRozmiar } from '../app/ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, atrybuty = {}) {
  const wezel = document.createElementNS(SVG_NS, tag);
  for (const [klucz, wartosc] of Object.entries(atrybuty)) wezel.setAttribute(klucz, wartosc);
  return wezel;
}

function uptimeSlownie(sekundy) {
  const d = Math.floor(sekundy / 86400);
  const h = Math.floor((sekundy % 86400) / 3600);
  const m = Math.floor((sekundy % 3600) / 60);
  if (d) return `${d} dn. ${h} godz.`;
  if (h) return `${h} godz. ${m} min`;
  return `${Math.max(m, 1)} min`;
}

function kafel(tytul, wartosc, opis) {
  return el('div', { class: 'kafel' },
    el('span', { class: 'eyebrow' }, tytul),
    el('b', {}, String(wartosc)),
    opis ? el('small', {}, opis) : null
  );
}

// Słupki dzień po dniu: odebrane (błękit PRIORYTET) i wysłane (czerwień polecony).
function wykresRuchu(traffic) {
  const szer = 24;
  const wys = 150;
  const dol = 128;
  const svg = svgEl('svg', {
    // xmlns przeżywa serializację do `outerHTML` i dopiero tam jest potrzebny, patrz ui.js.
    xmlns: SVG_NS,
    viewBox: `0 0 ${traffic.length * szer} ${wys}`,
    role: 'img',
    'aria-label': 'Ruch pocztowy z ostatnich 14 dni',
  });
  const max = Math.max(1, ...traffic.map((t) => Math.max(t.received, t.sent)));

  traffic.forEach((dzien, i) => {
    const x = i * szer;
    const para = [
      [dzien.received, 'var(--priorytet)', 3],
      [dzien.sent, 'var(--polecony)', 12],
    ];
    for (const [ile, kolor, dx] of para) {
      const h = Math.round((ile / max) * 100);
      const slupek = svgEl('rect', {
        class: 'wykres-slupek',
        x: x + dx,
        y: dol - h,
        width: 8,
        height: Math.max(h, ile ? 2 : 0.75),
        rx: 1.5,
        fill: kolor,
        opacity: ile ? 1 : 0.25,
      });
      slupek.append(svgEl('title'));
      slupek.lastChild.textContent = `${dzien.date}: odebrane ${dzien.received}, wysłane ${dzien.sent}`;
      svg.append(slupek);
    }
    // Etykiety: pierwszy dzień, co czwarty i ostatni.
    if (i === 0 || i === traffic.length - 1 || i % 4 === 0) {
      const tekst = svgEl('text', {
        x: x + 11.5,
        y: wys - 6,
        'text-anchor': 'middle',
        'font-size': 7.5,
        'font-family': 'var(--mono)',
        fill: 'var(--stempel)',
      });
      tekst.textContent = dzien.date.slice(5).replace('-', '.');
      svg.append(tekst);
    }
  });
  svg.append(svgEl('line', { x1: 0, y1: dol + 1, x2: traffic.length * szer, y2: dol + 1, stroke: 'var(--linia-2)', 'stroke-width': 1 }));
  return svg;
}

function naklejkaStanu(tekst, wlaczone, { klasaOn = 'naklejka-ok', klasaOff = '' } = {}) {
  return el('span', { class: `naklejka ${wlaczone ? klasaOn : klasaOff}` }, tekst);
}

export function initPulpit() {
  const kontener = document.querySelector('[data-widok="pulpit"]');

  async function pokaz() {
    let dane;
    try {
      dane = await api.statystyki();
    } catch (blad) {
      return toast(blad.message, { blad: true });
    }

    const { users, messages, storage, sessions, aliases, teams, traffic, server, gateway } = dane;

    kontener.replaceChildren(
      el('div', { class: 'sekcja-naglowek' },
        el('h1', {}, 'Pulpit'),
        el('div', { class: 'prawa' },
          el('button', { class: 'btn-drugi', onclick: pokaz }, 'Odśwież')
        )
      ),

      el('div', { class: 'kafle' },
        kafel('Konta', users.total, `${users.admins} adm. · ${users.blocked} zabl.`),
        kafel('Wiadomości', messages.total, 'we wszystkich skrzynkach'),
        kafel('Zajętość', formatujRozmiar(storage.bytes), `w tym załączniki ${formatujRozmiar(storage.attachments)}`),
        kafel('Aktywne sesje', sessions.active, 'zalogowane urządzenia'),
        kafel('Aliasy', aliases, 'dodatkowe adresy'),
        kafel('Zespoły', teams, 'skrzynki funkcyjne')
      ),

      el('div', { class: 'karta' },
        el('div', { class: 'karta-naglowek' }, el('h2', {}, 'Ruch pocztowy · 14 dni')),
        el('div', { class: 'karta-tresc wykres' },
          wykresRuchu(traffic),
          el('div', { class: 'wykres-legenda' },
            el('span', {}, el('i', { style: 'background: var(--priorytet)' }), 'Odebrane'),
            el('span', {}, el('i', { style: 'background: var(--polecony)' }), 'Wysłane')
          )
        )
      ),

      el('div', { class: 'karta' },
        el('div', { class: 'karta-naglowek' }, el('h2', {}, 'Bramki i usługi')),
        el('div', { class: 'karta-tresc konto-rzad' },
          el('span', { class: 'naklejka' }, `Domena · ${gateway.domain}`),
          naklejkaStanu(gateway.smtp ? 'SMTP przychodzący · WŁ' : 'SMTP przychodzący · WYŁ', gateway.smtp),
          naklejkaStanu(gateway.external ? 'Wysyłka na zewnątrz · WŁ' : 'Wysyłka na zewnątrz · WYŁ', gateway.external),
          naklejkaStanu(gateway.dkim ? 'DKIM · podpisujemy' : 'DKIM · brak klucza', gateway.dkim, { klasaOff: 'naklejka-uwaga' }),
          naklejkaStanu(gateway.registration ? 'Rejestracja · otwarta' : 'Rejestracja · zamknięta', gateway.registration, { klasaOn: '', klasaOff: 'naklejka-uwaga' }),
          gateway.smtp_route ? el('span', { class: 'naklejka' }, `Smarthost · ${gateway.smtp_route}`) : null
        )
      ),

      el('div', { class: 'karta' },
        el('div', { class: 'karta-naglowek' }, el('h2', {}, 'Serwer')),
        el('div', { class: 'karta-tresc' },
          el('dl', { class: 'definicje' },
            el('dt', {}, 'Działa od'), el('dd', { class: 'mono' }, uptimeSlownie(server.uptime)),
            el('dt', {}, 'Pamięć (RSS)'), el('dd', { class: 'mono' }, formatujRozmiar(server.rss)),
            el('dt', {}, 'Node.js'), el('dd', { class: 'mono' }, server.node),
            el('dt', {}, 'Rozmiar bazy'), el('dd', { class: 'mono' }, server.db_size == null ? '—' : formatujRozmiar(server.db_size))
          )
        )
      )
    );
  }

  return { pokaz };
}
