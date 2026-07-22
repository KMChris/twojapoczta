// Ścieżki negatywne i walidacja API: błędne dane, limity, 404/400/401/409/413/429.
// Osobna aplikacja na świeżej bazie in-memory: pełna izolacja od reszty testów.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';
import { openMemoryDb, now } from '../server/db.js';
import { storeAttachment, MAX_CONTENT_ID_CHARS } from '../server/attachments.js';

let server;
let base;
let db;

function client() {
  let cookie = '';
  async function call(method, path, body, extra = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data };
  }
  call.rawBody = (method, path, rawBody, headers = {}) =>
    fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: rawBody });
  return call;
}

before(async () => {
  db = openMemoryDb();
  const app = await createApp({ db });
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

// --- Body / routing ----------------------------------------------------------

test('nieprawidłowy JSON → 400', async () => {
  const res = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{ zepsuty',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Nieprawidłowy format/);
});

test('nieznana trasa API → 404', async () => {
  const res = await fetch(`${base}/api/nie-ma-takiej`);
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /Nie ma takiego adresu/);
});

test('body ponad 512 KB → 413', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const res = await api.rawBody('PATCH', '/api/me', 'x'.repeat(600 * 1024), {
    'Content-Type': 'application/json',
  });
  assert.equal(res.status, 413);
});

// --- Rejestracja -------------------------------------------------------------

test('rejestracja: walidacja loginu, nazwy, hasła i duplikatu', async () => {
  const api = client();
  assert.equal((await api('POST', '/api/register', { login: 'A B', name: 'X', password: '12345678' })).status, 400);
  assert.equal((await api('POST', '/api/register', { login: 'poprawny1', name: 'a'.repeat(61), password: '12345678' })).status, 400);
  assert.equal((await api('POST', '/api/register', { login: 'poprawny2', name: 'Ktoś', password: 'krotkie' })).status, 400);
  assert.equal((await api('POST', '/api/register', { login: 'demo', name: 'X', password: '12345678' })).status, 409);
});

// --- Logowanie ---------------------------------------------------------------

test('logowanie: złe hasło i nieznany login → 401', async () => {
  const api = client();
  assert.equal((await api('POST', '/api/login', { login: 'demo', password: 'zle', }, { 'X-Forwarded-For': '10.0.0.1' })).status, 401);
  assert.equal((await api('POST', '/api/login', { login: 'niktniema', password: 'x' }, { 'X-Forwarded-For': '10.0.0.1' })).status, 401);
});

test('logowanie: akceptuje login z sufiksem @domena', async () => {
  const api = client();
  const res = await api('POST', '/api/login', { login: 'demo@twojapoczta.com', password: 'demo1234' });
  assert.equal(res.status, 200);
  assert.equal(res.data.user.login, 'demo');
});

test('logowanie: 6. próba blokowana (429), inny adres IP nie', async () => {
  const api = client();
  for (let i = 0; i < 5; i++) {
    const r = await api('POST', '/api/login', { login: 'demo', password: 'zle' }, { 'X-Forwarded-For': '198.51.100.50' });
    assert.equal(r.status, 401);
  }
  const zablokowane = await api('POST', '/api/login', { login: 'demo', password: 'zle' }, { 'X-Forwarded-For': '198.51.100.50' });
  assert.equal(zablokowane.status, 429);
  const innyIp = await api('POST', '/api/login', { login: 'demo', password: 'zle' }, { 'X-Forwarded-For': '198.51.100.51' });
  assert.equal(innyIp.status, 401);
});

test('wylogowanie bez sesji zwraca 200', async () => {
  const res = await client()('POST', '/api/logout');
  assert.equal(res.status, 200);
});

// --- Profil ------------------------------------------------------------------

test('PATCH /api/me: ignoruje za długą nazwę/podpis i błędny motyw, pusty patch bez zmian', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const przed = (await api('GET', '/api/me')).data.user;

  const res = await api('PATCH', '/api/me', {
    name: 'a'.repeat(61),
    signature: 'z'.repeat(501),
    theme: 'neonowy',
  });
  assert.equal(res.data.user.name, przed.name);
  assert.equal(res.data.user.signature, przed.signature);
  assert.equal(res.data.user.theme, przed.theme);

  const pusty = await api('PATCH', '/api/me', {});
  assert.equal(pusty.status, 200);
  assert.equal(pusty.data.user.name, przed.name);

  const ok = await api('PATCH', '/api/me', { name: 'Nowa Nazwa', theme: 'dark' });
  assert.equal(ok.data.user.name, 'Nowa Nazwa');
  assert.equal(ok.data.user.theme, 'dark');
});

