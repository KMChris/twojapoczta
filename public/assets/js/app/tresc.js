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
  ocenUrlObrazka, czyOdrzucicDeklaracje, zakresujSelektor, rozstrzygnijMedia,
  znajdzCytatyWTekscie, zostajeCosWidocznego, liczbaTagow,
} from './reguly.js';
import { rgbNaOklch, odwrocJasnosc, parsujRgb, zapiszRgb } from './kolor.js';

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

// Limit głębokości rekurencji czyscDrzewo jest REALNĄ obroną także w Blinku — i to jest trzecia
// wersja tego komentarza, bo dwie poprzednie kłamały w przeciwne strony. Nie jest prawdą, że
// „chroni wydajność" (zmierzony DoS renderu siedzi w PARSERZE, nie tutaj: parseFromString zjada
// praktycznie cały czas renderu i to jego bramkuje MAX_TAGI niżej). Ale nie jest też prawdą, że
// „Blink i tak capuje głębokość drzewa na ~511, więc limit jest tylko na wypadek innego silnika".
// Cap 511 obejmuje WYŁĄCZNIE część elementów. Zmierzone (maks. głębokość po CAŁYM drzewie, nie
// po firstElementChild — poprzedni pomiar mylił się właśnie przez tamtą metodę):
//   <div> ×8000        -> 511    (capowane)     <table><tr><td> ×2000 -> 2383  (NIE capowane)
//   <blockquote> ×8000 -> 511    (capowane)     <a><div> ×4000        -> 4000  (NIE capowane)
//   <ul><li> ×4000     -> 511    (capowane)     <span> ×8000          -> 511   (capowane)
// Co gorsza te struktury są osiągalne POD progiem MAX_TAGI, bo dają dwa-trzy tagi na poziom:
// `<a><div>` ×8000 to dokładnie 16 000 „<" i drzewo głębokie na 8000, a `<table><tr><td>` ×5333
// to 15 999 „<" i głębokość 5716 (zmierzone). Bez tego limitu czyscDrzewo rekurowałoby więc
// tysiące poziomów na ładunku, który strażnik tagów przepuszcza.
// Czy to sięga stosu: rekurencja o kształcie czyscDrzewo przeszła 8000 poziomów na sparsowanym
// drzewie (5/5 prób), ale na drzewie zbudowanym przez DOM API rzucała RangeError już przy 8000 —
// czyli te głębokości leżą DOKŁADNIE na granicy stosu V8 i po której stronie wypadną, zależy od
// szczegółów, na które nie mamy wpływu. Limit zdejmuje to pytanie: głębokość renderu jest
// deterministyczna, a RangeError złapany przez renderujTresc zrzucałby list do gołego tekstu.
// 256 z dużym zapasem nad uczciwą pocztą (nawet gęsto zagnieżdżone tabele newsletterów idą rzędu
// kilkudziesięciu poziomów). Za limitem czyscDrzewo ucina całe poddrzewo.
const MAX_GLEBOKOSC = 256;

// Twardy limit liczby tagów (znaków „<") w body_html, sprawdzany PRZED parsowaniem — tu, nie
// w czyscDrzewo, siedzi zmierzony DoS. parseFromString to ~cały czas renderu, a jego koszt
// rośnie kwadratowo z zagnieżdżeniem: 120 tys. „<" (60 tys. zagnieżdżonych <div>) wiesza kartę
// na ~13 s. Bajtowy limit serwera (2 MB, server/mail.js) tego nie łapie — taki ładunek to
// tylko ~645 KB. Więc bramkujemy gęstość tagów: powyżej progu w ogóle nie parsujemy, dajemy
// tekst. 16000 dobrane pomiarem z dwóch stron naraz:
// · Od góry (koszt AT progu): przy DOKŁADNIE 16 tys. „<" najgorsze struktury kosztują znacznie
//   więcej, niż stało tu wcześniej („~205 ms", „trzymamy pod ~250 ms" — obie liczby były
//   nieprawdziwe). Zmierzone renderujTresc: `<b>x` ×16000 → 540-553 ms, niedomknięte `<div>`
//   ×16000 → ~571 ms, `<a><div>` ×8000 → ~397 ms, domknięte zagnieżdżone `<div>` ×8000 →
//   ~211 ms, płaskie `<p>x</p>` ×8000 → ~28 ms. Uczciwie więc: strażnik NIE trzyma najgorszego
//   przypadku pod ~250 ms, tylko sprowadza go poniżej sekundy (~0,55-0,6 s) — zamiast ~13 s,
//   które daje ten sam ładunek bez strażnika. Tyle wystarczy, żeby karta nie wyglądała na
//   zawieszoną, a niżej progu nie schodzimy, bo zaczyna gubić realną pocztę (poniżej).
// · Od dołu (uczciwa poczta): realny newsletter ~2400 tagów parsuje się ~2 ms, a bardzo
//   złożony sięga ~6-8 tys.; 16000 to ~2× tego sufitu, z zapasem nad prawdziwą pocztą.
// Liczymy „<", więc próg celuje w najgorszy przypadek (zagnieżdżenie); płaska poczta o tej
// samej liczbie tagów parsuje się liniowo i tanio. Cena proxy: bardzo duży PŁASKI list
// (>16 tys. tagów, np. 1000-wierszowy newsletter ~18 tys.) też zejdzie do tekstu — rzadkie i
// degraduje się czytelnie, a podniesienie progu wpuściłoby zagnieżdżony ładunek 20-30 tys.
// tagów wiszący 300-700 ms. Licznik: liczbaTagow w reguly.js.
const MAX_TAGI = 16000;

