// TwojaPoczta · zaznaczanie wielu wiadomości: stan, pasek akcji, menu zakresów.
//
// Wejściem jest klik w awatar wiersza (main.js/zbudujWiersz); tu mieszka Set
// zaznaczonych id, pasek nad nagłówkiem listy i menu „Zaznacz…". Przełączenie
// działa w miejscu (klasa + podmiana zawartości awatara), bez przerysowania
// listy — szybkie klikanie nie gubi fokusu ani pozycji przewinięcia.

import { ikona } from './ui.js';

const pasek = document.querySelector('[data-pasek-zaznaczenia]');
const licznik = document.querySelector('[data-zaznaczenie-licznik]');
const przyciskWszystko = document.querySelector('[data-akcja="zaznacz-wszystko"]');
const ikonaWyboru = document.querySelector('[data-zaznacz-ikona]');
const przyciskMenu = document.querySelector('[data-akcja="zaznacz-menu"]');
const menu = document.querySelector('[data-menu-zaznaczania]');
const listaEl = document.querySelector('[data-lista]');

export function initZaznaczanie(app) {
  const zaznaczone = new Set();

  const ma = (id) => zaznaczone.has(id);
  const aktywne = () => zaznaczone.size > 0;

  function odswiezWiersz(id) {
    const wiersz = listaEl.querySelector(`[data-id="${id}"]`);
    if (!wiersz) return;
    const jest = zaznaczone.has(id);
    wiersz.classList.toggle('zaznaczona', jest);
    const aw = wiersz.querySelector('.aw');
    if (!aw) return;
    aw.classList.toggle('zaznaczony', jest);
    aw.setAttribute('aria-checked', String(jest));
    aw.setAttribute('aria-label', jest ? 'Odznacz wiadomość' : 'Zaznacz wiadomość');
    // Inicjały i kolor zostawił zbudujWiersz w dataset — przełącznik nie musi
    // znać wiadomości, żeby przywrócić awatar.
    if (jest) {
      aw.replaceChildren(ikona('check'));
      aw.style.background = 'var(--polecony)';
    } else {
      aw.replaceChildren(aw.dataset.inicjaly ?? '');
      aw.style.background = aw.dataset.kolor ?? '';
    }
  }

  function odswiezPasek() {
    pasek.hidden = !zaznaczone.size;
    if (!zaznaczone.size) {
      if (menu.matches(':popover-open')) menu.hidePopover();
      return;
    }
    licznik.textContent = `Zaznaczono: ${zaznaczone.size}`;
    // Checkbox zbiorczy jak w Gmailu: pełny, gdy zaznaczono cały widok, kreska
    // przy części. Klik dopełnia do wszystkich albo odznacza wszystko — stan
    // „pusty" zdarza się tylko przelotnie, bo pusty zbiór chowa cały pasek.
    const wszystkie = zaznaczone.size === app.stan.wiadomosci.length;
    ikonaWyboru.setAttribute('href', wszystkie ? '#i-zaznacz-pelne' : '#i-zaznacz-czesc');
    przyciskWszystko.setAttribute('aria-checked', wszystkie ? 'true' : 'mixed');
    const tytul = wszystkie ? 'Odznacz wszystkie' : 'Zaznacz wszystkie';
    przyciskWszystko.setAttribute('aria-label', tytul);
    przyciskWszystko.dataset.dymek = tytul;
    // Wersje robocze i zaplanowane: jedyną sensowną akcją zbiorczą jest kosz.
    // Archiwizacja szkicu nic nie znaczy, a zaplanowanej po cichu odwołałaby
    // nadanie (zmiana folderu zeruje scheduled_at). W trybie kryteriów widok
    // bywa mieszany, więc zestaw zostaje pełny.
    const tylkoKosz =
      !app.stan.kryteria && (app.stan.folder === 'drafts' || app.stan.folder === 'scheduled');
    for (const przycisk of pasek.querySelectorAll('[data-zaznacz-akcja]')) {
      przycisk.hidden = tylkoKosz && przycisk.dataset.zaznaczAkcja !== 'kosz';
    }
  }

  function przelacz(id) {
    if (zaznaczone.has(id)) zaznaczone.delete(id);
    else zaznaczone.add(id);
    odswiezWiersz(id);
    odswiezPasek();
  }

  // Zwraca, czy było co czyścić — skrót Esc rozstrzyga tym, czy skonsumował klawisz.
  function wyczysc() {
    if (!zaznaczone.size) return false;
    const bylo = [...zaznaczone];
    zaznaczone.clear();
    for (const id of bylo) odswiezWiersz(id);
    odswiezPasek();
    return true;
  }

  // Po odświeżeniu listy zostają tylko id wciąż obecne. Wołane PRZED budową
  // wierszy (renderujListe), więc DOM-u nie dotyka — zbudujWiersz sam nada
  // klasy temu, co przetrwało.
  function przytnij() {
    if (!zaznaczone.size) return;
    const obecne = new Set(app.stan.wiadomosci.map((w) => w.id));
    for (const id of [...zaznaczone]) {
      if (!obecne.has(id)) zaznaczone.delete(id);
    }
    odswiezPasek();
  }

  // --- Menu zakresów --------------------------------------------------------

  const ZAKRESY = {
    wszystkie: () => true,
    zadne: () => false,
    przeczytane: (w) => w.is_read,
    nieprzeczytane: (w) => !w.is_read,
    gwiazdka: (w) => w.is_starred,
    'bez-gwiazdki': (w) => !w.is_starred,
  };

  // Wybór z menu ZASTĘPUJE zaznaczenie (jak w Gmailu) i działa na bieżącym
  // widoku listy — czyli na aktualnych filtrach, do limitu listy.
  function ustawZakres(nazwa) {
    zaznaczone.clear();
    for (const w of app.stan.wiadomosci) {
      if (ZAKRESY[nazwa](w)) zaznaczone.add(w.id);
    }
    for (const wiersz of listaEl.querySelectorAll('.wiadomosc')) {
      odswiezWiersz(Number(wiersz.dataset.id));
    }
    odswiezPasek();
  }

  for (const pozycja of menu.querySelectorAll('[data-zaznacz-zakres]')) {
    pozycja.addEventListener('click', () => {
      ustawZakres(pozycja.dataset.zaznaczZakres);
      menu.hidePopover();
    });
  }

  przyciskWszystko.addEventListener('click', () => {
    const wszystkie = zaznaczone.size === app.stan.wiadomosci.length;
    ustawZakres(wszystkie ? 'zadne' : 'wszystkie');
  });

  // Popover ląduje w warstwie wierzchniej z position:fixed — pozycję pod
  // przyciskiem liczymy sami, jak panel filtrów (anchor positioning nie jest
  // jeszcze Baseline).
  menu.addEventListener('toggle', (e) => {
    if (e.newState !== 'open') return;
    const r = przyciskMenu.getBoundingClientRect();
    const szerokosc = menu.offsetWidth || 208;
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.left = `${Math.min(Math.max(8, r.left), window.innerWidth - szerokosc - 8)}px`;
  });

  return { ma, przelacz, wyczysc, przytnij, aktywne, odswiezPasek };
}