// --- Wiadomości --------------------------------------------------------------

test('GET/PATCH/DELETE nieistniejącej wiadomości → 404', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  assert.equal((await api('GET', '/api/messages/999999')).status, 404);
  assert.equal((await api('PATCH', '/api/messages/999999', { is_read: true })).status, 404);
  assert.equal((await api('DELETE', '/api/messages/999999')).status, 404);
});

test('POST /api/messages: za długi temat → 400, wersja robocza z błędnym id → 404', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  assert.equal((await api('POST', '/api/messages', { to: 'ania@twojapoczta.com', subject: 't'.repeat(201), body: 'x' })).status, 400);
  const brak = await api('POST', '/api/messages', { draft: true, id: 999999, to: '', subject: 'x', body: 'x' });
  assert.equal(brak.status, 404);
  assert.equal(brak.data.error, 'Nie znaleziono wersji roboczej.');
});

test('GET /api/counts zwraca liczniki', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const res = await api('GET', '/api/counts');
  assert.equal(res.status, 200);
  assert.ok('inbox' in res.data.counts);
});

// --- Przesyłanie dalej --------------------------------------------------------

test('/api/forwarding: ustawienie, odczyt, walidacja i wyłączenie', async () => {
  const api = client();
  await api('POST', '/api/register', { login: 'przekierowany', name: 'Prze Kierowany', password: 'haslo12345' });

  assert.deepEqual((await api('GET', '/api/forwarding')).data.forwarding, { to: '', keepCopy: true });

  // własny adres → 400 i nic się nie zapisuje
  const naSiebie = await api('PUT', '/api/forwarding', { to: 'przekierowany@twojapoczta.com' });
  assert.equal(naSiebie.status, 400);
  assert.match(naSiebie.data.error, /na własny adres/);
  assert.equal((await api('GET', '/api/forwarding')).data.forwarding.to, '');

  // poprawny cel
  const ok = await api('PUT', '/api/forwarding', { to: 'demo@twojapoczta.com', keepCopy: false });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.forwarding, { to: 'demo@twojapoczta.com', keepCopy: false });
  assert.deepEqual((await api('GET', '/api/forwarding')).data.forwarding, { to: 'demo@twojapoczta.com', keepCopy: false });

  // wyłączenie wraca do stanu domyślnego
  assert.deepEqual((await api('PUT', '/api/forwarding', { to: '' })).data.forwarding, { to: '', keepCopy: true });

  // typ inny niż tekst → 400
  assert.equal((await api('PUT', '/api/forwarding', { to: { zly: 'typ' } })).status, 400);
});

test('/api/forwarding: bez sesji → 401', async () => {
  const api = client();
  assert.equal((await api('GET', '/api/forwarding')).status, 401);
  assert.equal((await api('PUT', '/api/forwarding', { to: 'demo@twojapoczta.com' })).status, 401);
});

// --- Aliasy ------------------------------------------------------------------

test('aliasy: lista, walidacja, zajęty, limit 5, usunięcie nieistniejącego', async () => {
  const api = client();
  await api('POST', '/api/register', { login: 'aliaser', name: 'Alias User', password: 'haslo12345' });

  const puste = await api('GET', '/api/aliases');
  assert.deepEqual(puste.data.aliases, []);
  assert.equal(puste.data.limit, 5, 'interfejs bierze limit z serwera');
  assert.equal((await api('POST', '/api/aliases', { alias: 'ZŁY!' })).status, 400);
  assert.equal((await api('POST', '/api/aliases', { alias: 'demo' })).status, 409);

  for (const a of ['alias-a', 'alias-b', 'alias-c', 'alias-d', 'alias-e']) {
    assert.equal((await api('POST', '/api/aliases', { alias: a })).status, 201);
  }
  const szosty = await api('POST', '/api/aliases', { alias: 'alias-f' });
  assert.equal(szosty.status, 400);
  assert.match(szosty.data.error, /najwyżej 5 aliasów/);
  assert.equal((await api('DELETE', '/api/aliases/999999')).status, 404);
});

