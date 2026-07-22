// Jednostkowe testy logiki poczty: adresy, foldery, doręczanie wewnętrzne, wersje
// robocze, wyszukiwanie, cykl życia wiadomości. Każdy test = świeża baza in-memory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openMemoryDb, now } from '../server/db.js';
import { saveUpload } from '../server/attachments.js';
import { createTeam, setMember } from '../server/teams.js';
import {
  DOMAIN, addressOf, findMailbox, makeSnippet, parseRecipients,
  listMessages, getMessage, updateMessage, deleteMessage, unreadCounts,
  saveDraft, sendMessage, deliverInbound, deliverSystemMessage, REAL_FOLDERS,
  fireScheduled, resolveSender, setForwarding, getForwarding,
  MAX_BODY_HTML_BYTES,
} from '../server/mail.js';

// Fałszywy serwer SMTP, który przyjmuje wszystko i oddaje surowe bajty listu.
// Potrzebny, bo dopiero na drucie widać to, czego wiersz w `messages` nie pokazuje:
// czy `cid:` ma jeszcze kotwicę Content-ID i co klient spoza domeny czyta w `From`.
function startSink() {
  const odebrane = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let wDanych = false;
    let dane = '';
    sock.write('220 sink ESMTP\r\n');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const linia = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (wDanych) {
          if (linia === '.') {
            wDanych = false;
            odebrane.push(dane);
            dane = '';
            sock.write('250 2.0.0 ok\r\n');
          } else dane += linia + '\r\n';
          continue;
        }
        const cmd = linia.slice(0, 4).toUpperCase();
        if (cmd === 'DATA') {
          sock.write('354 dawaj\r\n');
          wDanych = true;
        } else if (cmd === 'QUIT') {
          sock.write('221 pa\r\n');
          sock.end();
        } else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => sock.destroy());
  });
  return { server, odebrane };
}

function fresh() {
  const db = openMemoryDb();
  const users = {};
  for (const [login, name] of [['demo', 'Jan Demowski'], ['ania', 'Ania'], ['michal', 'Michał']]) {
    users[login] = Number(
      db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(login, name, 'x', now()).lastInsertRowid
    );
  }
  const user = (login) => ({ id: users[login], login, name: db.prepare('SELECT name FROM users WHERE id = ?').get(users[login]).name });
  return { db, users, user };
}

// --- Funkcje czyste ----------------------------------------------------------

test('addressOf skleja login z domeną', () => {
  assert.equal(addressOf('demo'), `demo@${DOMAIN}`);
});

test('parseRecipients: rozdziela, przycina, zmniejsza litery, odsiewa puste', () => {
  assert.deepEqual(parseRecipients(' A@X.pl , b@y.pl;C@Z.pl ,, '), ['a@x.pl', 'b@y.pl', 'c@z.pl']);
  assert.deepEqual(parseRecipients(null), []);
  assert.deepEqual(parseRecipients(''), []);
});

test('makeSnippet: zwija białe znaki i przycina do 140', () => {
  assert.equal(makeSnippet('  Ala\n\n ma   kota  '), 'Ala ma kota');
  assert.equal(makeSnippet('x'.repeat(300)).length, 140);
});

test('findMailbox: rozwiązuje login, alias i zwraca null dla nieznanych', () => {
  const { db, users } = fresh();
  db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(users.ania, 'ksiegowa', now());
  assert.equal(findMailbox(db, 'demo').id, users.demo);
  assert.equal(findMailbox(db, 'ksiegowa').id, users.ania);
  assert.equal(findMailbox(db, 'nieznany'), null);
  db.close();
});

// --- listMessages ------------------------------------------------------------

test('listMessages: filtruje po folderze, gwiazdka pomija kosz/spam, nieznany folder → []', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  sendMessage(db, demo, { to: addressOf('ania'), subject: 'A', body: 'raz' });
  // oznacz wiadomość w Wysłanych gwiazdką
  const [sent] = listMessages(db, demo.id, { folder: 'sent' });
  updateMessage(db, demo.id, sent.id, { is_starred: true });

  assert.equal(listMessages(db, demo.id, { folder: 'sent' }).length, 1);
  assert.ok(listMessages(db, demo.id, { folder: 'starred' }).some((m) => m.id === sent.id));
  assert.deepEqual(listMessages(db, demo.id, { folder: 'nieistnieje' }), []);
  db.close();
});

test('listMessages: gwiazdkowana wiadomość w koszu nie pojawia się w „starred”', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverSystemMessage(db, demo.id, { subject: 'S', body: 'x' });
  const [msg] = listMessages(db, demo.id, { folder: 'inbox' });
  updateMessage(db, demo.id, msg.id, { is_starred: true, folder: 'trash' });
  assert.equal(listMessages(db, demo.id, { folder: 'starred' }).length, 0);
  db.close();
});

test('listMessages: wyszukiwanie escapuje znaki LIKE (%,_,\\)', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverSystemMessage(db, demo.id, { subject: '100% rabatu', body: 'x' });
  deliverSystemMessage(db, demo.id, { subject: 'zwykły temat', body: 'y' });
  // „%” jako literał: trafia tylko w „100% rabatu”, nie działa jak wieloznacznik
  assert.equal(listMessages(db, demo.id, { folder: 'inbox', q: '100%' }).length, 1);
  assert.equal(listMessages(db, demo.id, { folder: 'inbox', q: '%' }).length, 1);
  db.close();
});

test('listMessages: szuka po treści, nadawcy i adresie', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  sendMessage(db, demo, { to: addressOf('ania'), subject: 'temat', body: 'wyjątkowe-słowo-kluczowe' });
  assert.equal(listMessages(db, demo.id, { folder: 'sent', q: 'wyjątkowe-słowo' }).length, 1);
  db.close();
});

// --- updateMessage -----------------------------------------------------------

test('updateMessage: is_read / is_starred / folder', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverSystemMessage(db, demo.id, { subject: 'S', body: 'x' });
  const [m] = listMessages(db, demo.id, { folder: 'inbox' });

  assert.equal(updateMessage(db, demo.id, m.id, { is_read: true }).is_read, 1);
  assert.equal(updateMessage(db, demo.id, m.id, { is_read: false }).is_read, 0);
  assert.equal(updateMessage(db, demo.id, m.id, { is_starred: true }).is_starred, 1);
  assert.equal(updateMessage(db, demo.id, m.id, { folder: 'archive' }).folder, 'archive');
  db.close();
});

