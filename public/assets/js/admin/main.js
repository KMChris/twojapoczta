// Panel administratora · rdzeń: strażnik roli, motyw, nawigacja sekcji.

import { api } from './api.js';
import { initPulpit } from './pulpit.js';
import { initUzytkownicy } from './uzytkownicy.js';
import { initDomena } from './domena.js';
import { initUstawienia } from './ustawienia.js';
import { initDziennik } from './dziennik.js';

const SEKCJE = ['pulpit', 'uzytkownicy', 'domena', 'ustawienia', 'dziennik'];
const TYTULY = {
  pulpit: 'Pulpit',
  uzytkownicy: 'Użytkownicy',
  domena: 'Domena i DNS',
  ustawienia: 'Ustawienia',
  dziennik: 'Dziennik zdarzeń',
};

const stan = { user: null, sekcja: null };
const widoki = {};

// --- Motyw (ten sam mechanizm, co w skrzynce) ---------------------------------

const systemowyCiemny = matchMedia('(prefers-color-scheme: dark)');

function zastosujMotyw() {
  const motyw = stan.user?.theme ?? 'system';
  const ciemny = motyw === 'dark' || (motyw === 'system' && systemowyCiemny.matches);
  if (ciemny) document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

systemowyCiemny.addEventListener('change', zastosujMotyw);

// --- Nawigacja -----------------------------------------------------------------

function pokazSekcje(sekcja, { zHash = false } = {}) {
  if (!SEKCJE.includes(sekcja)) sekcja = 'pulpit';
  stan.sekcja = sekcja;
  if (!zHash) history.replaceState(null, '', `#${sekcja}`);

  document.querySelectorAll('.folder').forEach((f) => {
    f.classList.toggle('aktywny', f.dataset.sekcja === sekcja);
  });
  for (const s of SEKCJE) {
    document.querySelector(`[data-widok="${s}"]`).hidden = s !== sekcja;
  }
  document.title = `${TYTULY[sekcja]} · Panel · TwojaPoczta`;
  widoki[sekcja]?.pokaz();
}

// --- Start -----------------------------------------------------------------------

async function start() {
  let user;
  try {
    ({ user } = await api.ja());
  } catch {
    return; // api.js przekierowało do logowania
  }
  if (!user.is_admin) {
    location.replace('/app');
    return;
  }
  stan.user = user;
  zastosujMotyw();
  document.querySelector('[data-adres]').textContent = user.address;

  widoki.pulpit = initPulpit();
  widoki.uzytkownicy = initUzytkownicy(stan);
  widoki.domena = initDomena();
  widoki.ustawienia = initUstawienia();
  widoki.dziennik = initDziennik();

  for (const przycisk of document.querySelectorAll('.folder')) {
    przycisk.addEventListener('click', () => pokazSekcje(przycisk.dataset.sekcja));
  }
  document.querySelector('[data-akcja="wyloguj"]').addEventListener('click', async () => {
    try {
      await api.wyloguj();
    } finally {
      location.href = '/logowanie';
    }
  });
  window.addEventListener('hashchange', () => pokazSekcje(location.hash.slice(1), { zHash: true }));

  pokazSekcje(location.hash.slice(1) || 'pulpit');
}

start();
