// Strona główna: żywy datownik, odsłanianie sekcji, menu mobilne, kopiowanie komend.

document.documentElement.classList.add('js');

const dzis = new Date();
const dd = String(dzis.getDate()).padStart(2, '0');
const mm = String(dzis.getMonth() + 1).padStart(2, '0');
const rrrr = dzis.getFullYear();

// Datownik zawsze stempluje dzisiejszą datę.
const data = document.querySelector('.datownik-data');
if (data) data.textContent = `${dd}.${mm}.${rrrr}`;

// Numer przesyłki w stopce: data nadania.
const nr = document.querySelector('[data-nr-przesylki]');
if (nr) nr.textContent = `TP-${String(rrrr).slice(2)}${mm}${dd}`;

// Menu mobilne.
const burger = document.querySelector('.nav-burger');
const menu = document.querySelector('.nav-menu');
if (burger && menu) {
  burger.addEventListener('click', () => {
    const otwarte = menu.classList.toggle('otwarte');
    burger.setAttribute('aria-expanded', String(otwarte));
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a')) {
      menu.classList.remove('otwarte');
      burger.setAttribute('aria-expanded', 'false');
    }
  });
}

// Kopiowanie komendy z terminala.
for (const przycisk of document.querySelectorAll('[data-kopiuj]')) {
  przycisk.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(przycisk.dataset.kopiuj);
      const bylo = przycisk.textContent;
      przycisk.textContent = 'Skopiowano ✓';
      setTimeout(() => (przycisk.textContent = bylo), 1800);
    } catch {
      przycisk.textContent = 'Ctrl+C ręcznie :)';
    }
  });
}

// Odsłanianie elementów przy przewijaniu (ze zmierzonym opóźnieniem w partii).
const obserwator = new IntersectionObserver(
  (wpisy) => {
    let i = 0;
    for (const wpis of wpisy) {
      if (!wpis.isIntersecting) continue;
      wpis.target.style.transitionDelay = `${Math.min(i * 70, 350)}ms`;
      wpis.target.classList.add('widoczne');
      obserwator.unobserve(wpis.target);
      i += 1;
    }
  },
  { threshold: 0.12, rootMargin: '0px 0px -4% 0px' }
);

for (const el of document.querySelectorAll('.odsl')) obserwator.observe(el);