test('updateMessage: nieprawidłowy folder → null, pusty patch → bez zmian', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverSystemMessage(db, demo.id, { subject: 'S', body: 'x' });
  const [m] = listMessages(db, demo.id, { folder: 'inbox' });
  assert.equal(updateMessage(db, demo.id, m.id, { folder: 'nieistnieje' }), null);
  const bezZmian = updateMessage(db, demo.id, m.id, {});
  assert.equal(bezZmian.id, m.id);
  db.close();
});

// --- deleteMessage -----------------------------------------------------------

test('deleteMessage: brak → deleted=false', () => {
  const { db, user } = fresh();
  assert.deepEqual(deleteMessage(db, user('demo').id, 9999), { deleted: false });
  db.close();
});

test('deleteMessage: dwustopniowo (do kosza, potem trwałe usunięcie)', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverSystemMessage(db, demo.id, { subject: 'S', body: 'x' });
  const [m] = listMessages(db, demo.id, { folder: 'inbox' });

  assert.deepEqual(deleteMessage(db, demo.id, m.id), { deleted: true, purged: false });
  assert.equal(getMessage(db, demo.id, m.id).folder, 'trash');
  assert.deepEqual(deleteMessage(db, demo.id, m.id), { deleted: true, purged: true });
  assert.equal(getMessage(db, demo.id, m.id), undefined);
  db.close();
});

test('deleteMessage: trwałe usunięcie z załącznikiem odpala GC blobów', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  // wyślij do siebie z załącznikiem, przenieś kopię z Odebranych do kosza i usuń
  const { upload } = saveUpload(db, demo.id, { filename: 'a.txt', mime: 'text/plain', buffer: Buffer.from('dane') });
  sendMessage(db, demo, { to: addressOf('demo'), subject: 'do siebie', body: 'x', uploads: [upload.token] });
  const [inbox] = listMessages(db, demo.id, { folder: 'inbox' });
  assert.equal(inbox.attachments_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 1);

  deleteMessage(db, demo.id, inbox.id); // → kosz
  deleteMessage(db, demo.id, inbox.id); // → trwałe + GC
  // kopia w Wysłanych wciąż trzyma ten sam blob, więc blob żyje
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 1);
  db.close();
});

test('deleteMessage: odrzucona wersja robocza trafia do kosza i znika z licznika', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  const robocza = saveDraft(db, demo, { to: '', subject: 'W', body: 'x' });
  assert.equal(unreadCounts(db, demo.id).drafts, 1);

  assert.deepEqual(deleteMessage(db, demo.id, robocza.id), { deleted: true, purged: false });
  assert.equal(getMessage(db, demo.id, robocza.id).folder, 'trash');
  assert.equal(unreadCounts(db, demo.id).drafts, 0);

  assert.deepEqual(deleteMessage(db, demo.id, robocza.id), { deleted: true, purged: true });
  assert.equal(getMessage(db, demo.id, robocza.id), undefined);
  db.close();
});

// --- unreadCounts ------------------------------------------------------------

test('unreadCounts: liczy nieprzeczytane w inbox/spam i wersje robocze', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverSystemMessage(db, demo.id, { subject: 'a', body: 'x' });
  deliverSystemMessage(db, demo.id, { subject: 'b', body: 'x' });
  db.prepare("INSERT INTO messages (owner_id, folder, from_addr, is_read, sent_at) VALUES (?, 'spam', 'x@y.pl', 0, ?)").run(demo.id, now());
  saveDraft(db, demo, { to: '', subject: 'szkic', body: 'x' });

  const c = unreadCounts(db, demo.id);
  assert.equal(c.inbox, 2);
  assert.equal(c.spam, 1);
  assert.equal(c.drafts, 1);
  db.close();
});

// --- saveDraft ---------------------------------------------------------------

test('saveDraft: tworzy i aktualizuje wersję roboczą', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  const d = saveDraft(db, demo, { to: 'ania@twojapoczta.com', subject: 'Szkic', body: 'wersja 1' });
  assert.equal(d.folder, 'drafts');
  assert.equal(d.is_read, 1);
  const u = saveDraft(db, demo, { id: d.id, to: 'ania@twojapoczta.com', subject: 'Szkic', body: 'wersja 2' });
  assert.equal(u.body, 'wersja 2');
  assert.equal(listMessages(db, demo.id, { folder: 'drafts' }).length, 1);
  db.close();
});

test('saveDraft: aktualizacja nieistniejącej lub nie-roboczej wiadomości → null', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  assert.equal(saveDraft(db, demo, { id: 9999, to: '', subject: 'x', body: 'x' }), null);
  deliverSystemMessage(db, demo.id, { subject: 'wiadomość', body: 'x' });
  const [inbox] = listMessages(db, demo.id, { folder: 'inbox' });
  assert.equal(saveDraft(db, demo, { id: inbox.id, to: '', subject: 'x', body: 'x' }), null);
  db.close();
});

// --- sendMessage: walidacja --------------------------------------------------

test('sendMessage: brak adresata → błąd', () => {
  const { db, user } = fresh();
  assert.match(sendMessage(db, user('demo'), { to: '', subject: 'x', body: 'x' }).error, /co najmniej jednego/);
  db.close();
});

test('sendMessage: niepoprawny adres i @bez-localu → błąd', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  assert.match(sendMessage(db, demo, { to: 'bez-malpy', subject: 'x', body: 'x' }).error, /niepoprawny/);
  assert.match(sendMessage(db, demo, { to: '@twojapoczta.com', subject: 'x', body: 'x' }).error, /niepoprawny/);
  db.close();
});

test('sendMessage: nieznana skrzynka w naszej domenie → błąd', () => {
  const { db, user } = fresh();
  assert.match(sendMessage(db, user('demo'), { to: 'nikt@twojapoczta.com', subject: 'x', body: 'x' }).error, /Nie znaleziono/);
  db.close();
});

test('sendMessage: adres zewnętrzny bez TP_EXTERNAL → błąd', () => {
  const { db, user } = fresh();
  assert.match(sendMessage(db, user('demo'), { to: 'ktos@gmail.com', subject: 'x', body: 'x' }).error, /tylko w domenie/);
  db.close();
});

test('sendMessage: z TP_EXTERNAL=1 błędny format adresu zewnętrznego → błąd', () => {
  process.env.TP_EXTERNAL = '1';
  try {
    const { db, user } = fresh();
    assert.match(sendMessage(db, user('demo'), { to: 'ktos@bezkropki', subject: 'x', body: 'x' }).error, /niepoprawny/);
    db.close();
  } finally {
    delete process.env.TP_EXTERNAL;
  }
});

