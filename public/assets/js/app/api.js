// Cienka warstwa nad API. Błędy niosą komunikat z serwera (po polsku).

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
  zapiszProfil: (dane) => zadanie('PATCH', '/api/me', dane),
  wyloguj: () => zadanie('POST', '/api/logout'),
  lista: (folder, q) =>
    zadanie('GET', `/api/messages?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(q ?? '')}`),
  wiadomosc: (id) => zadanie('GET', `/api/messages/${id}`),
  wyslij: (dane) => zadanie('POST', '/api/messages', dane),
  zmien: (id, dane) => zadanie('PATCH', `/api/messages/${id}`, dane),
  usun: (id) => zadanie('DELETE', `/api/messages/${id}`),
  liczniki: () => zadanie('GET', '/api/counts'),
};
