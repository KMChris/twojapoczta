# 📮 TwojaPoczta

**Twoja poczta. Twoje zasady.** Nowoczesny webmail, który stawiasz na własnym
VPS. Zero zależności npm, wystarczy Node 24.

```sh
git clone git@github.com:KMChris/twojapoczta.git
cd twojapoczta
node server/index.js
```

To wszystko. Bez `npm install`, bez Dockera, bez zewnętrznej bazy danych.

- **Strona główna:** `http://localhost:3000/`
- **Aplikacja:** `http://localhost:3000/app`
- **Konto demo:** `demo` / `demo1234` (tylko lokalnie; na produkcji ustaw `TP_SEED=0`)

## Dokumentacja

| Dokument | O czym |
| -------- | ------ |
| [Wdrożenie krok po kroku](docs/wdrozenie.md) | Od świeżego VPS-a do publicznej poczty z HTTPS i DKIM. |
| [Konfiguracja](docs/konfiguracja.md) | Wszystkie zmienne środowiskowe, rekordy DNS, limity. |
| [Panel administratora](docs/administracja.md) | Konta, limity, DKIM, weryfikacja DNS, dziennik zdarzeń. |
| [Przewodnik użytkownika](docs/przewodnik.md) | Skróty, paleta poleceń, aliasy, ustawienia. |
| [Architektura](docs/architektura.md) | Budowa kodu, model danych, API. Dla współtwórców. |

## Co potrafi

- **Pełny webmail**: Odebrane, Z gwiazdką, Wysłane, Zaplanowane, Wersje robocze
  (z autozapisem), Archiwum, Spam, Kosz (dwustopniowe usuwanie).
- **Pisanie jak w dużych skrzynkach**: formatowanie treści (pogrubienie, kolory,
  listy, cytaty, odnośniki, obrazki), DW i UDW, nadawanie spod aliasu
  oraz wysyłka o zaplanowanej porze.
- **Przesyłanie dalej**: cała nowa poczta leci automatycznie pod wskazany adres,
  z kopią w Odebranych albo bez, z ochroną przed zapętleniem.
- **Doręczanie wewnętrzne**: wiadomości między kontami w Twojej domenie
  trafiają do adresatów natychmiast.
- **Bramka SMTP**: odbiór poczty ze świata (rekord MX + port 25) z pełnym
  parserem MIME; wysyłka na zewnątrz opcjonalnie (`TP_EXTERNAL=1`)
  z podpisami **DKIM**, nieudane doręczenia wracają jako „Zwrot do nadawcy".
- **Załączniki**: do 10 plików po 5 MB, przechowywane z deduplikacją treści.
- **Aliasy adresów**: dodatkowe adresy wpadające do Twojej skrzynki; limit
  ustawia administrator per konto (domyślnie 5, można znieść).
- **Skróty klawiszowe**: `c` pisze, `/` szuka, `j`/`k` przewijają, `e` archiwizuje,
  `s` gwiazdka, `#` kosz, `u` nieprzeczytane, `g i`/`g s` foldery, `?` ściąga.
- **Paleta poleceń** `Ctrl+K`: foldery, akcje i ustawienia w jednym miejscu.
- **Wyszukiwarka pełnotekstowa**: nadawca, temat, treść.
- **Tryb ciemny „nocna sortownia"**: jasny, ciemny albo jak system.
- **List powitalny** dla każdego nowego konta i gotowa skrzynka demo.
- **Panel administratora** pod `/admin`: konta (role, blokady, hasła,
  limity miejsca, aliasy), klucze DKIM z panelu, żywa weryfikacja rekordów
  DNS (MX/SPF/DKIM/DMARC), rejestracja i polityka haseł bez restartu,
  catch-all, komunikaty do wszystkich skrzynek, dziennik zdarzeń
  i statystyki instancji. Bez wglądu w treść cudzych wiadomości.

## Architektura

Zero zależności w środowisku uruchomieniowym. Pracują tu wyłącznie moduły
wbudowane w Node 24:

| Warstwa    | Technologia                                          |
| ---------- | ---------------------------------------------------- |
| HTTP       | `node:http` + własny mini-router                     |
| Baza       | `node:sqlite` (WAL), jeden plik `data/twojapoczta.db` |
| Hasła      | `node:crypto` scrypt + sól, porównanie `timingSafeEqual` |
| Sesje      | cookie `httpOnly` `SameSite=Lax`, 30 dni             |
| Frontend   | statyczne ES-moduły + nowoczesny CSS, bez builda     |
| Fonty      | własne woff2 (Archivo, IBM Plex Mono; licencja SIL OFL) |

