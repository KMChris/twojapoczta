// Testy panelu administratora: rola, blokady kont, API /api/admin/*.
// HTTP przez createApp na bazie in-memory (jak api.test.js) + dostęp do bazy
// z zewnątrz, żeby symulować działania bez gotowego jeszcze API.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { openMemoryDb, now } from '../server/db.js';
import { grantAdmin } from '../server/admin.js';
import { setSetting } from '../server/settings.js';
import { listEvents } from '../server/audit.js';
import { configureDkim } from '../server/dkim.js';
import { initTls, configureTls } from '../server/tls-cert.js';

let server;
let base;
let db;
let dataDir;

// Fałszywy resolver: MX i A domeny testowej istnieją, reszta strefy pusta.
const fakeResolver = {
  async resolveMx(name) {
    if (name === 'twojapoczta.com') return [{ priority: 10, exchange: 'mx.twojapoczta.com' }];
    throw Object.assign(new Error('queryNotFound'), { code: 'ENOTFOUND' });
  },
  async resolve4(name) {
    if (name === 'mx.twojapoczta.com') return ['203.0.113.7'];
    throw Object.assign(new Error('queryNotFound'), { code: 'ENOTFOUND' });
  },
  async resolveTxt() {
    throw Object.assign(new Error('queryNotFound'), { code: 'ENOTFOUND' });
  },
};

function client() {
  let cookie = '';
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data };
  }
  return call;
}

async function adminClient() {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  return api;
}

before(async () => {
  db = openMemoryDb();
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'tp-admin-'));
  const app = await createApp({ db, dataDir, dnsResolver: fakeResolver });
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  configureDkim(null); // testowe klucze nie mogą przeciekać do innych testów
  configureTls(null);
  rmSync(dataDir, { recursive: true, force: true });
  return new Promise((resolve) => server.close(resolve));
});

// --- Rola administratora -------------------------------------------------------

test('konto demo z seedu jest administratorem i /api/me to zwraca', async () => {
  const api = client();
  const login = await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.is_admin, true);
  const me = await api('GET', '/api/me');
  assert.equal(me.data.user.is_admin, true);
});

test('nowo zarejestrowane konto nie jest administratorem', async () => {
  const api = client();
  const r = await api('POST', '/api/register', { login: 'szeregowy', name: 'Szeregowy Pracownik', password: 'haslo1234' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.is_admin, false);
});

test('grantAdmin nadaje uprawnienia po loginie (ścieżka CLI --admin)', () => {
  const osobna = openMemoryDb();
  osobna
    .prepare("INSERT INTO users (login, name, password_hash, signature, theme, created_at) VALUES ('szef', 'Szef Instancji', 'x', '', 'system', ?)")
    .run(now());
  assert.equal(grantAdmin(osobna, 'szef'), true);
  assert.equal(osobna.prepare("SELECT is_admin FROM users WHERE login = 'szef'").get().is_admin, 1);
  assert.equal(grantAdmin(osobna, 'nie-ma-takiego'), false);
  osobna.close();
});

// --- Blokada konta ---------------------------------------------------------------

test('zablokowane konto: logowanie 403, a żywa sesja gaśnie', async () => {
  const api = client();
  await api('POST', '/api/register', { login: 'pechowiec', name: 'Pech Owiec', password: 'haslo1234' });
  assert.equal((await api('GET', '/api/me')).status, 200);

  db.prepare("UPDATE users SET is_blocked = 1 WHERE login = 'pechowiec'").run();
  assert.equal((await api('GET', '/api/me')).status, 401);

  const ponowne = await api('POST', '/api/login', { login: 'pechowiec', password: 'haslo1234' });
  assert.equal(ponowne.status, 403);
  assert.match(ponowne.data.error, /zablokowane/i);
});

// --- Ustawienia sterują rejestracją i polityką haseł -----------------------------

test('wpis registration=0 zamyka rejestrację i /api/config to raportuje', async () => {
  const api = client();
  setSetting(db, 'registration', '0');
  try {
    const config = await api('GET', '/api/config');
    assert.equal(config.data.registration, false);
    const rejestracja = await api('POST', '/api/register', { login: 'spozniony', name: 'Spóźniony Gość', password: 'haslo1234' });
    assert.equal(rejestracja.status, 403);
  } finally {
    setSetting(db, 'registration', null);
  }
});

test('password_min podnosi wymaganą długość hasła przy rejestracji', async () => {
  const api = client();
  setSetting(db, 'password_min', '12');
  try {
    const zaKrotkie = await api('POST', '/api/register', { login: 'krotki', name: 'Krótki Test', password: 'haslo1234' });
    assert.equal(zaKrotkie.status, 400);
    assert.match(zaKrotkie.data.error, /12/);
  } finally {
    setSetting(db, 'password_min', null);
  }
});

// --- Dziennik zdarzeń przy logowaniu ---------------------------------------------

test('logowanie udane i nieudane zostawia wpisy w dzienniku', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'michal', password: 'demo1234' });
  await api('POST', '/api/login', { login: 'michal', password: 'zle-haslo' });

  const udane = listEvents(db, { action: 'login' });
  assert.ok(udane.some((w) => w.actor_login === 'michal'));
  const nieudane = listEvents(db, { action: 'login.failed' });
  assert.ok(nieudane.some((w) => w.actor_login === 'michal'));
});

