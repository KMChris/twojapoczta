// Okno pisania wiadomości: bogata treść (HTML), DW/UDW, nadawca z aliasu,
// autozapis wersji roboczych, wysyłka od razu albo o zaplanowanej porze.

import { api } from './api.js';
import { el, ikona, toast, formatujRozmiar } from './ui.js';
import { initEdytor, sanitizeHtml, tekstNaHtml, eskapujHtml } from './edytor.js';

export function initKompozycja(app) {
  const panel = document.querySelector('[data-kompozycja]');
  const formularz = document.querySelector('[data-formularz-kompozycji]');
  const tytul = document.querySelector('[data-kompozycja-tytul]');
  const status = document.querySelector('[data-status-zapisu]');
  const stempel = document.querySelector('[data-stempel-wyslano]');
  const stempelNapis = document.querySelector('[data-stempel-napis]');
  const stempelData = document.querySelector('[data-stempel-data]');
  const przyciskWyslij = formularz.querySelector('.btn-wyslij');
  const listaZalacznikow = document.querySelector('[data-zalaczniki]');
  const plikInput = document.querySelector('[data-plik-input]');

  const poleOd = document.querySelector('[data-pole-od]');
  const wyborOd = document.querySelector('[data-od]');
  const poleDw = document.querySelector('[data-pole-dw]');
  const poleUdw = document.querySelector('[data-pole-udw]');
  const nadajPozniej = document.querySelector('[data-nadaj-pozniej]');
  const nadajPresety = document.querySelector('[data-nadaj-presety]');
  const nadajKiedy = document.querySelector('[data-nadaj-kiedy]');

  const edytor = initEdytor();

  let draftId = null;
  let zapisNaHoryzoncie = null;
  let zapisWToku = null;
  // Odrzucenie albo ponowne otwarcie unieważnia spóźnione odpowiedzi autozapisu.
  let generacja = 0;
  let zmienione = false;
  let zalaczniki = [];
  let uploadyWToku = 0;

  // --- Nadawca (adres główny + aliasy) ------------------------------------------

  async function uzupelnijNadawcow(preferowany) {
    try {
      const { aliases } = await api.aliasy();
      const adresy = [app.stan.user.address, ...aliases.map((a) => a.address)];
      wyborOd.replaceChildren(...adresy.map((adres) => el('option', { value: adres }, adres)));
      wyborOd.value = adresy.includes(preferowany) ? preferowany : app.stan.user.address;
      poleOd.hidden = adresy.length < 2;
    } catch {
      poleOd.hidden = true; // bez aliasów piszemy po prostu z adresu głównego
    }
  }

  function otworz({ do: doKogo = '', dw = '', udw = '', temat = '', tresc = '', trescHtml = '', draft = null } = {}) {
    generacja += 1;
    draftId = draft?.id ?? null;
    zapisWToku = null;
    zmienione = false;
    zalaczniki = [];
    renderujZalaczniki();
    zamknijNadajPozniej();
    formularz.do.value = draft?.to_addr ?? doKogo;
    formularz.dw.value = draft?.cc_addr ?? dw;
    formularz.udw.value = draft?.bcc_addr ?? udw;
    formularz.temat.value = draft?.subject ?? temat;
    poleDw.hidden = !formularz.dw.value;
    poleUdw.hidden = !formularz.udw.value;
    if (draft?.body_html) edytor.ustaw({ html: draft.body_html });
    else if (draft) edytor.ustaw({ tekst: draft.body ?? '' });
    else if (trescHtml) edytor.ustaw({ html: trescHtml });
    else edytor.ustaw({ tekst: tresc });
    uzupelnijNadawcow(draft?.from_addr ?? app.stan.user.address);
    tytul.textContent = draftId ? 'Wersja robocza' : 'Nowa wiadomość';
    status.textContent = '';
    stempel.classList.remove('przybity');
    panel.hidden = false;
    if (!formularz.do.value) formularz.do.focus();
    else if (!formularz.temat.value) formularz.temat.focus();
    else edytor.fokus({ naPoczatku: true });
  }

  // --- Pola DW / UDW ---------------------------------------------------------------

  document.querySelector('[data-akcja="pokaz-dw"]').addEventListener('click', () => {
    poleDw.hidden = false;
    formularz.dw.focus();
  });
  document.querySelector('[data-akcja="pokaz-udw"]').addEventListener('click', () => {
    poleUdw.hidden = false;
    formularz.udw.focus();
  });

  // --- Załączniki -----------------------------------------------------------

  function renderujZalaczniki() {
    listaZalacznikow.hidden = !zalaczniki.length;
    listaZalacznikow.replaceChildren();
    for (const [indeks, plik] of zalaczniki.entries()) {
      listaZalacznikow.append(
        el(
          'li',
          { class: 'zalacznik-chip' },
          ikona('attach'),
          el('span', { class: 'zalacznik-nazwa' }, plik.filename),
          el('small', {}, formatujRozmiar(plik.size)),
          el(
            'button',
            {
              type: 'button',
              class: 'zalacznik-usun',
              'aria-label': `Usuń załącznik ${plik.filename}`,
              onclick: () => {
                zalaczniki.splice(indeks, 1);
                renderujZalaczniki();
              },
            },
            ikona('close')
          )
        )
      );
    }
  }

  function ustawBlokadeWysylki() {
    przyciskWyslij.disabled = uploadyWToku > 0;
  }

  async function dodajPliki(pliki) {
    for (const plik of pliki) {
      if (zalaczniki.length + uploadyWToku >= 10) {
        toast('Najwyżej 10 załączników w jednej wiadomości.', { blad: true });
        break;
      }
      if (plik.size > 5 * 1024 * 1024) {
        toast(`„${plik.name}” przekracza 5 MB.`, { blad: true });
        continue;
      }
      uploadyWToku += 1;
      ustawBlokadeWysylki();
      status.textContent = `Wysyłanie: ${plik.name}…`;
      try {
        const upload = await api.uploadPlik(plik);
        zalaczniki.push(upload);
        renderujZalaczniki();
        status.textContent = '';
      } catch (blad) {
        toast(blad.message, { blad: true });
        status.textContent = '';
      } finally {
        uploadyWToku -= 1;
        ustawBlokadeWysylki();
      }
    }
    plikInput.value = '';
  }

  document
    .querySelector('[data-akcja="dodaj-zalacznik"]')
    .addEventListener('click', () => plikInput.click());
  plikInput.addEventListener('change', () => dodajPliki([...plikInput.files]));

  function otwarte() {
    return !panel.hidden;
  }

  function pola() {
    return {
      to: formularz.do.value.trim(),
      cc: formularz.dw.value.trim(),
      bcc: formularz.udw.value.trim(),
      from: wyborOd.value,
      subject: formularz.temat.value.trim(),
      body: edytor.pobierzTekst(),
      bodyHtml: edytor.pobierzHtml(),
    };
  }

  function puste() {
    const { to, cc, bcc, subject } = pola();
    return !to && !cc && !bcc && !subject && edytor.pusty();
  }

  async function zapiszRobocza() {
    if (puste()) return null;
    const gen = generacja;
    const obietnica = api.wyslij({ draft: true, id: draftId, ...pola() }).then((w) => w.message.id);
    zapisWToku = obietnica.catch(() => null);
    try {
      const id = await obietnica;
      if (gen !== generacja) return id;
      draftId = id;
      zmienione = false;
      const teraz = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      status.textContent = `Wersja robocza zapisana ${teraz}`;
      if (app.stan.folder === 'drafts') app.odswiezListe({ cicho: true });
      return id;
    } catch {
      if (gen === generacja) status.textContent = 'Nie udało się zapisać wersji roboczej';
      return null;
    }
  }

  function zaplanujZapis() {
    zmienione = true;
    status.textContent = '';
    clearTimeout(zapisNaHoryzoncie);
    zapisNaHoryzoncie = setTimeout(zapiszRobocza, 1600);
  }

  formularz.addEventListener('input', zaplanujZapis);
  wyborOd.addEventListener('change', zaplanujZapis);

  async function zamknij({ zapisz = true } = {}) {
    clearTimeout(zapisNaHoryzoncie);
    zamknijNadajPozniej();
    if (zapisz && zmienione && !puste()) {
      await zapiszRobocza();
      toast('Zapisano wersję roboczą', { ikonaNazwa: 'draft' });
    }
    panel.hidden = true;
  }

  // Cofnięcie odrzucenia: list wraca z Kosza do wersji roboczych i (o ile nie piszemy
  // już czegoś innego) z powrotem do okna, żeby dało się dokończyć zdanie.
  async function przywrocRobocza(id) {
    try {
      const { message } = await api.zmien(id, { folder: 'drafts' });
      if (app.stan.folder === 'drafts') app.odswiezListe({ cicho: true });
      app.odswiezLiczniki();
      if (otwarte()) toast('Wersja robocza wróciła do folderu', { ikonaNazwa: 'draft' });
      else otworz({ draft: message });
    } catch (blad) {
      toast(blad.message, { blad: true });
    }
  }

  // Odrzucenie: porzuca pisany tekst, a zapisaną wersję roboczą przenosi do Kosza.
  async function odrzuc() {
    clearTimeout(zapisNaHoryzoncie);
    generacja += 1;
    const znanyId = draftId;
    const zapis = zapisWToku;
    draftId = null;
    zapisWToku = null;
    zmienione = false;
    zamknijNadajPozniej();
    panel.hidden = true;

    // Autozapis mógł być w drodze, więc poczekaj, żeby świeżo utworzony zapis też sprzątnąć.
    const id = znanyId ?? (zapis ? await zapis : null);
    if (id) {
      try {
        await api.usun(id);
      } catch (blad) {
        return toast(blad.message, { blad: true });
      }
      if (app.stan.folder === 'drafts') app.odswiezListe({ cicho: true });
      app.odswiezLiczniki();
      // Cofnięcie tylko dla zapisanej wersji: nigdy niezapisanego tekstu nie ma skąd wziąć.
      return toast('Odrzucono wersję roboczą', { ikonaNazwa: 'trash', cofnij: () => przywrocRobocza(id) });
    }
    toast('Odrzucono wersję roboczą', { ikonaNazwa: 'trash' });
  }

  // --- Wysyłka: teraz albo o wybranej porze -------------------------------------------

  async function wyslij(scheduledAt = null) {
    const dane = pola();
    if (!dane.to && !dane.cc && !dane.bcc) {
      toast('Podaj adresata wiadomości.', { blad: true });
      formularz.do.focus();
      return;
    }
    clearTimeout(zapisNaHoryzoncie);
    zamknijNadajPozniej();
    przyciskWyslij.disabled = true;
    try {
      // Autozapis w locie mógł właśnie utworzyć zapis; bez tego id wysyłka by go osierociła.
      if (zapisWToku) draftId = (await zapisWToku) ?? draftId;
      await api.wyslij({ ...dane, draftId, uploads: zalaczniki.map((z) => z.token), scheduledAt });
      const kiedy = scheduledAt ? new Date(scheduledAt) : new Date();
      stempelNapis.textContent = scheduledAt ? 'ZAPLANOWANO' : 'WYSŁANO';
      if (scheduledAt) stempelNapis.setAttribute('textLength', '132');
      else stempelNapis.removeAttribute('textLength');
      stempelData.textContent = kiedy.toLocaleDateString('pl-PL');
      stempel.classList.add('przybity');
      setTimeout(() => {
        panel.hidden = true;
        stempel.classList.remove('przybity');
        toast(
          scheduledAt ? `Zaplanowano na ${ladnaData(kiedy)}` : 'Wysłano ✓',
          { ikonaNazwa: scheduledAt ? 'clock' : 'send' }
        );
        clearTimeout(zapisNaHoryzoncie);
        generacja += 1;
        draftId = null;
        zapisWToku = null;
        zmienione = false;
        zalaczniki = [];
        renderujZalaczniki();
        if (['sent', 'drafts', 'scheduled'].includes(app.stan.folder)) {
          app.odswiezListe({ cicho: true });
        }
        app.odswiezLiczniki();
      }, 720);
    } catch (blad) {
      toast(blad.message, { blad: true });
    } finally {
      przyciskWyslij.disabled = false;
    }
  }

  formularz.addEventListener('submit', (e) => {
    e.preventDefault();
    wyslij();
  });

  // --- Okienko „Nadaj później" ----------------------------------------------------

  function ladnaData(data) {
    return data.toLocaleString('pl-PL', {
      weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  function naWartoscInputa(data) {
    const p = (n) => String(n).padStart(2, '0');
    return `${data.getFullYear()}-${p(data.getMonth() + 1)}-${p(data.getDate())}T${p(data.getHours())}:${p(data.getMinutes())}`;
  }

  function zbudujPresety() {
    const teraz = new Date();
    const presety = [];

    const dzisWieczorem = new Date(teraz);
    dzisWieczorem.setHours(18, 0, 0, 0);
    if (dzisWieczorem.getTime() - teraz.getTime() > 5 * 60_000) {
      presety.push(['Dziś wieczorem', dzisWieczorem]);
    }

    const jutroRano = new Date(teraz);
    jutroRano.setDate(jutroRano.getDate() + 1);
    jutroRano.setHours(8, 0, 0, 0);
    presety.push(['Jutro rano', jutroRano]);

    const poniedzialek = new Date(teraz);
    poniedzialek.setDate(poniedzialek.getDate() + (((8 - poniedzialek.getDay()) % 7) || 7));
    poniedzialek.setHours(8, 0, 0, 0);
    presety.push(['W poniedziałek rano', poniedzialek]);

    return presety;
  }

  function otworzNadajPozniej() {
    const presety = zbudujPresety();
    nadajPresety.replaceChildren(
      ...presety.map(([nazwa, data]) =>
        el(
          'button',
          { type: 'button', class: 'nadaj-preset', onclick: () => wyslij(data.toISOString()) },
          el('span', {}, nazwa),
          el('small', {}, ladnaData(data))
        )
      )
    );
    const jutro = presety.find(([nazwa]) => nazwa === 'Jutro rano')[1];
    nadajKiedy.value = naWartoscInputa(jutro);
    nadajKiedy.min = naWartoscInputa(new Date(Date.now() + 2 * 60_000));
    nadajPozniej.hidden = false;
  }

  function zamknijNadajPozniej() {
    nadajPozniej.hidden = true;
  }

  document.querySelector('[data-akcja="wyslij-pozniej"]').addEventListener('click', () => {
    if (nadajPozniej.hidden) otworzNadajPozniej();
    else zamknijNadajPozniej();
  });

  document.querySelector('[data-akcja="zaplanuj"]').addEventListener('click', () => {
    const data = new Date(nadajKiedy.value);
    if (Number.isNaN(data.getTime())) return toast('Wybierz datę i godzinę wysyłki.', { blad: true });
    if (data.getTime() <= Date.now()) return toast('Termin wysyłki musi być w przyszłości.', { blad: true });
    wyslij(data.toISOString());
  });

  document.addEventListener('pointerdown', (e) => {
    if (!nadajPozniej.hidden && !e.target.closest('[data-nadaj-pozniej]') && !e.target.closest('[data-akcja="wyslij-pozniej"]')) {
      zamknijNadajPozniej();
    }
  });

  // Zamyka nakładki (dymki edytora, okienko planowania); true, gdy coś było otwarte.
  function zamknijNakladki() {
    if (!nadajPozniej.hidden) {
      zamknijNadajPozniej();
      return true;
    }
    if (edytor.maDymek()) {
      edytor.zamknijDymki();
      return true;
    }
    return false;
  }

  document
    .querySelector('[data-akcja="zamknij-kompozycje"]')
    .addEventListener('click', () => zamknij());

  document
    .querySelector('[data-akcja="odrzuc-robocza"]')
    .addEventListener('click', odrzuc);

  return { otworz, zamknij, otwarte, zamknijNakladki };
}

// Cytowanie przy odpowiedzi: oryginał wjeżdża jako blockquote (HTML, gdy jest).
export function zbudujOdpowiedz(wiadomosc, uzytkownik) {
  const temat = wiadomosc.subject.startsWith('Re:') ? wiadomosc.subject : `Re: ${wiadomosc.subject}`;
  const data = new Date(wiadomosc.sent_at).toLocaleString('pl-PL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const naglowek = `${data}, ${wiadomosc.from_name || wiadomosc.from_addr} napisał(a):`;
  const cytat = wiadomosc.body_html ? sanitizeHtml(wiadomosc.body_html) : tekstNaHtml(wiadomosc.body);
  const podpis = uzytkownik.signature ? `<br><br>${tekstNaHtml(uzytkownik.signature)}` : '';
  return {
    do: wiadomosc.from_addr,
    temat,
    trescHtml: `${podpis}<br><br>${eskapujHtml(naglowek)}<blockquote>${cytat}</blockquote>`,
  };
}

export function zbudujPrzekazanie(wiadomosc) {
  const temat = wiadomosc.subject.startsWith('Fwd:') ? wiadomosc.subject : `Fwd: ${wiadomosc.subject}`;
  const naglowek = [
    '---------- Wiadomość przekazana ----------',
    `Od: ${wiadomosc.from_name} <${wiadomosc.from_addr}>`,
    `Data: ${new Date(wiadomosc.sent_at).toLocaleString('pl-PL')}`,
    `Temat: ${wiadomosc.subject}`,
    `Do: ${wiadomosc.to_addr}`,
  ].join('\n');
  const tresc = wiadomosc.body_html ? sanitizeHtml(wiadomosc.body_html) : tekstNaHtml(wiadomosc.body);
  return {
    do: '',
    temat,
    trescHtml: `<br><br>${tekstNaHtml(naglowek)}<br><br>${tresc}`,
  };
}
