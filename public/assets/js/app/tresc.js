// Renderer treści listu przychodzącego.
//
// Podział ról: reguly.js trzyma polityki (czyste, testowalne), tutaj jest
// wyłącznie chodzenie po drzewie i CSSOM. Oba parsery bierzemy od przeglądarki:
// DOMParser dla HTML, CSSStyleSheet dla CSS.
//
// HTML idzie bez drugiego parsowania: przenosimy gotowe węzły i nigdy nie serializujemy
// drzewa z powrotem. Nie ma więc rozbieżności między parserem sanityzującym a
// renderującym, czyli szczeliny, w której żyje mXSS.
//
// Dla CSS jest ODWROTNIE i trzeba to powiedzieć wprost, bo stało tu wcześniej, że
// rozbieżności nie ma w ogóle: przetworzRegule skleja selectorText z cssText w łańcuch,
// który wstrzykujemy do <style>, więc przeglądarka parsuje go DRUGI raz. To pełna runda
// serializacja→ponowne parsowanie i mogłaby być miejscem ucieczki z klamry. Nie jest,
// z dwóch zmierzonych powodów:
// · Niezbalansowana klamra nie trafia do wartości — kończy regułę już przy PIERWSZYM
//   parsowaniu. `.x{--a:foo} #app{display:none} .z{color:red}` to dla parsera trzy osobne
//   reguły najwyższego poziomu, a my zakresujemy każdą z osobna, więc wszystkie trzy
//   wychodzą spod `#list-…`. Nie ma czego przemycić „w środku" wartości.
// · Klamry, które w wartości przeżywają, są zbalansowane (`a{b}c`), w cudzysłowie (`"}"`)
//   albo w ucieczce (`foo\}`), a cssText serializuje je z powrotem w tej samej postaci —
//   drugie parsowanie czyta je jako dane, nie jako strukturę. Tak samo selectorText:
//   `[a="} #app{"]` wraca w cudzysłowie.
// Zmieniając cokolwiek w przetworzRegule, przemierz to ponownie: to jedyne miejsce,
// w którym tekst CSS wraca do parsera.
//
// To NIE jest sanitizer kompozytora. edytor.js/sanitizeHtml pilnuje tego, co
// użytkownik pisze, i zostaje nietknięty.

import { wstawTrescZLinkami } from './ui.js';
import {
  DOZWOLONE_TAGI, WYTNIJ_W_CALOSCI, dozwoloneAtrybuty, bezpiecznyLink,
  ocenUrlObrazka, czyOdrzucicDeklaracje, zakresujSelektor,
} from './reguly.js';

let licznik = 0;

// Elementy wycinane w całości jako selektor przodka, do odsiania <style> z poddrzewa,
// które i tak zniknie. Małe litery obsługują obie przestrzenie nazw naraz: dla elementów
// HTML w dokumencie HTML selektor typu jest nieczuły na wielkość liter, a dla obcych
// (svg, math) jest czuły i tam nazwa lokalna jest właśnie mała.
// HEAD wypada z listy świadomie: czyscDrzewo chodzi wyłącznie po body, więc arkusz
// siedzący w <head> nigdy nie jest „poddrzewem do wycięcia" — to normalne miejsce arkusza
// w liście HTML i ma się zbierać, a odsianie go zabrałoby zwykłej poczcie style. Nie
// chodzi tu o <head> wstawiony w body: parser HTML w ogóle go tam nie wpuszcza (zmierzone:
// znacznik znika bez śladu, a jego zawartość przelatuje wprost do body), więc obrona przed
// taką postacią nie miałaby czego bronić.
const PRZODKOWIE_WYCINANYCH = [...WYTNIJ_W_CALOSCI]
  .filter((tag) => tag !== 'HEAD')
  .map((tag) => tag.toLowerCase())
  .join(', ');

export function renderujTresc(kontener, wiadomosc, opcje = {}) {
  wyczyscKontener(kontener);
  if (!wiadomosc.body_html) return renderujTekst(kontener, wiadomosc);
  try {
    return renderujHtml(kontener, wiadomosc, opcje);
  } catch (err) {
    // Fallback jest jeden i zawsze ten sam: czytelny tekst zamiast białej plamy.
    console.error('[tresc] render HTML nie wyszedł, wracam do tekstu', err);
    return renderujTekst(kontener, wiadomosc);
  }
}

// Obie ścieżki wychodzą z tego samego stanu kontenera. Fallback musi powtórzyć pełny
// reset, bo wyjątek mógł polecieć już PO ustawieniu id i klasy — a `id` zostawione na
// kontenerze z tekstem to identyfikator listu wiszący nad cudzą treścią.
function wyczyscKontener(kontener) {
  kontener.replaceChildren();
  kontener.classList.remove('cz-body-list');
  kontener.removeAttribute('id');
}

