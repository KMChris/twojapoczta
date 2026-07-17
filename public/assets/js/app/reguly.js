// Polityki renderowania poczty przychodzącej.
//
// Moduł czysty: bez DOM i bez zależności. Node nie ma DOM, więc wszystko,
// co wyląduje w tresc.js, jest poza zasięgiem `node --test`. Każda decyzja
// dająca się wyrazić bez drzewa należy tutaj.
//
// To NIE jest polityka kompozytora. edytor.js pilnuje tego, co użytkownik
// pisze, i ma być wąski. Tu wchodzi HTML z internetu i musi być szeroki,
// bo inaczej newsletter rozsypuje się na tabelach.

export const DOZWOLONE_TAGI = new Set([
  'P', 'DIV', 'BR', 'HR', 'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE',
  'A', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'CODE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FONT', 'IMG', 'CENTER',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
  'COLGROUP', 'COL', 'SMALL', 'SUB', 'SUP', 'ABBR',
]);

// Wycinane razem z zawartością: ich wnętrze nie jest treścią listu.
export const WYTNIJ_W_CALOSCI = new Set([
  'SCRIPT', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET', 'FORM', 'INPUT',
  'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'SVG', 'MATH', 'TEMPLATE', 'HEAD',
  'TITLE', 'META', 'LINK', 'BASE', 'FRAME', 'FRAMESET', 'AUDIO', 'VIDEO', 'SOURCE',
]);

// `id` i `name` nie występują w żadnej liście świadomie: renderujemy do DOM
// aplikacji, gdzie `<img id="czytnik">` nadpisałby wynik getElementById
// i globalne nazwane właściwości (DOM clobbering).
const WSPOLNE = ['style', 'class', 'title', 'dir', 'lang', 'align', 'valign', 'bgcolor', 'width', 'height'];

const ATRYBUTY = new Map([
  ['A', [...WSPOLNE, 'href']],
  ['IMG', [...WSPOLNE, 'src', 'alt', 'border']],
  ['TABLE', [...WSPOLNE, 'border', 'cellpadding', 'cellspacing', 'background']],
  ['TD', [...WSPOLNE, 'colspan', 'rowspan', 'background']],
  ['TH', [...WSPOLNE, 'colspan', 'rowspan', 'background']],
  ['COL', [...WSPOLNE, 'span']],
  ['COLGROUP', [...WSPOLNE, 'span']],
  ['FONT', [...WSPOLNE, 'color', 'face', 'size']],
]);

export function dozwoloneAtrybuty(tag) {
  return ATRYBUTY.get(tag) ?? WSPOLNE;
}

const SCHEMATY_LINKU = new Set(['http:', 'https:', 'mailto:', 'tel:']);

export function bezpiecznyLink(surowy) {
  const tekst = String(surowy ?? '').trim();
  let url;
  try {
    url = new URL(tekst); // tylko adresy bezwzględne
  } catch {
    return null;
  }
  return SCHEMATY_LINKU.has(url.protocol) ? url.href : null;
}

const DATA_OBRAZKA = /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i;

