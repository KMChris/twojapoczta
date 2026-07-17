// Załączniki: blob-y adresowane hashem (jedna treść, wiele kopii wiadomości),
// tokeny uploadu ważne 24 h i leniwe odśmiecanie.

import crypto from 'node:crypto';
import { now } from './db.js';
import { hasRoom } from './quota.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB na plik
export const MAX_FILES_PER_MESSAGE = 10;
export const MAX_CONTENT_ID_CHARS = 200; // nasze ograniczenie danych od nadawcy, kolumna jest zwykłym TEXT
const UPLOAD_TTL_MS = 24 * 3600_000;

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
// Typy, które przeglądarka mogłaby wykonać: zawsze serwowane neutralnie.
const NIEBEZPIECZNE_MIME = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml', 'text/xml', 'application/xml']);

// Przeglądarka renderuje XML, a `<?xml-stylesheet type="text/xsl">` potrafi z tego zrobić
// wykonanie skryptu · dlatego cała rodzina `+xml`, a nie tylko typy wypisane z nazwy.
// Sufiks, bo tych typów jest otwarty zbiór: rss+xml, atom+xml, soap+xml i co jeszcze wymyślą.
function wykonywalnyWPrzegladarce(mime) {
  return NIEBEZPIECZNE_MIME.has(mime) || mime.endsWith('+xml');
}

export function sanitizeMime(mime) {
  const czysty = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (!MIME_RE.test(czysty) || wykonywalnyWPrzegladarce(czysty)) return 'application/octet-stream';
  return czysty;
}

export function sanitizeFilename(filename) {
  const czysty = String(filename ?? 'plik')
    .replace(/[\r\n\0]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 160);
  return czysty || 'plik';
}

