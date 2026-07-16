// TwojaPoczta · foldery użytkownika w panelu bocznym.
// Widok i CRUD. Nawigację prowadzi main.js — tutaj tylko lista, okno i akcje.

import { api } from './api.js';
import { el, ikona, toast } from './ui.js';

const listaEl = document.querySelector('[data-foldery-wlasne]');
const okno = document.querySelector('[data-folder-okno]');
const formularz = document.querySelector('[data-formularz-folderu]');
const tytulOkna = document.querySelector('[data-folder-tytul]');
const opisOkna = document.querySelector('[data-folder-opis]');
const przyciskZapisz = document.querySelector('[data-folder-zapisz]');
const przyciskUsun = document.querySelector('[data-akcja="usun-folder"]');
const przeniesOkno = document.querySelector('[data-przenies-okno]');
const przeniesLista = document.querySelector('[data-przenies-lista]');

export function initFoldery(app) {
  // edytowany === null znaczy „okno tworzy nowy folder".
  const stan = { foldery: [], edytowany: null };

  function nazwa(id) {
    return stan.foldery.find((f) => f.id === id)?.name ?? 'Folder';
  }

  function renderuj() {
    listaEl.replaceChildren();
    for (const f of stan.foldery) {
      const nieprzeczytane = app.stan.liczniki.custom?.[f.id] ?? 0;
      const licznik = el('em', {}, nieprzeczytane || '');
      licznik.hidden = !nieprzeczytane;

      listaEl.append(
        el(
          'button',
          {
            class: 'folder' + (app.stan.folderId === f.id ? ' aktywny' : ''),
            dataset: { folder: 'custom', folderId: f.id },
            onclick: () => app.przejdzDoFolderu('custom', { folderId: f.id }),
          },
          ikona('folder'),
          el('span', { class: 'folder-nazwa' }, f.name),
          licznik,
          el(
            'span',
            {
              class: 'folder-edytuj',
              role: 'button',
              tabindex: '0',
              title: `Zmień nazwę albo usuń „${f.name}"`,
              'aria-label': `Zmień nazwę albo usuń „${f.name}"`,
              onclick: (e) => {
                e.stopPropagation();
                otworzEdycje(f);
              },
            },
            ikona('wiecej')
          )
        )
      );
    }
  }

  async function odswiez() {
    try {
      const { folders } = await api.foldery();
      stan.foldery = folders;
      renderuj();
    } catch {
      /* panel boczny zostaje z poprzednią listą */
    }
  }

  function otworzNowy() {
    stan.edytowany = null;
    tytulOkna.textContent = 'Nowy folder';
    przyciskZapisz.textContent = 'Utwórz';
    przyciskUsun.hidden = true;
    opisOkna.hidden = true;
    formularz.nazwa.value = '';
    okno.showModal();
    formularz.nazwa.focus();
  }

  function otworzEdycje(folder) {
    stan.edytowany = folder;
    tytulOkna.textContent = 'Folder';
    przyciskZapisz.textContent = 'Zapisz';
    przyciskUsun.hidden = false;
    // Liczba mówi wprost, o co toczy się gra przy usuwaniu.
    opisOkna.hidden = false;
    opisOkna.textContent = folder.count
      ? `Usunięcie folderu przeniesie ${folder.count} ${wiadomosciWord(folder.count)} do Archiwum. Nic nie przepadnie.`
      : 'Folder jest pusty.';
    formularz.nazwa.value = folder.name;
    okno.showModal();
    formularz.nazwa.select();
  }

  formularz.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nowaNazwa = formularz.nazwa.value.trim();
    if (!nowaNazwa) return formularz.nazwa.focus();
    try {
      const { folders } = stan.edytowany
        ? await api.zmienNazweFolderu(stan.edytowany.id, nowaNazwa)
        : await api.dodajFolder(nowaNazwa);
      stan.foldery = folders;
      renderuj();
      okno.close();
      toast(stan.edytowany ? 'Zmieniono nazwę folderu' : 'Utworzono folder', { ikonaNazwa: 'folder' });
      // Tytuł listy trzyma starą nazwę, jeśli patrzymy właśnie na ten folder.
      if (app.stan.folder === 'custom') app.odswiezTytul();
    } catch (blad) {
      toast(blad.message, { blad: true });
    }
  });

  przyciskUsun.addEventListener('click', async () => {
    const folder = stan.edytowany;
    if (!folder) return;
    try {
      const { folders, moved } = await api.usunFolder(folder.id);
      stan.foldery = folders;
      okno.close();
      toast(
        moved
          ? `Usunięto folder · ${moved} ${wiadomosciWord(moved)} w Archiwum`
          : 'Usunięto folder',
        { ikonaNazwa: 'archive' }
      );
      // Patrzyliśmy właśnie na skasowany folder: idziemy tam, gdzie trafiła poczta.
      if (app.stan.folder === 'custom' && app.stan.folderId === folder.id) {
        app.przejdzDoFolderu(moved ? 'archive' : 'inbox');
      } else {
        renderuj();
      }
    } catch (blad) {
      toast(blad.message, { blad: true });
    }
  });

  document.querySelector('[data-akcja="nowy-folder"]').addEventListener('click', otworzNowy);

  // Zwraca id wybranego folderu albo null. pomijId wycina folder, w którym
  // wiadomość już leży — przenoszenie do samego siebie nie ma sensu.
  function wybierzFolder(pomijId = null) {
    return new Promise((rozwiaz) => {
      // Okno zamyka się też Esc i kliknięciem w tło, więc wynik zbieramy
      // w zdarzeniu 'close', a nie w onclick pozycji.
      let wybrany = null;
      const dostepne = stan.foldery.filter((f) => f.id !== pomijId);
      przeniesLista.replaceChildren();

      if (!dostepne.length) {
        przeniesLista.append(
          el('p', { class: 'aliasy-brak' }, 'Nie masz jeszcze żadnego folderu.'),
          el(
            'button',
            {
              type: 'button',
              class: 'btn-zapisz',
              onclick: () => {
                przeniesOkno.close();
                otworzNowy();
              },
            },
            'Utwórz folder'
          )
        );
      }

      for (const f of dostepne) {
        przeniesLista.append(
          el(
            'button',
            {
              type: 'button',
              class: 'przenies-pozycja',
              onclick: () => {
                wybrany = f.id;
                przeniesOkno.close();
              },
            },
            ikona('folder'),
            el('span', {}, f.name)
          )
        );
      }

      przeniesOkno.addEventListener('close', () => rozwiaz(wybrany), { once: true });
      przeniesOkno.showModal();
    });
  }

  return { odswiez, renderuj, nazwa, foldery: () => stan.foldery, otworzNowy, wybierzFolder };
}

// Polska odmiana: 1 wiadomość, 2–4 wiadomości, 5+ wiadomości. Dopełniacz i tak
// wychodzi „wiadomości", więc wyjątek jest tylko dla jedynki.
function wiadomosciWord(n) {
  return n === 1 ? 'wiadomość' : 'wiadomości';
}
