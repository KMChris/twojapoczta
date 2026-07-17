// Jednostkowe testy konwersji kolorów: sRGB ↔ OKLCH i inwersja jasności.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbNaOklch, oklchNaRgb, odwrocJasnosc, parsujRgb, zapiszRgb } from '../public/assets/js/app/kolor.js';

// Pasmo Datownika: --papier #14161d i --atrament #eceada z ciemnego motywu.
const PASMO = { lMin: 0.2, lMax: 0.93 };

test('rgbNaOklch: biel ma L bliskie 1, czerń bliskie 0', () => {
  assert.ok(Math.abs(rgbNaOklch({ r: 255, g: 255, b: 255 }).L - 1) < 0.005);
  assert.ok(Math.abs(rgbNaOklch({ r: 0, g: 0, b: 0 }).L) < 0.005);
});

test('rgbNaOklch: szarość nie ma nasycenia', () => {
  assert.ok(rgbNaOklch({ r: 128, g: 128, b: 128 }).C < 0.002);
});

test('oklchNaRgb: konwersja w obie strony wraca do punktu wyjścia', () => {
  const probki = [
    { r: 210, g: 60, b: 43 },   // --polecony
    { r: 37, g: 71, b: 208 },   // --priorytet
    { r: 236, g: 234, b: 218 }, // --atrament ciemny
    { r: 20, g: 22, b: 29 },    // --papier ciemny
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
  ];
  for (const kolor of probki) {
    const wrocil = oklchNaRgb(rgbNaOklch(kolor));
    assert.ok(Math.abs(wrocil.r - kolor.r) <= 1, `r dla ${JSON.stringify(kolor)}`);
    assert.ok(Math.abs(wrocil.g - kolor.g) <= 1, `g dla ${JSON.stringify(kolor)}`);
    assert.ok(Math.abs(wrocil.b - kolor.b) <= 1, `b dla ${JSON.stringify(kolor)}`);
  }
});

// Round-trip jest DOKŁADNY co do bajta, nie „±1" · sprawdzone wyczerpująco sondą na
// wszystkich 16 777 216 kolorach sRGB: max błąd 0. Test wyżej ma tolerancję <= 1, czyli
// o cały krok luźniejszą niż rzeczywistość, i ten luz połyka tryb zaokrąglenia
// (round → floor oraz round → ceil przechodzą tamten test na zielono).
//
// To NIE jest przefitowanie pod nasz silnik, bo przeglądarka w ogóle tu nie występuje:
// składamy własne dwie funkcje na wejściu całkowitym, a f⁻¹∘f = identyczność. Z Chrome
// porównujemy się przy OKLCH → RGB i tam tolerancja <= 1 ma sens · tu nie ma czego tolerować.
// Zapas do granicy zaokrąglenia to 0.4996 (najgorszy przypadek 0.00043 od całkowitej),
// więc różnice ULP między wersjami V8 tego nie ruszą.
test('oklchNaRgb: round-trip wraca co do bajta, co przypina tryb zaokrąglenia', () => {
  for (let r = 0; r < 256; r += 15) {
    for (let g = 0; g < 256; g += 15) {
      for (let b = 0; b < 256; b += 15) {
        const kolor = { r, g, b };
        assert.deepEqual(oklchNaRgb(rgbNaOklch(kolor)), kolor, `round-trip dla ${JSON.stringify(kolor)}`);
      }
    }
  }
});

test('oklchNaRgb: kolor spoza gamutu jest przycinany, nie zawija się', () => {
  const wynik = oklchNaRgb({ L: 0.99, C: 0.4, h: 1.2 });
  for (const kanal of [wynik.r, wynik.g, wynik.b]) {
    assert.ok(kanal >= 0 && kanal <= 255, `kanał poza zakresem: ${kanal}`);
  }
});

