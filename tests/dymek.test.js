// Jednostkowe testy geometrii dymka: centrowanie nad celem, klamry do okna, flip pod cel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pozycjaDymka } from '../public/assets/js/app/dymek.js';

const WIDOK = { width: 1000, height: 800 };
const DYMEK = { width: 80, height: 30 };

test('pozycjaDymka: dymek staje wyśrodkowany nad celem', () => {
  const cel = { left: 100, top: 100, width: 40, bottom: 124 };
  assert.deepEqual(pozycjaDymka(cel, DYMEK, WIDOK), { left: 80, top: 62, podCelem: false });
});

test('pozycjaDymka: przy lewej krawędzi klamruje do odstępu', () => {
  const cel = { left: 0, top: 100, width: 40, bottom: 124 };
  assert.equal(pozycjaDymka(cel, DYMEK, WIDOK).left, 8);
});

test('pozycjaDymka: przy prawej krawędzi klamruje do okna minus odstęp', () => {
  const cel = { left: 960, top: 100, width: 40, bottom: 124 };
  assert.equal(pozycjaDymka(cel, DYMEK, WIDOK).left, WIDOK.width - DYMEK.width - 8);
});

test('pozycjaDymka: gdy u góry brak miejsca, dymek schodzi pod cel', () => {
  const cel = { left: 100, top: 20, width: 40, bottom: 44 };
  const p = pozycjaDymka(cel, DYMEK, WIDOK);
  assert.equal(p.top, 52);
  assert.equal(p.podCelem, true);
});

test('pozycjaDymka: w ciasnym widoku lewa klamra wygrywa z prawą', () => {
  const cel = { left: 100, top: 100, width: 40, bottom: 124 };
  const p = pozycjaDymka(cel, { width: 190, height: 30 }, { width: 200, height: 800 });
  assert.equal(p.left, 8);
});

test('pozycjaDymka: odstęp jest parametryzowany', () => {
  const cel = { left: 100, top: 100, width: 40, bottom: 124 };
  assert.equal(pozycjaDymka(cel, DYMEK, WIDOK, 12).top, 100 - 30 - 12);
});
