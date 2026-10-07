// Shared by the chat (/) and terminal (/terminal/) pages: DOM and API
// helpers, per-device storage, toasts, the ⋯ menu, inline rename, the
// sidebar (collapses on desktop, drawer on phones), the connection dot and
// per-item accent colors. Styles for all of it: base.css.

export const $ = (sel) => document.querySelector(sel);
export const touch = matchMedia('(pointer: coarse)').matches;
export const narrow = () => matchMedia('(max-width: 800px)').matches;
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl+';
// Inside the macOS app (macos/): it registers this handler and wants to hear
// about on / off.
const hub = window.webkit?.messageHandlers?.hub;
export const native = hub ? (msg) => hub.postMessage(msg) : null;
// The installed app's window, or the macOS app. Only there do ⌘N / ⌘T / ⌘W
// reach the page: in a browser tab Chrome keeps them (new window, tab, close).
export const standalone = Boolean(native) || matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// N: new chat / terminal; T: chats ↔ terminal. In the macOS app or an
// installed app window just ⌘N / ⌘T; elsewhere ⇧⌘N / ⇧⌘T (a plain Chrome tab
// keeps both pairs for itself). Off macOS Ctrl+Shift+N / T: plain Ctrl+N / T
// are the browser's, and the shell's on the terminal page.
export const appKey = (letter) => (isMac ? `${standalone ? '' : '⇧'}⌘${letter}` : `Ctrl+Shift+${letter}`);
export const isAppKey = (e, letter) => e.code === `Key${letter}` && !e.altKey && (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey && !e.metaKey);

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

// The page is exactly the visible viewport: above the phone keyboard when it's
// open. The page has no room to keep for the phone's home bar (base.css
// --safe-bottom) when the keyboard covers it, or when an iPhone Home Screen
// app under a translucent status bar is drawn that bar's height (~6%) short of
// the screen's bottom — the home bar then sits in that band, outside the page
// (which can't paint there either).
function syncHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  const portrait = window.innerHeight >= window.innerWidth;
  const screenHeight = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
  const keyboard = touch && height < screenHeight * 0.75; // a phone keyboard takes 40%+
  const shortOfBottom = navigator.standalone === true && !keyboard && screenHeight - height > 20;
  document.documentElement.classList.toggle('no-home-bar', keyboard || shortOfBottom); // a real boolean: toggle(x, undefined) flips
  document.documentElement.style.setProperty('--app-h', `${height}px`);
  // Where iOS panned the visible area to (keyboard up); not while pinch-zoomed.
  const vv = window.visualViewport;
  const top = vv && Math.abs(vv.scale - 1) < 0.01 ? vv.offsetTop : 0;
  document.documentElement.style.setProperty('--app-top', `${top}px`);
}
window.visualViewport?.addEventListener('resize', syncHeight);
window.visualViewport?.addEventListener('scroll', syncHeight); // the pan
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
  setupSettings();
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

// ----------------------------------------------------------------- dialogs

// A confirmation in the app's own look — or, with `value`, a one-line prompt.
// Enter confirms, Esc or a click outside cancels; while it's open, the page's
// ⌘-shortcuts wait. Resolves true / the trimmed text, or null.
export function ask({ title, text, value, confirm = 'OK', danger = false }) {
  if (document.querySelector('.ask-backdrop')) return Promise.resolve(null); // one at a time
  const prompt = value !== undefined;
  return new Promise((resolve) => {
    const field = prompt
      ? h('input', { class: 'ask-input', value, maxLength: 120, 'aria-label': title, spellcheck: false, autocomplete: 'off', autocorrect: 'off' })
      : null;
    const cancel = h('button', { type: 'button', textContent: 'Cancel' });
    const ok = h('button', { type: 'button', class: `ask-ok${danger ? ' danger' : ''}`, textContent: confirm });
    const box = h(
      'div',
      { class: 'ask', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', { textContent: title }),
      text ? h('p', { textContent: text }) : null,
      field,
      h('div', { class: 'ask-actions' }, cancel, ok),
    );
    const backdrop = h('div', { class: 'ask-backdrop' }, box);
    const before = document.activeElement;
    const done = (result) => {
      backdrop.remove();
      window.removeEventListener('keydown', keys, true);
      before?.focus?.();
      resolve(result);
    };
    const submit = () => {
      if (!prompt) return done(true);
      const text = field.value.trim();
      if (text) done(text);
      else field.focus();
    };
    // On window, capturing: ahead of the page's own key handlers.
    const keys = (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && !e.isComposing)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') done(null);
        else if (document.activeElement === cancel) done(null);
        else submit();
      } else if (e.key === 'Tab') {
        e.preventDefault(); // stay inside the dialog
        const stops = [field, cancel, ok].filter(Boolean);
        const at = stops.indexOf(document.activeElement);
        stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length].focus();
      } else if (e.metaKey || e.ctrlKey) e.stopPropagation(); // ⌘C/⌘V still edit; page shortcuts wait
    };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', submit);
    backdrop.addEventListener('mousedown', (e) => e.target === backdrop && done(null));
    window.addEventListener('keydown', keys, true);
    document.body.append(backdrop);
    if (field) {
      field.focus();
      field.select();
    } else ok.focus();
  });
}

