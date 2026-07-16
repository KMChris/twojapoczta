// Mail domain logic: folders, internal delivery, search, message lifecycle.

import { now } from './db.js';
import { claimUploads, bindUploads, gcBlobs, storeAttachment } from './attachments.js';
import { buildRawMessage, deliverExternal } from './smtp-out.js';
import { signMessage } from './dkim.js';

export const DOMAIN = process.env.TP_DOMAIN || 'twojapoczta.com';
export const REAL_FOLDERS = ['inbox', 'sent', 'drafts', 'scheduled', 'archive', 'spam', 'trash'];
export const SYSTEM_SENDER = { login: 'zespol', name: 'Zespół TwojaPoczta' };
// Ile naraz można zaplanować do przodu; wentyl na literówki w dacie.
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 3600_000;

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
  // Zaplanowane sortujemy po terminie nadania: najbliższe na górze.
  const porzadek = folder === 'scheduled' ? 'scheduled_at ASC, id ASC' : 'sent_at DESC, id DESC';
  return db
    .prepare(
      `SELECT id, folder, from_name, from_addr, to_addr, cc_addr, subject, snippet,
              is_read, is_starred, is_priority, attachments_count, sent_at, scheduled_at
       FROM messages WHERE ${where.join(' AND ')}
       ORDER BY ${porzadek} LIMIT ?`
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
    // Do „Zaplanowanych" wiadomości trafiają tylko przez wysyłkę z terminem.
    if (!REAL_FOLDERS.includes(patch.folder) || patch.folder === 'scheduled') return null;
    sets.push('folder = ?', 'scheduled_at = NULL');
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
  db.prepare("UPDATE messages SET folder = 'trash', scheduled_at = NULL WHERE owner_id = ? AND id = ?").run(userId, id);
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
  const pelne = db
    .prepare(
      `SELECT folder, COUNT(*) AS n FROM messages
       WHERE owner_id = ? AND folder IN ('drafts', 'scheduled') GROUP BY folder`
    )
    .all(userId);
  const counts = { inbox: 0, spam: 0, drafts: 0, scheduled: 0 };
  for (const row of pelne) counts[row.folder] = row.n;
  for (const row of rows) counts[row.folder] = row.n;
  return counts;
}

// Zajętość skrzynki w bajtach: treści wiadomości + rozmiary załączników.
export function storageUsage(db, userId) {
  const tresci = db
    .prepare('SELECT COALESCE(SUM(LENGTH(CAST(body AS BLOB))), 0) AS b FROM messages WHERE owner_id = ?')
    .get(userId);
  const zalaczniki = db
    .prepare(
      `SELECT COALESCE(SUM(a.size), 0) AS b FROM attachments a
       JOIN messages m ON m.id = a.message_id WHERE m.owner_id = ?`
    )
    .get(userId);
  return tresci.b + zalaczniki.b;
}

