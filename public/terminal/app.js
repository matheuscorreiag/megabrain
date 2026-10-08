// Terminal page: tmux-backed terminal tabs (lib/terminal.js) in the same
// layout as the chat page — sidebar list with per-tab accents, ⌘1–9 / ⌘N /
// ⌘B — plus a Files panel on the right. Shared pieces: /ui.js, /base.css.

import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';
import { $, h, touch, narrow, isMac, appKey, isAppKey, itemKey, itemNumber, api, storage, toast, fail, showMenu, editInline, setupSidebar, setupPinning, setConn, accentFor, setHue, toHex, indexLabel, MORE_ICON } from '/ui.js';

const local = storage('terminal'); // active tab, last folder, panels
let config = { root: '/', workdir: '/', home: '/', hostname: '' };
let tabs = []; // pinned first, then oldest first: ⌘1…⌘9 follow this order
let activeId = local.get('active', null);
let editing = false; // a name is being renamed inline: hold list re-renders
const views = new Map(); // tab id -> { el, term, fit, ws, status, retries, timer, gone }

// In a terminal, Ctrl+B/E belong to the shell; off macOS this page uses
// Ctrl+Shift for them instead (macOS keeps ⌘, which terminals never see).
// 1–9 are the chat page's keys (ui.js itemNumber).
const TMOD = isMac ? '⌘' : 'Ctrl+Shift+';
const tmod = (e) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && e.shiftKey) && !e.altKey;

const tildify = (p = '') => (p === config.home || p.startsWith(`${config.home}/`) ? `~${p.slice(config.home.length)}` : p);
const joinPath = (dir, name) => `${dir.replace(/\/$/, '')}/${name}`;
const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

// Terminals have no stored color: the hue comes from the id, so a tab looks
// the same on every device.
const hueOf = (id) => Math.round((parseInt(id.slice(0, 6), 16) * 137.508) % 360);

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

function askName(message, value = '') {
  const name = prompt(message, value)?.trim();
  if (!name) return null;
  if (name.includes('/') || name === '.' || name === '..') {
    toast('Invalid name', true);
    return null;
  }
  return name;
}

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6"/></svg>',
};

// ---------------------------------------------------------------- sidebar

const sidebar = setupSidebar('terminalSidebarCollapsed');
$('#close-sidebar').addEventListener('click', sidebar.toggle);
$('#open-sidebar').addEventListener('click', sidebar.toggle);

const listItems = new Map(); // tab id -> { el, avatar, name, sub, kbd }

function listItem(tab) {
  const avatar = h('span', { class: 'avatar', 'aria-hidden': 'true' });
  const name = h('span', { class: 'name' });
  const sub = h('span', { class: 'sub' });
  const kbd = h('kbd', { class: 'kbd' });
  const current = () => tabs.find((t) => t.id === tab.id) || tab;
  const rename = () =>
    // Clearing the name goes back to the automatic title.
    editInline(name, current().title, (t) => setTabTitle(current(), t), {
      onStart: () => (editing = true),
      onEnd: () => {
        editing = false;
        renderList();
      },
    });
  const more = h('button', {
    type: 'button',
    class: 'more',
    innerHTML: MORE_ICON,
    'aria-label': 'Terminal options',
    onclick: (e) => {
      e.stopPropagation();
      const t = current();
      const dir = t.currentPath || t.cwd;
      showMenu(more, [
        { label: isPinned(t) ? 'Unpin' : 'Pin', run: () => togglePin(t) },
        { label: 'Rename', run: rename },
        t.renamed && { label: 'Back to automatic title', run: () => setTabTitle(t, '') },
        {
          label: 'Show folder in Files',
          run: () => {
            openDir(dir);
            setFiles(true);
          },
        },
        { label: 'New terminal in this folder', run: () => createTab(dir) },
        { label: 'New chat in this folder', run: () => chatIn(dir) },
        { label: 'Close terminal', danger: true, run: () => closeTab(t) },
      ]);
    },
  });
  const el = h(
    'div',
    {
      class: 'side-item',
      dataset: { id: tab.id },
      role: 'button',
      tabIndex: 0,
      onclick: () => activate(tab.id),
      ondblclick: (e) => {
        e.preventDefault();
        rename();
      },
      onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && activate(tab.id),
    },
    avatar,
    h('span', { class: 'text' }, name, sub),
    h('span', { class: 'side' }, kbd, more),
  );
  return { el, avatar, name, sub, kbd };
}

