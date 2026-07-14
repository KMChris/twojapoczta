# Architektura

Dokument dla osób, które chcą zrozumieć albo rozwijać kod. Prowadząca zasada
całego projektu: **zero zależności w runtime**. Wszystko stoi na modułach
wbudowanych w Node 24 (`node:http`, `node:sqlite`, `node:crypto`, `node:net`,
`node:tls`, `node:dns`, `node:test`). Frontend to statyczne moduły ES bez kroku
budowania. `node server/index.js` to całe wdrożenie.

## Rzut oka

```
                      ┌─────────────────────────────────────┐
   przeglądarka  ──►  │  node:http  (server/index.js)        │
   (public/*)         │    ├─ /api/*  → router → api.js      │
                      │    └─ /*      → static.js → public/  │
                      └───────────────┬─────────────────────┘
                                      │
   obcy serwer   ──►  ┌───────────────┴──────────┐
   pocztowy :25       │  node:net  (smtp.js)     │
                      │    └─ mime.js → mail.js   │
                      └───────────────┬──────────┘
                                      ▼
                          node:sqlite (db.js)  ── data/twojapoczta.db
                                      ▲
   wysyłka na       ┌────────────────┴──────────────┐
   zewnątrz    ◄──  │ smtp-out.js (MX, STARTTLS)     │
                    │   └─ dkim.js (podpis)          │
                    └───────────────────────────────┘
```

## Backend (`server/`)

| Plik            | Odpowiedzialność |
| --------------- | ---------------- |
| `index.js`      | Punkt wejścia. Składa aplikację (`createApp`), nakłada nagłówki bezpieczeństwa (CSP, `X-Content-Type-Options`…), rozdziela ruch `/api/*` od statyki, startuje serwer HTTP i opcjonalnie SMTP. Obsługuje też `--dkim`. |
| `router.js`     | Mini-router: dopasowanie metody i ścieżki ze wzorcami `:param`. Bez zależności. |
| `static.js`     | Bezpieczne serwowanie `public/`: ochrona przed path traversal, czyste adresy (`/logowanie` → `logowanie.html`), typy MIME, `Cache-Control`, `Last-Modified`/`304`. |
| `db.js`         | Schemat SQLite i połączenie (WAL, `foreign_keys=ON`). Lekkie migracje przez `ensureColumn`. `openDb` (plik) i `openMemoryDb` (testy). |
| `auth.js`       | scrypt + sól, `timingSafeEqual`, sesje w cookie `httpOnly`/`SameSite=Lax`, limit prób logowania (5 / 15 min na parę IP+login). |
| `mail.js`       | Logika domenowa: foldery, doręczanie wewnętrzne, wyszukiwanie, szkice, cykl życia wiadomości, doręczanie przychodzące (`deliverInbound`) i zlecanie wysyłki na zewnątrz. |
| `api.js`        | Handlery HTTP: walidacja wejścia, strażnik sesji, warstwa JSON, odczyt ciała z limitami. |
| `seed.js`       | Konta i wiadomości demonstracyjne (pomijane przy `TP_SEED=0`), treść listu powitalnego. |
| `attachments.js`| Załączniki: bloby adresowane sha256 (deduplikacja treści), tokeny uploadu (jednorazowe, 24 h), odśmiecanie osieroconych blobów. |
| `mime.js`       | Parser RFC 822/MIME poczty przychodzącej: encoded-words, quoted-printable, base64, multipart rekurencyjnie, `filename*`, polskie strony kodowe, HTML→tekst awaryjnie. |
| `smtp.js`       | Przychodzący SMTP na `node:net`: EHLO/MAIL/RCPT/DATA, dot-stuffing, limity, twarda ochrona przed relayem. |
| `smtp-out.js`   | Wychodzący SMTP: budowanie MIME, lookup MX, oportunistyczny STARTTLS, smarthost, kolejkowanie per domena. |
| `dkim.js`       | Podpisy DKIM (rsa-sha256, relaxed/relaxed), generowanie i przechowywanie klucza, rekord DNS. |

## Model danych

Jeden plik SQLite. Kluczowa decyzja: **kopia wiadomości per skrzynka**
(model zbliżony do Maildira). Wysyłka tworzy osobny wiersz w `messages`
u nadawcy (folder `sent`) i u każdego odbiorcy (`inbox`). Upraszcza to foldery,
liczniki i usuwanie: każdy operuje wyłącznie na własnych wierszach.

```
users(id, login·UNIQUE, name, password_hash, signature, theme, created_at)
sessions(id, user_id→users, expires_at, created_at)
messages(id, owner_id→users, folder, from_name, from_addr, to_addr,
         subject, body, snippet, is_read, is_starred, is_priority,
         attachments_count, sent_at)
aliases(id, user_id→users, alias·UNIQUE, created_at)
blobs(hash·PK, data·BLOB, size)
attachments(id, message_id→messages, filename, mime, size, blob_hash→blobs)
uploads(token·PK, user_id→users, filename, mime, size, blob_hash, created_at)
```

Treści załączników leżą raz w `blobs` (klucz = sha256 zawartości); wiele
kopii wiadomości i wielu adresatów współdzieli te same bajty. Gdy ostatni
wiersz `attachments`/`uploads` wskazujący na blob znika, `gcBlobs` sprząta
osieroconą treść.

## Cykl życia wiadomości

**Wysyłka wewnętrzna** (`sendMessage`): walidacja adresów → rozwiązanie
skrzynek i aliasów (`findMailbox`) → jedna transakcja SQLite tworzy kopię
`sent` i kopie `inbox`, po czym `bindUploads` przypina załączniki i zużywa
tokeny. Adresat spoza domeny (przy `TP_EXTERNAL=1`) trafia do `dispatchExternal`.