test('rejestracja konta zostawia wpis w dzienniku', async () => {
  const api = client();
  await api('POST', '/api/register', { login: 'dziennikowy', name: 'Dziennikowy Test', password: 'haslo1234' });
  assert.ok(listEvents(db, { action: 'user.register' }).some((w) => w.actor_login === 'dziennikowy'));
});

// --- Ślad logowania ----------------------------------------------------------------

test('udane logowanie zapisuje last_login_at', async () => {
  const api = client();
  assert.equal(db.prepare("SELECT last_login_at FROM users WHERE login = 'ania'").get().last_login_at, null);
  await api('POST', '/api/login', { login: 'ania', password: 'demo1234' });
  assert.ok(db.prepare("SELECT last_login_at FROM users WHERE login = 'ania'").get().last_login_at);
});

// --- Strażnik /api/admin/* ---------------------------------------------------------

test('trasy admina: 401 bez sesji, 403 dla zwykłego konta', async () => {
  const bezSesji = await fetch(`${base}/api/admin/users`);
  assert.equal(bezSesji.status, 401);

  const api = client();
  await api('POST', '/api/register', { login: 'ciekawski', name: 'Ciekawski Typ', password: 'haslo1234' });
  assert.equal((await api('GET', '/api/admin/users')).status, 403);
  assert.equal((await api('POST', '/api/admin/broadcast', { subject: 'x', body: 'y' })).status, 403);
});

test('PATCH /api/me nie pozwala nadać sobie uprawnień administratora', async () => {
  const api = client();
  await api('POST', '/api/register', { login: 'sprytny', name: 'Sprytny Typ', password: 'haslo1234' });
  const me = await api('PATCH', '/api/me', { is_admin: true });
  assert.equal(me.data.user.is_admin, false);
});

// --- Lista i tworzenie kont ----------------------------------------------------------

test('GET /api/admin/users zwraca konta z metadanymi', async () => {
  const api = await adminClient();
  const r = await api('GET', '/api/admin/users');
  assert.equal(r.status, 200);
  const demo = r.data.users.find((u) => u.login === 'demo');
  assert.ok(demo);
  assert.equal(demo.is_admin, true);
  assert.equal(demo.address, 'demo@twojapoczta.com');
  assert.ok(demo.messages > 0, 'seed dał demo wiadomości');
  assert.ok(demo.storage_bytes > 0);
  assert.ok(Array.isArray(demo.aliases));
  assert.ok('quota_mb' in demo && 'is_blocked' in demo && 'last_login_at' in demo && 'created_at' in demo);
  assert.equal(demo.alias_limit, 5, 'konta z seedu mają domyślny limit aliasów');
});