// --- sendMessage: doręczanie -------------------------------------------------

test('sendMessage: kopia w Wysłanych u nadawcy, w Odebranych u odbiorcy', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  const r = sendMessage(db, demo, { to: addressOf('ania'), subject: 'Cześć', body: 'treść', priority: true });
  assert.equal(r.message.folder, 'sent');
  assert.equal(r.message.is_priority, 1);

  const aniaInbox = listMessages(db, user('ania').id, { folder: 'inbox' });
  assert.equal(aniaInbox.length, 1);
  assert.equal(aniaInbox[0].is_read, 0);
  assert.equal(aniaInbox[0].from_addr, addressOf('demo'));
  db.close();
});

test('sendMessage: wysyłka do siebie tworzy kopię w Odebranych', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  sendMessage(db, demo, { to: addressOf('demo'), subject: 'notatka', body: 'do siebie' });
  assert.equal(listMessages(db, demo.id, { folder: 'sent' }).length, 1);
  assert.equal(listMessages(db, demo.id, { folder: 'inbox' }).length, 1);
  db.close();
});

test('sendMessage: alias + adres wprost = jedna kopia u odbiorcy', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(user('ania').id, 'ksiegowa', now());
  sendMessage(db, demo, { to: 'ksiegowa@twojapoczta.com, ania@twojapoczta.com', subject: 'raz', body: 'x' });
  assert.equal(listMessages(db, user('ania').id, { folder: 'inbox' }).length, 1);
  db.close();
});

test('sendMessage: pusty temat → „(bez tematu)”, draftId kasuje wersję roboczą', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  const draft = saveDraft(db, demo, { to: addressOf('ania'), subject: 'szkic', body: 'x' });
  const r = sendMessage(db, demo, { to: addressOf('ania'), subject: '   ', body: 'x', draftId: draft.id });
  assert.equal(r.message.subject, '(bez tematu)');
  assert.equal(listMessages(db, demo.id, { folder: 'drafts' }).length, 0);
  db.close();
});

// --- deliverInbound ----------------------------------------------------------

test('deliverInbound: wstawia wiadomość z parsera i liczy załączniki', () => {
  const { db, user } = fresh();
  const ania = user('ania');
  const parsed = {
    from: { name: 'Obcy', addr: 'obcy@example.com' },
    subject: 'Z zewnątrz',
    body: 'treść',
    attachments: [{ filename: 'p.txt', mime: 'text/plain', data: Buffer.from('dane') }],
  };
  const id = deliverInbound(db, ania.id, parsed, { toAddr: 'ania@twojapoczta.com' });
  const m = getMessage(db, ania.id, id);
  assert.equal(m.folder, 'inbox');
  assert.equal(m.from_addr, 'obcy@example.com');
  assert.equal(m.attachments_count, 1);
  db.close();
});

test('deliverInbound: pusty temat → „(bez tematu)”', () => {
  const { db, user } = fresh();
  const id = deliverInbound(db, user('ania').id, { from: { addr: 'a@b.pl' }, subject: '', body: 'x', attachments: [] }, { toAddr: '' });
  assert.equal(getMessage(db, user('ania').id, id).subject, '(bez tematu)');
  db.close();
});

// --- deliverSystemMessage ----------------------------------------------------

test('deliverSystemMessage: wiadomość od Zespołu, priorytet i nieprzeczytana', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverSystemMessage(db, demo.id, { subject: 'Witaj', body: 'x', priority: true });
  const [m] = listMessages(db, demo.id, { folder: 'inbox' });
  assert.equal(m.is_priority, 1);
  assert.equal(m.is_read, 0);
  assert.match(m.from_addr, /^zespol@/);
  db.close();
});

test('REAL_FOLDERS zawiera oczekiwane katalogi', () => {
  // 'custom' to wartownik folderu własnego (Task 4): legalna wartość messages.folder,
  // ale nie osobny katalog do przeglądania — po to istnieje BUILTIN_FOLDERS.
  assert.deepEqual(REAL_FOLDERS, ['inbox', 'sent', 'drafts', 'scheduled', 'archive', 'spam', 'trash', 'custom']);
});

// --- Wycofanie transakcji (ROLLBACK) na błędzie ------------------------------

test('sendMessage: błąd w transakcji wycofuje zmiany i rzuca', () => {
  const { db, user } = fresh();
  // nadawca o nieistniejącym id: wstawienie kopii łamie klucz obcy w środku transakcji
  const widmo = { id: 999999, login: 'demo', name: 'Widmo' };
  assert.throws(() => sendMessage(db, widmo, { to: addressOf('ania'), subject: 'x', body: 'x' }));
  // nic nie zostało: ani u „nadawcy", ani u odbiorcy
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  db.close();
});

