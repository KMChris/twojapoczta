# Panel administratora

Panel pod adresem `/admin` zarządza całą instancją: kontami, limitami,
domeną, kluczami DKIM, ustawieniami i dziennikiem zdarzeń. Wejście widzą
tylko konta z rolą administratora (link „Panel administratora" w stopce
panelu bocznego skrzynki).

**Zasada nadrzędna:** panel nie daje żadnego wglądu w treść cudzych
wiadomości. Administrator widzi wyłącznie liczby (ile wiadomości, ile
zajętego miejsca), nigdy tematy ani treści. Tajemnica korespondencji
obowiązuje też administratora.

## Kto jest administratorem

- Na instalacji demonstracyjnej rolę ma konto `demo`.
- Na produkcji (`TP_SEED=0`) pierwszemu kontu nadaje się rolę z konsoli
  serwera. Katalog danych wskazujemy wprost, bo `TP_DATA_DIR` jest ustawiony
  w unicie systemd, a nie w Twojej powłoce:

  ```bash
  cd /opt/twojapoczta
  sudo -u poczta env TP_DATA_DIR=/var/lib/twojapoczta \
    node server/index.js --admin twoj-login
  ```

  Samo `npm run admin -- twoj-login` celuje w domyślny katalog `data/` obok
  kodu. Polecenie to wykryje i odmówi z podpowiedzią, zamiast założyć tam
  pustą bazę i twierdzić, że nie ma takiego konta. Na lokalnej instalacji,
  gdzie dane leżą właśnie obok kodu, skrót `npm run admin` jest w porządku.

- Kolejnym kontom rolę nadaje (i odbiera) administrator w panelu,
  w karcie konta.

Instancja zawsze musi mieć administratora: nie można odebrać roli ani
usunąć **ostatniego** admina, nie można też zablokować siebie.

## Sekcje panelu

### Pulpit

Przekrój instancji: liczba kont (z podziałem na adminów i zablokowane),
wiadomości, zajętość (treści + załączniki), aktywne sesje, aliasy; wykres
ruchu z 14 dni (odebrane/wysłane per dzień); status bramek (SMTP,
wysyłka na zewnątrz, DKIM, rejestracja, smarthost) oraz zdrowie procesu
(uptime, pamięć, wersja Node, rozmiar bazy).

### Użytkownicy

Tabela wszystkich kont z filtrem. Kliknięcie wiersza otwiera kartę konta:

| Operacja | Skutek |
| -------- | ------ |
| Załóż konto | Działa też przy zamkniętej rejestracji. Nowe konto dostaje list powitalny. |
| Zmień imię | Zmienia podpis nadawcy widoczny u odbiorców. |
| Nadaj/odbierz rolę administratora | Pełny dostęp do panelu. Ostatniego admina nie da się zdegradować. |
| Zablokuj/odblokuj | Blokada natychmiast unieważnia sesje konta i uniemożliwia logowanie. Poczta nadal jest doręczana. |
| Limit miejsca | W MB; puste pole = bez limitu. Pełna skrzynka przestaje przyjmować pocztę (SMTP odpowiada `552 5.2.2`, nadawca wewnętrzny dostaje czytelny błąd), ale nadal może wysyłać. |
| Ustaw hasło | Nowe hasło wylogowuje konto ze wszystkich urządzeń (poza sytuacją, gdy admin zmienia własne). |
| Limit aliasów | Ile aliasów może mieć konto (domyślnie 5). Puste pole = bez limitu; wtedy użytkownik nie widzi w ustawieniach żadnej liczby. Zero wyłącza aliasy. Obniżenie limitu nie kasuje aliasów, które konto już ma, tylko wstrzymuje dokładanie kolejnych. |
| Aliasy | Dodawanie i usuwanie aliasów konta, w granicach jego limitu. |
| Wyloguj ze wszystkich urządzeń | Unieważnia wszystkie sesje konta. |
| Usuń konto | Kasuje konto z całą pocztą, aliasami i sesjami (dwuetapowe potwierdzenie). Własnego konta nie można usunąć. |

### Zespoły

