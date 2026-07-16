// Logika panelu administratora: uprawnienia, przegląd kont, statystyki instancji.

export function grantAdmin(db, login) {
  const result = db
    .prepare('UPDATE users SET is_admin = 1 WHERE login = ?')
    .run(String(login ?? '').trim().toLowerCase());
  return result.changes > 0;
}
