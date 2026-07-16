// Testy złożenia aplikacji (createApp) i trybów CLI `--dkim` oraz `--admin`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/index.js';
import { openDb, openMemoryDb } from '../server/db.js';

const execFileP = promisify(execFile);
const indexPath = fileURLToPath(new URL('../server/index.js', import.meta.url));

let server;
let base;

before(async () => {
  const app = await createApp({ db: openMemoryDb() });
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('serwuje stronę główną z nagłówkami bezpieczeństwa', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.headers.get('referrer-policy'));
});

test('publiczny endpoint /api/config działa bez logowania', async () => {
  const res = await fetch(`${base}/api/config`);
  assert.equal(res.status, 200);
  const dane = await res.json();
  assert.equal(dane.domain, 'twojapoczta.com');
});

test('nieznana trasa API → 404 JSON', async () => {
  const res = await fetch(`${base}/api/cokolwiek`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type'), /json/);
});

test('chroniona trasa bez sesji → 401', async () => {
  const res = await fetch(`${base}/api/messages`);
  assert.equal(res.status, 401);
});

test('błąd (zły JSON) zwraca kod < 500 bez wycieku szczegółów', async () => {
  const res = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ nie-json',
  });
  assert.equal(res.status, 400);
});

test('createApp z TP_EXTERNAL=1 i katalogiem danych inicjuje DKIM', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tp-app-dkim-'));
  process.env.TP_EXTERNAL = '1';
  try {
    const app = await createApp({ dataDir: dir });
    assert.ok(existsSync(path.join(dir, 'dkim', 'tp1.pem')), 'klucz DKIM powstał na dysku');
    app.db.close();
  } finally {
    delete process.env.TP_EXTERNAL;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI `--dkim` generuje klucz i wypisuje rekord DNS', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tp-cli-dkim-'));
  try {
    const { stdout } = await execFileP(process.execPath, [indexPath, '--dkim'], {
      env: { ...process.env, TP_DATA_DIR: dir },
    });
    assert.match(stdout, /v=DKIM1; k=rsa; p=/);
    assert.match(stdout, /_domainkey\.twojapoczta\.com/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI `--admin` nadaje rolę kontu z bazy we wskazanym katalogu', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tp-cli-admin-'));
  try {
    const db = openDb(dir);
    db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
      'szef',
      'Szef',
      'x',
      new Date().toISOString()
    );
    db.close();

    const { stdout } = await execFileP(process.execPath, [indexPath, '--admin', 'szef'], {
      env: { ...process.env, TP_DATA_DIR: dir },
    });
    assert.match(stdout, /szef/);

    const po = openDb(dir);
    const rola = po.prepare('SELECT is_admin FROM users WHERE login = ?').get('szef').is_admin;
    po.close();
    assert.equal(rola, 1, 'konto ma rolę administratora w bazie');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Bez TP_DATA_DIR (a na produkcji zmienna siedzi tylko w unicie systemd)
// polecenie celowało w katalog obok kodu, zakładało tam pustą bazę i mówiło
// „nie znaleziono konta" o koncie, które istnieje gdzie indziej.
test('CLI `--admin` odmawia i nie zakłada bazy, gdy katalog danych jest pusty', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tp-cli-admin-pusty-'));
  try {
    const blad = await execFileP(process.execPath, [indexPath, '--admin', 'szef'], {
      env: { ...process.env, TP_DATA_DIR: dir },
    }).then(
      () => null,
      (e) => e
    );

    assert.ok(blad, 'polecenie kończy się błędem, a nie sukcesem');
    assert.equal(blad.code, 1);
    assert.match(blad.stderr, /TP_DATA_DIR/, 'podpowiada, czym wskazać katalog danych');
    assert.ok(
      !existsSync(path.join(dir, 'twojapoczta.db')),
      'nie zakłada pustej bazy w źle wskazanym katalogu'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
