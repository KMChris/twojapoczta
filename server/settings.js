// Ustawienia instancji: klucz-wartość w DB dla decyzji produktowych administratora.
// Brak wpisu = fallback do env/domyślnych; infrastruktura (porty, domena) zostaje w env.

export const DEFAULT_PASSWORD_MIN = 8;

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

// value=null kasuje wpis (powrót do zachowania domyślnego).
export function setSetting(db, key, value) {
  if (value === null || value === undefined) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    return;
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function registrationOpen(db) {
  const wpis = getSetting(db, 'registration');
  if (wpis !== null) return wpis === '1';
  return process.env.TP_REGISTER !== '0';
}

export function passwordMinLength(db) {
  const wpis = Number.parseInt(getSetting(db, 'password_min') ?? '', 10);
  if (!Number.isInteger(wpis) || wpis < 4 || wpis > 128) return DEFAULT_PASSWORD_MIN;
  return wpis;
}

export function catchallLogin(db) {
  return getSetting(db, 'catchall') || null;
}
