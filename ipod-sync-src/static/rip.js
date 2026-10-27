/* The easter egg. Click the orb seven times (or enter the old cheat code) and Rip, a cartoon
   compact disc, pops up and offers a hand. "Tell me more" opens his note. */
(() => {
  'use strict';
  const { $ } = window.IP;

  const INK = '#1b2b44';

  // Rip is drawn once and his face changes with data-mood: resting, winking, spinning, scratched.
  const RIP = `
<svg class="rip" role="img" aria-label="Rip, a cartoon compact disc with a face" viewBox="0 0 200 200" data-mood="resting" data-arms="none">
  <g class="r-motion" stroke="#7fb3ff" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.75">
    <path d="M16 74 C6 90 6 110 16 126"/><path d="M184 74 C194 90 194 110 184 126"/>
  </g>
  <g class="r-arms r-wave" stroke="${INK}" stroke-width="5" stroke-linecap="round">
    <path d="M34 120 C12 128 10 150 24 160" fill="none"/>
    <path d="M166 104 C190 96 198 72 186 60" fill="none"/>
    <circle cx="20" cy="164" r="11" fill="#fff"/><circle cx="189" cy="55" r="11" fill="#fff"/>
  </g>
  <g class="r-arms r-peek" stroke="${INK}" stroke-width="5" stroke-linecap="round">
    <path d="M38 118 C14 112 6 92 16 78" fill="none"/>
    <circle cx="14" cy="72" r="11" fill="#fff"/>
  </g>
  <circle cx="100" cy="100" r="80" fill="url(#rip-sheen)" stroke="${INK}" stroke-width="5"/>
  <circle cx="100" cy="100" r="80" fill="url(#rip-gloss)"/>
  <circle cx="100" cy="100" r="30" fill="#0f1d34" stroke="${INK}" stroke-width="4"/>
  <circle cx="100" cy="100" r="13" fill="#16294a" stroke="${INK}" stroke-width="3"/>
  <ellipse cx="47" cy="122" rx="11" ry="7" fill="#ff9ab5" opacity="0.5"/>
  <ellipse cx="153" cy="122" rx="11" ry="7" fill="#ff9ab5" opacity="0.5"/>

  <g class="r-eye-l">
    <ellipse cx="68" cy="68" rx="22" ry="24" fill="#fff" stroke="${INK}" stroke-width="4"/>
    <g class="r-pupil"><circle cx="73" cy="72" r="10" fill="#15243c"/><circle cx="69" cy="67" r="3.6" fill="#fff"/></g>
  </g>
  <g class="r-eye-r">
    <ellipse cx="132" cy="68" rx="22" ry="24" fill="#fff" stroke="${INK}" stroke-width="4"/>
    <g class="r-pupil"><circle cx="137" cy="72" r="10" fill="#15243c"/><circle cx="133" cy="67" r="3.6" fill="#fff"/></g>
  </g>
  <path class="r-arc" d="M114 70 Q132 56 150 70" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
  <g class="r-happy" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round">
    <path d="M50 74 Q68 56 86 74"/><path d="M114 74 Q132 56 150 74"/>
  </g>
  <g class="r-x-marks" stroke="#15243c" stroke-width="5" stroke-linecap="round" fill="none">
    <path d="M62 62 L80 78 M80 62 L62 78"/><path d="M126 62 L144 78 M144 62 L126 78"/>
  </g>

  <path class="r-smile" d="M74 140 Q100 160 126 140" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
  <ellipse class="r-oh" cx="100" cy="142" rx="17" ry="14" fill="#15243c" stroke="${INK}" stroke-width="4"/>
  <path class="r-wavy" d="M78 146 Q90 134 102 146 Q114 158 126 146" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
  <g class="r-scratch" stroke-linecap="round">
    <path d="M40 132 L168 52" stroke="#fff" stroke-width="4" opacity="0.95"/>
    <path d="M40 132 L168 52" stroke="${INK}" stroke-width="1.6" opacity="0.55"/>
  </g>
</svg>`;

  const DEFS = `
<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="rip-sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fff2b8"/><stop offset="22%" stop-color="#b8f2d0"/>
      <stop offset="46%" stop-color="#bfe2ff"/><stop offset="70%" stop-color="#e3c9ff"/>
      <stop offset="88%" stop-color="#ffc9dd"/><stop offset="100%" stop-color="#fff0c2"/>
    </linearGradient>
    <radialGradient id="rip-gloss" cx="34%" cy="26%" r="62%">
      <stop offset="0%" stop-color="#fff" stop-opacity="0.85"/>
      <stop offset="55%" stop-color="#fff" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
  </defs>
</svg>`;

  const mood = (svg, name, arms) => {
    svg.dataset.mood = name;
    if (arms) svg.dataset.arms = arms;
  };

  function init() {
    const pop = $('#rip-pop');
    const note = $('#rip-note');
    if (!pop || !note) return;

    document.body.insertAdjacentHTML('beforeend', DEFS);
    const popRip = $('.rip-slot', pop);
    const noteRip = $('.rip-slot', note);
    popRip.innerHTML = RIP;
    noteRip.innerHTML = RIP;
    mood(popRip.firstElementChild, 'winking', 'peek');
    mood(noteRip.firstElementChild, 'resting', 'wave');

    let leaving = null;
    const hidePop = () => {
      pop.classList.add('leaving');
      clearTimeout(leaving);
      leaving = setTimeout(() => { pop.hidden = true; pop.classList.remove('leaving'); }, 450);
    };
    const busy = () => !pop.hidden || note.open || document.querySelector('dialog[open]');

    const show = () => {
      if (busy()) return;
      clearTimeout(leaving);
      pop.classList.remove('leaving');
      mood(popRip.firstElementChild, 'winking');
      pop.hidden = false;
      $('[data-act="more"]', pop).focus({ preventScroll: true });
    };

    $('[data-act="more"]', pop).addEventListener('click', () => {
      pop.hidden = true;
      const playing = document.body.classList.contains('is-playing');
      mood(noteRip.firstElementChild, playing ? 'spinning' : 'resting');
      note.showModal();
    });
    $('[data-act="no"]', pop).addEventListener('click', hidePop);
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); hidePop(); }
    });

    // Poke Rip in his note and he gets dizzy for a moment.
    let calm = null;
    noteRip.addEventListener('click', () => {
      const svg = noteRip.firstElementChild;
      mood(svg, 'scratched');
      clearTimeout(calm);
      calm = setTimeout(() => mood(svg, 'resting'), 1600);
    });
    $('#rip-close').addEventListener('click', () => note.close());
    note.addEventListener('click', (e) => { if (e.target === note) note.close(); });

    // seven clicks on the orb
    let clicks = 0, timer = null;
    const orb = $('#orb');
    orb.addEventListener('click', () => {
      clicks += 1;
      clearTimeout(timer);
      timer = setTimeout(() => { clicks = 0; }, 2500);
      orb.classList.remove('nudge'); void orb.getBoundingClientRect();
      if (clicks > 2) orb.classList.add('nudge');
      if (clicks >= 7) { clicks = 0; show(); }
    });

    // or the old cheat code
    const code = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
    let at = 0;
    document.addEventListener('keydown', (e) => {
      if (e.target.matches && e.target.matches('input, textarea, select')) { at = 0; return; }
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      at = key === code[at] ? at + 1 : (key === code[0] ? 1 : 0);
      if (at === code.length) { at = 0; show(); }
    });
  }

  window.IP.rip = { init };
})();