// Twardy limit liczby reguł CSS przemielanych z JEDNEGO listu. MAX_TAGI go nie zastąpi i to
// jest sedno: cały arkusz mieści się w jednym <style>, czyli w 2-6 znakach „<", więc strażnik
// gęstości tagów przepuszcza go bez mrugnięcia (zmierzone: 160 tys. reguł `aN{color:red}` to
// 2,64 MB i DOKŁADNIE 4 tagi). Koszt nie siedzi przy tym w przeglądarce, tylko w naszym kodzie:
// samo `replaceSync` na tych 160 tys. reguł to 166 ms, a cały renderujTresc 1771 ms w jasnym
// i 5449 ms w ciemnym — reszta to przetworzRegule per reguła (oczyscDeklaracje + zakresujSelektor,
// a w ciemnym jeszcze przepiszArkusz/przepiszDeklaracje). Budżet jest ZBIORCZY na cały list, nie
// per arkusz, bo rozbicie ładunku na 50 arkuszy po 5000 reguł kosztuje 7875 ms (zmierzone) i
// limit liczony osobno dla każdego arkusza przepuściłby je wszystkie.
// 5000 dobrane pomiarem z dwóch stron naraz:
// · Od góry (koszt AT progu): samo przetworzenie 5000 reguł to 139 ms w ciemnym i 50 ms w jasnym
//   (dla porównania 3000 → 79 ms, 8000 → 240 ms). Ale liczy się koszt CAŁEGO renderu przy
//   wyczerpanym limicie bajtowym body_html (2 MB, server/mail.js), bo do policzenia reguł trzeba
//   je najpierw sparsować. Zmierzone renderujTresc w ciemnym dla ładunku 2 MB, zależnie od tego,
//   na ile <style> jest rozbity: 1 arkusz → 198 ms, ten sam w jednym @media → 211 ms,
//   50 arkuszy → 266 ms, 500 → 278 ms, 5000 → 326 ms. Czyli sufit to ~0,33 s — ten sam rząd co
//   najgorszy przypadek MAX_TAGI (~0,6 s), zamiast 5,4 s bez tego limitu.
// · Od dołu (uczciwa poczta): typowy list ma dziesiątki-setki reguł, a bardzo złożony newsletter
//   rzadko przekracza 1000-2000. Zapas widać najlepiej w bajtach: wygenerowany newsletter o 2199
//   policzonych regułach (klasy, @media, kolory, tła) to już 132 KB samego CSS, a próg 5000
//   wypada dopiero przy ~300 KB — wielokrotność tego, co niesie realna poczta.
//   Uwaga przy strojeniu progu: liczymy REKURENCYJNIE, więc @media dokłada siebie i swoje
//   wnętrze. Newsletter z zapytaniami medialnymi wychodzi ~10% wyżej, niż sugeruje sama liczba
//   reguł najwyższego poziomu (zmierzone: 1801 top-level → 2199 policzonych).
// Za progiem pomijamy CAŁE arkusze, nigdy pół arkusza: użytkownik traci wtedy samo stylowanie,
// a treść listu renderuje się dalej — łagodniej niż zejście do gołego tekstu, a przy okazji bez
// arkusza sklejonego z połowy reguł, który wyglądałby gorzej niż jego brak. Pierwszy arkusz,
// który się nie mieści, kończy CSS całego listu (uzasadnienie przy `break` w przetworzStyle).
const MAX_REGUL = 5000;

// Staroszkolne atrybuty kolorów i ich odpowiedniki w stylu · przenosi je czyscAtrybuty.
// Poza pętlą, bo biegnie ona przez KAŻDY element każdego listu.
const KOLORY_Z_ATRYBUTU = [['bgcolor', 'backgroundColor'], ['color', 'color']];

