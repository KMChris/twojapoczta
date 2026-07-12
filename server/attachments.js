// Załączniki: blob-y adresowane hashem (jedna treść, wiele kopii wiadomości),
// tokeny uploadu ważne 24 h i leniwe odśmiecanie.

import crypto from 'node:crypto';
import { now } from './db.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB na plik
export const MAX_FILES_PER_MESSAGE = 10;
const UPLOAD_TTL_MS = 24 * 3600_000;

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;
// Typy, które przeglądarka mogłaby wykonać: zawsze serwowane neutralnie.
const NIEBEZPIECZNE_MIME = new Set(['text/html', 'application/xhtml+xml', 'image/svg+xml']);

export function sanitizeMime(mime) {
  const czysty = String(mime ?? '').split(';')[0].trim().toLowerCase();
  if (!MIME_RE.test(czysty) || NIEBEZPIECZNE_MIME.has(czysty)) return 'application/octet-stream';
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
      `SELECT a.id, a.filename, a.mime, a.size FROM attachments a
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

function pruneUploads(db) {
  const granica = new Date(Date.now() - UPLOAD_TTL_MS).toISOString();
  const wynik = db.prepare('DELETE FROM uploads WHERE created_at < ?').run(granica);
  if (wynik.changes) gcBlobs(db);
}

// Usuwa treści, do których nic już nie prowadzi.
export function gcBlobs(db) {
  db.exec(
    `DELETE FROM blobs WHERE hash NOT IN (SELECT blob_hash FROM attachments)
     AND hash NOT IN (SELECT blob_hash FROM uploads)`
  );
}
