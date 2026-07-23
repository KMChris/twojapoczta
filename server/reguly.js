// Reguły wiadomości: walidacja, CRUD, silnik i przebieg wsadowy.
//
// Dopasowanie reguły do wiadomości to zapytanie wyszukiwarki zawężone do
// jednego wiersza: WHERE owner_id = ? AND <kompilujKryteria> AND id = ?.
// Nie ma tu drugiego matchera i nie wolno go dopisać — podgląd w panelu
// filtrów i werdykt silnika mają być z definicji tym samym pytaniem.
//
// Import z mail.js jest cykliczny (mail woła applyRules po doręczeniu);
// bezpieczny, bo po symbolach sięgamy wyłącznie w ciałach funkcji.

import { now } from './db.js';
import { normalizujKryteria, kompilujKryteria } from './kryteria.js';
import { validateForwardTarget } from './mail.js';

const FLAGI = ['archive', 'markRead', 'star', 'delete', 'neverSpam'];

function prawdziwa(wartosc) {
  return wartosc === true || wartosc === 'true' || wartosc === '1' || wartosc === 1;
}

export function walidujAkcje(db, user, surowe) {
  if (!surowe || typeof surowe !== 'object') return { error: 'Reguła musi mieć przynajmniej jedną akcję.' };
  const akcje = {};
  for (const flaga of FLAGI) if (prawdziwa(surowe[flaga])) akcje[flaga] = true;

  if (surowe.priority != null && surowe.priority !== '') {
    if (surowe.priority !== 'always' && surowe.priority !== 'never') {
      return { error: 'Priorytet w regule może być tylko „zawsze" albo „nigdy".' };
    }
    akcje.priority = surowe.priority;
  }

  if (surowe.moveTo != null && surowe.moveTo !== '') {
    const folderId = Number(surowe.moveTo);
    const wlasny = Number.isInteger(folderId) && folderId > 0
      ? db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(folderId, user.id)
      : null;
    if (!wlasny) return { error: 'Reguła może przenosić tylko do Twojego folderu.' };
    akcje.moveTo = folderId;
  }

  if (surowe.forwardTo != null && String(surowe.forwardTo).trim() !== '') {
    const wynik = validateForwardTarget(db, user, surowe.forwardTo);
    if (wynik.error) return { error: wynik.error };
    akcje.forwardTo = wynik.cel;
  }

  if (!Object.keys(akcje).length) return { error: 'Reguła musi mieć przynajmniej jedną akcję.' };
  return { akcje };
}
