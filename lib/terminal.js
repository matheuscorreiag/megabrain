// Terminal tabs (tmux sessions running a login shell) and the file browser.
//
//   tab   = a tmux session (socket `megabrain`) running your login shell
//   view  = a WebSocket that attaches a PTY to that tmux session
//   files = a small REST API over the filesystem, confined to `root`
//
// Sessions live in tmux, so a tab survives the browser closing and can be
// opened from SSH too (`bin/megabrain`). UI: /terminal/.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { APP_DIR, HOME, HOSTNAME, config, expandHome, findBin, cleanEnv, HttpError, sendJson, readJson, clampInt, rejectUpgrade } from './config.js';

const ROOT = fs.realpathSync(expandHome(config.root));
const WORKDIR = fs.realpathSync(expandHome(config.workdir));
const SHELL = config.shell;
const TMUX = config.tmux || findBin('tmux');
const TMUX_BASE = ['-L', 'megabrain', '-f', path.join(APP_DIR, 'tmux.conf')];
const PREFIX = 'megabrain-';
const MAX_READ = 2 * 1024 * 1024;

function tmux(args, input) {
  if (!TMUX) return Promise.reject(new HttpError(500, 'tmux not found — install it with `brew install tmux`'));
  return new Promise((resolve, reject) => {
    const child = execFile(TMUX, [...TMUX_BASE, ...args], { env: cleanEnv(), encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

// ------------------------------------------------------------------- tabs

const TAB_FORMAT = [
  '#{session_name}',
  '#{session_path}',
  '#{session_created}',
  '#{session_attached}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{@megabrain_title}',
  '#{@megabrain_pinned}',
  '#{pane_title}',
].join('\t');

function tabName(id) {
  if (!/^[a-f0-9]{8}$/.test(id)) throw new HttpError(400, 'invalid id');
  return PREFIX + id;
}

// Exact-match targets: `=name` for session commands, `=name:` for commands
// that take a pane (set-option, send-keys, ...), which reject the bare form.
const pane = (name) => `=${name}:`;

// Like a terminal emulator: a name you gave the tab wins; otherwise the title
// the running program set (tmux defaults it to the hostname, i.e. unset);
// otherwise the current folder. Shells often set "user@host:~/dir" — that
// becomes just the folder name.
function autoTitle(paneTitle, currentPath) {
  const folder = (p) => (p === HOME || p === '~' ? '~' : path.basename(p) || p);
  const t = paneTitle.trim().replace(/^[^@\s]+@[^:\s]+:\s*/, '');
  if (!t || t === HOSTNAME || t === os.hostname()) return folder(currentPath);
  return /^[~/]/.test(t) && !/\s/.test(t) ? folder(t) : t;
}

async function listTabs() {
  let out;
  try {
    out = await tmux(['list-sessions', '-F', TAB_FORMAT]);
  } catch (err) {
    if (/no server running|error connecting|no sessions/i.test(err.stderr || '')) return [];
    throw err;
  }
  return out
    .split('\n')
    .filter((line) => line.startsWith(PREFIX))
    .map((line) => {
      const [name, cwd, created, attached, currentPath, command, customTitle, pinned, ...paneTitle] = line.split('\t');
      return {
        id: name.slice(PREFIX.length),
        title: customTitle || autoTitle(paneTitle.join('\t'), currentPath),
        renamed: Boolean(customTitle),
        pinned: Number(pinned) || undefined,
        cwd,
        currentPath,
        command,
        created: Number(created) * 1000,
        clients: Number(attached),
      };
    })
    // Pinned tabs first, in their pinned order; then the oldest first.
    .sort((a, b) => (a.pinned ?? Infinity) - (b.pinned ?? Infinity) || a.created - b.created);
}

async function createTab({ cwd }) {
  const dir = await resolveSafe(cwd || WORKDIR);
  if (!(await fsp.stat(dir)).isDirectory()) throw new HttpError(400, 'the tab folder must be a directory');
  const id = crypto.randomBytes(4).toString('hex');
  // Login shell so PATH, nvm etc. match a normal terminal window.
  await tmux(['new-session', '-d', '-s', PREFIX + id, '-c', dir, '-x', '120', '-y', '36', SHELL, '-l']);
  return (await listTabs()).find((t) => t.id === id);
}

// An empty title goes back to the automatic one.
async function renameTab(id, title) {
  const label = String(title || '').trim().slice(0, 80);
  const target = pane(tabName(id));
  if (label) await tmux(['set-option', '-t', target, '@megabrain_title', label]);
  else await tmux(['set-option', '-u', '-t', target, '@megabrain_title']).catch(() => {});
}

// The whole pinned list at once, in order (@megabrain_pinned, 1-based: tmux reads
// 0 as false); every tab not in it is unpinned.
async function setPinned(ids) {
  if (!Array.isArray(ids)) throw new HttpError(400, 'ids must be a list');
  const order = [...new Set(ids)];
  for (const tab of await listTabs()) {
    const pinned = order.indexOf(tab.id) + 1 || undefined;
    if (pinned === tab.pinned) continue;
    const target = pane(tabName(tab.id));
    if (pinned) await tmux(['set-option', '-t', target, '@megabrain_pinned', String(pinned)]);
    else await tmux(['set-option', '-u', '-t', target, '@megabrain_pinned']).catch(() => {});
  }
}

async function closeTab(id) {
  await tmux(['kill-session', '-t', `=${tabName(id)}`]).catch(() => {});
}

// Touch screens can't wheel-scroll tmux, so the UI has page buttons.
async function scrollTab(id, dir) {
  const target = pane(tabName(id));
  if (dir === 'up') await tmux(['copy-mode', '-u', '-t', target]);
  else if (dir === 'down') await tmux(['send-keys', '-t', target, '-X', 'page-down-and-cancel']).catch(() => {});
  else await tmux(['send-keys', '-t', target, '-X', 'cancel']).catch(() => {});
}

// ------------------------------------------------------------------ files

// Resolve symlinks (of the deepest existing ancestor, for paths about to be
// created) so nothing can step outside ROOT.
async function resolveSafe(p, { mustExist = true } = {}) {
  if (typeof p !== 'string' || !p) throw new HttpError(400, 'path required');
  const abs = path.resolve(ROOT, expandHome(p));
  let real;
  try {
    real = await fsp.realpath(abs);
  } catch (err) {
    if (err.code !== 'ENOENT' || mustExist) throw new HttpError(404, 'not found');
    try {
      real = path.join(await fsp.realpath(path.dirname(abs)), path.basename(abs));
    } catch {
      throw new HttpError(404, 'folder not found');
    }
  }
  if (real !== ROOT && !real.startsWith(ROOT + path.sep)) throw new HttpError(403, 'outside the allowed folder');
  return real;
}

async function listDir(p) {
  const dir = await resolveSafe(p);
  const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch((err) => {
    throw new HttpError(err.code === 'ENOTDIR' ? 400 : 403, err.code === 'ENOTDIR' ? 'not a folder' : 'permission denied');
  });
  const entries = await Promise.all(
    dirents.map(async (d) => {
      const full = path.join(dir, d.name);
      const st = await fsp.stat(full).catch(() => null); // follows symlinks; null when broken
      return {
        name: d.name,
        path: full,
        type: st?.isDirectory() ? 'dir' : 'file',
        size: st?.size ?? 0,
        mtime: st?.mtimeMs ?? 0,
        link: d.isSymbolicLink(),
      };
    }),
  );
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'en', { numeric: true }) : a.type === 'dir' ? -1 : 1));
  return { path: dir, parent: dir === ROOT ? null : path.dirname(dir), entries };
}

async function readFile(req, res, url) {
  const file = await resolveSafe(url.searchParams.get('path'));
  const st = await fsp.stat(file);
  if (!st.isFile()) throw new HttpError(400, 'not a file');
  if (url.searchParams.get('download')) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': st.size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    });
    await pipeline(fs.createReadStream(file), res);
    return;
  }
  if (st.size > MAX_READ) throw new HttpError(413, 'file too large to open here — download it');
  const buf = await fsp.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) throw new HttpError(415, 'binary file — download it');
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(buf);
}

