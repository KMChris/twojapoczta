// TwojaPoczta · rdzeń aplikacji: stan, foldery, lista, czytnik, ustawienia.

import { api } from './api.js';
import {
  el, ikona, krotkiCzas, pelnaData, inicjaly, kolorAwatara, toast, formatujRozmiar,
  zamykajDialogiTlem,
} from './ui.js';
import { initKompozycja, zbudujOdpowiedz, zbudujPrzekazanie } from './kompozycja.js';
import { renderujTresc, pokazObrazki } from './tresc.js';
import { widoczneSpinacze } from './spinacze.js';
import { initSkroty } from './skroty.js';
import { initFoldery } from './foldery.js';
import { initDymki } from './dymek.js';
import { initFiltry } from './filtry.js';
import { initReguly } from './reguly.js';

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
  custom: 'Ten folder jest pusty.\nOtwórz wiadomość i przenieś ją tu ikoną teczki.',
};

const stan = {
  user: null,
  folder: 'inbox',
  folderId: null,
  q: '',
  kryteria: null,
  wiadomosci: [],
  liczniki: {},
  wybranaId: null,
  otwarta: null,
  zalacznikiOtwartej: [],
  cidOtwartej: {},
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
  const bylCiemny = document.documentElement.dataset.theme === 'dark';
  if (ciemny) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  if (ciemny !== bylCiemny) przerysujOtwartaPoMotywie();
}

