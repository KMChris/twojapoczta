// HTTP API handlers: validation, auth guard and JSON plumbing.

import {
  hashPassword, verifyPassword, createSession, destroySession, getSessionUser,
  sessionCookie, parseCookies, loginAllowed, recordLoginFailure, clearLoginFailures,
  SESSION_COOKIE,
} from './auth.js';
import {
  DOMAIN, addressOf, addressTaken, listMessages, getMessage, updateMessage, deleteMessage,
  unreadCounts, sendMessage, saveDraft, deliverSystemMessage, setForwarding, getForwarding,
} from './mail.js';
import { listFolders, createFolder, renameFolder, deleteFolder } from './folders.js';
import { normalizujKryteria } from './kryteria.js';
import { listRules, createRule, updateRule, deleteRule, moveRule, applyRuleToExisting } from './reguly.js';
import { WELCOME_SUBJECT, WELCOME_BODY } from './seed.js';
import {
  saveUpload, listAttachments, getAttachment, getAttachmentByCid, MAX_FILE_BYTES,
} from './attachments.js';
import { now } from './db.js';
import { registrationOpen, passwordMinLength } from './settings.js';
import { aliasLimit, aliasCount, aliasesWord } from './aliases.js';
import { userTeams } from './teams.js';
import { logEvent } from './audit.js';

export const LOGIN_RE = /^[a-z0-9][a-z0-9.-]{2,29}$/;
const BODY_LIMIT = 512 * 1024;
// Wiadomości z HTML mieszczą obrazki wklejone jako data:URL, stąd wyższy limit.
const MESSAGE_LIMIT = 8 * 1024 * 1024;

export function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readRaw(req, limit, limitMessage) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let przekroczono = false;
    let chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (przekroczono) {
        // Dojadamy resztę, żeby klient dostał czyste 413, ale bez przesady.
        if (size > limit + 32 * 1024 * 1024) req.destroy();
        return;
      }
      if (size > limit) {
        przekroczono = true;
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (przekroczono) {
        reject(Object.assign(new Error(limitMessage), { status: 413 }));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', reject);
  });
}

export async function readBody(req, limit = BODY_LIMIT, limitMessage = 'Wiadomość jest zbyt duża (limit 512 KB).') {
  const raw = await readRaw(req, limit, limitMessage);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Nieprawidłowy format danych.'), { status: 400 });
  }
}

function publicUser(user) {
  return {
    login: user.login,
    name: user.name,
    address: addressOf(user.login),
    signature: user.signature,
    theme: user.theme,
    is_admin: !!user.is_admin,
  };
}

export function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '?';
}