export function saveUpload(db, userId, { filename, mime, buffer }) {
  pruneUploads(db);
  if (buffer.length > MAX_FILE_BYTES) {
    return { error: 'Załącznik może mieć najwyżej 5 MB.' };
  }
  if (!buffer.length) return { error: 'Plik jest pusty.' };
  if (!hasRoom(db, userId, buffer.length)) {
    return { error: 'Brak miejsca w skrzynce. Osiągnięto limit przydzielony przez administratora.' };
  }

  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  db.prepare('INSERT OR IGNORE INTO blobs (hash, data, size) VALUES (?, ?, ?)').run(hash, buffer, buffer.length);

  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare(
    'INSERT INTO uploads (token, user_id, filename, mime, size, blob_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(token, userId, sanitizeFilename(filename), sanitizeMime(mime), buffer.length, hash, now());

  return { upload: { token, filename: sanitizeFilename(filename), mime: sanitizeMime(mime), size: buffer.length } };
}

// Pobiera i weryfikuje tokeny przed wysyłką (bez kasowania, to robi bindUploads).
export function claimUploads(db, userId, tokens) {
  const lista = [...new Set((tokens ?? []).map(String))];
  if (!lista.length) return { uploads: [] };
  if (lista.length > MAX_FILES_PER_MESSAGE) {
    return { error: `Najwyżej ${MAX_FILES_PER_MESSAGE} załączników w jednej wiadomości.` };
  }
  const uploads = [];
  const zapytanie = db.prepare('SELECT * FROM uploads WHERE token = ? AND user_id = ?');
  for (const token of lista) {
    const wpis = zapytanie.get(token, userId);
    if (!wpis) return { error: 'Któryś z załączników wygasł. Dodaj go ponownie.' };
    uploads.push(wpis);
  }
  return { uploads };
}

// Przypina zweryfikowane uploady do wszystkich kopii wiadomości i zużywa tokeny.
export function bindUploads(db, uploads, messageIds) {
  if (!uploads.length) return;
  const insert = db.prepare(
    'INSERT INTO attachments (message_id, filename, mime, size, blob_hash) VALUES (?, ?, ?, ?, ?)'
  );
  for (const messageId of messageIds) {
    for (const u of uploads) insert.run(messageId, u.filename, u.mime, u.size, u.blob_hash);
    db.prepare('UPDATE messages SET attachments_count = ? WHERE id = ?').run(uploads.length, messageId);
  }
  const usun = db.prepare('DELETE FROM uploads WHERE token = ?');
  for (const u of uploads) usun.run(u.token);
}

export function listAttachments(db, ownerId, messageId) {
  return db
    .prepare(
      `SELECT a.id, a.filename, a.mime, a.size, a.content_id FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.id = ? AND m.owner_id = ? ORDER BY a.id`
    )
    .all(messageId, ownerId);
}

export function getAttachment(db, ownerId, messageId, attachmentId) {
  const meta = db
    .prepare(
      `SELECT a.id, a.filename, a.mime, a.size, a.blob_hash FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE a.id = ? AND m.id = ? AND m.owner_id = ?`
    )
    .get(attachmentId, messageId, ownerId);
  if (!meta) return null;
  const blob = db.prepare('SELECT data FROM blobs WHERE hash = ?').get(meta.blob_hash);
  if (!blob) return null;
  return { ...meta, data: blob.data };
}

// Obrazek osadzony po Content-ID. Jak `getAttachment`, ale adresowany tym,
// czym adresuje go treść listu. Przy dwóch częściach o tym samym Content-ID
// `ORDER BY` wiąże ten adres z pierwszym wierszem · dokładnie tym, który mapa
// w `GET /api/messages/:id` chowa z listy załączników. Dziś to samo oddaje plan
// zapytania, więc żaden test tego nie odróżni · piszemy to wprost, bo zgodność
// obu stron ma zależeć od nas, a nie od tego, jaki indeks wybierze SQLite.
export function getAttachmentByCid(db, ownerId, messageId, contentId) {
  const meta = db
    .prepare(
      `SELECT a.id, a.filename, a.mime, a.size, a.blob_hash FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE a.content_id = ? AND m.id = ? AND m.owner_id = ?
       ORDER BY a.id`
    )
    .get(String(contentId), messageId, ownerId);
  if (!meta) return null;
  const blob = db.prepare('SELECT data FROM blobs WHERE hash = ?').get(meta.blob_hash);
  if (!blob) return null;
  return { ...meta, data: blob.data };
}

function normalizeContentId(contentId) {
  if (!contentId) return null;
  const czysty = String(contentId);
  return czysty.length > MAX_CONTENT_ID_CHARS ? null : czysty;
}

function pruneUploads(db) {
  const granica = new Date(Date.now() - UPLOAD_TTL_MS).toISOString();
  const wynik = db.prepare('DELETE FROM uploads WHERE created_at < ?').run(granica);
  if (wynik.changes) gcBlobs(db);
}

// Zapis załącznika prosto z parsera (poczta przychodząca), bez tokenów uploadu.
// Zbyt długi Content-ID zapisujemy jako `null`, nie obcinamy · `body_html` idzie do bazy
// dosłownie, więc obcięty klucz dopasowałby się do prefiksu pełnego odwołania w treści —
// wtedy, gdy znak zaraz za obcięciem nie przedłuża identyfikatora w oczach `htmlCytujeCid`
// (apostrof albo cokolwiek spoza atextu; na literze czy `~` obcięcie by się nie dopasowało).
// Taki załącznik wpadłby do mapy `cid` (i zniknął z listy) pod kluczem, o który klient nigdy
// nie zapyta, bo z treści czyta odwołanie pełne. Nie chcemy zgadywać, na który z tych
// znaków trafimy · bez Content-ID zostaje zwykłym, widocznym załącznikiem.
export function storeAttachment(db, messageId, { filename, mime, data, contentId = null }) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buffer.length || buffer.length > MAX_FILE_BYTES) return false;
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  db.prepare('INSERT OR IGNORE INTO blobs (hash, data, size) VALUES (?, ?, ?)').run(hash, buffer, buffer.length);
  db.prepare(
    `INSERT INTO attachments (message_id, filename, mime, size, blob_hash, content_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    messageId,
    sanitizeFilename(filename),
    sanitizeMime(mime),
    buffer.length,
    hash,
    normalizeContentId(contentId)
  );
  return true;
}

// Usuwa treści, do których nic już nie prowadzi.
export function gcBlobs(db) {
  db.exec(
    `DELETE FROM blobs WHERE hash NOT IN (SELECT blob_hash FROM attachments)
     AND hash NOT IN (SELECT blob_hash FROM uploads)`
  );
}