// Cała reszta aplikacji chodzi na zmiennych CSS, więc przestawienie data-theme załatwia jej
// motyw w całości. Treść listu przychodzącego NIE: renderer czyta motyw raz, w chwili renderu,
// i wypala inwersję w stylach inline oraz w <style> listu (tresc.js/renderujHtml). Kolory
// nadawcy są tam POLICZONE, nie odziedziczone, więc nie ma zmiennej, którą dałoby się podmienić.
// Bez tego przerysowania otwarty list zostawał w barwach poprzedniego motywu, a furtka
// „Oryginalne kolory" wisiała w pasku akcji, choć nie było już czego przywracać.
// Zmierzone: po przełączeniu na jasny `.cz-body` trzymał id="list-1" (czyli render się nie
// powtórzył) i odwróconą czerwień rgb(202, 62, 51), podczas gdy tło aplikacji było już jasne.
//
// Wołamy to WYŁĄCZNIE przy realnej zmianie jasności. zastosujMotyw biegnie po każdym zapisie
// ustawień, także takim, który motywu nie rusza (imię, podpis), a przerysowanie bez powodu
// cofałoby świadome „Pokaż obrazki" i zwijało rozwinięte cytaty.
function przerysujOtwartaPoMotywie() {
  if (!stan.otwarta) return;
  // Zgodę na zdalne obrazki przenosimy przez render, dokładnie tak jak furtka „Oryginalne
  // kolory": inaczej przełącznik motywu cofałby decyzję użytkownika i parkował obrazki z
  // powrotem. Oba schowki bramki, nie samo `img[data-src]` — uzasadnienie przy furtce niżej.
  const stary = czytnikEl.querySelector('.cz-body');
  const obrazkiPokazane = Boolean(stary) && !stary.querySelector('[data-src], [data-background]');
  // Przerysowujemy CAŁY czytnik, nie samą treść: pasek akcji i belka obrazków też zależą od
  // wyniku renderu, więc przerysowanie połowy rozjechałoby je z treścią. Cena to zjazd na
  // górę listu, do przyjęcia przy świadomym przełączeniu motywu.
  renderujCzytnik();
  if (!obrazkiPokazane) return;
  const nowy = czytnikEl.querySelector('.cz-body');
  if (!nowy) return;
  pokazObrazki(nowy);
  czytnikEl.querySelector('.cz-obrazki')?.remove();
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

// Motyw zmienia się w chwili wyboru kafelka, a nie dopiero przy „Zapisz zmiany". Kafelek
// z podglądem wygląda na przełącznik, nie na pole formularza, więc kliknięcie, które tylko
// go zaznaczało i nie ruszało aplikacji, wyglądało po prostu na zepsuty motyw (zmierzone:
// po kliknięciu „Nocnej sortowni" motyw.value szedł na 'dark', a data-theme zostawał pusty
// aż do wysłania formularza schowanego niżej, poza widokiem). Tak samo natychmiastowo robi
// to paleta poleceń, więc obie drogi zachowują się teraz tak samo, a zamknięcie okna
// krzyżykiem nie ma już czego po cichu zgubić. Formularz i tak niesie `theme` przy zapisie,
// więc wartość zostaje ta sama, którą właśnie zapisaliśmy — to samo pole, ta sama wartość.
for (const kafelek of formularzUstawien.querySelectorAll('input[name="motyw"]')) {
  kafelek.addEventListener('change', () => ustawMotyw(kafelek.value, { zapisz: true }));
}

// --- Foldery i lista --------------------------------------------------------------

// Tytuł listy: wbudowane mają nazwy w NAZWY, własne trzymają je w foldery.js.
function odswiezTytul() {
  tytulFolderu.textContent = stan.kryteria
    ? 'Wyniki wyszukiwania'
    : stan.folder === 'custom' ? foldery.nazwa(stan.folderId) : NAZWY[stan.folder];
  renderujLiczniki();
}

function przejdzDoFolderu(folder, { folderId = null, zHash = false } = {}) {
  stan.folder = folder;
  stan.folderId = folder === 'custom' ? folderId : null;
  stan.q = '';
  filtry.wyczyscTryb();
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
    const { messages, counts } = stan.kryteria
      ? await api.szukaj(stan.kryteria)
      : await api.lista(stan.folder, stan.q, stan.folderId);
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
  const nazwaFolderu = stan.kryteria
    ? 'Wyniki wyszukiwania'
    : stan.folder === 'custom' ? foldery.nazwa(stan.folderId) : NAZWY[stan.folder];
  document.title = `${nazwaFolderu}${nieprzeczytane ? ` (${nieprzeczytane})` : ''} · TwojaPoczta`;
}

function renderujListe() {
  listaEl.replaceChildren();

  if (!stan.wiadomosci.length) {
    const tekst = stan.kryteria
      ? 'Nic nie pasuje do ustawionych filtrów.'
      : stan.q
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
  // W wynikach filtrów o układzie wiersza decyduje szukany folder, nie ostatnio
  // oglądany: wyniki „wszędzie" pokazują nadawcę, wyniki z Wysłanych adresata.
  const wysylkowy = stan.kryteria
    ? stan.kryteria.folder === 'sent'
    : ['sent', 'drafts', 'scheduled'].includes(stan.folder);
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
      w.attachments_count ? el('span', { class: 'w-spinacz', 'data-dymek': 'Z załącznikiem' }, ikona('attach')) : null,
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
    const { message, attachments, cid } = await api.wiadomosc(id);
    // W międzyczasie wybrano coś innego albo zmieniono folder, więc nie renderuj starej odpowiedzi.
    if (stan.wybranaId !== id) return;

    if (message.folder === 'drafts') {
      kompozycja.otworz({ draft: message });
      return;
    }

    stan.otwarta = message;
    stan.zalacznikiOtwartej = attachments ?? [];
    stan.cidOtwartej = cid ?? {};
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
    { class: `ikona-btn${aktywna ? ' aktywna' : ''}`, 'data-dymek': tytul, 'aria-label': tytul, onclick: klik },
    ikona(nazwaIkony)
  );
}

// Belka pojawia się tylko wtedy, gdy renderer faktycznie coś zaparkował. Zdalny
// obrazek zdradza nadawcy moment otwarcia listu i adres IP, więc domyślnie nie
// wczytujemy go wcale — wczytanie ma być świadomą decyzją, jednym kliknięciem.
// `ile` bierzemy z renderera, a nie z własnego przeliczenia drzewa: to ta sama
// liczba, którą pokazObrazki za chwilę przywróci.
function belkaObrazkow(body, ile) {
  const belka = el('div', { class: 'cz-obrazki' });
  belka.append(
    ikona('image'),
    el(
      'span',
      { class: 'cz-obrazki-tekst' },
      `Ta wiadomość zawiera obrazki z zewnątrz (${ile}). Wczytanie ich powie nadawcy, że list został otwarty.`
    ),
    el(
      'button',
      {
        class: 'cz-obrazki-akcja',
        type: 'button',
        onclick: () => {
          pokazObrazki(body);
          belka.remove();
        },
      },
      'Pokaż obrazki'
    )
  );
  return belka;
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
        ikonaAkcji('Przenieś do folderu', 'folder', () => przeniesDoFolderu()),
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
  const { zdalne, przerobioneKolory, uzyteCid } = renderujTresc(body, w, { cid: stan.cidOtwartej });

  // Opcja B: serwer oddaje wszystkie załączniki, a spinacze chowamy tylko dla tych, których
  // obrazek renderer NAPRAWDĘ wstawił w treść (uzyteCid). Bez content_id spinacz nie znika
  // nigdy; z content_id, którego treść nie wchłonęła, ZOSTAJE (to sedno opcji B). Przy kilku
  // załącznikach o TYM SAMYM Content-ID chowamy tylko JEDEN spinacz — ten pierwszy, który trasa
  // `cid:` serwuje w treść (dedup po wartości siedzi w widoczneSpinacze); duplikaty zostają pod
  // listem, inaczej druga kopia znikłaby z aplikacji. Liczymy raz, z pierwszego renderu:
  // rozwiązanie cid nie zależy od „Oryginalnych kolorów" ani od obrazków, a re-render przy furtce
  // nie przerysowuje tej sekcji.
  const spinacze = widoczneSpinacze(stan.zalacznikiOtwartej, uzyteCid);

  // Inwersja czasem chybi (logo w czarnej grafice na przezroczystym tle
  // zniknie), a wykryć się tego nie da: canvas nie odczyta zdalnego obrazka
  // przez CORS. Zamiast udawać nieomylność, dajemy furtkę — w OBIE strony.
  // Jednokierunkowa kazała zamknąć i otworzyć list od nowa, żeby wrócić do wersji
  // dopasowanej, a to jest przełącznik do porównywania: zobacz, jak nadał nadawca,
  // wróć, jak czyta się lepiej. Stan trzyma zmienna, bo poza nią nie ma go gdzie
  // przeczytać — `cz-body-kartka` siedzi na kontenerze tylko w ciemnym motywie.
  if (przerobioneKolory) {
    let oryginalne = false;
    const furtka = ikonaAkcji('Oryginalne kolory', 'ustawienia', () => {
      oryginalne = !oryginalne;
      // renderujTresc parkuje zdalne obrazki OD NOWA, więc bez zapamiętania decyzji
      // przełącznik cofnąłby świadome „Pokaż obrazki": obrazki wróciłyby zaparkowane, a
      // belka (już usunięta po odblokowaniu) nie miałaby jak ich znów odsłonić.
      // Selektor obejmuje OBA schowki bramki (data-src ORAZ data-background), tak samo
      // jak pokazObrazki — węższe `img[data-src]` uznałoby list z pikselem tylko w
      // data-background za „odblokowany" i odsłoniłoby go bez zgody użytkownika.
      const obrazkiPokazane = !body.querySelector('[data-src], [data-background]');
      renderujTresc(body, w, { cid: stan.cidOtwartej, oryginalneKolory: oryginalne });
      // Wyłącznie gdy użytkownik SAM je wcześniej pokazał — nigdy bez zgody.
      if (obrazkiPokazane) pokazObrazki(body);
      // Belka schodzi po FAKTYCZNYM stanie drzewa: tylko gdy nie ma już nic do odblokowania.
      if (!body.querySelector('[data-src], [data-background]')) {
        czytnikEl.querySelector('.cz-obrazki')?.remove();
      }
      const tytul = oryginalne ? 'Wróć do kolorów motywu' : 'Oryginalne kolory';
      furtka.classList.toggle('aktywna', oryginalne);
      furtka.title = tytul;
      furtka.setAttribute('aria-label', tytul);
      furtka.setAttribute('aria-pressed', String(oryginalne));
    });
    furtka.setAttribute('aria-pressed', 'false');
    akcje.append(furtka);
  }

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
  czytnikEl.append(akcje);
  if (zdalne) czytnikEl.append(belkaObrazkow(body, zdalne));
  czytnikEl.append(body);

  if (spinacze.length) {
    const lista = el('div', { class: 'cz-zalaczniki-lista' });
    for (const z of spinacze) {
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
        // Licznik liczy listę PO odfiltrowaniu skonsumowanych, żeby nagłówek nie kłamał.
        el('p', { class: 'eyebrow' }, `Załączniki (${spinacze.length})`),
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

// Cofnięcie przeniesienia: list wraca tam, skąd wyszedł, także do folderu własnego.
async function przywrocDoFolderu(id, folder, folderId = null) {
  try {
    await api.zmien(id, folderId ? { folder_id: folderId } : { folder });
    toast('Przywrócono', { ikonaNazwa: 'inbox' });
    const wrocilDoOgladanego =
      folderId ? stan.folder === 'custom' && stan.folderId === folderId : stan.folder === folder;
    if (wrocilDoOgladanego || stan.folder === 'starred') odswiezListe({ cicho: true });
    odswiezLiczniki();
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
}

async function przeniesOtwarta(folder, komunikat) {
  const w = stan.otwarta;
  if (!w) return;
  const skad = w.folder;
  const skadId = w.folder_id ?? null;
  try {
    await api.zmien(w.id, { folder });
    toast(komunikat, { ikonaNazwa: 'archive', cofnij: () => przywrocDoFolderu(w.id, skad, skadId) });
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

async function przeniesDoFolderu() {
  const w = stan.otwarta;
  if (!w) return;
  const cel = await foldery.wybierzFolder(w.folder_id ?? null);
  if (!cel) return;
  const skad = w.folder;
  const skadId = w.folder_id ?? null;
  try {
    await api.zmien(w.id, { folder_id: cel });
    toast(`Przeniesiono do „${foldery.nazwa(cel)}”`, {
      ikonaNazwa: 'folder',
      cofnij: () => przywrocDoFolderu(w.id, skad, skadId),
    });
    usunZListy(w.id);
    odswiezLiczniki();
  } catch (blad) {
    toast(blad.message, { blad: true });
  }
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
  const skadId = w.folder_id ?? null;
  try {
    const wynik = await api.usun(w.id);
    toast(wynik.purged ? 'Usunięto trwale' : 'Przeniesiono do kosza', {
      ikonaNazwa: 'trash',
      // Z kosza wiadomość znika bezpowrotnie, więc nie obiecujemy cofnięcia, którego nie ma.
      cofnij: wynik.purged ? null : () => przywrocDoFolderu(w.id, skad, skadId),
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
  zamknijBoczny();
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
    // Pisanie w polu szukania wraca do zwykłego trybu: tytuł i lista folderu.
    if (stan.kryteria) {
      filtry.wyczyscTryb();
      odswiezTytul();
    }
    stan.q = szukajInput.value.trim();
    odswiezListe();
  }, 300);
});

szukajInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(zegarSzukania);
    if (stan.kryteria) {
      filtry.wyczyscTryb();
      odswiezTytul();
    }
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

// Wyniki filtrów to tryb listy: wyłącza zwykłe szukanie, a kończy go nawigacja
// do folderu, „Wyczyść" w panelu albo powrót do pola szukania.
function szukajKryteriami(kryteria) {
  stan.kryteria = kryteria;
  stan.q = '';
  szukajInput.value = '';
  szukajWyczysc.hidden = true;
  stan.wybranaId = null;
  stan.otwarta = null;
  pokazPustyCzytnik();
  odswiezTytul();
  odswiezListe();
}

// --- Ustawienia i pomoc ---------------------------------------------------------------

function otworzUstawienia() {
  formularzUstawien.imie.value = stan.user.name;
  formularzUstawien.podpis.value = stan.user.signature;
  formularzUstawien.motyw.value = stan.user.theme;
  odswiezAliasy();
  odswiezZespoly();
  odswiezPrzekierowanie();
  reguly.odswiez();
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
  else opis.textContent = limit == null ? '' : `Możesz utworzyć maksymalnie ${limit}.`;
  opis.hidden = !opis.textContent;
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

// --- Skrzynki zespołowe -----------------------------------------------------------

// Tylko do odczytu: skład prowadzi administrator. Bez zespołów sekcja znika,
// bo pusty stan, którego nie da się kliknąć, jest samym szumem.
async function odswiezZespoly() {
  const sekcja = document.querySelector('[data-zespoly-sekcja]');
  try {
    const { teams } = await api.zespoly();
    sekcja.hidden = !teams.length;
    if (!teams.length) return;
    const lista = document.querySelector('[data-zespoly]');
    lista.replaceChildren(
      ...teams.map((zespol) =>
        el('li', { class: 'zespol' },
          el('span', { class: 'zespol-info' },
            el('span', { class: 'zespol-nazwa' }, zespol.name),
            el('span', { class: 'zespol-adres' }, zespol.address)
          ),
          el('span', { class: `zespol-prawo${zespol.can_send ? ' moze-wysylac' : ''}` },
            zespol.can_send ? 'odbiór i wysyłka' : 'odbiór')
        )
      )
    );
  } catch {
    sekcja.hidden = true; // przynależność to informacja dodatkowa, nie blokuje ustawień
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
  szukajKryteriami,
  otworzFiltry: () => filtry.otworz(),
  nazwyFolderow: NAZWY,
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
const filtry = initFiltry(app, foldery);
const reguly = initReguly(app, foldery, filtry);
initSkroty(app, kompozycja);

// „Nowy folder" i przyszłe przyciski stylowane na .folder nie są folderami:
// bez [data-folder] wpięłyby się tu i wołały przejdzDoFolderu(undefined).
for (const przycisk of document.querySelectorAll('.folder[data-folder]')) {
  przycisk.addEventListener('click', () => przejdzDoFolderu(przycisk.dataset.folder));
}

document.querySelector('[data-akcja="napisz"]').addEventListener('click', napisz);
// Ustawienia mogły zmienić aliasy; otwarte okno pisania widzi zmianę od razu.
ustawieniaDialog.addEventListener('close', () => kompozycja.odswiezNadawcow());
document.querySelector('[data-akcja="odswiez"]').addEventListener('click', () => odswiezListe());
document.querySelector('[data-akcja="ustawienia"]').addEventListener('click', otworzUstawienia);
document.querySelector('[data-akcja="pomoc"]').addEventListener('click', otworzPomoc);
document.querySelector('[data-akcja="wyloguj"]').addEventListener('click', wyloguj);

for (const przycisk of document.querySelectorAll('[data-akcja="zamknij-modal"]')) {
  przycisk.addEventListener('click', () => przycisk.closest('dialog').close());
}

zamykajDialogiTlem();
initDymki();

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
    if (stan.folder === 'inbox' && !stan.q && !stan.kryteria && !kompozycja.otwarte() && listaEl.scrollTop === 0) {
      odswiezListe({ cicho: true });
    }
  }, 30_000);
}

start();
