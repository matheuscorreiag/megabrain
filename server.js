// term-hub — a web UI for the coding agent running on this Mac (/), plus the
// terminal tabs and file browser (/terminal/). Listens on localhost only;
// reach it from other devices with `tailscale serve` (see README).
// Settings: config.json.
//
//   lib/chat.js      agent conversations over WebSocket (/ws/chat)
//   lib/agents/      adapters per agent (claude.js)
//   lib/terminal.js  tmux-backed terminal tabs (/ws/tabs/<id>) and files API
//   lib/config.js    settings and shared helpers

import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { APP_DIR, HOME, HOSTNAME, config, authorized, fromThisMac, sameOrigin, rejectUpgrade, HttpError, sendJson } from './lib/config.js';
import { loadChats, handleChatApi, handleChatUpgrade, serveMedia, stopChats, pauseChats } from './lib/chat.js';
import { handleTerminalApi, handleTerminalUpgrade, terminalInfo, detachTerminals } from './lib/terminal.js';
import { power, setPower, keepAwake } from './lib/power.js';

const PUBLIC_DIR = path.join(APP_DIR, 'public');
const VENDOR = {
  '/vendor/xterm.mjs': 'node_modules/@xterm/xterm/lib/xterm.mjs',
  '/vendor/xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  '/vendor/addon-fit.mjs': 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs',
  '/vendor/addon-web-links.mjs': 'node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs',
  '/vendor/marked.mjs': 'node_modules/marked/lib/marked.esm.js',
  '/vendor/purify.mjs': 'node_modules/dompurify/dist/purify.es.mjs',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, pathname) {
  let file;
  if (VENDOR[pathname]) file = path.join(APP_DIR, VENDOR[pathname]);
  else {
    file = path.join(PUBLIC_DIR, path.normalize(pathname));
    if (pathname.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not found');
  }
  const body = await fsp.readFile(file).catch(() => {
    throw new HttpError(404, 'not found');
  });
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  res.end(body);
}

async function handleApi(req, res, url) {
  // A custom header can't be sent cross-site without a CORS preflight, which
  // this server never grants.
  if (req.method !== 'GET' && req.headers['x-hub'] !== '1') throw new HttpError(403, 'missing X-Hub header');
  if (url.pathname === '/api/config' && req.method === 'GET') {
    return sendJson(res, 200, { ...terminalInfo, home: HOME, hostname: HOSTNAME, thisMac: fromThisMac(req), on: power.on });
  }
  // On / off (lib/power.js): only from a browser on this Mac.
  if ((url.pathname === '/api/turn-off' || url.pathname === '/api/turn-on') && req.method === 'POST') {
    if (!fromThisMac(req)) throw new HttpError(403, 'only a browser on this Mac can turn the server on or off');
    const on = url.pathname === '/api/turn-on';
    if (on !== power.on) {
      console.log(on ? 'turned on' : 'turned off');
      setPower(on);
      if (!on) {
        pauseChats();
        detachTerminals();
      }
    }
    return sendJson(res, 200, { on });
  }
  if (!power.on) throw new HttpError(503, 'turned off');
  if (await handleChatApi(req, res, url)) return;
  if (await handleTerminalApi(req, res, url)) return;
  throw new HttpError(404, 'route not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!authorized(req)) throw new HttpError(401, 'unauthorized user');
    const isApi = url.pathname.startsWith('/api/');
    const isMedia = url.pathname.startsWith('/media/');
    if ((isApi || isMedia) && !sameOrigin(req)) throw new HttpError(403, 'origin not allowed');
    if (isApi) await handleApi(req, res, url);
    else if (req.method !== 'GET') throw new HttpError(405, 'method not allowed');
    else if (isMedia) {
      if (!power.on) throw new HttpError(503, 'turned off');
      await serveMedia(res, url);
    }
    else await serveStatic(res, url.pathname);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(req.method, url.pathname, err);
    if (res.headersSent) return res.destroy();
    const status = err instanceof HttpError ? err.status : err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 500;
    sendJson(res, status, { error: err instanceof HttpError ? err.message : err.stderr?.trim() || err.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!authorized(req) || !sameOrigin(req)) return rejectUpgrade(socket, 403, 'Forbidden');
  if (!power.on) return rejectUpgrade(socket, 503, 'Service Unavailable');
  if (url.pathname === '/ws/chat') return handleChatUpgrade(req, socket, head);
  if (url.pathname.startsWith('/ws/tabs/')) return handleTerminalUpgrade(req, socket, head, url);
  rejectUpgrade(socket, 404, 'Not Found');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    stopChats();
    process.exit(0);
  });
}

await loadChats();
keepAwake();
server.listen(config.port, config.host, () => {
  console.log(`term-hub on http://${config.host}:${config.port}${power.on ? '' : ' (turned off)'}`);
  console.log(`  agent: ${config.agent.type} — ${config.agent.command} ${config.agent.args.join(' ')} (in ${config.agent.cwd})`);
  if (config.allowedLogins.length) console.log(`  allowed Tailscale logins: ${config.allowedLogins.join(', ')}`);
});
