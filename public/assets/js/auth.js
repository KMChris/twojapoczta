// Logowanie i rejestracja: wysyłka formularzy, tryb demo, podgląd adresu.

const formularz = document.querySelector('[data-formularz]');
const tryb = formularz?.dataset.formularz;
const blad = document.querySelector('[data-blad]');
const przycisk = document.querySelector('[data-wyslij]');

// Zalogowany? Prosto do skrzynki.
fetch('/api/me').then((r) => {
  if (r.ok) location.replace('/app');
});

// Tryb demo: wypełnij pola i pokaż notkę.
const parametry = new URLSearchParams(location.search);
if (tryb === 'logowanie' && parametry.get('demo') === '1') {
  formularz.login.value = 'demo';
  formularz.haslo.value = 'demo1234';
  document.querySelector('[data-demo-notka]').hidden = false;
}

// Podgląd pełnego adresu przy rejestracji.
const podglad = document.querySelector('[data-podglad-adresu]');
if (podglad) {
  const domyslny = podglad.textContent;
  formularz.login.addEventListener('input', () => {
    const login = formularz.login.value.trim().toLowerCase();
    podglad.replaceChildren();
    if (!login) {
      podglad.textContent = domyslny;
      return;
    }
    podglad.append('Twój adres: ');
    const b = document.createElement('b');
    b.textContent = `${login}@twojapoczta.com`;
    podglad.append(b);
  });
}

function pokazBlad(tekst) {
  blad.textContent = tekst;
  blad.hidden = false;
}

formularz?.addEventListener('submit', async (e) => {
  e.preventDefault();
  blad.hidden = true;
  przycisk.disabled = true;
  const bylo = przycisk.textContent;
  przycisk.textContent = tryb === 'logowanie' ? 'Logowanie…' : 'Zakładanie konta…';

  const dane =
    tryb === 'logowanie'
      ? { login: formularz.login.value.trim(), password: formularz.haslo.value }
      : {
          login: formularz.login.value.trim(),
          name: formularz.imie.value.trim(),
          password: formularz.haslo.value,
        };

  try {
    const odpowiedz = await fetch(tryb === 'logowanie' ? '/api/login' : '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dane),
    });
    const wynik = await odpowiedz.json();
    if (!odpowiedz.ok) {
      pokazBlad(wynik.error ?? 'Nie udało się. Spróbuj jeszcze raz.');
      return;
    }
    location.href = '/app';
  } catch {
    pokazBlad('Brak połączenia z serwerem. Sprawdź sieć i spróbuj ponownie.');
  } finally {
    przycisk.disabled = false;
    przycisk.textContent = bylo;
  }
});
