// TwojaPoczta · rdzeń aplikacji: stan, foldery, lista, czytnik, ustawienia.

import { api } from './api.js';
import {
  el, ikona, krotkiCzas, pelnaData, inicjaly, kolorAwatara, wstawTrescZLinkami, toast, formatujRozmiar,
} from './ui.js';
import { initKompozycja, zbudujOdpowiedz, zbudujPrzekazanie } from './kompozycja.js';
import { sanitizeHtml } from './edytor.js';
import { initSkroty } from './skroty.js';
import { initFoldery } from './foldery.js';

const NAZWY = {
  inbox: 'Odebrane', starred: 'Z gwiazdką', sent: 'Wysłane', scheduled: 'Zaplanowane',
  drafts: 'Wersje robocze', archive: 'Archiwum', spam: 'Spam', trash: 'Kosz',
};
const SLUGI = {
  odebrane: 'inbox', gwiazdka: 'starred', wyslane: 'sent', zaplanowane: 'scheduled',
  szkice: 'drafts', // dawna nazwa, stare zakładki mają dalej działać
  'wersje-robocze': 'drafts',
  archiwum: 'archive', spam: 'spam', kosz: 'trash',
};
// Przy dublujących się slugach do adresu trafia późniejszy wpis.
const SLUG_FOLDERU = Object.fromEntries(Object.entries(SLUGI).map(([s, f]) => [f, s]));

const PUSTE_TEKSTY = {
  inbox: 'Pusta skrzynka. Cisza jak w niedzielę na poczcie.',
  starred: 'Nic tu jeszcze nie błyszczy.\nOtwórz wiadomość i naciśnij „s”.',
  sent: 'Jeszcze nic stąd nie wysłano.\nNaciśnij „c” i nadaj pierwszy list.',
  scheduled: 'Nic nie czeka na nadanie.\nPisząc wiadomość, wybierz zegar obok „Wyślij”.',
  drafts: 'Brak wersji roboczych. Wszystko, co zaczniesz pisać,\nzapisze się tu samo.',
  archive: 'Archiwum świeci pustkami.',
  spam: 'Zero spamu. Tak trzymać.',
  trash: 'Kosz jest pusty.',
  custom: 'Ten folder jest pusty.\nPrzeciągnij tu pocztę akcją „Przenieś do".',
};

const stan = {
  user: null,
  folder: 'inbox',
  folderId: null,
  q: '',
  wiadomosci: [],
  liczniki: {},
  wybranaId: null,
  otwarta: null,
  zalacznikiOtwartej: [],
  przekierowanie: null,
};

// --- Referencje DOM ----------------------------------------------------------

const listaEl = document.querySelector('[data-lista]');
const tytulFolderu = document.querySelector('[data-tytul-folderu]');
const czytnikEl = document.querySelector('[data-czytnik]');
const czytnikPanel = document.querySelector('[data-panel-czytnik]');
const czytnikPuste = document.querySelector('[data-czytnik-puste]');
const szukajInput = document.querySelector('[data-szukaj]');
const szukajWyczysc = document.querySelector('[data-akcja="wyczysc-szukanie"]');
const boczny = document.querySelector('[data-boczny]');
const zaslona = document.querySelector('[data-zaslona]');
const ustawieniaDialog = document.querySelector('[data-ustawienia]');
const pomocDialog = document.querySelector('[data-pomoc]');
const formularzUstawien = document.querySelector('[data-formularz-ustawien]');

// --- Motyw ---------------------------------------------------------------------

const systemowyCiemny = matchMedia('(prefers-color-scheme: dark)');

