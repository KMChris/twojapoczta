// Foldery użytkownika: płaskie, jeden poziom, obok wbudowanych.
//
// Niezmiennik całej funkcji: wiadomość w folderze własnym ma folder='custom'
// ORAZ folder_id=N. Każde miejsce ustawiające folder musi wyzerować folder_id
// w tym samym UPDATE — inaczej wiadomość zniknie z każdego widoku.

import { now } from './db.js';

export const MAX_FOLDER_NAME = 40;

// Lustro NAZW z public/assets/js/app/main.js. Własny folder nie może udawać
// wbudowanego, bo panel boczny pokazałby dwa „Archiwum".
const NAZWY_WBUDOWANE = [
  'Odebrane', 'Z gwiazdką', 'Wysłane', 'Zaplanowane',
  'Wersje robocze', 'Archiwum', 'Spam', 'Kosz',
];

// „ Moje   faktury " → „Moje faktury".
export function normalizeName(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

// SQLite zna NOCASE tylko dla ASCII, więc „Ł" i „ł" byłyby dla bazy różne.
// Unikalność rozstrzygamy tutaj; UNIQUE w schemacie zostaje jako ostatnia deska.
function zloz(nazwa) {
  return nazwa.toLocaleLowerCase('pl');
}

function walidujNazwe(db, userId, nazwa, pomijId) {
  if (!nazwa) return 'Podaj nazwę folderu.';
  if (nazwa.length > MAX_FOLDER_NAME) {
    return `Nazwa folderu może mieć najwyżej ${MAX_FOLDER_NAME} znaków.`;
  }
  const zlozona = zloz(nazwa);
  if (NAZWY_WBUDOWANE.some((n) => zloz(n) === zlozona)) {
    return `„${nazwa}" to nazwa folderu wbudowanego. Wybierz inną.`;
  }
  const kolizja = db
    .prepare('SELECT id, name FROM folders WHERE user_id = ?')
    .all(userId)
    .find((f) => f.id !== pomijId && zloz(f.name) === zlozona);
  return kolizja ? `Masz już folder „${kolizja.name}".` : null;
}

// count = wszystkie wiadomości w folderze (nie tylko nieprzeczytane): tego
// potrzebuje okno potwierdzenia przy usuwaniu. Odznaki nieprzeczytanych jadą
// osobno, w unreadCounts.
export function listFolders(db, userId) {
  return db
    .prepare(
      `SELECT f.id, f.name, f.position,
              (SELECT COUNT(*) FROM messages m
                WHERE m.owner_id = f.user_id AND m.folder_id = f.id) AS count
       FROM folders f WHERE f.user_id = ? ORDER BY f.position, f.id`
    )
    .all(userId);
}

export function createFolder(db, userId, rawName) {
  const name = normalizeName(rawName);
  const blad = walidujNazwe(db, userId, name, null);
  if (blad) return { error: blad };
  const position = db
    .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM folders WHERE user_id = ?')
    .get(userId).p;
  const id = Number(
    db.prepare('INSERT INTO folders (user_id, name, position, created_at) VALUES (?, ?, ?, ?)')
      .run(userId, name, position, now()).lastInsertRowid
  );
  return { folder: { id, name, position } };
}

export function renameFolder(db, userId, id, rawName) {
  const istnieje = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(id, userId);
  if (!istnieje) return { error: 'Nie znaleziono folderu.', notFound: true };
  const name = normalizeName(rawName);
  const blad = walidujNazwe(db, userId, name, id);
  if (blad) return { error: blad };
  db.prepare('UPDATE folders SET name = ? WHERE id = ? AND user_id = ?').run(name, id, userId);
  return { folder: { id, name } };
}

// Usunięcie folderu nie może zgubić ani jednej wiadomości. Idą do Archiwum,
// nie do Odebranych: dwieście starych listów na górze skrzynki to nie jest to,
// czego ktokolwiek chce, a Archiwum jest bezpieczne i przeszukiwalne.
//
// Warunek folder='custom' w UPDATE nie jest ozdobą: bez niego zabralibyśmy też
// wiadomości, które z tego folderu poszły do kosza (mają jeszcze folder_id,
// gdyby ktoś kiedyś złamał niezmiennik) i wskrzesili je w Archiwum.
//
// Reguły przenoszące do tego folderu wyłącza faza 3 — tabeli rules jeszcze nie ma.
export function deleteFolder(db, userId, id) {
  const folder = db.prepare('SELECT id, name FROM folders WHERE id = ? AND user_id = ?').get(id, userId);
  if (!folder) return { error: 'Nie znaleziono folderu.', notFound: true };

  let moved = 0;
  db.exec('BEGIN');
  try {
    moved = db
      .prepare(
        `UPDATE messages SET folder = 'archive', folder_id = NULL
         WHERE owner_id = ? AND folder_id = ? AND folder = 'custom'`
      )
      .run(userId, id).changes;
    db.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').run(id, userId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { deleted: true, moved, name: folder.name };
}
