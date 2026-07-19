// Renderer treści listu przychodzącego.
//
// Podział ról: reguly.js trzyma polityki (czyste, testowalne), tutaj jest
// wyłącznie chodzenie po drzewie i CSSOM. Oba parsery bierzemy od
// przeglądarki: DOMParser dla HTML, CSSStyleSheet dla CSS. To ten sam parser,
// który potem to renderuje, więc nie ma rozbieżności, na której żyje mXSS.
//
// To NIE jest sanitizer kompozytora. edytor.js/sanitizeHtml pilnuje tego, co
// użytkownik pisze, i zostaje nietknięty.

import { wstawTrescZLinkami } from './ui.js';
import {
  DOZWOLONE_TAGI, WYTNIJ_W_CALOSCI, dozwoloneAtrybuty,
  bezpiecznyLink, ocenUrlObrazka, czyDeklaracjaZakazana, zakresujSelektor,
} from './reguly.js';

let licznik = 0;

const URL_ZDALNY = /url\(\s*['"]?\s*(https?:|\/\/)/i;

export function renderujTresc(kontener, wiadomosc, opcje = {}) {
  kontener.replaceChildren();
  kontener.classList.remove('cz-body-list');
  kontener.removeAttribute('id');

  if (!wiadomosc.body_html) {
    wstawTrescZLinkami(kontener, wiadomosc.body);
    return { zdalne: 0 };
  }
  try {
    return renderujHtml(kontener, wiadomosc, opcje);
  } catch (err) {
    // Fallback jest jeden i zawsze ten sam: czytelny tekst zamiast białej plamy.
    console.error('[tresc] render HTML nie wyszedł, wracam do tekstu', err);
    kontener.replaceChildren();
    kontener.classList.remove('cz-body-list');
    wstawTrescZLinkami(kontener, wiadomosc.body);
    return { zdalne: 0 };
  }
}

function renderujHtml(kontener, wiadomosc, { cid = {}, obrazki = false }) {
  const kontekst = { id: `list-${++licznik}`, cid, obrazki, zdalne: 0 };
  const doc = new DOMParser().parseFromString(wiadomosc.body_html, 'text/html');

  // Treść <style> zbieramy zanim czyscDrzewo usunie te elementy z drzewa.
  const zrodlaStylow = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '');
  czyscDrzewo(doc.body, kontekst);
  const arkusz = przetworzStyle(zrodlaStylow, kontekst);

  kontener.id = kontekst.id;
  kontener.classList.add('cz-body-list');
  if (arkusz) {
    const styl = document.createElement('style');
    styl.textContent = arkusz;
    kontener.append(styl);
  }
  kontener.append(...doc.body.childNodes);
  return { zdalne: kontekst.zdalne };
}

// --- Drzewo --------------------------------------------------------------------

function czyscDrzewo(rodzic, kontekst) {
  for (const wezel of [...rodzic.childNodes]) {
    if (wezel.nodeType === Node.TEXT_NODE) continue;
    if (wezel.nodeType !== Node.ELEMENT_NODE) {
      wezel.remove(); // komentarze, instrukcje przetwarzania
      continue;
    }
    const tag = wezel.tagName;
    if (WYTNIJ_W_CALOSCI.has(tag) || tag === 'STYLE') {
      wezel.remove(); // STYLE przerobiliśmy już przez CSSOM
      continue;
    }
    if (!DOZWOLONE_TAGI.has(tag)) {
      // Obcy znacznik znika, jego dzieci zostają (np. <article> → sama treść).
      czyscDrzewo(wezel, kontekst);
      wezel.replaceWith(...wezel.childNodes);
      continue;
    }
    czyscAtrybuty(wezel, kontekst);
    if (wezel.isConnected) czyscDrzewo(wezel, kontekst);
  }
}

function czyscAtrybuty(wezel, kontekst) {
  const tag = wezel.tagName;
  const dozwolone = dozwoloneAtrybuty(tag);
  for (const atrybut of [...wezel.attributes]) {
    const nazwa = atrybut.name.toLowerCase();
    if (nazwa.startsWith('on') || !dozwolone.includes(nazwa)) wezel.removeAttribute(atrybut.name);
  }

  if (wezel.hasAttribute('style')) czyscStylInline(wezel, kontekst);

  if (tag === 'A') {
    const href = bezpiecznyLink(wezel.getAttribute('href'));
    if (href) {
      wezel.setAttribute('href', href);
      wezel.setAttribute('target', '_blank');
      wezel.setAttribute('rel', 'noopener noreferrer');
    } else {
      wezel.removeAttribute('href');
    }
  }

  if (tag === 'IMG') {
    bramkujObrazek(wezel, kontekst, { atrybut: 'src', schowek: 'data-src', poOdrzuceniu: (w) => w.remove() });
  }

  // Atrybut HTML `background` (TABLE/TD/TH) niesie ten sam zdalny piksel śledzący
  // co IMG.src, tylko innym kanałem — Chrome go honoruje, więc bez bramki blokada
  // obrazków z Task 7 by go omijała. Po filtrze atrybutów `background` zostaje
  // wyłącznie na tagach z jego allowlisty, więc hasAttribute zastępuje sprawdzanie
  // tagu. Odrzucenie kasuje sam atrybut, nie węzeł: komórka to nośnik treści.
  if (wezel.hasAttribute('background')) {
    bramkujObrazek(wezel, kontekst, {
      atrybut: 'background',
      schowek: 'data-background',
      poOdrzuceniu: (w) => w.removeAttribute('background'),
    });
  }
}

// Wspólna bramka zdalnego obrazka: IMG.src i atrybut HTML `background`. Ta sama
// polityka co ocenUrlObrazka — cid rozwiązujemy przez mapę, data: zostaje, zdalne
// chowamy do atrybutu-schowka (data-src / data-background) pod belkę „Pokaż obrazki"
// z Task 7 i doliczamy do kontekst.zdalne. Różni je tylko reakcja na URL nie do
// przyjęcia, stąd wstrzykiwane `poOdrzuceniu`: dla obrazka kasujemy węzeł (to sam
// nośnik), dla tła tylko atrybut (komórka tabeli niesie treść).
function bramkujObrazek(wezel, kontekst, { atrybut, schowek, poOdrzuceniu }) {
  const ocena = ocenUrlObrazka(wezel.getAttribute(atrybut));
  if (ocena.rodzaj === 'cid') {
    const url = kontekst.cid[ocena.cid];
    if (url) wezel.setAttribute(atrybut, url);
    else wezel.removeAttribute(atrybut); // nieznany cid: złamany obrazek z alt, nie błąd renderu
    return;
  }
  if (ocena.rodzaj === 'ok') {
    wezel.setAttribute(atrybut, ocena.url);
    return;
  }
  if (ocena.rodzaj === 'zdalny') {
    kontekst.zdalne += 1;
    wezel.removeAttribute(atrybut);
    wezel.setAttribute(schowek, ocena.url);
    return;
  }
  poOdrzuceniu(wezel); // 'odrzuc'
}

function czyscStylInline(wezel, kontekst) {
  oczyscDeklaracje(wezel.style, kontekst);
  if (!wezel.getAttribute('style')) wezel.removeAttribute('style');
}

function oczyscDeklaracje(deklaracje, kontekst) {
  for (const nazwa of [...deklaracje]) {
    const wartosc = deklaracje.getPropertyValue(nazwa);
    if (czyDeklaracjaZakazana(nazwa, wartosc)) {
      deklaracje.removeProperty(nazwa);
      continue;
    }
    // Tło z url() to ten sam piksel śledzący co <img>, więc podlega tej samej
    // blokadzie. Bez belki, bo tła nie da się dołożyć po fakcie sensownie.
    if (URL_ZDALNY.test(wartosc)) {
      kontekst.zdalne += 1;
      deklaracje.removeProperty(nazwa);
    }
  }
}

// --- CSSOM ---------------------------------------------------------------------

function przetworzStyle(zrodla, kontekst) {
  const czesci = [];
  for (const zrodlo of zrodla) {
    const arkusz = new CSSStyleSheet();
    try {
      arkusz.replaceSync(zrodlo);
    } catch {
      continue; // zepsuty arkusz pomijamy w całości
    }
    for (const regula of arkusz.cssRules) {
      const tekst = przetworzRegule(regula, kontekst);
      if (tekst) czesci.push(tekst);
    }
  }
  return czesci.join('\n');
}

function przetworzRegule(regula, kontekst) {
  if (regula instanceof CSSStyleRule) {
    oczyscDeklaracje(regula.style, kontekst);
    if (!regula.style.length) return '';
    return `${zakresujSelektor(regula.selectorText, kontekst.id)} { ${regula.style.cssText} }`;
  }
  if (regula instanceof CSSMediaRule) {
    const wewnetrzne = [...regula.cssRules]
      .map((r) => przetworzRegule(r, kontekst))
      .filter(Boolean)
      .join('\n');
    if (!wewnetrzne) return '';
    return `@media ${regula.conditionText} { ${wewnetrzne} }`;
  }
  // @import i @font-face to sieć, czyli śledzenie. @keyframes i reszta
  // odpadają, bo nazwy animacji zderzałyby się z animacjami aplikacji.
  return '';
}