test('POST /api/admin/users zakłada konto nawet przy zamkniętej rejestracji', async () => {
  const api = await adminClient();
  setSetting(db, 'registration', '0');
  try {
    const r = await api('POST', '/api/admin/users', { login: 'nowy.pracownik', name: 'Nowy Pracownik', password: 'haslo1234' });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.login, 'nowy.pracownik');
    assert.equal(r.data.user.messages, 1, 'dostał list powitalny');
  } finally {
    setSetting(db, 'registration', null);
  }
  assert.ok(listEvents(db, { action: 'user.create' }).some((w) => w.target === 'nowy.pracownik'));
});

test('POST /api/admin/users waliduje login, hasło i konflikty', async () => {
  const api = await adminClient();
  assert.equal((await api('POST', '/api/admin/users', { login: 'ZŁY LOGIN', name: 'X Y', password: 'haslo1234' })).status, 400);
  assert.equal((await api('POST', '/api/admin/users', { login: 'krotkie.haslo', name: 'X Y', password: 'ha' })).status, 400);
  assert.equal((await api('POST', '/api/admin/users', { login: 'demo', name: 'Dubel', password: 'haslo1234' })).status, 409);
});

// --- Edycja kont: rola, blokada, limit ------------------------------------------------

test('PATCH /api/admin/users/:id zmienia imię i limit, waliduje śmieci', async () => {
  const api = await adminClient();
  const created = await api('POST', '/api/admin/users', { login: 'limitowany', name: 'Limitowany Typ', password: 'haslo1234' });
  const id = created.data.user.id;

  const r = await api('PATCH', `/api/admin/users/${id}`, { name: 'Po Zmianie', quota_mb: 250 });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.name, 'Po Zmianie');
  assert.equal(r.data.user.quota_mb, 250);

  const wyczysc = await api('PATCH', `/api/admin/users/${id}`, { quota_mb: null });
  assert.equal(wyczysc.data.user.quota_mb, null);

  assert.equal((await api('PATCH', `/api/admin/users/${id}`, { quota_mb: -5 })).status, 400);
  assert.equal((await api('PATCH', `/api/admin/users/${id}`, { quota_mb: 'setka' })).status, 400);
  assert.equal((await api('PATCH', '/api/admin/users/999999', { name: 'Duch' })).status, 404);
});

test('nadanie i odebranie roli administratora działa i zostaje w dzienniku', async () => {
  const api = await adminClient();
  const created = await api('POST', '/api/admin/users', { login: 'zastepca', name: 'Zastępca Szefa', password: 'haslo1234' });
  const id = created.data.user.id;

  const nadanie = await api('PATCH', `/api/admin/users/${id}`, { is_admin: true });
  assert.equal(nadanie.data.user.is_admin, true);
  const odebranie = await api('PATCH', `/api/admin/users/${id}`, { is_admin: false });
  assert.equal(odebranie.data.user.is_admin, false);
  assert.ok(listEvents(db, { action: 'user.admin' }).some((w) => w.target === 'zastepca'));
});

test('ostatniemu administratorowi nie można odebrać roli ani go usunąć', async () => {
  const api = await adminClient();
  const demoId = db.prepare("SELECT id FROM users WHERE login = 'demo'").get().id;
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n, 1, 'demo jest jedynym adminem');

  assert.equal((await api('PATCH', `/api/admin/users/${demoId}`, { is_admin: false })).status, 400);
  assert.equal((await api('DELETE', `/api/admin/users/${demoId}`)).status, 400);
  assert.equal((await api('PATCH', `/api/admin/users/${demoId}`, { is_blocked: true })).status, 400, 'nie można zablokować siebie');
});

