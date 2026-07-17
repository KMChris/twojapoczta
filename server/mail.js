// Mail domain logic: folders, internal delivery, search, message lifecycle.

import { now } from './db.js';
import { claimUploads, bindUploads, gcBlobs, storeAttachment } from './attachments.js';
import { hasRoom } from './quota.js';
import { buildRawMessage, deliverExternal } from './smtp-out.js';
import { signMessage } from './dkim.js';
import { findTeam, teamMailboxes, canSendAs } from './teams.js';

export const DOMAIN = process.env.TP_DOMAIN || 'twojapoczta.com';
// Dozwolone wartości messages.folder. 'custom' to wartownik: mówi „folder własny",
// a folder_id mówi który konkretnie.
export const REAL_FOLDERS = ['inbox', 'sent', 'drafts', 'scheduled', 'archive', 'spam', 'trash', 'custom'];
// Foldery wbudowane: te, po których da się nawigować i które wolno podać wprost.
export const BUILTIN_FOLDERS = REAL_FOLDERS.filter((f) => f !== 'custom');
export const SYSTEM_SENDER = { login: 'zespol', name: 'Zespół TwojaPoczta' };
// Ile naraz można zaplanować do przodu; wentyl na literówki w dacie.
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 3600_000;
// Najdłuższy łańcuch przekierowań (A→B→C); dalej list się zatrzymuje.
export const MAX_FORWARD_HOPS = 3;
// Powyżej tego progu HTML zostaje odrzucony, a list pokaże się jako tekst.
// Render wielomegabajtowego drzewa potrafi zawiesić kartę, a tekst zawsze jest.
export const MAX_BODY_HTML_BYTES = 2 * 1024 * 1024;

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

// Adres w naszej domenie wskazuje albo na konto (login lub alias), albo na zespół.
// To jedyne miejsce, które wie o fan-oucie: dla zespołu zwraca wszystkie skrzynki,
// do których ma pójść kopia. null = takiego adresu u nas nie ma.
// Uwaga: zespół bez członków zwraca pustą listę skrzynek, a nie null. Adres
// istnieje, tylko nikt go nie obsługuje, i wołający musi te dwa przypadki rozróżnić.
export function resolveDelivery(db, localPart) {
  const user = findMailbox(db, localPart);
  if (user) return { kind: 'user', team: null, mailboxes: [user] };
  const team = findTeam(db, localPart);
  if (!team) return null;
  return { kind: 'team', team, mailboxes: teamMailboxes(db, team.id) };
}

