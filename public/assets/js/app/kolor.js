// Konwersje sRGB ↔ OKLCH i inwersja jasności dla ciemnego motywu.
//
// Moduł czysty: bez DOM i bez zależności, żeby dało się go przetestować
// w `node --test`. Wszystko, co potrzebuje drzewa, będzie siedzieć w tresc.js (Task 6).
//
// OKLCH, a nie HSL, bo jasność ma tu odpowiadać jasności widzianej okiem.
// W HSL #ff0 i #00f mają tę samą „jasność”, co przy odwracaniu widać od razu.

function doLiniowego(kanal) {
  const c = kanal / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function zLiniowego(kanal) {
  const c = kanal <= 0.0031308 ? kanal * 12.92 : 1.055 * Math.max(0, kanal) ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}

export function rgbNaOklch({ r, g, b }) {
  const lr = doLiniowego(r);
  const lg = doLiniowego(g);
  const lb = doLiniowego(b);

  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  return { L, C: Math.hypot(A, B), h: Math.atan2(B, A) };
}

export function oklchNaRgb({ L, C, h }) {
  const A = C * Math.cos(h);
  const B = C * Math.sin(h);

  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;

  return {
    r: zLiniowego(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: zLiniowego(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: zLiniowego(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

// Odwraca jasność, zostawiając odcień i nasycenie. Skrajności kotwiczymy
// w palecie aplikacji (`lMin` = --papier, `lMax` = --atrament), więc biel
// newslettera ląduje w granacie „nocnej sortowni”, a nie w czystej czerni.
export function odwrocJasnosc(rgb, { lMin, lMax }) {
  const { L, C, h } = rgbNaOklch(rgb);
  return oklchNaRgb({ L: lMin + (1 - L) * (lMax - lMin), C, h });
}

// Wejście: `rgb(…)`/`rgba(…)`. Przeglądarka w computed serializuje ZAWSZE przecinkowo ·
// składnię ukośnikową (`rgb(1 2 3 / .25)`) parsujRgb przyjmuje dodatkowo, obronnie, jako
// ogólny parser. Ukośnik nie pochodzi od przeglądarki.
export function parsujRgb(tekst) {
  const dopasowanie = String(tekst ?? '').trim().match(/^rgba?\(([^)]*)\)$/i);
  if (!dopasowanie) return null;
  const czesci = dopasowanie[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (czesci.length < 3 || czesci.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
  const alfa = czesci.length > 3 && Number.isFinite(czesci[3]) ? czesci[3] : 1;
  return { r: czesci[0], g: czesci[1], b: czesci[2], a: alfa };
}

export function zapiszRgb({ r, g, b, a = 1 }) {
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}
