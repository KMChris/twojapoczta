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

// `contain: layout` w app.css i tak odbiera fixed ucieczkę do viewportu,
// a `isolation: isolate` odbiera z-index przebicie nad interfejs. To jest pas
// do tamtych szelek, na wypadek zmiany CSS kontenera.
export function czyDeklaracjaZakazana(nazwa, wartosc) {
  const n = String(nazwa).toLowerCase();
  if (n === 'z-index') return true;
  if (n === 'position') {
    // Zdejmujemy końcowe `!important` przed porównaniem. Przez zamierzoną ścieżkę
    // (getPropertyValue) to no-op: CSSOM oddaje priorytet osobno, więc wartość nigdy
    // nie niesie tu `!important`. Ale ta funkcja to obrona w głąb i nie ma ufać, że
    // każdy przyszły wywołujący rozdzieli wartość jak CSSOM · cssText `!important`
    // niesie, i bez tego `position: fixed !important` przeszedłby jako niezakazane.
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
      // Wiodący kombinator (`+`/`~`/`>`) zdejmujemy przed prefiksowaniem, żeby `#${id}`
      // nie stanął bezpośrednio przed `+`/`~` i nie wskoczył na rodzeństwo kontenera
      // (element interfejsu poza listem); `> .x` upraszczamy tak samo, a `#${id} .x` i tak
      // zostaje w kontenerze. Przez klasyczny selectorText z CSSOM to nieosiągalne (reguła
      // najwyższego poziomu nie zaczyna się kombinatorem) — domknięcie totalności, nie łata.
      const bezKombinatora = czesc.replace(/^[\s+~>]+/, '');
      if (/^(html|body)$/i.test(bezKombinatora)) return `#${id}`;
      const bezKorzenia = bezKombinatora.replace(/^(html|body)\b\s*/i, '').trim();
      return bezKorzenia ? `#${id} ${bezKorzenia}` : `#${id}`;
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
