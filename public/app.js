// Chat UI: chat list, one open chat, composer, usage, shortcuts. Talks to the
// server over a single WebSocket (/ws/chat); rendering lives in render.js and
// the "working" indicator in loader.js. Nothing here depends on which agent
// runs behind the server.

import { Thread, h } from '/render.js';
import { createLoader } from '/loader.js';

const $ = (sel) => document.querySelector(sel);
const touch = matchMedia('(pointer: coarse)').matches;
const narrow = () => matchMedia('(max-width: 800px)').matches;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
const randomId = () => Math.random().toString(36).slice(2, 10);

// Per-device conveniences only (last chat, unsent drafts, sidebar state).
const local = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`chat:${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value == null || value === '') localStorage.removeItem(`chat:${key}`);
      else localStorage.setItem(`chat:${key}`, JSON.stringify(value));
    } catch {}
  },
};

const thread = new Thread($('#thread'));
const input = $('#input');
const messages = $('#messages');

const state = {
  chats: [], // newest first, stable: ⌘1…⌘9 follow this order
  view: 'chat', // chat | shortcuts
  chatId: null, // null = a new chat, created by its first message
  nextHue: null, // accent the next new chat will get
  status: 'idle',
  queue: [],
  limits: null, // { status, windows: [{ id, label, utilization, resetsAt }], updated }
  phase: { phase: 'thinking', label: 'Thinking' },
  opening: null, // { chatId, buffer } until the history arrives
  attachments: [], // { id, name, mediaType, preview, uploading, file, url }
  sends: new Map(), // ref -> what was sent, to restore it on error
  editing: false, // a title is being renamed inline: hold list re-renders
};
let loader = null;

// ------------------------------------------------------------------ utils

async function api(method, url, body, contentType) {
  const init = { method, headers: { 'x-hub': '1' } };
  if (body instanceof Blob) {
    init.body = body;
    init.headers['content-type'] = contentType || body.type || 'application/octet-stream';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

let toastTimer;
function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = error ? 'error' : '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), error ? 5000 : 2500);
}
const fail = (err) => toast(err?.message || String(err), true);

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const hhmm = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

function resetsIn(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const mins = Math.max(0, Math.round((ts - Date.now()) / 60000));
  const rel = mins < 60 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  const sameDay = d.toDateString() === new Date().toDateString();
  const when = sameDay ? hhmm(d) : `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(d)}`;
  return `resets in ${rel} (${when})`;
}

function tokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

const level = (pct) => (pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '');

// Keep the layout inside the visible viewport when the phone keyboard opens.
function syncHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${height}px`);
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', syncHeight);
window.addEventListener('resize', syncHeight);
syncHeight();

// ---------------------------------------------------------------- accents

// Every chat has its own hue (picked by the server); lightness and chroma are
// fixed so each one reads well on the dark background.
const DEFAULT_HUE = 255;
const accentFor = (hue) => `oklch(0.78 0.14 ${Number.isFinite(hue) ? hue : DEFAULT_HUE})`;

function applyAccent() {
  const hue = state.chatId ? current()?.hue : state.nextHue;
  document.documentElement.style.setProperty('--accent', accentFor(hue));
}

// --------------------------------------------------------------- popovers

