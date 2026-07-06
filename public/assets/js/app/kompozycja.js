// Okno pisania wiadomości: szkice z autozapisem i stempel „WYSŁANO" przy wysyłce.

import { api } from './api.js';
import { toast } from './ui.js';

export function initKompozycja(app) {
  const panel = document.querySelector('[data-kompozycja]');
  const formularz = document.querySelector('[data-formularz-kompozycji]');
  const tytul = document.querySelector('[data-kompozycja-tytul]');
  const status = document.querySelector('[data-status-szkicu]');
  const stempel = document.querySelector('[data-stempel-wyslano]');
  const stempelData = document.querySelector('[data-stempel-data]');
  const przyciskWyslij = formularz.querySelector('.btn-wyslij');

  let draftId = null;
  let zapisNaHoryzoncie = null;
  let zmienione = false;

  function otworz({ do: doKogo = '', temat = '', tresc = '', draft = null } = {}) {
    draftId = draft?.id ?? null;
    zmienione = false;
    formularz.do.value = draft?.to_addr ?? doKogo;
    formularz.temat.value = draft?.subject ?? temat;
    formularz.tresc.value = draft?.body ?? tresc;
    tytul.textContent = draftId ? 'Szkic' : 'Nowa wiadomość';
    status.textContent = '';
    stempel.classList.remove('przybity');
    panel.hidden = false;
    const cel = formularz.do.value ? (formularz.temat.value ? formularz.tresc : formularz.temat) : formularz.do;
    cel.focus();
    if (cel === formularz.tresc) cel.setSelectionRange(0, 0);
  }

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

  async function zapiszSzkic() {
    if (puste()) return;
    try {
      const wynik = await api.wyslij({ draft: true, id: draftId, ...pola() });
      draftId = wynik.message.id;
      zmienione = false;
      const teraz = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
      status.textContent = `Szkic zapisany ${teraz}`;
      if (app.stan.folder === 'drafts') app.odswiezListe({ cicho: true });
    } catch {
      status.textContent = 'Nie udało się zapisać szkicu';
    }
  }

  function zaplanujZapis() {
    zmienione = true;
    status.textContent = '';
    clearTimeout(zapisNaHoryzoncie);
    zapisNaHoryzoncie = setTimeout(zapiszSzkic, 1600);
  }

  formularz.addEventListener('input', zaplanujZapis);

  async function zamknij({ zapisz = true } = {}) {
    clearTimeout(zapisNaHoryzoncie);
    if (zapisz && zmienione && !puste()) {
      await zapiszSzkic();
      toast('Zapisano w szkicach', { ikonaNazwa: 'draft' });
    }
    panel.hidden = true;
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
      await api.wyslij({ to, subject, body, draftId });
      const dzis = new Date();
      stempelData.textContent = dzis.toLocaleDateString('pl-PL');
      stempel.classList.add('przybity');
      setTimeout(() => {
        panel.hidden = true;
        stempel.classList.remove('przybity');
        toast('Wysłano ✓', { ikonaNazwa: 'send' });
        draftId = null;
        zmienione = false;
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
