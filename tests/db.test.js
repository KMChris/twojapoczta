// Jednostkowe testy warstwy bazy: otwarcie na dysku, migracja kolumn, now().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, openMemoryDb, now } from '../server/db.js';

test('openDb tworzy plik bazy, schemat i migruje kolumnę attachments_count', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tp-db-'));
  try {
    const db = openDb(dir);
    assert.ok(existsSync(path.join(dir, 'twojapoczta.db')));
    // migracja dołożyła attachments_count do messages
    const kolumny = db.prepare('PRAGMA table_info(messages)').all().map((k) => k.name);
    assert.ok(kolumny.includes('attachments_count'));
    db.close();

    // ponowne otwarcie: kolumna już istnieje → ensureColumn pomija ALTER
    const db2 = openDb(dir);
    assert.ok(db2.prepare('PRAGMA table_info(messages)').all().some((k) => k.name === 'attachments_count'));
    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('openMemoryDb ma komplet tabel', () => {
  const db = openMemoryDb();
  const tabele = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const t of ['users', 'sessions', 'messages', 'aliases', 'blobs', 'attachments', 'uploads']) {
    assert.ok(tabele.includes(t), `brak tabeli ${t}`);
  }
  db.close();
});

test('schemat ma kolumny panelu administratora i tabele settings/audit_log', () => {
  const db = openMemoryDb();
  const users = db.prepare('PRAGMA table_info(users)').all().map((k) => k.name);
  for (const k of ['is_admin', 'is_blocked', 'quota_mb', 'last_login_at', 'alias_limit']) {
    assert.ok(users.includes(k), `brak kolumny users.${k}`);
  }
  const tabele = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const t of ['settings', 'audit_log']) assert.ok(tabele.includes(t), `brak tabeli ${t}`);
  db.close();
});

test('migracja dokłada kolumny panelu do istniejącej bazy na dysku', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tp-db-'));
  try {
    openDb(dir).close();
    const db = openDb(dir);
    const users = db.prepare('PRAGMA table_info(users)').all();
    assert.ok(users.some((k) => k.name === 'is_admin'));
    // Konta sprzed migracji mają zachować dotychczasowy limit 5, nie „bez limitu".
    assert.equal(users.find((k) => k.name === 'alias_limit').dflt_value, '5');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('now() zwraca znacznik ISO 8601', () => {
  assert.match(now(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