test('odwrocJasnosc: biel ląduje w papierze, czerń w atramencie', () => {
  const biel = odwrocJasnosc({ r: 255, g: 255, b: 255 }, PASMO);
  assert.ok(Math.abs(rgbNaOklch(biel).L - PASMO.lMin) < 0.01);
  const czern = odwrocJasnosc({ r: 0, g: 0, b: 0 }, PASMO);
  assert.ok(Math.abs(rgbNaOklch(czern).L - PASMO.lMax) < 0.01);
});

test('odwrocJasnosc: odcień przeżywa inwersję, jasność zostaje w paśmie', () => {
  const czerwien = { r: 210, g: 60, b: 43 };
  const przed = rgbNaOklch(czerwien);
  const po = rgbNaOklch(odwrocJasnosc(czerwien, PASMO));
  assert.ok(Math.abs(po.h - przed.h) < 0.02, 'czerwień zostaje czerwienią');
  assert.ok(po.L >= PASMO.lMin - 0.01 && po.L <= PASMO.lMax + 0.01, 'jasność w paśmie palety');
});

test('odwrocJasnosc: co było jaśniejsze, staje się ciemniejsze', () => {
  const jasny = odwrocJasnosc({ r: 240, g: 240, b: 240 }, PASMO);
  const ciemny = odwrocJasnosc({ r: 40, g: 40, b: 40 }, PASMO);
  assert.ok(rgbNaOklch(jasny).L < rgbNaOklch(ciemny).L);
});

test('parsujRgb: czyta rgb i rgba w obu składniach', () => {
  assert.deepEqual(parsujRgb('rgb(255, 128, 0)'), { r: 255, g: 128, b: 0, a: 1 });
  assert.deepEqual(parsujRgb('rgba(1, 2, 3, 0.5)'), { r: 1, g: 2, b: 3, a: 0.5 });
  assert.deepEqual(parsujRgb('rgb(1 2 3 / 0.25)'), { r: 1, g: 2, b: 3, a: 0.25 });
});

test('parsujRgb: śmieci dają null', () => {
  assert.equal(parsujRgb('czerwony'), null);
  assert.equal(parsujRgb(''), null);
  assert.equal(parsujRgb(undefined), null);
  assert.equal(parsujRgb('rgb(1, 2)'), null);
});

// Chrome NIE normalizuje nowych składni CSS Color 4 do rgb() · zostają w swojej postaci,
// więc parsujRgb ich nie tknie i Task 8 zostawi taki kolor nieodwrócony. Sprawdzone
// w przeglądarce: oklch/oklab/lab/lch/color()/color-mix() wychodzą z getComputedStyle
// dosłownie. To znane ograniczenie, a nie przeoczenie · dlatego ma własny test.
test('parsujRgb: nowe składnie CSS Color 4 zwracają null, bo przeglądarka ich nie normalizuje', () => {
  assert.equal(parsujRgb('oklch(0.6 0.06 30)'), null);
  assert.equal(parsujRgb('lab(50 40 30)'), null);
  assert.equal(parsujRgb('color(display-p3 1 0.5 0)'), null);
});

test('zapiszRgb: pomija alfę, gdy jest pełna', () => {
  assert.equal(zapiszRgb({ r: 1, g: 2, b: 3 }), 'rgb(1, 2, 3)');
  assert.equal(zapiszRgb({ r: 1, g: 2, b: 3, a: 0.5 }), 'rgba(1, 2, 3, 0.5)');
});

// Domyślne tło KAŻDEGO elementu to rgba(0, 0, 0, 0) · tak samo normalizuje się `transparent`.
// Alfa musi przeżyć obie strony, inaczej Task 8 zamieni przezroczyste tło w jasny prostokąt.
test('parsujRgb i zapiszRgb: pełna przezroczystość przeżywa w obie strony', () => {
  assert.deepEqual(parsujRgb('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 });
  assert.equal(zapiszRgb({ r: 0, g: 0, b: 0, a: 0 }), 'rgba(0, 0, 0, 0)');
});
