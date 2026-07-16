// Edytor treści: pasek formatowania nad polem contenteditable + czyszczenie HTML.
// Czyszczenie działa przy zapisie ORAZ przy każdym renderze, więc obcy HTML nigdy
// nie trafia do DOM bez przejścia przez listę dozwolonych znaczników.

import { el, ikona, toast } from './ui.js';

// --- Czyszczenie HTML ----------------------------------------------------------

const DOZWOLONE_TAGI = new Set([
  'P', 'DIV', 'BR', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE',
  'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'H1', 'H2', 'H3',
  'FONT', 'IMG', 'HR',
]);
// Elementy wycinane razem z zawartością: ich wnętrze nie jest treścią listu.
const WYTNIJ_W_CALOSCI = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE']);
const DOZWOLONE_STYLE = [
  'color', 'background-color', 'font-family', 'font-size', 'font-weight',
  'font-style', 'text-decoration', 'text-align',
];

function bezpiecznyUrl(surowy, { obrazek = false } = {}) {
  const s = String(surowy ?? '').trim();
  if (obrazek) return /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i.test(s) ? s : null;
  let url;
  try {
    url = new URL(s);
  } catch {
    return null; // tylko adresy bezwzględne
  }
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') return url.href;
  return null;
}

function czyscAtrybuty(wezel) {
  const tag = wezel.tagName;
  for (const atrybut of [...wezel.attributes]) {
    const nazwa = atrybut.name.toLowerCase();
    if (nazwa === 'style') continue; // przepisywany niżej
    if (tag === 'A' && nazwa === 'href') continue;
    if (tag === 'IMG' && ['src', 'alt', 'width', 'height'].includes(nazwa)) continue;
    if (tag === 'FONT' && ['color', 'face', 'size'].includes(nazwa)) continue;
    if ((tag === 'DIV' || tag === 'P') && nazwa === 'align') continue;
    wezel.removeAttribute(atrybut.name);
  }

  if (wezel.getAttribute('style') != null) {
    const pary = [];
    for (const wlasciwosc of DOZWOLONE_STYLE) {
      const wartosc = wezel.style.getPropertyValue(wlasciwosc);
      if (wartosc && !/url\s*\(|expression/i.test(wartosc)) pary.push(`${wlasciwosc}: ${wartosc}`);
    }
    if (pary.length) wezel.setAttribute('style', pary.join('; '));
    else wezel.removeAttribute('style');
  }

  if (tag === 'A') {
    const href = bezpiecznyUrl(wezel.getAttribute('href'));
    if (href) {
      wezel.setAttribute('href', href);
      wezel.setAttribute('target', '_blank');
      wezel.setAttribute('rel', 'noopener noreferrer');
    } else {
      wezel.removeAttribute('href');
    }
  }

  if (tag === 'IMG') {
    const src = bezpiecznyUrl(wezel.getAttribute('src'), { obrazek: true });
    if (!src) return wezel.remove();
    wezel.setAttribute('src', src);
  }
}

function czyscDrzewo(rodzic) {
  for (const wezel of [...rodzic.childNodes]) {
    if (wezel.nodeType === Node.TEXT_NODE) continue;
    if (wezel.nodeType !== Node.ELEMENT_NODE) {
      wezel.remove(); // komentarze, instrukcje przetwarzania
      continue;
    }
    if (WYTNIJ_W_CALOSCI.has(wezel.tagName)) {
      wezel.remove();
      continue;
    }
    if (!DOZWOLONE_TAGI.has(wezel.tagName)) {
      // Obcy znacznik znika, jego dzieci zostają (np. <article> → sama treść).
      czyscDrzewo(wezel);
      wezel.replaceWith(...wezel.childNodes);
      continue;
    }
    czyscAtrybuty(wezel);
    if (wezel.isConnected) czyscDrzewo(wezel);
  }
}

export function sanitizeHtml(brudny) {
  const doc = new DOMParser().parseFromString(String(brudny ?? ''), 'text/html');
  czyscDrzewo(doc.body);
  return doc.body.innerHTML;
}

export function eskapujHtml(tekst) {
  return String(tekst ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function tekstNaHtml(tekst) {
  return eskapujHtml(tekst).replace(/\r?\n/g, '<br>');
}

// --- Edytor --------------------------------------------------------------------

const MAX_OBRAZEK_BAJTOW = 1.5 * 1024 * 1024;

const KOLORY = [
  ['#1a1a1a', 'Atrament'],
  ['#b3261e', 'Czerwony'],
  ['#a05a00', 'Bursztyn'],
  ['#1b7a2f', 'Zielony'],
  ['#0b57d0', 'Niebieski'],
  ['#6d28a8', 'Fiolet'],
  ['#6b7280', 'Popiel'],
];

export function initEdytor() {
  const edytor = document.querySelector('[data-edytor]');
  const pasek = document.querySelector('[data-pasek-edytora]');
  const obrazInput = document.querySelector('[data-obraz-input]');

  let zapamietanyZakres = null;

  function zapamietajZakres() {
    const sel = getSelection();
    if (sel.rangeCount && edytor.contains(sel.anchorNode)) {
      zapamietanyZakres = sel.getRangeAt(0).cloneRange();
    }
  }

  function przywrocZakres() {
    edytor.focus();
    if (!zapamietanyZakres) return;
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(zapamietanyZakres);
  }

  function wykonaj(cmd, wartosc = null) {
    edytor.focus();
    document.execCommand(cmd, false, wartosc);
    odswiezStanPaska();
  }

  // Przycisk nie może kraść zaznaczenia z edytora.
  pasek.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) e.preventDefault();
  });

  pasek.addEventListener('click', (e) => {
    const przycisk = e.target.closest('[data-cmd]');
    if (!przycisk) return;
    const cmd = przycisk.dataset.cmd;
    if (cmd === 'blockquote') {
      const obecny = document.queryCommandValue('formatBlock').toLowerCase();
      wykonaj('formatBlock', obecny === 'blockquote' ? '<div>' : '<blockquote>');
    } else if (cmd === 'usunFormat') {
      wykonaj('removeFormat');
      document.execCommand('unlink');
      document.execCommand('formatBlock', false, '<div>');
    } else {
      wykonaj(cmd);
    }
  });

  // --- Krój i rozmiar pisma --------------------------------------------------------

  const wyborCzcionki = pasek.querySelector('[data-czcionka]');
  const wyborRozmiaru = pasek.querySelector('[data-rozmiar]');

  wyborCzcionki.addEventListener('change', () => wykonaj('fontName', wyborCzcionki.value));

  // `execCommand('fontSize')` zna tylko skalę 1–7, a chcemy punkty. Wołamy je więc
  // z wartością-znacznikiem i od razu przepisujemy powstałe <font size="7">
  // na <span style="font-size: Npt">. Przy zwiniętym zaznaczeniu przeglądarka
  // niczego jeszcze nie opakowuje; znacznik pojawi się dopiero, gdy użytkownik
  // zacznie pisać, więc podmiana czeka na najbliższy `input`.
  const ZNACZNIK_ROZMIARU = '7';
  let oczekujacyRozmiar = null;

  function przepiszZnaczniki(pt) {
    const znalezione = edytor.querySelectorAll(`font[size="${ZNACZNIK_ROZMIARU}"]`);
    for (const font of znalezione) {
      // Przeglądarka dokłada `size` do istniejącego <font>, więc mógł już nieść
      // krój albo kolor. Zdejmujemy sam znacznik i zostawiamy resztę w środku.
      font.removeAttribute('size');
      const span = el('span', { style: `font-size: ${pt}pt` });
      font.replaceWith(span);
      if (font.attributes.length) span.append(font);
      else span.append(...font.childNodes);
    }
    return znalezione.length > 0;
  }

  function ustawRozmiar(pt) {
    edytor.focus();
    document.execCommand('fontSize', false, ZNACZNIK_ROZMIARU);
    oczekujacyRozmiar = przepiszZnaczniki(pt) ? null : pt;
    odswiezStanPaska();
  }

  wyborRozmiaru.addEventListener('change', () => ustawRozmiar(Number(wyborRozmiaru.value)));

  // Leci przed autozapisem (ten słucha na formularzu wyżej), więc do zapisu
  // trafia już przepisany styl, nigdy surowy znacznik.
  edytor.addEventListener('input', () => {
    if (oczekujacyRozmiar != null && przepiszZnaczniki(oczekujacyRozmiar)) oczekujacyRozmiar = null;
  });

  // --- Dymki: kolor i link -------------------------------------------------------

  let otwartyDymek = null;

  function zamknijDymek() {
    otwartyDymek?.remove();
    otwartyDymek = null;
  }

  function otworzDymek(zawartosc, kotwica) {
    zamknijDymek();
    otwartyDymek = el('div', { class: 'edytor-dymek' }, ...zawartosc);
    kotwica.insertAdjacentElement('afterend', otwartyDymek);
  }

  document.addEventListener('pointerdown', (e) => {
    if (otwartyDymek && !e.target.closest('.edytor-dymek') && !e.target.closest('[data-narzedzie]')) {
      zamknijDymek();
    }
  });

  pasek.querySelector('[data-narzedzie="kolor"]').addEventListener('click', (e) => {
    if (otwartyDymek) return zamknijDymek();
    zapamietajZakres();
    const kotwica = e.currentTarget;
    otworzDymek(
      KOLORY.map(([kolor, nazwa]) =>
        el('button', {
          type: 'button',
          class: 'edytor-probka',
          style: `background:${kolor}`,
          title: nazwa,
          'aria-label': `Kolor: ${nazwa}`,
          onclick: () => {
            przywrocZakres();
            wykonaj('foreColor', kolor);
            zamknijDymek();
          },
        })
      ),
      kotwica
    );
  });

  pasek.querySelector('[data-narzedzie="link"]').addEventListener('click', (e) => {
    if (otwartyDymek) return zamknijDymek();
    zapamietajZakres();
    const kotwica = e.currentTarget;
    const pole = el('input', {
      type: 'url',
      class: 'edytor-dymek-input',
      placeholder: 'https://…',
      'aria-label': 'Adres odnośnika',
    });
    const wstaw = () => {
      const href = bezpiecznyUrl(pole.value.trim() && !/^[a-z]+:/i.test(pole.value.trim()) ? `https://${pole.value.trim()}` : pole.value.trim());
      if (!href) return toast('Podaj poprawny adres (http, https albo mailto).', { blad: true });
      przywrocZakres();
      const sel = getSelection();
      if (!sel.rangeCount || sel.isCollapsed) {
        const a = el('a', { href }, href);
        document.execCommand('insertHTML', false, a.outerHTML);
      } else {
        document.execCommand('createLink', false, href);
      }
      zamknijDymek();
    };
    pole.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        wstaw();
      }
    });
    otworzDymek([pole, el('button', { type: 'button', class: 'edytor-dymek-btn', onclick: wstaw }, 'Wstaw')], kotwica);
    pole.focus();
  });

  // --- Obrazki (jako data:URL w treści) -------------------------------------------

  pasek.querySelector('[data-narzedzie="obraz"]').addEventListener('click', () => {
    zapamietajZakres();
    obrazInput.click();
  });

  obrazInput.addEventListener('change', () => {
    const plik = obrazInput.files?.[0];
    obrazInput.value = '';
    if (!plik) return;
    if (!/^image\//.test(plik.type)) return toast('To nie wygląda na obrazek.', { blad: true });
    if (plik.size > MAX_OBRAZEK_BAJTOW) {
      return toast('Obrazek w treści może mieć najwyżej 1,5 MB. Większe pliki dodaj jako załącznik.', { blad: true });
    }
    const czytnik = new FileReader();
    czytnik.onload = () => {
      przywrocZakres();
      document.execCommand('insertImage', false, czytnik.result);
      edytor.dispatchEvent(new Event('input', { bubbles: true }));
    };
    czytnik.readAsDataURL(plik);
  });

  // --- Stan paska (pogrubienie aktywne, krój i rozmiar spod kursora) ----------------

  const STANOWE = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'];

  // Bazowy krój edytora jest bezszeryfowy, więc wszystko, czego nie rozpoznamy
  // jako szeryfowe albo maszynowe, pokazujemy jako „Bezszeryfowy".
  function krojZRodziny(rodzina) {
    const f = rodzina.toLowerCase();
    if (/courier|consolas|mono/.test(f)) return 'Courier New';
    // Nazwy krojów szeryfowych zwykle nie zawierają słowa „serif" (Georgia, Times),
    // a „sans-serif" w stosie oznacza dokładnie odwrotność, stąd wykluczenie.
    if (/georgia|times|garamond|cambria|serif/.test(f) && !/sans-serif/.test(f)) return 'Georgia';
    return 'Arial';
  }

  const ROZMIARY = [...wyborRozmiaru.options].map((o) => Number(o.value));

  function rozmiarZPikseli(px) {
    const pt = px * 0.75; // 1pt = 1/72 cala, 1px CSS = 1/96 cala
    return ROZMIARY.reduce((a, b) => (Math.abs(b - pt) < Math.abs(a - pt) ? b : a));
  }

  function elementPrzyKursorze() {
    const sel = getSelection();
    const wezel = sel?.anchorNode;
    if (!wezel) return null;
    if (wezel.nodeType === Node.TEXT_NODE) return wezel.parentElement;
    // Zaznaczenie zaczepione o kontener („zaznacz wszystko", świeżo po execCommand):
    // krój i rozmiar niesie dziecko spod offsetu, nie sam kontener.
    const dziecko = wezel.childNodes[sel.anchorOffset] ?? wezel.lastChild;
    if (!dziecko) return wezel; // pusty edytor: styl bazowy
    return dziecko.nodeType === Node.TEXT_NODE ? dziecko.parentElement : dziecko;
  }

  function odswiezStanPaska() {
    if (!edytor.contains(getSelection()?.anchorNode)) return;
    for (const cmd of STANOWE) {
      const przycisk = pasek.querySelector(`[data-cmd="${cmd}"]`);
      let stan = false;
      try {
        stan = document.queryCommandState(cmd);
      } catch {
        /* starsze silniki */
      }
      przycisk?.classList.toggle('aktywna', stan);
    }

    const elem = elementPrzyKursorze();
    if (!elem) return;
    const styl = getComputedStyle(elem);
    wyborCzcionki.value = krojZRodziny(styl.fontFamily);
    // Znacznik rozmiaru bywa jeszcze nieprzepisany; wtedy pokazujemy wybór użytkownika.
    wyborRozmiaru.value = String(oczekujacyRozmiar ?? rozmiarZPikseli(parseFloat(styl.fontSize)));
  }

  document.addEventListener('selectionchange', () => {
    if (document.activeElement === edytor) odswiezStanPaska();
  });

  // --- API dla kompozycji -----------------------------------------------------------

  return {
    ustaw({ html = '', tekst = '' } = {}) {
      edytor.innerHTML = html ? sanitizeHtml(html) : tekstNaHtml(tekst);
      zapamietanyZakres = null;
      oczekujacyRozmiar = null;
      zamknijDymek();
      // Domyślne wartości bierzemy z samego edytora, więc select pokazuje to,
      // czym naprawdę pisze użytkownik, nawet gdy zmieni się CSS.
      const styl = getComputedStyle(edytor);
      wyborCzcionki.value = krojZRodziny(styl.fontFamily);
      wyborRozmiaru.value = String(rozmiarZPikseli(parseFloat(styl.fontSize)));
    },
    pobierzHtml() {
      if (this.pusty()) return '';
      return sanitizeHtml(edytor.innerHTML);
    },
    pobierzTekst() {
      return edytor.innerText.replace(/ /g, ' ').replace(/\n+$/, '');
    },
    pusty() {
      return !edytor.textContent.trim() && !edytor.querySelector('img');
    },
    fokus({ naPoczatku = false } = {}) {
      edytor.focus();
      if (naPoczatku) {
        const zakres = document.createRange();
        zakres.selectNodeContents(edytor);
        zakres.collapse(true);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(zakres);
      }
    },
    zamknijDymki: zamknijDymek,
    maDymek: () => !!otwartyDymek,
  };
}
