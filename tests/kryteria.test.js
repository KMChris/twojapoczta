// Kryteria wyszukiwania: normalizacja, walidacja i kompilacja do jednego SQL.
// Ta sama kompilacja obsłuży w fazie 3 silnik reguł, więc pilnujemy jej ostro.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizujKryteria, MAX_POLE_KRYTERIUM } from '../server/kryteria.js';

test('normalizacja: przycina białe znaki i długość, gubi puste pola', () => {
  const { kryteria } = normalizujKryteria({
    from: '  faktury@  ',
    subject: 'x'.repeat(MAX_POLE_KRYTERIUM + 50),
    to: '   ',
    has: '',
  });
  assert.deepEqual(Object.keys(kryteria).sort(), ['from', 'subject']);
  assert.equal(kryteria.from, 'faktury@');
  assert.equal(kryteria.subject.length, MAX_POLE_KRYTERIUM);
});

test('normalizacja: puste kryteria to błąd, nie „pasuje wszystko"', () => {
  assert.match(normalizujKryteria({}).error, /przynajmniej jedno/);
  assert.match(normalizujKryteria({ from: '  ', to: '' }).error, /przynajmniej jedno/);
  assert.match(normalizujKryteria(null).error, /przynajmniej jedno/);
});

test('normalizacja: folder i folderId wykluczają się', () => {
  assert.match(normalizujKryteria({ folder: 'inbox', folderId: 3 }).error, /nie oba naraz/);
});

test('normalizacja: folder tylko wbudowany', () => {
  assert.equal(normalizujKryteria({ folder: 'archive' }).kryteria.folder, 'archive');
  for (const zly of ['wszedzie', 'starred', 'custom', 'INBOX']) {
    assert.match(normalizujKryteria({ folder: zly }).error, /Nieznany folder/);
  }
});

test('normalizacja: folderId musi być dodatnią liczbą całkowitą', () => {
  assert.equal(normalizujKryteria({ folderId: '12' }).kryteria.folderId, 12);
  for (const zly of ['abc', '-3', '1.5', 0]) {
    assert.match(normalizujKryteria({ folderId: zly }).error, /folder/i);
  }
});

test('normalizacja: daty w formacie RRRR-MM-DD i realne w kalendarzu', () => {
  const { kryteria } = normalizujKryteria({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
  assert.equal(kryteria.dateFrom, '2026-01-01');
  assert.equal(kryteria.dateTo, '2026-12-31');
  for (const zla of ['31-12-2026', '2026-2-3', '2026-02-30', 'wczoraj']) {
    assert.match(normalizujKryteria({ dateFrom: zla }).error, /RRRR-MM-DD/);
    assert.match(normalizujKryteria({ dateTo: zla }).error, /RRRR-MM-DD/);
  }
});

test('normalizacja: odwrócony zakres dat to błąd, równe daty nie', () => {
  assert.match(
    normalizujKryteria({ dateFrom: '2026-05-02', dateTo: '2026-05-01' }).error,
    /odwrócony/
  );
  assert.ok(normalizujKryteria({ dateFrom: '2026-05-01', dateTo: '2026-05-01' }).kryteria);
});

test('normalizacja: hasAttachment przyjmuje tylko jawne „tak"', () => {
  for (const tak of [true, 'true', '1', 1]) {
    assert.equal(normalizujKryteria({ hasAttachment: tak }).kryteria.hasAttachment, true);
  }
  for (const nie of [false, 'false', '', '0', undefined]) {
    const wynik = normalizujKryteria({ hasAttachment: nie, from: 'x' });
    assert.equal(wynik.kryteria.hasAttachment, undefined);
  }
});
