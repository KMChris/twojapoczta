// TwojaPoczta · panel filtrów pod polem wyszukiwania.
//
// Panel to popover (top layer; Esc i klik obok zamykają go za darmo), nie modal:
// filtry ustawia się patrząc na listę wyników. Pozycję pod polem liczymy sami,
// bo CSS anchor positioning nie jest jeszcze Baseline (modern-web-guidance,
// 2026-07), a polyfille odpadają — zero zależności.

import { toast } from './ui.js';

const panel = document.querySelector('[data-panel-filtrow]');
const przycisk = document.querySelector('[data-akcja="filtry"]');
const szukajBox = document.querySelector('.szukaj');
const szukajInput = document.querySelector('[data-szukaj]');
const selectFolderu = document.querySelector('[data-filtry-folder]');

export function initFiltry(app, foldery) {
  function ustawPozycje() {
    const pole = szukajBox.getBoundingClientRect();
    const szerokosc = Math.min(560, window.innerWidth - 16);
    const lewo = Math.min(
      Math.max(8, pole.left + pole.width / 2 - szerokosc / 2),
      window.innerWidth - szerokosc - 8
    );
    panel.style.top = `${pole.bottom + 8}px`;
    panel.style.left = `${lewo}px`;
    panel.style.width = `${szerokosc}px`;
  }

  // Select folderów budujemy przy każdym otwarciu: foldery własne przychodzą
  // i odchodzą, a nazwy wbudowanych nie kolidują z własnymi (walidacja nazw
  // w folders.js tego pilnuje), więc lista nie potrzebuje separatora.
  function odswiezFoldery() {
    const wybrane = selectFolderu.value;
    selectFolderu.replaceChildren(new Option('Wszędzie (poza Koszem i Spamem)', ''));
    for (const [folder, nazwa] of Object.entries(app.nazwyFolderow)) {
      if (folder === 'starred') continue; // gwiazdka to widok, nie folder
      selectFolderu.append(new Option(nazwa, folder));
    }
    for (const wlasny of foldery.foldery()) {
      selectFolderu.append(new Option(wlasny.name, String(wlasny.id)));
    }
    selectFolderu.value = wybrane;
    if (selectFolderu.selectedIndex === -1) selectFolderu.value = '';
  }

  // Klucze wynikowe = kształt kryteriów ze specu (ten sam JSON pojedzie w fazie 3
  // do reguł). Wartość selecta: liczba to folder własny, reszta to wbudowany.
  function zbierz() {
    const kryteria = {};
    const tekst = (nazwa) => panel[nazwa].value.trim();
    if (tekst('od')) kryteria.from = tekst('od');
    if (tekst('do')) kryteria.to = tekst('do');
    if (tekst('temat')) kryteria.subject = tekst('temat');
    if (tekst('zawiera')) kryteria.has = tekst('zawiera');
    if (tekst('nie_zawiera')) kryteria.hasNot = tekst('nie_zawiera');
    if (panel.data_od.value) kryteria.dateFrom = panel.data_od.value;
    if (panel.data_do.value) kryteria.dateTo = panel.data_do.value;
    if (panel.zalacznik.checked) kryteria.hasAttachment = true;
    const folder = selectFolderu.value;
    if (/^\d+$/.test(folder)) kryteria.folderId = Number(folder);
    else if (folder) kryteria.folder = folder;
    return kryteria;
  }

  function wyczyscTryb() {
    app.stan.kryteria = null;
    przycisk.classList.remove('aktywny');
  }

  function otworz() {
    if (!panel.matches(':popover-open')) panel.showPopover();
  }

  panel.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    ustawPozycje();
    odswiezFoldery();
    // Panel doprecyzowuje szukanie: puste „Zawiera" przejmuje tekst z pola.
    if (!panel.zawiera.value && szukajInput.value.trim()) {
      panel.zawiera.value = szukajInput.value.trim();
    }
  });

  window.addEventListener('resize', () => {
    if (panel.matches(':popover-open')) ustawPozycje();
  });

  panel.addEventListener('submit', (e) => {
    e.preventDefault();
    const kryteria = zbierz();
    if (!Object.keys(kryteria).length) {
      toast('Ustaw przynajmniej jeden filtr.', { blad: true });
      return;
    }
    if (kryteria.dateFrom && kryteria.dateTo && kryteria.dateFrom > kryteria.dateTo) {
      toast('Zakres dat jest odwrócony.', { blad: true });
      return;
    }
    przycisk.classList.add('aktywny');
    panel.hidePopover();
    app.szukajKryteriami(kryteria);
  });

  // „Wyczyść" zdejmuje filtry i zeruje pola, ale zostawia panel otwarty:
  // to przełącznik, nie droga w jedną stronę.
  document.querySelector('[data-akcja="wyczysc-filtry"]').addEventListener('click', () => {
    panel.reset();
    if (app.stan.kryteria) {
      wyczyscTryb();
      app.odswiezTytul();
      app.odswiezListe();
    }
  });

  return { otworz, wyczyscTryb };
}
