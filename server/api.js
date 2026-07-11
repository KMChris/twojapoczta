// HTTP API handlers: validation, auth guard and JSON plumbing.

import {
  hashPassword, verifyPassword, createSession, destroySession, getSessionUser,
  sessionCookie, parseCookies, loginAllowed, recordLoginFailure, clearLoginFailures,
  SESSION_COOKIE,
} from './auth.js';
import {
  DOMAIN, addressOf, findMailbox, listMessages, getMessage, updateMessage, deleteMessage,
  unreadCounts, sendMessage, saveDraft, deliverSystemMessage,
} from './mail.js';
import { WELCOME_SUBJECT, WELCOME_BODY } from './seed.js';
import { now } from './db.js';

const LOGIN_RE = /^[a-z0-9][a-z0-9.-]{2,29}$/;
const BODY_LIMIT = 512 * 1024;

export function json(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('Wiadomość jest zbyt duża (limit 512 KB).'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Nieprawidłowy format danych.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function publicUser(user) {
  return {
    login: user.login,
    name: user.name,
    address: addressOf(user.login),
    signature: user.signature,
    theme: user.theme,
  };
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '?';
}

export function registerApiRoutes(router, db) {
  const open = new Set();

  function route(method, path, handler, { auth = true } = {}) {
    if (!auth) open.add(`${method} ${path}`);
    router[method.toLowerCase()](path, handler);
  }

  // --- Auth ----------------------------------------------------------------

  route('POST', '/api/register', async (req, res) => {
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
    if (password.length < 8) return json(res, 400, { error: 'Hasło musi mieć co najmniej 8 znaków.' });

    const taken = db.prepare('SELECT id FROM users WHERE login = ?').get(login);
    if (taken) return json(res, 409, { error: `Adres ${addressOf(login)} jest już zajęty.` });

    const hash = await hashPassword(password);
    const result = db
      .prepare('INSERT INTO users (login, name, password_hash, signature, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(login, name, hash, '', 'system', now());
    const userId = Number(result.lastInsertRowid);

    deliverSystemMessage(db, userId, { subject: WELCOME_SUBJECT, body: WELCOME_BODY, priority: true });

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
      return json(res, 401, { error: 'Nieprawidłowy login lub hasło.' });
    }

    clearLoginFailures(ip, login);
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

  route('GET', '/api/messages', async (req, res, { user, url }) => {
    const folder = url.searchParams.get('folder') ?? 'inbox';
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
    json(res, 200, {
      messages: listMessages(db, user.id, { folder, q }),
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
    json(res, 200, { message: msg });
  });

  route('POST', '/api/messages', async (req, res, { user }) => {
    const body = await readBody(req);
    if ((body.subject ?? '').length > 200) return json(res, 400, { error: 'Temat może mieć najwyżej 200 znaków.' });

    if (body.draft) {
      const draft = saveDraft(db, user, body);
      if (!draft) return json(res, 404, { error: 'Nie znaleziono szkicu.' });
      return json(res, 200, { message: draft, draft: true });
    }

    const result = sendMessage(db, user, body);
    if (result.error) return json(res, 400, { error: result.error });
    json(res, 201, { message: result.message });
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

  route('GET', '/api/counts', async (req, res, { user }) => {
    json(res, 200, { counts: unreadCounts(db, user.id) });
  });

  // --- Aliasy ------------------------------------------------------------------

  const listAliases = (userId) =>
    db
      .prepare('SELECT id, alias FROM aliases WHERE user_id = ? ORDER BY id')
      .all(userId)
      .map((a) => ({ ...a, address: addressOf(a.alias) }));

  route('GET', '/api/aliases', async (req, res, { user }) => {
    json(res, 200, { aliases: listAliases(user.id) });
  });

  route('POST', '/api/aliases', async (req, res, { user }) => {
    const body = await readBody(req);
    const alias = String(body.alias ?? '').trim().toLowerCase();
    if (!LOGIN_RE.test(alias)) {
      return json(res, 400, {
        error: 'Alias może mieć 3–30 znaków: małe litery, cyfry, kropki i myślniki.',
      });
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM aliases WHERE user_id = ?').get(user.id);
    if (count.n >= 5) return json(res, 400, { error: 'Możesz mieć najwyżej 5 aliasów.' });
    if (findMailbox(db, alias)) {
      return json(res, 409, { error: `Adres ${addressOf(alias)} jest już zajęty.` });
    }
    db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(user.id, alias, now());
    json(res, 201, { aliases: listAliases(user.id) });
  });

  route('DELETE', '/api/aliases/:id', async (req, res, { user, params }) => {
    const result = db
      .prepare('DELETE FROM aliases WHERE id = ? AND user_id = ?')
      .run(Number(params.id), user.id);
    if (!result.changes) return json(res, 404, { error: 'Nie znaleziono aliasu.' });
    json(res, 200, { aliases: listAliases(user.id) });
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
