// TwojaPoczta · zaznaczanie wielu wiadomości: stan, pasek akcji, menu zakresów.
//
// Wejściem jest klik w awatar wiersza (main.js/zbudujWiersz); tu mieszka Set
// zaznaczonych id, pasek nad nagłówkiem listy i menu „Zaznacz…". Przełączenie
// działa w miejscu (klasa + podmiana zawartości awatara), bez przerysowania
// listy — szybkie klikanie nie gubi fokusu ani pozycji przewinięcia.

import { api } from './api.js';
import { ikona, toast } from './ui.js';

const pasek = document.querySelector('[data-pasek-zaznaczenia]');
const licznik = document.querySelector('[data-zaznaczenie-licznik]');
const przyciskWszystko = document.querySelector('[data-akcja="zaznacz-wszystko"]');
const ikonaWyboru = document.querySelector('[data-zaznacz-ikona]');
const przyciskMenu = document.querySelector('[data-akcja="zaznacz-menu"]');
const menu = document.querySelector('[data-menu-zaznaczania]');
const listaEl = document.querySelector('[data-lista]');
const przyciskSpam = document.querySelector('[data-przycisk-spam]');
const ikonaSpam = przyciskSpam.querySelector('use');

export function initZaznaczanie(app, foldery) {
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
    // W Spamie „Zgłoś spam" nie ma sensu (poczta już tam jest) — przycisk staje
    // się „To nie spam" i odsyła do Odebranych, jak w czytniku pojedynczej
    // wiadomości. W trybie kryteriów widok bywa mieszany, więc zostaje spam.
    const wSpamie = !app.stan.kryteria && app.stan.folder === 'spam';
    przyciskSpam.dataset.zaznaczAkcja = wSpamie ? 'nie-spam' : 'spam';
    ikonaSpam.setAttribute('href', wSpamie ? '#i-inbox' : '#i-spam');
    const tytulSpam = wSpamie ? 'To nie spam' : 'Zgłoś spam';
    przyciskSpam.dataset.dymek = tytulSpam;
    przyciskSpam.setAttribute(
      'aria-label',
      wSpamie ? 'Przenieś zaznaczone do Odebranych' : 'Zgłoś zaznaczone jako spam'
    );

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

  // --- Akcje zbiorcze -------------------------------------------------------

  // Migawka (folder, folder_id) sprzed akcji — „Cofnij" odsyła każdą wiadomość
  // tam, skąd wyszła, także gdy widok mieszał foldery (gwiazdka, wyniki).
  function migawka(zbior) {
    return app.stan.wiadomosci
      .filter((w) => zbior.has(w.id))
      .map((w) => ({ id: w.id, folder: w.folder, folder_id: w.folder_id ?? null }));
  }

  async function cofnijGrupami(przed) {
    const grupy = new Map();
    for (const w of przed) {
      const klucz = `${w.folder}|${w.folder_id ?? ''}`;
      if (!grupy.has(klucz)) grupy.set(klucz, { ...w, ids: [] });
      grupy.get(klucz).ids.push(w.id);
    }
    try {
      for (const grupa of grupy.values()) {
        await api.zmienWiele(
          grupa.ids,
          grupa.folder === 'custom' && grupa.folder_id
            ? { folder_id: grupa.folder_id }
            : { folder: grupa.folder }
        );
      }
      toast('Przywrócono', { ikonaNazwa: 'inbox' });
    } catch (blad) {
      toast(blad.message, { blad: true });
    }
    app.odswiezListe({ cicho: true });
    app.odswiezLiczniki();
  }

  // Po udanej akcji: zaznaczenie znika (jak w Gmailu), lista i liczniki jadą
  // z serwera. Czytnik zamykamy tylko, gdy akcja objęła otwartą wiadomość.
  function poAkcji(zbior, { zamknij = true } = {}) {
    const otwartaWSrod = app.stan.otwarta && zbior.has(app.stan.otwarta.id);
    wyczysc();
    if (zamknij && otwartaWSrod) app.zamknijCzytnik();
    app.odswiezListe({ cicho: true });
    app.odswiezLiczniki();
  }

  function wiadomosciWord(n) {
    return n === 1 ? 'wiadomość' : 'wiadomości';
  }

  async function wykonajAkcje(akcja) {
    const ids = [...zaznaczone];
    if (!ids.length) return;
    const zbior = new Set(ids);
    const n = ids.length;
    const przed = migawka(zbior);

    try {
      if (akcja === 'archiwum') {
        await api.zmienWiele(ids, { folder: 'archive' });
        toast(`Zarchiwizowano ${n} ${wiadomosciWord(n)}`, {
          ikonaNazwa: 'archive',
          cofnij: () => cofnijGrupami(przed),
        });
        poAkcji(zbior);
      } else if (akcja === 'folder') {
        const cel = await foldery.wybierzFolder(null);
        if (!cel) return;
        await api.zmienWiele(ids, { folder_id: cel });
        toast(`Przeniesiono ${n} ${wiadomosciWord(n)} do „${foldery.nazwa(cel)}”`, {
          ikonaNazwa: 'folder',
          cofnij: () => cofnijGrupami(przed),
        });
        poAkcji(zbior);
      } else if (akcja === 'gwiazdka') {
        // Przełącznik, nie droga w jedną stronę: komplet z gwiazdką → zdejmujemy.
        const objete = app.stan.wiadomosci.filter((w) => zbior.has(w.id));
        const nowa = !objete.every((w) => w.is_starred);
        await api.zmienWiele(ids, { is_starred: nowa });
        // „z N wiadomości" jest poprawne dla każdego N (dopełniacz).
        toast(nowa ? `Oznaczono gwiazdką ${n} ${wiadomosciWord(n)}` : `Zdjęto gwiazdkę z ${n} wiadomości`, {
          ikonaNazwa: 'star',
        });
        if (app.stan.otwarta && zbior.has(app.stan.otwarta.id)) app.ustawGwiazdkeOtwartej(nowa);
        poAkcji(zbior, { zamknij: false });
      } else if (akcja === 'nieprzeczytane') {
        await api.zmienWiele(ids, { is_read: false });
        toast(`Oznaczono jako nieprzeczytane · ${n} ${wiadomosciWord(n)}`, { ikonaNazwa: 'unread' });
        poAkcji(zbior);
      } else if (akcja === 'kosz') {
        const wynik = await api.usunWiele(ids);
        // Widok nigdy nie miesza kosza z resztą, więc trwałe usunięcie obejmuje
        // komplet albo nic. Trwałego nie da się cofnąć — nie obiecujemy.
        toast(
          wynik.purged
            ? `Usunięto trwale ${wynik.purged} ${wiadomosciWord(wynik.purged)}`
            : `Przeniesiono do kosza ${n} ${wiadomosciWord(n)}`,
          { ikonaNazwa: 'trash', cofnij: wynik.purged ? null : () => cofnijGrupami(przed) }
        );
        poAkcji(zbior);
      } else if (akcja === 'spam') {
        await api.zmienWiele(ids, { folder: 'spam' });
        toast(`Oznaczono ${n} ${wiadomosciWord(n)} jako spam`, {
          ikonaNazwa: 'spam',
          cofnij: () => cofnijGrupami(przed),
        });
        poAkcji(zbior);
      } else if (akcja === 'nie-spam') {
        // Ten sam przycisk co „spam", ale w widoku Spamu: odsyła do Odebranych.
        await api.zmienWiele(ids, { folder: 'inbox' });
        toast(`Przeniesiono ${n} ${wiadomosciWord(n)} do Odebranych`, {
          ikonaNazwa: 'inbox',
          cofnij: () => cofnijGrupami(przed),
        });
        poAkcji(zbior);
      }
    } catch (blad) {
      // Zaznaczenie zostaje — po błędzie można ponowić bez klikania od nowa.
      toast(blad.message, { blad: true });
    }
  }

  for (const przycisk of pasek.querySelectorAll('[data-zaznacz-akcja]')) {
    przycisk.addEventListener('click', () => wykonajAkcje(przycisk.dataset.zaznaczAkcja));
  }

  return { ma, przelacz, wyczysc, przytnij, aktywne, odswiezPasek };
}