test('blokada konta unieważnia jego sesje, odblokowanie przywraca logowanie', async () => {
  const admin = await adminClient();
  const created = await admin('POST', '/api/admin/users', { login: 'blokowany', name: 'Blokowany Typ', password: 'haslo1234' });
  const id = created.data.user.id;

  const ofiara = client();
  await ofiara('POST', '/api/login', { login: 'blokowany', password: 'haslo1234' });
  assert.equal((await ofiara('GET', '/api/me')).status, 200);

  const blokada = await admin('PATCH', `/api/admin/users/${id}`, { is_blocked: true });
  assert.equal(blokada.data.user.is_blocked, true);
  assert.equal((await ofiara('GET', '/api/me')).status, 401, 'sesja wygasła natychmiast');
  assert.ok(listEvents(db, { action: 'user.block' }).some((w) => w.target === 'blokowany'));

  await admin('PATCH', `/api/admin/users/${id}`, { is_blocked: false });
  const ponowne = await ofiara('POST', '/api/login', { login: 'blokowany', password: 'haslo1234' });
  assert.equal(ponowne.status, 200);
  assert.ok(listEvents(db, { action: 'user.unblock' }).some((w) => w.target === 'blokowany'));
});

// --- Hasło i sesje --------------------------------------------------------------------

test('POST /api/admin/users/:id/password ustawia nowe hasło', async () => {
  const admin = await adminClient();
  const created = await admin('POST', '/api/admin/users', { login: 'resetowany', name: 'Resetowany Typ', password: 'stare-haslo1' });
  const id = created.data.user.id;

  assert.equal((await admin('POST', `/api/admin/users/${id}/password`, { password: 'za' })).status, 400);
  assert.equal((await admin('POST', `/api/admin/users/${id}/password`, { password: 'nowe-haslo-123' })).status, 200);

  const proba = client();
  assert.equal((await proba('POST', '/api/login', { login: 'resetowany', password: 'stare-haslo1' })).status, 401);
  assert.equal((await proba('POST', '/api/login', { login: 'resetowany', password: 'nowe-haslo-123' })).status, 200);
  assert.ok(listEvents(db, { action: 'user.password' }).some((w) => w.target === 'resetowany'));
});

test('POST /api/admin/users/:id/logout wylogowuje ze wszystkich urządzeń', async () => {
  const admin = await adminClient();
  const created = await admin('POST', '/api/admin/users', { login: 'wylogowany', name: 'Wylogowany Typ', password: 'haslo1234' });
  const id = created.data.user.id;

  const sesjaA = client();
  const sesjaB = client();
  await sesjaA('POST', '/api/login', { login: 'wylogowany', password: 'haslo1234' });
  await sesjaB('POST', '/api/login', { login: 'wylogowany', password: 'haslo1234' });

  assert.equal((await admin('POST', `/api/admin/users/${id}/logout`)).status, 200);
  assert.equal((await sesjaA('GET', '/api/me')).status, 401);
  assert.equal((await sesjaB('GET', '/api/me')).status, 401);
});

// --- Usuwanie konta --------------------------------------------------------------------

