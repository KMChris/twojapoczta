# 📮 TwojaPoczta

**Twoja poczta. Twoje zasady.** Nowoczesny webmail, który stawiasz na własnym
VPS. Zero zależności npm, wystarczy Node 24.

```sh
git clone <adres-repozytorium> twoja-poczta
cd twoja-poczta
node server/index.js
```

To wszystko. Bez `npm install`, bez Dockera, bez zewnętrznej bazy danych.

- **Strona główna:** `http://localhost:3000/`
- **Aplikacja:** `http://localhost:3000/app`
- **Konto demo:** `demo` / `demo1234`

## Co potrafi

- **Pełny webmail**: Odebrane, Z gwiazdką, Wysłane, Szkice (z autozapisem),
  Archiwum, Spam, Kosz (dwustopniowe usuwanie).
- **Doręczanie wewnętrzne**: wiadomości między kontami w Twojej domenie
  trafiają do adresatów natychmiast.
- **Skróty klawiszowe**: `c` pisze, `/` szuka, `j`/`k` przewijają, `e` archiwizuje,
  `s` gwiazdka, `#` kosz, `u` nieprzeczytane, `g i`/`g s` foldery, `?` ściąga.
- **Paleta poleceń** `Ctrl+K`: foldery, akcje i ustawienia w jednym miejscu.
- **Wyszukiwarka pełnotekstowa**: nadawca, temat, treść.
- **Tryb ciemny „nocna sortownia"**: jasny, ciemny albo jak system.
- **List powitalny** dla każdego nowego konta i gotowa skrzynka demo.

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
server/          # backend: index, router, static, db, auth, mail, api, seed
public/          # strona główna, logowanie/rejestracja, aplikacja /app
tests/           # smoke testy node:test (in-memory SQLite)
data/            # tworzony przy starcie; cała poczta w jednym pliku
```

## Konfiguracja

Zmiennymi środowiskowymi:

| Zmienna       | Domyślnie          | Opis                                        |
| ------------- | ------------------ | ------------------------------------------- |
| `PORT`        | `3000`             | port HTTP                                   |
| `HOST`        | `127.0.0.1`        | adres nasłuchu (za proxy zostaw domyślny)   |
| `TP_DATA_DIR` | `./data`           | katalog na bazę SQLite                      |
| `TP_DOMAIN`   | `twojapoczta.com`  | domena adresów e-mail                       |
| `TP_SECURE`   | brak               | `1` wymusza cookie `Secure` (albo nagłówek `x-forwarded-proto: https` z proxy) |

## Wdrożenie na VPS

### 1. Usługa systemd

`/etc/systemd/system/twojapoczta.service`:

```ini
[Unit]
Description=TwojaPoczta
After=network.target

[Service]
User=poczta
WorkingDirectory=/opt/twoja-poczta
ExecStart=/usr/bin/node server/index.js
Environment=PORT=3000
Environment=TP_DATA_DIR=/var/lib/twojapoczta
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl enable --now twojapoczta
```

### 2. Reverse proxy z TLS

Caddy (najprościej, automatyczny certyfikat):

```
twojapoczta.com {
    reverse_proxy 127.0.0.1:3000
}
```

albo nginx + certbot:

```nginx
server {
    server_name twojapoczta.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

### 3. Kopia zapasowa

Cała poczta to jeden plik:

```sh
sqlite3 /var/lib/twojapoczta/twojapoczta.db ".backup kopia-$(date +%F).db"
```

(albo zwykłe `cp`, gdy usługa jest zatrzymana).

## Rozwój i testy

```sh
npm run dev    # restart przy zmianach (node --watch)
npm test       # smoke testy API (node:test, baza in-memory)
```

## Mapa rozwoju

- Bramka SMTP/IMAP do poczty ze świata zewnętrznego
- Załączniki
- Aliasy adresów i katalogi własne
- Filtry / reguły

## Licencja

MIT, treść w [LICENSE](LICENSE). Fonty na licencji SIL OFL
([szczegóły](public/assets/fonts/LICENSE.md)).
