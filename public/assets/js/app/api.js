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
  lista: (folder, q, folderId = null) =>
    zadanie(
      'GET',
      `/api/messages?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(q ?? '')}` +
        (folderId ? `&folderId=${folderId}` : '')
    ),
  szukaj: (kryteria) => {
    const parametry = new URLSearchParams();
    for (const [klucz, wartosc] of Object.entries(kryteria)) parametry.set(klucz, wartosc);
    return zadanie('GET', `/api/messages?${parametry}`);
  },
  wiadomosc: (id) => zadanie('GET', `/api/messages/${id}`),
  wyslij: (dane) => zadanie('POST', '/api/messages', dane),
  zmien: (id, dane) => zadanie('PATCH', `/api/messages/${id}`, dane),
  usun: (id) => zadanie('DELETE', `/api/messages/${id}`),
  liczniki: () => zadanie('GET', '/api/counts'),
  foldery: () => zadanie('GET', '/api/folders'),
  dodajFolder: (name) => zadanie('POST', '/api/folders', { name }),
  zmienNazweFolderu: (id, name) => zadanie('PATCH', `/api/folders/${id}`, { name }),
  usunFolder: (id) => zadanie('DELETE', `/api/folders/${id}`),
  aliasy: () => zadanie('GET', '/api/aliases'),
  dodajAlias: (alias) => zadanie('POST', '/api/aliases', { alias }),
  usunAlias: (id) => zadanie('DELETE', `/api/aliases/${id}`),
  zespoly: () => zadanie('GET', '/api/teams'),
  przekierowanie: () => zadanie('GET', '/api/forwarding'),
  ustawPrzekierowanie: (dane) => zadanie('PUT', '/api/forwarding', dane),
  uploadPlik: async (plik) => {
    const odpowiedz = await fetch('/api/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': plik.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(plik.name),
      },
      body: plik,
    });
    if (odpowiedz.status === 401) {
      location.replace('/logowanie');
      throw new Error('Sesja wygasła.');
    }
    const dane = await odpowiedz.json().catch(() => ({}));
    if (!odpowiedz.ok) throw new Error(dane.error ?? 'Nie udało się wysłać załącznika.');
    return dane.upload;
  },
};