let menuAnchor = null;
function showMenu(anchor, items) {
  const menu = $('#menu');
  if (!menu.hidden && menuAnchor === anchor) return hidePopovers();
  hidePopovers();
  menuAnchor = anchor;
  menu.replaceChildren(
    ...items.map((item) =>
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

function place(popover, anchor) {
  const r = anchor.getBoundingClientRect();
  const below = r.bottom + popover.offsetHeight + 8 < innerHeight;
  popover.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - popover.offsetHeight - 4)}px`;
  popover.style.left = `${Math.max(8, Math.min(r.right - popover.offsetWidth, innerWidth - popover.offsetWidth - 8))}px`;
}

function hidePopovers() {
  $('#menu').hidden = true;
  $('#usage-panel').hidden = true;
  menuAnchor = null;
}
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!e.target.closest('#menu, #usage-panel, .stat') && !menuAnchor?.contains(e.target)) hidePopovers();
  },
  true,
);

// Swaps `el`'s text for an input; Enter/blur saves, Esc cancels.
function editInline(el, value, save) {
  if (el.querySelector('.rename-input')) return;
  state.editing = true;
  const field = h('input', { class: 'rename-input', value, maxLength: 120, 'aria-label': 'New name' });
  el.replaceChildren(field);
  field.focus();
  field.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    state.editing = false;
    const title = field.value.trim();
    el.textContent = commit && title ? title : value;
    if (commit && title && title !== value) await save(title).catch(fail);
    renderList();
    renderHeader();
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

// ------------------------------------------------------------- connection

let ws = null;
let retries = 0;
let retryTimer = null;

function connect() {
  clearTimeout(retryTimer);
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/chat`);
  ws = socket;
  setConn('connecting');
  socket.onopen = () => {
    retries = 0;
    setConn('online');
    openChat(state.chatId); // (re)load what's on screen
  };
  socket.onmessage = (e) => onMessage(JSON.parse(e.data));
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setConn('offline');
    retryTimer = setTimeout(connect, Math.min(8000, 400 * 2 ** retries++));
  };
}

function wsSend(msg) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

const CONN_LABELS = { connecting: 'Connecting…', online: 'Connected', offline: 'Reconnecting…' };
function setConn(state) {
  const el = $('#conn');
  el.dataset.state = state;
  el.title = CONN_LABELS[state];
  el.querySelector('.sr-only').textContent = CONN_LABELS[state];
  $('#open-sidebar').dataset.conn = state;
}

// Phones drop sockets while asleep; reconnect as soon as the page is back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ws?.readyState !== WebSocket.OPEN) {
    retries = 0;
    connect();
  }
});

function onMessage(m) {
  const here = m.chatId && m.chatId === state.chatId;
  switch (m.op) {
    case 'chats':
      state.chats = m.chats;
      state.nextHue = m.nextHue;
      renderList();
      renderHeader();
      break;

    case 'limits':
      state.limits = m.limits;
      renderHeader();
      break;

    case 'history': {
      if (!here) return;
      const buffered = state.opening?.buffer || [];
      state.opening = null;
      thread.reset();
      for (const item of [...m.items, ...buffered]) thread.add(item);
      for (const draft of m.drafts) thread.live({ t: 'start', ...draft });
      applyStatus(m.status, m.queue);
      scrollToBottom();
      break;
    }

    case 'created':
      // Our first message made a new chat: it's the one on screen now.
      if (!state.sends.has(m.ref)) return;
      state.chatId = m.chatId;
      local.set('last', m.chatId);
      history.replaceState(null, '', `#${m.chatId}`);
      moveDraft('new', m.chatId);
      renderHeader();
      renderList();
      break;

    case 'item':
      if (!here) return;
      if (state.opening) return state.opening.buffer.push(m.item);
      thread.add(m.item);
      itemPhase(m.item);
      break;

    case 'live':
      if (!here || state.opening) return;
      thread.live(m.ev);
      livePhase(m.ev);
      break;

    case 'status':
      if (here) applyStatus(m.status, m.queue);
      break;

    case 'ack':
      state.sends.delete(m.ref);
      break;

    case 'error': {
      const sent = state.sends.get(m.ref);
      state.sends.delete(m.ref);
      if (sent && !input.value && !state.attachments.length) {
        input.value = sent.text;
        state.attachments = sent.attachments;
        renderAttachments();
        autosize();
      }
      if (state.opening && m.chatId === state.opening.chatId) {
        state.opening = null;
        go(null); // that chat is gone
      }
      fail(m.error);
      break;
    }

    case 'deleted':
      if (here) go(null);
      break;
  }
}

// ----------------------------------------------------------------- chats

// Routes: #<chatId> (or empty for a new chat) and #shortcuts.
function route() {
  const hash = location.hash.slice(1);
  return hash === 'shortcuts' ? { view: 'shortcuts' } : { view: 'chat', chatId: hash || null };
}
const hashId = () => route().chatId ?? null;

function go(id) {
  id = id || null;
  if (state.view === 'chat' && id === state.chatId && hashId() === id) return; // already open
  if (route().view === 'chat' && hashId() === id) applyRoute();
  else location.hash = id || '';
}