// --- Uploady / załączniki ----------------------------------------------------

test('upload pustego pliku → 400', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const res = await api.rawBody('POST', '/api/uploads', Buffer.alloc(0), {
    'Content-Type': 'text/plain', 'X-Filename': 'pusty.txt',
  });
  assert.equal(res.status, 400);
});

test('upload z błędnym X-Filename spada na nazwę domyślną', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  // „%” bez dwóch cyfr szesnastkowych wywala decodeURIComponent → nazwa „plik"
  const res = await api.rawBody('POST', '/api/uploads', Buffer.from('dane'), {
    'Content-Type': 'text/plain', 'X-Filename': '%zle%',
  });
  assert.equal(res.status, 201);
  const { upload } = await res.json();
  assert.equal(upload.filename, 'plik');
});

test('pobranie nieistniejącego załącznika → 404', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const res = await api.rawBody('GET', '/api/messages/1/attachments/999999');
  assert.equal(res.status, 404);
});

// --- Foldery ------------------------------------------------------------------

test('foldery: pełny obieg tras', async () => {
  const ala = client();
  await ala('POST', '/api/register', { login: 'folderowa', name: 'Ala Folderowa', password: 'haslo1234' });

  assert.deepEqual((await ala('GET', '/api/folders')).data.folders, []);

  const utworzony = await ala('POST', '/api/folders', { name: 'Faktury' });
  assert.equal(utworzony.status, 201);
  const id = utworzony.data.folder.id;
  // Kształt, na którym opiera się panel boczny i okno usuwania.
  assert.deepEqual(Object.keys(utworzony.data.folders[0]).sort(), ['count', 'id', 'name', 'position']);

  const kolizja = await ala('POST', '/api/folders', { name: 'faktury' });
  assert.equal(kolizja.status, 400);
  assert.match(kolizja.data.error, /Masz już folder/);

  assert.equal((await ala('POST', '/api/folders', { name: '  ' })).status, 400);
  assert.equal((await ala('POST', '/api/folders', { name: 123 })).status, 400);

  const zmiana = await ala('PATCH', `/api/folders/${id}`, { name: 'Rachunki' });
  assert.equal(zmiana.status, 200);
  assert.equal(zmiana.data.folder.name, 'Rachunki');

  assert.equal((await ala('PATCH', '/api/folders/9999', { name: 'X' })).status, 404);
  assert.equal((await ala('DELETE', '/api/folders/9999')).status, 404);

  const usuniety = await ala('DELETE', `/api/folders/${id}`);
  assert.equal(usuniety.status, 200);
  assert.equal(usuniety.data.moved, 0);
  assert.deepEqual(usuniety.data.folders, []);
});

test('foldery: cudzy folder jest niewidoczny i nietykalny', async () => {
  const ala = client();
  await ala('POST', '/api/register', { login: 'wlascicielka', name: 'Ala', password: 'haslo1234' });
  const id = (await ala('POST', '/api/folders', { name: 'Prywatne' })).data.folder.id;

  const bob = client();
  await bob('POST', '/api/register', { login: 'obcy', name: 'Bob', password: 'haslo1234' });
  assert.deepEqual((await bob('GET', '/api/folders')).data.folders, []);
  assert.equal((await bob('PATCH', `/api/folders/${id}`, { name: 'Moje' })).status, 404);
  assert.equal((await bob('DELETE', `/api/folders/${id}`)).status, 404);

  assert.equal((await ala('GET', '/api/folders')).data.folders[0].name, 'Prywatne');
});

