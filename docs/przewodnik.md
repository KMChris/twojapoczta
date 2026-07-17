# Przewodnik użytkownika

Krótki obchód po TwojejPoczcie: od pierwszego logowania po skróty, dzięki
którym ręce nie zejdą z klawiatury.

Administrujesz serwerem? Panel instancji opisuje osobny dokument:
[panel administratora](administracja.md).

## Pierwsze kroki

1. **Załóż konto** na `/rejestracja`. Wybierasz login (to część adresu przed
   `@`), imię i nazwisko (tak podpiszemy Twoje wiadomości) oraz hasło.
   W Odebranych czeka już list powitalny.
2. **Zaloguj się** na `/logowanie`. Sesja trzyma się 30 dni, więc rzadko
   będziesz się logować ponownie.
3. **Chcesz się tylko rozejrzeć?** Na wersji demonstracyjnej wejdź na
   `/logowanie?demo=1`, a pola wypełnią się kontem `demo` / `demo1234`.

## Skrzynka w pigułce

Aplikacja ma trzy kolumny: **foldery** po lewej, **lista wiadomości**
w środku i **czytnik** po prawej. Na telefonie kolumny zwijają się w jeden
widok, a foldery chowają się pod ikoną menu.

### Foldery

| Folder         | Co w nim jest |
| -------------- | ------------- |
| Odebrane       | Poczta przychodząca. Licznik pokazuje nieprzeczytane. |
| Z gwiazdką     | Wiadomości oznaczone gwiazdką (z dowolnego folderu poza Koszem i Spamem). |
| Wysłane        | Kopie tego, co wysłałeś. |
| Zaplanowane    | Listy czekające na swoją godzinę. Licznik pokazuje, ile ich jest. |
| Wersje robocze | Zaczęte, jeszcze niewysłane wiadomości; zapisują się same. |
| Archiwum       | Uprzątnięte z Odebranych, ale nieusunięte. |
| Spam           | Zgłoszone albo złapane jako niechciane. |
| Kosz           | Usunięte. Kolejne skasowanie usuwa trwale. |

**Własne foldery.** Pod wbudowanymi w panelu bocznym jest „Nowy folder".
Foldery są płaskie: bez podfolderów, bo przy kilkunastu teczkach drzewo
bardziej przeszkadza, niż pomaga. Kolejność wyznacza czas utworzenia.

Wiadomość przenosisz ikoną teczki w otwartym liście. Leży dokładnie w jednym
miejscu, więc znika z Odebranych. Toast pozwala cofnąć przeniesienie.

Nazwa nie może udawać folderu wbudowanego i nie rozróżnia wielkości liter:
„Faktury" i „faktury" to ten sam folder.

**Usunięcie folderu nie kasuje poczty.** Wiadomości trafiają do Archiwum,
a okno potwierdzenia mówi, ile ich jest.

### Pisanie wiadomości

Kliknij **Napisz** (albo naciśnij `c`). Okno kompozycji pojawia się w prawym
dolnym rogu. Wpisz adresata, temat i treść. Możesz podać kilku adresatów
po przecinku.

- **Formatowanie**: pasek nad treścią daje pogrubienie, kursywę, podkreślenie,
  przekreślenie, krój pisma, kolor, wyrównanie, listy, cytat, odnośniki
  i obrazki w treści. Ostatnia ikona czyści formatowanie zaznaczenia.
- **Kilku adresatów**: rozdziel adresy przecinkiem. Przyciski `DW` i `UDW`
  obok pola „Do" dokładają kopię i kopię ukrytą. Adresaci z UDW nie widzą
  siebie nawzajem ani nie pojawiają się w kopiach u pozostałych.
- **Nadawca**: mając aliasy, wybierzesz w polu „Od", spod którego adresu
  wychodzi list.
- **Załączniki**: ikona spinacza dodaje pliki (do 10 sztuk po 5 MB).
  Obrazek wklejony w treść może mieć 1,5 MB; większe dodaj jako załącznik.
- **Wersja robocza zapisuje się sama** kilka sekund po tym, jak przestaniesz
  pisać. Zamknięcie okna z niepustą treścią też odkłada wiadomość do Wersji
  roboczych.
- **Odrzucanie**: ikona kosza w oknie kompozycji porzuca pisaną wiadomość,
  a zapisaną wersję roboczą przenosi do Kosza.
- **Wysyłka**: przycisk „Wyślij" albo `Ctrl+Enter`. Na wysłaną wiadomość
  przybija się pieczęć „WYSŁANO" z dzisiejszą datą.
- **Wysyłka o wybranej porze**: zegar obok „Wyślij" otwiera okienko z gotowymi
  terminami (dziś wieczorem, jutro rano, w poniedziałek) albo własną datą
  i godziną. List czeka w Zaplanowanych; „Anuluj wysyłkę" cofa go do wersji
  roboczych i od razu otwiera do poprawek.

