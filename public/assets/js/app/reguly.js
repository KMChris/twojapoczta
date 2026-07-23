// TwojaPoczta · reguły wiadomości: kreator w panelu filtrów i sekcja w Ustawieniach.
//
// Kreator to drugi krok panelu filtrów (jak w Gmailu): kryteria zostają w polach
// kroku pierwszego, tu dochodzą akcje. Zapis idzie przez /api/rules; dopasowaniem
// zajmuje się wyłącznie serwer — klient nigdy nie porównuje pól wiadomości.

import { api } from './api.js';
import { el, toast } from './ui.js';

// Klocki opisu po polsku: kreator skleja z nich zdanie, a lista w Ustawieniach
// rozkłada na znaczniki „jeśli / to". Jedno źródło, żeby opisy się nie rozjechały.
// `nazwy` = { wbudowane: {inbox: 'Odebrane', …}, folderu: (id) => nazwa }.
export function opisWarunkow(criteria, nazwy) {
  const czesci = [];
  if (criteria.from) czesci.push(`od „${criteria.from}"`);
  if (criteria.to) czesci.push(`do „${criteria.to}"`);
  if (criteria.subject) czesci.push(`temat zawiera „${criteria.subject}"`);
  if (criteria.has) czesci.push(`zawiera „${criteria.has}"`);
  if (criteria.hasNot) czesci.push(`nie zawiera „${criteria.hasNot}"`);
  if (criteria.dateFrom) czesci.push(`od ${criteria.dateFrom}`);
  if (criteria.dateTo) czesci.push(`do ${criteria.dateTo}`);
  if (criteria.folder) czesci.push(`w folderze ${nazwy.wbudowane[criteria.folder] ?? criteria.folder}`);
  if (criteria.folderId) czesci.push(`w folderze „${nazwy.folderu(criteria.folderId)}"`);
  if (criteria.hasAttachment) czesci.push('ma załącznik');
  return czesci;
}

export function opisSkutkow(actions, nazwy) {
  const skutki = [];
  if (actions.delete) skutki.push('usuń');
  if (actions.moveTo) skutki.push(`przenieś do „${nazwy.folderu(actions.moveTo)}"`);
  if (actions.archive) skutki.push('archiwizuj');
  if (actions.markRead) skutki.push('oznacz jako przeczytane');
  if (actions.star) skutki.push('oznacz gwiazdką');
  if (actions.forwardTo) skutki.push(`przekaż na ${actions.forwardTo}`);
  if (actions.neverSpam) skutki.push('nigdy nie do spamu');
  if (actions.priority === 'always') skutki.push('zawsze priorytet');
  if (actions.priority === 'never') skutki.push('nigdy priorytet');
  return skutki;
}

export function podsumowaniePL(criteria, actions, nazwy) {
  return `Jeśli ${opisWarunkow(criteria, nazwy).join(' i ')} → ${opisSkutkow(actions, nazwy).join(', ')}`;
}