test('deliverInbound: błąd wstawienia wycofuje transakcję i rzuca', () => {
  const { db } = fresh();
  const parsed = { from: { addr: 'a@b.pl' }, subject: 's', body: 'x', attachments: [] };
  assert.throws(() => deliverInbound(db, 999999, parsed, { toAddr: 'x@y.pl' }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
  db.close();
});

// --- Wysyłka zewnętrzna z załącznikiem: kopia + odbicie ----------------------

test('sendMessage: wysyłka na zewnątrz z załącznikiem zostawia kopię i wraca odbiciem', async () => {
  process.env.TP_EXTERNAL = '1';
  process.env.TP_SMTP_ROUTE = '127.0.0.1:1'; // martwy port, doręczenie musi się nie udać
  try {
    const { db, user } = fresh();
    const demo = user('demo');
    const { upload } = saveUpload(db, demo.id, { filename: 'raport.txt', mime: 'text/plain', buffer: Buffer.from('dane raportu') });
    const r = sendMessage(db, demo, {
      to: 'ktos@zewnetrzna.example',
      subject: 'Na zewnątrz z plikiem',
      body: 'treść',
      uploads: [upload.token],
    });
    assert.equal(r.message.folder, 'sent');
    assert.equal(r.message.attachments_count, 1);

    let odbicie = null;
    for (let i = 0; i < 80 && !odbicie; i++) {
      await new Promise((res) => setTimeout(res, 25));
      odbicie = listMessages(db, demo.id, { folder: 'inbox' }).find((m) => m.subject.startsWith('Zwrot do nadawcy'));
    }
    assert.ok(odbicie, 'odbicie powinno trafić do Odebranych');
    assert.match(getMessage(db, demo.id, odbicie.id).body, /ktos@zewnetrzna\.example/);
    db.close();
  } finally {
    delete process.env.TP_EXTERNAL;
    delete process.env.TP_SMTP_ROUTE;
  }
});

// --- DW, UDW, alias nadawcy ----------------------------------------------------

test('sendMessage: DW dociera i jest widoczne, UDW dociera bez śladu w kopiach', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  const wynik = sendMessage(db, demo, {
    to: addressOf('ania'),
    cc: addressOf('michal'),
    subject: 'Narada',
    body: 'x',
  });
  assert.ok(!wynik.error);

  const [uAni] = listMessages(db, users.ania, { folder: 'inbox' });
  const [uMichala] = listMessages(db, users.michal, { folder: 'inbox' });
  assert.equal(uAni.cc_addr, addressOf('michal'));
  assert.ok(uMichala, 'adresat DW dostaje kopię');

  // UDW: michal dostaje, ale ani adresat, ani on sam nie widzi listy UDW
  const udw = sendMessage(db, demo, {
    to: addressOf('ania'),
    bcc: addressOf('michal'),
    subject: 'Poufne',
    body: 'y',
  });
  assert.ok(!udw.error);
  const kopiaAni = getMessage(db, users.ania, listMessages(db, users.ania, { folder: 'inbox' })[0].id);
  const kopiaMichala = getMessage(db, users.michal, listMessages(db, users.michal, { folder: 'inbox' })[0].id);
  assert.equal(kopiaAni.bcc_addr, '');
  assert.equal(kopiaMichala.bcc_addr, '');
  assert.ok(!kopiaAni.to_addr.includes('michal'));
  // nadawca w swojej kopii „Wysłane" widzi pełną listę UDW
  const [wyslana] = listMessages(db, users.demo, { folder: 'sent' });
  assert.equal(getMessage(db, users.demo, wyslana.id).bcc_addr, addressOf('michal'));
  db.close();
});

test('sendMessage: sam UDW wystarcza za adresata', () => {
  const { db, user, users } = fresh();
  const wynik = sendMessage(db, user('demo'), { to: '', bcc: addressOf('ania'), subject: 'U', body: 'x' });
  assert.ok(!wynik.error);
  assert.equal(listMessages(db, users.ania, { folder: 'inbox' }).length, 1);
  db.close();
});

test('resolveSender i sendMessage: własny alias tak, cudzy adres nie', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(users.demo, 'biuro-jana', now());

  // Alias nadaje imieniem właściciela: tożsamość zmienia wyłącznie zespół.
  assert.deepEqual(resolveSender(db, demo, ''), { addr: addressOf('demo'), name: demo.name });
  assert.deepEqual(resolveSender(db, demo, addressOf('biuro-jana')), { addr: addressOf('biuro-jana'), name: demo.name });
  assert.equal(resolveSender(db, demo, addressOf('ania')), null);
  assert.equal(resolveSender(db, demo, 'ktos@obca.pl'), null);

  const zAliasu = sendMessage(db, demo, { to: addressOf('ania'), from: addressOf('biuro-jana'), subject: 'A', body: 'x' });
  assert.ok(!zAliasu.error);
  const [uAni] = listMessages(db, users.ania, { folder: 'inbox' });
  assert.equal(uAni.from_addr, addressOf('biuro-jana'));
  assert.equal(uAni.from_name, demo.name);

  const zCudzego = sendMessage(db, demo, { to: addressOf('ania'), from: addressOf('michal'), subject: 'B', body: 'x' });
  assert.match(zCudzego.error, /własnych aliasów/);
  db.close();
});

test('saveDraft: przechowuje DW, UDW, nadawcę-alias i HTML', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(users.demo, 'praca', now());
  const d = saveDraft(db, demo, {
    to: addressOf('ania'),
    cc: addressOf('michal'),
    bcc: addressOf('demo'),
    from: addressOf('praca'),
    subject: 'Robocza',
    body: 'tekst',
    bodyHtml: '<p>tekst <strong>bogaty</strong></p>',
  });
  assert.equal(d.cc_addr, addressOf('michal'));
  assert.equal(d.bcc_addr, addressOf('demo'));
  assert.equal(d.from_addr, addressOf('praca'));
  assert.equal(d.body_html, '<p>tekst <strong>bogaty</strong></p>');
  // cudzy nadawca w wersji roboczej po cichu wraca na adres główny
  const d2 = saveDraft(db, demo, { id: d.id, to: '', from: addressOf('ania'), subject: '', body: '' });
  assert.equal(d2.from_addr, addressOf('demo'));
  db.close();
});

// --- Zaplanowana wysyłka --------------------------------------------------------

test('sendMessage: termin w przyszłości odkłada list do Zaplanowanych', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  const draft = saveDraft(db, demo, { to: addressOf('ania'), subject: 'Później', body: 'x' });
  const za2h = new Date(Date.now() + 2 * 3600_000).toISOString();
  const wynik = sendMessage(db, demo, {
    to: addressOf('ania'), subject: 'Później', body: 'x', scheduledAt: za2h, draftId: draft.id,
  });
  assert.ok(wynik.scheduled);
  assert.equal(wynik.message.folder, 'scheduled');
  assert.equal(wynik.message.scheduled_at, za2h);
  assert.equal(unreadCounts(db, users.demo).scheduled, 1);
  assert.equal(unreadCounts(db, users.demo).drafts, 0, 'wersja robocza znika po zaplanowaniu');
  assert.equal(listMessages(db, users.ania, { folder: 'inbox' }).length, 0, 'nic jeszcze nie doręczono');
  db.close();
});

test('sendMessage: termin z przeszłości albo bełkot → błąd', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  const wczoraj = new Date(Date.now() - 24 * 3600_000).toISOString();
  assert.match(sendMessage(db, demo, { to: addressOf('ania'), body: 'x', scheduledAt: wczoraj }).error, /przyszłości/);
  assert.match(sendMessage(db, demo, { to: addressOf('ania'), body: 'x', scheduledAt: 'za tydzien' }).error, /Nieprawidłowa data/);
  const za2lata = new Date(Date.now() + 2 * 366 * 24 * 3600_000).toISOString();
  assert.match(sendMessage(db, demo, { to: addressOf('ania'), body: 'x', scheduledAt: za2lata }).error, /rok naprzód/);
  db.close();
});

