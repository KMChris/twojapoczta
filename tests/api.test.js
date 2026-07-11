// End-to-end smoke tests: real HTTP against an in-memory database.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openMemoryDb } from '../server/db.js';

let server;
let base;

function client() {
  let cookie = '';
  return async function call(method, path, body) {
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
  };
}

before(async () => {
  const app = await createApp({ db: openMemoryDb() });
  server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('unauthenticated API access is rejected', async () => {
  const res = await fetch(`${base}/api/messages`);
  assert.equal(res.status, 401);
});

test('demo account can log in and sees the seeded inbox', async () => {
  const api = client();
  const login = await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.address, 'demo@twojapoczta.com');

  const inbox = await api('GET', '/api/messages?folder=inbox');
  assert.equal(inbox.status, 200);
  assert.ok(inbox.data.messages.length >= 5);
  assert.ok(inbox.data.counts.inbox >= 2);
});

test('reading a message marks it as read', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const inbox = await api('GET', '/api/messages?folder=inbox');
  const unread = inbox.data.messages.find((m) => !m.is_read);
  assert.ok(unread);

  const msg = await api('GET', `/api/messages/${unread.id}`);
  assert.equal(msg.data.message.is_read, 1);
});

test('registration creates a mailbox with a welcome message', async () => {
  const api = client();
  const reg = await api('POST', '/api/register', {
    login: 'kasia',
    name: 'Kasia Testowa',
    password: 'sekretne123',
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.user.address, 'kasia@twojapoczta.com');

  const inbox = await api('GET', '/api/messages?folder=inbox');
  assert.equal(inbox.data.messages.length, 1);
  assert.match(inbox.data.messages[0].subject, /Witaj/);
});

test('registration validates login format and duplicates', async () => {
  const api = client();
  const bad = await api('POST', '/api/register', { login: 'Zł y', name: 'X', password: '12345678' });
  assert.equal(bad.status, 400);
  const dup = await api('POST', '/api/register', { login: 'demo', name: 'X', password: '12345678' });
  assert.equal(dup.status, 409);
});

test('internal delivery: sent copy for sender, inbox copy for recipient', async () => {
  const kasia = client();
  await kasia('POST', '/api/login', { login: 'kasia', password: 'sekretne123' });
  const sent = await kasia('POST', '/api/messages', {
    to: 'demo@twojapoczta.com',
    subject: 'Test doręczenia',
    body: 'To jest test wewnętrznego doręczenia.',
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.folder, 'sent');

  const demo = client();
  await demo('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const inbox = await demo('GET', '/api/messages?folder=inbox');
  const received = inbox.data.messages.find((m) => m.subject === 'Test doręczenia');
  assert.ok(received);
  assert.equal(received.is_read, 0);
  assert.equal(received.from_addr, 'kasia@twojapoczta.com');
});

test('sending to unknown or external addresses fails clearly', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const unknown = await api('POST', '/api/messages', { to: 'nikt@twojapoczta.com', subject: 'x', body: 'x' });
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /Nie znaleziono/);
  const external = await api('POST', '/api/messages', { to: 'ktos@gmail.com', subject: 'x', body: 'x' });
  assert.equal(external.status, 400);
});

test('star, archive, trash and purge lifecycle', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const inbox = await api('GET', '/api/messages?folder=inbox');
  const target = inbox.data.messages[0];

  const starred = await api('PATCH', `/api/messages/${target.id}`, { is_starred: true });
  assert.equal(starred.data.message.is_starred, 1);
  const starredList = await api('GET', '/api/messages?folder=starred');
  assert.ok(starredList.data.messages.some((m) => m.id === target.id));

  const archived = await api('PATCH', `/api/messages/${target.id}`, { folder: 'archive' });
  assert.equal(archived.data.message.folder, 'archive');

  const trashed = await api('DELETE', `/api/messages/${target.id}`);
  assert.equal(trashed.data.purged, false);
  const purged = await api('DELETE', `/api/messages/${target.id}`);
  assert.equal(purged.data.purged, true);

  const gone = await api('GET', `/api/messages/${target.id}`);
  assert.equal(gone.status, 404);
});

test('drafts can be saved, updated and sent', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });

  const draft = await api('POST', '/api/messages', { draft: true, to: '', subject: 'Szkic', body: 'wersja 1' });
  assert.equal(draft.status, 200);
  const draftId = draft.data.message.id;

  const updated = await api('POST', '/api/messages', {
    draft: true, id: draftId, to: 'ania@twojapoczta.com', subject: 'Szkic', body: 'wersja 2',
  });
  assert.equal(updated.data.message.body, 'wersja 2');

  const sent = await api('POST', '/api/messages', {
    to: 'ania@twojapoczta.com', subject: 'Szkic', body: 'wersja 2', draftId,
  });
  assert.equal(sent.status, 201);
  const drafts = await api('GET', '/api/messages?folder=drafts');
  assert.ok(!drafts.data.messages.some((m) => m.id === draftId));
});

test('search finds messages by subject and sender', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const bySubject = await api('GET', '/api/messages?folder=inbox&q=rower');
  assert.ok(bySubject.data.messages.length >= 1);
  const nothing = await api('GET', '/api/messages?folder=inbox&q=xyzniematakiego');
  assert.equal(nothing.data.messages.length, 0);
});

test('aliases: add, deliver through alias, dedupe, remove', async () => {
  const ania = client();
  await ania('POST', '/api/login', { login: 'ania', password: 'demo1234' });

  const added = await ania('POST', '/api/aliases', { alias: 'ksiegowa' });
  assert.equal(added.status, 201);
  assert.equal(added.data.aliases[0].address, 'ksiegowa@twojapoczta.com');

  const taken = await ania('POST', '/api/aliases', { alias: 'demo' });
  assert.equal(taken.status, 409);
  const invalid = await ania('POST', '/api/aliases', { alias: 'Źle!' });
  assert.equal(invalid.status, 400);

  const demo = client();
  await demo('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const sent = await demo('POST', '/api/messages', {
    to: 'ksiegowa@twojapoczta.com, ania@twojapoczta.com',
    subject: 'Test aliasu',
    body: 'Przez alias i wprost, powinna dojść jedna kopia.',
  });
  assert.equal(sent.status, 201);

  const inbox = await ania('GET', '/api/messages?folder=inbox');
  const kopie = inbox.data.messages.filter((m) => m.subject === 'Test aliasu');
  assert.equal(kopie.length, 1);

  const removed = await ania('DELETE', `/api/aliases/${added.data.aliases[0].id}`);
  assert.equal(removed.status, 200);
  const gone = await demo('POST', '/api/messages', { to: 'ksiegowa@twojapoczta.com', subject: 'x', body: 'x' });
  assert.equal(gone.status, 400);
});

test('profile can be updated', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'kasia', password: 'sekretne123' });
  const updated = await api('PATCH', '/api/me', { theme: 'dark', signature: 'Pozdrawiam, Kasia' });
  assert.equal(updated.data.user.theme, 'dark');
  assert.equal(updated.data.user.signature, 'Pozdrawiam, Kasia');
});
