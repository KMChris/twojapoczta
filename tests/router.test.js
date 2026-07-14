// Jednostkowe testy mini-routera: dopasowanie metod, parametry :id, znaki specjalne.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../server/router.js';

test('dopasowuje statyczną ścieżkę i metodę', () => {
  const r = createRouter();
  const h = () => 'ok';
  r.get('/api/me', h);
  const m = r.match('GET', '/api/me');
  assert.ok(m);
  assert.equal(m.handler, h);
  assert.deepEqual(m.params, {});
});

test('nie dopasowuje przy innej metodzie', () => {
  const r = createRouter();
  r.get('/api/me', () => {});
  assert.equal(r.match('POST', '/api/me'), null);
});

test('zwraca null gdy nic nie pasuje', () => {
  const r = createRouter();
  r.get('/api/me', () => {});
  assert.equal(r.match('GET', '/api/nieistnieje'), null);
});

test('wyłuskuje parametry :id i dekoduje je', () => {
  const r = createRouter();
  r.get('/api/messages/:id', () => {});
  const m = r.match('GET', '/api/messages/42');
  assert.deepEqual(m.params, { id: '42' });

  const dek = r.match('GET', '/api/messages/a%20b');
  assert.deepEqual(dek.params, { id: 'a b' });
});

test('obsługuje wiele parametrów w jednej ścieżce', () => {
  const r = createRouter();
  r.get('/api/messages/:id/attachments/:aid', () => {});
  const m = r.match('GET', '/api/messages/7/attachments/3');
  assert.deepEqual(m.params, { id: '7', aid: '3' });
});

test('parametr nie łapie ukośnika (segmentowe [^/]+)', () => {
  const r = createRouter();
  r.get('/api/messages/:id', () => {});
  assert.equal(r.match('GET', '/api/messages/7/extra'), null);
});

test('escapuje znaki specjalne w literalnych segmentach', () => {
  const r = createRouter();
  r.get('/api/a.b', () => {});
  assert.ok(r.match('GET', '/api/a.b'));
  // kropka jest literałem, nie dowolnym znakiem
  assert.equal(r.match('GET', '/api/aXb'), null);
});

test('rejestruje wszystkie czasowniki HTTP', () => {
  const r = createRouter();
  r.get('/x', () => 'g');
  r.post('/x', () => 'p');
  r.patch('/x', () => 'pa');
  r.delete('/x', () => 'd');
  assert.ok(r.match('GET', '/x'));
  assert.ok(r.match('POST', '/x'));
  assert.ok(r.match('PATCH', '/x'));
  assert.ok(r.match('DELETE', '/x'));
});

test('pierwsza pasująca trasa wygrywa', () => {
  const r = createRouter();
  r.get('/api/:x', () => 'pierwsza');
  r.get('/api/konkret', () => 'druga');
  assert.equal(r.match('GET', '/api/konkret').handler(), 'pierwsza');
});
