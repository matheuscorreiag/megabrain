import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links.mjs';

const $ = (sel) => document.querySelector(sel);
const touch = matchMedia('(pointer: coarse)').matches;
const narrow = () => matchMedia('(max-width: 760px)').matches;

// Per-device conveniences only (active tab, last folder); tabs live in tmux.
const local = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`hub:${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`hub:${key}`, JSON.stringify(value));
    } catch {}
  },
};

let config = { root: '/', workdir: '/', home: '/', hostname: '' };
let tabs = [];
let activeId = local.get('active', null);
const views = new Map(); // tab id -> { el, term, fit, ws, status, retries, timer, gone }

// ------------------------------------------------------------------ utils

async function api(method, url, body) {
  const init = { method, headers: { 'x-hub': '1' } };
  if (typeof body === 'string' || body instanceof Blob) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(url, init);
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.error || res.statusText);
    err.status = res.status;
    throw err;
  }
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

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el[k] = v;
  }
  el.append(...children.filter((c) => c != null));
  return el;
}

const joinPath = (dir, name) => `${dir.replace(/\/$/, '')}/${name}`;
const tildify = (p) => (p === config.home || p.startsWith(`${config.home}/`) ? `~${p.slice(config.home.length)}` : p);
const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

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

// Keep the layout inside the visible viewport when the phone keyboard opens.
function syncHeight() {
  const height = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${height}px`);
  window.scrollTo(0, 0);
}
window.visualViewport?.addEventListener('resize', syncHeight);
window.visualViewport?.addEventListener('scroll', syncHeight);
window.addEventListener('resize', syncHeight);
syncHeight();

// ------------------------------------------------------------------- menu

let menuAnchor = null;

// Clicking the same anchor again closes the menu instead of reopening it.
function toggleMenu(anchor, items) {
  if (!$('#menu').hidden && menuAnchor === anchor) return hideMenu();
  showMenu(anchor, items);
}

function showMenu(anchor, items) {
  const menu = $('#menu');
  menuAnchor = anchor;
  menu.replaceChildren(
    ...items.filter(Boolean).map((item) =>
      h('button', {
        textContent: item.label,
        class: item.danger ? 'danger' : '',
        onclick: () => {
          hideMenu();
          item.run();
        },
      }),
    ),
  );
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
  menu.style.top = `${rect.bottom + height + 8 > innerHeight ? Math.max(8, rect.top - height - 4) : rect.bottom + 4}px`;
}
function hideMenu() {
  $('#menu').hidden = true;
  menuAnchor = null;
}
// Capture phase, so clicks on the terminal (which xterm handles) count too.
document.addEventListener(
  'pointerdown',
  (e) => {
    if (!e.target.closest('#menu') && !menuAnchor?.contains(e.target)) hideMenu();
  },
  true,
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideMenu();
});
window.addEventListener('blur', hideMenu);

// ------------------------------------------------------------------- tabs

async function refreshTabs() {
  try {
    tabs = await api('GET', '/api/tabs');
  } catch {
    return; // server unreachable; views show their own status
  }
  for (const id of views.keys()) if (!tabs.some((t) => t.id === id)) destroyView(id);
  if (!tabs.some((t) => t.id === activeId)) activeId = tabs.at(-1)?.id ?? null;
  renderTabs();
  if (activeId && !views.get(activeId)?.el.classList.contains('active')) activate(activeId, { focus: false });
}

let renderedKey = '';

function renderTabs() {
  // Polled every few seconds: skip rebuilding when nothing visible changed.
  const key = JSON.stringify([activeId, tabs.map((t) => [t.id, t.title, t.currentPath])]);
  if (key === renderedKey) return;
  renderedKey = key;
  const nav = $('#tabs');
  const scroll = nav.scrollLeft;
  nav.replaceChildren(
    ...tabs.map((tab) => {
      const el = h(
        'div',
        {
          class: `tab${tab.id === activeId ? ' active' : ''}`,
          role: 'tab',
          title: `${tab.title}\n${tildify(tab.currentPath || tab.cwd)}`,
          onclick: (e) => {
            if (e.target.closest('.close')) return closeTab(tab);
            if (tab.id === activeId) return tabMenu(tab, el);
            activate(tab.id);
          },
          ondblclick: () => renameTab(tab),
        },
        h('span', { class: 'title', textContent: tab.title }),
        h('span', { class: `dot ${views.get(tab.id)?.status || ''}` }),
        h('button', { class: 'close', title: 'Close terminal', textContent: '×' }),
      );
      return el;
    }),
  );
  nav.scrollLeft = scroll;
  $('#empty').hidden = tabs.length > 0;
  const active = tabs.find((t) => t.id === activeId);
  document.title = active ? `${active.title} · ${config.hostname}` : `Terminal · ${config.hostname}`;
}

function tabMenu(tab, anchor) {
  const dir = tab.currentPath || tab.cwd;
  toggleMenu(anchor, [
    { label: 'Rename', run: () => renameTab(tab) },
    tab.renamed && { label: 'Back to automatic title', run: () => setTabTitle(tab, '') },
    {
      label: 'Show folder in Files',
      run: () => {
        openDir(dir);
        setFilesOpen(true);
      },
    },
    { label: 'New terminal in this folder', run: () => createTab(dir) },
    { label: 'Close terminal', danger: true, run: () => closeTab(tab) },
  ]);
}