function renderujTekst(kontener, wiadomosc) {
  wyczyscKontener(kontener);
  // `?? ''`, bo list bywa sam HTML-em bez części tekstowej, a wstawTrescZLinkami robi
  // String(tekst) — bez tego użytkownik dostałby wypisane słowo „undefined".
  wstawTrescZLinkami(kontener, wiadomosc.body ?? '');
  return { zdalne: 0 };
}

function renderujHtml(kontener, wiadomosc, { cid = {}, obrazki = false }) {
  const kontekst = { id: `list-${++licznik}`, cid, obrazki, zdalne: 0 };
  const doc = new DOMParser().parseFromString(wiadomosc.body_html, 'text/html');

  // Treść <style> zbieramy zanim czyscDrzewo usunie te elementy z drzewa. Odsiewamy przy
  // tym style siedzące pod wycinanym przodkiem (`<svg><style>`): za chwilę znikną razem
  // z nim, więc ich reguły nie mają prawa trafić do arkusza. `closest` bierze też sam
  // element, ale STYLE nie jest na liście wycinanych, więc nie dopasuje się do siebie.
  const zrodlaStylow = [...doc.querySelectorAll('style')]
    .filter((s) => !s.closest(PRZODKOWIE_WYCINANYCH))
    .map((s) => s.textContent ?? '');
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

// Wszystkie polityki tagów są pisane WIELKIMI literami, bo takie tagName oddaje HTML.
// Elementy spoza HTML (`<svg>`, `<math>` i ich wnętrze) mają tagName małymi literami, więc
// bez tego kroku nie trafiały w żadną politykę: `<svg>` wpadał w gałąź rozwijającą i jego
// dzieci przeżywały. Dla HTML to no-op.
function nazwaTagu(wezel) {
  return wezel.tagName.toUpperCase();
}

function czyscDrzewo(rodzic, kontekst) {
  for (const wezel of [...rodzic.childNodes]) {
    if (wezel.nodeType === Node.TEXT_NODE) continue;
    if (wezel.nodeType !== Node.ELEMENT_NODE) {
      wezel.remove(); // komentarze, instrukcje przetwarzania
      continue;
    }
    const tag = nazwaTagu(wezel);
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
  const tag = nazwaTagu(wezel);
  const dozwolone = dozwoloneAtrybuty(tag);
  for (const atrybut of [...wezel.attributes]) {
    const nazwa = atrybut.name.toLowerCase();
    if (nazwa.startsWith('on') || !dozwolone.includes(nazwa)) wezel.removeAttribute(atrybut.name);
  }

  if (wezel.hasAttribute('style')) czyscStylInline(wezel);

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
    // Klucz podaje nadawca, więc pytamy wyłącznie o własność własną. Serwer buduje mapę
    // przez Object.create(null), ale JSON to cofa: po JSON.parse obiekt ma z powrotem
    // Object.prototype, więc `cid['toString']` oddałoby funkcję, a setAttribute wpisałby
    // jej źródło w src. `<img src="cid:toString">` to wystarczy, żeby wywołać.
    const url = Object.hasOwn(kontekst.cid, ocena.cid) ? kontekst.cid[ocena.cid] : null;
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

// Kanały bramkowane wyżej, od strony odwrotnej: atrybut-schowek → atrybut docelowy.
// Ta lista MUSI zostać zgodna z wywołaniami bramkujObrazek, bo to jest kontrakt belki
// „Pokaż obrazki": kontekst.zdalne liczy dokładnie tyle, ile pokazObrazki przywróci.
// Dołożenie trzeciego kanału do bramki bez dopisania go tutaj sprawia, że belka mówi
// o N obrazkach, przywraca mniej i znika — a razem z nią jedyna droga do reszty.
const SCHOWKI_OBRAZKOW = [
  ['data-src', 'src'],
  ['data-background', 'background'],
];

// Belka „Pokaż obrazki" przepina zaparkowane adresy w miejscu. Bez ponownego renderu,
// bo blokada siedzi w atrybucie-schowku, a nie w CSP: wystarczy zmienić nazwę atrybutu
// i przeglądarka pobiera obrazek sama.
//
// Wartości nie oceniamy drugi raz i nie musimy. Do schowka trafia wyłącznie to, co
// ocenUrlObrazka uznało za 'zdalny' (czyli http/https), a data-src przyniesione przez
// nadawcę nie ma prawa dożyć tego miejsca: filtr atrybutów w czyscAtrybuty biegnie
// PRZED bramką i żadna allowlista nie zna data-*.
export function pokazObrazki(kontener) {
  for (const [schowek, atrybut] of SCHOWKI_OBRAZKOW) {
    for (const wezel of kontener.querySelectorAll(`[${schowek}]`)) {
      wezel.setAttribute(atrybut, wezel.getAttribute(schowek));
      wezel.removeAttribute(schowek);
    }
  }
}

function czyscStylInline(wezel) {
  oczyscDeklaracje(wezel.style);
  if (!wezel.getAttribute('style')) wezel.removeAttribute('style');
}

// Polityka URL-i w CSS to allowlista funkcji z reguly.js, nie szukanie URL-i: wartość
// pada, jeśli wywołuje cokolwiek spoza listy znanych niepobierających. Dlatego CSS-owe
// `url()` nie ma tu odpowiednika bramki z <img> — nie chowamy adresu do schowka i nie
// doliczamy go do kontekst.zdalne. `zdalne` karmi belkę „Pokaż obrazki", a belka nie
// umie przywrócić tła wyciętego z deklaracji: policzone tutaj obiecywałoby N obrazków
// i pokazywało mniej. Liczymy więc wyłącznie to, co belka faktycznie przywróci —
// bramkowane atrybuty HTML (data-src, data-background).
//
// Dwie ścieżki, bo SPRAWDZAMY MODEL, KTÓRY CZYTAMY (własności przez iterator i
// getPropertyValue), A EMITUJEMY INNY ARTEFAKT (`cssText`). Dziura mieszkała dokładnie
// w tej różnicy, nie w „zapomnieliśmy o skrótach". Gdy skrót (`background`, `mask`,
// `list-style`, `border-image`, …) niesie `var()`, CSS trzyma wartość czekającą na
// podstawienie NA SKRÓCIE: iterator skrótu w ogóle nie wymienia, a wszystkie jego
// longhandy oddają `""`. Skan nie widział więc niczego i niczego nie usuwał, a `cssText`
// serializował skrót dosłownie — `--u: "http://…"; background: image-set(var(--u) 1x)`
// wychodził na zewnątrz nietknięty i ładował się.
//
// Stąd sygnał: własność WYMIENIONA przez iterator, której getPropertyValue oddaje `""`,
// jest cieniem skrótu, którego nie widzimy. Sygnał jest wąski, bo longhand z `var()`
// (`background-image: image-set(var(--u) 1x)`) oddaje swoją treść normalnie i pada już
// na allowliście w reguly.js. `""` naprawdę znaczy „stoi tu coś, czego nie umiemy
// przeczytać", a czego nie umiemy przeczytać, tego nie wolno nam wypuścić.
//
// Nie usuwamy wtedy pojedynczego longhandu: removeProperty('background-image') NIE
// zdejmuje skrótu — zostawia kalekę `background-position-x: ; …` i ładunek w custom
// property. Zdejmuje go dopiero removeProperty nazwą skrótu, której z iteratora nie mamy.
// Dlatego przebudowujemy blok: zbieramy deklaracje widoczne i dozwolone, czyścimy
// cssText, wstawiamy je z powrotem wraz z priorytetem (bez priorytetu gubimy
// `!important`). Wszystko, czego nie mogliśmy zobaczyć, znika razem z czyszczeniem.
//
// Blok bez podstawienia zostaje na starej ścieżce — usuwaniu pojedynczych złych
// deklaracji. Jest poprawna, a przebudowa przepisywałaby cssText każdej zwykłej
// wiadomości bez powodu. Kierunek awarii jest bezpieczny w obie strony: `""` z innego
// powodu niż skrót najwyżej wymusi przebudowę, a ta i tak zachowuje wyłącznie deklaracje
// widoczne i dozwolone.
function oczyscDeklaracje(deklaracje) {
  const zachowane = [];
  const doUsuniecia = [];
  let podstawienie = false;

  for (const nazwa of [...deklaracje]) {
    const wartosc = deklaracje.getPropertyValue(nazwa);
    if (wartosc === '') {
      podstawienie = true;
      continue;
    }
    if (czyOdrzucicDeklaracje(nazwa, wartosc)) doUsuniecia.push(nazwa);
    else zachowane.push([nazwa, wartosc, deklaracje.getPropertyPriority(nazwa)]);
  }

  if (!podstawienie) {
    for (const nazwa of doUsuniecia) deklaracje.removeProperty(nazwa);
    return;
  }

  deklaracje.cssText = '';
  for (const [nazwa, wartosc, priorytet] of zachowane) {
    deklaracje.setProperty(nazwa, wartosc, priorytet);
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
    oczyscDeklaracje(regula.style);
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