function applyRoute() {
  const r = route();
  if (r.view === 'shortcuts') return setView('shortcuts');
  // Back from Shortcuts to the chat that's still loaded behind it.
  if (state.view !== 'chat' && r.chatId === state.chatId) return setView('chat');
  setView('chat');
  openChat(r.chatId);
}
window.addEventListener('hashchange', applyRoute);

function setView(view) {
  state.view = view;
  document.body.dataset.view = view;
  $('#open-shortcuts').classList.toggle('active', view === 'shortcuts');
  if (view === 'shortcuts') renderShortcuts();
  hidePopovers();
  renderHeader();
  renderList();
  if (narrow()) setDrawer(false);
}

function openChat(id) {
  const changed = id !== state.chatId;
  state.chatId = id || null;
  local.set('last', state.chatId);
  thread.reset();
  applyStatus('idle', []);
  hidePopovers();
  $('#welcome').hidden = Boolean(state.chatId);
  if (changed) restoreDraft();
  renderHeader();
  renderList();
  state.opening = state.chatId ? { chatId: state.chatId, buffer: [] } : null;
  wsSend({ op: 'open', chatId: state.chatId });
  if (narrow()) setDrawer(false);
}

function newChat() {
  go(null);
  if (!touch) input.focus();
}

const current = () => state.chats.find((c) => c.id === state.chatId);

const renameChat = (id, title) => api('PATCH', `/api/chats/${id}`, { title });

async function deleteChat(chat) {
  if (!confirm(`Delete "${chat.title || 'this chat'}"? Its history is removed from the app.`)) return;
  await api('DELETE', `/api/chats/${chat.id}`)
    .then(() => chat.id === state.chatId && go(null))
    .catch(fail);
}

// Items are kept and updated in place (keyed by id): rebuilding them would
// break double-click-to-rename and lose focus while the list refreshes.
const listItems = new Map(); // chat id -> { el, avatar, name, sub, kbd }

const MORE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';

function listItem(c) {
  const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const name = h('span', { class: 'name' });
  const sub = h('span', { class: 'sub' });
  const kbd = h('kbd', { class: 'kbd' });
  const rename = () => {
    const chat = state.chats.find((x) => x.id === c.id);
    editInline(name, chat?.title || '', (t) => renameChat(c.id, t));
  };
  const more = h('button', {
    type: 'button',
    class: 'more',
    innerHTML: MORE_ICON,
    'aria-label': 'Chat options',
    onclick: (e) => {
      e.stopPropagation();
      showMenu(more, [
        { label: 'Rename', run: rename },
        { label: 'Delete', danger: true, run: () => deleteChat(state.chats.find((x) => x.id === c.id) || c) },
      ]);
    },
  });
  const el = h(
    'div',
    {
      class: 'chat-item',
      role: 'button',
      tabIndex: 0,
      onclick: () => go(c.id),
      ondblclick: (e) => {
        e.preventDefault();
        rename();
      },
      onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && go(c.id),
    },
    avatar,
    h('span', { class: 'text' }, name, sub),
    h('span', { class: 'side' }, kbd, more),
  );
  return { el, avatar, name, sub, kbd };
}

// First letter (or emoji) of the title, for the colored avatar.
const initial = (title) => ([...(title || '').trim()][0] || '·').toUpperCase();

function renderList() {
  if (state.editing) return; // would clobber the rename field
  const nav = $('#chat-list');
  const ids = new Set(state.chats.map((c) => c.id));
  for (const [id, item] of listItems) {
    if (!ids.has(id)) {
      item.el.remove();
      listItems.delete(id);
    }
  }
  state.chats.forEach((c, i) => {
    let item = listItems.get(c.id);
    if (!item) listItems.set(c.id, (item = listItem(c)));
    const name = c.title || 'New chat';
    const busy = c.status === 'running';
    item.el.classList.toggle('active', state.view === 'chat' && c.id === state.chatId);
    item.el.style.setProperty('--item-accent', accentFor(c.hue));
    item.el.title = i < 9 ? `${name}  (${MOD}${i + 1})` : name;
    item.avatar.textContent = initial(c.title);
    item.avatar.classList.toggle('busy', busy);
    item.name.textContent = name;
    item.sub.textContent = busy ? (c.queued ? `working · ${c.queued} queued` : 'working…') : ago(c.updated) === 'now' ? 'just now' : `${ago(c.updated)} ago`;
    item.sub.classList.toggle('busy', busy);
    item.kbd.textContent = i < 9 ? `${MOD}${i + 1}` : '';
    item.kbd.hidden = i >= 9;
    nav.append(item.el); // moves existing nodes into order
  });
  let empty = nav.querySelector('.chat-list-empty');
  if (!state.chats.length && !empty) nav.append((empty = h('div', { class: 'chat-list-empty', textContent: 'No chats yet.' })));
  if (state.chats.length) empty?.remove();
}

