// TwojaPoczta · dymek podpowiedzi. Jeden element na stronę, cele wskazuje [data-dymek].
// Popover manual, bo modalne <dialog> żyją w warstwie wierzchniej: zwykły div zostałby
// pod oknem ustawień, a tam mieszkają przyciski (i). Promocja showPopover() przy każdym
// pokazaniu, tym samym ruchem co strefa toastów (ui.js).

const ODSTEP = 8;
const ZWLOKA = 350;

// Czysta geometria (testowana w node): nad celem, wyśrodkowana, klamrowana do okna;
// gdy u góry brak miejsca, dymek schodzi pod cel.
export function pozycjaDymka(cel, rozmiar, widok, odstep = ODSTEP) {
  const lewo = Math.max(odstep, Math.min(cel.left + cel.width / 2 - rozmiar.width / 2, widok.width - rozmiar.width - odstep));
  const nad = cel.top - rozmiar.height - odstep;
  const podCelem = nad < odstep;
  return { left: lewo, top: podCelem ? cel.bottom + odstep : nad, podCelem };
}

export function initDymki() {
  const dymek = document.createElement('div');
  dymek.id = 'dymek';
  dymek.className = 'dymek';
  dymek.setAttribute('role', 'tooltip');
  dymek.setAttribute('popover', 'manual');
  document.body.append(dymek);

  let cel = null;
  let zegar = 0;

  function pokaz(nowyCel) {
    if (cel && cel !== nowyCel) schowaj();
    cel = nowyCel;
    dymek.textContent = nowyCel.dataset.dymek;
    if (dymek.matches(':popover-open')) dymek.hidePopover();
    dymek.showPopover();
    const p = pozycjaDymka(
      nowyCel.getBoundingClientRect(),
      dymek.getBoundingClientRect(),
      { width: innerWidth, height: innerHeight }
    );
    dymek.style.left = `${p.left}px`;
    dymek.style.top = `${p.top}px`;
    nowyCel.setAttribute('aria-describedby', 'dymek');
  }

  function schowaj() {
    clearTimeout(zegar);
    if (!cel) return;
    if (cel.getAttribute('aria-describedby') === 'dymek') cel.removeAttribute('aria-describedby');
    cel = null;
    if (dymek.matches(':popover-open')) dymek.hidePopover();
  }

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return; // dotyk nie najeżdża; z fokusu dymek i tak wyjdzie
    const t = e.target.closest?.('[data-dymek]');
    if (!t || t === cel) return;
    clearTimeout(zegar);
    zegar = setTimeout(() => pokaz(t), ZWLOKA);
  });

  document.addEventListener('pointerout', (e) => {
    const t = e.target.closest?.('[data-dymek]');
    if (!t || (e.relatedTarget && t.contains(e.relatedTarget))) return;
    if (t === cel) schowaj();
    else clearTimeout(zegar);
  });

  // Fokus pokazuje bez zwłoki, ale tylko widoczny (Tab), nie każdy klik w przycisk.
  document.addEventListener('focusin', (e) => {
    const t = e.target.closest?.('[data-dymek]');
    if (t && t.matches(':focus-visible')) pokaz(t);
  });
  document.addEventListener('focusout', (e) => {
    if (cel && e.target.closest?.('[data-dymek]') === cel) schowaj();
  });

  // Działanie ważniejsze niż podpowiedź: klik, Esc i przewinięcie sprzątają dymek.
  document.addEventListener('pointerdown', schowaj);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') schowaj();
  });
  addEventListener('scroll', schowaj, { capture: true, passive: true });
  addEventListener('resize', schowaj);
}
