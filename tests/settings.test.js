// Jednostkowe testy ustawień instancji: klucz-wartość w DB z fallbackiem do env.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../server/db.js';
import {
  getSetting, setSetting, registrationOpen, passwordMinLength, catchallLogin,
} from '../server/settings.js';

test('setSetting/getSetting: zapis, odczyt i kasowanie wpisu', () => {
  const db = openMemoryDb();
  assert.equal(getSetting(db, 'proba'), null);
  setSetting(db, 'proba', '42');
  assert.equal(getSetting(db, 'proba'), '42');
  setSetting(db, 'proba', 'inna');
  assert.equal(getSetting(db, 'proba'), 'inna');
  setSetting(db, 'proba', null); // null = wróć do domyślnych (fallback env)
  assert.equal(getSetting(db, 'proba'), null);
  db.close();
});

test('registrationOpen: wpis w DB wygrywa ze zmienną środowiskową', () => {
  const db = openMemoryDb();
  const przed = process.env.TP_REGISTER;
  try {
    delete process.env.TP_REGISTER;
    assert.equal(registrationOpen(db), true, 'domyślnie otwarta');

    process.env.TP_REGISTER = '0';
    assert.equal(registrationOpen(db), false, 'env zamyka');

    setSetting(db, 'registration', '1');
    assert.equal(registrationOpen(db), true, 'DB nadpisuje env');

    setSetting(db, 'registration', '0');
    delete process.env.TP_REGISTER;
    assert.equal(registrationOpen(db), false, 'DB zamyka mimo otwartego env');
  } finally {
    if (przed === undefined) delete process.env.TP_REGISTER;
    else process.env.TP_REGISTER = przed;
    db.close();
  }
});

test('passwordMinLength: domyślnie 8, wpis w DB zmienia, śmieci ignorowane', () => {
  const db = openMemoryDb();
  assert.equal(passwordMinLength(db), 8);
  setSetting(db, 'password_min', '12');
  assert.equal(passwordMinLength(db), 12);
  setSetting(db, 'password_min', 'byle-co');
  assert.equal(passwordMinLength(db), 8);
  db.close();
});

test('catchallLogin: domyślnie brak, ustawiony zwraca login', () => {
  const db = openMemoryDb();
  assert.equal(catchallLogin(db), null);
  setSetting(db, 'catchall', 'biuro');
  assert.equal(catchallLogin(db), 'biuro');
  setSetting(db, 'catchall', null);
  assert.equal(catchallLogin(db), null);
  db.close();
});
