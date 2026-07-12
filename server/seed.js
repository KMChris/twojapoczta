// Demo data: a believable Polish inbox that shows off every UI state.

import { hashPassword } from './auth.js';
import { now } from './db.js';
import { deliverSystemMessage, addressOf, makeSnippet, SYSTEM_SENDER } from './mail.js';

export const WELCOME_SUBJECT = 'Witaj w TwojejPoczcie 👋';

export const WELCOME_BODY = `Cześć!

Twoja skrzynka właśnie ruszyła. Twój serwer, Twoje dane, Twoje zasady.

Na dobry początek trzy rzeczy, które warto znać:

1. Skróty klawiszowe. Naciśnij „c", żeby napisać wiadomość, „/" żeby szukać,
   „j" i „k" żeby poruszać się po liście. Pełna lista: naciśnij „?".

2. Paleta poleceń. Ctrl+K otwiera jedno okienko do wszystkiego: folderów,
   akcji i ustawień. Szybciej się nie da.

3. Ustawienia. W prawym górnym rogu zmienisz nazwę, podpis i motyw
   (jasny, nocna sortownia albo jak system).

Coś nie działa? Odpowiedz na tę wiadomość. A tak poważnie: to Twój serwer,
więc i logi są Twoje.

Miłego pisania!
Zespół TwojaPoczta
zespol@${'twojapoczta.com'}`;

const HOURS = 3600_000;
const DAYS = 24 * HOURS;

function at(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}

