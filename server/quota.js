// Limity miejsca: zużycie skrzynki i decyzja, czy przyjąć kolejne bajty.
// Moduł bez zależności, importują go mail.js, attachments.js i smtp.js.

// Zajętość skrzynki w bajtach: treści wiadomości + rozmiary załączników.
export function storageUsage(db, userId) {
  const tresci = db
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB)) + LENGTH(CAST(body_html AS BLOB))), 0) AS b
       FROM messages WHERE owner_id = ?`
    )
    .get(userId);
  const zalaczniki = db
    .prepare(
      `SELECT COALESCE(SUM(a.size), 0) AS b FROM attachments a
       JOIN messages m ON m.id = a.message_id WHERE m.owner_id = ?`
    )
    .get(userId);
  return tresci.b + zalaczniki.b;
}

// Czy skrzynka przyjmie jeszcze extraBytes? Brak limitu (NULL) = zawsze tak.
export function hasRoom(db, userId, extraBytes = 0) {
  const konto = db.prepare('SELECT quota_mb FROM users WHERE id = ?').get(userId);
  if (!konto || konto.quota_mb == null) return true;
  return storageUsage(db, userId) + extraBytes <= konto.quota_mb * 1024 * 1024;
}
