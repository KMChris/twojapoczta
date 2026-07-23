// Kryteria wyszukiwania: normalizacja, walidacja i kompilacja do SQL.
//
// Zasada nadrzędna specu: kryteria kompilują się do SQL RAZ. Wyszukiwarka
// wpina fragment po owner_id = ?, a silnik reguł (faza 3) użyje tego samego
// fragmentu z dopiskiem AND id = ?. Druga implementacja dopasowania to bug.
//
// Import z mail.js jest cykliczny (mail.js importuje stąd kompilację) i
// bezpieczny tylko dlatego, że po BUILTIN_FOLDERS sięgamy w ciele funkcji,
// gdy oba moduły są już zainicjowane. Nie używać go na poziomie modułu.

import { BUILTIN_FOLDERS } from './mail.js';

export const MAX_POLE_KRYTERIUM = 200;

const POLA_TEKSTOWE = ['from', 'to', 'subject', 'has', 'hasNot'];

// 'YYYY-MM-DD' i realna data: '2026-02-30' odpada na roundtripie przez Date.
function poprawnaData(tekst) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tekst)) return false;
  const data = new Date(`${tekst}T00:00:00Z`);
  return !Number.isNaN(data.getTime()) && data.toISOString().slice(0, 10) === tekst;
}

// Wejście bywa dwojakie: query string (same stringi) albo JSON reguły
// (faza 3; liczby i booleany). Normalizacja sprowadza oba do jednej postaci.
export function normalizujKryteria(surowe) {
  if (!surowe || typeof surowe !== 'object') {
    return { error: 'Podaj przynajmniej jedno kryterium.' };
  }
  const kryteria = {};

  for (const pole of POLA_TEKSTOWE) {
    const wartosc = String(surowe[pole] ?? '').trim().slice(0, MAX_POLE_KRYTERIUM);
    if (wartosc) kryteria[pole] = wartosc;
  }

  for (const pole of ['dateFrom', 'dateTo']) {
    const wartosc = String(surowe[pole] ?? '').trim();
    if (!wartosc) continue;
    if (!poprawnaData(wartosc)) return { error: 'Data w kryteriach ma mieć format RRRR-MM-DD.' };
    kryteria[pole] = wartosc;
  }
  if (kryteria.dateFrom && kryteria.dateTo && kryteria.dateFrom > kryteria.dateTo) {
    return { error: 'Zakres dat jest odwrócony: „od" wypada po „do".' };
  }

  const folder = String(surowe.folder ?? '').trim();
  if (folder) {
    if (!BUILTIN_FOLDERS.includes(folder)) return { error: 'Nieznany folder w kryteriach.' };
    kryteria.folder = folder;
  }

  if (surowe.folderId != null && surowe.folderId !== '') {
    const folderId = Number(surowe.folderId);
    if (!Number.isInteger(folderId) || folderId <= 0) {
      return { error: 'Nieprawidłowy folder własny w kryteriach.' };
    }
    kryteria.folderId = folderId;
  }
  if (kryteria.folder && kryteria.folderId) {
    return { error: 'Wybierz folder wbudowany albo własny, nie oba naraz.' };
  }

  const zalacznik = surowe.hasAttachment;
  if (zalacznik === true || zalacznik === 'true' || zalacznik === '1' || zalacznik === 1) {
    kryteria.hasAttachment = true;
  }

  if (!Object.keys(kryteria).length) return { error: 'Podaj przynajmniej jedno kryterium.' };
  return { kryteria };
}
