// How other devices reach this server (the sidebar's Settings): the
// `tailscale serve` address that proxies to our port — what to open in Chrome
// on Windows, a phone… — plus this Mac's tailnet name and IPs. The server
// only listens on localhost, so a LAN address would get nothing, on purpose.
// Read from the tailscale CLI, cached briefly.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, findBin } from './config.js';

const run = promisify(execFile);
const BIN = findBin('tailscale') || '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
let cache = null;

async function tailscale(...args) {
  try {
    const { stdout } = await run(BIN, [...args, '--json'], { timeout: 4000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// `tailscale serve --bg 7680` stores "http://127.0.0.1:7680".
function proxiesHere(target = '') {
  try {
    const url = new URL(/^\d+$/.test(target) ? `http://127.0.0.1:${target}` : target);
    return Number(url.port) === config.port && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export async function networkInfo() {
  if (cache && Date.now() - cache.at < 15_000) return cache.info;
  const [status, serve] = await Promise.all([tailscale('status'), tailscale('serve', 'status')]);
  const self = status?.Self;
  const info = {
    tailscale: Boolean(self),
    online: Boolean(self?.Online),
    name: self?.DNSName?.replace(/\.$/, '') || null,
    ips: self?.TailscaleIPs || [],
    urls: Object.entries(serve?.Web || {})
      .filter(([, web]) => Object.values(web.Handlers || {}).some((handler) => proxiesHere(handler.Proxy)))
      .map(([host]) => `https://${host.replace(/:443$/, '')}`),
    funnel: Object.values(serve?.AllowFunnel || {}).some(Boolean), // public on the internet: never meant to be
    port: config.port,
  };
  cache = { at: Date.now(), info };
  return info;
}