function zastosujMotyw() {
  const motyw = stan.user?.theme ?? 'system';
  const ciemny = motyw === 'dark' || (motyw === 'system' && systemowyCiemny.matches);
  if (ciemny) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

systemowyCiemny.addEventListener('change', zastosujMotyw);

async function ustawMotyw(motyw, { zapisz = false } = {}) {
  stan.user.theme = motyw;
  zastosujMotyw();
  if (zapisz) {
    try {
      await api.zapiszProfil({ theme: motyw });
    } catch {
      /* motyw i tak działa lokalnie */
    }
  }
}

// --- Foldery i lista --------------------------------------------------------------

// Tytuł listy: wbudowane mają nazwy w NAZWY, własne trzymają je w foldery.js.
function odswiezTytul() {
  tytulFolderu.textContent =
    stan.folder === 'custom' ? foldery.nazwa(stan.folderId) : NAZWY[stan.folder];
  renderujLiczniki();
}

function przejdzDoFolderu(folder, { folderId = null, zHash = false } = {}) {
  stan.folder = folder;
  stan.folderId = folder === 'custom' ? folderId : null;
  stan.q = '';
  szukajInput.value = '';
  szukajWyczysc.hidden = true;
  stan.wybranaId = null;
  stan.otwarta = null;
  if (!zHash) {
    // Folder własny adresujemy po id, nie po nazwie: zmiana nazwy nie psuje zakładki.
    history.replaceState(null, '', `#${folder === 'custom' ? `f-${folderId}` : SLUG_FOLDERU[folder]}`);
  }
  // Selektor musi być [data-folder]: „Nowy folder" nosi klasę .folder dla wyglądu,
  // ale folderem nie jest.
  document.querySelectorAll('.folder[data-folder]').forEach((f) => {
    const wlasny = f.dataset.folder === 'custom';
    f.classList.toggle(
      'aktywny',
      wlasny ? stan.folder === 'custom' && Number(f.dataset.folderId) === stan.folderId
             : f.dataset.folder === folder
    );
  });
  odswiezTytul();
  pokazPustyCzytnik();
  zamknijBoczny();
  odswiezListe();
}

async function odswiezListe({ cicho = false } = {}) {
  try {
    const { messages, counts } = await api.lista(stan.folder, stan.q, stan.folderId);
    stan.wiadomosci = messages;
    stan.liczniki = counts;
    renderujListe();
    renderujLiczniki();
  } catch (blad) {
    if (!cicho) toast(blad.message, { blad: true });
  }
}

async function odswiezLiczniki() {
  try {
    const { counts } = await api.liczniki();
    stan.liczniki = counts;
    renderujLiczniki();
  } catch {
    /* cisza, to tylko liczniki */
  }
}

function renderujLiczniki() {
  for (const [klucz, wartosc] of [
    ['inbox', stan.liczniki.inbox],
    ['scheduled', stan.liczniki.scheduled],
    ['drafts', stan.liczniki.drafts],
    ['spam', stan.liczniki.spam],
  ]) {
    const znacznik = document.querySelector(`[data-licznik="${klucz}"]`);
    if (!znacznik) continue;
    znacznik.hidden = !wartosc;
    znacznik.textContent = wartosc || '';
  }
  foldery.renderuj();
  const nieprzeczytane = stan.liczniki.inbox;
  const nazwaFolderu = stan.folder === 'custom' ? foldery.nazwa(stan.folderId) : NAZWY[stan.folder];
  document.title = `${nazwaFolderu}${nieprzeczytane ? ` (${nieprzeczytane})` : ''} · TwojaPoczta`;
}

function renderujListe() {
  listaEl.replaceChildren();

  if (!stan.wiadomosci.length) {
    const tekst = stan.q
      ? `Brak wyników dla „${stan.q}”.`
      : PUSTE_TEKSTY[stan.folder] ?? 'Pusto.';
    const pusta = el('div', { class: 'lista-pusta' }, ikona('mail'));
    for (const linia of tekst.split('\n')) pusta.append(el('p', {}, linia));
    listaEl.append(pusta);
    return;
  }

  for (const w of stan.wiadomosci) listaEl.append(zbudujWiersz(w));
}

function zbudujWiersz(w) {
  const wysylkowy = ['sent', 'drafts', 'scheduled'].includes(stan.folder);
  const kto = wysylkowy ? `Do: ${w.to_addr || w.cc_addr || '(bez adresata)'}` : w.from_name || w.from_addr;
  const kolorAdres = wysylkowy ? w.to_addr : w.from_addr;
  const czas = stan.folder === 'scheduled' && w.scheduled_at ? w.scheduled_at : w.sent_at;

  const gwiazdka = el(
    'span',
    {
      class: `w-gwiazdka${w.is_starred ? ' aktywna' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': w.is_starred ? 'Zdejmij gwiazdkę' : 'Oznacz gwiazdką',
      onclick: (e) => {
        e.stopPropagation();
        przelaczGwiazdke(w.id);
      },
    },
    ikona('star')
  );

  const wiersz = el(
    'button',
    {
      class:
        'wiadomosc' +
        (!w.is_read && !wysylkowy ? ' nieprzeczytana' : '') +
        (w.id === stan.wybranaId ? ' wybrana' : ''),
      dataset: { id: w.id },
      onclick: () => otworzWiadomosc(w.id),
    },
    el('span', { class: 'aw', style: `background:${kolorAwatara(kolorAdres)}` }, inicjaly(kto.replace(/^Do: /, ''), kolorAdres)),
    el(
      'span',
      { class: 'w-gora' },
      el('span', { class: 'w-od' }, kto),
      w.is_priority ? el('span', { class: 'w-chip' }, 'PRIORYTET') : null
    ),
    el('span', { class: 'w-czas' }, krotkiCzas(czas)),
    el(
      'span',
      { class: 'w-dol' },
      el('span', { class: 'w-temat' }, w.subject || '(bez tematu)'),
      el('span', { class: 'w-snippet' }, w.snippet ? `· ${w.snippet}` : ''),
      w.attachments_count ? el('span', { class: 'w-spinacz', title: 'Z załącznikiem' }, ikona('attach')) : null,
      gwiazdka
    )
  );
  return wiersz;
}

// --- Czytnik ----------------------------------------------------------------------

function pokazPustyCzytnik() {
  stan.otwarta = null;
  czytnikEl.hidden = true;
  czytnikPuste.hidden = false;
  czytnikPanel.classList.remove('otwarty');
  odswiezZaznaczenieListy();
}

function zamknijCzytnik() {
  pokazPustyCzytnik();
  stan.wybranaId = null;
  odswiezZaznaczenieListy();
}

function odswiezZaznaczenieListy() {
  listaEl.querySelectorAll('.wiadomosc').forEach((wiersz) => {
    wiersz.classList.toggle('wybrana', Number(wiersz.dataset.id) === stan.wybranaId);
  });
}

async function otworzWiadomosc(id) {
  const skrot = stan.wiadomosci.find((w) => w.id === id);
  stan.wybranaId = id;
  odswiezZaznaczenieListy();

  try {
    const { message, attachments } = await api.wiadomosc(id);
    // W międzyczasie wybrano coś innego albo zmieniono folder, więc nie renderuj starej odpowiedzi.
    if (stan.wybranaId !== id) return;

    if (message.folder === 'drafts') {
      kompozycja.otworz({ draft: message });
      return;
    }

    stan.otwarta = message;
    stan.zalacznikiOtwartej = attachments ?? [];
    if (skrot && !skrot.is_read) {
      skrot.is_read = 1;
      listaEl.querySelector(`[data-id="${id}"]`)?.classList.remove('nieprzeczytana');
      odswiezLiczniki();
    }
    renderujCzytnik();
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
}

function przyciskAkcji(tekst, nazwaIkony, klik, { glowny = false } = {}) {
  return el(
    'button',
    { class: `cz-przycisk${glowny ? ' glowny' : ''}`, onclick: klik },
    ikona(nazwaIkony),
    tekst
  );
}

function ikonaAkcji(tytul, nazwaIkony, klik, { aktywna = false } = {}) {
  return el(
    'button',
    { class: `ikona-btn${aktywna ? ' aktywna' : ''}`, title: tytul, 'aria-label': tytul, onclick: klik },
    ikona(nazwaIkony)
  );
}

function renderujCzytnik() {
  const w = stan.otwarta;
  czytnikEl.replaceChildren();
  czytnikPuste.hidden = true;
  czytnikEl.hidden = false;
  czytnikPanel.classList.add('otwarty');

  const powrot = el(
    'button',
    { class: 'ikona-btn cz-powrot', 'aria-label': 'Wróć do listy', onclick: () => zamknijCzytnik() },
    ikona('back')
  );

  const naglowek = el(
    'div',
    { class: 'cz-naglowek' },
    el('h2', { class: 'cz-temat' }, w.subject || '(bez tematu)'),
    w.is_priority ? el('span', { class: 'cz-chip' }, 'PRIORYTET') : null
  );

  const kto = el(
    'div',
    { class: 'cz-kto' },
    el('div', { class: 'cz-od' }, w.from_name || w.from_addr, el('small', {}, `<${w.from_addr}>`)),
    el('div', { class: 'cz-do' }, `Do: ${w.to_addr || stan.user.address}`)
  );
  if (w.cc_addr) kto.append(el('div', { class: 'cz-do' }, `DW: ${w.cc_addr}`));
  if (w.bcc_addr) kto.append(el('div', { class: 'cz-do' }, `UDW: ${w.bcc_addr}`));

  const meta = el(
    'div',
    { class: 'cz-meta' },
    el('span', { class: 'aw', style: `background:${kolorAwatara(w.from_addr)}` }, inicjaly(w.from_name, w.from_addr)),
    kto,
    el('div', { class: 'cz-data' }, pelnaData(w.sent_at))
  );

  const zaplanowana = w.folder === 'scheduled';
  const akcje = el('div', { class: 'cz-akcje' });
  if (zaplanowana) {
    akcje.append(
      przyciskAkcji('Anuluj wysyłkę', 'draft', () => anulujZaplanowana(), { glowny: true }),
      ikonaAkcji('Do kosza (#)', 'trash', () => doKoszaOtwarta())
    );
  } else {
    akcje.append(
      przyciskAkcji('Odpowiedz', 'reply', () => odpowiedz(), { glowny: true }),
      przyciskAkcji('Przekaż', 'forward', () => przekaz())
    );
    if (w.folder === 'trash') {
      akcje.append(
        przyciskAkcji('Przywróć', 'inbox', () => przeniesOtwarta('inbox', 'Przywrócono do Odebranych')),
        przyciskAkcji('Usuń trwale', 'trash', () => doKoszaOtwarta())
      );
    } else {
      if (w.folder === 'spam') {
        akcje.append(przyciskAkcji('To nie spam', 'inbox', () => przeniesOtwarta('inbox', 'Przeniesiono do Odebranych')));
      }
      akcje.append(
        ikonaAkcji('Archiwizuj (e)', 'archive', () => archiwizujOtwarta()),
        ikonaAkcji(w.is_starred ? 'Zdejmij gwiazdkę (s)' : 'Gwiazdka (s)', 'star', () => gwiazdkaOtwarta(), {
          aktywna: !!w.is_starred,
        }),
        ikonaAkcji('Oznacz jako nieprzeczytane (u)', 'unread', () => nieprzeczytanaOtwarta()),
        ikonaAkcji('Do kosza (#)', 'trash', () => doKoszaOtwarta())
      );
      if (w.folder !== 'spam' && w.folder !== 'sent') {
        akcje.append(ikonaAkcji('Zgłoś spam', 'spam', () => przeniesOtwarta('spam', 'Oznaczono jako spam')));
      }
    }
  }
  akcje.append(ikonaAkcji('Drukuj', 'print', () => window.print()));

  const body = el('div', { class: 'cz-body' });
  if (w.body_html) body.innerHTML = sanitizeHtml(w.body_html);
  else wstawTrescZLinkami(body, w.body);

  czytnikEl.append(powrot, naglowek, meta);
  if (zaplanowana && w.scheduled_at) {
    czytnikEl.append(
      el(
        'div',
        { class: 'cz-zaplanowana' },
        ikona('clock'),
        `Zaplanowano nadanie: ${pelnaData(w.scheduled_at)}`
      )
    );
  }
  czytnikEl.append(akcje, body);

  if (stan.zalacznikiOtwartej.length) {
    const lista = el('div', { class: 'cz-zalaczniki-lista' });
    for (const z of stan.zalacznikiOtwartej) {
      lista.append(
        el(
          'a',
          {
            class: 'zalacznik',
            href: `/api/messages/${w.id}/attachments/${z.id}`,
            download: z.filename,
          },
          ikona('attach'),
          el('span', { class: 'zalacznik-nazwa' }, z.filename),
          el('small', {}, formatujRozmiar(z.size))
        )
      );
    }
    czytnikEl.append(
      el(
        'section',
        { class: 'cz-zalaczniki' },
        el('p', { class: 'eyebrow' }, `Załączniki (${stan.zalacznikiOtwartej.length})`),
        lista
      )
    );
  }

  czytnikPanel.scrollTop = 0;
}

// --- Akcje na wiadomościach ------------------------------------------------------

function usunZListy(id, { zaznaczNastepna = true } = {}) {
  const indeks = stan.wiadomosci.findIndex((w) => w.id === id);
  if (indeks === -1) return;
  stan.wiadomosci.splice(indeks, 1);
  renderujListe();
  if (stan.wybranaId !== id) return;
  const nastepnaW = stan.wiadomosci[Math.min(indeks, stan.wiadomosci.length - 1)];
  if (zaznaczNastepna && nastepnaW) otworzWiadomosc(nastepnaW.id);
  else zamknijCzytnik();
}

async function przelaczGwiazdke(id) {
  const w = stan.wiadomosci.find((x) => x.id === id) ?? stan.otwarta;
  if (!w) return;
  const nowa = !w.is_starred;
  try {
    await api.zmien(id, { is_starred: nowa });
  } catch (blad) {
    return toast(blad.message, { blad: true });
  }
  w.is_starred = nowa ? 1 : 0;
  if (stan.otwarta?.id === id) stan.otwarta.is_starred = w.is_starred;
  if (stan.folder === 'starred' && !nowa) {
    usunZListy(id);
  } else {
    renderujListe();
    if (stan.otwarta?.id === id) renderujCzytnik();
  }
}

// Cofnięcie przeniesienia: list wraca tam, skąd wyszedł.
async function przywrocDoFolderu(id, folder) {
  try {
    await api.zmien(id, { folder });
    toast('Przywrócono', { ikonaNazwa: 'inbox' });
    // Wrócił do folderu, który właśnie oglądamy, więc musi się znów pojawić na liście.
    if (stan.folder === folder || stan.folder === 'starred') odswiezListe({ cicho: true });
    odswiezLiczniki();
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
}

async function przeniesOtwarta(folder, komunikat) {
  const w = stan.otwarta;
  if (!w) return;
  const skad = w.folder;
  try {
    await api.zmien(w.id, { folder });
    toast(komunikat, { ikonaNazwa: 'archive', cofnij: () => przywrocDoFolderu(w.id, skad) });
    usunZListy(w.id);
    odswiezLiczniki();
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
}

function archiwizujOtwarta() {
  if (!stan.otwarta || stan.otwarta.folder === 'archive') return;
  przeniesOtwarta('archive', 'Zarchiwizowano');
}

// Anulowana wysyłka wraca do wersji roboczych i od razu otwiera się do edycji.
async function anulujZaplanowana() {
  const w = stan.otwarta;
  if (!w) return;
  try {
    const { message } = await api.zmien(w.id, { folder: 'drafts' });
    toast('Wysyłka anulowana. List wrócił do wersji roboczych', { ikonaNazwa: 'draft' });
    usunZListy(w.id, { zaznaczNastepna: false });
    odswiezLiczniki();
    kompozycja.otworz({ draft: message });
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
}

function gwiazdkaOtwarta() {
  if (stan.otwarta) przelaczGwiazdke(stan.otwarta.id);
}

async function doKoszaOtwarta() {
  const w = stan.otwarta;
  if (!w) return;
  const skad = w.folder;
  try {
    const wynik = await api.usun(w.id);
    toast(wynik.purged ? 'Usunięto trwale' : 'Przeniesiono do kosza', {
      ikonaNazwa: 'trash',
      // Z kosza wiadomość znika bezpowrotnie, więc nie obiecujemy cofnięcia, którego nie ma.
      cofnij: wynik.purged ? null : () => przywrocDoFolderu(w.id, skad),
    });
    usunZListy(w.id);
    odswiezLiczniki();
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
}

async function nieprzeczytanaOtwarta() {
  const w = stan.otwarta;
  if (!w) return;
  try {
    await api.zmien(w.id, { is_read: false });
    const skrot = stan.wiadomosci.find((x) => x.id === w.id);
    if (skrot) skrot.is_read = 0;
    zamknijCzytnik();
    renderujListe();
    odswiezLiczniki();
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
}

// --- Nawigacja po liście -------------------------------------------------------------

function otworzWzgledna(krok) {
  if (!stan.wiadomosci.length) return;
  const indeks = stan.wiadomosci.findIndex((w) => w.id === stan.wybranaId);
  const nowy = indeks === -1 ? 0 : Math.min(Math.max(indeks + krok, 0), stan.wiadomosci.length - 1);
  if (stan.wiadomosci[nowy].id !== stan.wybranaId) {
    otworzWiadomosc(stan.wiadomosci[nowy].id);
    listaEl.querySelector(`[data-id="${stan.wiadomosci[nowy].id}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

// --- Kompozycja: wejścia -------------------------------------------------------------

function napisz() {
  kompozycja.otworz({ tresc: stan.user.signature ? `\n\n${stan.user.signature}` : '' });
}

function odpowiedz() {
  if (!stan.otwarta) return;
  kompozycja.otworz(zbudujOdpowiedz(stan.otwarta, stan.user));
}

function przekaz() {
  if (!stan.otwarta) return;
  kompozycja.otworz(zbudujPrzekazanie(stan.otwarta));
}

// --- Szukanie ----------------------------------------------------------------------

let zegarSzukania = null;

szukajInput.addEventListener('input', () => {
  szukajWyczysc.hidden = !szukajInput.value;
  clearTimeout(zegarSzukania);
  zegarSzukania = setTimeout(() => {
    stan.q = szukajInput.value.trim();
    odswiezListe();
  }, 300);
});

szukajInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(zegarSzukania);
    stan.q = szukajInput.value.trim();
    odswiezListe();
  }
});

szukajWyczysc.addEventListener('click', () => {
  szukajInput.value = '';
  szukajWyczysc.hidden = true;
  stan.q = '';
  odswiezListe();
  szukajInput.focus();
});

function fokusSzukaj() {
  szukajInput.focus();
  szukajInput.select();
}

// --- Ustawienia i pomoc ---------------------------------------------------------------

function otworzUstawienia() {
  formularzUstawien.imie.value = stan.user.name;
  formularzUstawien.podpis.value = stan.user.signature;
  formularzUstawien.motyw.value = stan.user.theme;
  odswiezAliasy();
  odswiezPrzekierowanie();
  ustawieniaDialog.showModal();
}

// --- Przesyłanie dalej ------------------------------------------------------------

const przekierowanieInput = document.querySelector('[data-przekierowanie]');
const przekierowanieKopia = document.querySelector('[data-przekierowanie-kopia]');
const przekierowanieWylacz = document.querySelector('[data-akcja="wylacz-przekierowanie"]');

function pokazStanPrzekierowania({ to, keepCopy }) {
  przekierowanieInput.value = to;
  przekierowanieKopia.checked = keepCopy;
  przekierowanieWylacz.hidden = !to;
  stan.przekierowanie = { to, keepCopy };
}

async function odswiezPrzekierowanie() {
  try {
    const { forwarding } = await api.przekierowanie();
    pokazStanPrzekierowania(forwarding);
  } catch {
    /* sekcja zostaje z domyślnymi wartościami */
  }
}

// Zapisujemy tylko przy realnej zmianie: inaczej każdy zapis ustawień
// kasowałby przekierowanie, gdyby pole nie zdążyło się wczytać.
async function zapiszPrzekierowanie() {
  const to = przekierowanieInput.value.trim();
  const keepCopy = przekierowanieKopia.checked;
  const teraz = stan.przekierowanie ?? { to: '', keepCopy: true };
  if (to === teraz.to && keepCopy === teraz.keepCopy) return true;
  try {
    const { forwarding } = await api.ustawPrzekierowanie({ to, keepCopy });
    pokazStanPrzekierowania(forwarding);
    return true;
  } catch (blad) {
    toast(blad.message, { blad: true });
    return false;
  }
}

przekierowanieWylacz.addEventListener('click', async () => {
  przekierowanieInput.value = '';
  if (await zapiszPrzekierowanie()) toast('Przesyłanie dalej wyłączone', { ikonaNazwa: 'mail' });
});

// --- Aliasy ---------------------------------------------------------------------

const OPIS_ALIASOW = 'Wiadomości wysłane na alias trafią do Twojej skrzynki.';

async function odswiezAliasy() {
  try {
    const { aliases, limit } = await api.aliasy();
    renderujAliasy(aliases, limit);
  } catch {
    /* sekcja zostaje pusta */
  }
}

// Limit ustala administrator: null = bez limitu (wtedy nie strasz użytkownika liczbą),
// 0 = aliasy wyłączone.
function renderujAliasy(aliasy, limit) {
  const lista = document.querySelector('[data-aliasy]');
  const opis = document.querySelector('[data-aliasy-opis]');
  const dodawanie = document.querySelector('[data-alias-dodawanie]');

  if (limit === 0) opis.textContent = 'Administrator wyłączył aliasy na tym koncie.';
  else opis.textContent = limit == null ? OPIS_ALIASOW : `${OPIS_ALIASOW} Najwyżej ${limit}.`;
  dodawanie.hidden = limit != null && aliasy.length >= limit;

  lista.replaceChildren();
  if (!aliasy.length) {
    lista.append(el('li', { class: 'aliasy-brak' }, 'Nie masz jeszcze żadnego aliasu.'));
    return;
  }
  for (const wpis of aliasy) {
    lista.append(
      el(
        'li',
        { class: 'alias' },
        el('span', {}, wpis.address),
        el(
          'button',
          {
            type: 'button',
            class: 'alias-usun',
            'aria-label': `Usuń alias ${wpis.address}`,
            onclick: async () => {
              try {
                const { aliases, limit: swiezyLimit } = await api.usunAlias(wpis.id);
                renderujAliasy(aliases, swiezyLimit);
                toast('Usunięto alias', { ikonaNazwa: 'trash' });
              } catch (blad) {
                toast(blad.message, { blad: true });
              }
            },
          },
          ikona('close')
        )
      )
    );
  }
}

async function dodajAlias() {
  const input = document.querySelector('[data-alias-input]');
  const alias = input.value.trim().toLowerCase();
  if (!alias) return input.focus();
  try {
    const { aliases, limit } = await api.dodajAlias(alias);
    input.value = '';
    renderujAliasy(aliases, limit);
    toast('Dodano alias', { ikonaNazwa: 'mail' });
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
}

formularzUstawien.addEventListener('submit', async (e) => {
  e.preventDefault();
  // Odrzucone przekierowanie (np. literówka w adresie) zatrzymuje zamknięcie okna,
  // żeby błąd nie zniknął razem z nim.
  if (!(await zapiszPrzekierowanie())) return;
  try {
    const { user } = await api.zapiszProfil({
      name: formularzUstawien.imie.value.trim(),
      signature: formularzUstawien.podpis.value,
      theme: formularzUstawien.motyw.value,
    });
    stan.user = user;
    zastosujMotyw();
    odswiezAwatar();
    ustawieniaDialog.close();
    toast('Zapisano ustawienia', { ikonaNazwa: 'ustawienia' });
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
});

function otworzPomoc() {
  pomocDialog.showModal();
}

async function wyloguj() {
  try {
    await api.wyloguj();
  } finally {
    location.href = '/logowanie';
  }
}

// --- Panel boczny (mobile) --------------------------------------------------------------

function zamknijBoczny() {
  boczny.classList.remove('otwarty');
  zaslona.hidden = true;
}

document.querySelector('[data-akcja="menu"]').addEventListener('click', () => {
  const otwarty = boczny.classList.toggle('otwarty');
  zaslona.hidden = !otwarty;
});

zaslona.addEventListener('click', zamknijBoczny);

// --- Spinanie całości ----------------------------------------------------------------------

function odswiezAwatar() {
  const znak = document.querySelector('[data-awatar]');
  znak.textContent = inicjaly(stan.user.name, stan.user.address);
  znak.parentElement.style.background = kolorAwatara(stan.user.address);
  document.querySelector('[data-adres]').textContent = stan.user.address;

  const domena = stan.user.address.split('@')[1];
  for (const wezel of document.querySelectorAll('[data-domena]')) {
    wezel.textContent = `@${domena}`;
  }
  document.querySelector('[data-formularz-kompozycji]').do.placeholder = `adres@${domena}`;
  // Wejście do panelu administratora widzą tylko konta z rolą.
  document.querySelector('[data-admin-link]').hidden = !stan.user.is_admin;
}

const app = {
  stan,
  przejdzDoFolderu,
  odswiezListe,
  odswiezLiczniki,
  odswiezTytul,
  zamknijCzytnik,
  napisz,
  fokusSzukaj,
  ustawMotyw,
  otworzUstawienia,
  otworzPomoc,
  wyloguj,
  nastepna: () => otworzWzgledna(1),
  poprzednia: () => otworzWzgledna(-1),
  otworzZaznaczona: () => stan.wybranaId && otworzWiadomosc(stan.wybranaId),
  archiwizujOtwarta,
  gwiazdkaOtwarta,
  doKoszaOtwarta,
  nieprzeczytanaOtwarta,
};

const kompozycja = initKompozycja(app);
const foldery = initFoldery(app);
initSkroty(app, kompozycja);

// „Nowy folder" i przyszłe przyciski stylowane na .folder nie są folderami:
// bez [data-folder] wpięłyby się tu i wołały przejdzDoFolderu(undefined).
for (const przycisk of document.querySelectorAll('.folder[data-folder]')) {
  przycisk.addEventListener('click', () => przejdzDoFolderu(przycisk.dataset.folder));
}

document.querySelector('[data-akcja="napisz"]').addEventListener('click', napisz);
document.querySelector('[data-akcja="odswiez"]').addEventListener('click', () => odswiezListe());
document.querySelector('[data-akcja="ustawienia"]').addEventListener('click', otworzUstawienia);
document.querySelector('[data-akcja="pomoc"]').addEventListener('click', otworzPomoc);
document.querySelector('[data-akcja="wyloguj"]').addEventListener('click', wyloguj);

for (const przycisk of document.querySelectorAll('[data-akcja="zamknij-modal"]')) {
  przycisk.addEventListener('click', () => przycisk.closest('dialog').close());
}

// Kliknięcie w tło zamyka modal, tak samo jak Esc. Tło to pseudo-element
// dialogu, więc trafienie w nie ma target === dialog; po marginesie wewnętrznym
// rozróżnia je dopiero geometria. `detail` odsiewa Enter i kliknięcia z kodu,
// które przychodzą bez współrzędnych i wyglądałyby na klik w róg ekranu.
for (const okno of document.querySelectorAll('dialog')) {
  okno.addEventListener('click', (e) => {
    if (e.target !== okno || !e.detail) return;
    const r = okno.getBoundingClientRect();
    const poza = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    if (poza) okno.close();
  });
}

document.querySelector('[data-akcja="dodaj-alias"]').addEventListener('click', dodajAlias);
document.querySelector('[data-alias-input]').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    dodajAlias();
  }
});

// Folder własny w adresie to #f-12 (po id, nie po nazwie).
function zHasha(hash) {
  const slug = hash.slice(1);
  const wlasny = /^f-(\d+)$/.exec(slug);
  if (wlasny) return { folder: 'custom', folderId: Number(wlasny[1]) };
  const folder = SLUGI[slug];
  return folder ? { folder, folderId: null } : null;
}

window.addEventListener('hashchange', () => {
  const cel = zHasha(location.hash);
  if (!cel) return;
  if (cel.folder !== stan.folder || cel.folderId !== stan.folderId) {
    przejdzDoFolderu(cel.folder, { folderId: cel.folderId, zHash: true });
  }
});

async function start() {
  try {
    const { user } = await api.ja();
    stan.user = user;
  } catch {
    return; // api.js przekierowało do logowania
  }
  zastosujMotyw();
  odswiezAwatar();
  await foldery.odswiez();
  const cel = zHasha(location.hash);
  przejdzDoFolderu(cel?.folder ?? 'inbox', { folderId: cel?.folderId ?? null });

  // Cichy puls: świeże liczniki, a w Odebranych także lista.
  setInterval(() => {
    if (document.hidden) return;
    odswiezLiczniki();
    if (stan.folder === 'inbox' && !stan.q && !kompozycja.otwarte() && listaEl.scrollTop === 0) {
      odswiezListe({ cicho: true });
    }
  }, 30_000);
}

start();
