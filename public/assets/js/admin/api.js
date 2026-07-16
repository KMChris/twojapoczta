// Cienka warstwa nad /api/admin/*. Błędy niosą komunikat serwera po polsku.

async function zadanie(metoda, sciezka, dane) {
  const odpowiedz = await fetch(sciezka, {
    method: metoda,
    headers: dane ? { 'Content-Type': 'application/json' } : undefined,
    body: dane ? JSON.stringify(dane) : undefined,
  });

  if (odpowiedz.status === 401) {
    location.replace('/logowanie');
    throw new Error('Sesja wygasła.');
  }

  const wynik = await odpowiedz.json().catch(() => ({}));
  if (!odpowiedz.ok) {
    throw new Error(wynik.error ?? 'Nie udało się. Spróbuj jeszcze raz.');
  }
  return wynik;
}

export const api = {
  ja: () => zadanie('GET', '/api/me'),
  wyloguj: () => zadanie('POST', '/api/logout'),

  statystyki: () => zadanie('GET', '/api/admin/stats'),

  uzytkownicy: () => zadanie('GET', '/api/admin/users'),
  dodajKonto: (dane) => zadanie('POST', '/api/admin/users', dane),
  zmienKonto: (id, dane) => zadanie('PATCH', `/api/admin/users/${id}`, dane),
  usunKonto: (id) => zadanie('DELETE', `/api/admin/users/${id}`),
  ustawHaslo: (id, password) => zadanie('POST', `/api/admin/users/${id}/password`, { password }),
  wylogujKonto: (id) => zadanie('POST', `/api/admin/users/${id}/logout`, {}),
  dodajAlias: (id, alias) => zadanie('POST', `/api/admin/users/${id}/aliases`, { alias }),
  usunAlias: (id, aliasId) => zadanie('DELETE', `/api/admin/users/${id}/aliases/${aliasId}`),

  ustawienia: () => zadanie('GET', '/api/admin/settings'),
  zapiszUstawienia: (dane) => zadanie('PATCH', '/api/admin/settings', dane),
  broadcast: (dane) => zadanie('POST', '/api/admin/broadcast', dane),

  dziennik: (action) =>
    zadanie('GET', `/api/admin/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`),

  dkim: () => zadanie('GET', '/api/admin/dkim'),
  generujDkim: (selector) => zadanie('POST', '/api/admin/dkim', selector ? { selector } : {}),
  sprawdzDns: () => zadanie('POST', '/api/admin/dns-check', {}),
};