```
server/          # backend: http, router, static, db, auth, mail, api, seed,
                 #          attachments, mime, smtp (in), smtp-out, dkim,
                 #          settings, audit, quota, admin, api-admin, dns-check
public/          # strona główna, logowanie/rejestracja, aplikacja /app
tests/           # testy node:test (in-memory SQLite): api, smtp, dkim
data/            # tworzony przy starcie; cała poczta w jednym pliku
```

Szczegółowy opis modułów i modelu danych: [docs/architektura.md](docs/architektura.md).

## Konfiguracja

Zmiennymi środowiskowymi:

| Zmienna            | Domyślnie          | Opis                                        |
| ------------------ | ------------------ | ------------------------------------------- |
| `PORT`             | `3000`             | port HTTP                                   |
| `HOST`             | `127.0.0.1`        | adres nasłuchu (za proxy zostaw domyślny)   |
| `TP_DATA_DIR`      | `./data`           | katalog na bazę SQLite                      |
| `TP_DOMAIN`        | `twojapoczta.com`  | domena adresów e-mail                       |
| `TP_SEED`          | brak (włączone)    | `0` wyłącza konta demo (ustaw na produkcji) |
| `TP_REGISTER`      | brak (otwarta)     | `0` zamyka rejestrację nowych kont          |
| `TP_SECURE`        | brak               | `1` wymusza cookie `Secure` (albo nagłówek `x-forwarded-proto: https` z proxy) |
| `TP_SMTP_PORT`     | brak (wyłączone)   | port przychodzącego SMTP (produkcyjnie `25`) |
| `TP_SMTP_HOST`     | `0.0.0.0`          | adres nasłuchu SMTP                         |
| `TP_SMTP_HOSTNAME` | `mx.{TP_DOMAIN}`   | nazwa serwera w powitaniu SMTP i EHLO       |
| `TP_EXTERNAL`      | brak (wyłączone)   | `1` włącza wysyłkę poza własną domenę       |
| `TP_SMTP_ROUTE`    | brak               | smarthost `host[:port]`: cała poczta wychodząca przez przekaźnik |
| `TP_TLS_VERIFY`    | brak (oportunistycznie) | `1` wymusza walidację certyfikatu serwera odbiorcy (fail-closed) |
| `TP_DKIM_SELECTOR` | `tp1`              | selektor podpisów DKIM (nazwa rekordu TXT)  |

## Wdrożenie na VPS

Pełne wdrożenie, od świeżego serwera po publiczną pocztę z HTTPS, odbiorem
ze świata, DKIM i kopiami zapasowymi, opisuje krok po kroku
[**docs/wdrozenie.md**](docs/wdrozenie.md). Poniżej skrót.

Aplikacja słucha tylko na `127.0.0.1`; do świata wystawia ją reverse proxy
z TLS (Caddy albo nginx, konfiguracja obu w samouczku). Uruchamiasz ją jako
usługę systemd:

```ini
# /etc/systemd/system/twojapoczta.service
[Service]
User=poczta
WorkingDirectory=/opt/twojapoczta
ExecStart=/usr/bin/node server/index.js
Environment=PORT=3000
Environment=TP_DOMAIN=twojadomena.pl
Environment=TP_DATA_DIR=/var/lib/twojapoczta
Environment=TP_SEED=0          # produkcja: bez konta demo
# Poczta ze świata (gdy MX wskazuje na ten serwer):
# Environment=TP_SMTP_PORT=25
# Environment=TP_EXTERNAL=1     # + podpisy DKIM (npm run dkim wypisze rekord DNS)
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
```

Bramka SMTP przyjmuje pocztę tylko dla skrzynek i aliasów w Twojej domenie
(relay odrzucany), a wysyłka na zewnątrz podpisuje wiadomości DKIM i zwraca
nieudane doręczenia jako „Zwrot do nadawcy". Rekordy DNS (MX, SPF, DKIM),
rekord PTR, zaporę i wariant ze smarthostem opisuje samouczek.

**Kopia zapasowa.** Cała poczta to jeden plik SQLite:

```sh
sqlite3 /var/lib/twojapoczta/twojapoczta.db ".backup kopia-$(date +%F).db"
```

## Rozwój i testy

```sh
npm run dev             # restart przy zmianach (node --watch)
npm test                # 331 testów (node:test, baza w pamięci, zero instalacji)
npm run test:coverage   # to samo + raport pokrycia linii i gałęzi
```

## Mapa rozwoju

- STARTTLS dla przychodzącego SMTP (szyfrowany transport od obcych serwerów)
- Dostęp IMAP dla zewnętrznych klientów pocztowych
- Katalogi własne i filtry / reguły

## Licencja

MIT, treść w [LICENSE](LICENSE). Fonty na licencji SIL OFL
([szczegóły](public/assets/fonts/LICENSE.md)).
