// Okno pisania wiadomości: wersje robocze z autozapisem i stempel „WYSŁANO" przy wysyłce.

import { api } from './api.js';
import { el, ikona, toast, formatujRozmiar } from './ui.js';

export function initKompozycja(app) {
  const panel = document.querySelector('[data-kompozycja]');
  const formularz = document.querySelector('[data-formularz-kompozycji]');
  const tytul = document.querySelector('[data-kompozycja-tytul]');
  const status = document.querySelector('[data-status-zapisu]');
  const stempel = document.querySelector('[data-stempel-wyslano]');
  const stempelData = document.querySelector('[data-stempel-data]');
  const przyciskWyslij = formularz.querySelector('.btn-wyslij');
  const listaZalacznikow = document.querySelector('[data-zalaczniki]');
  const plikInput = document.querySelector('[data-plik-input]');

  let draftId = null;
  let zapisNaHoryzoncie = null;
  let zapisWToku = null;
  // Odrzucenie albo ponowne otwarcie unieważnia spóźnione odpowiedzi autozapisu.
  let generacja = 0;
  let zmienione = false;
  let zalaczniki = [];
  let uploadyWToku = 0;

  function otworz({ do: doKogo = '', temat = '', tresc = '', draft = null } = {}) {
    generacja += 1;
    draftId = draft?.id ?? null;
    zapisWToku = null;
    zmienione = false;
    zalaczniki = [];
    renderujZalaczniki();
    formularz.do.value = draft?.to_addr ?? doKogo;
    formularz.temat.value = draft?.subject ?? temat;
    formularz.tresc.value = draft?.body ?? tresc;
    tytul.textContent = draftId ? 'Wersja robocza' : 'Nowa wiadomość';
    status.textContent = '';
    stempel.classList.remove('przybity');
    panel.hidden = false;
    const cel = formularz.do.value ? (formularz.temat.value ? formularz.tresc : formularz.temat) : formularz.do;
    cel.focus();
    if (cel === formularz.tresc) cel.setSelectionRange(0, 0);
  }

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
      subject: formularz.temat.value.trim(),
      body: formularz.tresc.value,
    };
  }

  function puste() {
    const { to, subject, body } = pola();
    return !to && !subject && !body.trim();
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

  async function zamknij({ zapisz = true } = {}) {
    clearTimeout(zapisNaHoryzoncie);
    if (zapisz && zmienione && !puste()) {
      await zapiszRobocza();
      toast('Zapisano wersję roboczą', { ikonaNazwa: 'draft' });
    }
    panel.hidden = true;
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
    }
    toast('Odrzucono wersję roboczą', { ikonaNazwa: 'trash' });
  }

  formularz.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { to, subject, body } = pola();
    if (!to) {
      toast('Podaj adresata wiadomości.', { blad: true });
      formularz.do.focus();
      return;
    }
    clearTimeout(zapisNaHoryzoncie);
    przyciskWyslij.disabled = true;
    try {
      // Autozapis w locie mógł właśnie utworzyć zapis; bez tego id wysyłka by go osierociła.
      if (zapisWToku) draftId = (await zapisWToku) ?? draftId;
      await api.wyslij({ to, subject, body, draftId, uploads: zalaczniki.map((z) => z.token) });
      const dzis = new Date();
      stempelData.textContent = dzis.toLocaleDateString('pl-PL');
      stempel.classList.add('przybity');
      setTimeout(() => {
        panel.hidden = true;
        stempel.classList.remove('przybity');
        toast('Wysłano ✓', { ikonaNazwa: 'send' });
        clearTimeout(zapisNaHoryzoncie);
        generacja += 1;
        draftId = null;
        zapisWToku = null;
        zmienione = false;
        zalaczniki = [];
        renderujZalaczniki();
        if (app.stan.folder === 'sent' || app.stan.folder === 'drafts') {
          app.odswiezListe({ cicho: true });
        }
        app.odswiezLiczniki();
      }, 720);
    } catch (blad) {
      toast(blad.message, { blad: true });
    } finally {
      przyciskWyslij.disabled = false;
    }
  });

  document
    .querySelector('[data-akcja="zamknij-kompozycje"]')
    .addEventListener('click', () => zamknij());

  document
    .querySelector('[data-akcja="odrzuc-robocza"]')
    .addEventListener('click', odrzuc);

  return { otworz, zamknij, otwarte };
}

// Cytowanie przy odpowiedzi.
export function zbudujOdpowiedz(wiadomosc, uzytkownik) {
  const temat = wiadomosc.subject.startsWith('Re:') ? wiadomosc.subject : `Re: ${wiadomosc.subject}`;
  const data = new Date(wiadomosc.sent_at).toLocaleString('pl-PL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const cytat = wiadomosc.body
    .split('\n')
    .map((linia) => `> ${linia}`)
    .join('\n');
  const podpis = uzytkownik.signature ? `\n\n${uzytkownik.signature}` : '';
  return {
    do: wiadomosc.from_addr,
    temat,
    tresc: `${podpis}\n\n${data}, ${wiadomosc.from_name || wiadomosc.from_addr} napisał(a):\n${cytat}`,
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
  return {
    do: '',
    temat,
    tresc: `\n\n${naglowek}\n\n${wiadomosc.body}`,
  };
}
