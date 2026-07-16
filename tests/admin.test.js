// Testy panelu administratora: rola, blokady kont, API /api/admin/*.
// HTTP przez createApp na bazie in-memory (jak api.test.js) + dostęp do bazy
// z zewnątrz, żeby symulować działania bez gotowego jeszcze API.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openMemoryDb, now } from '../server/db.js';
import { grantAdmin } from '../server/admin.js';
import { setSetting } from '../server/settings.js';
import { listEvents } from '../server/audit.js';

let server;
let base;
let db;

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
  const app = await createApp({ db });
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

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

test('GET /api/admin/audit zwraca dziennik z filtrem po akcji', async () => {
  const admin = await adminClient();
  const wszystko = await admin('GET', '/api/admin/audit');
  assert.equal(wszystko.status, 200);
  assert.ok(wszystko.data.events.length > 0);

  const logowania = await admin('GET', '/api/admin/audit?action=login');
  assert.ok(logowania.data.events.length > 0);
  assert.ok(logowania.data.events.every((w) => w.action === 'login'));
});
