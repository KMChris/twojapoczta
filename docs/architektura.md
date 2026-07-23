# Architektura

Dokument dla osób, które chcą zrozumieć albo rozwijać kod. Prowadząca zasada
całego projektu: **zero zależności w runtime**. Wszystko stoi na modułach
wbudowanych w Node 24 (`node:http`, `node:sqlite`, `node:crypto`, `node:net`,
`node:tls`, `node:dns`, `node:test`). Frontend to statyczne moduły ES bez kroku
budowania. `node server/index.js` to całe wdrożenie.

## Rzut oka

```
                      ┌─────────────────────────────────────┐
   przeglądarka  ──►  │  node:http  (server/index.js)       │
   (public/*)         │    ├─ /api/*  → router → api.js     │
                      │    └─ /*      → static.js → public/ │
                      └───────────────┬─────────────────────┘
                                      │
   obcy serwer   ──►  ┌───────────────┴──────────┐
   pocztowy :25       │  node:net  (smtp.js)     │
                      │    ├─ STARTTLS (tls-cert)│
                      │    └─ mime.js → mail.js  │
                      └───────────────┬──────────┘
                                      ▼
                          node:sqlite (db.js)  ── data/twojapoczta.db
                                      ▲
   wysyłka na       ┌─────────────────┴─────────────┐
   zewnątrz    ◄──  │ smtp-out.js (MX, STARTTLS)    │
                    │   └─ dkim.js (podpis)         │
                    └───────────────────────────────┘
```

## Backend (`server/`)

