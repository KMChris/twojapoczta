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
