// Ścieżki negatywne i walidacja API: błędne dane, limity, 404/400/401/409/413/429.
// Osobna aplikacja na świeżej bazie in-memory: pełna izolacja od reszty testów.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openMemoryDb } from '../server/db.js';

let server;
let base;

function client() {
  let cookie = '';
  async function call(method, path, body, extra = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data };
  }
  call.rawBody = (method, path, rawBody, headers = {}) =>
    fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: rawBody });
  return call;
}

before(async () => {
  const app = await createApp({ db: openMemoryDb() });
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

// --- Body / routing ----------------------------------------------------------

test('nieprawidłowy JSON → 400', async () => {
  const res = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ zepsuty',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Nieprawidłowy format/);
});

test('nieznana trasa API → 404', async () => {
  const res = await fetch(`${base}/api/nie-ma-takiej`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Nie ma takiego adresu/);
});

test('body ponad 512 KB → 413', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const res = await api.rawBody('PATCH', '/api/me', 'x'.repeat(600 * 1024), {
    'Content-Type': 'application/json',
  });
  assert.equal(res.status, 413);
});

// --- Rejestracja -------------------------------------------------------------

test('rejestracja: walidacja loginu, nazwy, hasła i duplikatu', async () => {
  const api = client();
  assert.equal((await api('POST', '/api/register', { login: 'A B', name: 'X', password: '12345678' })).status, 400);
  assert.equal((await api('POST', '/api/register', { login: 'poprawny1', name: 'a'.repeat(61), password: '12345678' })).status, 400);
  assert.equal((await api('POST', '/api/register', { login: 'poprawny2', name: 'Ktoś', password: 'krotkie' })).status, 400);
  assert.equal((await api('POST', '/api/register', { login: 'demo', name: 'X', password: '12345678' })).status, 409);
});

// --- Logowanie ---------------------------------------------------------------

test('logowanie: złe hasło i nieznany login → 401', async () => {
  const api = client();
  assert.equal((await api('POST', '/api/login', { login: 'demo', password: 'zle', }, { 'X-Forwarded-For': '10.0.0.1' })).status, 401);
  assert.equal((await api('POST', '/api/login', { login: 'niktniema', password: 'x' }, { 'X-Forwarded-For': '10.0.0.1' })).status, 401);
});

test('logowanie: akceptuje login z sufiksem @domena', async () => {
  const api = client();
  const res = await api('POST', '/api/login', { login: 'demo@twojapoczta.com', password: 'demo1234' });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.login, 'demo');
});

test('logowanie: 6. próba blokowana (429), inny adres IP nie', async () => {
  const api = client();
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/login', { login: 'demo', password: 'zle' }, { 'X-Forwarded-For': '198.51.100.50' });
    assert.equal(r.status, 401);
  }
  const zablokowane = await api('POST', '/api/login', { login: 'demo', password: 'zle' }, { 'X-Forwarded-For': '198.51.100.50' });
  assert.equal(zablokowane.status, 429);
  const innyIp = await api('POST', '/api/login', { login: 'demo', password: 'zle' }, { 'X-Forwarded-For': '198.51.100.51' });
  assert.equal(innyIp.status, 401);
});

test('wylogowanie bez sesji zwraca 200', async () => {
  const res = await client()('POST', '/api/logout');
  assert.equal(res.status, 200);
});

// --- Profil ------------------------------------------------------------------

test('PATCH /api/me: ignoruje za długą nazwę/podpis i błędny motyw, pusty patch bez zmian', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const przed = (await api('GET', '/api/me')).data.user;

  const res = await api('PATCH', '/api/me', {
    name: 'a'.repeat(61),
    signature: 'z'.repeat(501),
    theme: 'neonowy',
  });
  assert.equal(res.data.user.name, przed.name);
  assert.equal(res.data.user.signature, przed.signature);
  assert.equal(res.data.user.theme, przed.theme);

  const pusty = await api('PATCH', '/api/me', {});
  assert.equal(pusty.status, 200);
  assert.equal(pusty.data.user.name, przed.name);

  const ok = await api('PATCH', '/api/me', { name: 'Nowa Nazwa', theme: 'dark' });
  assert.equal(ok.data.user.name, 'Nowa Nazwa');
  assert.equal(ok.data.user.theme, 'dark');
});

// --- Wiadomości --------------------------------------------------------------

test('GET/PATCH/DELETE nieistniejącej wiadomości → 404', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  assert.equal((await api('GET', '/api/messages/999999')).status, 404);
  assert.equal((await api('PATCH', '/api/messages/999999', { is_read: true })).status, 404);
  assert.equal((await api('DELETE', '/api/messages/999999')).status, 404);
});

test('POST /api/messages: za długi temat → 400, szkic z błędnym id → 404', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  assert.equal((await api('POST', '/api/messages', { to: 'ania@twojapoczta.com', subject: 't'.repeat(201), body: 'x' })).status, 400);
  assert.equal((await api('POST', '/api/messages', { draft: true, id: 999999, to: '', subject: 'x', body: 'x' })).status, 404);
});

test('GET /api/counts zwraca liczniki', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const res = await api('GET', '/api/counts');
  assert.equal(res.status, 200);
  assert.ok('inbox' in res.data.counts);
});

// --- Aliasy ------------------------------------------------------------------

test('aliasy: lista, walidacja, zajęty, limit 5, usunięcie nieistniejącego', async () => {
  const api = client();
  await api('POST', '/api/register', { login: 'aliaser', name: 'Alias User', password: 'haslo12345' });

  assert.deepEqual((await api('GET', '/api/aliases')).data.aliases, []);
  assert.equal((await api('POST', '/api/aliases', { alias: 'ZŁY!' })).status, 400);
  assert.equal((await api('POST', '/api/aliases', { alias: 'demo' })).status, 409);

  for (const a of ['alias-a', 'alias-b', 'alias-c', 'alias-d', 'alias-e']) {
    assert.equal((await api('POST', '/api/aliases', { alias: a })).status, 201);
  }
  assert.equal((await api('POST', '/api/aliases', { alias: 'alias-f' })).status, 400);
  assert.equal((await api('DELETE', '/api/aliases/999999')).status, 404);
});

// --- Uploady / załączniki ----------------------------------------------------

test('upload pustego pliku → 400', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const res = await api.rawBody('POST', '/api/uploads', Buffer.alloc(0), {
    'Content-Type': 'text/plain', 'X-Filename': 'pusty.txt',
  });
  assert.equal(res.status, 400);
});

test('upload z błędnym X-Filename spada na nazwę domyślną', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  // „%” bez dwóch cyfr szesnastkowych wywala decodeURIComponent → nazwa „plik"
  const res = await api.rawBody('POST', '/api/uploads', Buffer.from('dane'), {
    'Content-Type': 'text/plain', 'X-Filename': '%zle%',
  });
  assert.equal(res.status, 201);
  const { upload } = await res.json();
  assert.equal(upload.filename, 'plik');
});

test('pobranie nieistniejącego załącznika → 404', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const res = await api.rawBody('GET', '/api/messages/1/attachments/999999');
  assert.equal(res.status, 404);
});