// There's no header: this keeps the tab title, the accent and the stats
// above the composer in sync with the open chat.
function renderHeader() {
  const chat = current();
  document.title = state.view === 'shortcuts' ? 'Shortcuts' : chat?.title || 'New chat';
  applyAccent();
  renderStats();
}

$('#new-chat').addEventListener('click', newChat);

// Sidebar: collapses on desktop, slides in as a drawer on phones. Its own
// button hides it; a floating one brings it back.
function setDrawer(open) {
  document.body.classList.toggle('sidebar-open', open);
}
function toggleSidebar() {
  if (narrow()) return setDrawer(!document.body.classList.contains('sidebar-open'));
  const stick = atBottom; // the reflow would leave the thread mid-way
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  local.set('sidebarCollapsed', collapsed || null);
  if (stick) {
    requestAnimationFrame(scrollToBottom);
    setTimeout(scrollToBottom, 300); // after the slide (see style.css)
  }
}
$('#close-sidebar').addEventListener('click', toggleSidebar);
$('#open-sidebar').addEventListener('click', toggleSidebar);
$('#scrim').addEventListener('click', () => setDrawer(false));
if (local.get('sidebarCollapsed', false)) document.body.classList.add('sidebar-collapsed');

setInterval(() => {
  renderList();
  renderStats();
}, 60_000);

// ------------------------------------------------------------------ usage

