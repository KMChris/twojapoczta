// Trasy /api/admin/*: zarządzanie instancją. Każda wymaga roli administratora,
// każda mutacja zostawia wpis w dzienniku zdarzeń.

import path from 'node:path';
import { statSync } from 'node:fs';
import { json, readBody, clientIp, LOGIN_RE } from './api.js';
import { hashPassword } from './auth.js';
import {
  listUsers, getUserView, createUser, deleteUser, revokeSessions, adminCount,
  userAliases, instanceStats,
} from './admin.js';
import { DOMAIN, addressOf, findMailbox, deliverSystemMessage, SYSTEM_SENDER } from './mail.js';
import { WELCOME_SUBJECT, WELCOME_BODY } from './seed.js';
import { registrationOpen, passwordMinLength, catchallLogin, setSetting } from './settings.js';
import { aliasLimit, aliasCount, aliasesWord, MAX_ALIAS_LIMIT } from './aliases.js';
import { logEvent, listEvents } from './audit.js';
import { dkimConfigured, initDkim, dnsRecord } from './dkim.js';
import { tlsStatus } from './tls-cert.js';
import { checkDns } from './dns-check.js';
import { now } from './db.js';

const MAX_QUOTA_MB = 1_048_576; // 1 TB: wentyl na literówki, nie limit produktu
const SELECTOR_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function registerAdminRoutes(router, db, { dataDir = null, resolver } = {}) {
  function route(method, pattern, handler) {
    router[method.toLowerCase()](pattern, async (req, res, ctx) => {
      if (!ctx.user?.is_admin) {
        return json(res, 403, { error: 'Ta operacja wymaga uprawnień administratora.' });
      }
      await handler(req, res, ctx);
    });
  }

  const audyt = (req, user, action, target = '', details = '') =>
    logEvent(db, { actor: user.login, action, target, details, ip: clientIp(req) });

  const znajdzKonto = (params) =>
    db.prepare('SELECT id, login, is_admin, is_blocked FROM users WHERE id = ?').get(Number(params.id));

  // --- Użytkownicy -----------------------------------------------------------

  route('GET', '/api/admin/users', async (req, res) => {
    json(res, 200, { users: listUsers(db) });
  });

  route('POST', '/api/admin/users', async (req, res, { user }) => {
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
    if (findMailbox(db, login)) {
      return json(res, 409, { error: `Adres ${addressOf(login)} jest już zajęty.` });
    }

    const passwordHash = await hashPassword(password);
    const id = createUser(db, { login, name, passwordHash });
    deliverSystemMessage(db, id, { subject: WELCOME_SUBJECT, body: WELCOME_BODY, priority: true });
    audyt(req, user, 'user.create', login);
    json(res, 201, { user: getUserView(db, id) });
  });

  route('PATCH', '/api/admin/users/:id', async (req, res, { user, params }) => {
    const konto = znajdzKonto(params);
    if (!konto) return json(res, 404, { error: 'Nie znaleziono konta.' });
    const body = await readBody(req);

    const sets = [];
    const values = [];
    const zdarzenia = [];

    if ('name' in body) {
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 60) return json(res, 400, { error: 'Imię i nazwisko: 1–60 znaków.' });
      sets.push('name = ?');
      values.push(name);
      zdarzenia.push(['user.update', `imię: ${name}`]);
    }

    if ('is_admin' in body) {
      const nadaj = !!body.is_admin;
      if (!nadaj && konto.is_admin && adminCount(db) <= 1) {
        return json(res, 400, { error: 'Nie można odebrać roli ostatniemu administratorowi.' });
      }
      sets.push('is_admin = ?');
      values.push(nadaj ? 1 : 0);
      zdarzenia.push(['user.admin', nadaj ? 'nadano rolę administratora' : 'odebrano rolę administratora']);
    }

    if ('is_blocked' in body) {
      const zablokuj = !!body.is_blocked;
      if (zablokuj && konto.id === user.id) {
        return json(res, 400, { error: 'Nie można zablokować własnego konta.' });
      }
      if (zablokuj && konto.is_admin && adminCount(db) <= 1) {
        return json(res, 400, { error: 'Nie można zablokować ostatniego administratora.' });
      }
      sets.push('is_blocked = ?');
      values.push(zablokuj ? 1 : 0);
      zdarzenia.push([zablokuj ? 'user.block' : 'user.unblock', '']);
    }

    if ('quota_mb' in body) {
      const limit = body.quota_mb;
      if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > MAX_QUOTA_MB)) {
        return json(res, 400, { error: 'Limit miejsca: pełne MB (co najmniej 1) albo brak limitu.' });
      }
      sets.push('quota_mb = ?');
      values.push(limit);
      zdarzenia.push(['user.quota', limit === null ? 'zniesiono limit' : `limit ${limit} MB`]);
    }

    if ('alias_limit' in body) {
      const limit = body.alias_limit;
      if (limit !== null && (!Number.isInteger(limit) || limit < 0 || limit > MAX_ALIAS_LIMIT)) {
        return json(res, 400, { error: `Limit aliasów: liczba 0–${MAX_ALIAS_LIMIT} albo brak limitu.` });
      }
      // Obniżenie limitu nie kasuje aliasów, które konto już ma; po prostu nie doda kolejnych.
      sets.push('alias_limit = ?');
      values.push(limit);
      zdarzenia.push([
        'user.alias_limit',
        limit === null ? 'zniesiono limit aliasów' : `limit ${limit} ${aliasesWord(limit)}`,
      ]);
    }

    if (sets.length) {
      values.push(konto.id);
      db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      // Blokada działa od razu: żywe sesje konta gasną.
      if (body.is_blocked) revokeSessions(db, konto.id);
      for (const [akcja, szczegoly] of zdarzenia) audyt(req, user, akcja, konto.login, szczegoly);
    }
    json(res, 200, { user: getUserView(db, konto.id) });
  });

  route('DELETE', '/api/admin/users/:id', async (req, res, { user, params }) => {
    const konto = znajdzKonto(params);
    if (!konto) return json(res, 404, { error: 'Nie znaleziono konta.' });
    if (konto.id === user.id) return json(res, 400, { error: 'Nie można usunąć własnego konta.' });
    if (konto.is_admin && adminCount(db) <= 1) {
      return json(res, 400, { error: 'Nie można usunąć ostatniego administratora.' });
    }
    deleteUser(db, konto.id);
    audyt(req, user, 'user.delete', konto.login);
    json(res, 200, { ok: true });
  });

  route('POST', '/api/admin/users/:id/password', async (req, res, { user, params }) => {
    const konto = znajdzKonto(params);
    if (!konto) return json(res, 404, { error: 'Nie znaleziono konta.' });
    const body = await readBody(req);
    const password = String(body.password ?? '');
    const minHasla = passwordMinLength(db);
    if (password.length < minHasla) {
      return json(res, 400, { error: `Hasło musi mieć co najmniej ${minHasla} znaków.` });
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), konto.id);
    // Nowe hasło unieważnia stare sesje, chyba że admin zmienia własne (zostałby wylogowany).
    if (konto.id !== user.id) revokeSessions(db, konto.id);
    audyt(req, user, 'user.password', konto.login);
    json(res, 200, { ok: true });
  });

  route('POST', '/api/admin/users/:id/logout', async (req, res, { user, params }) => {
    const konto = znajdzKonto(params);
    if (!konto) return json(res, 404, { error: 'Nie znaleziono konta.' });
    revokeSessions(db, konto.id);
    audyt(req, user, 'user.logout', konto.login);
    json(res, 200, { ok: true });
  });

  // --- Aliasy dowolnego konta ---------------------------------------------------

  route('POST', '/api/admin/users/:id/aliases', async (req, res, { user, params }) => {
    const konto = znajdzKonto(params);
    if (!konto) return json(res, 404, { error: 'Nie znaleziono konta.' });
    const body = await readBody(req);
    const alias = String(body.alias ?? '').trim().toLowerCase();
    if (!LOGIN_RE.test(alias)) {
      return json(res, 400, { error: 'Alias może mieć 3–30 znaków: małe litery, cyfry, kropki i myślniki.' });
    }
    const limit = aliasLimit(db, konto.id);
    if (limit !== null && aliasCount(db, konto.id) >= limit) {
      return json(res, 400, {
        error: `To konto osiągnęło limit aliasów (${limit}). Podnieś limit, żeby dodać kolejny.`,
      });
    }
    if (findMailbox(db, alias)) {
      return json(res, 409, { error: `Adres ${addressOf(alias)} jest już zajęty.` });
    }
    db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(konto.id, alias, now());
    audyt(req, user, 'alias.create', konto.login, alias);
    json(res, 201, { aliases: userAliases(db, konto.id) });
  });

  route('DELETE', '/api/admin/users/:id/aliases/:aliasId', async (req, res, { user, params }) => {
    const konto = znajdzKonto(params);
    if (!konto) return json(res, 404, { error: 'Nie znaleziono konta.' });
    const usuniety = db
      .prepare('SELECT alias FROM aliases WHERE id = ? AND user_id = ?')
      .get(Number(params.aliasId), konto.id);
    if (!usuniety) return json(res, 404, { error: 'Nie znaleziono aliasu.' });
    db.prepare('DELETE FROM aliases WHERE id = ? AND user_id = ?').run(Number(params.aliasId), konto.id);
    audyt(req, user, 'alias.delete', konto.login, usuniety.alias);
    json(res, 200, { aliases: userAliases(db, konto.id) });
  });

  // --- Ustawienia instancji --------------------------------------------------------

  const settingsView = () => ({
    registration: registrationOpen(db),
    password_min: passwordMinLength(db),
    catchall: catchallLogin(db),
  });

  const envView = () => ({
    domain: DOMAIN,
    data_dir: dataDir,
    external: process.env.TP_EXTERNAL === '1',
    smtp_port: process.env.TP_SMTP_PORT ? Number(process.env.TP_SMTP_PORT) : null,
    smtp_hostname: process.env.TP_SMTP_HOSTNAME ?? `mx.${DOMAIN}`,
    smtp_route: process.env.TP_SMTP_ROUTE ?? null,
    tls_verify: process.env.TP_TLS_VERIFY === '1',
    seed: process.env.TP_SEED !== '0',
  });

  route('GET', '/api/admin/settings', async (req, res) => {
    json(res, 200, { settings: settingsView(), env: envView() });
  });

  route('PATCH', '/api/admin/settings', async (req, res, { user }) => {
    const body = await readBody(req);
    const operacje = [];
    const zmiany = [];

    if ('registration' in body) {
      const v = body.registration;
      operacje.push(() => setSetting(db, 'registration', v === null ? null : v ? '1' : '0'));
      zmiany.push(`rejestracja: ${v === null ? 'wg środowiska' : v ? 'otwarta' : 'zamknięta'}`);
    }
    if ('password_min' in body) {
      const v = body.password_min;
      if (v !== null && (!Number.isInteger(v) || v < 4 || v > 128)) {
        return json(res, 400, { error: 'Minimalna długość hasła: liczba 4–128.' });
      }
      operacje.push(() => setSetting(db, 'password_min', v === null ? null : String(v)));
      zmiany.push(`min. długość hasła: ${v ?? 'domyślna'}`);
    }
    if ('catchall' in body) {
      const v = body.catchall;
      if (v === null || v === '') {
        operacje.push(() => setSetting(db, 'catchall', null));
        zmiany.push('catch-all: wyłączony');
      } else {
        const skrzynka = findMailbox(db, String(v).trim().toLowerCase());
        if (!skrzynka) {
          return json(res, 400, { error: 'Catch-all musi wskazywać istniejącą skrzynkę (login albo alias).' });
        }
        operacje.push(() => setSetting(db, 'catchall', skrzynka.login));
        zmiany.push(`catch-all: ${skrzynka.login}`);
      }
    }

    // Walidacja w całości przed zapisem: żadnych częściowych zmian przy błędzie.
    for (const zastosuj of operacje) zastosuj();
    if (zmiany.length) audyt(req, user, 'settings.update', '', zmiany.join('; '));
    json(res, 200, { settings: settingsView() });
  });

  // --- Komunikat do wszystkich -------------------------------------------------------

  route('POST', '/api/admin/broadcast', async (req, res, { user }) => {
    const body = await readBody(req);
    const subject = String(body.subject ?? '').trim();
    const tresc = String(body.body ?? '');
    if (!subject || subject.length > 200) return json(res, 400, { error: 'Temat komunikatu: 1–200 znaków.' });
    if (!tresc.trim()) return json(res, 400, { error: 'Treść komunikatu nie może być pusta.' });

    const odbiorcy = db.prepare('SELECT id FROM users WHERE login != ?').all(SYSTEM_SENDER.login);
    for (const odbiorca of odbiorcy) {
      deliverSystemMessage(db, odbiorca.id, { subject, body: tresc, priority: true });
    }
    audyt(req, user, 'broadcast.send', '', subject);
    json(res, 200, { delivered: odbiorcy.length });
  });

  // --- Statystyki i dziennik -----------------------------------------------------------

  route('GET', '/api/admin/stats', async (req, res) => {
    let dbSize = null;
    if (dataDir) {
      try {
        dbSize = statSync(path.join(dataDir, 'twojapoczta.db')).size;
      } catch {
        dbSize = null; // baza in-memory albo jeszcze nie istnieje
      }
    }
    json(res, 200, {
      ...instanceStats(db),
      server: {
        uptime: process.uptime(),
        rss: process.memoryUsage().rss,
        node: process.version,
        db_size: dbSize,
      },
      gateway: {
        domain: DOMAIN,
        hostname: process.env.TP_SMTP_HOSTNAME ?? `mx.${DOMAIN}`,
        smtp: !!process.env.TP_SMTP_PORT,
        external: process.env.TP_EXTERNAL === '1',
        smtp_route: process.env.TP_SMTP_ROUTE ?? null,
        dkim: dkimConfigured(),
        registration: registrationOpen(db),
      },
    });
  });

  // --- DKIM i DNS -------------------------------------------------------------------

  route('GET', '/api/admin/dkim', async (req, res) => {
    if (!dkimConfigured()) return json(res, 200, { configured: false, selector: null, record: null });
    const record = dnsRecord();
    json(res, 200, { configured: true, selector: record.nazwa.split('._domainkey.')[0], record });
  });

  route('POST', '/api/admin/dkim', async (req, res, { user }) => {
    const body = await readBody(req);
    const selector = body.selector == null ? undefined : String(body.selector).trim().toLowerCase();
    if (selector !== undefined && !SELECTOR_RE.test(selector)) {
      return json(res, 400, { error: 'Selektor DKIM: 1–31 znaków, małe litery, cyfry i myślniki.' });
    }
    const wynik = initDkim(dataDir, { domain: DOMAIN, ...(selector ? { selector } : {}) });
    audyt(req, user, 'dkim.generate', wynik.selector, wynik.wygenerowano ? 'nowy klucz' : 'wczytano istniejący');
    json(res, 200, {
      configured: true,
      selector: wynik.selector,
      generated: wynik.wygenerowano,
      record: dnsRecord(),
    });
  });

  // Bez mutacji, więc bez wpisu w audycie. Certyfikat jest publiczny:
  // pokazujemy to, co każdy zobaczy przez openssl s_client.
  route('GET', '/api/admin/tls', async (req, res) => {
    json(res, 200, tlsStatus());
  });

  route('POST', '/api/admin/dns-check', async (req, res) => {
    const hostname = process.env.TP_SMTP_HOSTNAME ?? `mx.${DOMAIN}`;
    let dkim = null;
    if (dkimConfigured()) {
      const record = dnsRecord();
      dkim = { name: record.nazwa, value: record.wartosc };
    }
    const checks = await checkDns({ domain: DOMAIN, hostname, dkim, ...(resolver ? { resolver } : {}) });
    json(res, 200, { domain: DOMAIN, hostname, checks });
  });

  route('GET', '/api/admin/audit', async (req, res, { url }) => {
    const action = url.searchParams.get('action') || null;
    const limit = Number(url.searchParams.get('limit')) || 200;
    json(res, 200, { events: listEvents(db, { action, limit }) });
  });
}