| Plik            | Odpowiedzialność |
| --------------- | ---------------- |
| `index.js`      | Punkt wejścia. Składa aplikację (`createApp`), nakłada nagłówki bezpieczeństwa (CSP, `X-Content-Type-Options`…), rozdziela ruch `/api/*` od statyki, startuje serwer HTTP i opcjonalnie SMTP. Obsługuje też CLI `--dkim` i `--admin <login>`. |
| `router.js`     | Mini-router: dopasowanie metody i ścieżki ze wzorcami `:param`. Bez zależności. |
| `static.js`     | Bezpieczne serwowanie `public/`: ochrona przed path traversal, czyste adresy (`/logowanie` → `logowanie.html`), typy MIME, `Cache-Control`, `Last-Modified`/`304`. |
| `db.js`         | Schemat SQLite i połączenie (WAL, `foreign_keys=ON`). Lekkie migracje przez `ensureColumn`. `openDb` (plik) i `openMemoryDb` (testy). |
| `auth.js`       | scrypt + sól, `timingSafeEqual`, sesje w cookie `httpOnly`/`SameSite=Lax`, limit prób logowania (5 / 15 min na parę IP+login). |
| `mail.js`       | Logika domenowa: foldery, doręczanie wewnętrzne, wyszukiwanie, wersje robocze, zaplanowana wysyłka (`fireScheduled`), przesyłanie dalej (`forwardDelivered`), cykl życia wiadomości, doręczanie przychodzące (`deliverInbound`) i zlecanie wysyłki na zewnątrz. |
| `folders.js`    | Logika folderów własnych: CRUD, walidacja nazw, usuwanie z przeniesieniem do Archiwum. |
| `kryteria.js`   | Kryteria wyszukiwania: normalizacja, walidacja i kompilacja do jednego fragmentu SQL. Napędza wyszukiwarkę i silnik reguł — to ta sama ścieżka kodu. |
| `reguly.js`     | Reguły wiadomości: walidacja akcji (cel przekazania tą samą ścieżką co przekierowanie skrzynki), CRUD z kolejnością, silnik składający akcje pasujących reguł po `position` (precedencja celu: usuń > przenieś > archiwizuj; sprzeczny priorytet rozstrzyga wyższa pozycja) i przebieg wsadowy bez przekazywania dalej. Dopasowanie = fragment z `kryteria.js` + `AND id = ?`. |
| `api.js`        | Handlery HTTP: walidacja wejścia, strażnik sesji, warstwa JSON, odczyt ciała z limitami. |
| `seed.js`       | Konta i wiadomości demonstracyjne (pomijane przy `TP_SEED=0`), treść listu powitalnego. |
| `attachments.js`| Załączniki: bloby adresowane sha256 (deduplikacja treści), tokeny uploadu (jednorazowe, 24 h), odśmiecanie osieroconych blobów. |
| `mime.js`       | Parser RFC 822/MIME poczty przychodzącej: encoded-words, quoted-printable, base64, multipart rekurencyjnie, `filename*`, polskie strony kodowe, HTML→tekst awaryjnie. |
| `smtp.js`       | Przychodzący SMTP na `node:net`: EHLO/MAIL/RCPT/DATA, STARTTLS (RFC 3207), dot-stuffing, limity, twarda ochrona przed relayem. Kontekst TLS dostaje opcją, więc nie wie, skąd bierze się certyfikat. |
| `tls-cert.js`   | Certyfikat dla bramki SMTP: wskazany w `TP_TLS_CERT` albo samopodpisany w `{TP_DATA_DIR}/tls/`. Kontekst przebudowuje leniwie po `mtime`, więc odnowienie nie wymaga restartu. |
| `x509.js`       | Samopodpisany certyfikat X.509 kodowany DER-em ręcznie (Node nie umie ich wystawiać): ECDSA P-256, `serverAuth`, SAN z nazwą MX-a. |
| `smtp-out.js`   | Wychodzący SMTP: budowanie MIME, lookup MX, oportunistyczny STARTTLS, smarthost, kolejkowanie per domena. |
| `dkim.js`       | Podpisy DKIM (rsa-sha256, relaxed/relaxed), generowanie i przechowywanie klucza, rekord DNS. |
| `settings.js`   | Ustawienia instancji w tabeli `settings` (rejestracja, min. długość hasła, catch-all) z fallbackiem do env: decyzje produktowe zmienialne w locie. |
| `audit.js`      | Dziennik zdarzeń: działania administracyjne i logowania, aktor jako tekst (wpis przeżywa usunięcie konta), retencja 90 dni czyszczona leniwie. |
| `quota.js`      | Limity miejsca: zużycie skrzynki (treści + załączniki) i decyzja `hasRoom`. Bez zależności, importują go mail/attachments/smtp. |
| `aliases.js`    | Limity aliasów per konto: odczyt limitu (`NULL` = bez limitu, `0` = wyłączone), liczenie i polska odmiana liczebnika. |
| `teams.js`      | Skrzynki zespołowe: skład, prawo wysyłki per członek, CRUD. Liść bez zależności (jak `quota.js`), adresy skleja wołający. |
| `admin.js`      | Logika panelu: przegląd kont z metadanymi, tworzenie/usuwanie kont, sesje, statystyki i ruch dzienny. Wyłącznie liczby, nigdy treści wiadomości. |
| `api-admin.js`  | Trasy `/api/admin/*`: strażnik roli, walidacja, guardy ostatniego administratora, wpisy audytu przy każdej mutacji. |
| `dns-check.js`  | Weryfikacja rekordów DNS (MX/A/SPF/DKIM/DMARC) na `node:dns` z wstrzykiwalnym resolverem (testy bez sieci). |

## Model danych

Jeden plik SQLite. Kluczowa decyzja: **kopia wiadomości per skrzynka**
(model zbliżony do Maildira). Wysyłka tworzy osobny wiersz w `messages`
u nadawcy (folder `sent`) i u każdego odbiorcy (`inbox`). Upraszcza to foldery,
liczniki i usuwanie: każdy operuje wyłącznie na własnych wierszach.

