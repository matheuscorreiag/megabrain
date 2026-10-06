// Shared by the chat (/) and terminal (/terminal/) pages: DOM and API
// helpers, per-device storage, toasts, the ⋯ menu, inline rename, the
// sidebar (collapses on desktop, drawer on phones), the connection dot and
// per-item accent colors. Styles for all of it: base.css.

export const $ = (sel) => document.querySelector(sel);
export const touch = matchMedia('(pointer: coarse)').matches;
export const narrow = () => matchMedia('(max-width: 800px)').matches;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';
// The installed app's window. Only there do ⌘N / ⌘T / ⌘W reach the page:
// in a browser tab Chrome keeps them (new window, tab, close).
export const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// Every write carries X-Hub: the server refuses writes without it, which a
// cross-site page can't add without a CORS preflight.
export async function api(method, url, body, contentType) {
  const init = { method, headers: { 'x-hub': '1' } };
  if (typeof body === 'string' || body instanceof Blob) {
    init.body = body;
    if (contentType || body.type) init.headers['content-type'] = contentType || body.type;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Per-device conveniences only (localStorage can be unavailable or wiped).
export function storage(prefix) {
  return {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(`${prefix}:${key}`);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (value == null || value === '') localStorage.removeItem(`${prefix}:${key}`);
        else localStorage.setItem(`${prefix}:${key}`, JSON.stringify(value));
      } catch {}
    },
  };
}

let toastTimer;
export function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 5000 : 2500);
}
export const fail = (err) => toast(err?.message || String(err), true);

// Keep the layout inside the visible viewport when the phone keyboard opens.
function syncHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${height}px`);
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', syncHeight);
window.addEventListener('resize', syncHeight);
syncHeight();

// --------------------------------------------------------------- popovers

// Popovers are #menu plus anything marked [data-popover]; clicking outside
// (or on something that isn't their anchor) closes them.
let menuAnchor = null;

export function place(popover, anchor) {
  const r = anchor.getBoundingClientRect();
  const below = r.bottom + popover.offsetHeight + 8 < innerHeight;
  popover.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - popover.offsetHeight - 4)}px`;
  popover.style.left = `${Math.max(8, Math.min(r.right - popover.offsetWidth, innerWidth - popover.offsetWidth - 8))}px`;
}

export function hidePopovers() {
  $('#menu').hidden = true;
  for (const el of document.querySelectorAll('[data-popover]')) el.hidden = true;
  menuAnchor = null;
}

// items: [{ label, run, danger }] — falsy entries are skipped. Clicking the
// same anchor again closes the menu.
export function showMenu(anchor, items) {
  const menu = $('#menu');
  if (!menu.hidden && menuAnchor === anchor) return hidePopovers();
  hidePopovers();
  menuAnchor = anchor;
  menu.replaceChildren(
    ...items.filter(Boolean).map((item) =>
      h('button', {
        type: 'button',
        class: item.danger ? 'danger' : '',
        textContent: item.label,
        onclick: () => {
          hidePopovers();
          item.run();
        },
      }),
    ),
  );
  menu.hidden = false;
  place(menu, anchor);
}

// Capture phase, so clicks on things that handle their own events (the
// terminal) still close popovers.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (e.target.closest('#menu, [data-popover], [data-popover-anchor]') || menuAnchor?.contains(e.target)) return;
    hidePopovers();
  },
  true,
);
window.addEventListener('blur', () => $('#menu').hidden || hidePopovers());

// Swaps `el`'s text for an input; Enter/blur saves, Esc cancels.
export function editInline(el, value, save, { onStart, onEnd } = {}) {
  if (el.querySelector('.rename-input')) return;
  onStart?.();
  const field = h('input', { class: 'rename-input', value, maxLength: 120, 'aria-label': 'New name' });
  el.replaceChildren(field);
  field.focus();
  field.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const title = field.value.trim();
    el.textContent = commit && title ? title : value;
    if (commit && title !== value) await save(title).catch(fail);
    onEnd?.();
  };
  field.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  field.addEventListener('blur', () => finish(true));
  field.addEventListener('click', (e) => e.stopPropagation());
  field.addEventListener('dblclick', (e) => e.stopPropagation());
}

