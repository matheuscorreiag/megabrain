// Chat UI: chat list, one open chat, composer, usage, shortcuts. Talks to the
// server over a single WebSocket (/ws/chat); rendering lives in render.js and
// the "working" indicator in loader.js. Nothing here depends on which agent
// runs behind the server.

import { Thread } from '/render.js';
import { createLoader } from '/loader.js';
import { $, h, touch, narrow, isMac, MOD, standalone, api, storage, toast, fail, place, hidePopovers, showMenu, editInline, setupSidebar, setConn, accentFor, setHue, indexLabel, MORE_ICON, ago } from '/ui.js';

const randomId = () => Math.random().toString(36).slice(2, 10);
const local = storage('chat'); // last chat, unsent drafts, settings for new chats

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
  agent: { models: [], efforts: [] }, // per-chat choices the agent offers
  newSettings: { model: null, effort: null, ...local.get('newSettings', {}) }, // for the next new chat
  listed: false, // the first list arrived (later unread changes are news)
};
let loader = null;

// ------------------------------------------------------------------ utils

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

// ---------------------------------------------------------------- accents

// Every chat has its own hue (picked by the server); it tints the whole
// page. The New chat button previews the next one.
function applyAccent() {
  setHue(state.chatId ? current()?.hue : state.nextHue);
  $('#new-chat').style.setProperty('--swatch', accentFor(state.nextHue));
}

// Inline rename (ui.js) with the list held still while the field is open.
function renameInline(el, chat) {
  editInline(el, chat?.title || '', (t) => (t ? renameChat(chat.id, t) : Promise.resolve()), {
    onStart: () => (state.editing = true),
    onEnd: () => {
      state.editing = false;
      renderList();
      renderHeader();
    },
  });
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
    sendVisibility(); // before "open": a visible page marks the chat read
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

// Phones drop sockets while asleep; reconnect as soon as the page is back.
// The server also needs to know: chats only count as read on a visible page.
const sendVisibility = () => wsSend({ op: 'visibility', visible: !document.hidden });
document.addEventListener('visibilitychange', () => {
  document.body.classList.toggle('away', document.hidden); // holds the notice's countdown
  if (!document.hidden && ws?.readyState !== WebSocket.OPEN) {
    retries = 0;
    connect();
  } else sendVisibility();
});

function onMessage(m) {
  const here = m.chatId && m.chatId === state.chatId;
  switch (m.op) {
    case 'agent':
      state.agent = { models: m.models, efforts: m.efforts };
      renderStats();
      break;

    case 'chats': {
      const before = new Map(state.chats.map((c) => [c.id, c]));
      state.chats = m.chats;
      state.nextHue = m.nextHue;
      if (state.listed) for (const c of m.chats) if (c.unread && !before.get(c.id)?.unread) notify(c);
      state.listed = true;
      renderList();
      renderHeader();
      break;
    }

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
  if (!state.chatId) scrollToBottom();
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

function listItem(c) {
  const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const name = h('span', { class: 'name' });
  const sub = h('span', { class: 'sub' });
  const kbd = h('kbd', { class: 'kbd' });
  const rename = () => renameInline(name, state.chats.find((x) => x.id === c.id) || c);
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
      class: 'side-item',
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
    h('span', { class: 'side' }, h('span', { class: 'unread-dot', title: 'New reply' }), kbd, more),
  );
  return { el, avatar, name, sub, kbd };
}

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
    item.avatar.textContent = indexLabel(i);
    item.avatar.classList.toggle('busy', busy);
    item.name.textContent = name;
    const when = ago(c.updated) === 'now' ? 'just now' : `${ago(c.updated)} ago`;
    item.sub.textContent = busy ? (c.queued ? `working · ${c.queued} queued` : 'working…') : c.unread ? `replied ${when}` : when;
    item.sub.classList.toggle('busy', busy || c.unread);
    item.el.classList.toggle('unread', c.unread && !busy);
    item.kbd.textContent = i < 9 ? `${MOD}${i + 1}` : '';
    item.kbd.hidden = i >= 9;
    nav.append(item.el); // moves existing nodes into order
  });
  $('#chat-count').textContent = state.chats.length ? indexLabel(state.chats.length - 1) : '';
  let empty = nav.querySelector('.side-list-empty');
  if (!state.chats.length && !empty) nav.append((empty = h('div', { class: 'side-list-empty', textContent: 'No chats yet.' })));
  if (state.chats.length) empty?.remove();
  renderUnread();
}

