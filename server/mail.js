// Mail domain logic: folders, internal delivery, search, message lifecycle.

import { now } from './db.js';
import { claimUploads, bindUploads, gcBlobs } from './attachments.js';

export const DOMAIN = process.env.TP_DOMAIN || 'twojapoczta.com';
export const REAL_FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'spam', 'trash'];
export const SYSTEM_SENDER = { login: 'zespol', name: 'Zespół TwojaPoczta' };

export function addressOf(login) {
  return `${login}@${DOMAIN}`;
}

// A local part resolves to a mailbox directly or through an alias.
export function findMailbox(db, localPart) {
  const user = db.prepare('SELECT id, login, name FROM users WHERE login = ?').get(localPart);
  if (user) return user;
  return (
    db
      .prepare(
        `SELECT u.id, u.login, u.name FROM aliases a
         JOIN users u ON u.id = a.user_id WHERE a.alias = ?`
      )
      .get(localPart) ?? null
  );
}

export function makeSnippet(body) {
  return body.replace(/\s+/g, ' ').trim().slice(0, 140);
}

// Comma/semicolon separated list -> array of trimmed, lowercased addresses.
export function parseRecipients(raw) {
  return String(raw ?? '')
    .split(/[,;]/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
}

export function listMessages(db, userId, { folder = 'inbox', q = '', limit = 100 } = {}) {
  const where = ['owner_id = ?'];
  const params = [userId];

  if (folder === 'starred') {
    where.push("is_starred = 1 AND folder NOT IN ('trash', 'spam')");
  } else if (REAL_FOLDERS.includes(folder)) {
    where.push('folder = ?');
    params.push(folder);
  } else {
    return [];
  }

  if (q) {
    where.push('(subject LIKE ? ESCAPE \'\\\' OR body LIKE ? ESCAPE \'\\\' OR from_name LIKE ? ESCAPE \'\\\' OR from_addr LIKE ? ESCAPE \'\\\' OR to_addr LIKE ? ESCAPE \'\\\')');
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like, like, like);
  }

  params.push(limit);
  return db
    .prepare(
      `SELECT id, folder, from_name, from_addr, to_addr, subject, snippet,
              is_read, is_starred, is_priority, attachments_count, sent_at
       FROM messages WHERE ${where.join(' AND ')}
       ORDER BY sent_at DESC, id DESC LIMIT ?`
    )
    .all(...params);
}

export function getMessage(db, userId, id) {
  return db.prepare('SELECT * FROM messages WHERE owner_id = ? AND id = ?').get(userId, id);
}

export function updateMessage(db, userId, id, patch) {
  const sets = [];
  const params = [];
  if ('is_read' in patch) {
    sets.push('is_read = ?');
    params.push(patch.is_read ? 1 : 0);
  }
  if ('is_starred' in patch) {
    sets.push('is_starred = ?');
    params.push(patch.is_starred ? 1 : 0);
  }
  if ('folder' in patch) {
    if (!REAL_FOLDERS.includes(patch.folder)) return null;
    sets.push('folder = ?');
    params.push(patch.folder);
  }
  if (!sets.length) return getMessage(db, userId, id);
  params.push(userId, id);
  db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE owner_id = ? AND id = ?`).run(...params);
  return getMessage(db, userId, id);
}

// Trash is a two-step delete: first move to trash, delete permanently from there.
export function deleteMessage(db, userId, id) {
  const msg = getMessage(db, userId, id);
  if (!msg) return { deleted: false };
  if (msg.folder === 'trash') {
    db.prepare('DELETE FROM messages WHERE owner_id = ? AND id = ?').run(userId, id);
    if (msg.attachments_count) gcBlobs(db);
    return { deleted: true, purged: true };
  }
  db.prepare("UPDATE messages SET folder = 'trash' WHERE owner_id = ? AND id = ?").run(userId, id);
  return { deleted: true, purged: false };
}

export function unreadCounts(db, userId) {
  const rows = db
    .prepare(
      `SELECT folder, COUNT(*) AS n FROM messages
       WHERE owner_id = ? AND is_read = 0 AND folder IN ('inbox', 'spam')
       GROUP BY folder`
    )
    .all(userId);
  const drafts = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE owner_id = ? AND folder = 'drafts'")
    .get(userId);
  const counts = { inbox: 0, spam: 0, drafts: drafts?.n ?? 0 };
  for (const row of rows) counts[row.folder] = row.n;
  return counts;
}

function insertMessage(db, ownerId, msg) {
  const result = db
    .prepare(
      `INSERT INTO messages
         (owner_id, folder, from_name, from_addr, to_addr, subject, body, snippet,
          is_read, is_starred, is_priority, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId,
      msg.folder,
      msg.from_name ?? '',
      msg.from_addr,
      msg.to_addr ?? '',
      msg.subject ?? '',
      msg.body ?? '',
      makeSnippet(msg.body ?? ''),
      msg.is_read ? 1 : 0,
      msg.is_starred ? 1 : 0,
      msg.is_priority ? 1 : 0,
      msg.sent_at ?? now()
    );
  return Number(result.lastInsertRowid);
}