export function initReguly(app, foldery, filtry) {
  const panel = document.querySelector('[data-panel-filtrow]');
  const krokAkcji = panel.querySelector('[data-krok-akcji]');
  const opisKryteriow = panel.querySelector('[data-reguly-kryteria]');
  const selectCelu = panel.querySelector('[data-regula-folder]');
  const listaEl = document.querySelector('[data-reguly]');
  const brakEl = document.querySelector('[data-reguly-brak]');

  let kryteriaKreatora = null;
  let reguly = [];

  const nazwy = {
    wbudowane: app.nazwyFolderow,
    folderu: (id) => foldery.foldery().find((f) => f.id === id)?.name ?? `folder #${id}`,
  };

  // --- Kreator (krok akcji w panelu filtrów) ---------------------------------

  function otworzKrokAkcji() {
    const kryteria = filtry.zbierzKryteria();
    if (!Object.keys(kryteria).length) {
      toast('Ustaw przynajmniej jeden filtr.', { blad: true });
      return;
    }
    kryteriaKreatora = kryteria;
    // Sam warunek, bez strzałki: akcje dopiero powstaną.
    opisKryteriow.textContent = podsumowaniePL(kryteria, {}, nazwy).replace(/ → $/, '');
    selectCelu.replaceChildren(new Option('Nie przenoś', ''));
    for (const wlasny of foldery.foldery()) {
      selectCelu.append(new Option(wlasny.name, String(wlasny.id)));
    }
    filtry.pokazKrok('akcje');
  }

  function zbierzAkcje() {
    const akcje = {};
    if (panel.akcja_archive.checked) akcje.archive = true;
    if (panel.akcja_markread.checked) akcje.markRead = true;
    if (panel.akcja_star.checked) akcje.star = true;
    if (panel.akcja_delete.checked) akcje.delete = true;
    if (panel.akcja_neverspam.checked) akcje.neverSpam = true;
    if (selectCelu.value) akcje.moveTo = Number(selectCelu.value);
    if (panel.akcja_priority.value) akcje.priority = panel.akcja_priority.value;
    if (panel.akcja_forwardto.value.trim()) akcje.forwardTo = panel.akcja_forwardto.value.trim();
    return akcje;
  }

  panel.addEventListener('submit', async (e) => {
    if (krokAkcji.hidden) return; // krok filtrów obsługuje filtry.js
    e.preventDefault();
    const akcje = zbierzAkcje();
    if (!Object.keys(akcje).length) {
      toast('Zaznacz przynajmniej jedną akcję.', { blad: true });
      return;
    }
    try {
      const { applied } = await api.dodajRegule({
        name: panel.regula_nazwa.value.trim(),
        criteria: kryteriaKreatora,
        actions: akcje,
        applyExisting: panel.regula_wstecz_zastosuj.checked,
      });
      panel.hidePopover();
      toast(
        applied != null ? `Utworzono regułę · objęła ${applied} ${wiadomosciWord(applied)}` : 'Utworzono regułę',
        { ikonaNazwa: 'filtr' }
      );
      if (applied) {
        app.odswiezListe();
        app.odswiezLiczniki();
      }
    } catch (blad) {
      toast(blad.message, { blad: true });
    }
  });

  document.querySelector('[data-akcja="utworz-regule"]').addEventListener('click', otworzKrokAkcji);
  document.querySelector('[data-akcja="regula-wstecz"]').addEventListener('click', () => filtry.pokazKrok('filtry'));

  // --- Sekcja w Ustawieniach --------------------------------------------------

  function renderuj() {
    listaEl.replaceChildren();
    brakEl.hidden = reguly.length > 0;
    reguly.forEach((regula, i) => {
      const przelacznik = el('input', {
        type: 'checkbox',
        'aria-label': regula.is_active ? 'Wyłącz regułę' : 'Włącz regułę',
        onchange: async (e) => {
          try {
            await zmien(regula.id, { is_active: e.target.checked ? 1 : 0 });
          } catch (blad) {
            e.target.checked = !e.target.checked;
            toast(blad.message, { blad: true });
          }
        },
      });
      przelacznik.checked = !!regula.is_active;

      listaEl.append(el(
        'li',
        { class: `regula${regula.is_active ? '' : ' wylaczona'}` },
        el('label', { class: 'regula-aktywnosc' }, przelacznik),
        el(
          'div',
          { class: 'regula-opis' },
          regula.name ? el('strong', { class: 'regula-nazwa' }, regula.name) : null,
          el(
            'span',
            { class: 'regula-wiersz' },
            el('span', { class: 'regula-etykieta' }, 'jeśli'),
            el('span', { class: 'regula-znaczniki' },
              ...opisWarunkow(regula.criteria, nazwy).map((czesc) => el('span', { class: 'regula-znacznik' }, czesc)))
          ),
          el(
            'span',
            { class: 'regula-wiersz' },
            el('span', { class: 'regula-etykieta' }, 'to'),
            el('span', { class: 'regula-znaczniki' },
              ...opisSkutkow(regula.actions, nazwy).map((skutek) => el('span', { class: 'regula-znacznik' }, skutek)))
          )
        ),
        el(
          'span',
          { class: 'regula-akcje-listy' },
          przycisk('↑', 'Wyżej', i === 0, () => zmien(regula.id, { move: 'up' })),
          przycisk('↓', 'Niżej', i === reguly.length - 1, () => zmien(regula.id, { move: 'down' })),
          przycisk('✕', 'Usuń regułę', false, async () => {
            const { rules } = await api.usunRegule(regula.id);
            reguly = rules;
            renderuj();
            toast('Usunięto regułę', { ikonaNazwa: 'filtr' });
          })
        )
      ));
    });
  }

  function przycisk(znak, tytul, wylaczony, akcja) {
    return el(
      'button',
      {
        type: 'button',
        class: 'regula-przycisk',
        'data-dymek': tytul,
        'aria-label': tytul,
        disabled: wylaczony || null,
        onclick: async () => {
          try {
            await akcja();
          } catch (blad) {
            toast(blad.message, { blad: true });
          }
        },
      },
      znak
    );
  }

  async function zmien(id, dane) {
    const { rules } = await api.zmienRegule(id, dane);
    reguly = rules;
    renderuj();
  }

  async function odswiez() {
    try {
      const { rules } = await api.reguly();
      reguly = rules;
      renderuj();
    } catch {
      /* sekcja zostaje z poprzednią listą */
    }
  }

  return { odswiez };
}

// Polska odmiana jak w foldery.js: wyjątek tylko dla jedynki.
function wiadomosciWord(n) {
  return n === 1 ? 'wiadomość' : 'wiadomości';
}