test('fireScheduled: nadaje dojrzałe listy z załącznikami i sprząta Zaplanowane', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  const { upload } = saveUpload(db, users.demo, { filename: 'plan.txt', mime: 'text/plain', buffer: Buffer.from('agenda') });
  const za1h = new Date(Date.now() + 3600_000).toISOString();
  const wynik = sendMessage(db, demo, {
    to: addressOf('ania'), cc: addressOf('michal'), subject: 'Dojrzeje', body: 'tresc',
    bodyHtml: '<p>tresc</p>', scheduledAt: za1h, uploads: [upload.token],
  });
  assert.ok(wynik.scheduled);
  assert.equal(wynik.message.attachments_count, 1);

  // jeszcze nie czas
  assert.equal(fireScheduled(db), 0);

  // przesuwamy termin w przeszłość i budzimy strażnika
  const minelo = new Date(Date.now() - 1000).toISOString();
  db.prepare('UPDATE messages SET scheduled_at = ? WHERE id = ?').run(minelo, wynik.message.id);
  assert.equal(fireScheduled(db), 1);

  assert.equal(unreadCounts(db, users.demo).scheduled, 0);
  const [uAni] = listMessages(db, users.ania, { folder: 'inbox' });
  assert.equal(uAni.subject, 'Dojrzeje');
  assert.equal(uAni.attachments_count, 1);
  assert.equal(getMessage(db, users.ania, uAni.id).body_html, '<p>tresc</p>');
  const [uMichala] = listMessages(db, users.michal, { folder: 'inbox' });
  assert.equal(uMichala.attachments_count, 1);
  const [wyslana] = listMessages(db, users.demo, { folder: 'sent' });
  assert.equal(wyslana.attachments_count, 1);
  // wspólne bloby: jedna treść, wiele kopii
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 1);
  db.close();
});

test('fireScheduled: znikła skrzynka adresata → zwrot do nadawcy, reszta doręczona', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  const za1h = new Date(Date.now() + 3600_000).toISOString();
  const wynik = sendMessage(db, demo, {
    to: `${addressOf('ania')}, ${addressOf('michal')}`, subject: 'Do dwojga', body: 'x', scheduledAt: za1h,
  });
  db.prepare('DELETE FROM users WHERE id = ?').run(users.michal);
  db.prepare('UPDATE messages SET scheduled_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), wynik.message.id);
  fireScheduled(db);

  assert.equal(listMessages(db, users.ania, { folder: 'inbox' }).length, 1);
  const zwrot = listMessages(db, users.demo, { folder: 'inbox' }).find((m) => m.subject.startsWith('Zwrot do nadawcy'));
  assert.ok(zwrot, 'nadawca dostaje zwrot o nieistniejącej skrzynce');
  db.close();
});

// --- Przesyłanie dalej ----------------------------------------------------------

test('setForwarding: ustawia, czyta i kasuje przekierowanie', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  assert.deepEqual(getForwarding(db, users.demo), { to: '', keepCopy: true });

  const ok = setForwarding(db, demo, { to: addressOf('ania'), keepCopy: false });
  assert.deepEqual(ok.forwarding, { to: addressOf('ania'), keepCopy: false });
  assert.deepEqual(getForwarding(db, users.demo), { to: addressOf('ania'), keepCopy: false });

  setForwarding(db, demo, { to: '' });
  assert.deepEqual(getForwarding(db, users.demo), { to: '', keepCopy: true });
  db.close();
});

test('setForwarding: własny adres, własny alias i nieznana skrzynka → błąd', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  db.prepare('INSERT INTO aliases (user_id, alias, created_at) VALUES (?, ?, ?)').run(users.demo, 'ja-inaczej', now());

  assert.match(setForwarding(db, demo, { to: addressOf('demo') }).error, /na własny adres/);
  assert.match(setForwarding(db, demo, { to: addressOf('ja-inaczej') }).error, /na własny adres/);
  assert.match(setForwarding(db, demo, { to: addressOf('nieznany') }).error, /Nie znaleziono skrzynki/);
  assert.match(setForwarding(db, demo, { to: 'bezmalpy' }).error, /niepoprawny/);
  // nic z tego nie zostało zapisane
  assert.equal(getForwarding(db, users.demo).to, '');
  db.close();
});

test('setForwarding: adres z obcej domeny wymaga włączonej bramki', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  assert.match(setForwarding(db, demo, { to: 'ja@gdzieindziej.pl' }).error, /tylko w domenie/);

  process.env.TP_EXTERNAL = '1';
  try {
    assert.equal(setForwarding(db, demo, { to: 'ja@gdzieindziej.pl' }).forwarding.to, 'ja@gdzieindziej.pl');
    assert.equal(getForwarding(db, users.demo).to, 'ja@gdzieindziej.pl');
  } finally {
    delete process.env.TP_EXTERNAL;
  }
  db.close();
});

test('przesyłanie dalej: poczta przychodząca trafia do celu, kopia zostaje', () => {
  const { db, user, users } = fresh();
  setForwarding(db, user('ania'), { to: addressOf('michal') });

  sendMessage(db, user('demo'), { to: addressOf('ania'), subject: 'Dla Ani', body: 'tresc', bodyHtml: '<p>tresc</p>' });

  const [uAni] = listMessages(db, users.ania, { folder: 'inbox' });
  assert.ok(uAni, 'oryginał zostaje w skrzynce Ani');
  const [uMichala] = listMessages(db, users.michal, { folder: 'inbox' });
  assert.equal(uMichala.subject, 'Dla Ani');
  // przesłana kopia zachowuje oryginalnego nadawcę i trafia jako nieprzeczytana
  assert.equal(uMichala.from_addr, addressOf('demo'));
  assert.equal(uMichala.to_addr, addressOf('michal'));
  assert.equal(uMichala.is_read, 0);
  assert.equal(getMessage(db, users.michal, uMichala.id).body_html, '<p>tresc</p>');
  db.close();
});

test('przesyłanie dalej: bez „zostaw kopię" oryginał ląduje w Archiwum', () => {
  const { db, user, users } = fresh();
  setForwarding(db, user('ania'), { to: addressOf('michal'), keepCopy: false });

  sendMessage(db, user('demo'), { to: addressOf('ania'), subject: 'Przelotem', body: 'x' });

  assert.equal(listMessages(db, users.ania, { folder: 'inbox' }).length, 0);
  const [zarchiwizowana] = listMessages(db, users.ania, { folder: 'archive' });
  assert.equal(zarchiwizowana.subject, 'Przelotem', 'poczta nie ginie, tylko schodzi z Odebranych');
  assert.equal(listMessages(db, users.michal, { folder: 'inbox' }).length, 1);
  db.close();
});