Skrzynki funkcyjne instancji: wspólny adres (`sprzedaz@twojapoczta.com`)
z własną nazwą („Dział Sprzedaży"). Poczta na ten adres rozchodzi się kopią do
skrzynki każdego członka; zespół nie ma własnego magazynu, więc miejsce zużywa
się u członków, gdzie działają zwykłe limity.

Każdemu członkowi ustawia się osobno, czy tylko **odbiera**, czy również
**wysyła**. Wysyłka z adresu zespołu podpisuje się nazwą zespołu, nie imieniem
osoby, która pisze: klient odpowiada firmie, a odpowiedź wraca do wszystkich.

Adres zespołu żyje w jednej przestrzeni nazw z loginami i aliasami, więc nie da
się założyć zespołu na zajętym adresie ani konta na adresie zespołu. Sam adres
jest niezmienny; zmienia się tylko nazwa.

**Zespół bez członków odrzuca pocztę** (`550`), dlatego panel oznacza taki
zespół ostrzeżeniem. Usunięcie zespołu zwalnia adres, a poczta już doręczona
zostaje u członków: to ich kopie.

### Domena i DNS

- **Szyfrowanie (STARTTLS)**: czy bramka SMTP szyfruje transport od obcych
  serwerów, skąd bierze certyfikat (wskazany zmienną `TP_TLS_CERT` czy
  samopodpisany), na jaką nazwę, do kiedy jest ważny i jaki ma odcisk SHA-256.
  Poniżej 14 dni do wygaśnięcia karta zapala ostrzeżenie. Samopodpisany
  certyfikat to stan normalny i wystarczający: obce serwery pocztowe szyfrują
  oportunistycznie i certyfikatu nie sprawdzają. Karta niczego nie zmienia,
  bo źródło certyfikatu jest decyzją wdrożeniową (zmienne środowiskowe).
- **DKIM**: generowanie klucza jednym przyciskiem (odpowiednik
  `npm run dkim`), rekord TXT do skopiowania, rotacja przez nowy selektor.
  Przycisk zawsze trafia w katalog danych działającego serwera. Z konsoli
  trzeba wskazać ten katalog wprost przez `TP_DATA_DIR`, tak samo jak przy
  `--admin`; samo `npm run dkim` celuje obok kodu i polecenie to odmówi,
  zamiast wypisać rekord dla klucza, którym nikt nie podpisuje.
- **Weryfikacja DNS**: żywe sprawdzenie rekordów MX, A, SPF, DKIM i DMARC.
  Panel porównuje stan w DNS z oczekiwanym i pokazuje różnice
  („Zgodny" / „Brak rekordu" / „Niezgodny" z zastaną wartością).
  Zapytania wychodzą z serwera poczty, więc wynik odpowiada temu,
  co widzą serwery odbiorców.
- Sama domena (`TP_DOMAIN`) i nazwa hosta MX pozostają w zmiennych
  środowiskowych; ich zmiana to decyzja wdrożeniowa (restart usługi).

### Ustawienia

- **Rejestracja nowych kont**: otwarta/zamknięta. Ustawienie z panelu ma
  pierwszeństwo przed `TP_REGISTER`.
- **Minimalna długość hasła**: 4–128 znaków (domyślnie 8). Obowiązuje przy
  rejestracji, zakładaniu kont i zmianach haseł z panelu.
- **Catch-all**: wskazana skrzynka dostaje pocztę SMTP adresowaną na
  nieistniejące adresy w domenie. Puste = taka poczta jest odbijana.
- **Komunikat do wszystkich**: wiadomość systemowa (nadawca „Zespół
  TwojaPoczta", PRIORYTET) trafia do Odebranych każdego konta.
- **Środowisko**: podgląd zmiennych `TP_*` (tylko odczyt).

### Dziennik zdarzeń

Wszystkie działania administracyjne (założenia, blokady, zmiany haseł
i limitów, aliasy, ustawienia, DKIM, komunikaty) oraz logowania, udane
i nieudane, z aktorem, celem, szczegółami i adresem IP. Wpisy trzymane
są 90 dni i przeżywają usunięcie konta (aktor zapisany jako tekst).

## API panelu

Wszystkie trasy pod `/api/admin/*` wymagają sesji z rolą administratora
(pozostali dostają 403). Każda mutacja zostawia wpis w dzienniku. Pełna
lista tras w [architekturze](architektura.md#api-http).
