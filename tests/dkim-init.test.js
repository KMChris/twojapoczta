// Jednostkowe testy inicjalizacji DKIM: generowanie/wczytywanie klucza z dysku,
// stan konfiguracji i błąd przy braku konfiguracji. Klucz w katalogu tymczasowym.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDkim, configureDkim, dkimConfigured, dnsRecord, signMessage } from '../server/dkim.js';

test('bez konfiguracji: dkimConfigured=false, dnsRecord rzuca', () => {
  configureDkim(null);
  assert.equal(dkimConfigured(), false);
  assert.throws(() => dnsRecord(), /nie jest skonfigurowany/);
});

test('initDkim generuje klucz przy pierwszym starcie i wczytuje przy drugim', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tp-dkim-'));
  try {
    const pierwszy = initDkim(dir, { domain: 'twojapoczta.com', selector: 'tp1' });
    assert.equal(pierwszy.wygenerowano, true);
    assert.ok(existsSync(pierwszy.plik));
    assert.equal(pierwszy.selector, 'tp1');
    assert.equal(dkimConfigured(), true);

    const drugi = initDkim(dir, { domain: 'twojapoczta.com', selector: 'tp1' });
    assert.equal(drugi.wygenerowano, false, 'drugi start wczytuje istniejący klucz');

    const rekord = dnsRecord();
    assert.equal(rekord.nazwa, 'tp1._domainkey.twojapoczta.com');
    assert.match(rekord.wartosc, /^v=DKIM1; k=rsa; p=[A-Za-z0-9+/]+=*$/);
  } finally {
    configureDkim(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signMessage podpisuje wiadomość ze zwiniętym (folded) nagłówkiem', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  try {
    configureDkim({ privateKey, selector: 'tp1', domain: 'twojapoczta.com' });
    // Subject złamany na dwie linie: zbierzNaglowki musi skleić kontynuację.
    const raw = [
      'From: Jan <jan@twojapoczta.com>',
      'To: ktos@example.com',
      'Subject: Bardzo dlugi temat ktory',
      '  zostal zwiniety na dwie linie',
      'Date: Mon, 01 Jan 2026 10:00:00 +0000',
      'Message-ID: <abc@twojapoczta.com>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'tresc',
    ].join('\r\n');
    const podpisany = signMessage(raw);
    assert.ok(podpisany.startsWith('DKIM-Signature:'));
    assert.match(podpisany, /h=from:to:subject/);
  } finally {
    configureDkim(null);
  }
});

test('TP_DKIM_SELECTOR ustawia domyślny selektor', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tp-dkim-'));
  process.env.TP_DKIM_SELECTOR = 'wybrany';
  try {
    const cfg = initDkim(dir, { domain: 'przyklad.pl' });
    assert.equal(cfg.selector, 'wybrany');
    assert.ok(existsSync(path.join(dir, 'dkim', 'wybrany.pem')));
    assert.equal(dnsRecord().nazwa, 'wybrany._domainkey.przyklad.pl');
  } finally {
    delete process.env.TP_DKIM_SELECTOR;
    configureDkim(null);
    rmSync(dir, { recursive: true, force: true });
  }
});