export function renderujTresc(kontener, wiadomosc, opcje = {}) {
  wyczyscKontener(kontener);
  // Normalny tekst zwija cytaty pod „•••”. Fallback niżej woła renderujTekst BEZ tej
  // flagi: jak render HTML padł, dajemy goły tekst i nie kombinujemy dalej.
  if (!wiadomosc.body_html) return renderujTekst(kontener, wiadomosc, { zwijajCytaty: true });
  // Strażnik gęstości tagów PRZED parserem: patologicznie tagogęsty HTML wiesza kartę już
  // w parseFromString (zob. MAX_TAGI), więc go w ogóle nie parsujemy — pokazujemy tekst tą
  // samą ścieżką co zwykły list bez HTML. To cichy fallback: użytkownik dostaje czytelną
  // treść (wiadomosc.body), nie białą plamę ani surowe źródło. console.warn tylko dla
  // diagnostyki, nie dla użytkownika.
  if (liczbaTagow(wiadomosc.body_html) > MAX_TAGI) {
    console.warn('[tresc] list zbyt gęsty w tagi, pomijam render HTML i pokazuję tekst');
    return renderujTekst(kontener, wiadomosc, { zwijajCytaty: true });
  }
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
  // `cz-body-kartka` też schodzi: wyjątek w renderze HTML mógł polecieć już PO jej
  // ustawieniu, a jasna kartka nad tekstowym fallbackiem to biały prostokąt bez powodu.
  kontener.classList.remove('cz-body-list', 'cz-body-kartka');
  kontener.removeAttribute('id');
}

function renderujTekst(kontener, wiadomosc, { zwijajCytaty = false } = {}) {
  wyczyscKontener(kontener);
  // `?? ''`, bo list bywa sam HTML-em bez części tekstowej, a wstaw* robią String(tekst)
  // — bez tego użytkownik dostałby wypisane słowo „undefined".
  //
  // Dwa wywołania, różne potrzeby: normalna ścieżka tekstowa (renderujTresc) chowa cytaty,
  // fallback po wyjątku w renderze HTML woła nas bez flagi i ma dać goły tekst.
  if (zwijajCytaty) wstawTekstZCytatami(kontener, wiadomosc.body ?? '');
  else wstawTrescZLinkami(kontener, wiadomosc.body ?? '');
  // Pełny kształt jak renderujHtml: tekst nie ma kolorów do odwrócenia, więc `false`
  // na sztywno. Jawne pole zamiast `undefined` to porządek — `if (przerobioneKolory)`
  // w main.js dalej fałszywe, furtka „Oryginalne kolory” się nie pojawia.
  // `uzyteCid` pusty: ścieżka tekstowa nie rozwiązuje żadnego cid, więc niczego nie
  // skonsumowała. Pole MUSI być, bo main.js woła na nim `.has` niezależnie od ścieżki.
  return { zdalne: 0, przerobioneKolory: false, uzyteCid: new Set() };
}

function renderujHtml(kontener, wiadomosc, { cid = {}, obrazki = false, oryginalneKolory = false }) {
  const ciemny = document.documentElement.dataset.theme === 'dark';
  const kontekst = {
    id: `list-${++licznik}`, cid, obrazki, zdalne: 0,
    ciemny: ciemny && !oryginalneKolory,
    wlasnyCiemny: false,
    pierwszeTlo: undefined,
    // Content-ID, które renderer faktycznie wstawił w treść (rozwiązał `cid:` na realny src).
    // main.js chowa spinacz tylko dla tych — reszta załączników zostaje pod listem.
    uzyteCid: new Set(),
  };
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

  // Decyzja raz na list, nie na element: mieszanie dałoby ciemną stopkę przy
  // rozjaśnionej treści. Brak tła traktujemy jak jasne, bo maile projektuje
  // się na biel.
  const jasny = !kontekst.pierwszeTlo || rgbNaOklch(kontekst.pierwszeTlo).L > 0.5;
  const pasmo = kontekst.ciemny && !kontekst.wlasnyCiemny && jasny ? pasmoJasnosci() : null;
  if (pasmo) przepiszKoloryDrzewa(doc.body, pasmo);

  kontener.id = kontekst.id;
  kontener.classList.add('cz-body-list');
  kontener.classList.toggle('cz-body-kartka', oryginalneKolory && ciemny);
  if (arkusz) {
    const styl = document.createElement('style');
    // Inwersję arkusza puszczamy PO przetworzStyle (allowlista funkcji, wykrycie
    // podstawienia var()) — wejście jest już czyste, przepiszDeklaracje tylko odwraca
    // kolory, więc druga runda CSSOM nie otwiera z powrotem kanału url()/var().
    styl.textContent = pasmo ? przepiszArkusz(arkusz, pasmo) : arkusz;
    kontener.append(styl);
  }
  kontener.append(...doc.body.childNodes);
  // Zwijanie idzie NA KOŃCU, po dwóch rzeczach: po przepiszKoloryDrzewa (kolory odwracamy
  // na treści w drzewie, zanim zwinięcie poprzenosi węzły do opakowania) i po wstawieniu
  // treści do kontenera (zwinCytaty szuka blockquote w kontenerze, nie w oderwanym doc).
  zwinCytaty(kontener);
  return { zdalne: kontekst.zdalne, przerobioneKolory: Boolean(pasmo), uzyteCid: kontekst.uzyteCid };
}

// --- Drzewo --------------------------------------------------------------------

// Wszystkie polityki tagów są pisane WIELKIMI literami, bo takie tagName oddaje HTML.
// Elementy spoza HTML (`<svg>`, `<math>` i ich wnętrze) mają tagName małymi literami, więc
// bez tego kroku nie trafiały w żadną politykę: `<svg>` wpadał w gałąź rozwijającą i jego
// dzieci przeżywały. Dla HTML to no-op.
function nazwaTagu(wezel) {
  return wezel.tagName.toUpperCase();
}

