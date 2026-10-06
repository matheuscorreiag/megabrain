// On / off for the whole panel (the sidebar's Turn off, the Turned off
// screen's Turn on). Off: agents and terminal views are stopped, every device
// gets the "Turned off" screen, and the Mac may idle-sleep again — the
// caffeinate assertion only exists while on. The process itself stays up
// (idle, it costs nothing) so a browser on this Mac can turn it back on; a
// stopped server couldn't be reached to do that. A marker file in the data
// dir keeps it off across restarts and logins.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, expandHome } from './config.js';

const MARKER = path.join(expandHome(config.dataDir), 'off');
let caffeinate = null;

export const power = { on: !fs.existsSync(MARKER) };

export function setPower(on) {
  power.on = on;
  if (on) fs.rmSync(MARKER, { force: true });
  else fs.writeFileSync(MARKER, `${new Date().toISOString()}\n`);
  keepAwake();
}

// -w: the assertion also ends with this process, however it ends.
export function keepAwake() {
  if (power.on && !caffeinate) {
    const proc = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    proc.on('error', (err) => console.error('caffeinate:', err.message));
    proc.on('exit', () => caffeinate === proc && (caffeinate = null));
    caffeinate = proc;
  } else if (!power.on && caffeinate) {
    caffeinate.kill();
    caffeinate = null;
  }
}