function meter({ label, pct, detail, foot }) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, pct)}%`;
  return h(
    'div',
    { class: `meter ${level(pct)}` },
    h('div', { class: 'meter-head' }, h('span', { textContent: label }), h('b', { textContent: detail ?? `${pct}%` })),
    h('div', { class: 'meter-bar' }, bar),
    foot ? h('div', { class: 'meter-foot', textContent: foot }) : null,
  );
}

function stat({ label, pct, title }) {
  const bar = h('span');
  bar.style.width = `${Math.min(100, pct)}%`;
  return h(
    'button',
    { type: 'button', class: `stat ${level(pct)}`, title, onclick: (e) => openUsage(e.currentTarget) },
    h('span', { textContent: label }),
    h('span', { class: 'stat-bar' }, bar),
    h('b', { textContent: `${pct}%` }),
  );
}

const contextPct = (ctx) => Math.round((ctx.used / ctx.window) * 100);
const windowPct = (w) => Math.round((w.utilization || 0) * 100);

// Top of the chat: model, this chat's context, the account's usage windows.
function renderStats() {
  const chat = current();
  const ctx = chat?.context;
  const parts = [];
  if (chat?.modelLabel || chat?.model) parts.push(h('span', { class: 'model', textContent: chat.modelLabel || chat.model }));
  if (ctx?.window) parts.push(stat({ label: 'ctx', pct: contextPct(ctx), title: `Context: ${tokens(ctx.used)} / ${tokens(ctx.window)} tokens` }));
  for (const w of state.limits?.windows || []) parts.push(stat({ label: w.label, pct: windowPct(w), title: `${w.label} usage — ${resetsIn(w.resetsAt)}` }));
  $('#chat-stats').replaceChildren(...parts);
  if (!$('#usage-panel').hidden) renderUsagePanel();
}

function renderUsagePanel() {
  const ctx = current()?.context;
  const windows = state.limits?.windows || [];
  const updated = state.limits && ago(state.limits.updated);
  $('#usage-panel').replaceChildren(
    ctx?.window
      ? h(
          'section',
          { class: 'meter-group' },
          h('h2', { textContent: 'This chat' }),
          meter({ label: 'Context', pct: contextPct(ctx), detail: `${contextPct(ctx)}% · ${tokens(ctx.used)} / ${tokens(ctx.window)}` }),
        )
      : null,
    windows.length
      ? h(
          'section',
          { class: 'meter-group' },
          h('h2', { textContent: 'Account limits' }),
          ...windows.map((w) => meter({ label: w.label, pct: windowPct(w), foot: resetsIn(w.resetsAt) })),
          h('div', { class: 'meter-foot', textContent: updated === 'now' ? 'updated just now' : `updated ${updated} ago` }),
        )
      : null,
  );
}

function openUsage(anchor) {
  const panel = $('#usage-panel');
  if (!panel.hidden) return hidePopovers();
  hidePopovers();
  renderUsagePanel();
  panel.hidden = false;
  place(panel, anchor);
}

// ------------------------------------------------------------- shortcuts

// One table drives the key handling and the Shortcuts screen. `match` gets
// the keydown event; `run` returns false when it didn't apply. `testOnly`
// keys are handled elsewhere (the composer) and only listed/checked here.
const mod = (e) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey) && !e.altKey;
const SHORTCUTS = [
  {
    id: 'switch',
    keys: [`${MOD}1`, '…', `${MOD}9`],
    label: 'Open chat 1–9',
    note: 'In sidebar order — hold the modifier to see the numbers',
    match: (e) => mod(e) && !e.shiftKey && /^Digit[1-9]$/.test(e.code),
    run: (e) => {
      const chat = state.chats[Number(e.code.slice(5)) - 1];
      if (!chat) return false;
      go(chat.id);
    },
  },
  {
    id: 'new',
    keys: [isMac ? '⌃⌘N' : 'Ctrl+Alt+N'],
    label: 'New chat',
    match: (e) => e.code === 'KeyN' && !e.shiftKey && (isMac ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey),
    run: () => newChat(),
  },
  {
    id: 'sidebar',
    keys: [`${MOD}B`],
    label: 'Show / hide the sidebar',
    match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyB',
    run: () => toggleSidebar(),
  },
  {
    id: 'shortcuts',
    keys: [`${MOD}/`],
    label: 'Open this screen',
    match: (e) => mod(e) && (e.key === '/' || e.code === 'Slash'), // ABNT keyboards put / elsewhere
    run: () => (location.hash = 'shortcuts'),
  },
  { id: 'send', keys: ['Enter'], label: 'Send message', note: 'On a phone, use the send button', testOnly: true, match: (e) => e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey },
  { id: 'newline', keys: ['⇧Enter'], label: 'New line in the message', testOnly: true, match: (e) => e.key === 'Enter' && e.shiftKey },
  { id: 'stop', keys: ['Esc'], label: 'Stop the agent', note: 'While it is working, with the message box focused', testOnly: true, match: (e) => e.key === 'Escape' },
  { id: 'rename', keys: ['Double-click'], label: 'Rename a chat', note: 'Double-click it in the sidebar, or use its ⋯ menu' },
];

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === (isMac ? 'Meta' : 'Control')) document.body.classList.add('show-keys');
    const s = SHORTCUTS.find((x) => x.match?.(e));
    if (!s || e.isComposing) return;
    if (state.view === 'shortcuts') {
      // On the Shortcuts screen keys are only checked, so testing ⌘1 doesn't navigate away.
      if (s.testOnly && e.target.closest?.('button, a')) return; // Enter on a focused button still clicks it
      e.preventDefault();
      flash(s.id);
      return;
    }
    if (s.testOnly || s.run(e) === false) return;
    e.preventDefault();
    flash(s.id);
  },
  true,
);
const hideKeys = () => document.body.classList.remove('show-keys');
document.addEventListener('keyup', (e) => e.key === (isMac ? 'Meta' : 'Control') && hideKeys());
window.addEventListener('blur', hideKeys);

$('#new-chat-hint').textContent = SHORTCUTS.find((x) => x.id === 'new').keys[0];
$('#shortcuts-hint').textContent = `${MOD}/`;

const verified = new Set(); // shortcuts seen working in this window

// Marks a shortcut as working; shown with a ✓ on the Shortcuts screen.
function flash(id) {
  verified.add(id);
  const row = document.querySelector(`#shortcut-list li[data-id="${id}"]`);
  if (!row) return;
  row.classList.add('works', 'hit');
  setTimeout(() => row.classList.remove('hit'), 700);
}