function insertMessage(db, ownerId, msg) {
  const result = db
    .prepare(
      `INSERT INTO messages
         (owner_id, folder, from_name, from_addr, to_addr, cc_addr, bcc_addr, subject,
          body, body_html, snippet, is_read, is_starred, is_priority, sent_at, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      ownerId,
      msg.folder,
      msg.from_name ?? '',
      msg.from_addr,
      msg.to_addr ?? '',
      msg.cc_addr ?? '',
      msg.bcc_addr ?? '',
      msg.subject ?? '',
      msg.body ?? '',
      msg.body_html ?? '',
      makeSnippet(msg.body ?? ''),
      msg.is_read ? 1 : 0,
      msg.is_starred ? 1 : 0,
      msg.is_priority ? 1 : 0,
      msg.sent_at ?? now(),
      msg.scheduled_at ?? null
    );
  return Number(result.lastInsertRowid);
}

// Adres nadawcy: własny login albo jeden z własnych aliasów; inaczej null.
export function resolveSenderAddress(db, user, from) {
  const wybrany = String(from ?? '').trim().toLowerCase();
  if (!wybrany || wybrany === addressOf(user.login)) return addressOf(user.login);
  const at = wybrany.lastIndexOf('@');
  if (at < 1 || wybrany.slice(at + 1) !== DOMAIN) return null;
  const alias = db
    .prepare('SELECT 1 FROM aliases WHERE user_id = ? AND alias = ?')
    .get(user.id, wybrany.slice(0, at));
  return alias ? wybrany : null;
}

export function saveDraft(db, user, { id, to, cc, bcc, from, subject, body, bodyHtml }) {
  const data = {
    folder: 'drafts',
    from_name: user.name,
    // W wersji roboczej niepoprawny nadawca po cichu wraca na adres główny.
    from_addr: resolveSenderAddress(db, user, from) ?? addressOf(user.login),
    to_addr: parseRecipients(to).join(', '),
    cc_addr: parseRecipients(cc).join(', '),
    bcc_addr: parseRecipients(bcc).join(', '),
    subject: subject ?? '',
    body: body ?? '',
    body_html: bodyHtml ?? '',
    is_read: 1,
    sent_at: now(),
  };
  if (id) {
    const existing = getMessage(db, user.id, id);
    if (!existing || existing.folder !== 'drafts') return null;
    db.prepare(
      `UPDATE messages SET from_addr = ?, to_addr = ?, cc_addr = ?, bcc_addr = ?,
         subject = ?, body = ?, body_html = ?, snippet = ?, sent_at = ?
       WHERE owner_id = ? AND id = ?`
    ).run(
      data.from_addr, data.to_addr, data.cc_addr, data.bcc_addr,
      data.subject, data.body, data.body_html, makeSnippet(data.body), data.sent_at,
      user.id, id
    );
    return getMessage(db, user.id, id);
  }
  const newId = insertMessage(db, user.id, data);
  return getMessage(db, user.id, newId);
}

// Rozkłada adresy na lokalne skrzynki i adresatów zewnętrznych (albo zwraca błąd).
function resolveRecipients(db, addresses) {
  const resolved = [];
  const zewnetrzni = [];
  for (const addr of addresses) {
    const at = addr.lastIndexOf('@');
    const local = addr.slice(0, at);
    const domena = addr.slice(at + 1);
    if (at < 1 || !domena) return { error: `Adres „${addr}" wygląda na niepoprawny.` };

    if (domena === DOMAIN) {
      const recipient = findMailbox(db, local);
      if (!recipient) return { error: `Nie znaleziono skrzynki „${addr}".` };
      if (!resolved.some((r) => r.id === recipient.id)) resolved.push(recipient);
      continue;
    }

    // Poza naszą domenę tylko z włączoną bramką wychodzącą.
    if (process.env.TP_EXTERNAL !== '1') {
      return { error: `Ta instalacja doręcza pocztę tylko w domenie @${DOMAIN}. Adres „${addr}" jest poza nią.` };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      return { error: `Adres „${addr}" wygląda na niepoprawny.` };
    }
    if (!zewnetrzni.includes(addr)) zewnetrzni.push(addr);
  }
  return { resolved, zewnetrzni };
}

// Kopie u adresatów: „sent" u nadawcy, „inbox" u każdego odbiorcy (UDW bez śladu w kopiach).
function deliverCopies(db, ownerId, base, resolved, { bccAddr = '' } = {}) {
  const copyIds = [insertMessage(db, ownerId, { ...base, folder: 'sent', is_read: 1, bcc_addr: bccAddr })];
  for (const recipient of resolved) {
    if (recipient.id === ownerId) continue; // wysyłka do siebie: kopia w Odebranych niżej
    copyIds.push(insertMessage(db, recipient.id, { ...base, folder: 'inbox', is_read: 0 }));
  }
  if (resolved.some((r) => r.id === ownerId)) {
    copyIds.push(insertMessage(db, ownerId, { ...base, folder: 'inbox', is_read: 0 }));
  }
  return copyIds;
}

