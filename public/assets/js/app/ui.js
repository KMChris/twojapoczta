// Drobne narzędzia UI: budowanie DOM, czas po polsku, awatary, toasty, linkowanie.

export function el(tag, atrybuty = {}, ...dzieci) {
  const wezel = document.createElement(tag);
  for (const [klucz, wartosc] of Object.entries(atrybuty)) {
    if (wartosc == null) continue;
    if (klucz === 'class') wezel.className = wartosc;
    else if (klucz === 'dataset') Object.assign(wezel.dataset, wartosc);
    else if (klucz.startsWith('on')) wezel.addEventListener(klucz.slice(2), wartosc);
    else wezel.setAttribute(klucz, wartosc);
  }
  wezel.append(...dzieci.filter((d) => d != null));
  return wezel;
}

export function ikona(nazwa) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${nazwa}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.append(use);
  return svg;
}

const MIESIACE = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];

export function krotkiCzas(iso) {
  const data = new Date(iso);
  const teraz = new Date();
  const tenSamDzien = data.toDateString() === teraz.toDateString();
  if (tenSamDzien) {
    return data.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
  }
  const wczoraj = new Date(teraz);
  wczoraj.setDate(teraz.getDate() - 1);
  if (data.toDateString() === wczoraj.toDateString()) return 'wczoraj';
  if (data.getFullYear() === teraz.getFullYear()) {
    return `${data.getDate()} ${MIESIACE[data.getMonth()]}`;
  }
  return data.toLocaleDateString('pl-PL');
}

export function pelnaData(iso) {
  return new Date(iso).toLocaleString('pl-PL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function inicjaly(nazwa, adres) {
  const zrodlo = (nazwa || adres || '?').trim();
  const czesci = zrodlo.split(/\s+/).filter((czesc) => /[\p{L}\p{N}]/u.test(czesc[0]));
  if (czesci.length >= 2) return (czesci[0][0] + czesci[1][0]).toUpperCase();
  return (czesci[0] ?? zrodlo).slice(0, 2).toUpperCase();
}

const KOLORY_AWATARA = ['#2547d0', '#c2331f', '#0f7a4d', '#8a5a2b', '#5b4bb5', '#b23a68', '#0b7285'];

export function kolorAwatara(adres = '') {
  let suma = 0;
  for (const znak of adres) suma = (suma * 31 + znak.codePointAt(0)) % 997;
  return KOLORY_AWATARA[suma % KOLORY_AWATARA.length];
}

// Treść jako tekst + klikalne linki http(s). Zero innerHTML.
export function wstawTrescZLinkami(cel, tekst) {
  cel.replaceChildren();
  const czesci = String(tekst).split(/(https?:\/\/[^\s<>"')\]]+)/g);
  for (const czesc of czesci) {
    if (/^https?:\/\//.test(czesc)) {
      const a = el('a', { href: czesc, target: '_blank', rel: 'noopener noreferrer' }, czesc);
      cel.append(a);
    } else if (czesc) {
      cel.append(document.createTextNode(czesc));
    }
  }
}

const strefaToastow = () => document.querySelector('[data-toasty]');

export function toast(tekst, { blad = false, ikonaNazwa = 'mail' } = {}) {
  const wpis = el('div', { class: `toast${blad ? ' blad' : ''}` }, ikona(blad ? 'spam' : ikonaNazwa), tekst);
  strefaToastow().append(wpis);
  setTimeout(() => {
    wpis.classList.add('znika');
    setTimeout(() => wpis.remove(), 350);
  }, 3400);
}

export function bezOgonkow(tekst) {
  return tekst
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l');
}
