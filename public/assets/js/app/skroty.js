// Skróty klawiszowe i paleta poleceń (Ctrl+K).

import { el, ikona, bezOgonkow } from './ui.js';

export function initSkroty(app, kompozycja) {
  const paleta = document.querySelector('[data-paleta]');
  const paletaInput = document.querySelector('[data-paleta-input]');
  const paletaLista = document.querySelector('[data-paleta-lista]');

  // --- Paleta poleceń -------------------------------------------------------

  const polecenia = [
    { tytul: 'Napisz wiadomość', ikona: 'pen', skrot: 'c', wykonaj: () => app.napisz() },
    { tytul: 'Odebrane', ikona: 'inbox', skrot: 'g i', wykonaj: () => app.przejdzDoFolderu('inbox') },
    { tytul: 'Z gwiazdką', ikona: 'star', wykonaj: () => app.przejdzDoFolderu('starred') },
    { tytul: 'Wysłane', ikona: 'send', skrot: 'g s', wykonaj: () => app.przejdzDoFolderu('sent') },
    { tytul: 'Zaplanowane', ikona: 'clock', wykonaj: () => app.przejdzDoFolderu('scheduled') },
    { tytul: 'Wersje robocze', ikona: 'draft', wykonaj: () => app.przejdzDoFolderu('drafts') },
    { tytul: 'Archiwum', ikona: 'archive', wykonaj: () => app.przejdzDoFolderu('archive') },
    { tytul: 'Spam', ikona: 'spam', wykonaj: () => app.przejdzDoFolderu('spam') },
    { tytul: 'Kosz', ikona: 'trash', wykonaj: () => app.przejdzDoFolderu('trash') },
    { tytul: 'Szukaj w poczcie', ikona: 'search', skrot: '/', wykonaj: () => app.fokusSzukaj() },
    { tytul: 'Odśwież listę', ikona: 'refresh', wykonaj: () => app.odswiezListe() },
    { tytul: 'Motyw: jasny', ikona: 'ustawienia', wykonaj: () => app.ustawMotyw('light', { zapisz: true }) },
    { tytul: 'Motyw: nocna sortownia', ikona: 'ustawienia', wykonaj: () => app.ustawMotyw('dark', { zapisz: true }) },
    { tytul: 'Motyw: jak system', ikona: 'ustawienia', wykonaj: () => app.ustawMotyw('system', { zapisz: true }) },
    { tytul: 'Ustawienia konta', ikona: 'ustawienia', wykonaj: () => app.otworzUstawienia() },
    { tytul: 'Skróty klawiszowe', ikona: 'menu', skrot: '?', wykonaj: () => app.otworzPomoc() },
    { tytul: 'Wyloguj się', ikona: 'back', wykonaj: () => app.wyloguj() },
  ];

  let widoczne = [];
  let zaznaczenie = 0;

  function renderujPalete(zapytanie) {
    const q = bezOgonkow(zapytanie.trim());
    widoczne = q ? polecenia.filter((p) => bezOgonkow(p.tytul).includes(q)) : polecenia;
    zaznaczenie = 0;
    paletaLista.replaceChildren();
    if (!widoczne.length) {
      paletaLista.append(el('li', { class: 'paleta-pusta' }, `Nic nie pasuje do „${zapytanie.trim()}”.`));
      return;
    }
    widoczne.forEach((polecenie, i) => {
      const li = el(
        'li',
        {
          class: `paleta-pozycja${i === zaznaczenie ? ' zaznaczona' : ''}`,
          role: 'option',
          onclick: () => wykonaj(polecenie),
          onmousemove: () => {
            if (zaznaczenie === i) return;
            zaznaczenie = i;
            odswiezZaznaczenie();
          },
        },
        ikona(polecenie.ikona),
        polecenie.tytul
      );
      if (polecenie.skrot) li.append(el('kbd', {}, polecenie.skrot));
      paletaLista.append(li);
    });
  }

  function odswiezZaznaczenie() {
    paletaLista.querySelectorAll('.paleta-pozycja').forEach((li, i) => {
      li.classList.toggle('zaznaczona', i === zaznaczenie);
      if (i === zaznaczenie) li.scrollIntoView({ block: 'nearest' });
    });
  }

  function wykonaj(polecenie) {
    paleta.close();
    polecenie.wykonaj();
  }

  function otworzPalete() {
    if (paleta.open) return;
    paleta.showModal();
    paletaInput.value = '';
    renderujPalete('');
    paletaInput.focus();
  }

  paletaInput.addEventListener('input', () => renderujPalete(paletaInput.value));
  paletaInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const krok = e.key === 'ArrowDown' ? 1 : -1;
      zaznaczenie = (zaznaczenie + krok + widoczne.length) % Math.max(widoczne.length, 1);
      odswiezZaznaczenie();
    } else if (e.key === 'Enter' && widoczne[zaznaczenie]) {
      e.preventDefault();
      wykonaj(widoczne[zaznaczenie]);
    }
  });

  document.querySelector('[data-akcja="paleta"]').addEventListener('click', otworzPalete);

  // --- Klawisze globalne ------------------------------------------------------

  let oczekujeG = false;
  let zegarG = null;

  document.addEventListener('keydown', (e) => {
    // Ctrl+K działa zawsze.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      otworzPalete();
      return;
    }

    // Ctrl+Enter wysyła z okna kompozycji.
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && kompozycja.otwarte()) {
      document.querySelector('[data-formularz-kompozycji]').requestSubmit();
      return;
    }

    const cel = e.target;
    const wPolu =
      cel instanceof HTMLInputElement ||
      cel instanceof HTMLTextAreaElement ||
      cel instanceof HTMLSelectElement ||
      cel.isContentEditable;

    // Przycisk i odnośnik same obsługują Enter i spację — przeglądarka zamienia je na
    // kliknięcie. Skrót globalny zdublowałby więc jedno naciśnięcie na dwie akcje i to
    // on wygrywa: `Enter` → otworzZaznaczona() przerenderowuje czytnik i kasuje efekt
    // kliknięcia (belka „Pokaż obrazki" odparkowywała obrazki i natychmiast parkowała
    // je z powrotem). Osobny warunek, a nie poszerzenie `wPolu`, bo `wPolu` steruje też
    // gałęzią `Escape` (cel.blur()), a przycisk nie jest polem tekstowym i nie ma się
    // rozmywać. `Escape` celowo zostaje poza tym wyjątkiem — jest obsłużone niżej, ale
    // PRZED wczesnym powrotem, więc zamykanie czytnika i okien nadal działa wszędzie,
    // także na zafokusowanym przycisku.
    const naPrzycisku = cel instanceof HTMLButtonElement || cel instanceof HTMLAnchorElement;

    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open]')) return; // dialog zamyka się sam
      if (kompozycja.zamknijNakladki()) return; // najpierw dymki i okienko planowania
      if (wPolu && !cel.closest('[data-kompozycja]')) {
        cel.blur();
        return;
      }
      if (kompozycja.otwarte()) {
        kompozycja.zamknij();
        return;
      }
      app.zamknijCzytnik();
      return;
    }

    if (wPolu || naPrzycisku || document.querySelector('dialog[open]')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Otwarta kompozycja blokuje skróty zmieniające stan; szukanie i pomoc mają działać.
    if (kompozycja.otwarte() && e.key !== '/' && e.key !== '?') return;

    // Sekwencja g + litera.
    if (oczekujeG) {
      oczekujeG = false;
      clearTimeout(zegarG);
      if (e.key === 'i') return app.przejdzDoFolderu('inbox');
      if (e.key === 's') return app.przejdzDoFolderu('sent');
      return;
    }

    switch (e.key) {
      case 'c':
        e.preventDefault();
        app.napisz();
        break;
      case '/':
        e.preventDefault();
        app.fokusSzukaj();
        break;
      case 'j':
        app.nastepna();
        break;
      case 'k':
        app.poprzednia();
        break;
      case 'Enter':
        app.otworzZaznaczona();
        break;
      case 'e':
        app.archiwizujOtwarta();
        break;
      case 's':
        app.gwiazdkaOtwarta();
        break;
      case '#':
        app.doKoszaOtwarta();
        break;
      case 'u':
        app.nieprzeczytanaOtwarta();
        break;
      case '?':
        app.otworzPomoc();
        break;
      case 'g':
        oczekujeG = true;
        zegarG = setTimeout(() => (oczekujeG = false), 900);
        break;
    }
  });

  return { otworzPalete };
}
