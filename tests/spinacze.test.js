// Jednostkowe testy polityki widocznych spinaczy (opcja B, dedup Content-ID).
// Pad rodziny „załącznik znika" siedział w kliencie: przy duplikacie Content-ID stary
// filtr (`!uzyteCid.has(z.content_id)`) chował OBA spinacze, a trasa `cid:` serwowała w treść
// tylko pierwszy → druga kopia ginęła (ani w treści, ani pod listem). Ten test pinuje naprawę
// „chowaj tylko pierwszy spinacz na skonsumowany Content-ID".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { widoczneSpinacze } from '../public/assets/js/app/spinacze.js';

const nazwy = (lista) => lista.map((z) => z.filename);

// Kolejność wejścia = kolejność z serwera (`ORDER BY a.id`), czyli ta sama, w której trasa
// `cid:` wybiera „pierwszy" wiersz. Dlatego pierwszy element to ten, którego obrazek ląduje
// w treści, a chowamy dokładnie jego.

test('duplikat cytowany: chowamy tylko pierwszy, druga kopia zostaje spinaczem', () => {
  const zalaczniki = [
    { id: 1, filename: 'pierwszy.png', content_id: 'dup@x' },
    { id: 2, filename: 'drugi.png', content_id: 'dup@x' },
  ];
  const spinacze = widoczneSpinacze(zalaczniki, new Set(['dup@x']));
  assert.deepEqual(nazwy(spinacze), ['drugi.png']);
});

test('trzy kopie tego samego Content-ID: pierwsza osadzona, dwie zostają', () => {
  const zalaczniki = [
    { id: 1, filename: 'x1.png', content_id: 'x@x' },
    { id: 2, filename: 'x2.png', content_id: 'x@x' },
    { id: 3, filename: 'x3.png', content_id: 'x@x' },
  ];
  const spinacze = widoczneSpinacze(zalaczniki, new Set(['x@x']));
  assert.deepEqual(nazwy(spinacze), ['x2.png', 'x3.png']);
});

test('pojedynczy osadzony: spinacz schowany', () => {
  const zalaczniki = [{ id: 1, filename: 'logo.png', content_id: 'logo@x' }];
  const spinacze = widoczneSpinacze(zalaczniki, new Set(['logo@x']));
  assert.deepEqual(nazwy(spinacze), []);
});

test('sierota: Content-ID w mapie, ale treść go nie cytuje → zostaje spinaczem', () => {
  const zalaczniki = [{ id: 1, filename: 'sierota.png', content_id: 'sierota@x' }];
  const spinacze = widoczneSpinacze(zalaczniki, new Set()); // renderer niczego nie wchłonął
  assert.deepEqual(nazwy(spinacze), ['sierota.png']);
});

test('mieszany: załącznik bez Content-ID nigdy nie znika', () => {
  const zalaczniki = [
    { id: 1, filename: 'logo.png', content_id: 'logo@x' },
    { id: 2, filename: 'zwykly.pdf', content_id: null },
  ];
  const spinacze = widoczneSpinacze(zalaczniki, new Set(['logo@x']));
  assert.deepEqual(nazwy(spinacze), ['zwykly.pdf']);
});

test('dwa różne Content-ID oba cytowane: oba osadzone, oba schowane', () => {
  const zalaczniki = [
    { id: 1, filename: 'a.png', content_id: 'a@x' },
    { id: 2, filename: 'b.png', content_id: 'b@x' },
  ];
  const spinacze = widoczneSpinacze(zalaczniki, new Set(['a@x', 'b@x']));
  assert.deepEqual(nazwy(spinacze), []);
});