function renderShortcuts() {
  $('#shortcut-list').replaceChildren(
    ...SHORTCUTS.map((s) =>
      h(
        'li',
        { class: verified.has(s.id) ? 'works' : '', dataset: { id: s.id } },
        h('span', { class: 'what' }, s.label, s.note ? h('small', { textContent: s.note }) : null),
        h('span', { class: 'keys' }, s.keys.map((k) => (k === '…' ? h('span', { textContent: '…' }) : h('kbd', { textContent: k })))),
        h('span', { class: 'check', textContent: '✓', title: 'Works here' }),
      ),
    ),
  );
}
$('#open-shortcuts').addEventListener('click', () => (location.hash = 'shortcuts'));
$('#back-to-chat').addEventListener('click', () => go(state.chatId));

// ---------------------------------------------------------- turn status

function applyStatus(status, queue) {
  state.status = status;
  state.queue = queue || [];
  if (status === 'running' && !loader) {
    loader = createLoader();
    $('#loader-slot').append(loader.el);
    state.phase = { phase: 'thinking', label: 'Thinking' };
    loader.update(state.phase);
  } else if (status !== 'running' && loader) {
    loader.destroy();
    loader = null;
  }
  renderQueue();
  updateSend();
}

function setPhase(phase, label) {
  state.phase = { phase, label };
  loader?.update(state.phase);
}

function livePhase(ev) {
  if (ev.t !== 'start') return;
  if (ev.kind === 'thinking') setPhase('thinking', 'Thinking');
  else if (ev.kind === 'text') setPhase('writing', 'Writing');
  else if (ev.kind === 'tool_use') setPhase('tool', `Using ${ev.name}`);
}

function itemPhase(item) {
  if (item.t === 'block' && item.block.type === 'tool_use') setPhase('tool', `Running ${item.block.name}`);
  else if (item.t === 'tool_result') setPhase('thinking', 'Reading the result');
}

function renderQueue() {
  $('#queue').replaceChildren(
    ...state.queue.map((q) =>
      h(
        'div',
        { class: 'queued', title: q.text },
        h('span', { textContent: `Queued: ${q.text || q.attachments.map((a) => a.name).join(', ')}` }),
        h('button', { type: 'button', textContent: '×', 'aria-label': 'Remove from queue', onclick: () => wsSend({ op: 'unqueue', chatId: state.chatId, id: q.id }) }),
      ),
    ),
  );
}

// ------------------------------------------------------------- scrolling

let atBottom = true;
messages.addEventListener('scroll', () => {
  atBottom = messages.scrollTop + messages.clientHeight >= messages.scrollHeight - 80;
  $('#jump').hidden = atBottom;
});
function scrollToBottom() {
  messages.scrollTop = messages.scrollHeight;
  atBottom = true;
  $('#jump').hidden = true;
}
// Follow new content (streamed text, images loading) while at the bottom.
new ResizeObserver(() => atBottom && scrollToBottom()).observe($('#thread'));
new ResizeObserver(() => atBottom && scrollToBottom()).observe($('#loader-slot'));
$('#jump').addEventListener('click', scrollToBottom);

// -------------------------------------------------------------- composer

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

function updateSend() {
  const empty = !input.value.trim() && !state.attachments.length;
  const stop = state.status === 'running' && empty;
  const send = $('#send');
  send.classList.toggle('stop', stop);
  send.textContent = stop ? '■' : '↑';
  send.setAttribute('aria-label', stop ? 'Stop' : 'Send');
  send.disabled = !stop && (empty || state.attachments.some((a) => a.uploading));
}

const draftKey = () => `draft:${state.chatId || 'new'}`;
function restoreDraft() {
  input.value = local.get(draftKey(), '');
  autosize();
  updateSend();
}
function moveDraft(from, to) {
  local.set(`draft:${to}`, local.get(`draft:${from}`, ''));
  local.set(`draft:${from}`, null);
}