```
users(id, login·UNIQUE, name, password_hash, signature, theme, created_at,
      is_admin, is_blocked, quota_mb·NULL, last_login_at, alias_limit,
      forward_to, forward_keep)
sessions(id, user_id→users, expires_at, created_at)
messages(id, owner_id→users, folder, folder_id→folders·NULL, from_name,
         from_addr, to_addr, cc_addr, bcc_addr, subject, body, body_html,
         snippet, is_read, is_starred, is_priority, attachments_count,
         sent_at, scheduled_at)
folders(id, user_id→users, name, position, created_at)
rules(id, user_id→users, name, criteria·JSON, actions·JSON, is_active,
      position, created_at)
aliases(id, user_id→users, alias·UNIQUE, created_at)
teams(id, local_part·UNIQUE, name, created_at)
team_members(team_id→teams, user_id→users, can_send, created_at, PK(team_id,user_id))
blobs(hash·PK, data·BLOB, size)
attachments(id, message_id→messages, filename, mime, size, blob_hash→blobs)
uploads(token·PK, user_id→users, filename, mime, size, blob_hash, created_at)
settings(key·PK, value)
audit_log(id, actor_login, action, target, details, ip, created_at)
```

Folder własny wpina się do wiadomości przez `folder_id`, a `'custom'` w
kolumnie `folder` to wartownik: znaczy „to jest folder własny", nie
wbudowany. Niezmiennik trzyma się dla każdego wiersza:
**`folder_id IS NOT NULL` ⟺ `folder='custom'`**. Nazwa folderu jest unikalna
w obrębie konta (`UNIQUE(user_id, name)`), a wielkość liter składa kod
aplikacji, bo NOCASE w SQLite zna tylko ASCII.

Skrzynka zespołowa nie ma magazynu: `teams` trzyma wyłącznie adres i nazwę,
a poczta rozchodzi się kopią do skrzynki każdego członka (fan-out), więc
`owner_id` pozostaje jedynym właścicielem wiadomości. `local_part` żyje w tej
samej przestrzeni nazw co `users.login` i `aliases.alias`; pilnuje tego
`addressTaken` w `mail.js`.

`body` trzyma zawsze wersję tekstową (z niej powstaje `snippet` i po niej
szuka wyszukiwarka), `body_html` opcjonalną bogatą. `bcc_addr` wypełnia się
tylko w kopii nadawcy w `sent`; kopie adresatów go nie widzą. `scheduled_at`
ma sens wyłącznie w folderze `scheduled`.

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

**Wysyłka z terminem** (`scheduledAt`): list ląduje w folderze `scheduled`
zamiast u adresatów. Strażnik `fireScheduled`, wołany przy starcie i co 30 s
z `index.js`, nadaje wszystko, czego termin minął, i kasuje wiersz
`scheduled`. Adresaci mogli w międzyczasie zniknąć: tacy wracają zwrotem,
reszta dostaje list. Wyjście z folderu (`PATCH … folder`) zeruje `scheduled_at`,
więc anulowanie wysyłki nie zostawia uzbrojonego terminu.