function activate(id, { focus = !touch } = {}) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  activeId = id;
  local.set('active', id);
  const view = ensureView(tab);
  for (const v of views.values()) v.el.classList.toggle('active', v === view);
  renderTabs();
  $('#tabs .tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  fitView(view);
  if (!view.ws) connect(view);
  if (focus) view.term.focus();
  if (narrow()) setFilesOpen(false);
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
  try {
    await api('PATCH', `/api/tabs/${tab.id}`, { title });
    await refreshTabs();
  } catch (err) {
    fail(err);
  }
}

function renameTab(tab) {
  const title = prompt('Terminal name (empty = automatic title)', tab.title);
  if (title === null || title.trim() === tab.title) return;
  setTabTitle(tab, title.trim());
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

// --------------------------------------------------------------- terminal

function ensureView(tab) {
  let view = views.get(tab.id);
  if (view) return view;
  const el = h('div', { class: 'term' });
  $('#terms').append(el);
  const term = new Terminal({
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    fontSize: narrow() ? 12 : 13,
    cursorBlink: true,
    scrollback: 2000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    theme: {
      background: '#121212',
      foreground: '#e6e6e6',
      cursor: '#6ea8fe',
      selectionBackground: '#6ea8fe55',
    },
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
  const tab = [...$('#tabs').children][tabs.findIndex((t) => t.id === view.id)];
  tab?.querySelector('.dot')?.setAttribute('class', `dot ${status}`);
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
    setStatus(view, '');
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

let fitFrame;
new ResizeObserver(() => {
  cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => fitView(views.get(activeId)));
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

$('#new-tab').addEventListener('click', () => createTab());
$('#empty-new').addEventListener('click', () => createTab());

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

function setFilesOpen(open) {
  document.body.classList.toggle('files-hidden', !open);
  if (!narrow()) local.set('files', open);
}
$('#toggle-files').addEventListener('click', () => setFilesOpen(document.body.classList.contains('files-hidden')));

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
    ...entries.map((entry) =>
      h(
        'li',
        {
          class: `${entry.type}${entry.name.startsWith('.') ? ' hidden-file' : ''}`,
          title: entry.path,
          onclick: (e) => {
            if (e.target.closest('.more')) return fileMenu(entry, e.target.closest('.more'));
            entry.type === 'dir' ? openDir(entry.path) : openFile(entry);
          },
        },
        h('span', { textContent: entry.type === 'dir' ? '📁' : '📄' }),
        h('span', { class: 'name', textContent: entry.name + (entry.link ? ' ↪' : '') }),
        entry.type === 'file' ? h('span', { class: 'meta', textContent: formatSize(entry.size) }) : null,
        h('button', { class: 'more', textContent: '⋯', title: 'Actions' }),
      ),
    ),
  );
  if (!entries.length) list.append(h('li', { class: 'msg', textContent: 'Empty folder' }));
}

// Types the path at the prompt of the active terminal (nothing is run).
function insertPath(path) {
  const view = views.get(activeId);
  if (!view) return toast('Open a terminal first', true);
  wsSend(view, { t: 'i', d: `${shellQuote(path)} ` });
  if (narrow()) setFilesOpen(false);
  toast('Path typed into the terminal');
}

function fileMenu(entry, anchor) {
  const isDir = entry.type === 'dir';
  toggleMenu(anchor, [
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

$('.files-actions').addEventListener('click', async (e) => {
  const act = e.target.closest('button')?.dataset.act;
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
  local.set('hidden', showHidden);
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
const editorText = $('#editor-text');
let editing = null;

async function openFile(entry) {
  try {
    const res = await fetch(`/api/fs/read?path=${encodeURIComponent(entry.path)}`, { headers: { 'x-hub': '1' } });
    if (res.status === 413 || res.status === 415) {
      const { error } = await res.json();
      if (confirm(`${error[0].toUpperCase()}${error.slice(1)}. Download it now?`)) download(entry.path);
      return;
    }
    if (!res.ok) throw new Error((await res.json()).error);
    const text = await res.text();
    editing = { path: entry.path, original: text };
    $('#editor-name').textContent = tildify(entry.path);
    $('#editor-status').textContent = '';
    editorText.value = text;
    editor.showModal();
    editorText.setSelectionRange(0, 0);
    editorText.scrollTop = 0;
  } catch (err) {
    fail(err);
  }
}

async function saveFile() {
  if (!editing) return;
  const text = editorText.value;
  $('#editor-status').textContent = 'saving…';
  try {
    await api('PUT', `/api/fs/write?path=${encodeURIComponent(editing.path)}`, text);
    editing.original = text;
    $('#editor-status').textContent = `saved at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    if (listing && editing.path.startsWith(cwd)) openDir(cwd);
  } catch (err) {
    $('#editor-status').textContent = '';
    fail(err);
  }
}

function closeEditor() {
  if (editing && editorText.value !== editing.original && !confirm('Discard unsaved changes?')) return;
  editing = null;
  editor.close();
}

$('#editor-save').addEventListener('click', saveFile);
$('#editor-close').addEventListener('click', closeEditor);
$('#editor-download').addEventListener('click', () => editing && download(editing.path));
editor.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeEditor();
});
editorText.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    saveFile();
  }
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    editorText.setRangeText('  ', editorText.selectionStart, editorText.selectionEnd, 'end');
  }
});

// ------------------------------------------------------------------- boot

try {
  config = await api('GET', '/api/config');
} catch (err) {
  fail(err);
}
setFilesOpen(narrow() ? false : local.get('files', true));
await refreshTabs();
openDir(cwd || config.workdir);
