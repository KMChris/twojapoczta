// Strażnik niewidocznej umowy w znacznikach stron.
//
// `<svg>` wstawiony wprost w HTML działa bez `xmlns`, bo parser HTML sam wrzuca go do
// przestrzeni nazw SVG. Poza stroną (samodzielny plik, `data:image/svg+xml`) czyta go już
// parser XML i bez deklaracji to nie jest dokument SVG. Rozszerzenia motywów, np. Dark Reader,
// serializują nasze znaczniki i ładują jako obrazek, więc brak `xmlns` kończy się błędem
// w konsoli. Tego nie widać podczas normalnego klikania po aplikacji, dlatego pilnuje tego test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const katalog = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const strony = readdirSync(katalog).filter((nazwa) => nazwa.endsWith('.html'));

function wczytaj(nazwa) {
  return readFileSync(path.join(katalog, nazwa), 'utf8');
}

test('są strony do sprawdzenia', () => {
  assert.ok(strony.length >= 6, `spodziewane co najmniej 6 stron, jest ${strony.length}`);
});

test('każdy <svg> w stronach deklaruje xmlns', () => {
  for (const nazwa of strony) {
    // Lookahead nie przekracza '>', więc patrzy wyłącznie w obręb tego jednego znacznika.
    const bezXmlns = [...wczytaj(nazwa).matchAll(/<svg(?![^>]*xmlns=)[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(bezXmlns, [], `${nazwa}: <svg> bez xmlns`);
  }
});

// Pole bez `id` i bez `name` psuje autouzupełnianie i menedżery haseł, a przeglądarka
// zgłasza je tylko w panelu Issues, więc w konsoli tego nie widać. Test patrzy na znaczniki
// w stronach; pola tworzone z JS (panel administratora) trzeba pilnować osobno.
test('każde pole formularza ma id albo name', () => {
  for (const nazwa of strony) {
    const bez = [...wczytaj(nazwa).matchAll(/<(?:input|select|textarea)(?![^>]*\s(?:id|name)=)[^>]*>/g)];
    assert.deepEqual(bez.map((m) => m[0]), [], `${nazwa}: pole bez id i name`);
  }
});

test('każda strona deklaruje color-scheme', () => {
  for (const nazwa of strony) {
    assert.match(wczytaj(nazwa), /<meta name="color-scheme"/, `${nazwa}: brak meta color-scheme`);
  }
});
