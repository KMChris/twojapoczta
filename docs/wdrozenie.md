# Wdrożenie na własny serwer, krok po kroku

Ten przewodnik prowadzi od świeżego VPS-a do działającej, publicznej poczty
z HTTPS, odbiorem maili ze świata i podpisami DKIM. Zakłada Ubuntu 24.04
(na Debianie 12 wszystko wygląda tak samo), ale jedynym twardym wymaganiem
jest **Node 24+** i systemd.

Czas: ~30 minut. Poziom: podstawowa znajomość terminala i SSH.

> W przykładach używamy domeny `twojadomena.pl` i adresu IP `203.0.113.10`.
> Wszędzie podmień je na swoje.

## Czego potrzebujesz

- **VPS**. Wystarczy najmniejszy: 1 vCPU, 512 MB RAM, parę GB dysku.
  Jeśli chcesz odbierać pocztę ze świata, upewnij się u dostawcy, że
  **port 25 nie jest blokowany** (część tanich VPS-ów blokuje go domyślnie).
- **Domena** z dostępem do edycji rekordów DNS.
- Dostęp SSH z uprawnieniami `sudo`.

## Krok 1: rekordy DNS

Ustaw w panelu swojej domeny (TTL dowolny, np. 3600):

| Typ | Nazwa               | Wartość                  | Po co                    |
| --- | ------------------- | ------------------------ | ------------------------ |
| A   | `twojadomena.pl`    | `203.0.113.10`           | strona i aplikacja       |
| A   | `mx.twojadomena.pl` | `203.0.113.10`           | serwer pocztowy          |
| MX  | `twojadomena.pl`    | `10 mx.twojadomena.pl`   | dokąd słać Twoją pocztę  |
| TXT | `twojadomena.pl`    | `v=spf1 a mx -all`       | SPF: kto może nadawać    |

Rekord TXT dla DKIM dodasz w kroku 8 (najpierw serwer musi wygenerować klucz).

Do tego **rekord PTR** (reverse DNS) dla `203.0.113.10` wskazujący na
`mx.twojadomena.pl`. Ustawia się go **w panelu dostawcy VPS**, nie w DNS
domeny. Bez PTR duzi operatorzy (Gmail, Outlook) często odrzucają pocztę.

Propagacja DNS może potrwać do godziny. Możesz kontynuować i sprawdzić później:

```sh
dig +short MX twojadomena.pl
dig +short TXT twojadomena.pl
```

## Krok 2: Node 24

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # musi pokazać v24.x lub nowszy
```

## Krok 3: użytkownik i katalogi

Aplikacja będzie działać jako osobny użytkownik systemowy, bez powłoki:

```sh
sudo adduser --system --group --home /var/lib/twojapoczta poczta
sudo git clone https://twojapoczta.com/kod.git /opt/twojapoczta
sudo chown -R poczta:poczta /opt/twojapoczta /var/lib/twojapoczta
```

Kod trafia do `/opt/twojapoczta`, dane (baza SQLite, klucz DKIM) do
`/var/lib/twojapoczta`. Rozdzielenie ułatwia aktualizacje i kopie zapasowe.

## Krok 4: pierwszy start na próbę

```sh
cd /opt/twojapoczta
sudo -u poczta env TP_SEED=0 TP_DOMAIN=twojadomena.pl \
  TP_DATA_DIR=/var/lib/twojapoczta node server/index.js
```

W drugim terminalu:

```sh
curl -s http://127.0.0.1:3000/api/config
# → {"domain":"twojadomena.pl","registration":true}
```

Działa? Zatrzymaj proces (`Ctrl+C`) i przejdź dalej.

> **`TP_SEED=0` jest ważne na produkcji**: bez niego pierwsza inicjalizacja
> bazy utworzy konta demonstracyjne (m.in. `demo` z publicznie znanym hasłem
> `demo1234`). Zostaw seed tylko do lokalnych testów.

## Krok 5: usługa systemd

Utwórz `/etc/systemd/system/twojapoczta.service`:

```ini
[Unit]
Description=TwojaPoczta
After=network.target

[Service]
User=poczta
Group=poczta
WorkingDirectory=/opt/twojapoczta
ExecStart=/usr/bin/node server/index.js
Restart=on-failure