test('foldery: przeniesienie wiadomości, filtrowanie po folderId i licznik', async () => {
  const ala = client();
  await ala('POST', '/api/register', { login: 'przenoszaca', name: 'Ala', password: 'haslo1234' });
  const id = (await ala('POST', '/api/folders', { name: 'Faktury' })).data.folder.id;

  // Rejestracja zostawia w Odebranych wiadomość powitalną — na niej pracujemy.
  const odebrane = (await ala('GET', '/api/messages?folder=inbox')).data.messages;
  assert.ok(odebrane.length >= 1);
  const wiadomosc = odebrane[0].id;

  const po = await ala('PATCH', `/api/messages/${wiadomosc}`, { folder_id: id });
  assert.equal(po.status, 200);
  assert.equal(po.data.message.folder, 'custom');
  assert.equal(po.data.message.folder_id, id);

  const wFolderze = await ala('GET', `/api/messages?folderId=${id}`);
  assert.equal(wFolderze.data.messages.length, 1);
  assert.equal(wFolderze.data.counts.custom[id], 1);
  assert.equal((await ala('GET', '/api/messages?folder=inbox')).data.messages.length, 0);

  // Usunięcie folderu przenosi pocztę do Archiwum, a nie kasuje.
  assert.equal((await ala('DELETE', `/api/folders/${id}`)).data.moved, 1);
  assert.equal((await ala('GET', '/api/messages?folder=archive')).data.messages.length, 1);
});

// --- Obrazki osadzone (cid) --------------------------------------------------

function idUzytkownika(login) {
  return db.prepare('SELECT id FROM users WHERE login = ?').get(login).id;
}

function wstawZObrazkiem(ownerId, contentId, dane = 'png-bajty') {
  const wynik = db.prepare(
    `INSERT INTO messages (owner_id, folder, from_addr, subject, body, body_html, snippet, sent_at, attachments_count)
     VALUES (?, 'inbox', 'a@b.pl', 'Z obrazkiem', 'tekst', ?, '', ?, 1)`
  ).run(ownerId, `<img src="cid:${contentId}">`, now());
  const id = Number(wynik.lastInsertRowid);
  storeAttachment(db, id, { filename: 'logo.png', mime: 'image/png', data: Buffer.from(dane), contentId });
  return id;
}