function czyscDrzewo(rodzic, kontekst, glebokosc = 0) {
  // Za twardym limitem ucinamy CAŁE poddrzewo i wracamy. Niezmiennik: do kontenera nigdy
  // nie trafia węzeł, który nie przeszedł sanityzacji — dlatego ucięcie USUWA zbyt głębokie
  // węzły, nie zostawia ich nietkniętych. rodzic jest w tym miejscu już bezpieczny: w ścieżce
  // zejścia czyscAtrybuty biegnie PRZED rekurencją, a w ścieżce obcego tagu rodzic i tak zaraz
  // znika przez unwrap. replaceChildren() kasuje więc wyłącznie jeszcze nietknięte dzieci spod
  // granicy — nic z atrybutami on* ani innym ładunkiem nie przeżywa.
  if (glebokosc > MAX_GLEBOKOSC) {
    rodzic.replaceChildren();
    return;
  }
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
      czyscDrzewo(wezel, kontekst, glebokosc + 1);
      wezel.replaceWith(...wezel.childNodes);
      continue;
    }
    czyscAtrybuty(wezel, kontekst);
    if (wezel.isConnected) czyscDrzewo(wezel, kontekst, glebokosc + 1);
  }
}

function czyscAtrybuty(wezel, kontekst) {
  const tag = nazwaTagu(wezel);
  const dozwolone = dozwoloneAtrybuty(tag);
  for (const atrybut of [...wezel.attributes]) {
    const nazwa = atrybut.name.toLowerCase();
    if (nazwa.startsWith('on') || !dozwolone.includes(nazwa)) wezel.removeAttribute(atrybut.name);
  }

  // `bgcolor` i `color` to staroszkolny sposób na tło i tekst, a newslettery wciąż ich
  // używają. Przenosimy oba do stylu, żeby inwersja miała jedno miejsce do przepisania:
  // przepiszKoloryDrzewa chodzi po `[style]`, więc kolor zostawiony w atrybucie jej umyka.
  // Bez tego `<font color="#000">` zostawał czarnym tekstem na tle, które inwersja właśnie
  // przyciemniła — czyli dokładnie ta nieczytelność, przed którą broni przeniesienie bgcolor.
  // `color` stoi w allowliście wyłącznie przy FONT, więc hasAttribute zastępuje sprawdzanie
  // tagu (tak samo jak przy `background` niżej).
  //
  // Nie nadpisujemy stylu inline, gdy już niesie tę własność: atrybut prezentacyjny przegrywa
  // z `style` w kaskadzie, a przeniesienie go bez tego warunku odwróciłoby tę kolejność.
  for (const [atrybut, wlasnosc] of KOLORY_Z_ATRYBUTU) {
    const wartosc = wezel.getAttribute(atrybut);
    if (!wartosc) continue;
    if (!wezel.style[wlasnosc]) wezel.style[wlasnosc] = wartosc;
    wezel.removeAttribute(atrybut);
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
    // Klucz podaje nadawca, więc pytamy wyłącznie o własność własną. Serwer buduje mapę
    // przez Object.create(null), ale JSON to cofa: po JSON.parse obiekt ma z powrotem
    // Object.prototype, więc `cid['toString']` oddałoby funkcję, a setAttribute wpisałby
    // jej źródło w src. `<img src="cid:toString">` to wystarczy, żeby wywołać.
    const url = Object.hasOwn(kontekst.cid, ocena.cid) ? kontekst.cid[ocena.cid] : null;
    if (url) {
      wezel.setAttribute(atrybut, url);
      // Faktycznie wstawiliśmy ten obrazek w treść, więc jego spinacz można schować pod listem —
      // dokładnie jeden: gdy kilka załączników dzieli ten Content-ID, dedup po stronie main.js
      // (widoczneSpinacze) chowa tylko pierwszy, ten, który trasa `cid:` serwuje, a duplikaty
      // zostawia widocznymi spinaczami.
      // Porównanie po CAŁYM kluczu (Object.hasOwn wyżej) · klucz obcięty nie dopasuje się do
      // pełnego odwołania, więc taki załącznik NIE trafi tu i zostanie widocznym spinaczem.
      kontekst.uzyteCid.add(ocena.cid);
    } else {
      wezel.removeAttribute(atrybut); // nieznany cid: złamany obrazek z alt, nie błąd renderu
    }
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

function czyscStylInline(wezel, kontekst) {
  oczyscDeklaracje(wezel.style);

  // Pierwsze nieprzezroczyste tło w kolejności dokumentu to tło najbardziej
  // zewnętrznego elementu, który je ustawia. Na nim opieramy decyzję o inwersji.
  if (kontekst.pierwszeTlo === undefined) {
    const tlo = normalizujKolor(wezel.style.backgroundColor);
    if (tlo && tlo.a > 0.5) kontekst.pierwszeTlo = tlo;
  }

  // Atrybut przepisujemy z KANONICZNEJ serializacji CSSOM (wezel.style.cssText), nie
  // zostawiamy surowego źródła. Gdy CSSOM odrzuci deklarację już przy parsowaniu (bo jest
  // nieprawidłowa: `background:url(javascript:alert(1))`, `width:expression(...)`,
  // `-moz-binding:url(...)`), nie trafia ona do wezel.style, więc oczyscDeklaracje nie ma
  // czego usunąć ani co przepisać — a getAttribute('style') oddawał wtedy surowy string
  // źródłowy z bezwładnym junkiem. cssText niesie wyłącznie to, co parser przyjął i co
  // przeżyło sanityzację, więc nieprzeczytanego junku nie ma jak w nim zostać. Reserializacja
  // jest idempotentna i bezpieczna: ustawiamy atrybut na WŁASNĄ serializację CSSOM, którą
  // przeglądarka odczyta tym SAMYM parserem — bez rozbieżności serializacja↔parser.
  const czyste = wezel.style.cssText;
  if (czyste) wezel.setAttribute('style', czyste);
  else wezel.removeAttribute('style');
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

// Liczy reguły arkusza tak, jak realnie chodzi po nich przetworzRegule, czyli RAZEM z wnętrzem
// @media. Samo `arkusz.cssRules.length` nie wystarczy i nie jest to teoretyczne: te same 160 tys.
// reguł opakowane w jedno `@media screen{…}` dają cssRules.length === 1 (zmierzone), a render
// i tak stoi 4681 ms — licznik po wierzchu przepuściłby cały ładunek, wystarczyłoby dopisać
// jedną linijkę wokół niego.
//
// Schodzimy też w reguły, w które przetworzRegule NIE schodzi (@supports, @keyframes,
// zagnieżdżenia CSS). To świadome zawyżenie: mylimy się w stronę pominięcia arkusza, nigdy
// w stronę niedoszacowania pracy, którą mamy do wykonania.
//
// Iteracyjnie, nie rekurencyjnie: rekurencja po dowolnie głęboko zagnieżdżonym CSS dokładałaby
// nowe ryzyko przepełnienia stosu, a chodzi o strażnika kosztu, nie o kolejny sposób na wywrotkę.
// Przerwanie po przekroczeniu `limit` trzyma koszt zliczania na O(limit) na arkusz zamiast
// O(reguł w arkuszu) — i tak samo ogranicza pamięć, bo każde odłożenie na stos odpowiada
// jednej policzonej regule.
function policzReguly(reguly, limit) {
  let liczba = 0;
  const stos = [reguly];
  while (stos.length) {
    for (const regula of stos.pop()) {
      liczba += 1;
      if (liczba > limit) return liczba;
      if (regula.cssRules && regula.cssRules.length) stos.push(regula.cssRules);
    }
  }
  return liczba;
}

function przetworzStyle(zrodla, kontekst) {
  const czesci = [];
  // Budżet zbiorczy na CAŁY list, nie na pojedynczy arkusz: praca po naszej stronie zostaje
  // przez to ograniczona do MAX_REGUL reguł niezależnie od tego, na ile <style> nadawca ją
  // rozbije. Kolejne arkusze konsumują go po kolei, aż do wyczerpania (patrz MAX_REGUL).
  let budzet = MAX_REGUL;
  for (const zrodlo of zrodla) {
    if (budzet <= 0) break;
    const arkusz = new CSSStyleSheet();
    try {
      arkusz.replaceSync(zrodlo);
    } catch {
      continue; // zepsuty arkusz pomijamy w całości
    }
    // Zliczamy PO replaceSync (samo parsowanie jednego arkusza jest tanie), ale PRZED
    // przetworzRegule — inaczej strażnik biegłby za tym, przed czym ma bronić.
    //
    // Pierwszy arkusz, który się w budżecie nie mieści, KOŃCZY CSS całego listu (break), a nie
    // tylko wypada sam (continue). Powód jest zmierzony: przy `continue` budżet zatrzymuje się
    // tuż nad zerem i nigdy go nie osiąga (ładunek z 5000 arkuszy po ~24 reguły zjada 4992 z
    // 5000, a każdy kolejny arkusz jest za duży na resztę), więc pętla i tak parsowała
    // replaceSync CAŁE 2 MB — 720 ms zamiast ~180 ms. Dla uczciwej poczty ta różnica nie
    // istnieje: żeby w ogóle dojść do pominięcia, list musi nieść ponad MAX_REGUL reguł, czyli
    // wielokrotność tego, co niesie realny newsletter.
    const ile = policzReguly(arkusz.cssRules, budzet);
    if (ile > budzet) {
      console.warn('[tresc] arkusz ma zbyt wiele reguł, pomijam stylowanie od tego miejsca');
      break;
    }
    budzet -= ile;
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
    const rozstrzygniecie = rozstrzygnijMedia(regula.conditionText, kontekst.ciemny);
    if (rozstrzygniecie.decyzja === 'odrzuc') return '';
    // List, który ma własny dark mode, dostaje swój. Nadawca wie lepiej niż
    // nasza inwersja, więc notujemy to i inwersji nie nakładamy.
    if (rozstrzygniecie.decyzja !== 'zostaw' || rozstrzygniecie.warunek !== regula.conditionText) {
      kontekst.wlasnyCiemny = true;
    }
    const wewnetrzne = [...regula.cssRules]
      .map((r) => przetworzRegule(r, kontekst))
      .filter(Boolean)
      .join('\n');
    if (!wewnetrzne) return '';
    if (rozstrzygniecie.decyzja === 'bezwarunkowo') return wewnetrzne;
    return `@media ${rozstrzygniecie.warunek} { ${wewnetrzne} }`;
  }
  // @import i @font-face to sieć, czyli śledzenie. @keyframes i reszta
  // odpadają, bo nazwy animacji zderzałyby się z animacjami aplikacji.
  return '';
}

// --- Ciemny motyw ---------------------------------------------------------------

// Literał koloru w wartości złożonej (gradient, box-shadow). Przybliżenie,
// i tak jest opisane w specyfikacji.
//
// Uwaga: to wyrażenie ma flagę `g`, więc NIE wolno wołać na nim `.test()`.
// `.test()` na wyrażeniu z `g` jest stanowe przez `lastIndex` i dla tego
// samego wejścia zwraca naprzemiennie true i false. Używamy tylko `.replace()`,
// które `lastIndex` zeruje samo.
const LITERAL_KOLORU = /#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)/gi;

// Normalizację nazw, hexów i hsl() zostawiamy przeglądarce: wpisujemy wartość w element
// i odczytujemy z powrotem. ALE odczyt MUSI iść przez getComputedStyle — inline
// `style.color` NIE rozwija nazw (`white` wraca jako "white", nie rgb), a wtedy
// `parsujRgb` zwraca null i `bgcolor="white"` zostaje białym prostokątem w ciemnym
// motywie, czyli dokładnie ta skarga, dla której cała funkcja powstaje. Próbka MUSI
// wisieć w dokumencie: getComputedStyle na odczepionym elemencie oddaje "" dla wszystkiego.
const probka = document.createElement('span');
document.body.append(probka);

// Słowa kluczowe CSS przechodzą bramę inline (nie są ""), a getComputedStyle rozwiązałby
// je do koloru RODZICA — czyli do podwójnej inwersji, bo przepiszKoloryDrzewa idzie po
// [style] w kolejności dokumentu (rodzic przed dzieckiem), więc dziecko dziedziczyłoby już
// odwrócony kolor i odwróciło go drugi raz. Zostawiamy je nietknięte: dziecko naturalnie
// odziedziczy odwrócony kolor rodzica, poprawnie i za darmo.
const SLOWA_KLUCZOWE_KOLORU = new Set(['inherit', 'initial', 'unset', 'revert', 'currentcolor']);

function normalizujKolor(wartosc) {
  probka.style.color = '';
  probka.style.color = String(wartosc ?? '').trim();
  // Brama na inline setterze: CSSOM odrzuca nie-kolory do "" (`12px`, `garbage`, `inherit`
  // jest niepuste — stąd osobny warunek niżej). Bez tej bramy getComputedStyle oddałby dla
  // śmiecia odziedziczony kolor domyślny i odwrócilibyśmy nie-kolor.
  if (!probka.style.color) return null;
  if (SLOWA_KLUCZOWE_KOLORU.has(probka.style.color.toLowerCase())) return null;
  // Dopiero teraz rozwijamy nazwę/hsl na rgb. oklch()/lab() zostają dosłowne obiema drogami,
  // więc parsujRgb je pomija — granica CSS Color 4, znane ograniczenie.
  return parsujRgb(getComputedStyle(probka).color);
}

// Pasmo bierzemy z tokenów w czasie działania, nie na sztywno, więc zmiana
// palety pociąga inwersję za sobą.
function pasmoJasnosci() {
  const style = getComputedStyle(document.documentElement);
  const papier = normalizujKolor(style.getPropertyValue('--papier'));
  const atrament = normalizujKolor(style.getPropertyValue('--atrament'));
  if (!papier || !atrament) return null;
  return { lMin: rgbNaOklch(papier).L, lMax: rgbNaOklch(atrament).L };
}

// Zwraca nową wartość albo null, gdy nie ma czego przepisywać. Wartości
// nie-kolorowe (`12px`, `inherit`, `transparent`) przechodzą przez oba etapy
// i wypadają jako null, więc nie trzeba trzymać listy właściwości kolorowych.
function przepiszWartosc(wartosc, pasmo) {
  const wprost = normalizujKolor(wartosc);
  if (wprost) {
    if (wprost.a === 0) return null; // przezroczyste zostaje przezroczyste
    return zapiszRgb({ ...odwrocJasnosc(wprost, pasmo), a: wprost.a });
  }
  const tekst = String(wartosc);
  const zmieniona = tekst.replace(LITERAL_KOLORU, (literal) => {
    const rgb = normalizujKolor(literal);
    return rgb ? zapiszRgb({ ...odwrocJasnosc(rgb, pasmo), a: rgb.a }) : literal;
  });
  return zmieniona === tekst ? null : zmieniona;
}

function przepiszDeklaracje(deklaracje, pasmo) {
  for (const nazwa of [...deklaracje]) {
    const nowa = przepiszWartosc(deklaracje.getPropertyValue(nazwa), pasmo);
    if (nowa) deklaracje.setProperty(nazwa, nowa, deklaracje.getPropertyPriority(nazwa));
  }
}

function przepiszKoloryDrzewa(rodzic, pasmo) {
  for (const wezel of rodzic.querySelectorAll('[style]')) {
    przepiszDeklaracje(wezel.style, pasmo);
  }
}

// Arkusz jest już zakresowany i posklejany w string, więc przepuszczamy go
// jeszcze raz przez CSSOM, zamiast trzymać reguły w pamięci. Bezpieczne, bo biegnie
// PO przetworzStyle: wejście jest już odsiane (allowlista funkcji, wykrycie var()),
// a przepiszDeklaracje tylko odwraca kolory — nie dokłada url(), var() ani skrótów.
function przepiszArkusz(tekst, pasmo) {
  const arkusz = new CSSStyleSheet();
  try {
    arkusz.replaceSync(tekst);
  } catch {
    return tekst;
  }
  przepiszRegulyArkusza(arkusz.cssRules, pasmo);
  return [...arkusz.cssRules].map((r) => r.cssText).join('\n');
}

function przepiszRegulyArkusza(reguly, pasmo) {
  for (const regula of reguly) {
    if (regula instanceof CSSStyleRule) przepiszDeklaracje(regula.style, pasmo);
    else if (regula.cssRules) przepiszRegulyArkusza(regula.cssRules, pasmo);
  }
}

// --- Cytaty ---------------------------------------------------------------------

// Selektory cytatu w liście HTML. Uwaga na sanitizer: czyscAtrybuty ZDEJMUJE `id`
// (DOM clobbering) oraz `type` z blockquote (spoza allowlisty), więc do zwinCytaty
// docierają realnie tylko `blockquote` (łapie też Apple Mail `blockquote[type=cite]`)
// i `.gmail_quote` (class przeżywa). `#divRplyFwdMsg` (Outlook) i `blockquote[type=cite]`
// zostają jako zapis intencji — pierwszy jest dziś martwy (id ścięte), drugi zbędny
// (podzbiór `blockquote`). Zob. raport Task 9.
const SELEKTORY_CYTATU = 'blockquote, .gmail_quote, #divRplyFwdMsg, blockquote[type="cite"]';

function zwinCytaty(kontener) {
  // Tylko najbardziej zewnętrzne: zagnieżdżone chowają się razem z rodzicem.
  const cytaty = [...kontener.querySelectorAll(SELEKTORY_CYTATU)]
    .filter((wezel) => !wezel.parentElement.closest(SELEKTORY_CYTATU));
  if (!cytaty.length) return;

  // Każdy cytat wraz z jego linią atrybucji (jeśli ją rozpoznajemy) to jedna grupa
  // chowana pod wspólnym „•••”. Grupy budujemy zanim cokolwiek zwiniemy, bo strażnik
  // niżej patrzy na nie zbiorczo.
  const grupy = cytaty.map(zbudujGrupeCytatu);

  // Strażnik zbiorczy: zwijamy tylko wtedy, gdy po schowaniu WSZYSTKICH cytatów zostaje
  // jeszcze coś widocznego. Liczony per-grupę (jak wcześniej) daje pustą kartkę przy
  // dwóch rozłącznych cytatach top-level bez innej treści: każda grupa widzi tekst
  // drugiej jako „resztę listu” i chowa się, zostają dwa „•••” nad niczym. To ta sama
  // zasada co zostajeCosWidocznego w ścieżce tekstowej. Mierzymy tekstem, nie węzłami:
  // cytat bywa zagnieżdżony w <div>, więc porównanie dzieci najwyższego poziomu myli.
  const cale = dlugoscTresci(kontener);
  const cytowane = grupy.reduce((suma, grupa) => suma + dlugoscWezlow(grupa), 0);
  if (cale - cytowane < 1) return;

  for (const grupa of grupy) schowajGrupe(grupa);
}

// Cytat plus poprzedzająca go linia atrybucji, o ile to NASZA atrybucja. Kandydatem
// jest WYŁĄCZNIE goły węzeł tekstowy: nasza atrybucja z kompozytora (kompozycja.js:427)
// renderuje się jako czysty tekst tuż przed <blockquote>. Element-rodzeństwo do grupy
// NIE wchodzi — w ścieżce tekstowej całą treść „przed” trzyma <div>, którego textContent
// też bywa zakończony „napisał(a):”; wciągnięcie go schowałoby widoczną odpowiedź razem
// z cytatem (zmierzone: bottom-post gubił odpowiedź, top-post nie zwijał cytatu wcale).
function zbudujGrupeCytatu(cytat) {
  const grupa = [cytat];
  let poprzedni = cytat.previousSibling;
  while (poprzedni && poprzedni.nodeType === Node.TEXT_NODE && !poprzedni.textContent.trim()) {
    poprzedni = poprzedni.previousSibling;
  }
  if (poprzedni && poprzedni.nodeType === Node.TEXT_NODE && czyLiniaAtrybucji(poprzedni.textContent)) {
    grupa.unshift(poprzedni);
  }
  return grupa;
}

// Odróżnia linię atrybucji od prozy zakończonej „…napisał(a):”. Dwa warunki naraz:
// (1) tekst kończy się suffiksem atrybucji, (2) niesie cyfrę. Nasza atrybucja zawsze
// niesie datę i godzinę („pt., 17 lip 2026 o 09:24 Jan <…> napisał(a):”), więc cyfrę ma; proza
// odpowiedzi tuż przed cytatem zwykle nie („Dzięki wielkie za pomoc! Jan napisał(a):”).
// Bez warunku (2) obcy klient, który sklei odpowiedź i atrybucję w jeden goły węzeł
// tekstowy, schowałby odpowiedź pod „•••”. Kierunek awarii bezpieczny: brak cyfry → NIE
// dokładamy węzła (atrybucja zostaje widoczna nad cytatem, sam cytat i tak się zwija),
// a nasza atrybucja nigdy nie jest bezcyfrowa, więc to zawężenie jej nie rusza.
function czyLiniaAtrybucji(tekst) {
  const t = String(tekst ?? '');
  return /(?:napisał\(a\):|wrote:)\s*$/i.test(t) && /\d/.test(t);
}

// Długość tekstu listu z pominięciem <style>, którego CSS też jest textContent,
// a treścią nie jest.
function dlugoscTresci(kontener) {
  let suma = 0;
  for (const wezel of kontener.childNodes) {
    if (wezel.tagName === 'STYLE') continue;
    suma += (wezel.textContent ?? '').trim().length;
  }
  return suma;
}

// Suma długości tekstu (po trim) węzłów jednej grupy cytatu — cytat i ewentualna
// linia atrybucji. Ten sam trim co dlugoscTresci, żeby odejmowanie się zgadzało.
function dlugoscWezlow(wezly) {
  return wezly.reduce((suma, wezel) => suma + (wezel.textContent ?? '').trim().length, 0);
}

// Strażnik „pustej kartki” siedzi teraz zbiorczo w zwinCytaty (bo dwa rozłączne cytaty
// muszą być ważone razem), więc tu już tylko przenosimy grupę pod „•••”.
function schowajGrupe(grupa) {
  const opakowanie = document.createElement('div');
  opakowanie.className = 'cz-cytat';
  grupa[0].before(opakowanie);

  const przycisk = document.createElement('button');
  przycisk.type = 'button';
  przycisk.className = 'cz-cytat-przycisk';
  przycisk.setAttribute('aria-expanded', 'false');
  przycisk.setAttribute('aria-label', 'Pokaż cytowaną treść');
  przycisk.textContent = '•••';

  const tresc = document.createElement('div');
  tresc.className = 'cz-cytat-tresc';
  tresc.hidden = true;
  tresc.append(...grupa);

  przycisk.addEventListener('click', () => {
    tresc.hidden = !tresc.hidden;
    przycisk.setAttribute('aria-expanded', String(!tresc.hidden));
    przycisk.setAttribute('aria-label', tresc.hidden ? 'Pokaż cytowaną treść' : 'Ukryj cytowaną treść');
  });

  opakowanie.append(przycisk, tresc);
}

// Ścieżka tekstowa: ciągłe bloki linii od „>”. Atrybucji nad nimi nie
// zgadujemy, bo heurystyka po samym tekście potrafi schować treść, która
// cytatem nie jest.
function wstawTekstZCytatami(kontener, tekst) {
  const linie = String(tekst ?? '').split('\n');
  const zakresy = znajdzCytatyWTekscie(tekst);
  if (!zakresy.length || !zostajeCosWidocznego(linie, zakresy)) {
    wstawTrescZLinkami(kontener, tekst);
    return;
  }

  let kursor = 0;
  for (const zakres of zakresy) {
    if (zakres.start > kursor) {
      const przed = document.createElement('div');
      wstawTrescZLinkami(przed, linie.slice(kursor, zakres.start).join('\n'));
      kontener.append(przed);
    }
    const cytat = document.createElement('blockquote');
    wstawTrescZLinkami(cytat, linie.slice(zakres.start, zakres.end + 1).join('\n'));
    kontener.append(cytat);
    kursor = zakres.end + 1;
  }
  if (kursor < linie.length) {
    const po = document.createElement('div');
    wstawTrescZLinkami(po, linie.slice(kursor).join('\n'));
    kontener.append(po);
  }
  zwinCytaty(kontener);
}
