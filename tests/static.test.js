// Jednostkowe testy serwera plików statycznych: czyste URL-e, bezpieczne ścieżki,
// cache, 304, HEAD, 405, fallback 404. Fixtury w katalogu tymczasowym.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStaticHandler } from '../server/static.js';

let root;
let serve;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'tp-static-'));
  mkdirSync(path.join(root, 'assets', 'fonts'), { recursive: true });
  mkdirSync(path.join(root, 'pod'), { recursive: true });
  writeFileSync(path.join(root, 'index.html'), '<h1>Strona</h1>');
  writeFileSync(path.join(root, 'app.html'), 'APLIKACJA');
  writeFileSync(path.join(root, '404.html'), 'NIE MA STRONY');
  writeFileSync(path.join(root, 'strona.html'), 'STRONA');
  writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(path.join(root, 'assets', 'fonts', 'font.woff2'), Buffer.from([1, 2, 3, 4]));
  writeFileSync(path.join(root, 'pod', 'index.html'), 'INDEX POD');
  serve = createStaticHandler(root);
});

after(() => rmSync(root, { recursive: true, force: true }));

// Mock odpowiedzi: strumień Writable, który łapie pipe(), writeHead() i end().
class MockRes extends Writable {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.chunks = [];
    this.done = new Promise((r) => (this._resolve = r));
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  _write(chunk, _enc, cb) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
  end(chunk) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this._resolve();
    return super.end();
  }
  get body() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

async function req(method, pathname, headers = {}) {
  const res = new MockRes();
  await serve({ method, headers }, res, pathname);
  await res.done;
  return res;
}

test('serwuje stronę główną „/” jako index.html', async () => {
  const res = await req('GET', '/');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(res.body, /Strona/);
});

test('czysty URL „/app” → app.html', async () => {
  const res = await req('GET', '/app');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'APLIKACJA');
});

test('serwuje zasób z podkatalogu z właściwym typem MIME', async () => {
  const res = await req('GET', '/assets/app.js');
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'text/javascript; charset=utf-8');
});

test('fonty dostają nieśmiertelny cache, reszta no-cache', async () => {
  const font = await req('GET', '/assets/fonts/font.woff2');
  assert.equal(font.headers['Content-Type'], 'font/woff2');
  assert.match(font.headers['Cache-Control'], /immutable/);
  const strona = await req('GET', '/');
  assert.equal(strona.headers['Cache-Control'], 'no-cache');
});

test('rozszerzenie .html dołączane automatycznie (/strona → strona.html)', async () => {
  const res = await req('GET', '/strona');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'STRONA');
});

test('katalog serwuje swój index.html', async () => {
  const res = await req('GET', '/pod');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'INDEX POD');
});

test('nieznana ścieżka → 404 z treścią 404.html', async () => {
  const res = await req('GET', '/nie/ma/takiej');
  assert.equal(res.statusCode, 404);
  assert.equal(res.body, 'NIE MA STRONY');
});

test('HEAD nie zwraca ciała', async () => {
  const res = await req('HEAD', '/');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '');
  assert.ok(res.headers['Content-Length']);
});

test('If-Modified-Since → 304 bez ciała', async () => {
  const first = await req('GET', '/');
  const lm = first.headers['Last-Modified'];
  assert.ok(lm);
  const res = await req('GET', '/', { 'if-modified-since': lm });
  assert.equal(res.statusCode, 304);
  assert.equal(res.body, '');
});

test('metoda inna niż GET/HEAD → 405', async () => {
  const res = await req('POST', '/');
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, 'GET, HEAD');
});

test('próba wyjścia poza katalog (../) → 404', async () => {
  const res = await req('GET', '/../../../etc/passwd');
  assert.equal(res.statusCode, 404);
});

test('bajt zerowy w ścieżce → 404', async () => {
  const res = await req('GET', '/plik\0.html');
  assert.equal(res.statusCode, 404);
});

test('błędne kodowanie procentowe → 404', async () => {
  const res = await req('GET', '/%E0%A4%A');
  assert.equal(res.statusCode, 404);
});

test('bez pliku 404.html serwer zwraca prosty tekst 404', async () => {
  const pusty = mkdtempSync(path.join(os.tmpdir(), 'tp-static-empty-'));
  try {
    const serveEmpty = createStaticHandler(pusty);
    const res = new MockRes();
    await serveEmpty({ method: 'GET', headers: {} }, res, '/cokolwiek');
    await res.done;
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers['Content-Type'], 'text/plain; charset=utf-8');
    assert.match(res.body, /nie znaleziono/);
  } finally {
    rmSync(pusty, { recursive: true, force: true });
  }
});