test('DELETE /api/admin/users/:id usuwa konto z całą pocztą', async () => {
  const admin = await adminClient();
  const created = await admin('POST', '/api/admin/users', { login: 'do.usuniecia', name: 'Do Usunięcia', password: 'haslo1234' });
  const id = created.data.user.id;
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ?').get(id).n > 0);

  assert.equal((await admin('DELETE', `/api/admin/users/${id}`)).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE owner_id = ?').get(id).n, 0, 'poczta poszła kaskadą');
  assert.ok(listEvents(db, { action: 'user.delete' }).some((w) => w.target === 'do.usuniecia'));
  assert.equal((await admin('DELETE', '/api/admin/users/999999')).status, 404);
});

// --- Aliasy z panelu ---------------------------------------------------------------------

test('administrator zarządza aliasami dowolnego konta', async () => {
  const admin = await adminClient();
  const aniaId = db.prepare("SELECT id FROM users WHERE login = 'ania'").get().id;

  const dodany = await admin('POST', `/api/admin/users/${aniaId}/aliases`, { alias: 'recepcja' });
  assert.equal(dodany.status, 201);
  assert.ok(dodany.data.aliases.some((a) => a.alias === 'recepcja'));

  assert.equal((await admin('POST', `/api/admin/users/${aniaId}/aliases`, { alias: 'recepcja' })).status, 409);

  const aliasId = dodany.data.aliases.find((a) => a.alias === 'recepcja').id;
  const usuniety = await admin('DELETE', `/api/admin/users/${aniaId}/aliases/${aliasId}`);
  assert.equal(usuniety.status, 200);
  assert.ok(!usuniety.data.aliases.some((a) => a.alias === 'recepcja'));
});

// --- Limit aliasów per konto ----------------------------------------------------------------

test('PATCH /api/admin/users/:id: limit aliasów, zniesienie limitu i walidacja', async () => {
  const admin = await adminClient();
  const created = await admin('POST', '/api/admin/users', { login: 'aliasowy', name: 'Aliasowy Typ', password: 'haslo1234' });
  const id = created.data.user.id;
  assert.equal(created.data.user.alias_limit, 5, 'nowe konto dostaje domyślny limit');

  const dwa = await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: 2 });
  assert.equal(dwa.status, 200);
  assert.equal(dwa.data.user.alias_limit, 2);

  const bez = await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: null });
  assert.equal(bez.data.user.alias_limit, null, 'null = bez limitu');

  assert.equal((await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: -1 })).status, 400);
  assert.equal((await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: 1.5 })).status, 400);
  assert.equal((await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: 'dużo' })).status, 400);
  assert.equal((await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: 101 })).status, 400);
  assert.ok(listEvents(db, { action: 'user.alias_limit' }).some((w) => w.target === 'aliasowy'));
});

test('administrator dokłada aliasy tylko do granicy limitu konta', async () => {
  const admin = await adminClient();
  const created = await admin('POST', '/api/admin/users', { login: 'jeden.alias', name: 'Jeden Alias', password: 'haslo1234' });
  const id = created.data.user.id;
  await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: 1 });

  assert.equal((await admin('POST', `/api/admin/users/${id}/aliases`, { alias: 'pierwszy' })).status, 201);
  const drugi = await admin('POST', `/api/admin/users/${id}/aliases`, { alias: 'drugi' });
  assert.equal(drugi.status, 400);
  assert.match(drugi.data.error, /limit aliasów \(1\)/);
});

test('limit 0 wyłącza aliasy, a zniesienie limitu przepuszcza więcej niż piątkę', async () => {
  const admin = await adminClient();
  const uzytkownik = client();
  await uzytkownik('POST', '/api/register', { login: 'wolny.alias', name: 'Wolny Alias', password: 'haslo1234' });
  const id = db.prepare("SELECT id FROM users WHERE login = 'wolny.alias'").get().id;

  await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: 0 });
  const zero = await uzytkownik('POST', '/api/aliases', { alias: 'niemozliwy' });
  assert.equal(zero.status, 400);
  assert.match(zero.data.error, /wyłączył/i);
  assert.equal((await uzytkownik('GET', '/api/aliases')).data.limit, 0);

  await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: null });
  for (const alias of ['w-a', 'w-b', 'w-c', 'w-d', 'w-e', 'w-f']) {
    assert.equal((await uzytkownik('POST', '/api/aliases', { alias })).status, 201, alias);
  }
  const lista = await uzytkownik('GET', '/api/aliases');
  assert.equal(lista.data.limit, null, 'bez limitu, interfejs nie pokaże liczby');
  assert.equal(lista.data.aliases.length, 6);
});