test('cid: oddaje obrazek osadzony inline', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const id = wstawZObrazkiem(idUzytkownika('demo'), 'logo@fir.ma');
  // rawBody z pustym ciałem daje surową odpowiedź z ciasteczkiem sesji,
  // a `api()` parsuje tylko JSON, więc na bajty się nie nadaje.
  const res = await api.rawBody('GET', `/api/messages/${id}/cid/${encodeURIComponent('logo@fir.ma')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.match(res.headers.get('content-disposition'), /^inline/);
  // Tyle samo, co sąsiednia trasa załącznika · treść jest zależna od sesji, a cache nie
  // kluczuje po ciasteczku, więc okno pomijania serwera ma być tak krótkie, jak tam.
  assert.equal(res.headers.get('cache-control'), 'private, max-age=3600');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'png-bajty');
});

test('cid: cudza wiadomość → 404', async () => {
  const api = client();
  await api('POST', '/api/register', { login: 'obcy1', name: 'Obcy', password: '12345678' });
  const idObcego = idUzytkownika('obcy1');
  const api2 = client();
  await api2('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const id = wstawZObrazkiem(idObcego, 'cudze@fir.ma');
  const res = await api2.rawBody('GET', `/api/messages/${id}/cid/${encodeURIComponent('cudze@fir.ma')}`);
  assert.equal(res.status, 404);
});

test('cid: nieznany identyfikator → 404', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const id = wstawZObrazkiem(idUzytkownika('demo'), 'jest@fir.ma');
  const res = await api.rawBody('GET', `/api/messages/${id}/cid/nie-ma-takiego`);
  assert.equal(res.status, 404);
});

// Content-ID jest unikalny najwyżej w obrębie listu, więc dwa listy mogą go mieć taki sam.
// Własność pilnuje `owner_id`, ale to `m.id = ?` wiąże obrazek z jego listem · bez tego
// trasa podałaby w treści jednego listu obrazek z drugiego.
test('cid: ten sam Content-ID w dwóch moich wiadomościach → każda oddaje swój obrazek', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const ownerId = idUzytkownika('demo');
  const id1 = wstawZObrazkiem(ownerId, 'ten-sam@fir.ma', 'OBRAZEK-PIERWSZEJ');
  const id2 = wstawZObrazkiem(ownerId, 'ten-sam@fir.ma', 'OBRAZEK-DRUGIEJ');
  const bajty = async (id) => {
    const res = await api.rawBody('GET', `/api/messages/${id}/cid/${encodeURIComponent('ten-sam@fir.ma')}`);
    return Buffer.from(await res.arrayBuffer()).toString();
  };
  assert.equal(await bajty(id1), 'OBRAZEK-PIERWSZEJ');
  assert.equal(await bajty(id2), 'OBRAZEK-DRUGIEJ');
});

test('cid: mapa w GET /api/messages/:id zawiera każdy Content-ID, a serwer trzyma wszystkie załączniki na liście', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const id = wstawZObrazkiem(idUzytkownika('demo'), 'mapa@fir.ma');
  const { status, data } = await api('GET', `/api/messages/${id}`);
  assert.equal(status, 200);
  assert.equal(data.cid['mapa@fir.ma'], `/api/messages/${id}/cid/${encodeURIComponent('mapa@fir.ma')}`);
  // Opcja B: osadzony obrazek zostaje TAKŻE pod listem · to klient chowa spinacz, gdy sam
  // wstawi ten obrazek w treść. Serwer nie zdejmuje już nic z listy.
  assert.deepEqual(data.attachments.map((z) => z.filename), ['logo.png']);
});

// Nic nie broni nadawcy przed wysłaniem dwóch części z tym samym Content-ID. Klucz w mapie
// jest jeden (bierze go pierwszy), ale opcja B trzyma OBA załączniki pod listem · klient
// schowa najwyżej ten spinacz, którego obrazek faktycznie wstawił w treść.
test('cid: dwa załączniki z tym samym Content-ID → pierwszy w mapie, oba zostają na liście', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const ownerId = idUzytkownika('demo');
  const wynik = db.prepare(
    `INSERT INTO messages (owner_id, folder, from_addr, subject, body, body_html, snippet, sent_at, attachments_count)
     VALUES (?, 'inbox', 'a@b.pl', 'Duplikat', 'tekst', ?, '', ?, 2)`
  ).run(ownerId, '<img src="cid:dup@fir.ma">', now());
  const id = Number(wynik.lastInsertRowid);
  storeAttachment(db, id, { filename: 'pierwszy.png', mime: 'image/png', data: Buffer.from('PIERWSZY'), contentId: 'dup@fir.ma' });
  storeAttachment(db, id, { filename: 'drugi.png', mime: 'image/png', data: Buffer.from('DRUGI'), contentId: 'dup@fir.ma' });

  const { data } = await api('GET', `/api/messages/${id}`);
  // pierwszy: osiągalny w treści, przez mapę (klucz bierze pierwszy zapisany)
  const wMapie = await api.rawBody('GET', data.cid['dup@fir.ma']);
  assert.equal(Buffer.from(await wMapie.arrayBuffer()).toString(), 'PIERWSZY');
  // oba zostają pod listem, w kolejności zapisu
  assert.deepEqual(data.attachments.map((z) => z.filename), ['pierwszy.png', 'drugi.png']);
  // drugi: osiągalny pod listem, przez zwykłą trasę załącznika
  const naLiscie = await api.rawBody('GET', `/api/messages/${id}/attachments/${data.attachments[1].id}`);
  assert.equal(Buffer.from(await naLiscie.arrayBuffer()).toString(), 'DRUGI');
});

// Content-ID jest polem nadawcy, więc `__proto__` jest zwykłym listem, nie atakiem. Mapa bez
// prototypu (Object.create(null)) przyjmuje go jak każdy inny klucz, a opcja B trzyma załącznik
// także pod listem · na zwykłym `{}` przypisanie poszłoby w setter prototypu i wpis by zniknął.
test('cid: Content-ID o nazwie klucza z prototypu trafia do mapy jak każdy inny', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const id = wstawZObrazkiem(idUzytkownika('demo'), '__proto__', 'BAJTY-PROTO');
  const { data } = await api('GET', `/api/messages/${id}`);
  assert.equal(data.cid['__proto__'], `/api/messages/${id}/cid/${encodeURIComponent('__proto__')}`);
  // Opcja B: załącznik zostaje TAKŻE na liście, nie tylko w mapie.
  assert.equal(data.attachments.length, 1);
  const res = await api.rawBody('GET', data.cid['__proto__']);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'BAJTY-PROTO');
});

// Opcja B odwraca ten test. Był dowodem starej polityki „serwer zgaduje po treści": treść nie
// cytuje sieroty, więc serwer NIE mapował jej Content-ID (`data.cid` puste). Teraz serwer mapuje
// KAŻDY Content-ID niezależnie od treści, a o pokazaniu spinacza decyduje klient (chowa go tylko,
// gdy sam wstawił obrazek). Sierota trafia więc do mapy MIMO braku cytowania, a załącznik i tak
// zostaje pod listem — bo klient tej treści nie wchłonął, więc spinacz zostanie widoczny.
test('cid: serwer mapuje Content-ID niezależnie od cytowania, a załącznik zostaje na liście', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const ownerId = idUzytkownika('demo');
  const wynik = db.prepare(
    `INSERT INTO messages (owner_id, folder, from_addr, subject, body, body_html, snippet, sent_at, attachments_count)
     VALUES (?, 'inbox', 'a@b.pl', 'Sierota', 'tekst', '<p>Bez obrazkow</p>', '', ?, 1)`
  ).run(ownerId, now());
  const id = Number(wynik.lastInsertRowid);
  storeAttachment(db, id, { filename: 'sierota.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'sierota@fir.ma' });
  const { data } = await api('GET', `/api/messages/${id}`);
  assert.equal(data.cid['sierota@fir.ma'], `/api/messages/${id}/cid/${encodeURIComponent('sierota@fir.ma')}`);
  assert.equal(data.attachments.length, 1);
  assert.equal(data.attachments[0].filename, 'sierota.png');
});

// Broni całej rodziny „załącznik zniknął z aplikacji" na wejściu z przydługim Content-ID.
// Gdybyśmy klucz obcinali, dopasowałby się do prefiksu pełnego, 213-znakowego odwołania w
// treści (201. znak to apostrof: legalny atext RFC 5322, ale jedyny wyjęty z klasy
// lookaheada, bo jest zarazem ogranicznikiem atrybutu — więc obcięcia nie zasłania):
// załącznik wpadłby do mapy `cid` pod obciętym kluczem i zniknął z listy, a klient pytałby
// mapę o odwołanie pełne · nie byłoby go ani w treści, ani pod listem.
test('cid: Content-ID dłuższy niż limit zostaje widocznym załącznikiem, zamiast zniknąć', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const zaDlugi = 'a'.repeat(MAX_CONTENT_ID_CHARS) + "'dalej@fir.ma";
  const id = wstawZObrazkiem(idUzytkownika('demo'), zaDlugi, 'BAJTY-DLUGIEGO');
  const { data } = await api('GET', `/api/messages/${id}`);
  assert.deepEqual(data.cid, {}, 'mapa nie może połknąć załącznika pod obciętym kluczem');
  assert.equal(data.attachments.length, 1, 'załącznik ma zostać widoczny na liście');
  assert.equal(data.attachments[0].filename, 'logo.png');
  const res = await api.rawBody('GET', `/api/messages/${id}/attachments/${data.attachments[0].id}`);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'BAJTY-DLUGIEGO');
});

// Test charakteryzujący: przechodził już przed tą zmianą, bo `GET /api/messages/:id` nie
// filtrował załączników, więc nie jest dowodem regresji. Pilnuje granicy od drugiej strony
// niż test wyżej: tam treść jest i nie cytuje, tu treści nie ma wcale.
test('cid: list bez HTML nadal nie gubi załącznika z Content-ID', async () => {
  const api = client();
  await api('POST', '/api/login', { login: 'demo', password: 'demo1234' });
  const ownerId = idUzytkownika('demo');
  const wynik = db.prepare(
    `INSERT INTO messages (owner_id, folder, from_addr, subject, body, body_html, snippet, sent_at, attachments_count)
     VALUES (?, 'inbox', 'a@b.pl', 'Sam tekst', 'tekst', '', '', ?, 1)`
  ).run(ownerId, now());
  const id = Number(wynik.lastInsertRowid);
  storeAttachment(db, id, { filename: 'zalacznik.png', mime: 'image/png', data: Buffer.from('png'), contentId: 'bez-html@fir.ma' });
  const { data } = await api('GET', `/api/messages/${id}`);
  assert.equal(data.attachments.length, 1);
});