export async function seedIfEmpty(db) {
  // Na produkcji (TP_SEED=0) nie tworzymy kont demo o publicznie znanym haśle.
  if (process.env.TP_SEED === '0') return false;
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (existing.n > 0) return false;

  const password = await hashPassword('demo1234');
  const insertUser = db.prepare(
    'INSERT INTO users (login, name, password_hash, signature, theme, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const users = {};
  const roster = [
    ['demo', 'Jan Demowski', 'Pozdrawiam,\nJan'],
    [SYSTEM_SENDER.login, SYSTEM_SENDER.name, ''],
    ['ania', 'Ania Nowakowska', 'Ania'],
    ['michal', 'Michał Krajewski', 'M.'],
    ['biuro', 'Biuro TwojaPoczta', ''],
  ];
  for (const [login, name, signature] of roster) {
    const r = insertUser.run(login, name, password, signature, 'system', now());
    users[login] = Number(r.lastInsertRowid);
  }

  const insert = db.prepare(
    `INSERT INTO messages
       (owner_id, folder, from_name, from_addr, to_addr, subject, body, snippet,
        is_read, is_starred, is_priority, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const demo = users.demo;
  const demoAddr = addressOf('demo');

  const put = (folder, fromLogin, fromName, subject, body, opts = {}) => {
    insert.run(
      opts.owner ?? demo,
      folder,
      fromName,
      addressOf(fromLogin),
      opts.to ?? demoAddr,
      subject,
      body,
      makeSnippet(body),
      opts.unread ? 0 : 1,
      opts.starred ? 1 : 0,
      opts.priority ? 1 : 0,
      opts.at ?? now()
    );
  };

  // --- Inbox ---------------------------------------------------------------
  deliverSystemMessage(db, demo, {
    subject: WELCOME_SUBJECT,
    body: WELCOME_BODY,
    priority: true,
    sentAt: at(2 * HOURS),
  });

  put(
    'inbox', 'zespol', SYSTEM_SENDER.name,
    'Ściąga: skróty klawiszowe',
    `Wydrukuj albo zapamiętaj. Po tygodniu wejdzie w krew:

c · nowa wiadomość           / · szukaj
j, k · następna, poprzednia  Enter · otwórz
e · archiwizuj               s · gwiazdka
# · do kosza                 u · oznacz jako nieprzeczytane
g i · Odebrane               g s · Wysłane
Ctrl+K · paleta poleceń      ? · ta ściąga

Zespół TwojaPoczta`,
    { unread: true, at: at(2 * HOURS - 60_000) }
  );

  put(
    'inbox', 'michal', 'Michał Krajewski',
    'Plan na sobotę: rower?',
    `Cześć Janek,

jedziemy w sobotę nad Zalew? Prognoza wygląda przyzwoicie, 24 stopnie
i bez deszczu. Wyjazd 9:00 spod mostku, jak zwykle.

Daj znać do piątku, to zarezerwuję stolik w tej smażalni na końcu trasy.

M.`,
    { unread: true, at: at(5 * HOURS) }
  );

  put(
    'inbox', 'ania', 'Ania Nowakowska',
    'Zdjęcia z Mazur ⛵',
    `Janek, cześć!

Wrzuciłam w końcu zdjęcia z rejsu na dysk, link masz w poprzedniej
wiadomości. Te z zachodu słońca nad Śniardwami wyszły najlepiej,
szczególnie to, na którym walczysz z grillem :)

Odzywaj się, jak będziesz w Olsztynie!
Ania`,
    { starred: true, at: at(1 * DAYS + 3 * HOURS) }
  );

  put(
    'inbox', 'biuro', 'Serwerownia.pl (faktury)',
    'Faktura VAT 07/2026 za serwer VPS',
    `Dzień dobry,

w załączeniu faktura VAT nr 07/2026/8841 za usługę VPS „Sopel-2"
(2 vCPU, 4 GB RAM) za okres 01.07–31.07.2026.

Kwota: 42,00 zł brutto
Termin płatności: 14.07.2026
Nr konta: 12 3456 0000 7890 1234 5678 9012

To na tym serwerze działa Twoja poczta. Miło nam gościć.

Serwerownia.pl`,
    { at: at(2 * DAYS) }
  );

  put(
    'inbox', 'zespol', SYSTEM_SENDER.name,
    'Pocztówka nr 12: co nowego w TwojejPoczcie',
    `Krótko i konkretnie, jak co miesiąc:

• Wyszukiwarka rozumie teraz zapytania po nadawcy i temacie.
• Tryb ciemny „nocna sortownia" dostał poprawiony kontrast.
• Szkice zapisują się same, zanim zdążysz o tym pomyśleć.

Cały changelog znajdziesz na stronie projektu.

Do następnej pocztówki!
Zespół TwojaPoczta`,
    { at: at(3 * DAYS) }
  );

  put(
    'inbox', 'ania', 'Ania Nowakowska',
    'Re: Weekend w górach',
    `Świetnie, że się zebraliśmy! Schronisko potwierdzone na 18–20 września,
pokój czteroosobowy. Zaliczkę wpłaciłam, rozliczymy się na miejscu.

Bierz dobre buty, trasa na Babią pod koniec robi się kamienista.

Ania`,
    { at: at(6 * DAYS) }
  );

  // --- Spam ---------------------------------------------------------------
  put(
    'spam', 'biuro', 'Loteria Międzynarodowa',
    'GRATULACJE!!! Wygrałeś 1 000 000 zł',
    `Szanowny Zwyciezco!

Twoj adres e-mail zostal wylosowany w Wielkiej Loterii Miedzynarodowej.
Aby odebrac nagrode 1.000.000 PLN wystarczy oplacic drobna oplate
manipulacyjna 199 zl...

(Klasyka gatunku. Ta wiadomość trafiła tu, żeby pokazać folder Spam.)`,
    { unread: true, at: at(4 * DAYS) }
  );

  // --- Drafts --------------------------------------------------------------
  put(
    'drafts', 'demo', 'Jan Demowski',
    'Wniosek o urlop w sierpniu',
    `Dzień dobry,

chciałbym złożyć wniosek o urlop w dniach 10–21 sierpnia. Projekt
„Migracja" będzie wtedy po wdrożeniu, a bieżące sprawy przejmie`,
    { to: `biuro@${'twojapoczta.com'}`, at: at(26 * HOURS) }
  );

  // --- Sent ----------------------------------------------------------------
  put(
    'sent', 'demo', 'Jan Demowski',
    'Weekend w górach',
    `Cześć Aniu,

wchodzę w to! Wrzesień pasuje idealnie, byle nie ten weekend z maratonem.
Zarezerwujesz schronisko, czy mam się tym zająć?

Pozdrawiam,
Jan`,
    { to: `ania@${'twojapoczta.com'}`, at: at(7 * DAYS) }
  );

  put(
    'sent', 'demo', 'Jan Demowski',
    'Re: Plan na sobotę: rower?',
    `Jasne, 9:00 spod mostku. Biorę łatki i pompkę, bo ostatnio skończyło się
prowadzeniem roweru 8 km.

Jan`,
    { to: `michal@${'twojapoczta.com'}`, at: at(4 * HOURS) }
  );

  // --- Archive & Trash ------------------------------------------------------
  put(
    'archive', 'biuro', 'Rejestrator domen',
    'Potwierdzenie rejestracji domeny twojapoczta.com',
    `Dzień dobry,

potwierdzamy rejestrację domeny twojapoczta.com na okres 12 miesięcy.
Serwery DNS skierowane zgodnie z dyspozycją. Powodzenia z projektem!

Zespół rejestratora`,
    { at: at(9 * DAYS) }
  );

  put(
    'trash', 'michal', 'Michał Krajewski',
    'stary łańcuszek, nie czytaj',
    `Prześlij to do 10 osób albo... no właśnie, nic się nie stanie.
Dlatego ta wiadomość leży w koszu.`,
    { at: at(8 * DAYS) }
  );

  return true;
}