function renderList() {
  if (editing || pinning.dragging) return;
  const nav = $('#tab-list');
  const ids = new Set(tabs.map((t) => t.id));
  for (const [id, item] of listItems) {
    if (!ids.has(id)) {
      item.el.remove();
      listItems.delete(id);
    }
  }
  tabs.forEach((tab, i) => {
    let item = listItems.get(tab.id);
    if (!item) listItems.set(tab.id, (item = listItem(tab)));
    const path = tildify(tab.currentPath || tab.cwd);
    item.el.classList.toggle('active', tab.id === activeId);
    item.el.style.setProperty('--item-accent', accentFor(hueOf(tab.id)));
    item.el.title = `${tab.title}\n${path}${i < 9 ? `  (${itemKey(i + 1)})` : ''}`;
    item.avatar.textContent = indexLabel(i);
    item.name.textContent = tab.title;
    item.sub.textContent = tab.clients > 1 ? `${path} · ${tab.clients} devices` : path;
    item.kbd.textContent = i < 9 ? itemKey(i + 1) : '';
    item.kbd.hidden = i >= 9;
    (isPinned(tab) ? pinning.nav : nav).append(item.el);
  });
  const pinned = tabs.filter(isPinned).length;
  pinning.update(pinned);
  $('#tab-count').textContent = tabs.length > pinned ? indexLabel(tabs.length - pinned - 1) : '';
  $('#empty').hidden = tabs.length > 0;
  const active = tabs.find((t) => t.id === activeId);
  document.title = active ? active.title : 'Terminal';
  setHue(active ? hueOf(active.id) : undefined);
  $('#chat-here').hidden = !active;
  $('#chat-here').title = active ? `New chat in ${tildify(active.currentPath || active.cwd)}` : '';
}

// Pinned tabs (tmux @mothership_pinned, their place from 1) come first, in the
// server's order — mirrored here so a drop shows at once.
const isPinned = (t) => t.pinned != null;
const byPlace = (a, b) => (a.pinned ?? Infinity) - (b.pinned ?? Infinity) || a.created - b.created;

// index: its place among the pinned tabs; null unpins it.
async function movePin(id, index) {
  const before = tabs.filter(isPinned).map((t) => t.id);
  const ids = before.filter((x) => x !== id);
  if (index != null) ids.splice(index, 0, id);
  if (ids.join() === before.join()) return;
  tabs = tabs.map((t) => ({ ...t, pinned: ids.indexOf(t.id) + 1 || undefined })).sort(byPlace);
  renderList();
  await api('PUT', '/api/tabs/pinned', { ids }).catch(fail);
  await refreshTabs();
}
const togglePin = (tab) => movePin(tab.id, isPinned(tab) ? null : tabs.filter(isPinned).length);

const pinning = setupPinning({ list: $('#tab-list'), onDrop: movePin, onEnd: renderList });

// ------------------------------------------------------------------- tabs

async function refreshTabs() {
  try {
    tabs = await api('GET', '/api/tabs');
    if (!views.get(activeId)) setConn('online');
  } catch (err) {
    if (err.status === 503) return location.replace('/'); // turned off: the chat page says so
    setConn('offline');
    return;
  }
  for (const id of views.keys()) if (!tabs.some((t) => t.id === id)) destroyView(id);
  if (!tabs.some((t) => t.id === activeId)) activeId = tabs[0]?.id ?? null;
  renderList();
  if (activeId && !views.get(activeId)?.el.classList.contains('active')) activate(activeId, { focus: false });
}

function activate(id, { focus = !touch } = {}) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeId = id;
  local.set('active', id);
  const view = ensureView(tab);
  for (const v of views.values()) v.el.classList.toggle('active', v === view);
  renderList();
  fitView(view);
  if (!view.ws) connect(view);
  else setConn(view.status || 'online');
  if (focus) view.term.focus();
  if (narrow()) sidebar.setDrawer(false);
}