test('obniżenie limitu nie kasuje aliasów, które konto już ma', async () => {
  const admin = await adminClient();
  const created = await admin('POST', '/api/admin/users', { login: 'nadmiarowy', name: 'Nadmiarowy Typ', password: 'haslo1234' });
  const id = created.data.user.id;
  for (const alias of ['n-a', 'n-b', 'n-c']) {
    assert.equal((await admin('POST', `/api/admin/users/${id}/aliases`, { alias })).status, 201);
  }

  const obnizony = await admin('PATCH', `/api/admin/users/${id}`, { alias_limit: 1 });
  assert.equal(obnizony.data.user.alias_limit, 1);
  assert.equal(obnizony.data.user.aliases.length, 3, 'istniejące aliasy zostają nietknięte');
  assert.equal((await admin('POST', `/api/admin/users/${id}/aliases`, { alias: 'n-d' })).status, 400);
});

// --- Ustawienia instancji ------------------------------------------------------------------

test('GET/PATCH /api/admin/settings steruje rejestracją, hasłami i catch-all', async () => {
  const admin = await adminClient();
  const przed = await admin('GET', '/api/admin/settings');
  assert.equal(przed.status, 200);
  assert.equal(przed.data.settings.registration, true);
  assert.equal(przed.data.settings.password_min, 8);
  assert.equal(przed.data.settings.catchall, null);
  assert.equal(przed.data.env.domain, 'twojapoczta.com');

  try {
    const po = await admin('PATCH', '/api/admin/settings', { registration: false, password_min: 10, catchall: 'demo' });
    assert.equal(po.data.settings.registration, false);
    assert.equal(po.data.settings.password_min, 10);
    assert.equal(po.data.settings.catchall, 'demo');
    assert.equal((await client()('GET', '/api/config')).data.registration, false);
    assert.ok(listEvents(db, { action: 'settings.update' }).length > 0);

    assert.equal((await admin('PATCH', '/api/admin/settings', { catchall: 'nie-ma-takiego' })).status, 400);
    assert.equal((await admin('PATCH', '/api/admin/settings', { password_min: 2 })).status, 400);
  } finally {
    setSetting(db, 'registration', null);
    setSetting(db, 'password_min', null);
    setSetting(db, 'catchall', null);
  }
});

// --- Broadcast --------------------------------------------------------------------------------

test('POST /api/admin/broadcast dostarcza komunikat do wszystkich skrzynek', async () => {
  const admin = await adminClient();
  assert.equal((await admin('POST', '/api/admin/broadcast', { subject: '', body: '' })).status, 400);

  const r = await admin('POST', '/api/admin/broadcast', { subject: 'Przerwa techniczna', body: 'W sobotę 22:00–23:00.' });
  assert.equal(r.status, 200);
  assert.ok(r.data.delivered >= 4);
  const dostarczone = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE subject = 'Przerwa techniczna' AND folder = 'inbox'").get().n;
  assert.equal(dostarczone, r.data.delivered);
  assert.ok(listEvents(db, { action: 'broadcast.send' }).length > 0);
});

// --- Statystyki i dziennik ---------------------------------------------------------------------

test('GET /api/admin/stats zwraca przekrój instancji', async () => {
  const admin = await adminClient();
  const r = await admin('GET', '/api/admin/stats');
  assert.equal(r.status, 200);
  assert.ok(r.data.users.total >= 5);
  assert.ok(r.data.users.admins >= 1);
  assert.ok(r.data.messages.total > 0);
  assert.ok(r.data.storage.bytes > 0);
  assert.equal(r.data.traffic.length, 14);
  assert.ok('sent' in r.data.traffic[0] && 'received' in r.data.traffic[0] && 'date' in r.data.traffic[0]);
  assert.ok(r.data.server.uptime > 0);
  assert.equal(r.data.server.node, process.version);
  assert.ok(r.data.sessions.active >= 1);
  assert.equal(r.data.gateway.domain, 'twojapoczta.com');
  assert.equal(typeof r.data.gateway.external, 'boolean');
  assert.equal(typeof r.data.gateway.dkim, 'boolean');
});

// --- DKIM i DNS ----------------------------------------------------------------------

