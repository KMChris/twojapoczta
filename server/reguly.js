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
import { validateForwardTarget, forwardCopyTo } from './mail.js';

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

function wiersz(db, userId, id) {
  return db.prepare('SELECT * FROM rules WHERE id = ? AND user_id = ?').get(id, userId);
}

function parsuj(r) {
  return { ...r, criteria: JSON.parse(r.criteria), actions: JSON.parse(r.actions) };
}

export function listRules(db, userId) {
  return db
    .prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY position, id')
    .all(userId)
    .map(parsuj);
}

export function createRule(db, user, { name, criteria, actions }) {
  const kryt = normalizujKryteria(criteria);
  if (kryt.error) return { error: kryt.error };
  const akc = walidujAkcje(db, user, actions);
  if (akc.error) return { error: akc.error };
  const position = db
    .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM rules WHERE user_id = ?')
    .get(user.id).p;
  const id = Number(
    db.prepare(
      'INSERT INTO rules (user_id, name, criteria, actions, position, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      user.id,
      String(name ?? '').trim().slice(0, 80),
      JSON.stringify(kryt.kryteria),
      JSON.stringify(akc.akcje),
      position,
      now()
    ).lastInsertRowid
  );
  return { rule: parsuj(wiersz(db, user.id, id)) };
}