// Body streams to a temp file that is renamed over the target, so a dropped
// upload never leaves a half-written file behind.
async function writeFile(req, url) {
  const file = await resolveSafe(url.searchParams.get('path'), { mustExist: false });
  const exists = await fsp.stat(file).then((st) => st, () => null);
  if (exists?.isDirectory()) throw new HttpError(400, 'a folder with that name already exists');
  if (exists && url.searchParams.get('overwrite') === '0') throw new HttpError(409, 'file already exists');
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.megabrain-${crypto.randomBytes(3).toString('hex')}`);
  try {
    await pipeline(req, fs.createWriteStream(tmp, { mode: exists ? exists.mode & 0o777 : 0o644 }));
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return { path: file };
}

async function makeDir(p) {
  const dir = await resolveSafe(p, { mustExist: false });
  await fsp.mkdir(dir).catch((err) => {
    throw new HttpError(err.code === 'EEXIST' ? 409 : 400, err.code === 'EEXIST' ? 'already exists' : err.message);
  });
  return { path: dir };
}

async function renamePath(from, to) {
  const src = await resolveSafe(from);
  const dst = await resolveSafe(to, { mustExist: false });
  if (src === ROOT) throw new HttpError(400, 'cannot move the root folder');
  if (await fsp.stat(dst).then(() => true, () => false)) throw new HttpError(409, 'something with that name already exists');
  await fsp.rename(src, dst);
  return { path: dst };
}

// "Delete" moves to the macOS Trash, or to ~/.megabrain/trash when the Trash
// isn't writable from this process.
async function trashPath(p) {
  const src = await resolveSafe(p);
  if (src === ROOT) throw new HttpError(400, 'cannot delete the root folder');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const bin of [path.join(HOME, '.Trash'), path.join(HOME, '.megabrain', 'trash')]) {
    try {
      await fsp.mkdir(bin, { recursive: true });
      const target = path.join(bin, `${path.basename(src)} ${stamp}`);
      await fsp.rename(src, target);
      return { trashed: target };
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    }
  }
  throw new HttpError(403, 'no permission to move to the Trash');
}

// ----------------------------------------------------------------- routes

export const terminalInfo = { root: ROOT, workdir: WORKDIR };

// Returns false when the path isn't a terminal/files route.
export async function handleTerminalApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  const reply = (status, body) => {
    sendJson(res, status, body);
    return true;
  };

  if (pathname === '/api/tabs') {
    if (method === 'GET') return reply(200, await listTabs());
    if (method === 'POST') return reply(201, await createTab(await readJson(req)));
  }
  // { ids }: the pinned tabs, in order
  if (pathname === '/api/tabs/pinned' && method === 'PUT') {
    await setPinned((await readJson(req)).ids);
    return reply(200, await listTabs());
  }
  const tab = pathname.match(/^\/api\/tabs\/([^/]+)(\/scroll)?$/);
  if (tab) {
    const [, id, action] = tab;
    if (!action && method === 'PATCH') {
      await renameTab(id, (await readJson(req)).title);
      return reply(200, { ok: true });
    }
    if (!action && method === 'DELETE') {
      await closeTab(id);
      return reply(200, { ok: true });
    }
    if (action && method === 'POST') {
      await scrollTab(id, (await readJson(req)).dir);
      return reply(200, { ok: true });
    }
  }
  if (pathname === '/api/fs/list' && method === 'GET') return reply(200, await listDir(url.searchParams.get('path') || WORKDIR));
  if (pathname === '/api/fs/read' && method === 'GET') {
    await readFile(req, res, url);
    return true;
  }
  if (pathname === '/api/fs/write' && method === 'PUT') return reply(200, await writeFile(req, url));
  if (pathname === '/api/fs/mkdir' && method === 'POST') return reply(201, await makeDir((await readJson(req)).path));
  if (pathname === '/api/fs/rename' && method === 'POST') {
    const body = await readJson(req);
    return reply(200, await renamePath(body.from, body.to));
  }
  if (pathname === '/api/fs/trash' && method === 'POST') return reply(200, await trashPath((await readJson(req)).path));
  return false;
}

// --------------------------------------------------------------- terminal

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

// Called for /ws/tabs/<id> after access checks.
export async function handleTerminalUpgrade(req, socket, head, url) {
  const match = url.pathname.match(/^\/ws\/tabs\/([a-f0-9]{8})$/);
  if (!match) return rejectUpgrade(socket, 404, 'Not Found');
  const name = PREFIX + match[1];
  try {
    await tmux(['has-session', '-t', `=${name}`]);
  } catch {
    return rejectUpgrade(socket, 404, 'Not Found');
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, name, url));
}

// Turned off from the panel: detach every browser view; tmux keeps the shells.
export function detachTerminals() {
  for (const ws of wss.clients) ws.close(1001, 'turned off');
}

// Each browser view is its own tmux client; closing the view only detaches.
function attach(ws, name, url) {
  const term = pty.spawn(TMUX, [...TMUX_BASE, 'attach-session', '-t', `=${name}`], {
    name: 'xterm-256color',
    cols: clampInt(url.searchParams.get('cols'), 10, 500, 120),
    rows: clampInt(url.searchParams.get('rows'), 4, 200, 36),
    cwd: HOME,
    env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'en_US.UTF-8' }),
  });
  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  // 4000 tells the UI the tmux client is gone (usually: the tab was closed).
  term.onExit(() => ws.close(4000, 'session ended'));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') term.write(msg.d);
    else if (msg.t === 'r') term.resize(clampInt(msg.cols, 10, 500, 120), clampInt(msg.rows, 4, 200, 36));
  });
  ws.on('close', () => {
    try {
      term.kill();
    } catch {}
  });
}