test('DKIM: generowanie, ponowne wczytanie i rotacja selektorem', async () => {
  const admin = await adminClient();
  const przed = await admin('GET', '/api/admin/dkim');
  assert.equal(przed.data.configured, false);

  assert.equal((await admin('POST', '/api/admin/dkim', { selector: 'ZŁY SELEKTOR!' })).status, 400);

  const pierwszy = await admin('POST', '/api/admin/dkim', {});
  assert.equal(pierwszy.status, 200);
  assert.equal(pierwszy.data.generated, true);
  assert.equal(pierwszy.data.selector, 'tp1');
  assert.match(pierwszy.data.record.nazwa, /^tp1\._domainkey\.twojapoczta\.com$/);
  assert.match(pierwszy.data.record.wartosc, /^v=DKIM1; k=rsa; p=/);

  const drugi = await admin('POST', '/api/admin/dkim', { selector: 'tp1' });
  assert.equal(drugi.data.generated, false, 'istniejący klucz jest wczytywany, nie nadpisywany');

  const rotacja = await admin('POST', '/api/admin/dkim', { selector: 'tp2' });
  assert.equal(rotacja.data.generated, true);
  assert.match(rotacja.data.record.nazwa, /^tp2\._domainkey\./);

  const po = await admin('GET', '/api/admin/dkim');
  assert.equal(po.data.configured, true);
  assert.equal(po.data.selector, 'tp2');
  assert.ok(listEvents(db, { action: 'dkim.generate' }).length >= 2);
});

test('POST /api/admin/dns-check raportuje stan rekordów przez resolver', async () => {
  const admin = await adminClient();
  const r = await admin('POST', '/api/admin/dns-check');
  assert.equal(r.status, 200);
  assert.equal(r.data.domain, 'twojapoczta.com');
  assert.equal(r.data.hostname, 'mx.twojapoczta.com');

  const stany = Object.fromEntries(r.data.checks.map((c) => [c.id, c.status]));
  assert.equal(stany.mx, 'ok');
  assert.equal(stany.a, 'ok');
  assert.equal(stany.spf, 'missing');
  assert.equal(stany.dmarc, 'missing');
  assert.equal(stany.dkim, 'missing', 'klucz wygenerowany, ale TXT nieopublikowany');
});

test('GET /api/admin/audit zwraca dziennik z filtrem po akcji', async () => {
  const admin = await adminClient();
  const wszystko = await admin('GET', '/api/admin/audit');
  assert.equal(wszystko.status, 200);
  assert.ok(wszystko.data.events.length > 0);

  const logowania = await admin('GET', '/api/admin/audit?action=login');
  assert.ok(logowania.data.events.length > 0);
  assert.ok(logowania.data.events.every((w) => w.action === 'login'));
});

// --- TLS ------------------------------------------------------------------------

test('GET /api/admin/tls: bez bramki SMTP mówi wyłączone z powodem', async () => {
  configureTls(null);
  const api = await adminClient();
  const r = await api('GET', '/api/admin/tls');
  assert.equal(r.status, 200);
  assert.equal(r.data.enabled, false);
  assert.equal(r.data.reason, 'smtp-off');
});

test('GET /api/admin/tls: opisuje certyfikat samopodpisany', async () => {
  try {
    initTls(dataDir, { hostname: 'mx.twojapoczta.com' });
    const api = await adminClient();
    const r = await api('GET', '/api/admin/tls');

    assert.equal(r.status, 200);
    assert.equal(r.data.enabled, true);
    assert.equal(r.data.source, 'self-signed');
    assert.equal(r.data.subject, 'CN=mx.twojapoczta.com');
    assert.ok(r.data.daysLeft > 1800);
    assert.match(r.data.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  } finally {
    configureTls(null);
  }
});

test('GET /api/admin/tls wymaga roli administratora', async () => {
  const api = client();
  await api('POST', '/api/register', { login: 'bez-roli-tls', name: 'Bez Roli', password: 'haslo1234' });
  const r = await api('GET', '/api/admin/tls');
  assert.equal(r.status, 403);
});