// ---------------------------------------------------------------- unread

// The server decides what's unread (a turn ended while no device had the
// chat open and visible); opening a chat on a visible page marks it read.
const unreadCount = () => state.chats.filter((c) => c.unread).length;

// Count on the floating sidebar toggle (the list is hidden) and on the
// installed app's icon.
function renderUnread() {
  const n = unreadCount();
  const badge = $('#unread-badge');
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : String(n);
  try {
    if (n) navigator.setAppBadge?.(n)?.catch(() => {});
    else navigator.clearAppBadge?.()?.catch(() => {});
  } catch {}
}

// A chat that isn't on screen just replied: a notice with the start of the
// reply that opens it (click, or ⌘J). It stays NOTICE_SECONDS on screen —
// a bar shows the time left, which stops while hovered or while the page is
// in the background (see style.css), so it isn't missed.
const NOTICE_SECONDS = 30;
let noticeChat = null;

function notify(chat) {
  if (chat.id === state.chatId && state.view === 'chat' && !document.hidden) return;
  noticeChat = chat.id;
  const others = state.chats.filter((c) => c.unread && c.id !== chat.id).length;
  const el = $('#notice');
  el.style.setProperty('--item-accent', accentFor(chat.hue));
  el.style.setProperty('--notice-time', `${NOTICE_SECONDS}s`);
  const time = h('span', { class: 'notice-time' });
  time.addEventListener('animationend', hideNotice);
  el.replaceChildren(
    h(
      'div',
      { class: 'notice-head' },
      h('span', { class: 'dot' }),
      h('span', { textContent: 'New reply' }),
      h('span', { class: 'num', textContent: indexLabel(state.chats.indexOf(chat)) }),
      h('button', { type: 'button', class: 'notice-x', 'aria-label': 'Dismiss', textContent: '×', onclick: (e) => (e.stopPropagation(), hideNotice()) }),
    ),
    h('div', { class: 'notice-title', textContent: chat.title || 'New chat' }),
    h('p', { class: 'notice-preview', textContent: chat.preview || 'The turn ended — open the chat to see it.' }),
    h(
      'div',
      { class: 'notice-foot' },
      others ? h('span', { class: 'notice-more', textContent: `+${others} more unread` }) : null,
      h('span', { class: 'notice-open' }, 'Open', touch ? null : h('kbd', { textContent: `${MOD}J` })),
    ),
    time,
  );
  el.onclick = openReply;
  el.hidden = false;
}

function hideNotice() {
  $('#notice').hidden = true;
  noticeChat = null;
}

// The chat in the notice, else the newest unread one. False when there's none.
function openReply() {
  const newest = state.chats.filter((c) => c.unread).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))[0];
  const id = noticeChat || newest?.id;
  if (!id) return false;
  hideNotice();
  go(id);
}

// There's no header: this keeps the tab title, the accent and the status
// line under the composer in sync with the open chat.
function renderHeader() {
  const chat = current();
  const n = unreadCount();
  document.title = `${n ? `(${n}) ` : ''}${state.view === 'shortcuts' ? 'Shortcuts' : chat?.title || 'New chat'}`;
  applyAccent();
  renderTitle();
  renderStats();
}

// The open chat in the status line: its number and title.
function renderTitle() {
  const chat = current();
  const i = state.chats.indexOf(chat);
  const el = $('#chat-title');
  el.title = chat?.title || '';
  el.replaceChildren(
    ...[
      h('span', { class: 'swatch' }),
      chat && h('span', { class: 'num', textContent: indexLabel(i) }),
      h('span', { class: 't', textContent: chat?.title || 'New chat' }),
    ].filter(Boolean),
  );
}