# --- konfiguracja ---
Environment=PORT=3000
Environment=HOST=127.0.0.1
Environment=TP_DOMAIN=twojadomena.pl
Environment=TP_DATA_DIR=/var/lib/twojapoczta
Environment=TP_SEED=0
# Poczta ze świata (krok 8). Odkomentuj, gdy DNS będzie gotowy:
# Environment=TP_SMTP_PORT=25
# Environment=TP_SMTP_HOSTNAME=mx.twojadomena.pl
# Environment=TP_EXTERNAL=1

# port 25 bez roota wymaga tej zdolności:
AmbientCapabilities=CAP_NET_BIND_SERVICE

# odrobina hartowania:
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/twojapoczta
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now twojapoczta
sudo systemctl status twojapoczta      # powinno być: active (running)
journalctl -u twojapoczta -f           # podgląd logów na żywo
```

## Krok 6: HTTPS przez reverse proxy

Aplikacja słucha tylko na `127.0.0.1:3000`; do świata wystawia ją proxy
z automatycznym TLS. Wybierz jeden wariant.

### Wariant A: Caddy (polecany, najmniej pracy)

```sh
sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```
twojadomena.pl {
    reverse_proxy 127.0.0.1:3000
}
```

```sh
sudo systemctl reload caddy
```

Caddy sam pozyska i odnowi certyfikat Let's Encrypt oraz ustawi nagłówek
`X-Forwarded-Proto`, dzięki któremu ciasteczko sesji dostanie flagę `Secure`.

### Wariant B: nginx + certbot

```sh
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/twojapoczta`:

```nginx
server {
    listen 80;
    server_name twojadomena.pl;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
        client_max_body_size 6m;   # upload załączników (limit aplikacji: 5 MB)
    }
}
```

```sh
sudo ln -s /etc/nginx/sites-available/twojapoczta /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d twojadomena.pl
```

## Krok 7: zapora

```sh
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 25/tcp      # tylko jeśli odbierasz pocztę ze świata
sudo ufw enable
sudo ufw status
```

Sprawdź w przeglądarce: `https://twojadomena.pl`. Strona główna powinna
działać z kłódką.

## Krok 8: poczta ze świata i DKIM

1. Odkomentuj w unicie systemd trzy linie `TP_SMTP_PORT`, `TP_SMTP_HOSTNAME`
   i `TP_EXTERNAL`, po czym:

   ```sh
   sudo systemctl daemon-reload && sudo systemctl restart twojapoczta
   ```

   W logach zobaczysz `SMTP nasluchuje na 0.0.0.0:25`.

2. Wygeneruj i odczytaj rekord DKIM (klucz powstaje przy pierwszym starcie
   z `TP_EXTERNAL=1`; to polecenie tylko go wydrukuje):

   ```sh
   cd /opt/twojapoczta
   sudo -u poczta env TP_DOMAIN=twojadomena.pl \
     TP_DATA_DIR=/var/lib/twojapoczta node server/index.js --dkim
   ```

   Dodaj w DNS wypisany rekord TXT o nazwie `tp1._domainkey.twojadomena.pl`.

3. Zweryfikuj (po propagacji):

   ```sh
   dig +short TXT tp1._domainkey.twojadomena.pl
   telnet mx.twojadomena.pl 25    # powinno przywitać: 220 mx.twojadomena.pl ESMTP TwojaPoczta
   ```

4. **Test bojowy:** wyślij mail z Gmaila na `cokolwiek@twojadomena.pl`.
   Wpadnie do Odebranych (o ile skrzynka `cokolwiek` istnieje; inaczej
   nadawca dostanie odbicie `550 5.1.1 No such mailbox`). Potem odpowiedz
   z TwojejPoczty i w Gmailu otwórz „Pokaż oryginał". Powinno być
   `SPF: PASS` i `DKIM: PASS`.

> Jeśli Twój dostawca blokuje wychodzący port 25, wysyłaj przez przekaźnik
> SMTP (smarthost): `Environment=TP_SMTP_ROUTE=smtp.twoj-hosting.pl:25`.

## Krok 9: konta

1. Wejdź na `https://twojadomena.pl/rejestracja` i załóż swoje konto.
   List powitalny już czeka w Odebranych.
2. Załóż konta domownikom / zespołowi.
3. Gdy komplet jest gotowy, **zamknij rejestrację**: dodaj do unitu
   `Environment=TP_REGISTER=0` i zrestartuj usługę. Od tej pory nowych
   kont nie założy nikt z internetu.