test('przesyłanie dalej: załączniki idą z listem, bloby zostają wspólne', () => {
  const { db, user, users } = fresh();
  setForwarding(db, user('ania'), { to: addressOf('michal') });
  const { upload } = saveUpload(db, users.demo, { filename: 'umowa.txt', mime: 'text/plain', buffer: Buffer.from('tresc') });

  sendMessage(db, user('demo'), { to: addressOf('ania'), subject: 'Z plikiem', body: 'x', uploads: [upload.token] });

  const [uMichala] = listMessages(db, users.michal, { folder: 'inbox' });
  assert.equal(uMichala.attachments_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM blobs').get().n, 1);
  db.close();
});

test('przesyłanie dalej: łańcuch A→B→C dochodzi do końca', () => {
  const { db, user, users } = fresh();
  const biuroId = Number(
    db.prepare('INSERT INTO users (login, name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('biuro', 'Biuro', 'x', now()).lastInsertRowid
  );
  setForwarding(db, user('ania'), { to: addressOf('michal') });
  setForwarding(db, user('michal'), { to: addressOf('biuro') });

  // List wchodzi z zewnątrz, bo tylko poczta przychodząca niesie `content_id`:
  // `bindUploads` nie ustawia go nigdy, więc `sendMessage` nie ma czym nakarmić łańcucha.
  deliverInbound(db, users.ania, {
    from: { name: 'Firma', addr: 'biuro@fir.ma' },
    subject: 'Sztafeta',
    body: 'x',
    html: '<p>Sztafeta</p><img src="cid:logo@fir.ma">',
    attachments: [{ filename: 'logo.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'logo@fir.ma' }],
  }, { toAddr: addressOf('ania') });

  assert.equal(listMessages(db, users.ania, { folder: 'inbox' }).length, 1);
  assert.equal(listMessages(db, users.michal, { folder: 'inbox' }).length, 1);
  const doBiura = listMessages(db, biuroId, { folder: 'inbox' });
  assert.equal(doBiura.length, 1, 'list dochodzi na koniec łańcucha');

  // Kotwica ma się domknąć także na drugim skoku: kopia kopii to osobne wywołanie
  // kopiowania, więc pierwszy skok sam z siebie niczego o drugim nie dowodzi.
  const htmlBiura = getMessage(db, biuroId, doBiura[0].id).body_html;
  const odwolanie = htmlBiura.match(/src="cid:([^"]+)"/)?.[1];
  assert.equal(odwolanie, 'logo@fir.ma', 'HTML na końcu łańcucha nadal niesie odwołanie cid:');
  const zalacznik = db.prepare('SELECT content_id FROM attachments WHERE message_id = ?').get(doBiura[0].id);
  assert.equal(zalacznik.content_id, odwolanie, 'załącznik po drugim skoku niesie content_id, na który wskazuje cid: w jego body_html');
  db.close();
});

test('przesyłanie dalej: pętla A→B→A zatrzymuje się i nie zalewa skrzynek', () => {
  const { db, user, users } = fresh();
  setForwarding(db, user('ania'), { to: addressOf('michal') });
  setForwarding(db, user('michal'), { to: addressOf('ania') });

  sendMessage(db, user('demo'), { to: addressOf('ania'), subject: 'W kółko', body: 'x' });

  // Ania: oryginał + jeden nawrót od Michała. Michał: jedna kopia. I koniec.
  assert.equal(listMessages(db, users.ania, { folder: 'inbox' }).length, 2);
  assert.equal(listMessages(db, users.michal, { folder: 'inbox' }).length, 1);
  db.close();
});

test('przesyłanie dalej: wiadomości systemowe nie idą dalej', () => {
  const { db, user, users } = fresh();
  setForwarding(db, user('ania'), { to: addressOf('michal') });

  deliverSystemMessage(db, users.ania, { subject: 'Witaj', body: 'x' });

  assert.equal(listMessages(db, users.ania, { folder: 'inbox' }).length, 1);
  assert.equal(listMessages(db, users.michal, { folder: 'inbox' }).length, 0, 'zwroty i powitania zostają na miejscu');
  db.close();
});

test('przesyłanie dalej: poczta z bramki SMTP też jest przekazywana', () => {
  const { db, user, users } = fresh();
  setForwarding(db, user('ania'), { to: addressOf('michal') });

  deliverInbound(
    db,
    users.ania,
    { from: { name: 'Ktoś', addr: 'ktos@obca.pl' }, subject: 'Z zewnątrz', body: 'halo', attachments: [] },
    { toAddr: addressOf('ania') }
  );

  const [uMichala] = listMessages(db, users.michal, { folder: 'inbox' });
  assert.equal(uMichala.subject, 'Z zewnątrz');
  assert.equal(uMichala.from_addr, 'ktos@obca.pl');
  db.close();
});

test('przesyłanie dalej: zniknięta skrzynka celu nie wywraca doręczenia', () => {
  const { db, user, users } = fresh();
  setForwarding(db, user('ania'), { to: addressOf('michal') });
  db.prepare('DELETE FROM users WHERE id = ?').run(users.michal);

  const wynik = sendMessage(db, user('demo'), { to: addressOf('ania'), subject: 'Mimo wszystko', body: 'x' });
  assert.ok(!wynik.error);
  assert.equal(listMessages(db, users.ania, { folder: 'inbox' }).length, 1, 'list dociera, przekierowanie milczy');
  db.close();
});

test('przesyłanie dalej: na zewnątrz idzie bramką, a porażka wraca zwrotem do właściciela', async () => {
  process.env.TP_EXTERNAL = '1';
  process.env.TP_SMTP_ROUTE = '127.0.0.1:1'; // martwy port, doręczenie musi się nie udać
  try {
    const { db, user, users } = fresh();
    setForwarding(db, user('ania'), { to: 'ania-prywatnie@gdzieindziej.example' });
    sendMessage(db, user('demo'), { to: addressOf('ania'), subject: 'Dalej w świat', body: 'x' });

    let odbicie = null;
    for (let i = 0; i < 80 && !odbicie; i++) {
      await new Promise((res) => setTimeout(res, 25));
      odbicie = listMessages(db, users.ania, { folder: 'inbox' }).find((m) => m.subject.startsWith('Zwrot do nadawcy'));
    }
    assert.ok(odbicie, 'nieudane przesłanie wraca zwrotem do właściciela skrzynki');
    assert.match(getMessage(db, users.ania, odbicie.id).body, /gdzieindziej\.example/);
    // zwrot jest wiadomością systemową, więc sam nie poleciał dalej i nie zapętlił bramki
    assert.equal(
      listMessages(db, users.ania, { folder: 'inbox' }).filter((m) => m.subject.startsWith('Zwrot do nadawcy')).length,
      1
    );
    db.close();
  } finally {
    delete process.env.TP_EXTERNAL;
    delete process.env.TP_SMTP_ROUTE;
  }
});

test('przesyłanie dalej: kopia w Wysłanych nadawcy nie jest przekazywana', () => {
  const { db, user, users } = fresh();
  // nadawca ma przekierowanie, ale nie może ono dotyczyć jego własnych kopii w Wysłanych
  setForwarding(db, user('demo'), { to: addressOf('michal') });

  sendMessage(db, user('demo'), { to: addressOf('ania'), subject: 'Ode mnie', body: 'x' });

  assert.equal(listMessages(db, users.michal, { folder: 'inbox' }).length, 0);
  assert.equal(listMessages(db, users.demo, { folder: 'sent' }).length, 1);
  db.close();
});

test('updateMessage: do scheduled nie wolno, wyjście z scheduled czyści termin', () => {
  const { db, user, users } = fresh();
  const demo = user('demo');
  const za1h = new Date(Date.now() + 3600_000).toISOString();
  const wynik = sendMessage(db, demo, { to: addressOf('ania'), subject: 'S', body: 'x', scheduledAt: za1h });

  // anulowanie wysyłki: powrót do wersji roboczych zeruje scheduled_at
  const cofnieta = updateMessage(db, users.demo, wynik.message.id, { folder: 'drafts' });
  assert.equal(cofnieta.folder, 'drafts');
  assert.equal(cofnieta.scheduled_at, null);
  assert.equal(fireScheduled(db), 0);

  // zwykłej wiadomości nie można ręcznie wepchnąć do Zaplanowanych
  deliverSystemMessage(db, users.demo, { subject: 'N', body: 'x' });
  const [zwykla] = listMessages(db, users.demo, { folder: 'inbox' });
  assert.equal(updateMessage(db, users.demo, zwykla.id, { folder: 'scheduled' }), null);
  db.close();
});

// Zewnętrzne ramię tożsamości zespołu. Mieszka tu, a nie w teams.test.js, bo to plik
// od drutu: klient spoza domeny czyta bajty nagłówka From, nie wiersz w `messages`.
test('wysyłka jako zespół na zewnątrz: nagłówek From na drucie niesie nazwę zespołu', async () => {
  const { server, odebrane } = startSink();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.TP_EXTERNAL = '1';
  process.env.TP_SMTP_ROUTE = `127.0.0.1:${server.address().port}`;
  try {
    const { db, user, users } = fresh();
    const demo = user('demo');
    const zespol = createTeam(db, { localPart: 'sprzedaz', name: 'Dział Sprzedaży' });
    setMember(db, zespol.id, users.demo, true);

    const wynik = sendMessage(db, demo, {
      to: 'klient@gdzieindziej.pl',
      from: addressOf('sprzedaz'),
      subject: 'Oferta',
      body: 'x',
    });
    assert.ok(!wynik.error);

    let raw = null;
    for (let i = 0; i < 80 && !raw; i++) {
      await new Promise((res) => setTimeout(res, 25));
      raw = odebrane[0] ?? null;
    }
    assert.ok(raw, 'list do klienta powinien wyjść na zewnątrz');

    const naglowekFrom = raw.match(/^From: (.*)$/m)?.[1];
    assert.ok(naglowekFrom, 'list na drucie ma nagłówek From');
    assert.match(naglowekFrom, /<sprzedaz@twojapoczta\.com>/, 'odpowiedź klienta wraca na zespół');
    // Nazwa z ogonkami jedzie zakodowana (encodeHeaderWord), więc „Dział Sprzedaży"
    // nie stoi na drucie dosłownie i asercja na sam tekst przechodziłaby na ślepo.
    const zakodowana = naglowekFrom.match(/=\?UTF-8\?B\?([^?]+)\?=/)?.[1];
    assert.ok(zakodowana, 'nazwa nadawcy jedzie jako zakodowane słowo nagłówka');
    assert.equal(
      Buffer.from(zakodowana, 'base64').toString('utf8'),
      'Dział Sprzedaży',
      'klient spoza domeny widzi firmę, nie Jana z dyżuru'
    );
    db.close();
  } finally {
    delete process.env.TP_EXTERNAL;
    delete process.env.TP_SMTP_ROUTE;
    await new Promise((r) => server.close(r));
  }
});

// --- HTML poczty przychodzącej -----------------------------------------------

test('deliverInbound: zapisuje body_html i content_id załącznika', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverInbound(db, demo.id, {
    from: { name: 'A', addr: 'a@b.pl' },
    subject: 'HTML',
    body: 'tekst',
    html: '<p>treść <b>HTML</b></p>',
    attachments: [{ filename: 'logo.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'logo@fir.ma' }],
  }, { toAddr: addressOf('demo') });

  const msg = db.prepare('SELECT body_html FROM messages WHERE owner_id = ?').get(demo.id);
  assert.equal(msg.body_html, '<p>treść <b>HTML</b></p>');
  assert.equal(db.prepare('SELECT content_id FROM attachments').get().content_id, 'logo@fir.ma');
});

// Test charakteryzujący: ten inwariant trzymał już przed zapisem HTML (insertMessage
// domyka `body_html` przez `?? ''`), więc nie jest dowodem regresji dla tej zmiany.
// Pilnuje go, bo kolumna jest `NOT NULL` (insert by rzucił), a w `server/quota.js`
// `SUM(LENGTH(body) + LENGTH(body_html))` z `NULL`-em daje `NULL`, który SQLite pomija
// w `SUM` — cały wiersz zniknąłby z rozliczenia miejsca po cichu.
test('deliverInbound: brak HTML nadal zapisuje pusty string, nie null', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverInbound(db, demo.id, {
    from: { name: '', addr: 'a@b.pl' }, subject: 'Tekst', body: 'sam tekst', html: null, attachments: [],
  }, { toAddr: addressOf('demo') });
  assert.equal(db.prepare('SELECT body_html FROM messages').get().body_html, '');
});

test('deliverInbound: HTML powyżej limitu jest odrzucany, tekst zostaje', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  deliverInbound(db, demo.id, {
    from: { name: '', addr: 'a@b.pl' },
    subject: 'Grubas',
    body: 'tekst zapasowy',
    html: '<p>' + 'x'.repeat(MAX_BODY_HTML_BYTES) + '</p>',
    attachments: [],
  }, { toAddr: addressOf('demo') });
  const msg = db.prepare('SELECT body, body_html FROM messages').get();
  assert.equal(msg.body_html, '');
  assert.equal(msg.body, 'tekst zapasowy');
});

test('deliverInbound: HTML dokładnie na limicie wchodzi, o bajt większy odpada', () => {
  const { db, user } = fresh();
  const demo = user('demo');
  // Limit mierzy bajty, nie znaki, więc ciało budujemy z samego ASCII (bajt = znak)
  // i długość potwierdzamy asercją, zamiast ufać `repeat`.
  const htmlODlugosci = (bajty) => `<p>${'x'.repeat(bajty - '<p></p>'.length)}</p>`;
  const naLimicie = htmlODlugosci(MAX_BODY_HTML_BYTES);
  const oBajtZaDuzy = htmlODlugosci(MAX_BODY_HTML_BYTES + 1);
  assert.equal(Buffer.byteLength(naLimicie, 'utf8'), MAX_BODY_HTML_BYTES);
  assert.equal(Buffer.byteLength(oBajtZaDuzy, 'utf8'), MAX_BODY_HTML_BYTES + 1);

  const dorecz = (subject, html) => deliverInbound(db, demo.id, {
    from: { name: '', addr: 'a@b.pl' }, subject, body: 'tekst zapasowy', html, attachments: [],
  }, { toAddr: addressOf('demo') });
  dorecz('Na limicie', naLimicie);
  dorecz('O bajt za duzy', oBajtZaDuzy);

  // Próg jest ostry: HTML równy limitowi jeszcze wchodzi. Gdyby `>` w mail.js zmieniło
  // się w `>=`, wiadomość na limicie po cichu straciłaby treść HTML.
  const [wchodzi, odpada] = db.prepare('SELECT subject, body_html FROM messages ORDER BY id').all();
  assert.equal(wchodzi.body_html, naLimicie, 'HTML o długości równej limitowi zostaje zapisany');
  assert.equal(odpada.body_html, '', 'HTML o bajt powyżej limitu jest odrzucany');
});

test('przesyłanie dalej: kopia zachowuje kotwicę cid osadzonego obrazka', () => {
  const { db, user, users } = fresh();
  setForwarding(db, user('demo'), { to: addressOf('ania') });
  deliverInbound(db, users.demo, {
    from: { name: 'Firma', addr: 'biuro@fir.ma' },
    subject: 'Z logo',
    body: 'tekst',
    html: '<p>Witamy</p><img src="cid:logo@fir.ma">',
    attachments: [{ filename: 'logo.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'logo@fir.ma' }],
  }, { toAddr: addressOf('demo') });

  // Sens pary: HTML kopii odwołuje się przez `cid:` do załącznika kopii. Jeśli kopia
  // dostanie HTML bez załącznika o tym content_id, obrazek nie ma się z czego wyświetlić.
  const [kopia] = listMessages(db, users.ania, { folder: 'inbox' });
  assert.ok(kopia, 'przekierowana kopia trafia do skrzynki celu');
  const htmlKopii = getMessage(db, users.ania, kopia.id).body_html;
  const odwolanie = htmlKopii.match(/src="cid:([^"]+)"/)?.[1];
  assert.ok(odwolanie, 'HTML kopii nadal niesie odwołanie cid:');
  const zalacznik = db.prepare('SELECT content_id FROM attachments WHERE message_id = ?').get(kopia.id);
  assert.equal(zalacznik.content_id, odwolanie, 'załącznik kopii niesie content_id, na który wskazuje cid: w jej body_html');
  db.close();
});

test('przesyłanie dalej na zewnątrz: osadzony obrazek wychodzi na drut z kotwicą Content-ID', async () => {
  const { server, odebrane } = startSink();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.TP_EXTERNAL = '1';
  process.env.TP_SMTP_ROUTE = `127.0.0.1:${server.address().port}`;
  try {
    const { db, user, users } = fresh();
    setForwarding(db, user('demo'), { to: 'ja-prywatnie@gdzieindziej.pl' });
    deliverInbound(db, users.demo, {
      from: { name: 'Firma', addr: 'biuro@fir.ma' },
      subject: 'Z logo',
      body: 'tekst',
      html: '<p>Witamy</p><img src="cid:logo@fir.ma">',
      attachments: [{ filename: 'logo.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'logo@fir.ma' }],
    }, { toAddr: addressOf('demo') });

    // Wysyłka na zewnątrz leci w setImmediate, więc czekamy na bajty u odbiorcy.
    let raw = null;
    for (let i = 0; i < 80 && !raw; i++) {
      await new Promise((res) => setTimeout(res, 25));
      raw = odebrane[0] ?? null;
    }
    assert.ok(raw, 'przekierowany list powinien wyjść na zewnątrz');

    // Sens pary: to jedyne miejsce, w którym widać alias `a.content_id AS contentId`.
    // Bez niego `buildRawMessage` dostaje `undefined`, nagłówek nie powstaje i odbiorca
    // ma `cid:` bez kotwicy — a testy jednostkowe buildRawMessage tego nie zobaczą,
    // bo wołają go z gotowym `contentId` z pominięciem SELECT-a.
    assert.match(raw, /Content-Type: multipart\/related;/, 'osadzony obrazek jedzie w multipart/related');
    const kotwica = raw.match(/Content-ID: <([^>]+)>/)?.[1];
    // HTML jedzie quoted-printable, więc `src="` jest na drucie jako `src=3D"`.
    const odwolanie = raw.match(/src=3D"cid:([^"]+)"/)?.[1];
    assert.equal(odwolanie, 'logo@fir.ma', 'HTML na drucie nadal cytuje cid:');
    assert.equal(kotwica, odwolanie, 'nagłówek Content-ID domyka odwołanie cid: z HTML-u');
    db.close();
  } finally {
    delete process.env.TP_EXTERNAL;
    delete process.env.TP_SMTP_ROUTE;
    await new Promise((r) => server.close(r));
  }
});
