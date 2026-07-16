// Limity aliasów per konto. NULL w users.alias_limit = bez limitu (jak quota_mb),
// 0 = aliasy wyłączone. Domyślną piątkę nadaje schemat bazy.

export const DEFAULT_ALIAS_LIMIT = 5;
// Wentyl na literówki w panelu, nie limit produktu.
export const MAX_ALIAS_LIMIT = 100;

export function aliasLimit(db, userId) {
  const row = db.prepare('SELECT alias_limit FROM users WHERE id = ?').get(userId);
  return row?.alias_limit ?? null;
}

export function aliasCount(db, userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM aliases WHERE user_id = ?').get(userId).n;
}

// Polska odmiana liczebnika: 1 alias, 2–4 aliasy, 5+ aliasów (nastolatki wyjątkiem).
export function aliasesWord(n) {
  if (n === 1) return 'alias';
  const dziesiatki = n % 100;
  const jednosci = n % 10;
  if (jednosci >= 2 && jednosci <= 4 && !(dziesiatki >= 12 && dziesiatki <= 14)) return 'aliasy';
  return 'aliasów';
}