## Krok 10: kopie zapasowe

Cała poczta (konta, wiadomości, załączniki, sesje) to jeden plik SQLite.
Bezpieczną kopię na działającej usłudze robi `sqlite3 .backup`:

```sh
sudo apt-get install -y sqlite3
```

Skrypt `/usr/local/bin/kopia-poczty`:

```sh
#!/bin/sh
set -eu
KATALOG=/var/backups/twojapoczta
mkdir -p "$KATALOG"
sqlite3 /var/lib/twojapoczta/twojapoczta.db ".backup '$KATALOG/poczta-$(date +%F).db'"
find "$KATALOG" -name 'poczta-*.db' -mtime +14 -delete
```

```sh
sudo chmod +x /usr/local/bin/kopia-poczty
sudo crontab -e   # dodaj linię:
# 30 3 * * * /usr/local/bin/kopia-poczty
```

Do kopii dołącz też katalog `/var/lib/twojapoczta/dkim/` (klucz prywatny;
bez niego po odtworzeniu trzeba by zmieniać rekord DNS).

**Przywracanie:** zatrzymaj usługę, podmień plik bazy, uruchom:

```sh
sudo systemctl stop twojapoczta
sudo cp /var/backups/twojapoczta/poczta-2026-07-12.db /var/lib/twojapoczta/twojapoczta.db
sudo chown poczta:poczta /var/lib/twojapoczta/twojapoczta.db
sudo systemctl start twojapoczta
```

## Krok 11: aktualizacje

```sh
cd /opt/twojapoczta
sudo -u poczta git pull
sudo -u poczta npm test        # 212 testów, zero zależności do instalowania
sudo systemctl restart twojapoczta
```

Migracje schematu bazy wykonują się same przy starcie.

## Rozwiązywanie problemów

| Objaw | Najczęstsza przyczyna | Co zrobić |
| ----- | --------------------- | --------- |
| Przeglądarka: 502 Bad Gateway | usługa nie działa | `systemctl status twojapoczta`, `journalctl -u twojapoczta -n 50` |
| `EADDRINUSE` w logach | port 3000 zajęty | zmień `PORT` w unicie albo znajdź proces: `ss -ltnp \| grep 3000` |
| `EACCES` przy porcie 25 | brak zdolności bind | sprawdź `AmbientCapabilities=CAP_NET_BIND_SERVICE` w unicie |
| Maile ze świata nie dochodzą | MX/zapora/port 25 | `dig MX`, `ufw status`, `telnet mx.twojadomena.pl 25` z innej maszyny |
| Wysłane maile lądują w spamie | brak PTR albo DKIM | ustaw PTR u dostawcy VPS; `dig TXT tp1._domainkey...`; ostatecznie smarthost |
| „Zwrot do nadawcy" w Odebranych | odbiorca odrzucił / port 25 out zablokowany | powód jest w treści odbicia; rozważ `TP_SMTP_ROUTE` |
| Po wejściu na stronę brak stylów | proxy tnie ścieżki `/assets` | proxy ma przekazywać cały ruch `/` bez wyjątków |
| Rejestracja zwraca 403 | `TP_REGISTER=0` | tak ma być; konta zakłada się przy otwartej rejestracji |
| Baza „locked" przy ręcznym grzebaniu | otwarta przez usługę (WAL) | używaj `sqlite3 .backup`, nie edytuj bazy pod działającą usługą |

## Lista kontrolna na koniec

- [ ] `https://twojadomena.pl` działa z ważnym certyfikatem
- [ ] `TP_SEED=0` ustawione (brak konta demo)
- [ ] własne konto założone, list powitalny odebrany
- [ ] `TP_REGISTER=0` po założeniu wszystkich kont
- [ ] `dig MX` i `dig TXT` (SPF + DKIM) zwracają poprawne rekordy
- [ ] PTR ustawiony u dostawcy VPS
- [ ] test z Gmailem: odbiór działa, `SPF: PASS`, `DKIM: PASS`
- [ ] cron z kopią zapasową + kopia katalogu `dkim/`

## Znane ograniczenia

- Przychodzący SMTP nie oferuje jeszcze STARTTLS, więc transport od obcych
  serwerów do Twojego może być nieszyfrowany (treść w skrzynce jest już
  tylko Twoja). Pozycja na mapie rozwoju.
- Brak IMAP: pocztę czytasz przez webmail (responsywny, działa na telefonie).
