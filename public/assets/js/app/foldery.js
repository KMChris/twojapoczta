// TwojaPoczta · foldery użytkownika w panelu bocznym.
// Widok i CRUD. Nawigację prowadzi main.js. Tutaj tylko lista, okno i akcje.

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
              'data-dymek': `Zmień nazwę albo usuń „${f.name}”`,
              'aria-label': `Zmień nazwę albo usuń „${f.name}”`,
              onclick: async (e) => {
                e.stopPropagation();
                await otworzEdycje(f);
              },
              onkeydown: (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  otworzEdycje(f);
                }
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

  async function otworzEdycje(folder) {
    // Licznik musi być świeży w chwili, gdy pytamy o usunięcie: przeniesienie
    // wiadomości do folderu nie odświeża listy, więc bez tego okno potrafiłoby
    // powiedzieć „Folder jest pusty" nad folderem pełnym poczty.
    await odswiez();
    const swiezy = stan.foldery.find((f) => f.id === folder.id) ?? folder;
    stan.edytowany = swiezy;
    tytulOkna.textContent = 'Folder';
    przyciskZapisz.textContent = 'Zapisz';
    przyciskUsun.hidden = false;
    // Liczba mówi wprost, o co toczy się gra przy usuwaniu.
    opisOkna.hidden = false;
    opisOkna.textContent = swiezy.count
      ? `Usunięcie folderu przeniesie ${swiezy.count} ${wiadomosciWord(swiezy.count)} do Archiwum. Nic nie przepadnie.`
      : 'Folder jest pusty.';
    formularz.nazwa.value = swiezy.name;
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
      const { folders, moved, rulesDisabled } = await api.usunFolder(folder.id);
      stan.foldery = folders;
      okno.close();
      // Nic nie dzieje się po cichu: toast wylicza i pocztę, i wyłączone reguły.
      const czesci = [];
      if (moved) czesci.push(`${moved} ${wiadomosciWord(moved)} w Archiwum`);
      if (rulesDisabled) {
        czesci.push(rulesDisabled === 1 ? 'wyłączona 1 reguła' : `wyłączone ${rulesDisabled} reguły`);
      }
      toast(czesci.length ? `Usunięto folder · ${czesci.join(' · ')}` : 'Usunięto folder', {
        ikonaNazwa: 'archive',
      });
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
  // wiadomość już leży: przenoszenie do samego siebie nie ma sensu.
  //
  // Wynik rozstrzygamy w kliknięciu pozycji, nie w zdarzeniu 'close' okna.
  // Powód jest praktyczny: część środowisk (panel Browser na Electronie) nie
  // odpala 'close' przy programowym .close(), mimo że okno się zamyka i
  // returnValue się ustawia. Obietnica nigdy by nie wróciła i przenoszenie po
  // cichu nic by nie robiło. 'close' zostaje wyłącznie jako droga wyjścia dla
  // Esc i kliknięcia w tło; strażnik pilnuje, żeby nie rozstrzygnąć dwa razy.
  function wybierzFolder(pomijId = null) {
    return new Promise((rozwiaz) => {
      let rozstrzygniete = false;
      const zakoncz = (wynik) => {
        if (rozstrzygniete) return;
        rozstrzygniete = true;
        przeniesOkno.removeEventListener('close', anuluj);
        rozwiaz(wynik);
      };
      const anuluj = () => zakoncz(null);

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
                zakoncz(null);
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
                przeniesOkno.close();
                zakoncz(f.id);
              },
            },
            ikona('folder'),
            el('span', {}, f.name)
          )
        );
      }

      przeniesOkno.addEventListener('close', anuluj);
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