**Wysyłka na zewnątrz** (`dispatchExternal`): dzieje się **po** odpowiedzi HTTP
(`setImmediate`), więc interfejs nie czeka na obcy serwer. `buildRawMessage`
składa MIME, `signMessage` dokleja podpis DKIM, `deliverExternal` grupuje
adresatów per domena i próbuje ich MX-ów (albo smarthosta). Porażka wraca do
nadawcy jako priorytetowy „Zwrot do nadawcy" (`deliverBounce`).

**Odbiór** (`smtp.js` → `parseMessage` → `deliverInbound`): serwer przyjmuje
`DATA` tylko dla lokalnych skrzynek, parser rozkłada MIME, a doręczenie w jednej
transakcji tworzy wiersz `inbox` i zapisuje załączniki (`storeAttachment`).

## Frontend (`public/`)

Bez frameworka i bez budowania. Trzy strony (strona główna `index.html`,
`logowanie`/`rejestracja`, webmail `app.html`) plus `404.html`.

- `assets/css/`: `tokens.css` (zmienne systemu „Datownik", motywy), `fonts.css`
  (własne woff2), oraz style per strona (`landing`, `auth`, `app`).
- `assets/js/auth.js`: logowanie/rejestracja, tryb demo, dynamiczny sufiks domeny.
- `assets/js/app/`: webmail rozbity na moduły:
  - `api.js`: cienka warstwa nad REST-em (błędy niosą komunikat serwera po polsku),
  - `ui.js`: narzędzia DOM, formatowanie czasu/rozmiaru po polsku, awatary, toasty,
    bezpieczne wstawianie treści z linkami (zero `innerHTML` dla danych),
  - `kompozycja.js`: okno pisania, autozapis szkiców, upload załączników, stempel,
  - `skroty.js`: skróty klawiszowe i paleta poleceń,
  - `main.js`: rdzeń, czyli stan, foldery, lista, czytnik, ustawienia i spinanie całości.

Interfejs jest po polsku; sufiks domeny pobiera z `GET /api/config`, więc
instalacja pod własną domeną nie wymaga dotykania plików frontendu.

## API HTTP

Wszystko pod `/api`, format JSON. Poza `config`/`register`/`login`/`logout`
każdy endpoint wymaga sesji.

| Metoda i ścieżka                         | Rola |
| ---------------------------------------- | ---- |
| `GET /api/config`                        | domena i czy rejestracja otwarta (publiczne) |
| `POST /api/register` · `login` · `logout`| konto i sesja |
| `GET` / `PATCH /api/me`                  | profil (imię, podpis, motyw) |
| `GET /api/messages?folder=&q=`           | lista + liczniki |
| `GET /api/messages/:id`                  | treść (oznacza przeczytane) + załączniki |
| `POST /api/messages`                     | wyślij lub zapisz szkic |
| `PATCH /api/messages/:id`                | `is_read` / `is_starred` / `folder` |
| `DELETE /api/messages/:id`               | do kosza, a z kosza trwale |
| `GET /api/counts`                        | nieprzeczytane per folder |
| `GET` / `POST /api/aliases` · `DELETE …/:id` | aliasy |
| `POST /api/uploads`                      | wgraj załącznik (surowe ciało + nagłówki) |
| `GET /api/messages/:id/attachments/:aid` | pobierz załącznik |

## Bezpieczeństwo

- Hasła: scrypt z solą, porównanie w czasie stałym.
- Sesje: cookie `httpOnly`, `SameSite=Lax`, `Secure` za HTTPS; leniwe sprzątanie wygasłych.
- Nagłówki: CSP `script-src 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- Treść wiadomości renderowana wyłącznie jako tekst (klikalne linki budowane
  z węzłów DOM, bez `innerHTML` dla danych użytkownika).
- SMTP przychodzący nie przyjmuje relayu; wychodzący domyślnie wyłączony.
- Niebezpieczne typy załączników (`text/html`, `image/svg+xml`…) serwowane
  jako `application/octet-stream` z `Content-Disposition: attachment`.
- Limity rozmiaru na każdym wejściu (ciało JSON, upload, wiadomość SMTP).

## Testy

`npm test` uruchamia 212 testów na `node:test` (baza w pamięci, zero
instalacji); `npm run test:coverage` dolicza raport pokrycia linii i gałęzi.

- Scenariusze przekrojowe: `tests/api.test.js` (pełen obieg REST: konta,
  foldery, doręczanie, aliasy, załączniki, przełączniki produkcyjne)
  i `tests/smtp.test.js` (parser MIME, serwer przychodzący, pętla out→in,
  odbicia, ochrona przed relayem).
- Testy jednostkowe per moduł: `auth`, `mail`, `mime`, `attachments`,
  `router`, `static`, `db`, `smtp-in`, `smtp-out`, `dkim-init`, `api.extra`,
  `index`. Każdy test dostaje świeżą bazę w pamięci, więc nic nie współdzieli
  z pozostałymi.
- `tests/dkim.test.js`: wektory kanonizacji z RFC 6376 i **niezależny
  weryfikator** sprawdzający podpis na wyemitowanych, pofoldowanych bajtach.

## Zasady, których warto się trzymać

- **Nie dodawaj zależności runtime.** Jeśli czegoś brakuje w standardowej
  bibliotece Node, najpierw rozważ, czy naprawdę jest potrzebne.
- **Dane użytkownika to tekst, nie HTML.** Buduj DOM z węzłów.
- **Każde wejście ma limit.** Nowy endpoint = jawny limit rozmiaru i walidacja.
- **Interfejs po polsku, komunikaty błędów też.** Pisane z perspektywy
  użytkownika, nie systemu.
- **Commity: krótki komunikat po angielsku** (konwencja checkpointów projektu).