export function registerApiRoutes(router, db) {
  const open = new Set();

  function route(method, path, handler, { auth = true } = {}) {
    if (!auth) open.add(`${method} ${path}`);
    router[method.toLowerCase()](path, handler);
  }

  // --- Auth ----------------------------------------------------------------

  route('GET', '/api/config', async (req, res) => {
    json(res, 200, { domain: DOMAIN, registration: registrationOpen(db) });
  }, { auth: false });

  route('POST', '/api/register', async (req, res) => {
    if (!registrationOpen(db)) {
      return json(res, 403, { error: 'Rejestracja nowych kont jest wyłączona na tym serwerze.' });
    }
    const body = await readBody(req);
    const login = String(body.login ?? '').trim().toLowerCase();
    const name = String(body.name ?? '').trim();
    const password = String(body.password ?? '');

    if (!LOGIN_RE.test(login)) {
      return json(res, 400, {
        error: 'Login może mieć 3–30 znaków: małe litery, cyfry, kropki i myślniki, zaczynając od litery lub cyfry.',
      });
    }
    if (!name || name.length > 60) return json(res, 400, { error: 'Podaj imię i nazwisko (do 60 znaków).' });
    const minHasla = passwordMinLength(db);
    if (password.length < minHasla) {
      return json(res, 400, { error: `Hasło musi mieć co najmniej ${minHasla} znaków.` });
    }

    // addressTaken łapie kolizję z cudzym loginem, aliasem, zespołem i adresem systemowym.
    if (addressTaken(db, login)) return json(res, 409, { error: `Adres ${addressOf(login)} jest już zajęty.` });

    const hash = await hashPassword(password);
    const result = db
      .prepare('INSERT INTO users (login, name, password_hash, signature, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(login, name, hash, '', 'system', now());
    const userId = Number(result.lastInsertRowid);

    deliverSystemMessage(db, userId, { subject: WELCOME_SUBJECT, body: WELCOME_BODY, priority: true });
    logEvent(db, { actor: login, action: 'user.register', ip: clientIp(req) });

    const session = createSession(db, userId);
    res.setHeader('Set-Cookie', sessionCookie(session, req));
    json(res, 201, { user: publicUser({ login, name, signature: '', theme: 'system' }) });
  }, { auth: false });

  route('POST', '/api/login', async (req, res) => {
    const body = await readBody(req);
    const login = String(body.login ?? '').trim().toLowerCase().replace(`@${DOMAIN}`, '');
    const password = String(body.password ?? '');
    const ip = clientIp(req);

    if (!loginAllowed(ip, login)) {
      return json(res, 429, { error: 'Zbyt wiele prób. Spróbuj ponownie za kwadrans.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE login = ?').get(login);
    const valid = user && (await verifyPassword(user.password_hash, password));
    if (!valid) {
      recordLoginFailure(ip, login);
      logEvent(db, { actor: login, action: 'login.failed', ip });
      return json(res, 401, { error: 'Nieprawidłowy login lub hasło.' });
    }
    // Dopiero po poprawnym haśle: 403 przy złym haśle zdradzałoby istnienie konta.
    if (user.is_blocked) {
      logEvent(db, { actor: login, action: 'login.failed', details: 'konto zablokowane', ip });
      return json(res, 403, { error: 'Konto jest zablokowane. Skontaktuj się z administratorem.' });
    }

    clearLoginFailures(ip, login);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), user.id);
    logEvent(db, { actor: login, action: 'login', ip });
    const session = createSession(db, user.id);
    res.setHeader('Set-Cookie', sessionCookie(session, req));
    json(res, 200, { user: publicUser(user) });
  }, { auth: false });

  route('POST', '/api/logout', async (req, res) => {
    const sessionId = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sessionId) destroySession(db, sessionId);
    res.setHeader('Set-Cookie', sessionCookie('', req, { clear: true }));
    json(res, 200, { ok: true });
  }, { auth: false });

  route('GET', '/api/me', async (req, res, { user }) => {
    json(res, 200, { user: publicUser(user) });
  });

  route('PATCH', '/api/me', async (req, res, { user }) => {
    const body = await readBody(req);
    const sets = [];
    const params = [];
    if (typeof body.name === 'string' && body.name.trim() && body.name.length <= 60) {
      sets.push('name = ?');
      params.push(body.name.trim());
    }
    if (typeof body.signature === 'string' && body.signature.length <= 500) {
      sets.push('signature = ?');
      params.push(body.signature);
    }
    if (['light', 'dark', 'system'].includes(body.theme)) {
      sets.push('theme = ?');
      params.push(body.theme);
    }
    if (sets.length) {
      params.push(user.id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
    const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    json(res, 200, { user: publicUser(fresh) });
  });

  // --- Messages --------------------------------------------------------------

  // Parametry filtrów przełączają trasę w tryb kryteriów. folder i folderId
  // dołączają do kryteriów tylko w ich towarzystwie — same oznaczają zwykłą
  // nawigację i zachowują dzisiejsze znaczenie.
  const POLA_FILTRA = ['from', 'to', 'subject', 'has', 'hasNot', 'dateFrom', 'dateTo', 'hasAttachment'];

  route('GET', '/api/messages', async (req, res, { user, url }) => {
    const folder = url.searchParams.get('folder') ?? 'inbox';
    // Number('') to 0, a Number('abc') to NaN, oba padają na || null.
    const folderId = Number(url.searchParams.get('folderId')) || null;
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);

    const surowe = {};
    for (const pole of POLA_FILTRA) {
      const wartosc = url.searchParams.get(pole);
      if (wartosc) surowe[pole] = wartosc;
    }
    if (Object.keys(surowe).length) {
      if (url.searchParams.get('folder')) surowe.folder = url.searchParams.get('folder');
      if (url.searchParams.get('folderId')) surowe.folderId = url.searchParams.get('folderId');
      const wynik = normalizujKryteria(surowe);
      if (wynik.error) return json(res, 400, { error: wynik.error });
      return json(res, 200, {
        messages: listMessages(db, user.id, { q, kryteria: wynik.kryteria }),
        counts: unreadCounts(db, user.id),
      });
    }

    json(res, 200, {
      messages: listMessages(db, user.id, { folder, folderId, q }),
      counts: unreadCounts(db, user.id),
    });
  });

  route('GET', '/api/messages/:id', async (req, res, { user, params }) => {
    const msg = getMessage(db, user.id, Number(params.id));
    if (!msg) return json(res, 404, { error: 'Nie znaleziono wiadomości.' });
    if (!msg.is_read) {
      updateMessage(db, user.id, msg.id, { is_read: true });
      msg.is_read = 1;
    }
    const attachments = msg.attachments_count ? listAttachments(db, user.id, msg.id) : [];
    // Serwer nie zgaduje już, co jest osadzone: oddaje WSZYSTKIE załączniki pod listem i mapuje
    // KAŻDY Content-ID. Który spinacz schować, rozstrzyga KLIENT — tylko on parsuje treść (DOM)
    // i wie, który obrazek naprawdę wstawił. Fałszywy negatyw kosztuje wtedy złamany obrazek OBOK
    // widocznego spinacza, a nie zgubiony plik (nie ma go ani w treści, ani pod listem). Przy
    // zderzeniu Content-ID trasa `cid:` serwuje w treść tylko pierwszy wiersz, więc klient chowa
    // też tylko ten jeden spinacz — duplikaty zostają pod listem i żadna kopia nie ginie.
    // Mapa bez prototypu, bo klucz daje nadawca · na zwykłym `{}` `Content-ID: <__proto__>`
    // poszedłby w setter prototypu i wpis by zniknął, więc mapa nie oddałaby obrazka.
    // Lista jedzie w całości, bez przesiewania · mapujemy tylko Content-ID.
    const cid = Object.create(null);
    for (const z of attachments) {
      // Klucz jest jeden, więc przy zderzeniu Content-ID bierze go pierwszy · drugi i tak jest
      // osiągalny pod listem zwykłą trasą załącznika.
      if (z.content_id && !Object.hasOwn(cid, z.content_id)) {
        cid[z.content_id] = `/api/messages/${msg.id}/cid/${encodeURIComponent(z.content_id)}`;
      }
    }
    json(res, 200, { message: msg, attachments, cid });
  });

  route('GET', '/api/messages/:id/cid/:contentId', async (req, res, { user, params }) => {
    const obrazek = getAttachmentByCid(db, user.id, Number(params.id), params.contentId);
    if (!obrazek) return json(res, 404, { error: 'Nie znaleziono obrazka.' });
    res.writeHead(200, {
      'Content-Type': obrazek.mime,
      'Content-Length': obrazek.size,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(obrazek.data);
  });

  // --- Załączniki -------------------------------------------------------------

  route('POST', '/api/uploads', async (req, res, { user }) => {
    const buffer = await readRaw(req, MAX_FILE_BYTES, 'Załącznik może mieć najwyżej 5 MB.');
    let filename = 'plik';
    try {
      filename = decodeURIComponent(req.headers['x-filename'] ?? 'plik');
    } catch {
      /* zostaje domyślna nazwa */
    }
    const wynik = saveUpload(db, user.id, {
      filename,
      mime: req.headers['content-type'],
      buffer,
    });
    if (wynik.error) return json(res, 400, { error: wynik.error });
    json(res, 201, wynik);
  });

  route('GET', '/api/messages/:id/attachments/:aid', async (req, res, { user, params }) => {
    const zalacznik = getAttachment(db, user.id, Number(params.id), Number(params.aid));
    if (!zalacznik) return json(res, 404, { error: 'Nie znaleziono załącznika.' });
    // Fallback w cudzysłowie musi być ASCII; pełna nazwa (z ogonkami) idzie w filename*.
    const bezpiecznaNazwa = zalacznik.filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
    res.writeHead(200, {
      'Content-Type': zalacznik.mime,
      'Content-Length': zalacznik.size,
      'Content-Disposition': `attachment; filename="${bezpiecznaNazwa}"; filename*=UTF-8''${encodeURIComponent(zalacznik.filename)}`,
      'Cache-Control': 'private, max-age=3600',
    });
    res.end(zalacznik.data);
  });

  route('POST', '/api/messages', async (req, res, { user }) => {
    const body = await readBody(req, MESSAGE_LIMIT, 'Wiadomość jest zbyt duża (limit 8 MB).');
    for (const pole of ['to', 'cc', 'bcc', 'from', 'subject', 'body', 'bodyHtml', 'scheduledAt']) {
      if (body[pole] != null && typeof body[pole] !== 'string') {
        return json(res, 400, { error: 'Nieprawidłowy format danych.' });
      }
    }
    if ((body.subject ?? '').length > 200) return json(res, 400, { error: 'Temat może mieć najwyżej 200 znaków.' });

    if (body.draft) {
      const draft = saveDraft(db, user, body);
      if (!draft) return json(res, 404, { error: 'Nie znaleziono wersji roboczej.' });
      return json(res, 200, { message: draft, draft: true });
    }

    const result = sendMessage(db, user, body);
    if (result.error) return json(res, 400, { error: result.error });
    json(res, 201, { message: result.message, scheduled: !!result.scheduled });
  });

  route('PATCH', '/api/messages/:id', async (req, res, { user, params }) => {
    const body = await readBody(req);
    const msg = updateMessage(db, user.id, Number(params.id), body);
    if (!msg) return json(res, 404, { error: 'Nie znaleziono wiadomości.' });
    json(res, 200, { message: msg });
  });

  route('DELETE', '/api/messages/:id', async (req, res, { user, params }) => {
    const result = deleteMessage(db, user.id, Number(params.id));
    if (!result.deleted) return json(res, 404, { error: 'Nie znaleziono wiadomości.' });
    json(res, 200, result);
  });

  // --- Operacje zbiorcze ------------------------------------------------------

  // Zaznaczenie na liście ma najwyżej tyle pozycji, ile odda listMessages
  // (limit 100); 200 zostawia zapas, a ucina wsady sklejane poza aplikacją.
  const MAX_BATCH = 200;

  function batchIds(body) {
    const { ids } = body;
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_BATCH) return null;
    if (!ids.every((id) => typeof id === 'number' && Number.isInteger(id))) return null;
    return ids;
  }

  // Wsad przechodzi przez updateMessage/deleteMessage sztuka po sztuce: cudze
  // i nieistniejące id po prostu się nie liczą, więc odpowiedź niesie liczby,
  // nie listę błędów. Transakcja jak przy deleteFolder — połowiczny wsad po
  // padzie w środku byłby gorszy niż powtórka całości.
  route('PATCH', '/api/messages', async (req, res, { user }) => {
    const body = await readBody(req);
    const ids = batchIds(body);
    const maZmiane = ['is_read', 'is_starred', 'folder', 'folder_id'].some((pole) => pole in body);
    if (!ids || !maZmiane) return json(res, 400, { error: 'Nieprawidłowy format danych.' });
    let updated = 0;
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        if (updateMessage(db, user.id, id, body)) updated += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    json(res, 200, { updated });
  });

  route('DELETE', '/api/messages', async (req, res, { user }) => {
    const body = await readBody(req);
    const ids = batchIds(body);
    if (!ids) return json(res, 400, { error: 'Nieprawidłowy format danych.' });
    let deleted = 0;
    let purged = 0;
    db.exec('BEGIN');
    try {
      for (const id of ids) {
        const wynik = deleteMessage(db, user.id, id);
        if (wynik.deleted) deleted += 1;
        if (wynik.purged) purged += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    json(res, 200, { deleted, purged });
  });

  route('GET', '/api/counts', async (req, res, { user }) => {
    json(res, 200, { counts: unreadCounts(db, user.id) });
  });

  // --- Foldery ------------------------------------------------------------------

  route('GET', '/api/folders', async (req, res, { user }) => {
    json(res, 200, { folders: listFolders(db, user.id) });
  });

  route('POST', '/api/folders', async (req, res, { user }) => {
    const body = await readBody(req);
    if (body.name != null && typeof body.name !== 'string') {
      return json(res, 400, { error: 'Nieprawidłowy format danych.' });
    }
    const wynik = createFolder(db, user.id, body.name);
    if (wynik.error) return json(res, 400, { error: wynik.error });
    json(res, 201, { folders: listFolders(db, user.id), folder: wynik.folder });
  });

  route('PATCH', '/api/folders/:id', async (req, res, { user, params }) => {
    const body = await readBody(req);
    if (body.name != null && typeof body.name !== 'string') {
      return json(res, 400, { error: 'Nieprawidłowy format danych.' });
    }
    const wynik = renameFolder(db, user.id, Number(params.id), body.name);
    if (wynik.error) return json(res, wynik.notFound ? 404 : 400, { error: wynik.error });
    json(res, 200, { folders: listFolders(db, user.id), folder: wynik.folder });
  });

  route('DELETE', '/api/folders/:id', async (req, res, { user, params }) => {
    const wynik = deleteFolder(db, user.id, Number(params.id));
    if (wynik.error) return json(res, 404, { error: wynik.error });
    json(res, 200, {
      folders: listFolders(db, user.id),
      moved: wynik.moved,
      name: wynik.name,
      rulesDisabled: wynik.rulesDisabled,
    });
  });

  // --- Reguły ------------------------------------------------------------------

  route('GET', '/api/rules', async (req, res, { user }) => {
    json(res, 200, { rules: listRules(db, user.id) });
  });

  route('POST', '/api/rules', async (req, res, { user }) => {
    const body = await readBody(req);
    const wynik = createRule(db, user, { name: body.name, criteria: body.criteria, actions: body.actions });
    if (wynik.error) return json(res, 400, { error: wynik.error });
    let applied;
    if (body.applyExisting) {
      const wsad = applyRuleToExisting(db, user, wynik.rule.id);
      applied = wsad.applied ?? 0;
    }
    json(res, 201, { rules: listRules(db, user.id), rule: wynik.rule, applied });
  });

  route('PATCH', '/api/rules/:id', async (req, res, { user, params }) => {
    const body = await readBody(req);
    if (body.move === 'up' || body.move === 'down') {
      const wynik = moveRule(db, user.id, Number(params.id), body.move);
      if (wynik.error) return json(res, wynik.notFound ? 404 : 400, { error: wynik.error });
      return json(res, 200, { rules: wynik.rules });
    }
    const wynik = updateRule(db, user, Number(params.id), body);
    if (wynik.error) return json(res, wynik.notFound ? 404 : 400, { error: wynik.error });
    json(res, 200, { rules: listRules(db, user.id) });
  });

  route('DELETE', '/api/rules/:id', async (req, res, { user, params }) => {
    const wynik = deleteRule(db, user.id, Number(params.id));
    if (wynik.error) return json(res, 404, { error: wynik.error });
    json(res, 200, { rules: listRules(db, user.id) });
  });

  route('POST', '/api/rules/:id/apply', async (req, res, { user, params }) => {
    const wynik = applyRuleToExisting(db, user, Number(params.id));
    if (wynik.error) return json(res, wynik.notFound ? 404 : 400, { error: wynik.error });
    json(res, 200, { applied: wynik.applied });
  });

  // --- Aliasy ------------------------------------------------------------------

  const listAliases = (userId) =>
    db
      .prepare('SELECT id, alias FROM aliases WHERE user_id = ? ORDER BY id')
      .all(userId)
      .map((a) => ({ ...a, address: addressOf(a.alias) }));

  // Limit jedzie razem z listą: interfejs nie zna go z góry, bo ustawia go administrator.
  const aliasesView = (userId) => ({ aliases: listAliases(userId), limit: aliasLimit(db, userId) });

  route('GET', '/api/aliases', async (req, res, { user }) => {
    json(res, 200, aliasesView(user.id));
  });

  route('POST', '/api/aliases', async (req, res, { user }) => {
    const body = await readBody(req);
    const alias = String(body.alias ?? '').trim().toLowerCase();
    if (!LOGIN_RE.test(alias)) {
      return json(res, 400, {
        error: 'Alias może mieć 3–30 znaków: małe litery, cyfry, kropki i myślniki.',
      });
    }
    const limit = aliasLimit(db, user.id);
    if (limit === 0) return json(res, 400, { error: 'Administrator wyłączył aliasy na tym koncie.' });
    if (limit !== null && aliasCount(db, user.id) >= limit) {
      return json(res, 400, { error: `Możesz mieć najwyżej ${limit} ${aliasesWord(limit)}.` });
    }
    if (addressTaken(db, alias)) {
      return json(res, 409, { error: `Adres ${addressOf(alias)} jest już zajęty.` });
    }
    db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(user.id, alias, now());
    json(res, 201, aliasesView(user.id));
  });

  // --- Zespoły -------------------------------------------------------------------

  // Tylko do odczytu. Skład zespołu prowadzi administrator, więc POST i DELETE tu
  // nie istnieją: brak trasy jest lepszym strażnikiem niż ukryty przycisk.
  route('GET', '/api/teams', async (req, res, { user }) => {
    json(res, 200, {
      teams: userTeams(db, user.id).map((t) => ({ ...t, address: addressOf(t.local_part) })),
    });
  });

  // --- Przesyłanie dalej ---------------------------------------------------------

  route('GET', '/api/forwarding', async (req, res, { user }) => {
    json(res, 200, { forwarding: getForwarding(db, user.id) });
  });

  route('PUT', '/api/forwarding', async (req, res, { user }) => {
    const body = await readBody(req);
    if (body.to != null && typeof body.to !== 'string') {
      return json(res, 400, { error: 'Nieprawidłowy format danych.' });
    }
    const wynik = setForwarding(db, user, { to: body.to, keepCopy: body.keepCopy !== false });
    if (wynik.error) return json(res, 400, { error: wynik.error });
    json(res, 200, wynik);
  });

  route('DELETE', '/api/aliases/:id', async (req, res, { user, params }) => {
    const result = db
      .prepare('DELETE FROM aliases WHERE id = ? AND user_id = ?')
      .run(Number(params.id), user.id);
    if (!result.changes) return json(res, 404, { error: 'Nie znaleziono aliasu.' });
    json(res, 200, aliasesView(user.id));
  });

  return {
    isOpen(method, path) {
      return open.has(`${method} ${path}`);
    },
  };
}

export function requireUser(db, req, res) {
  const user = getSessionUser(db, req);
  if (!user) {
    json(res, 401, { error: 'Zaloguj się, aby kontynuować.' });
    return null;
  }
  return user;
}