**Reguły** (`applyRules`): wołane po zatwierdzeniu każdego doręczenia do
`inbox`, **przed** przesyłaniem dalej — reguła, która list zarchiwizowała,
wycisza przekierowanie, bo `forwardDelivered` sprawdza folder w bazie.
Kolejność: `COMMIT → applyRules → forwardDelivered`. Kopie w Wysłanych,
wiadomości systemowe i kopie z przekazań nie przechodzą przez reguły
(ostatnie ucina pętle dwóch reguł „przekaż dalej" z konstrukcji).
`criteria` i `actions` to JSON-y walidowane przy zapisie i odczycie.

**Przesyłanie dalej** (`forwardDelivered`): wołane **po** zatwierdzeniu każdego
doręczenia do `inbox` (wysyłka wewnętrzna, nadanie zaplanowanego, odbiór z SMTP).
Kopia wewnątrz domeny zachowuje oryginalnego nadawcę; na zewnątrz nadajemy
z adresu właściciela skrzynki (żeby SPF/DKIM się zgadzały) z `Reply-To`
na oryginalnego nadawcę. Pętle ucina zbiór odwiedzonych skrzynek plus limit
`MAX_FORWARD_HOPS`, a wiadomości systemowe (`deliverSystemMessage`: powitania
i zwroty) nie idą dalej; inaczej zwrot z przekierowania krążyłby w kółko.

## Frontend (`public/`)

Bez frameworka i bez budowania. Cztery strony (strona główna `index.html`,
`logowanie`/`rejestracja`, webmail `app.html`, panel administratora
`admin.html`) plus `404.html`.

- `assets/css/`: `tokens.css` (zmienne systemu „Datownik", motywy), `fonts.css`
  (własne woff2), oraz style per strona (`landing`, `auth`, `app`).
- `assets/js/auth.js`: logowanie/rejestracja, tryb demo, dynamiczny sufiks domeny.
- `assets/js/app/`: webmail rozbity na moduły:
  - `api.js`: cienka warstwa nad REST-em (błędy niosą komunikat serwera po polsku),
  - `ui.js`: narzędzia DOM, formatowanie czasu/rozmiaru po polsku, awatary, toasty,
    bezpieczne wstawianie treści z linkami (zero `innerHTML` dla danych),
  - `kompozycja.js`: okno pisania, DW/UDW, nadawca z aliasu, autozapis i odrzucanie wersji roboczych, upload załączników, planowanie wysyłki, stempel,
  - `edytor.js`: pasek formatowania nad `contenteditable` i czyszczenie HTML po liście dozwolonych znaczników (przy zapisie i przy renderze),
  - `tresc.js`: renderer poczty przychodzącej · sanitizer po stronie klienta (`DOMParser` + CSSOM), blokada zdalnych obrazków, zwijanie cytatów, inwersja kolorów w ciemnym motywie i fallback do czystego tekstu,
  - `polityki.js`: czyste polityki renderera (bez DOM, testowalne w `node:test`): allowlisty tagów i atrybutów, ocena adresów obrazków, allowlista funkcji CSS i zakresowanie selektorów do listu,
  - `kolor.js`: konwersje sRGB↔OKLCH i inwersja jasności pod ciemny motyw (czysty moduł),
  - `spinacze.js`: wybór widocznych spinaczy załączników · chowa ten, którego obrazek renderer wstawił w treść przez `cid:`,
  - `skroty.js`: skróty klawiszowe i paleta poleceń,
  - `foldery.js`: panel boczny, okna folderu i przenoszenia,
  - `filtry.js`: panel filtrów pod polem wyszukiwania (popover pozycjonowany w JS, bo anchor positioning nie jest jeszcze Baseline), zbieranie kryteriów, znacznik aktywnych filtrów,
  - `reguly.js`: kreator reguły (drugi krok panelu filtrów) i sekcja „Reguły" w Ustawieniach z polskim podsumowaniem (`podsumowaniePL`), przełącznikiem, strzałkami kolejności i usuwaniem,
  - `main.js`: rdzeń, czyli stan, foldery, lista, czytnik, ustawienia i spinanie całości.
- `assets/js/admin/`: panel administratora (osobna strona, hash-routing jak
  w apce, reuse `ui.js` i tokenów): `main.js` (strażnik roli, nawigacja),
  `api.js`, widoki `pulpit` (statystyki + wykres SVG), `uzytkownicy`
  (tabela + karta konta), `domena` (DKIM + weryfikacja DNS), `ustawienia`
  (zasady instancji + broadcast), `dziennik` (audyt). Style w `admin.css`.

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
| `GET /api/messages?folder=&folderId=&q=` | lista + liczniki |
| `GET /api/messages?from=&to=&subject=&has=&hasNot=&dateFrom=&dateTo=&hasAttachment=` | wyszukiwanie po kryteriach (AND); `folder`/`folderId` stają się kryteriami tylko w towarzystwie filtrów, bez folderu szuka wszędzie poza Koszem i Spamem, nieprawidłowe kryteria → 400 |
| `GET /api/messages/:id`                  | treść (oznacza przeczytane) + załączniki |
| `POST /api/messages`                     | wyślij (od razu albo z `scheduledAt`) lub zapisz wersję roboczą |
| `PATCH /api/messages/:id`                | `is_read` / `is_starred` / `folder` / `folder_id` |
| `DELETE /api/messages/:id`               | do kosza, a z kosza trwale |
| `GET /api/counts`                        | nieprzeczytane per folder |
| `GET` / `POST /api/folders`              | lista folderów własnych · utwórz folder |
| `PATCH` / `DELETE /api/folders/:id`      | zmień nazwę · usuń (poczta do Archiwum, reguły z tym celem gasną — `rulesDisabled` w odpowiedzi) |
| `GET` / `POST /api/rules`                | lista reguł · utwórz (`applyExisting: true` stosuje od ręki do starej poczty, bez przekazywania) |
| `PATCH` / `DELETE /api/rules/:id`        | zmiana pól, `is_active`, `move: 'up'\|'down'` · usuń |
| `POST /api/rules/:id/apply`              | przebieg wsadowy na żądanie → `{applied}` |
| `GET` / `POST /api/aliases` · `DELETE …/:id` | aliasy |
| `GET` / `PUT /api/forwarding`            | przesyłanie dalej (`to`, `keepCopy`) |
| `POST /api/uploads`                      | wgraj załącznik (surowe ciało + nagłówki) |
| `GET /api/messages/:id/attachments/:aid` | pobierz załącznik |

Trasy panelu administratora (`/api/admin/*`) wymagają dodatkowo roli
`is_admin`; pozostali dostają 403. Każda mutacja zostawia wpis w audycie.

| Metoda i ścieżka                              | Rola |
| --------------------------------------------- | ---- |
| `GET /api/admin/stats`                        | pulpit: konta, wiadomości, zajętość, ruch 14 dni, proces, bramki |
| `GET` / `POST /api/admin/users`               | lista kont z metadanymi · załóż konto |
| `PATCH` / `DELETE /api/admin/users/:id`       | imię, rola, blokada, limit · usuń konto |
| `POST /api/admin/users/:id/password`          | ustaw nowe hasło (unieważnia sesje) |
| `POST /api/admin/users/:id/logout`            | wyloguj ze wszystkich urządzeń |
| `POST` / `DELETE /api/admin/users/:id/aliases[/:aliasId]` | aliasy dowolnego konta |
| `GET` / `PATCH /api/admin/settings`           | rejestracja, min. hasło, catch-all + podgląd env |
| `POST /api/admin/broadcast`                   | komunikat systemowy do wszystkich skrzynek |
| `GET /api/admin/audit?action=&limit=`         | dziennik zdarzeń |
| `GET` / `POST /api/admin/dkim`                | status/rekord · generowanie lub rotacja klucza |
| `GET /api/admin/tls`                          | status certyfikatu STARTTLS: źródło, nazwa, ważność, odcisk |
| `POST /api/admin/dns-check`                   | żywa weryfikacja MX/A/SPF/DKIM/DMARC |

## Bezpieczeństwo

- Hasła: scrypt z solą, porównanie w czasie stałym.
- Sesje: cookie `httpOnly`, `SameSite=Lax`, `Secure` za HTTPS; leniwe sprzątanie wygasłych.
- Nagłówki: CSP trzyma `script-src` i `default-src` na `'self'`; `img-src` dopuszcza
  dodatkowo `data:` oraz `https:`/`http:` dla obrazków, które użytkownik świadomie
  odblokował w liście. Do tego `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`.
- Poczta HTML renderuje się po stronie klienta przez własny sanitizer (`tresc.js`,
  polityki w `polityki.js`): `DOMParser` parsuje HTML, CSSOM czyści CSS, a treść ląduje
  w DOM aplikacji przez allowlistę tagów i atrybutów, ze stylami zakresowanymi do
  kontenera listu. Bez `iframe` i bez Shadow DOM. Drzewa nie serializujemy z powrotem
  do stringa · to zamyka mXSS.
- Zdalne obrazki są domyślnie blokowane: adres parkuje w atrybucie-schowku, a użytkownik
  odblokowuje je świadomie belką „Pokaż obrazki". To ochrona prywatności · nadawca nie
  pozna momentu otwarcia listu.
- Starsze listy (sprzed tej zmiany) pokazują się jako tekst z klikalnymi linkami
  budowanymi z węzłów DOM · to fallback, nie jedyna ścieżka.
- SMTP przychodzący nie przyjmuje relayu; wychodzący domyślnie wyłączony.
- STARTTLS na przychodzącym jest oportunistyczny, nigdy wymagany: MX odmawiający
  poczty nieszyfrowanej po prostu traci listy od starszych serwerów. Stan sprzed
  TLS jest kasowany po podniesieniu (RFC 3207 §4.2), a polecenia wstrzyknięte
  za komendą `STARTTLS` zrywają połączenie.
- Niebezpieczne typy załączników (`text/html`, `image/svg+xml`…) serwowane
  jako `application/octet-stream` z `Content-Disposition: attachment`.
- Limity rozmiaru na każdym wejściu (ciało JSON, upload, wiadomość SMTP).
- Panel administratora: rola sprawdzana serwerowo przy każdej trasie,
  sesje kont zablokowanych unieważniane natychmiast, guardy ostatniego
  administratora (nie można go zdegradować, zablokować ani usunąć),
  komunikat 403 przy złym haśle nie zdradza istnienia konta, pełny audyt
  mutacji z adresem IP. Panel nie ma wglądu w treści wiadomości.

## Testy

`npm test` uruchamia 433 testy na `node:test` (baza w pamięci, zero
instalacji); `npm run test:coverage` dolicza raport pokrycia linii i gałęzi.
Uruchamiając ręcznie, podawaj pliki (`node --test tests/teams.test.js`):
gołe `node --test tests/` nie uruchamia żadnego testu, a wygląda na sukces.

- Scenariusze przekrojowe: `tests/api.test.js` (pełen obieg REST: konta,
  foldery, doręczanie, aliasy, załączniki, przełączniki produkcyjne),
  `tests/smtp.test.js` (parser MIME, serwer przychodzący, pętla out→in,
  odbicia, ochrona przed relayem) i `tests/admin.test.js` (panel: strażnik
  roli, konta, blokady, ustawienia, broadcast, DKIM, weryfikacja DNS
  na fałszywym resolverze).
- Testy jednostkowe per moduł: `auth`, `mail`, `folders`, `mime`, `attachments`,
  `router`, `static`, `db`, `smtp-in`, `smtp-out`, `smtp-starttls`, `x509`,
  `tls-cert`, `dkim-init`, `api.extra`, `index`, `settings`, `audit`, `quota`,
  `aliases`, `teams`, `dns-check`. Każdy test dostaje świeżą bazę w pamięci, więc nic
  nie współdzieli z pozostałymi.
- `tests/dkim.test.js`: wektory kanonizacji z RFC 6376 i **niezależny
  weryfikator** sprawdzający podpis na wyemitowanych, pofoldowanych bajtach.
- `tests/x509.test.js`: certyfikat sprawdzany **cudzym parserem** (`crypto.X509Certificate`)
  i własnym podpisem (`verify`), co wyłapuje błąd w kodowaniu DER co do bajtu.

## Zasady, których warto się trzymać

- **Nie dodawaj zależności runtime.** Jeśli czegoś brakuje w standardowej
  bibliotece Node, najpierw rozważ, czy naprawdę jest potrzebne.
- **Cudzego HTML nie wstawiaj przez `innerHTML`.** Dane budujesz z węzłów DOM;
  pocztę przychodzącą renderuje własny sanitizer (`tresc.js`), który przenosi węzły
  z `DOMParser` i nigdy nie serializuje drzewa z powrotem.
- **Każde wejście ma limit.** Nowy endpoint = jawny limit rozmiaru i walidacja.
- **Interfejs po polsku, komunikaty błędów też.** Pisane z perspektywy
  użytkownika, nie systemu.
- **Commity: krótki komunikat po angielsku** (konwencja checkpointów projektu).