// Internal delivery: a copy lands in the sender's "sent" and each recipient's "inbox".
export function sendMessage(db, user, { to, cc, bcc, from, subject, body, bodyHtml, draftId, priority, uploads, scheduledAt }) {
  const doKogo = parseRecipients(to);
  const dw = parseRecipients(cc);
  const udw = parseRecipients(bcc);
  const wszyscy = [...new Set([...doKogo, ...dw, ...udw])];
  if (!wszyscy.length) return { error: 'Podaj co najmniej jednego adresata.' };

  const fromAddr = resolveSenderAddress(db, user, from);
  if (!fromAddr) return { error: 'Możesz nadawać tylko ze swojego adresu albo własnych aliasów.' };

  const adresaci = resolveRecipients(db, wszyscy);
  if (adresaci.error) return { error: adresaci.error };

  const claimed = claimUploads(db, user.id, uploads);
  if (claimed.error) return { error: claimed.error };

  const base = {
    from_name: user.name,
    from_addr: fromAddr,
    to_addr: doKogo.join(', '),
    cc_addr: dw.join(', '),
    subject: subject?.trim() || '(bez tematu)',
    body: body ?? '',
    body_html: bodyHtml ?? '',
    is_priority: priority ? 1 : 0,
    sent_at: now(),
  };

  // Wysyłka z terminem: list czeka w „Zaplanowanych", nada go strażnik (fireScheduled).
  if (scheduledAt) {
    const kiedy = new Date(scheduledAt);
    if (Number.isNaN(kiedy.getTime())) return { error: 'Nieprawidłowa data wysyłki.' };
    if (kiedy.getTime() <= Date.now()) return { error: 'Termin wysyłki musi być w przyszłości.' };
    if (kiedy.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
      return { error: 'Wysyłkę można zaplanować najwyżej rok naprzód.' };
    }
    db.exec('BEGIN');
    try {
      const id = insertMessage(db, user.id, {
        ...base,
        folder: 'scheduled',
        bcc_addr: udw.join(', '),
        is_read: 1,
        scheduled_at: kiedy.toISOString(),
      });
      bindUploads(db, claimed.uploads, [id]);
      if (draftId) {
        db.prepare("DELETE FROM messages WHERE owner_id = ? AND id = ? AND folder = 'drafts'").run(user.id, draftId);
      }
      db.exec('COMMIT');
      return { message: getMessage(db, user.id, id), scheduled: true };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  db.exec('BEGIN');
  try {
    const copyIds = deliverCopies(db, user.id, base, adresaci.resolved, { bccAddr: udw.join(', ') });
    bindUploads(db, claimed.uploads, copyIds);
    if (draftId) {
      db.prepare("DELETE FROM messages WHERE owner_id = ? AND id = ? AND folder = 'drafts'").run(user.id, draftId);
    }
    db.exec('COMMIT');

    if (adresaci.zewnetrzni.length) {
      const zalaczniki = claimed.uploads
        .map((u) => ({
          filename: u.filename,
          mime: u.mime,
          data: db.prepare('SELECT data FROM blobs WHERE hash = ?').get(u.blob_hash)?.data,
        }))
        .filter((z) => z.data);
      dispatchExternal(db, user.id, {
        from: { name: user.name, addr: fromAddr },
        recipients: adresaci.zewnetrzni,
        to: doKogo,
        cc: dw,
        subject: base.subject,
        body: base.body,
        html: base.body_html,
        zalaczniki,
      });
    }

    return { message: getMessage(db, user.id, copyIds[0]) };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Strażnik zaplanowanych: nadaje wszystko, czego termin właśnie minął. Zwraca liczbę nadanych.
export function fireScheduled(db) {
  const dojrzale = db
    .prepare("SELECT * FROM messages WHERE folder = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?")
    .all(now());
  for (const msg of dojrzale) {
    try {
      wyslijZaplanowana(db, msg);
    } catch (err) {
      console.error('[scheduler] nie udało się nadać wiadomości', msg.id, err);
    }
  }
  return dojrzale.length;
}

function wyslijZaplanowana(db, msg) {
  const wszyscy = [
    ...new Set([...parseRecipients(msg.to_addr), ...parseRecipients(msg.cc_addr), ...parseRecipients(msg.bcc_addr)]),
  ];
  // Adresaci mogli zniknąć między zaplanowaniem a nadaniem; tych pomijamy i zgłaszamy zwrot.
  const resolved = [];
  const zewnetrzni = [];
  const nieosiagalni = [];
  for (const addr of wszyscy) {
    const at = addr.lastIndexOf('@');
    const domena = addr.slice(at + 1);
    if (domena === DOMAIN) {
      const recipient = findMailbox(db, addr.slice(0, at));
      if (recipient && !resolved.some((r) => r.id === recipient.id)) resolved.push(recipient);
      else if (!recipient) nieosiagalni.push({ adres: addr, powod: 'skrzynka nie istnieje' });
    } else if (process.env.TP_EXTERNAL === '1') {
      zewnetrzni.push(addr);
    } else {
      nieosiagalni.push({ adres: addr, powod: 'wysyłka na zewnątrz jest wyłączona' });
    }
  }

  const base = {
    from_name: msg.from_name,
    from_addr: msg.from_addr,
    to_addr: msg.to_addr,
    cc_addr: msg.cc_addr,
    subject: msg.subject,
    body: msg.body,
    body_html: msg.body_html,
    is_priority: msg.is_priority,
    sent_at: now(),
  };

  let sentId;
  db.exec('BEGIN');
  try {
    const copyIds = deliverCopies(db, msg.owner_id, base, resolved, { bccAddr: msg.bcc_addr });
    sentId = copyIds[0];
    // Załączniki wędrują z zaplanowanej na wszystkie kopie (bloby zostają wspólne).
    const zalaczniki = db
      .prepare('SELECT filename, mime, size, blob_hash FROM attachments WHERE message_id = ?')
      .all(msg.id);
    if (zalaczniki.length) {
      const insert = db.prepare(
        'INSERT INTO attachments (message_id, filename, mime, size, blob_hash) VALUES (?, ?, ?, ?, ?)'
      );
      for (const copyId of copyIds) {
        for (const z of zalaczniki) insert.run(copyId, z.filename, z.mime, z.size, z.blob_hash);
        db.prepare('UPDATE messages SET attachments_count = ? WHERE id = ?').run(zalaczniki.length, copyId);
      }
    }
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  if (zewnetrzni.length) {
    const zalaczniki = db
      .prepare(
        `SELECT a.filename, a.mime, b.data FROM attachments a
         JOIN blobs b ON b.hash = a.blob_hash WHERE a.message_id = ?`
      )
      .all(sentId);
    dispatchExternal(db, msg.owner_id, {
      from: { name: msg.from_name, addr: msg.from_addr },
      recipients: zewnetrzni,
      to: parseRecipients(msg.to_addr),
      cc: parseRecipients(msg.cc_addr),
      subject: msg.subject,
      body: msg.body,
      html: msg.body_html,
      zalaczniki,
    });
  }
  if (nieosiagalni.length) deliverBounce(db, msg.owner_id, msg.subject, nieosiagalni);
}

// Wysyłka na zewnątrz dzieje się po odpowiedzi HTTP; porażka wraca jako „Zwrot do nadawcy".
function dispatchExternal(db, ownerId, { from, recipients, to, cc, subject, body, html, zalaczniki }) {
  const raw = signMessage(
    buildRawMessage({
      domain: DOMAIN,
      from,
      to,
      cc,
      subject,
      body,
      html,
      attachments: zalaczniki,
    })
  );
  setImmediate(async () => {
    try {
      const { porazki } = await deliverExternal({
        domain: DOMAIN,
        ehloName: process.env.TP_SMTP_HOSTNAME ?? `mx.${DOMAIN}`,
        mailFrom: from.addr,
        recipients,
        raw,
      });
      if (porazki.length) deliverBounce(db, ownerId, subject, porazki);
    } catch (err) {
      deliverBounce(db, ownerId, subject, recipients.map((adres) => ({ adres, powod: err.message })));
    }
  });
}

function deliverBounce(db, userId, subject, porazki) {
  const lista = porazki.map((p) => `• ${p.adres}: ${p.powod}`).join('\n');
  try {
    deliverSystemMessage(db, userId, {
      subject: `Zwrot do nadawcy: ${subject}`,
      body: `Nie udało się doręczyć wiadomości „${subject}" do:\n\n${lista}\n\nKopia została w folderze Wysłane. Sprawdź adres albo spróbuj ponownie później.\n\nZespół TwojaPoczta`,
      priority: true,
    });
  } catch (err) {
    console.error('[smtp-out] bounce', err);
  }
}

// Delivery of a parsed external message (SMTP gateway) into a local inbox.
export function deliverInbound(db, mailboxUserId, parsed, { toAddr }) {
  db.exec('BEGIN');
  try {
    const id = insertMessage(db, mailboxUserId, {
      folder: 'inbox',
      from_name: parsed.from.name ?? '',
      from_addr: parsed.from.addr,
      to_addr: toAddr ?? '',
      subject: parsed.subject || '(bez tematu)',
      body: parsed.body ?? '',
      is_read: 0,
      sent_at: now(),
    });
    let zapisane = 0;
    for (const zalacznik of parsed.attachments ?? []) {
      if (storeAttachment(db, id, zalacznik)) zapisane += 1;
    }
    if (zapisane) {
      db.prepare('UPDATE messages SET attachments_count = ? WHERE id = ?').run(zapisane, id);
    }
    db.exec('COMMIT');
    return id;
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