// The gear next to the status dot: for now, how to open the panel on another
// device — the `tailscale serve` address (lib/network.js). The server only
// listens on localhost, so it's that or nothing; a LAN IP won't answer.
const GEAR_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>';

function setupSettings() {
  const button = h('button', {
    id: 'open-settings',
    class: 'icon-btn panel-btn',
    type: 'button',
    title: 'Settings',
    'aria-label': 'Settings',
    'data-popover-anchor': '',
    innerHTML: GEAR_ICON,
  });
  const panel = h('div', { id: 'settings-panel', 'data-popover': '', hidden: true });
  $('#conn').before(button);
  document.body.append(panel);
  button.addEventListener('click', async () => {
    if (!panel.hidden) return hidePopovers();
    hidePopovers();
    panel.replaceChildren(h('h2', { textContent: 'Settings' }), h('p', { textContent: 'Looking up the network…' }));
    panel.hidden = false;
    place(panel, button);
    let net;
    try {
      net = await api('GET', '/api/network');
    } catch (err) {
      net = { error: err.message };
    }
    if (panel.hidden) return;
    panel.replaceChildren(h('h2', { textContent: 'Settings' }), ...networkSection(net));
    place(panel, button);
  });
}

function networkSection(net) {
  const head = h('h3', { textContent: 'Open on another device' });
  if (net.error) return [head, h('p', { textContent: `Couldn't look it up: ${net.error}` })];
  if (!net.tailscale) return [head, h('p', { textContent: "Tailscale isn't running on this Mac. Other devices reach the panel through it." })];
  const out = [head];
  if (net.urls.length) {
    out.push(...net.urls.map(addressRow));
    out.push(h('p', { textContent: 'Open it in Chrome on Windows, on a phone or any computer. That device needs Tailscale, signed in with an allowed login.' }));
  } else {
    out.push(h('p', { textContent: 'Not shared on your tailnet yet. On this Mac, run:' }), addressRow(`tailscale serve --bg ${net.port}`));
  }
  if (net.funnel) out.push(h('p', { class: 'warn', textContent: 'Tailscale Funnel is on: the panel is reachable from the internet. Turn it off.' }));
  if (!net.online) out.push(h('p', { class: 'warn', textContent: 'This Mac is offline on Tailscale right now.' }));
  out.push(
    h(
      'dl',
      { class: 'kv' },
      net.name ? [h('dt', { textContent: 'Name' }), h('dd', { textContent: net.name })] : null,
      net.ips.length ? [h('dt', { textContent: 'Tailscale IP' }), h('dd', { textContent: net.ips.join('\n') })] : null,
    ),
    h('p', { class: 'fine', textContent: 'Use the address above: the panel answers on its Tailscale HTTPS name, not on an IP or the local network.' }),
  );
  return out;
}

// A value you'll paste elsewhere, with a Copy button.
function addressRow(text) {
  const code = h('code', { textContent: text });
  const copy = h('button', { type: 'button', textContent: 'Copy' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Older or stricter contexts: copy the selection instead.
      getSelection().selectAllChildren(code);
      document.execCommand('copy');
    }
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1500);
  });
  return h('div', { class: 'addr' }, code, copy);
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
