# Konfiguracja

Cała konfiguracja odbywa się zmiennymi środowiskowymi, nie ma pliku
konfiguracyjnego. W systemd ustawia się je liniami `Environment=`.

## Zmienne środowiskowe

### Serwer WWW

| Zmienna     | Domyślnie   | Opis |
| ----------- | ----------- | ---- |
| `PORT`      | `3000`      | Port HTTP aplikacji. |
| `HOST`      | `127.0.0.1` | Adres nasłuchu. Za reverse proxy zostaw domyślny; aplikacja nie powinna być wystawiona bezpośrednio do internetu. |
| `TP_SECURE` | brak        | `1` wymusza flagę `Secure` na ciasteczku sesji. Zwykle niepotrzebne: flaga włącza się sama, gdy proxy przekazuje `X-Forwarded-Proto: https` (Caddy robi to automatycznie). |

### Dane i domena

| Zmienna       | Domyślnie         | Opis |
| ------------- | ----------------- | ---- |
| `TP_DOMAIN`   | `twojapoczta.com` | Domena adresów e-mail (część po `@`). Interfejs pobiera ją z serwera, więc w plikach frontendu nie trzeba nic zmieniać. |
| `TP_DATA_DIR` | `./data`          | Katalog danych: baza `twojapoczta.db` (+ pliki WAL) i podkatalog `dkim/` z kluczem prywatnym. |
| `TP_SEED`     | brak (włączony)   | `0` wyłącza tworzenie kont demonstracyjnych przy pierwszym starcie z pustą bazą. **Na produkcji zawsze `0`**: seed zakłada konto `demo` z publicznie znanym hasłem. |
| `TP_REGISTER` | brak (otwarta)    | `0` zamyka rejestrację: `POST /api/register` zwraca 403, formularz pokazuje komunikat. Istniejące konta logują się normalnie. |

### Bramka SMTP

| Zmienna            | Domyślnie            | Opis |
| ------------------ | -------------------- | ---- |
| `TP_SMTP_PORT`     | brak (wyłączona)        | Port przychodzącego SMTP. Produkcyjnie `25`; do testów dowolny (np. `2525`). Bez tej zmiennej serwer SMTP w ogóle nie startuje. |
| `TP_SMTP_HOST`     | `0.0.0.0`               | Adres nasłuchu SMTP. |
| `TP_SMTP_HOSTNAME` | `mx.{TP_DOMAIN}`        | Nazwa, którą serwer przedstawia się w powitaniu `220` i którą klient wychodzący podaje w `EHLO`. Powinna mieć rekord A i zgadzać się z PTR. |
| `TP_EXTERNAL`      | brak (wyłączona)        | `1` pozwala wysyłać do adresów poza `TP_DOMAIN`. Przy pierwszym starcie generuje też klucz DKIM. Bez flagi próba wysyłki na zewnątrz kończy się czytelnym błędem w kompozycji. |
| `TP_SMTP_ROUTE`    | brak (bezpośrednio MX)  | Smarthost `host[:port]`: cała poczta wychodząca idzie przez wskazany przekaźnik zamiast do MX odbiorców. Ratunek przy zablokowanym porcie 25 i przy problemach z reputacją IP. |
| `TP_TLS_VERIFY`    | brak (oportunistycznie) | `1` wymusza walidację certyfikatu serwera odbiorcy przy STARTTLS (fail-closed: nieufny certyfikat = brak doręczenia + odbicie). Domyślnie TLS oportunistyczny, jak w typowych MTA. |
| `TP_DKIM_SELECTOR` | `tp1`                   | Selektor DKIM, czyli nazwa rekordu TXT (`{selektor}._domainkey.{domena}`) i pliku klucza (`dkim/{selektor}.pem`). Zmiana selektora = nowy klucz i nowy rekord. |

## Typowe zestawy

**Tylko webmail wewnętrzny** (zespół/rodzina, bez poczty ze świata):

```ini
Environment=TP_DOMAIN=twojadomena.pl
Environment=TP_DATA_DIR=/var/lib/twojapoczta
Environment=TP_SEED=0
```

**Odbiór ze świata, bez wysyłki na zewnątrz:**

```ini
# jak wyżej, plus:
Environment=TP_SMTP_PORT=25
Environment=TP_SMTP_HOSTNAME=mx.twojadomena.pl
```

**Pełna poczta (odbiór + wysyłka + DKIM):**

```ini
# jak wyżej, plus:
Environment=TP_EXTERNAL=1
```

**Wysyłka przez smarthost** (zablokowany port 25 albo słaba reputacja IP):

```ini
Environment=TP_EXTERNAL=1
Environment=TP_SMTP_ROUTE=smtp.twoj-hosting.pl:25
```

## Rekordy DNS: ściąga

| Typ | Nazwa                           | Wartość                         |
| --- | ------------------------------- | ------------------------------- |
| A   | `twojadomena.pl`                | IP serwera                      |
| A   | `mx.twojadomena.pl`             | IP serwera                      |
| MX  | `twojadomena.pl`                | `10 mx.twojadomena.pl`          |
| TXT | `twojadomena.pl`                | `v=spf1 a mx -all`              |
| TXT | `tp1._domainkey.twojadomena.pl` | wydruk z `npm run dkim`         |
| PTR | (panel dostawcy VPS)            | `mx.twojadomena.pl`             |

> `npm run dkim` bez zmiennych czyta domyślne `./data` i `twojapoczta.com`.
> Na produkcji uruchom je z tym samym `TP_DOMAIN` i `TP_DATA_DIR`, co usługa.
> Pełne polecenie znajdziesz w [samouczku wdrożenia](wdrozenie.md) (krok 8).

## Limity aplikacji

| Co | Limit |
| -- | ----- |
| Treść żądania JSON | 512 KB |
| Załącznik | 5 MB / plik, 10 plików na wiadomość |
| Wiadomość przychodząca SMTP | 10 MB, 50 adresatów |
| Login / alias | 3–30 znaków: `a-z`, `0-9`, `.`, `-` (start od litery lub cyfry) |
| Aliasy | 5 na konto |
| Hasło | min. 8 znaków |
| Temat | 200 znaków |
| Podpis | 500 znaków |
| Sesja | 30 dni |
| Logowanie | 5 nieudanych prób / 15 min (na parę IP+login) |
| Token uploadu załącznika | jednorazowy, ważny 24 h |

## Struktura katalogu danych

```
/var/lib/twojapoczta/
├── twojapoczta.db        # cała poczta: konta, wiadomości, załączniki, sesje
├── twojapoczta.db-wal    # dziennik WAL (SQLite zarządza sam)
├── twojapoczta.db-shm
└── dkim/
    └── tp1.pem           # klucz prywatny DKIM: chroń i rób kopie
```
