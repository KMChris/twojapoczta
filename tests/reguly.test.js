// Jednostkowe testy polityk renderera poczty: tagi, URL-e, CSS, cytaty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOZWOLONE_TAGI, WYTNIJ_W_CALOSCI, dozwoloneAtrybuty, bezpiecznyLink, ocenUrlObrazka,
  czyDeklaracjaZakazana, podzielSelektory, zakresujSelektor, rozstrzygnijMedia,
  znajdzCytatyWTekscie, zostajeCosWidocznego,
} from '../public/assets/js/app/reguly.js';

test('DOZWOLONE_TAGI: tabele przechodzą, bo na nich stoi layout newsletterów', () => {
  for (const tag of ['TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']) {
    assert.ok(DOZWOLONE_TAGI.has(tag), `brakuje ${tag}`);
  }
});

test('WYTNIJ_W_CALOSCI i DOZWOLONE_TAGI nie zachodzą na siebie', () => {
  for (const tag of WYTNIJ_W_CALOSCI) {
    assert.ok(!DOZWOLONE_TAGI.has(tag), `${tag} jest i dozwolony, i wycinany`);
  }
});

test('dozwoloneAtrybuty: id i name nie przechodzą przez żaden tag', () => {
  for (const tag of ['A', 'IMG', 'TABLE', 'TD', 'DIV', 'FONT']) {
    assert.ok(!dozwoloneAtrybuty(tag).includes('id'), `${tag} przepuszcza id`);
    assert.ok(!dozwoloneAtrybuty(tag).includes('name'), `${tag} przepuszcza name`);
  }
});

test('dozwoloneAtrybuty: TD ma colspan, IMG ma src, A ma href', () => {
  assert.ok(dozwoloneAtrybuty('TD').includes('colspan'));
  assert.ok(dozwoloneAtrybuty('IMG').includes('src'));
  assert.ok(dozwoloneAtrybuty('A').includes('href'));
  assert.ok(!dozwoloneAtrybuty('DIV').includes('href'));
});