// Czy część lokalna jest zajęta? Loginy, aliasy i zespoły dzielą jedną przestrzeń
// nazw, bo wszystkie są adresami w tej samej domenie.
//
// SYSTEM_SENDER.login jest zastrzeżony bez względu na bazę: seed zakłada to konto
// tylko na instalacji demonstracyjnej, a deliverSystemMessage nadaje z tego adresu
// zawsze (wpisuje from_addr tekstem, wiersz w users nie jest mu potrzebny). Bez tej
// linijki przy TP_SEED=0 dowolny użytkownik mógłby zarejestrować ten adres i podszyć
// się pod listy powitalne i zwroty.
export function addressTaken(db, localPart) {
  if (localPart === SYSTEM_SENDER.login) return true;
  return !!findMailbox(db, localPart) || !!findTeam(db, localPart);
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

export function listMessages(db, userId, { folder = 'inbox', folderId = null, q = '', limit = 100 } = {}) {
  const where = ['owner_id = ?'];
  const params = [userId];

  if (folderId) {
    where.push("folder = 'custom' AND folder_id = ?");
    params.push(folderId);
  } else if (folder === 'starred') {
    // Foldery własne zostają: gwiazdka omija tylko kosz i spam.
    where.push("is_starred = 1 AND folder NOT IN ('trash', 'spam')");
  } else if (BUILTIN_FOLDERS.includes(folder)) {
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
  if ('folder_id' in patch) {
    // Folder własny wchodzi wyłącznie tędy, a wartownika ustawiamy sami.
    // Dzięki temu nie da się wpisać folder='custom' bez wskazania folderu
    // i zostawić wiadomości poza każdym widokiem.
    const folderId = Number(patch.folder_id);
    const wlasny = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId);
    if (!wlasny) return null;
    sets.push("folder = 'custom'", 'folder_id = ?', 'scheduled_at = NULL');
    params.push(folderId);
  } else if ('folder' in patch) {
    // Do „Zaplanowanych" wiadomości trafiają tylko przez wysyłkę z terminem.
    // BUILTIN_FOLDERS nie zawiera 'custom', więc wartownik odpada tu sam.
    if (!BUILTIN_FOLDERS.includes(patch.folder) || patch.folder === 'scheduled') return null;
    sets.push('folder = ?', 'folder_id = NULL', 'scheduled_at = NULL');
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
  db.prepare(
    "UPDATE messages SET folder = 'trash', folder_id = NULL, scheduled_at = NULL WHERE owner_id = ? AND id = ?"
  ).run(userId, id);
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
  const wlasne = db
    .prepare(
      `SELECT folder_id, COUNT(*) AS n FROM messages
       WHERE owner_id = ? AND is_read = 0 AND folder = 'custom' AND folder_id IS NOT NULL
       GROUP BY folder_id`
    )
    .all(userId);
  const counts = { inbox: 0, spam: 0, drafts: 0, scheduled: 0, custom: {} };
  for (const row of pelne) counts[row.folder] = row.n;
  for (const row of rows) counts[row.folder] = row.n;
  for (const row of wlasne) counts.custom[row.folder_id] = row.n;
  return counts;
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

// Tożsamość nadawcy: { addr, name } albo null, gdy z tego adresu nadawać nie wolno.
// Adres główny i alias nadają imieniem konta. Skrzynka zespołowa nadaje własną
// nazwą: klient pisze do firmy, nie do osoby, która akurat miała dyżur, i to jest
// cała różnica między zespołem a aliasem.
export function resolveSender(db, user, from) {
  const wybrany = String(from ?? '').trim().toLowerCase();
  if (!wybrany || wybrany === addressOf(user.login)) return { addr: addressOf(user.login), name: user.name };
  const at = wybrany.lastIndexOf('@');
  if (at < 1 || wybrany.slice(at + 1) !== DOMAIN) return null;
  const local = wybrany.slice(0, at);
  const alias = db.prepare('SELECT 1 FROM aliases WHERE user_id = ? AND alias = ?').get(user.id, local);
  if (alias) return { addr: wybrany, name: user.name };
  const zespol = canSendAs(db, user.id, local);
  return zespol ? { addr: wybrany, name: zespol.name } : null;
}

export function saveDraft(db, user, { id, to, cc, bcc, from, subject, body, bodyHtml }) {
  // W wersji roboczej niepoprawny nadawca po cichu wraca na adres główny.
  const nadawca = resolveSender(db, user, from) ?? { addr: addressOf(user.login), name: user.name };
  const data = {
    folder: 'drafts',
    from_name: nadawca.name,
    from_addr: nadawca.addr,
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
    // from_name jedzie z from_addr: odkąd nadawcą bywa zespół, nazwa i adres to jedna
    // tożsamość i rozjechałyby się przy zmianie nadawcy w zapisanym już szkicu.
    db.prepare(
      `UPDATE messages SET from_name = ?, from_addr = ?, to_addr = ?, cc_addr = ?, bcc_addr = ?,
         subject = ?, body = ?, body_html = ?, snippet = ?, sent_at = ?
       WHERE owner_id = ? AND id = ?`
    ).run(
      data.from_name, data.from_addr, data.to_addr, data.cc_addr, data.bcc_addr,
      data.subject, data.body, data.body_html, makeSnippet(data.body), data.sent_at,
      user.id, id
    );
    return getMessage(db, user.id, id);
  }
  const newId = insertMessage(db, user.id, data);
  return getMessage(db, user.id, newId);
}

// Rozkłada adresy na lokalne skrzynki i adresatów zewnętrznych (albo zwraca błąd).
// Zespół rozwija się na członków; każda skrzynka niesie viaTeam, czyli adres zespołu,
// przez który tu trafiła (null = nadawca poprosił o nią wprost). Ta różnica decyduje
// potem, czy pełna skrzynka wywala wysyłkę, czy tylko wypada z rozdzielnika.
//
// Obok tego `teamy` (adres zespołu → id jego skrzynek) trzyma skład każdego
// zaadresowanego zespołu w całości. To osobna sprawa niż viaTeam: viaTeam mówi, kogo
// nadawca poprosił wprost, a `teamy` — kto stoi za adresem zespołu. Rozdzielnik nie
// odpowie na to drugie, bo deduplikacja zostawia każdą skrzynkę raz: członek dwóch
// zespołów pamięta tylko pierwszy z koperty, a adresowany wprost traci viaTeam zupełnie.
function resolveRecipients(db, addresses) {
  const resolved = [];
  const zewnetrzni = [];
  const teamy = new Map();
  for (const addr of addresses) {
    const at = addr.lastIndexOf('@');
    const local = addr.slice(0, at);
    const domena = addr.slice(at + 1);
    if (at < 1 || !domena) return { error: `Adres „${addr}" wygląda na niepoprawny.` };

    if (domena === DOMAIN) {
      const cel = resolveDelivery(db, local);
      if (!cel) return { error: `Nie znaleziono skrzynki „${addr}".` };
      if (cel.kind === 'team' && !cel.mailboxes.length) {
        return { error: `Skrzynka zespołu „${addr}" nie ma jeszcze członków.` };
      }
      const viaTeam = cel.kind === 'team' ? addr : null;
      // Skład zapisujemy tutaj, przed deduplikacją: to jedyne miejsce, w którym widać
      // go w komplecie.
      if (viaTeam) teamy.set(viaTeam, cel.mailboxes.map((s) => s.id));
      for (const skrzynka of cel.mailboxes) {
        const juz = resolved.find((r) => r.id === skrzynka.id);
        // Adresowanie wprost wygrywa nad członkostwem, bez względu na kolejność
        // adresów w kopercie: kto został poproszony z imienia, ten odpowiada za
        // swoją skrzynkę jak zawsze.
        if (juz) {
          if (!viaTeam) juz.viaTeam = null;
          continue;
        }
        resolved.push({ ...skrzynka, viaTeam });
      }
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
  return { resolved, zewnetrzni, teamy };
}

// Kopie u adresatów: „sent" u nadawcy, „inbox" u każdego odbiorcy (UDW bez śladu w kopiach).
// Zwraca [{ id, ownerId, folder }]; właściciele są potrzebni do przesyłania dalej.
function deliverCopies(db, ownerId, base, resolved, { bccAddr = '' } = {}) {
  const kopie = [
    { id: insertMessage(db, ownerId, { ...base, folder: 'sent', is_read: 1, bcc_addr: bccAddr }), ownerId, folder: 'sent' },
  ];
  for (const recipient of resolved) {
    if (recipient.id === ownerId) continue; // wysyłka do siebie: kopia w Odebranych niżej
    kopie.push({
      id: insertMessage(db, recipient.id, { ...base, folder: 'inbox', is_read: 0 }),
      ownerId: recipient.id,
      folder: 'inbox',
    });
  }
  if (resolved.some((r) => r.id === ownerId)) {
    kopie.push({
      id: insertMessage(db, ownerId, { ...base, folder: 'inbox', is_read: 0 }),
      ownerId,
      folder: 'inbox',
    });
  }
  return kopie;
}

// Po zatwierdzeniu doręczenia: przesyła dalej każdą świeżą kopię w Odebranych.
function forwardInboxCopies(db, kopie) {
  for (const kopia of kopie) {
    if (kopia.folder !== 'inbox') continue;
    try {
      forwardDelivered(db, kopia.ownerId, kopia.id);
    } catch (err) {
      console.error('[forward] nie udało się przesłać dalej', kopia.id, err);
    }
  }
}

// Internal delivery: a copy lands in the sender's "sent" and each recipient's "inbox".
export function sendMessage(db, user, { to, cc, bcc, from, subject, body, bodyHtml, draftId, priority, uploads, scheduledAt }) {
  const doKogo = parseRecipients(to);
  const dw = parseRecipients(cc);
  const udw = parseRecipients(bcc);
  const wszyscy = [...new Set([...doKogo, ...dw, ...udw])];
  if (!wszyscy.length) return { error: 'Podaj co najmniej jednego adresata.' };

  const nadawca = resolveSender(db, user, from);
  if (!nadawca) {
    return {
      error: 'Możesz nadawać tylko ze swojego adresu, własnych aliasów albo skrzynki zespołu, w której masz prawo wysyłki.',
    };
  }

  const adresaci = resolveRecipients(db, wszyscy);
  if (adresaci.error) return { error: adresaci.error };

  const claimed = claimUploads(db, user.id, uploads);
  if (claimed.error) return { error: claimed.error };

  // Limit miejsca odbiorców: kopia do Odebranych musi się zmieścić.
  // Adresat wpisany wprost z pełną skrzynką wywala wysyłkę, jak zawsze. Członek
  // zespołu tylko wypada z rozdzielnika: jedna pełna skrzynka nie może odcinać
  // firmowego adresu, a komunikat o niej zdradzałby nadawcy skład zespołu.
  const przybywa =
    Buffer.byteLength(body ?? '', 'utf8') +
    Buffer.byteLength(bodyHtml ?? '', 'utf8') +
    claimed.uploads.reduce((suma, u) => suma + u.size, 0);
  const pomijani = new Set();
  for (const recipient of adresaci.resolved) {
    if (hasRoom(db, recipient.id, przybywa)) continue;
    if (!recipient.viaTeam) {
      return { error: `Skrzynka „${addressOf(recipient.login)}" jest pełna. Wiadomość nie została wysłana.` };
    }
    pomijani.add(recipient.id);
  }
  // Zespół, w którym miejsca nie ma nikt, jest nieosiągalny i nadawca musi to wiedzieć.
  // Liczymy po pełnym składzie (`teamy`), nie po viaTeam ocalałym z rozdzielnika: członek
  // poproszony wprost ma viaTeam wyzerowane, a należący do dwóch zespołów pamięta tylko
  // pierwszy — w obu razach grupa wyszłaby węższa niż zespół naprawdę jest.
  for (const [adresZespolu, czlonkowie] of adresaci.teamy) {
    if (czlonkowie.every((id) => pomijani.has(id))) {
      return { error: `Skrzynka zespołu „${adresZespolu}" jest pełna. Wiadomość nie została wysłana.` };
    }
  }
  const odbiorcy = adresaci.resolved.filter((r) => !pomijani.has(r.id));

  const base = {
    from_name: nadawca.name,
    from_addr: nadawca.addr,
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

  let kopie;
  db.exec('BEGIN');
  try {
    kopie = deliverCopies(db, user.id, base, odbiorcy, { bccAddr: udw.join(', ') });
    bindUploads(db, claimed.uploads, kopie.map((k) => k.id));
    if (draftId) {
      db.prepare("DELETE FROM messages WHERE owner_id = ? AND id = ? AND folder = 'drafts'").run(user.id, draftId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  forwardInboxCopies(db, kopie);

  if (adresaci.zewnetrzni.length) {
    const zalaczniki = claimed.uploads
      .map((u) => ({
        filename: u.filename,
        mime: u.mime,
        data: db.prepare('SELECT data FROM blobs WHERE hash = ?').get(u.blob_hash)?.data,
      }))
      .filter((z) => z.data);
    dispatchExternal(db, user.id, {
      from: { name: nadawca.name, addr: nadawca.addr },
      recipients: adresaci.zewnetrzni,
      to: doKogo,
      cc: dw,
      subject: base.subject,
      body: base.body,
      html: base.body_html,
      zalaczniki,
    });
  }

  return { message: getMessage(db, user.id, kopie[0].id) };
}

// Strażnik zaplanowanych: podejmuje wszystko, czego termin właśnie minął.
// Zwraca liczbę podjętych, nie doręczonych: list odmówiony też się liczy.
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
  // Autoryzacja z chwili nadania, nie z chwili zapisu: między zaplanowaniem
  // a terminem administrator mógł odebrać prawo wysyłki albo wypisać z zespołu.
  const wlasciciel = db.prepare('SELECT id, login, name FROM users WHERE id = ?').get(msg.owner_id);
  const nadawca = wlasciciel ? resolveSender(db, wlasciciel, msg.from_addr) : null;
  if (!nadawca) {
    // Do Wersji roboczych, bo praca autora ma się dać poprawić i wysłać ponownie;
    // wyzerowany scheduled_at wypisuje ją ze SELECT-a strażnika, więc nie próbuje w kółko.
    db.prepare("UPDATE messages SET folder = 'drafts', scheduled_at = NULL WHERE id = ?").run(msg.id);
    // Nie deliverBounce: tamten zwrot mówi o adresatach, do których nie dowieziono, i odsyła
    // po kopię do Wysłanych. Tu nie zawiódł żaden adresat, tylko nadawca stracił prawo, a list
    // czeka w Wersjach roboczych, i to jedyne, czego autor naprawdę potrzebuje się dowiedzieć.
    deliverSystemMessage(db, msg.owner_id, {
      subject: `Nie wysłano: ${msg.subject}`,
      body: `Nie nadaliśmy wiadomości „${msg.subject}", bo nie masz już prawa wysyłki z adresu ${msg.from_addr}.\n\nList czeka w Wersjach roboczych. Zmień nadawcę i wyślij go ponownie.\n\nZespół TwojaPoczta`,
      priority: true,
    });
    return;
  }
  const wszyscy = [
    ...new Set([...parseRecipients(msg.to_addr), ...parseRecipients(msg.cc_addr), ...parseRecipients(msg.bcc_addr)]),
  ];
  // Adresaci mogli zniknąć albo zapełnić skrzynkę między zaplanowaniem
  // a nadaniem; tych pomijamy i zgłaszamy zwrot.
  const zalacznikiBajty = db
    .prepare('SELECT COALESCE(SUM(size), 0) AS b FROM attachments WHERE message_id = ?')
    .get(msg.id).b;
  const przybywa =
    Buffer.byteLength(msg.body ?? '', 'utf8') +
    Buffer.byteLength(msg.body_html ?? '', 'utf8') +
    zalacznikiBajty;
  const resolved = [];
  const zewnetrzni = [];
  const nieosiagalni = [];
  for (const addr of wszyscy) {
    const at = addr.lastIndexOf('@');
    const domena = addr.slice(at + 1);
    if (domena === DOMAIN) {
      // Ta sama polityka co w resolveRecipients, ale ubrana w „nieosiagalni":
      // nadawcy nie ma już przy klawiaturze, więc odmowa wraca pocztą, nie błędem.
      const cel = resolveDelivery(db, addr.slice(0, at));
      if (!cel) {
        nieosiagalni.push({ adres: addr, powod: 'skrzynka nie istnieje' });
        continue;
      }
      if (cel.kind === 'team' && !cel.mailboxes.length) {
        nieosiagalni.push({ adres: addr, powod: 'skrzynka zespołu nie ma członków' });
        continue;
      }
      const zMiejscem = cel.mailboxes.filter((s) => hasRoom(db, s.id, przybywa));
      if (!zMiejscem.length) {
        nieosiagalni.push({
          adres: addr,
          powod: cel.kind === 'team' ? 'skrzynka zespołu jest pełna' : 'skrzynka odbiorcy jest pełna',
        });
        continue;
      }
      for (const skrzynka of zMiejscem) {
        if (!resolved.some((r) => r.id === skrzynka.id)) resolved.push(skrzynka);
      }
    } else if (process.env.TP_EXTERNAL === '1') {
      zewnetrzni.push(addr);
    } else {
      nieosiagalni.push({ adres: addr, powod: 'wysyłka na zewnątrz jest wyłączona' });
    }
  }

  const base = {
    from_name: nadawca.name,
    from_addr: msg.from_addr,
    to_addr: msg.to_addr,
    cc_addr: msg.cc_addr,
    subject: msg.subject,
    body: msg.body,
    body_html: msg.body_html,
    is_priority: msg.is_priority,
    sent_at: now(),
  };

  let kopie;
  let sentId;
  db.exec('BEGIN');
  try {
    kopie = deliverCopies(db, msg.owner_id, base, resolved, { bccAddr: msg.bcc_addr });
    sentId = kopie[0].id;
    // Załączniki wędrują z zaplanowanej na wszystkie kopie (bloby zostają wspólne).
    for (const kopia of kopie) kopiujZalaczniki(db, msg.id, kopia.id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  forwardInboxCopies(db, kopie);

  if (zewnetrzni.length) {
    const zalaczniki = db
      .prepare(
        `SELECT a.filename, a.mime, b.data FROM attachments a
         JOIN blobs b ON b.hash = a.blob_hash WHERE a.message_id = ?`
      )
      .all(sentId);
    dispatchExternal(db, msg.owner_id, {
      from: { name: nadawca.name, addr: msg.from_addr },
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

// --- Przesyłanie dalej (automatyczne przekierowanie skrzynki) --------------------

// Ustawia albo kasuje przekierowanie skrzynki. Pusty adres = wyłączone.
export function setForwarding(db, user, { to, keepCopy = true }) {
  const cel = String(to ?? '').trim().toLowerCase();
  if (!cel) {
    db.prepare("UPDATE users SET forward_to = '', forward_keep = 1 WHERE id = ?").run(user.id);
    return { forwarding: { to: '', keepCopy: true } };
  }

  const at = cel.lastIndexOf('@');
  if (at < 1 || !cel.slice(at + 1)) return { error: `Adres „${cel}" wygląda na niepoprawny.` };
  const domena = cel.slice(at + 1);

  if (domena === DOMAIN) {
    const odbiorca = findMailbox(db, cel.slice(0, at));
    if (!odbiorca) {
      // Zespół w łańcuchu przekierowań mnoży rozgałęzienia, a przesyłanie na własny
      // zespół robi pętlę na sobie. Odmawiamy, ale mówimy dlaczego: ten adres istnieje.
      if (findTeam(db, cel.slice(0, at))) return { error: 'Nie można przesyłać poczty na adres zespołu.' };
      return { error: `Nie znaleziono skrzynki „${cel}".` };
    }
    // Przekierowanie na własny adres albo alias zapętliłoby skrzynkę na siebie.
    if (odbiorca.id === user.id) return { error: 'Nie da się przesyłać poczty na własny adres.' };
  } else {
    if (process.env.TP_EXTERNAL !== '1') {
      return { error: `Ta instalacja doręcza pocztę tylko w domenie @${DOMAIN}. Adres „${cel}" jest poza nią.` };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cel)) return { error: `Adres „${cel}" wygląda na niepoprawny.` };
  }

  db.prepare('UPDATE users SET forward_to = ?, forward_keep = ? WHERE id = ?').run(cel, keepCopy ? 1 : 0, user.id);
  return { forwarding: { to: cel, keepCopy: !!keepCopy } };
}

export function getForwarding(db, userId) {
  const u = db.prepare('SELECT forward_to, forward_keep FROM users WHERE id = ?').get(userId);
  return { to: u?.forward_to ?? '', keepCopy: u?.forward_keep !== 0 };
}

function kopiujZalaczniki(db, zId, doId) {
  const zalaczniki = db
    .prepare('SELECT filename, mime, size, blob_hash, content_id FROM attachments WHERE message_id = ?')
    .all(zId);
  if (!zalaczniki.length) return;
  // content_id jedzie z kopią, bo `body_html` kopiujemy dosłownie: bez kotwicy odwołanie
  // `cid:` w treści nie miałoby do czego trafić i osadzony obrazek by nie wstał.
  const insert = db.prepare(
    'INSERT INTO attachments (message_id, filename, mime, size, blob_hash, content_id) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const z of zalaczniki) insert.run(doId, z.filename, z.mime, z.size, z.blob_hash, z.content_id);
  db.prepare('UPDATE messages SET attachments_count = ? WHERE id = ?').run(zalaczniki.length, doId);
}

// Przesyła świeżo doręczoną wiadomość dalej, jeśli właściciel skrzynki tak ustawił.
// Wołać PO zatwierdzeniu transakcji doręczenia. Zwraca adres celu albo null.
//
// Pętle: łańcuch A→B→A ucina zbiór odwiedzonych skrzynek, a długość ogranicza MAX_FORWARD_HOPS.
// Wiadomości systemowe (powitanie, zwroty) nie idą dalej, żeby zwrot z przekierowania
// nie wracał w kółko.
export function forwardDelivered(db, ownerId, messageId, { hops = 0, odwiedzeni = new Set() } = {}) {
  if (hops >= MAX_FORWARD_HOPS || odwiedzeni.has(ownerId)) return null;

  const wlasciciel = db
    .prepare('SELECT id, login, name, forward_to, forward_keep FROM users WHERE id = ?')
    .get(ownerId);
  if (!wlasciciel?.forward_to) return null;

  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND owner_id = ?').get(messageId, ownerId);
  if (!msg || msg.folder !== 'inbox') return null;

  odwiedzeni.add(ownerId);
  const cel = wlasciciel.forward_to;
  const at = cel.lastIndexOf('@');
  const domena = cel.slice(at + 1);

  const odlozOryginal = () => {
    // Bez „zostaw kopię" oryginał idzie do Archiwum; nie kasujemy poczty za plecami.
    if (!wlasciciel.forward_keep) {
      db.prepare(
        "UPDATE messages SET folder = 'archive', folder_id = NULL WHERE id = ? AND owner_id = ?"
      ).run(messageId, ownerId);
    }
  };

  if (domena === DOMAIN) {
    const odbiorca = findMailbox(db, cel.slice(0, at));
    if (!odbiorca) return null; // skrzynka celu zniknęła, przekierowanie milczy
    // Pełna skrzynka celu: pomijamy przekierowanie, oryginał zostaje na miejscu.
    const przybywa =
      Buffer.byteLength(msg.body ?? '', 'utf8') +
      Buffer.byteLength(msg.body_html ?? '', 'utf8') +
      db.prepare('SELECT COALESCE(SUM(size), 0) AS b FROM attachments WHERE message_id = ?').get(msg.id).b;
    if (!hasRoom(db, odbiorca.id, przybywa)) return null;
    let nowyId;
    db.exec('BEGIN');
    try {
      // Kopia zachowuje oryginalnego nadawcę: wewnątrz domeny nie ma czego wyrównywać.
      nowyId = insertMessage(db, odbiorca.id, {
        folder: 'inbox',
        from_name: msg.from_name,
        from_addr: msg.from_addr,
        to_addr: cel,
        cc_addr: msg.cc_addr,
        subject: msg.subject,
        body: msg.body,
        body_html: msg.body_html,
        is_read: 0,
        is_priority: msg.is_priority,
        sent_at: msg.sent_at,
      });
      kopiujZalaczniki(db, msg.id, nowyId);
      odlozOryginal();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    // Cel też może mieć przekierowanie, więc łańcuch idzie dalej, aż do limitu.
    forwardDelivered(db, odbiorca.id, nowyId, { hops: hops + 1, odwiedzeni });
    return cel;
  }

  if (process.env.TP_EXTERNAL !== '1') return null;

  // Alias na camelCase, bo `buildRawMessage` czyta `contentId`: samo `content_id` z bazy
  // dałoby ciche `undefined`, nagłówek by nie powstał i `cid:` w HTML-u zostałby bez kotwicy.
  const zalaczniki = db
    .prepare(
      `SELECT a.filename, a.mime, a.content_id AS contentId, b.data FROM attachments a
       JOIN blobs b ON b.hash = a.blob_hash WHERE a.message_id = ?`
    )
    .all(msg.id);
  // Na zewnątrz nadajemy z własnego adresu, żeby SPF i DKIM się zgadzały; oryginalny
  // nadawca zostaje w nazwie i w Reply-To, więc odpowiedź trafia tam, gdzie trzeba.
  dispatchExternal(db, ownerId, {
    from: { name: msg.from_name || msg.from_addr, addr: addressOf(wlasciciel.login) },
    replyTo: msg.from_addr,
    recipients: [cel],
    to: [cel],
    cc: [],
    subject: msg.subject,
    body: msg.body,
    html: msg.body_html,
    zalaczniki,
  });
  odlozOryginal();
  return cel;
}

// Wysyłka na zewnątrz dzieje się po odpowiedzi HTTP; porażka wraca jako „Zwrot do nadawcy".
function dispatchExternal(db, ownerId, { from, replyTo, recipients, to, cc, subject, body, html, zalaczniki }) {
  const raw = signMessage(
    buildRawMessage({
      domain: DOMAIN,
      from,
      replyTo,
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
  let id;
  db.exec('BEGIN');
  try {
    const surowyHtml = parsed.html ?? '';
    const bodyHtml = Buffer.byteLength(surowyHtml, 'utf8') > MAX_BODY_HTML_BYTES ? '' : surowyHtml;

    id = insertMessage(db, mailboxUserId, {
      folder: 'inbox',
      from_name: parsed.from.name ?? '',
      from_addr: parsed.from.addr,
      to_addr: toAddr ?? '',
      subject: parsed.subject || '(bez tematu)',
      body: parsed.body ?? '',
      body_html: bodyHtml,
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
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  try {
    forwardDelivered(db, mailboxUserId, id);
  } catch (err) {
    console.error('[forward] nie udało się przesłać dalej', id, err);
  }
  return id;
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
