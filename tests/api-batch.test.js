// Operacje zbiorcze na wiadomościach: PATCH i DELETE /api/messages (bez :id).
// Osobna aplikacja na świeżej bazie in-memory, wzorzec z api.extra.test.js.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openMemoryDb } from '../server/db.js';

let server;
let base;
let db;

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
  return call;
}

before(async () => {
  db = openMemoryDb();
  const app = await createApp({ db });
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

async function zalogowanyDemo() {
  const api = client();
  const res = await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  assert.equal(res.status, 200);
  return api;
}

// Trzy listy demo → demo; zwraca id kopii z Odebranych.
async function wyslijTrzy(api, znacznik) {
  for (let i = 1; i <= 3; i++) {
    const res = await api('POST', '/api/messages', {
      to: 'demo@twojapoczta.com',
      subject: `${znacznik} ${i}`,
      body: `Treść ${i}`,
    });
    assert.equal(res.status, 201);
  }
  const { data } = await api('GET', '/api/messages?folder=inbox&q=');
  return data.messages.filter((w) => w.subject.startsWith(znacznik)).map((w) => w.id);
}

test('wsad: walidacja ids i pól zmiany → 400', async () => {
  const api = await zalogowanyDemo();
  const zle = [
    { is_read: true }, // bez ids
    { ids: [], is_read: true },
    { ids: Array.from({ length: 201 }, (_, i) => i + 1), is_read: true },
    { ids: [1, '2'], is_read: true }, // string zamiast liczby
    { ids: [1.5], is_read: true },
    { ids: [1, 2] }, // bez pola zmiany
  ];
  for (const body of zle) {
    const res = await api('PATCH', '/api/messages', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.data.error, /Nieprawidłowy format/);
  }
  assert.equal((await api('DELETE', '/api/messages', { ids: [] })).status, 400);
  assert.equal((await api('DELETE', '/api/messages', { ids: ['x'] })).status, 400);
});

test('wsad bez sesji → 401', async () => {
  const api = client();
  assert.equal((await api('PATCH', '/api/messages', { ids: [1], is_read: true })).status, 401);
  assert.equal((await api('DELETE', '/api/messages', { ids: [1] })).status, 401);
});

test('PATCH wsadem: is_read, przenosiny, cudze id i zły folder własny', async () => {
  const api = await zalogowanyDemo();
  const ids = await wyslijTrzy(api, 'Wsad A');
  assert.equal(ids.length, 3);

  const przed = (await api('GET', '/api/counts')).data.counts.inbox;
  const przeczytane = await api('PATCH', '/api/messages', { ids, is_read: true });
  assert.equal(przeczytane.status, 200);
  assert.deepEqual(przeczytane.data, { updated: 3 });
  assert.equal((await api('GET', '/api/counts')).data.counts.inbox, przed - 3);

  // Cudze id nie liczy się do updated i nie zmienia cudzej wiadomości.
  await api('POST', '/api/messages', { to: 'ania@twojapoczta.com', subject: 'Cudza', body: 'x' });
  const cudza = db
    .prepare("SELECT id, folder FROM messages WHERE owner_id = (SELECT id FROM users WHERE login = 'ania') LIMIT 1")
    .get();
  assert.ok(cudza);
  const przenosiny = await api('PATCH', '/api/messages', { ids: [...ids, cudza.id], folder: 'archive' });
  assert.deepEqual(przenosiny.data, { updated: 3 });
  assert.equal(
    db.prepare('SELECT folder FROM messages WHERE id = ?').get(cudza.id).folder,
    cudza.folder
  );
  const archiwum = (await api('GET', '/api/messages?folder=archive&q=')).data.messages;
  for (const id of ids) assert.ok(archiwum.some((w) => w.id === id));

  // Nieistniejący folder własny: updateMessage odmawia każdemu id.
  const zly = await api('PATCH', '/api/messages', { ids, folder_id: 9999 });
  assert.deepEqual(zly.data, { updated: 0 });

  // Lista niesie folder_id — cofanie zbiorcze grupuje po tej parze.
  assert.ok(Object.hasOwn(archiwum[0], 'folder_id'));
});

test('DELETE wsadem: najpierw kosz, z kosza trwale', async () => {
  const api = await zalogowanyDemo();
  const ids = await wyslijTrzy(api, 'Wsad B');

  const doKosza = await api('DELETE', '/api/messages', { ids });
  assert.equal(doKosza.status, 200);
  assert.deepEqual(doKosza.data, { deleted: 3, purged: 0 });
  const kosz = (await api('GET', '/api/messages?folder=trash&q=')).data.messages;
  for (const id of ids) assert.ok(kosz.some((w) => w.id === id));

  const trwale = await api('DELETE', '/api/messages', { ids });
  assert.deepEqual(trwale.data, { deleted: 3, purged: 3 });
  const zostalo = db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE id IN (${ids.join(',')})`)
    .get().n;
  assert.equal(zostalo, 0);

  // Powtórka po skasowanych: nic nie znaleziono, nic nie usunięto.
  assert.deepEqual((await api('DELETE', '/api/messages', { ids })).data, { deleted: 0, purged: 0 });
});