// ---------------------------------------------------------------- sidebar

// Collapses on desktop (remembered per device under `key`), slides in as a
// drawer on phones. Pages wire #close-sidebar / #open-sidebar to `toggle`
// (or to their own wrapper around it).
export function setupSidebar(key) {
  const local = storage('ui');
  if (local.get(key, false)) document.body.classList.add('sidebar-collapsed');
  setupResize(local);
  const setDrawer = (open) => document.body.classList.toggle('sidebar-open', open);
  $('#scrim').addEventListener('click', () => setDrawer(false));
  return {
    setDrawer,
    toggle() {
      if (narrow()) return setDrawer(!document.body.classList.contains('sidebar-open'));
      local.set(key, document.body.classList.toggle('sidebar-collapsed') || null);
    },
  };
}

// Dragging the sidebar's right edge sets its width (--side-w), shared by both
// pages; double-click goes back to the default. Desktop only (base.css).
function setupResize(local) {
  const root = document.documentElement;
  let width = local.get('sidebarWidth', null);
  const apply = () => {
    if (!width) return root.style.removeProperty('--side-w');
    root.style.setProperty('--side-w', `${Math.round(Math.max(200, Math.min(width, 520, innerWidth - 360)))}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  const handle = h('div', { class: 'side-resize', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize · double-click to reset' });
  $('#sidebar').append(handle);
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const left = $('#sidebar').getBoundingClientRect().left;
    const move = (ev) => {
      width = ev.clientX - left;
      apply();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener(
      'lostpointercapture',
      () => {
        handle.removeEventListener('pointermove', move);
        document.body.classList.remove('resizing');
        width = parseInt(root.style.getPropertyValue('--side-w')) || null; // what was applied, clamped
        local.set('sidebarWidth', width);
      },
      { once: true },
    );
  });
  handle.addEventListener('dblclick', () => {
    width = null;
    apply();
    local.set('sidebarWidth', null);
  });
}

// The status dot at the top of the sidebar (and on the floating toggle while
// the sidebar is closed). state: connecting | online | offline
const CONN_LABELS = { connecting: 'Connecting…', online: 'Connected', offline: 'Reconnecting…' };
export function setConn(state) {
  const el = $('#conn');
  el.dataset.state = state;
  el.title = CONN_LABELS[state];
  el.querySelector('.sr-only').textContent = CONN_LABELS[state];
  $('#open-sidebar').dataset.conn = state;
}

// Holding the modifier shows the ⌘1…⌘9 hints next to sidebar items.
document.addEventListener('keydown', (e) => e.key === (isMac ? 'Meta' : 'Control') && document.body.classList.add('show-keys'), true);
document.addEventListener('keyup', (e) => e.key === (isMac ? 'Meta' : 'Control') && document.body.classList.remove('show-keys'));
window.addEventListener('blur', () => document.body.classList.remove('show-keys'));

// ----------------------------------------------------------------- items

// Accents share lightness and chroma (so any hue reads well on the dark UI);
// only the hue varies per chat or terminal.
export const DEFAULT_HUE = 255;
const hueOr = (hue) => (Number.isFinite(hue) ? hue : DEFAULT_HUE);
export const accentFor = (hue) => `oklch(0.78 0.14 ${hueOr(hue)})`;
// The page background for a hue — keep in sync with --bg in base.css.
export const surfaceFor = (hue) => `oklch(0.165 0.014 ${hueOr(hue)})`;

// Tints the whole page (base.css derives every color from --h) and the
// browser's toolbar.
export function setHue(hue) {
  document.documentElement.style.setProperty('--h', hueOr(hue));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', toHex(surfaceFor(hue)));
}

// Some consumers (xterm.js, theme-color) only understand sRGB; let a canvas
// convert oklch().
const swatch = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
export function toHex(color) {
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = color;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b] = swatch.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// Sidebar items are numbered: the number is also their ⌘ shortcut.
export const indexLabel = (i) => String(i + 1).padStart(2, '0');

export const MORE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

export function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