export function saveDraft(db, user, { id, to, subject, body }) {
  const data = {
    folder: 'drafts',
    from_name: user.name,
    from_addr: addressOf(user.login),
    to_addr: parseRecipients(to).join(', '),
    subject: subject ?? '',
    body: body ?? '',
    is_read: 1,
    sent_at: now(),
  };
  if (id) {
    const existing = getMessage(db, user.id, id);
    if (!existing || existing.folder !== 'drafts') return null;
    db.prepare(
      `UPDATE messages SET to_addr = ?, subject = ?, body = ?, snippet = ?, sent_at = ?
       WHERE owner_id = ? AND id = ?`
    ).run(data.to_addr, data.subject, data.body, makeSnippet(data.body), data.sent_at, user.id, id);
    return getMessage(db, user.id, id);
  }
  const newId = insertMessage(db, user.id, data);
  return getMessage(db, user.id, newId);
}

// Internal delivery: a copy lands in the sender's "sent" and each recipient's "inbox".
export function sendMessage(db, user, { to, subject, body, draftId, priority, uploads }) {
  const recipients = parseRecipients(to);
  if (!recipients.length) return { error: 'Podaj co najmniej jednego adresata.' };

  const resolved = [];
  for (const addr of recipients) {
    const match = addr.match(/^([a-z0-9][a-z0-9.-]{0,63})@(.+)$/);
    if (!match) return { error: `Adres „${addr}" wygląda na niepoprawny.` };
    if (match[2] !== DOMAIN) {
      return { error: `Ta instalacja doręcza pocztę tylko w domenie @${DOMAIN}. Adres „${addr}" jest poza nią.` };
    }
    const recipient = findMailbox(db, match[1]);
    if (!recipient) return { error: `Nie znaleziono skrzynki „${addr}".` };
    if (!resolved.some((r) => r.id === recipient.id)) resolved.push(recipient);
  }

  const claimed = claimUploads(db, user.id, uploads);
  if (claimed.error) return { error: claimed.error };

  const sentAt = now();
  const base = {
    from_name: user.name,
    from_addr: addressOf(user.login),
    to_addr: recipients.join(', '),
    subject: subject?.trim() || '(bez tematu)',
    body: body ?? '',
    is_priority: priority ? 1 : 0,
    sent_at: sentAt,
  };

  db.exec('BEGIN');
  try {
    const copyIds = [insertMessage(db, user.id, { ...base, folder: 'sent', is_read: 1 })];
    for (const recipient of resolved) {
      if (recipient.id === user.id) continue; // sent-to-self: inbox copy below
      copyIds.push(insertMessage(db, recipient.id, { ...base, folder: 'inbox', is_read: 0 }));
    }
    if (resolved.some((r) => r.id === user.id)) {
      copyIds.push(insertMessage(db, user.id, { ...base, folder: 'inbox', is_read: 0 }));
    }
    bindUploads(db, claimed.uploads, copyIds);
    if (draftId) {
      db.prepare("DELETE FROM messages WHERE owner_id = ? AND id = ? AND folder = 'drafts'").run(user.id, draftId);
    }
    db.exec('COMMIT');
    return { message: getMessage(db, user.id, copyIds[0]) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Messages from the product itself (welcome mail, notifications).
export function deliverSystemMessage(db, toUserId, { subject, body, priority = false, sentAt }) {
  insertMessage(db, toUserId, {
    folder: 'inbox',
    from_name: SYSTEM_SENDER.name,
    from_addr: addressOf(SYSTEM_SENDER.login),
    to_addr: '',
    subject,
    body,
    is_read: 0,
    is_priority: priority ? 1 : 0,
    sent_at: sentAt ?? now(),
  });
}
