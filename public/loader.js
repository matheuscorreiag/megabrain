// The "agent is working" indicator shown at the end of the thread.
//
// Self-contained on purpose: restyle it in style.css (section "loader") or
// replace this file entirely. The app only relies on this contract:
//
//   const loader = createLoader();   // -> { el, update(state), destroy() }
//   loader.update({ phase, label })  // phase: thinking | writing | tool

// The app icon's flying wing (macos/AppIcon.svg, its 1024 grid): a B-2 seen
// from above, its left half in shade. A light sweeps across it while it
// works; contrails stream from its trailing edge while a tool runs.
const WING = 'M512 330 L912 590 L896 612 L776 690 L648 607 L512 695 L376 607 L248 690 L128 612 L112 590 Z';
const SHADE = 'M512 330 L512 695 L376 607 L248 690 L128 612 L112 590 Z';
const TRAILS = [312, 424, 600, 712].map((x, i) => `<line class="trail" style="--i:${i}" x1="${x}" y1="650" x2="${x}" y2="840"/>`);
const CRAFT = `<svg class="loader-wing" viewBox="100 228 824 604" aria-hidden="true">
  <defs>
    <clipPath id="loader-wing-clip"><path d="${WING}"/></clipPath>
    <linearGradient id="loader-lit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fbfbfc"/><stop offset="1" stop-color="#b9bcc2"/></linearGradient>
    <linearGradient id="loader-shade" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9da1a8"/><stop offset="1" stop-color="#4a4e55"/></linearGradient>
    <linearGradient id="loader-sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.8"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g class="trails">${TRAILS.join('')}</g>
  <g class="craft">
    <path d="${WING}" fill="url(#loader-lit)"/>
    <path d="${SHADE}" fill="url(#loader-shade)"/>
    <g clip-path="url(#loader-wing-clip)"><rect class="sheen" x="-260" y="300" width="260" height="420" fill="url(#loader-sheen)"/></g>
  </g>
</svg>`;

export function createLoader() {
  const el = document.createElement('div');
  el.className = 'loader';
  el.setAttribute('role', 'status');

  // The flying wing; style.css animates it differently per phase.
  const mark = document.createElement('span');
  mark.className = 'loader-mark';
  mark.innerHTML = CRAFT;
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
