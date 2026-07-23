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

// Eskejpowanie LIKE wzorcem z listMessages: %, _ i \ stają się literałami.
function wzorzecLike(tekst) {
  return `%${tekst.replace(/[\\%_]/g, '\\$&')}%`;
}

// Te same 5 kolumn co dzisiejsze q w listMessages — spec wymaga tej spójności.
const SZEROKIE_LIKE =
  "(subject LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\'" +
  " OR from_addr LIKE ? ESCAPE '\\' OR to_addr LIKE ? ESCAPE '\\')";

// sent_at to pełne ISO UTC, więc "cały dzień dateTo" to sent_at < dzień następny.
function dzienPo(data) {
  const d = new Date(`${data}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Kryteria (znormalizowane!) → fragment WHERE bez owner_id, do wpięcia przez AND.
// Czysta funkcja: żadnej bazy, żadnego stanu. Faza 3 dołoży do wyniku AND id = ?
// i to będzie CAŁY silnik dopasowania reguł.
export function kompilujKryteria(kryteria) {
  const czesci = [];
  const params = [];

  if (kryteria.from) {
    czesci.push("(from_addr LIKE ? ESCAPE '\\' OR from_name LIKE ? ESCAPE '\\')");
    const wzorzec = wzorzecLike(kryteria.from);
    params.push(wzorzec, wzorzec);
  }
  if (kryteria.to) {
    // „Do" pyta, czy list szedł do adresata — kopia (DW) też się liczy.
    czesci.push("(to_addr LIKE ? ESCAPE '\\' OR cc_addr LIKE ? ESCAPE '\\')");
    const wzorzec = wzorzecLike(kryteria.to);
    params.push(wzorzec, wzorzec);
  }
  if (kryteria.subject) {
    czesci.push("subject LIKE ? ESCAPE '\\'");
    params.push(wzorzecLike(kryteria.subject));
  }
  if (kryteria.has) {
    czesci.push(SZEROKIE_LIKE);
    params.push(...Array(5).fill(wzorzecLike(kryteria.has)));
  }
  if (kryteria.hasNot) {
    // Kolumny są NOT NULL DEFAULT '', więc NOT (… LIKE …) nie wpada w pułapkę NULL.
    czesci.push(`NOT ${SZEROKIE_LIKE}`);
    params.push(...Array(5).fill(wzorzecLike(kryteria.hasNot)));
  }
  if (kryteria.dateFrom) {
    czesci.push('sent_at >= ?');
    params.push(kryteria.dateFrom);
  }
  if (kryteria.dateTo) {
    czesci.push('sent_at < ?');
    params.push(dzienPo(kryteria.dateTo));
  }
  if (kryteria.hasAttachment) czesci.push('attachments_count > 0');

  if (kryteria.folderId) {
    czesci.push("(folder = 'custom' AND folder_id = ?)");
    params.push(kryteria.folderId);
  } else if (kryteria.folder) {
    czesci.push('folder = ?');
    params.push(kryteria.folder);
  } else {
    // Jak w Gmailu: bez wskazania folderu szukamy wszędzie poza Koszem i Spamem.
    czesci.push("folder NOT IN ('trash', 'spam')");
  }

  // Normalizacja odrzuca puste kryteria; trafienie tutaj to błąd wywołującego.
  if (!params.length && czesci.length === 1) throw new Error('puste kryteria');
  return { sql: czesci.join(' AND '), params };
}