input.addEventListener('input', () => {
  autosize();
  updateSend();
  local.set(draftKey(), input.value);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    if (e.shiftKey) return flash('newline');
    if (touch) return;
    e.preventDefault();
    $('#composer').requestSubmit();
  }
  if (e.key === 'Escape' && state.status === 'running') {
    wsSend({ op: 'interrupt', chatId: state.chatId });
    flash('stop');
  }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (state.status === 'running' && !text && !state.attachments.length) {
    wsSend({ op: 'interrupt', chatId: state.chatId });
    return;
  }
  if (!text && !state.attachments.length) return;
  if (state.attachments.some((a) => a.uploading)) return toast('Wait for the attachments to upload');
  const ref = randomId();
  const attachments = state.attachments.map((a) => ({ file: a.file, name: a.name }));
  if (!wsSend({ op: 'send', ref, chatId: state.chatId, text, attachments })) return toast('Not connected to the server', true);
  flash('send');
  state.sends.set(ref, { text, attachments: state.attachments });
  input.value = '';
  local.set(draftKey(), null);
  state.attachments = [];
  renderAttachments();
  autosize();
  updateSend();
  $('#welcome').hidden = true;
  scrollToBottom();
});

// ----------------------------------------------------------- attachments

const MAX_EDGE = 1568; // larger images get downscaled by the model APIs anyway

// Phone photos are big: resize before uploading (and turn HEIC into JPEG).
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const convert = /heic|heif/.test(file.type);
  if (scale === 1 && !convert && file.size < 3 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
  if (!blob) return file;
  const name = `${(file.name || 'image').replace(/\.\w+$/, '')}.${type === 'image/png' ? 'png' : 'jpg'}`;
  return new File([blob], name, { type });
}

async function addFiles(files) {
  for (const original of files) {
    const att = {
      id: randomId(),
      name: original.name || 'image',
      mediaType: original.type,
      preview: original.type.startsWith('image/') ? URL.createObjectURL(original) : null,
      uploading: true,
    };
    state.attachments.push(att);
    renderAttachments();
    updateSend();
    try {
      const file = await prepareImage(original);
      const res = await api('POST', `/api/uploads?name=${encodeURIComponent(file.name || att.name)}`, file, file.type || 'application/octet-stream');
      Object.assign(att, { file: res.file, name: res.name, url: res.url, mediaType: res.mediaType, uploading: false });
    } catch (err) {
      state.attachments = state.attachments.filter((a) => a !== att);
      fail(err);
    }
    renderAttachments();
    updateSend();
  }
}

function renderAttachments() {
  $('#attachments').replaceChildren(
    ...state.attachments.map((a) =>
      h(
        'div',
        { class: `chip${a.uploading ? ' uploading' : ''}`, title: a.name },
        a.preview ? h('img', { src: a.preview, alt: '' }) : null,
        h('span', { class: 'name', textContent: a.uploading ? 'uploading…' : a.name }),
        h('button', {
          type: 'button',
          class: 'chip-x',
          textContent: '×',
          'aria-label': 'Remove attachment',
          onclick: () => {
            state.attachments = state.attachments.filter((x) => x !== a);
            renderAttachments();
            updateSend();
          },
        }),
      ),
    ),
  );
}

$('#attach').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = '';
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
$('#main').addEventListener('dragover', (e) => e.preventDefault());
$('#main').addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files.length) addFiles([...e.dataTransfer.files]);
});

// --------------------------------------------------------------- lightbox

const lightbox = $('#lightbox');
document.addEventListener('click', (e) => {
  const img = e.target.closest('img.zoomable');
  if (!img) return;
  lightbox.querySelector('img').src = img.src;
  $('#lightbox-open').href = img.src;
  lightbox.hidden = false;
});
lightbox.addEventListener('click', (e) => {
  if (!e.target.closest('a')) lightbox.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    lightbox.hidden = true;
    hidePopovers();
  }
});

// ------------------------------------------------------------------- boot

// Opening the app without a link resumes the last chat.
if (route().view === 'chat' && !hashId() && local.get('last', null)) history.replaceState(null, '', `#${local.get('last')}`);
state.chatId = route().view === 'chat' ? hashId() : local.get('last', null);
$('#welcome').hidden = Boolean(state.chatId);
restoreDraft();
setView(route().view);
connect();