export function ocenUrlObrazka(surowy) {
  const tekst = String(surowy ?? '').trim();
  if (/^cid:/i.test(tekst)) {
    const cid = tekst.slice(4).trim().replace(/^<|>$/g, '');
    return cid ? { rodzaj: 'cid', cid } : { rodzaj: 'odrzuc' };
  }
  if (DATA_OBRAZKA.test(tekst)) return { rodzaj: 'ok', url: tekst };
  if (/^https?:\/\//i.test(tekst)) return { rodzaj: 'zdalny', url: tekst };
  return { rodzaj: 'odrzuc' };
}

// Podstawowa i jedyna pewna obrona przed ucieczką treści z kontenera — nie „pas do
// szelek" dla CSS kontenera, bo ten nic nie trzyma niezawodnie. Bazowy `.czytnik`
// (app.css:606) to `position: relative; overflow-y: auto`: przycina `absolute`
// i przepełnienie, ale `relative` NIE zawiera `fixed` (ten ucieka do viewportu —
// trzymałby go dopiero transform/filter/contain na przodku, których ani `.czytnik`,
// ani `.uklad`/`body.app` na desktopie nie mają) i NIE tworzy kontekstu stackingu,
// więc nie izoluje `z-index`. Na dokładkę kontener zmienia się z breakpointem — pod
// `@media (max-width:1080px)` `.czytnik` bywa `fixed` + `transform` (szuflada mobilna) —
// więc nie ma się na czym oprzeć. Dlatego `fixed`/`sticky`/`z-index` blokujemy tutaj.
export function czyDeklaracjaZakazana(nazwa, wartosc) {
  const n = String(nazwa).toLowerCase();
  if (n === 'z-index') return true;
  if (n === 'position') {
    // Zdejmujemy końcowe `!important` w postaci, w jakiej serializuje je CSSOM:
    // przylegająco, bez spacji ani komentarzy. Zamierzona ścieżka (getPropertyValue)
    // oddaje priorytet osobno, więc to zwykle no-op · ale cssText niesie `!important`
    // w wartości, i bez tego `position: fixed !important` przeszedłby jako niezakazane.
    // Pełnej gramatyki priorytetu (`fixed ! important`, `fixed /* */ !important`) nie
    // parsujemy — CSSOM jej nie emituje, więc taka forma tu nie dociera. To nie jest
    // obrona przed dowolnym tekstem CSS, tylko dopasowanie do tego, co produkuje CSSOM.
    const w = String(wartosc).toLowerCase().replace(/\s*!important\s*$/, '').trim();
    return w === 'fixed' || w === 'sticky';
  }
  return false;
}

// Dzieli listę selektorów po przecinkach najwyższego poziomu. Przecinek legalnie
// siedzi w nawiasach (`:is(.a, .b)`), w nawiasach kwadratowych (`[title="a, b"]`)
// i w łańcuchu w cudzysłowie — funkcja respektuje każde z tych zagnieżdżeń, więc
// tnie tylko przecinek poza nawiasami, poza `[...]` i poza łańcuchem. Stan łańcucha
// jest nadrzędny: w cudzysłowie żaden `(`/`[`/`,` nie liczy się jako struktura,
// a zamyka go dopiero ten sam znak cudzysłowu, którym się otworzył (dopuszcza `[a="]"]`).
export function podzielSelektory(selektor) {
  const czesci = [];
  let glebokosc = 0;
  let cudzyslow = null;
  let biezacy = '';
  for (const znak of String(selektor ?? '')) {
    if (cudzyslow) {
      if (znak === cudzyslow) cudzyslow = null;
    } else if (znak === '"' || znak === "'") {
      cudzyslow = znak;
    } else if (znak === '(' || znak === '[') {
      glebokosc += 1;
    } else if (znak === ')' || znak === ']') {
      glebokosc -= 1;
    } else if (znak === ',' && glebokosc === 0) {
      czesci.push(biezacy);
      biezacy = '';
      continue;
    }
    biezacy += znak;
  }
  czesci.push(biezacy);
  return czesci.map((c) => c.trim()).filter(Boolean);
}

// Zamyka selektor w kontenerze listu. `body`/`html` celują w sam kontener,
// bo body listu rozpuszcza się przy wstawianiu, a tło z `body { }` to
// dokładnie ten biały prostokąt, o który chodzi w ciemnym motywie.
export function zakresujSelektor(selektor, id) {
  const czesci = podzielSelektory(selektor);
  // Pusty wynik (selektor pusty, sam przecinek, same białe znaki) celuje w kontener,
  // żeby zakresowanie nigdy nie zwróciło reguły bez preludium (` { … }` to błąd składni).
  // Nieosiągalne przez Task 6 (selectorText nie bywa pusty) · funkcja i tak ma być totalna.
  if (czesci.length === 0) return `#${id}`;
  return czesci
    .map((czesc) => {
      // Przedrostek korzenia (`html`/`body`) i wiodący kombinator (`+`/`~`/`>`) zdejmujemy
      // naprzemiennie, aż do stabilizacji: zdjęcie `body`/`html` odsłania kombinator, który
      // wcześniej stał za korzeniem (i odwrotnie), więc jeden przebieg nie wystarcza. Bez tego
      // `body + .x` dałoby `#${id} + .x` i wskoczyło na rodzeństwo kontenera (element interfejsu
      // poza listem). W odróżnieniu od gołego `+ .x` (nieosiągalnego — reguła top-level nie
      // zaczyna się kombinatorem) `body + .x` JEST osiągalne przez selectorText z CSSOM, więc to
      // zamknięcie osiągalnej ucieczki, nie sama totalność. Pętla kończy się dla każdego wejścia:
      // string tylko się skraca albo zostaje (wtedy `!==` przerywa).
      let reszta = czesc.trim();
      let poprzednia;
      do {
        poprzednia = reszta;
        reszta = reszta.replace(/^(html|body)\b\s*/i, '').replace(/^[\s+~>]+/, '');
      } while (reszta !== poprzednia);
      return reszta ? `#${id} ${reszta}` : `#${id}`;
    })
    .join(', ');
}

// @media (prefers-color-scheme: …) pyta system operacyjny, a aplikacja ma
// własny przełącznik motywu. Rozstrzygamy warunek sami, żeby list słuchał
// przełącznika, a nie systemu.
export function rozstrzygnijMedia(warunek, ciemny) {
  const tekst = String(warunek ?? '');
  const dopasowanie = tekst.match(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/i);
  if (!dopasowanie) return { decyzja: 'zostaw', warunek: tekst };

  const chceCiemny = dopasowanie[1].toLowerCase() === 'dark';
  if (chceCiemny !== ciemny) return { decyzja: 'odrzuc' };

  const reszta = tekst
    .replace(dopasowanie[0], '')
    .replace(/\s+and\s+and\s+/gi, ' and ')
    .replace(/^\s*and\s+/i, '')
    .replace(/\s+and\s*$/i, '')
    .trim();
  return reszta ? { decyzja: 'zostaw', warunek: reszta } : { decyzja: 'bezwarunkowo' };
}

// Ciągłe bloki linii cytatu w liście tekstowym. Zwraca zakresy indeksów linii,
// obie granice włącznie.
export function znajdzCytatyWTekscie(tekst) {
  const linie = String(tekst ?? '').split('\n');
  const zakresy = [];
  let start = null;
  for (let i = 0; i < linie.length; i++) {
    const cytat = /^\s*>/.test(linie[i]);
    if (cytat && start === null) start = i;
    if (!cytat && start !== null) {
      zakresy.push({ start, end: i - 1 });
      start = null;
    }
  }
  if (start !== null) zakresy.push({ start, end: linie.length - 1 });
  return zakresy;
}

// List przekazany bywa w całości cytatem. Zwinięcie go dałoby pustą kartkę,
// więc pytamy, czy po zwinięciu w ogóle coś zostanie.
export function zostajeCosWidocznego(linie, zakresy) {
  const wCytacie = new Set();
  for (const zakres of zakresy) {
    for (let i = zakres.start; i <= zakres.end; i++) wCytacie.add(i);
  }
  return linie.some((linia, i) => !wCytacie.has(i) && linia.trim() !== '');
}
