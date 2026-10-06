// The "agent is working" indicator shown at the end of the thread.
//
// Self-contained on purpose: restyle it in style.css (section "loader") or
// replace this file entirely. The app only relies on this contract:
//
//   const loader = createLoader();   // -> { el, update(state), destroy() }
//   loader.update({ phase, label })  // phase: thinking | writing | tool

export function createLoader() {
  const el = document.createElement('div');
  el.className = 'loader';
  el.setAttribute('role', 'status');

  // Three dots; style.css animates them differently per phase.
  const mark = document.createElement('span');
  mark.className = 'loader-mark';
  mark.append(...[0, 1, 2].map(() => document.createElement('i')));
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