$('#new-chat').addEventListener('click', newChat);

// Sidebar (ui.js): its own button hides it, a floating one brings it back.
const sidebar = setupSidebar('chatSidebarCollapsed');
const setDrawer = sidebar.setDrawer;
function toggleSidebar() {
  const stick = atBottom; // the reflow would leave the thread mid-way
  sidebar.toggle();
  if (stick && !narrow()) {
    requestAnimationFrame(scrollToBottom);
    setTimeout(scrollToBottom, 300); // after the slide (see base.css)
  }
}
$('#close-sidebar').addEventListener('click', toggleSidebar);
$('#open-sidebar').addEventListener('click', toggleSidebar);

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
    { type: 'button', class: `stat ${level(pct)}`, title, 'data-popover-anchor': '', onclick: (e) => openUsage(e.currentTarget) },
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
  if (state.agent.models.length) parts.push(modelButton(chat));
  else if (chat?.modelLabel || chat?.model) parts.push(h('span', { class: 'model', textContent: chat.modelLabel || chat.model }));
  if (ctx?.window) parts.push(stat({ label: 'ctx', pct: contextPct(ctx), title: `Context: ${tokens(ctx.used)} / ${tokens(ctx.window)} tokens` }));
  for (const w of state.limits?.windows || []) parts.push(stat({ label: w.label, pct: windowPct(w), title: `${w.label} usage — ${resetsIn(w.resetsAt)}` }));
  $('#chat-stats').replaceChildren(...parts);
  if (!$('#usage-panel').hidden) renderUsagePanel();
  if (!$('#model-panel').hidden) renderModelPanel();
}

// ------------------------------------------------------ model and effort

// Per chat; a new chat uses the ones picked for it (kept per device).
const settingsOf = (chat) => (chat ? { model: null, effort: null, ...chat.settings } : state.newSettings);
const modelOption = (id) => state.agent.models.find((m) => m.id === id);

function modelButton(chat) {
  const { model, effort } = settingsOf(chat);
  // The exact model once a process reported it, else the choice.
  const label = (chat ? chat.modelLabel : modelOption(model)?.label) || 'Default model';
  const showEffort = effort && modelOption(model)?.effort !== false;
  return h(
    'button',
    { type: 'button', class: 'model', title: 'Model and effort', 'data-popover-anchor': '', onclick: (e) => openModelPanel(e.currentTarget) },
    h('span', { class: 'model-name', textContent: label }),
    h('span', { class: 'model-short', textContent: label.split(' · ')[0] }), // phones: no "· 1M"
    showEffort ? h('span', { class: 'effort', textContent: effort }) : null,
  );
}

function renderModelPanel() {
  const chat = current();
  const { model, effort } = settingsOf(chat);
  const noEffort = modelOption(model)?.effort === false;
  const models = [{ id: null, label: 'Default', note: 'account setting' }, ...state.agent.models];
  $('#model-panel').replaceChildren(
    h(
      'section',
      { class: 'pick-group' },
      h('h2', { textContent: 'Model' }),
      ...models.map((m) =>
        h(
          'button',
          { type: 'button', class: `pick${m.id === model ? ' on' : ''}`, onclick: () => changeSettings({ model: m.id }) },
          h('span', { class: 'radio' }),
          h('span', { class: 'pick-label', textContent: m.label }),
          m.note ? h('span', { class: 'pick-note', textContent: m.note }) : null,
        ),
      ),
    ),
    state.agent.efforts.length
      ? h(
          'section',
          { class: 'pick-group' },
          h('h2', { textContent: 'Effort' }),
          h(
            'div',
            { class: 'segmented' },
            ...[null, ...state.agent.efforts].map((e) =>
              h('button', { type: 'button', class: !noEffort && e === effort ? 'on' : '', disabled: noEffort, textContent: e ?? 'default', onclick: () => changeSettings({ effort: e }) }),
            ),
          ),
        )
      : null,
    h('div', { class: 'meter-foot', textContent: chat ? 'Applies from the next message.' : 'For this new chat (and the next ones on this device).' }),
  );
}