async function createTab(dir) {
  try {
    const tab = await api('POST', '/api/tabs', { cwd: dir || cwd || config.workdir });
    await refreshTabs();
    if (tab) activate(tab.id);
  } catch (err) {
    fail(err);
  }
}

async function setTabTitle(tab, title) {
  await api('PATCH', `/api/tabs/${tab.id}`, { title });
  await refreshTabs();
}

async function closeTab(tab) {
  if (!confirm(`Close "${tab.title}"? Whatever is running in it will be stopped.`)) return;
  try {
    await api('DELETE', `/api/tabs/${tab.id}`);
    await refreshTabs();
  } catch (err) {
    fail(err);
  }
}

$('#new-tab').addEventListener('click', () => createTab());
$('#empty-new').addEventListener('click', () => createTab());

// A new chat whose agent starts in this folder (the chat page reads ?dir=).
const chatIn = (dir) => (location.href = `/?dir=${encodeURIComponent(dir)}`);
$('#chat-here').addEventListener('click', () => {
  const tab = tabs.find((t) => t.id === activeId);
  if (tab) chatIn(tab.currentPath || tab.cwd);
});

// --------------------------------------------------------------- terminal

function ensureView(tab) {
  let view = views.get(tab.id);
  if (view) return view;
  const el = h('div', { class: 'term' });
  $('#terms').append(el);
  const hue = hueOf(tab.id);
  const accent = toHex(accentFor(hue));
  const background = toHex(`oklch(0.13 0.011 ${hue})`); // --code-bg in base.css
  const term = new Terminal({
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: narrow() ? 12 : 13,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 2000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    theme: { background, foreground: toHex(`oklch(0.93 0.01 ${hue})`), cursor: accent, cursorAccent: background, selectionBackground: `${accent}55` },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(el);
  view = { id: tab.id, el, term, fit, ws: null, status: 'connecting', retries: 0, timer: null, gone: false };
  term.onData((d) => wsSend(view, { t: 'i', d }));
  term.onResize(({ cols, rows }) => wsSend(view, { t: 'r', cols, rows }));
  views.set(tab.id, view);
  return view;
}

function destroyView(id) {
  const view = views.get(id);
  if (!view) return;
  view.gone = true;
  clearTimeout(view.timer);
  view.ws?.close();
  view.term.dispose();
  view.el.remove();
  views.delete(id);
}

function setStatus(view, status) {
  view.status = status;
  if (view.id === activeId) setConn(status === '' ? 'online' : status);
}

function wsSend(view, msg) {
  if (view.ws?.readyState === WebSocket.OPEN) view.ws.send(JSON.stringify(msg));
}

function connect(view) {
  clearTimeout(view.timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/tabs/${view.id}?cols=${view.term.cols}&rows=${view.term.rows}`);
  view.ws = ws;
  setStatus(view, 'connecting');
  ws.onopen = () => {
    view.retries = 0;
    view.term.reset(); // tmux redraws the whole screen on attach
    setStatus(view, 'online');
    fitView(view);
  };
  ws.onmessage = (e) => view.term.write(e.data);
  ws.onclose = (e) => {
    if (view.ws !== ws || view.gone) return;
    view.ws = null;
    setStatus(view, 'offline');
    // 4000: the tmux client exited — usually the tab ended; refresh decides.
    const delay = e.code === 4000 ? 0 : Math.min(10000, 500 * 2 ** view.retries++);
    view.timer = setTimeout(async () => {
      await refreshTabs();
      if (!view.gone && !view.ws) connect(view);
    }, delay);
  };
}

function fitView(view) {
  if (!view?.el.classList.contains('active')) return;
  try {
    view.fit.fit();
  } catch {}
}

// Panels slide in and out: refit once the size settles, not on every frame
// (each fit resizes the tmux session).
let fitTimer;
new ResizeObserver(() => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => fitView(views.get(activeId)), 80);
}).observe($('#terms'));

// Phones drop sockets while asleep; reconnect as soon as the page is back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refreshTabs();
  const view = views.get(activeId);
  if (view && view.ws?.readyState !== WebSocket.OPEN && view.ws?.readyState !== WebSocket.CONNECTING) connect(view);
});
// Titles follow whatever runs in each tab, so keep the list fresh.
setInterval(() => !document.hidden && refreshTabs(), 3000);

// Chats that replied meanwhile: a count on "Back to chats" (and on the
// floating toggle while the sidebar is closed).
async function refreshUnread() {
  let n = 0;
  try {
    n = (await api('GET', '/api/chats')).filter((c) => c.unread).length;
  } catch {
    return;
  }
  for (const el of [$('#chats-unread'), $('#unread-badge')]) {
    el.hidden = !n;
    el.textContent = n > 9 ? '9+' : String(n);
  }
}
setInterval(() => !document.hidden && refreshUnread(), 5000);
document.addEventListener('visibilitychange', () => !document.hidden && refreshUnread());

// -------------------------------------------------------------- shortcuts

// Captured before xterm sees them, so they never reach the shell.
const SHORTCUTS = [
  {
    // 1–9: the same keys as on the chat page (ui.js itemNumber).
    match: (e) => itemNumber(e) > 0,
    run: (e) => {
      const tab = tabs[itemNumber(e) - 1];
      if (!tab) return false;
      activate(tab.id);
    },
  },
  { match: (e) => isAppKey(e, 'N'), run: () => createTab() },
  { match: (e) => tmod(e) && e.code === 'KeyB', run: () => sidebar.toggle() },
  { match: (e) => tmod(e) && e.code === 'KeyE', run: () => setFiles(!document.body.classList.contains('files-open')) },
  { match: (e) => isAppKey(e, 'T'), run: () => (location.href = '/') },
  // ⇧⌘P (Ctrl+Shift+P): pin / unpin the open terminal, like on the chat page.
  {
    match: (e) => tmod(e) && e.shiftKey && e.code === 'KeyP',
    run: () => {
      const tab = tabs.find((t) => t.id === activeId);
      if (!tab) return false;
      togglePin(tab);
    },
  },
];
document.addEventListener(
  'keydown',
  (e) => {
    const s = SHORTCUTS.find((x) => x.match(e));
    if (!s || s.run(e) === false) return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);
$('#new-tab-hint').textContent = appKey('N');
$('#files-hint').textContent = `${TMOD}E`;
$('#chats-hint').textContent = appKey('T');

// ------------------------------------------------------- touch key strip

const KEYS = {
  esc: '\x1b',
  tab: '\t',
  stab: '\x1b[Z',
  ctrlc: '\x03',
  up: '\x1b[A',
  down: '\x1b[B',
  left: '\x1b[D',
  right: '\x1b[C',
  enter: '\r',
};
const keys = $('#keys');
// Don't let the strip steal focus (and close the phone keyboard).
for (const type of ['pointerdown', 'mousedown']) keys.addEventListener(type, (e) => e.preventDefault());
keys.addEventListener('click', (e) => {
  const button = e.target.closest('button');
  const view = views.get(activeId);
  if (!button || !view) return;
  if (button.dataset.key) wsSend(view, { t: 'i', d: KEYS[button.dataset.key] });
  else if (button.dataset.scroll) api('POST', `/api/tabs/${activeId}/scroll`, { dir: button.dataset.scroll }).catch(fail);
});

// ------------------------------------------------------------------ files

let cwd = local.get('cwd', null);
let listing = null;
let showHidden = local.get('hidden', false);
$('#show-hidden').checked = showHidden;

function setFiles(open) {
  document.body.classList.toggle('files-open', open);
  $('#toggle-files').classList.toggle('active', open);
  local.set('files', open || null);
  if (open && narrow()) sidebar.setDrawer(false);
}
$('#toggle-files').addEventListener('click', () => setFiles(!document.body.classList.contains('files-open')));

async function openDir(path) {
  try {
    listing = await api('GET', `/api/fs/list?path=${encodeURIComponent(path)}`);
    cwd = listing.path;
    local.set('cwd', cwd);
    renderFiles();
  } catch (err) {
    fail(err);
    if (!listing && path !== config.workdir) openDir(config.workdir);
  }
}

function renderFiles() {
  const crumbs = $('#crumbs');
  const rootLabel = config.root === config.home ? '~' : config.root;
  const parts = cwd === config.root ? [] : cwd.slice(config.root.length).split('/').filter(Boolean);
  let acc = config.root;
  crumbs.replaceChildren(h('a', { textContent: rootLabel, onclick: () => openDir(config.root) }));
  for (const part of parts) {
    const target = (acc = joinPath(acc, part));
    crumbs.append(' / ', h('a', { textContent: part, onclick: () => openDir(target) }));
  }
  crumbs.scrollLeft = crumbs.scrollWidth;

  const entries = listing.entries.filter((e) => showHidden || !e.name.startsWith('.'));
  const list = $('#file-list');
  list.replaceChildren(
    ...entries.map((entry) => {
      const more = h('button', { class: 'more', type: 'button', innerHTML: MORE_ICON, 'aria-label': 'Actions' });
      return h(
        'li',
        {
          class: `${entry.type}${entry.name.startsWith('.') ? ' hidden-file' : ''}`,
          title: entry.path,
          onclick: (e) => {
            if (e.target.closest('.more')) return fileMenu(entry, more);
            entry.type === 'dir' ? openDir(entry.path) : openFile(entry);
          },
        },
        h('span', { class: 'icon', innerHTML: entry.type === 'dir' ? ICONS.folder : ICONS.file }),
        h('span', { class: 'name', textContent: entry.name + (entry.link ? ' ↪' : '') }),
        entry.type === 'file' ? h('span', { class: 'meta', textContent: formatSize(entry.size) }) : null,
        more,
      );
    }),
  );
  if (!entries.length) list.append(h('li', { class: 'msg', textContent: 'Empty folder' }));
}

// Types the path at the prompt of the active terminal (nothing is run).
function insertPath(path) {
  const view = views.get(activeId);
  if (!view) return toast('Open a terminal first', true);
  wsSend(view, { t: 'i', d: `${shellQuote(path)} ` });
  if (narrow()) setFiles(false);
  toast('Path typed into the terminal');
}

function fileMenu(entry, anchor) {
  const isDir = entry.type === 'dir';
  showMenu(anchor, [
    isDir ? { label: 'New terminal here', run: () => createTab(entry.path) } : { label: 'Open', run: () => openFile(entry) },
    !isDir && { label: 'Download', run: () => download(entry.path) },
    { label: 'Type path into terminal', run: () => insertPath(entry.path) },
    { label: 'Rename', run: () => renameEntry(entry) },
    { label: 'Move to Trash', danger: true, run: () => trashEntry(entry) },
  ]);
}

function download(path) {
  h('a', { href: `/api/fs/read?path=${encodeURIComponent(path)}&download=1`, download: '' }).click();
}

async function renameEntry(entry) {
  const name = askName('New name', entry.name);
  if (!name || name === entry.name) return;
  try {
    await api('POST', '/api/fs/rename', { from: entry.path, to: joinPath(cwd, name) });
    openDir(cwd);
  } catch (err) {
    fail(err);
  }
}

async function trashEntry(entry) {
  if (!confirm(`Move "${entry.name}" to the Trash?`)) return;
  try {
    await api('POST', '/api/fs/trash', { path: entry.path });
    toast('Moved to the Trash');
    openDir(cwd);
  } catch (err) {
    fail(err);
  }
}

async function upload(files) {
  files = [...files];
  let done = 0;
  for (const file of files) {
    const target = joinPath(cwd, file.name);
    toast(`Uploading ${done + 1}/${files.length}: ${file.name}`);
    try {
      await api('PUT', `/api/fs/write?path=${encodeURIComponent(target)}&overwrite=0`, file);
      done++;
    } catch (err) {
      if (err.status === 409 && confirm(`"${file.name}" already exists. Replace it?`)) {
        await api('PUT', `/api/fs/write?path=${encodeURIComponent(target)}`, file).then(() => done++, fail);
      } else if (err.status !== 409) fail(err);
    }
  }
  if (done) toast(`${done} file(s) uploaded`);
  openDir(cwd);
}

$('.files-head').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'close') setFiles(false);
  if (act === 'up' && listing?.parent) openDir(listing.parent);
  if (act === 'refresh') openDir(cwd);
  if (act === 'upload') $('#upload-input').click();
  if (act === 'term-here') createTab(cwd);
  if (act === 'new-dir') {
    const name = askName('New folder name');
    if (name) api('POST', '/api/fs/mkdir', { path: joinPath(cwd, name) }).then(() => openDir(cwd), fail);
  }
  if (act === 'new-file') {
    const name = askName('New file name');
    if (!name) return;
    const path = joinPath(cwd, name);
    try {
      await api('PUT', `/api/fs/write?path=${encodeURIComponent(path)}&overwrite=0`, '');
      await openDir(cwd);
      openFile({ path, name });
    } catch (err) {
      fail(err);
    }
  }
});
$('#show-hidden').addEventListener('change', (e) => {
  showHidden = e.target.checked;
  local.set('hidden', showHidden || null);
  renderFiles();
});
$('#upload-input').addEventListener('change', (e) => {
  if (e.target.files.length) upload(e.target.files);
  e.target.value = '';
});

const filesPanel = $('#files');
let dragDepth = 0;
filesPanel.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  filesPanel.classList.add('dragging');
});
filesPanel.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) filesPanel.classList.remove('dragging');
});
filesPanel.addEventListener('dragover', (e) => e.preventDefault());
filesPanel.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  filesPanel.classList.remove('dragging');
  if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
});

// ----------------------------------------------------------------- editor

const editor = $('#editor');
let code = null; // the code editor (editor.js)
let loadingCode = null; // its first load: clicks while it loads wait for the same one
let editingFile = null;
let opening = 0; // the latest click wins (a double-click is two clicks)

// Made once: a second click while CodeMirror loads (a double-click does it)
// would otherwise add a second editor under the first, which then kept
// showing the first file whatever was opened next.
function loadCode() {
  loadingCode ??= import('/terminal/editor.js')
    .then((m) => (code = m.createEditor($('#editor-text'), { onSave: saveFile })))
    .catch((err) => {
      loadingCode = null;
      throw err;
    });
  return loadingCode;
}

async function openFile(entry) {
  const n = ++opening;
  try {
    const res = await fetch(`/api/fs/read?path=${encodeURIComponent(entry.path)}`, { headers: { 'x-mothership': '1' } });
    if (res.status === 413 || res.status === 415) {
      const { error } = await res.json();
      if (n !== opening) return;
      if (confirm(`${error[0].toUpperCase()}${error.slice(1)}. Download it now?`)) download(entry.path);
      return;
    }
    if (!res.ok) throw new Error((await res.json()).error);
    const text = await res.text();
    await loadCode();
    if (n !== opening) return; // another file was clicked meanwhile
    editingFile = { path: entry.path, original: text };
    $('#editor-name').textContent = tildify(entry.path);
    $('#editor-status').textContent = '';
    if (!editor.open) editor.showModal();
    code.open(text, entry.path.split('/').pop());
    if (!touch) code.focus();
  } catch (err) {
    fail(err);
  }
}

async function saveFile() {
  if (!editingFile) return;
  const text = code.text;
  $('#editor-status').textContent = 'saving…';
  try {
    await api('PUT', `/api/fs/write?path=${encodeURIComponent(editingFile.path)}`, text);
    editingFile.original = text;
    $('#editor-status').textContent = `saved at ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    if (listing && editingFile.path.startsWith(cwd)) openDir(cwd);
  } catch (err) {
    $('#editor-status').textContent = '';
    fail(err);
  }
}

function closeEditor() {
  if (editingFile && code.text !== editingFile.original && !confirm('Discard unsaved changes?')) return;
  editingFile = null;
  editor.close();
}

$('#editor-save').addEventListener('click', saveFile);
$('#editor-close').addEventListener('click', closeEditor);
$('#editor-download').addEventListener('click', () => editingFile && download(editingFile.path));
editor.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeEditor();
});
// Esc is caught before it becomes a "cancel", which the browser only lets a
// page refuse once per user action: a second Esc would drop unsaved changes.
// The editor's own Esc (closing find) comes first.
editor.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  e.preventDefault();
  closeEditor();
});

// ------------------------------------------------------------------- boot

setConn('connecting');
try {
  config = await api('GET', '/api/config');
} catch (err) {
  fail(err);
}
if (local.get('files', false) && !narrow()) setFiles(true);
await refreshTabs();
openDir(cwd || config.workdir);
refreshUnread();