export function updateRule(db, user, id, patch) {
  const stara = wiersz(db, user.id, id);
  if (!stara) return { error: 'Nie znaleziono reguły.', notFound: true };

  const sets = [];
  const params = [];
  if ('name' in patch) {
    sets.push('name = ?');
    params.push(String(patch.name ?? '').trim().slice(0, 80));
  }
  if ('criteria' in patch) {
    const kryt = normalizujKryteria(patch.criteria);
    if (kryt.error) return { error: kryt.error };
    sets.push('criteria = ?');
    params.push(JSON.stringify(kryt.kryteria));
  }
  if ('actions' in patch) {
    const akc = walidujAkcje(db, user, patch.actions);
    if (akc.error) return { error: akc.error };
    sets.push('actions = ?');
    params.push(JSON.stringify(akc.akcje));
  }
  if ('is_active' in patch) {
    const wlaczana = patch.is_active ? 1 : 0;
    if (wlaczana) {
      // Reguła mogła stracić cel przy kasowaniu folderu; włączać wolno tylko zdrową.
      const kryteria = 'criteria' in patch ? patch.criteria : JSON.parse(stara.criteria);
      const akcje = 'actions' in patch ? patch.actions : JSON.parse(stara.actions);
      const kryt = normalizujKryteria(kryteria);
      if (kryt.error) return { error: kryt.error };
      const akc = walidujAkcje(db, user, akcje);
      if (akc.error) return { error: akc.error };
    }
    sets.push('is_active = ?');
    params.push(wlaczana);
  }
  if (sets.length) {
    db.prepare(`UPDATE rules SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...params, id, user.id);
  }
  return { rule: parsuj(wiersz(db, user.id, id)) };
}

export function deleteRule(db, userId, id) {
  const zmiany = db.prepare('DELETE FROM rules WHERE id = ? AND user_id = ?').run(id, userId).changes;
  return zmiany ? { deleted: true } : { error: 'Nie znaleziono reguły.', notFound: true };
}

const RANGA_CELU = { delete: 3, moveTo: 2, archive: 1 };

// Składa akcje wszystkich pasujących, aktywnych reguł (po position rosnąco)
// i stosuje je do wiadomości. Dopasowanie = zapytanie wyszukiwarki + AND id = ?.
// Wołać PO zatwierdzeniu transakcji doręczenia, przed przekierowaniem skrzynki.
export function applyRules(db, ownerId, messageId, { skipForward = false } = {}) {
  const reguly = db
    .prepare('SELECT * FROM rules WHERE user_id = ? AND is_active = 1 ORDER BY position, id')
    .all(ownerId);
  if (!reguly.length) return { matched: 0, skippedForward: 0 };
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND owner_id = ?').get(messageId, ownerId);
  if (!msg) return { matched: 0, skippedForward: 0 };

  let matched = 0;
  const zlozone = { forwardTo: [] };
  let cel = null; // { ranga, rodzaj, folderId? } — precedencja: usuń > przenieś > archiwizuj

  for (const regula of reguly) {
    let kryteria;
    let akcje;
    try {
      kryteria = normalizujKryteria(JSON.parse(regula.criteria));
      akcje = JSON.parse(regula.actions);
    } catch {
      continue; // zepsuty JSON nie może zablokować doręczenia
    }
    if (kryteria.error) continue;
    const { sql, params } = kompilujKryteria(kryteria.kryteria);
    const pasuje = db
      .prepare(`SELECT id FROM messages WHERE owner_id = ? AND ${sql} AND id = ?`)
      .get(ownerId, ...params, messageId);
    if (!pasuje) continue;
    matched += 1;

    if (akcje.markRead) zlozone.markRead = true;
    if (akcje.star) zlozone.star = true;
    if (akcje.neverSpam) zlozone.neverSpam = true;
    // „Zawsze" kontra „nigdy": wygrywa reguła o wyższej pozycji, czyli późniejsze
    // przypisanie w tej pętli.
    if (akcje.priority === 'always' || akcje.priority === 'never') zlozone.priority = akcje.priority;

    for (const [rodzaj, ranga] of Object.entries(RANGA_CELU)) {
      if (!akcje[rodzaj]) continue;
      // >= zamiast >: przy równej randze (dwa moveTo) późniejsza reguła wygrywa,
      // spójnie z rozstrzyganiem priorytetu.
      if (!cel || ranga >= cel.ranga) cel = { ranga, rodzaj, folderId: akcje.moveTo };
    }
    if (akcje.forwardTo && !zlozone.forwardTo.includes(akcje.forwardTo)) {
      zlozone.forwardTo.push(akcje.forwardTo);
    }
  }
  if (!matched) return { matched: 0, skippedForward: 0 };

  const sets = [];
  const params = [];
  if (zlozone.markRead) sets.push('is_read = 1');
  if (zlozone.star) sets.push('is_starred = 1');
  if (zlozone.priority) sets.push(`is_priority = ${zlozone.priority === 'always' ? 1 : 0}`);
  if (cel?.rodzaj === 'delete') sets.push("folder = 'trash'", 'folder_id = NULL');
  else if (cel?.rodzaj === 'archive') sets.push("folder = 'archive'", 'folder_id = NULL');
  else if (cel?.rodzaj === 'moveTo') {
    // Folder mógł zniknąć między walidacją a doręczeniem (kasowanie folderu
    // wyłącza reguły, ale wyścig jest możliwy) — wtedy cel po prostu przepada.
    const istnieje = db
      .prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
      .get(cel.folderId, ownerId);
    if (istnieje) {
      sets.push("folder = 'custom'", 'folder_id = ?');
      params.push(cel.folderId);
    }
  }
  if (sets.length) {
    db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`)
      .run(...params, messageId, ownerId);
  }

  if (skipForward) return { matched, skippedForward: zlozone.forwardTo.length };
  for (const adres of zlozone.forwardTo) {
    try {
      // Pętli reguł nie trzeba tu wycinać zbiorem odwiedzonych: kopia z przekazania
      // nie przechodzi przez reguły odbiorcy (forwardCopyTo ciągnie wyłącznie
      // łańcuch USTAWIEŃ skrzynek), więc reguła nie ma jak odbić listu z powrotem.
      forwardCopyTo(db, ownerId, msg, adres, {});
    } catch (err) {
      console.error('[reguly] nie udało się przekazać dalej', messageId, err);
    }
  }
  return { matched, skippedForward: 0 };
}

// Zamiana miejscami z sąsiadem; na krańcu listy nic się nie dzieje.
export function moveRule(db, userId, id, kierunek) {
  const regula = wiersz(db, userId, id);
  if (!regula) return { error: 'Nie znaleziono reguły.', notFound: true };
  const sasiad = db
    .prepare(
      kierunek === 'up'
        ? 'SELECT * FROM rules WHERE user_id = ? AND (position < ? OR (position = ? AND id < ?)) ORDER BY position DESC, id DESC LIMIT 1'
        : 'SELECT * FROM rules WHERE user_id = ? AND (position > ? OR (position = ? AND id > ?)) ORDER BY position ASC, id ASC LIMIT 1'
    )
    .get(userId, regula.position, regula.position, regula.id);
  if (sasiad) {
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE rules SET position = ? WHERE id = ?').run(sasiad.position, regula.id);
      db.prepare('UPDATE rules SET position = ? WHERE id = ?').run(regula.position, sasiad.id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return { rules: listRules(db, userId) };
}