function openModelPanel(anchor) {
  const panel = $('#model-panel');
  if (!panel.hidden) return hidePopovers();
  hidePopovers();
  renderModelPanel();
  panel.hidden = false;
  place(panel, anchor);
}

async function changeSettings(changes) {
  const chat = current();
  if (!chat) {
    state.newSettings = { ...state.newSettings, ...changes };
    local.set('newSettings', state.newSettings);
    return renderStats();
  }
  // Show it right away; the server's list confirms it.
  chat.settings = { ...settingsOf(chat), ...changes };
  if ('model' in changes) chat.modelLabel = modelOption(changes.model)?.label || '';
  renderStats();
  await api('PATCH', `/api/chats/${chat.id}`, changes).catch(fail);
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
// the keydown event; `run` returns false when it didn't apply. Entries
// without `match` are handled elsewhere (composer, sidebar) and only listed.
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
    keys: [`${MOD}N`, 'or', isMac ? '⌃⌘N' : 'Ctrl+Alt+N'],
    label: 'New chat',
    note: `${MOD}N in the installed app — a browser tab keeps it for a new window`,
    match: (e) => e.code === 'KeyN' && !e.shiftKey && (mod(e) || (isMac ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey)),
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
    id: 'reply',
    keys: [`${MOD}J`],
    label: 'Open the latest reply',
    note: 'The chat in the notice, or the newest unread one',
    match: (e) => mod(e) && !e.shiftKey && e.code === 'KeyJ',
    run: () => openReply(),
  },
  {
    id: 'shortcuts',
    keys: [`${MOD}/`],
    label: 'Open this screen',
    match: (e) => mod(e) && (e.key === '/' || e.code === 'Slash'), // ABNT keyboards put / elsewhere
    run: () => (location.hash = 'shortcuts'),
  },
  { id: 'send', keys: ['Enter'], label: 'Send message', note: 'On a phone, use the send button' },
  { id: 'newline', keys: ['⇧Enter'], label: 'New line in the message' },
  { id: 'stop', keys: ['Esc'], label: 'Stop the agent', note: 'While it is working, with the message box focused' },
  { id: 'rename', keys: ['Double-click'], label: 'Rename a chat', note: 'Double-click it in the sidebar, or use its ⋯ menu' },
];

document.addEventListener(
  'keydown',
  (e) => {
    const s = SHORTCUTS.find((x) => x.match?.(e));
    if (!s || e.isComposing || s.run(e) === false) return;
    e.preventDefault();
  },
  true,
);

$('#new-chat-hint').textContent = standalone ? `${MOD}N` : isMac ? '⌃⌘N' : 'Ctrl+Alt+N';
$('#shortcuts-hint').textContent = `${MOD}/`;

// The Shortcuts screen: what each one does and its keys.
$('#shortcut-list').replaceChildren(
  ...SHORTCUTS.map((s) =>
    h(
      'li',
      {},
      h('span', { class: 'what' }, s.label, s.note ? h('small', { textContent: s.note }) : null),
      h('span', { class: 'keys' }, s.keys.map((k) => (k === '…' || k === 'or' ? h('span', { textContent: k }) : h('kbd', { textContent: k })))),
    ),
  ),
);
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
    if (e.shiftKey || touch) return;
    e.preventDefault();
    $('#composer').requestSubmit();
  }
  if (e.key === 'Escape' && state.status === 'running') {
    wsSend({ op: 'interrupt', chatId: state.chatId });
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
  const settings = state.chatId ? undefined : state.newSettings; // a new chat starts with these
  if (!wsSend({ op: 'send', ref, chatId: state.chatId, text, attachments, settings })) return toast('Not connected to the server', true);
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
