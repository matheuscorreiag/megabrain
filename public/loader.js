// The "agent is working" indicator shown at the end of the thread.
//
// Self-contained on purpose: restyle it in style.css (section "loader") or
// replace this file entirely. The app only relies on this contract:
//
//   const loader = createLoader();   // -> { el, update(state), destroy() }
//   loader.update({ phase, label })  // phase: thinking | writing | tool

// The app icon's brain (macos/AppIcon.svg, its 1024 grid): one half, mirrored,
// with the menu-bar glyph's three grooves so they read at this size.
const HALF = 'M500 268 A62 62 0 0 0 392 284 A70 70 0 0 0 300 368 A70 70 0 0 0 270 490 A70 70 0 0 0 290 614 A70 70 0 0 0 360 718 A84 84 0 0 0 500 756 Z';
const GROOVES = ['M416 290 C 396 330, 404 372, 446 392', 'M282 452 C 330 452, 366 430, 380 392', 'M296 636 C 344 640, 384 618, 402 576'];

// Each groove twice: the groove, and a spark that runs along it (style.css
// animates the dash). The --i stagger makes the signals hop between grooves.
const half = (mirror, offset) => `
  <g${mirror ? ' transform="matrix(-1 0 0 1 1024 0)"' : ''}>
    <path class="lobe" d="${HALF}"/>
    ${GROOVES.map((d) => `<path class="groove" d="${d}"/>`).join('')}
    ${GROOVES.map((d, i) => `<path class="spark" pathLength="100" style="--i:${i * 2 + offset}" d="${d}"/>`).join('')}
  </g>`;
const BRAIN = `<svg class="loader-brain" viewBox="212 212 600 600" aria-hidden="true">
  ${half(false, 0)}${half(true, 1)}
  <circle class="ping" cx="512" cy="512" r="58"/>
  <circle class="core" cx="512" cy="512" r="58"/>
</svg>`;

export function createLoader() {
  const el = document.createElement('div');
  el.className = 'loader';
  el.setAttribute('role', 'status');

  // The brain; style.css animates it differently per phase.
  const mark = document.createElement('span');
  mark.className = 'loader-mark';
  mark.innerHTML = BRAIN;
  const label = document.createElement('span');
  label.className = 'loader-label';
  const time = document.createElement('span');
  time.className = 'loader-time';
  el.append(mark, label, time);

  const started = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    time.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  tick();
  const timer = setInterval(tick, 1000);

  return {
    el,
    update({ phase = 'thinking', label: text = 'Thinking' } = {}) {
      el.dataset.phase = phase;
      label.textContent = `${text}…`;
    },
    destroy() {
      clearInterval(timer);
      el.remove();
    },
  };
}