test('bezpiecznyLink: przepuszcza http, https, mailto i tel', () => {
  assert.equal(bezpiecznyLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(bezpiecznyLink('mailto:a@b.pl'), 'mailto:a@b.pl');
  assert.equal(bezpiecznyLink('tel:+48123456789'), 'tel:+48123456789');
});

test('bezpiecznyLink: odrzuca javascript, data i adresy względne', () => {
  assert.equal(bezpiecznyLink('javascript:alert(1)'), null);
  assert.equal(bezpiecznyLink('  JaVaScRiPt:alert(1)'), null);
  assert.equal(bezpiecznyLink('data:text/html,<script>'), null);
  assert.equal(bezpiecznyLink('/wzgledny'), null);
  assert.equal(bezpiecznyLink(''), null);
});

test('ocenUrlObrazka: rozpoznaje cid, data, zdalny i śmieci', () => {
  assert.deepEqual(ocenUrlObrazka('cid:logo@fir.ma'), { rodzaj: 'cid', cid: 'logo@fir.ma' });
  assert.deepEqual(ocenUrlObrazka('CID:<x@y>'), { rodzaj: 'cid', cid: 'x@y' });
  assert.equal(ocenUrlObrazka('data:image/png;base64,AAA').rodzaj, 'ok');
  assert.equal(ocenUrlObrazka('https://tracker.example/p.gif').rodzaj, 'zdalny');
  assert.equal(ocenUrlObrazka('data:text/html,<script>').rodzaj, 'odrzuc');
  assert.equal(ocenUrlObrazka('javascript:alert(1)').rodzaj, 'odrzuc');
  assert.equal(ocenUrlObrazka('').rodzaj, 'odrzuc');
});

// data:image/svg+xml jest obrazkiem z nazwy, ale SVG wozi <script>, foreignObject i
// zewnętrzne referencje. Allowlista DATA_OBRAZKA świadomie go pomija · ten test przypina
// tę decyzję, żeby „przecież svg to obrazek" nie dopisało go kiedyś do dozwolonych.
test('ocenUrlObrazka: data:image/svg+xml jest odrzucany mimo prefiksu image/', () => {
  assert.equal(ocenUrlObrazka('data:image/svg+xml,<svg onload=alert(1)>').rodzaj, 'odrzuc');
  assert.equal(ocenUrlObrazka('data:image/svg+xml;base64,PHN2Zz4=').rodzaj, 'odrzuc');
});

// DATA_OBRAZKA jest zakotwiczone `^`: `data:image/png;` MUSI stać na początku, nie gdziekolwiek.
// Bez kotwicy zdalny tracker z `data:image/png;` w query udawałby obrazek wbudowany i omijał
// bramkę „zdalny" (ochronę przed pikselami śledzącymi). Ma wychodzić zdalny, nie ok.
test('ocenUrlObrazka: data:image w środku zdalnego URL-a nie robi z niego wbudowanego', () => {
  assert.equal(ocenUrlObrazka('https://tracker.example/p.gif?x=data:image/png;base64,AAA').rodzaj, 'zdalny');
  assert.equal(ocenUrlObrazka('javascript:/*data:image/png;*/alert(1)').rodzaj, 'odrzuc');
});

test('czyDeklaracjaZakazana: fixed i sticky wypadają, relative zostaje', () => {
  assert.ok(czyDeklaracjaZakazana('position', 'fixed'));
  assert.ok(czyDeklaracjaZakazana('POSITION', 'STICKY'));
  assert.ok(czyDeklaracjaZakazana('z-index', '9999'));
  assert.ok(!czyDeklaracjaZakazana('position', 'relative'));
  assert.ok(!czyDeklaracjaZakazana('color', 'red'));
});

test('czyDeklaracjaZakazana: position fixed/sticky wypada nawet z !important', () => {
  // getPropertyValue strippuje !important, ale cssText go niesie · obrona w głąb nie ufa,
  // że wywołujący zawsze poda wartość rozdzieloną przez CSSOM.
  assert.ok(czyDeklaracjaZakazana('position', 'fixed !important'));
  assert.ok(czyDeklaracjaZakazana('position', 'STICKY !IMPORTANT'));
  assert.ok(!czyDeklaracjaZakazana('position', 'relative !important'));
});

test('podzielSelektory: przecinek w :is() nie rozcina selektora', () => {
  assert.deepEqual(podzielSelektory('.a, .b'), ['.a', '.b']);
  assert.deepEqual(podzielSelektory(':is(.a, .b) .c'), [':is(.a, .b) .c']);
  assert.deepEqual(podzielSelektory(':is(.a, .b), .d'), [':is(.a, .b)', '.d']);
  assert.deepEqual(podzielSelektory('  '), []);
});

test('podzielSelektory: przecinek w selektorze atrybutu nie rozcina', () => {
  assert.deepEqual(podzielSelektory('[data-a="x,y"]'), ['[data-a="x,y"]']);
  assert.deepEqual(podzielSelektory('[title="Hello, World"], .c'), ['[title="Hello, World"]', '.c']);
  assert.deepEqual(podzielSelektory('[data-x="("] , .b'), ['[data-x="("]', '.b']);
});

test('zakresujSelektor: zwykły selektor dostaje przedrostek', () => {
  assert.equal(zakresujSelektor('.przycisk', 'list-1'), '#list-1 .przycisk');
  assert.equal(zakresujSelektor('.a, .b', 'list-1'), '#list-1 .a, #list-1 .b');
});

test('zakresujSelektor: body i html celują w kontener, nie znikają', () => {
  assert.equal(zakresujSelektor('body', 'list-1'), '#list-1');
  assert.equal(zakresujSelektor('html', 'list-1'), '#list-1');
  assert.equal(zakresujSelektor('body .tresc', 'list-1'), '#list-1 .tresc');
  assert.equal(zakresujSelektor('body, .x', 'list-1'), '#list-1, #list-1 .x');
});

// Pusty selektor w wyjściu dałby regułę ` { … }` bez preludium · celujemy wtedy w sam
// kontener, żeby zakresowanie nigdy nie emitowało reguły niezwiązanej z listem. Przez
// Task 6 nieosiągalne (selectorText CSSStyleRule nie bywa pusty), ale funkcja ma być
// totalna: co wejdzie, wychodzi zakresowane.
test('zakresujSelektor: pusty selektor celuje w kontener, nie w nic', () => {
  assert.equal(zakresujSelektor('', 'list-1'), '#list-1');
  assert.equal(zakresujSelektor('   ', 'list-1'), '#list-1');
  assert.equal(zakresujSelektor(',', 'list-1'), '#list-1');
});

// Wiodący kombinator postawiłby `#list-1` bezpośrednio przed `+`/`~`, celując w rodzeństwo
// kontenera (element interfejsu poza listem). Zdejmujemy go, więc część staje się potomkiem
// zamkniętym w kontenerze. Przez selectorText z CSSOM nieosiągalne (reguła top-level nie
// zaczyna się kombinatorem), ale funkcja ma gwarantować zamknięcie dla każdego wejścia.
test('zakresujSelektor: wiodący kombinator nie ucieka na rodzeństwo kontenera', () => {
  assert.equal(zakresujSelektor('+ .sibling', 'list-1'), '#list-1 .sibling');
  assert.equal(zakresujSelektor('~ .x', 'list-1'), '#list-1 .x');
  assert.equal(zakresujSelektor('> .child', 'list-1'), '#list-1 .child');
});

// W odróżnieniu od gołego `+ .x` (reguła top-level nie zaczyna się kombinatorem — nieosiągalne)
// `body + .x` to legalny selektor, który CSSOM zachowuje w selectorText: OSIĄGALNE przez Task 6.
// Zdjęcie korzenia `body`/`html` odsłania kombinator stojący za nim, więc bez naprzemiennego
// zdejmowania aż do stabilizacji `#list-1 + .x` uciekłoby na rodzeństwo kontenera.
test('zakresujSelektor: korzeń html/body nie odsłania kombinatora ucieczki', () => {
  assert.equal(zakresujSelektor('body + .x', 'list-1'), '#list-1 .x');
  assert.equal(zakresujSelektor('html ~ .y', 'list-1'), '#list-1 .y');
  assert.equal(zakresujSelektor('body > .z', 'list-1'), '#list-1 .z');
  // regresja: dotychczasowe zachowanie zostaje
  assert.equal(zakresujSelektor('body .tresc', 'list-1'), '#list-1 .tresc');
  assert.equal(zakresujSelektor('body', 'list-1'), '#list-1');
});

test('rozstrzygnijMedia: warunek pasujący do motywu wchodzi bezwarunkowo', () => {
  assert.deepEqual(rozstrzygnijMedia('(prefers-color-scheme: dark)', true), { decyzja: 'bezwarunkowo' });
  assert.deepEqual(rozstrzygnijMedia('(prefers-color-scheme: light)', false), { decyzja: 'bezwarunkowo' });
});

test('rozstrzygnijMedia: warunek niepasujący do motywu odpada', () => {
  assert.deepEqual(rozstrzygnijMedia('(prefers-color-scheme: dark)', false), { decyzja: 'odrzuc' });
  assert.deepEqual(rozstrzygnijMedia('(prefers-color-scheme: light)', true), { decyzja: 'odrzuc' });
});

test('rozstrzygnijMedia: reszta warunku zostaje po wycięciu prefers-color-scheme', () => {
  assert.deepEqual(
    rozstrzygnijMedia('(min-width: 600px) and (prefers-color-scheme: dark)', true),
    { decyzja: 'zostaw', warunek: '(min-width: 600px)' }
  );
});

test('rozstrzygnijMedia: warunek bez prefers-color-scheme przechodzi bez zmian', () => {
  assert.deepEqual(rozstrzygnijMedia('(max-width: 480px)', true), { decyzja: 'zostaw', warunek: '(max-width: 480px)' });
});

test('znajdzCytatyWTekscie: znajduje ciągły blok linii z ">"', () => {
  const tekst = 'Moja odpowiedź\n\n> cytat pierwszy\n> cytat drugi\n\nPodpis';
  assert.deepEqual(znajdzCytatyWTekscie(tekst), [{ start: 2, end: 3 }]);
});

test('znajdzCytatyWTekscie: dwa rozdzielone bloki to dwa zakresy', () => {
  const tekst = '> a\ntekst\n> b';
  assert.deepEqual(znajdzCytatyWTekscie(tekst), [{ start: 0, end: 0 }, { start: 2, end: 2 }]);
});

test('znajdzCytatyWTekscie: brak cytatu to pusta lista', () => {
  assert.deepEqual(znajdzCytatyWTekscie('sam tekst'), []);
  assert.deepEqual(znajdzCytatyWTekscie(''), []);
});

test('zostajeCosWidocznego: cytat na cały list nie kwalifikuje się do zwinięcia', () => {
  const linie = ['> a', '> b'];
  assert.equal(zostajeCosWidocznego(linie, [{ start: 0, end: 1 }]), false);
});

test('zostajeCosWidocznego: puste linie poza cytatem nie liczą się jako treść', () => {
  const linie = ['', '> a', ''];
  assert.equal(zostajeCosWidocznego(linie, [{ start: 1, end: 1 }]), false);
});

test('zostajeCosWidocznego: prawdziwa treść poza cytatem kwalifikuje', () => {
  const linie = ['Dzięki', '> a'];
  assert.equal(zostajeCosWidocznego(linie, [{ start: 1, end: 1 }]), true);
});