Doręczanie w obrębie Twojej domeny jest natychmiastowe. Jeśli serwer ma
włączoną bramkę wychodzącą, możesz pisać też na zewnętrzne adresy.
Nieudane doręczenie wróci jako „Zwrot do nadawcy".

### Czytanie i porządki

Kliknij wiadomość, żeby ją otworzyć. Nad treścią masz przyciski:
**Odpowiedz** (cytuje oryginał), **Przekaż**, archiwizuj, gwiazdka,
oznacz jako nieprzeczytane, do kosza, zgłoś spam, drukuj. Załączniki pobierasz
klikając ich kafelki pod treścią.

**Drukowanie** (ikona drukarki albo `Ctrl+P`) kładzie na papier samą otwartą
wiadomość: temat, nadawcę, datę i treść. Bez folderów, listy i przycisków.

## Skróty klawiszowe

Naciśnij `?` w aplikacji, żeby zobaczyć tę listę na ekranie.

### Poruszanie się

| Skrót | Działanie |
| ----- | --------- |
| `j` / `k` | następna / poprzednia wiadomość |
| `Enter`   | otwórz zaznaczoną |
| `Esc`     | zamknij / wróć |
| `g` potem `i` | przejdź do Odebranych |
| `g` potem `s` | przejdź do Wysłanych |

### Działania

| Skrót | Działanie |
| ----- | --------- |
| `c` | nowa wiadomość |
| `/` | szukaj |
| `e` | archiwizuj |
| `s` | gwiazdka |
| `#` | do kosza |
| `u` | oznacz jako nieprzeczytane |
| `Ctrl`+`Enter` | wyślij (w oknie kompozycji) |
| `Ctrl`+`K` | paleta poleceń |
| `?` | ta ściąga |

## Paleta poleceń

`Ctrl`+`K` otwiera wyszukiwarkę wszystkiego: folderów, akcji i ustawień.
Zacznij pisać, a lista filtruje się na bieżąco (ignoruje polskie ogonki, więc
„wyslane" znajdzie „Wysłane"). Strzałkami wybierasz, `Enter` wykonuje.
Najszybsza droga do każdej funkcji.

## Wyszukiwanie

Pole wyszukiwania u góry (albo `/`) przeszukuje bieżący folder po nadawcy,
temacie i treści. Wyniki pojawiają się w trakcie pisania.

## Ustawienia

Kliknij swój awatar w prawym górnym rogu:

- **Imię i nazwisko**: podpis pod Twoimi wiadomościami.
- **Podpis**: tekst doklejany pod nową wiadomością i odpowiedzią.
- **Motyw**: jasny, „nocna sortownia" (ciemny w granacie atramentu) albo
  jak system.
- **Aliasy**: dodatkowe adresy (np. `biuro@…`, `sklep@…`), które wpadają do
  tej samej skrzynki. Wygodne do rozdzielania korespondencji bez zakładania
  kolejnych kont. Spod aliasu możesz też nadawać: wybierz go w polu „Od"
  w oknie pisania. Ile ich możesz mieć, ustala administrator (domyślnie 5);
  gdy limit nie obowiązuje, pod polem nie zobaczysz żadnej liczby.
- **Przesyłanie dalej**: podaj adres, a każda nowa wiadomość poleci tam
  automatycznie. Domyślnie kopia zostaje w Odebranych; po odznaczeniu
  „Zostaw kopię w Odebranych" oryginał schodzi do Archiwum, więc nic nie ginie.
  Nie da się przesyłać na własny adres ani na swój alias, a poza domenę tylko
  przy włączonej bramce wychodzącej. Przycisk „Wyłącz" kasuje przekierowanie.

  Zwroty i wiadomości od Zespołu nie są przesyłane dalej, a łańcuch
  przekierowań (gdy adresat też przesyła gdzie indziej) urywa się po trzech
  krokach. Dzięki temu dwie skrzynki ustawione na siebie nawzajem
  nie zapętlą się.

### Skrzynki zespołowe

Skrzynka zespołowa to wspólny adres, na przykład `sprzedaz@twojapoczta.com`,
z własną nazwą. Poczta na ten adres trafia do skrzynek wszystkich członków.
Zespoły zakłada i prowadzi administrator, więc tej sekcji nie da się zmienić
z poziomu skrzynki; jeśli do żadnego nie należysz, nie widzisz jej wcale.

Znacznik przy zespole mówi, co Ci wolno. „Odbiór" znaczy, że dostajesz pocztę.
„Odbiór i wysyłka" znaczy, że adres zespołu pojawi się też w polu **Od** przy
pisaniu listu. Wysłany stamtąd list podpisuje się nazwą zespołu, a nie Twoim
imieniem, i odpowiedź wróci do całego zespołu.

## Prywatność

Twoja poczta mieszka na serwerze, którym zarządzasz Ty albo ktoś, komu ufasz.
Nikt nie skanuje treści pod reklamy, nic nie wychodzi do zewnętrznych usług
analitycznych, a cała skrzynka to jeden plik, który można w każdej chwili
skopiować albo skasować.
