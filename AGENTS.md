# AGENTS.md

Context for anyone (human or agent) changing this project. README.md covers
setup and usage; this file covers what the code is, how it fits together, the
decisions behind it and the traps already found.

## What this is

A personal, self-hosted web app that lets its owner use the **coding agent
running on their Mac** from a phone or any other device. All work (files,
commands, the office VPN, local network) happens on the Mac; other devices
only render the UI. It is reached over **Tailscale** (`tailscale serve`, tailnet
only) and runs as a **launchd** user agent.

Two pages, same look:

- `/` — **chat**: one agent process per chat, structured events (streaming
  text, tool calls, images, context and usage limits) rendered by our own UI.
- `/terminal/` — **terminals**: tmux-backed shells in the browser, plus a
  Files panel. "Back to chats" returns to `/`.

The agent today is **Claude Code** (`claude -p` in stream-json mode, using the
owner's subscription — no API key, no Agent SDK). The UI must stay
**agent-agnostic**: anything Claude-specific lives in `lib/agents/claude.js`.

## Product rules (from the owner)

- **No names or branding in the UI.** No product name, no "Claude", no logo
  text. Tab titles are the chat/terminal title, the page is "New chat",
  "Shortcuts" or "Terminal".
- **English UI**, everywhere (server error messages too). The owner talks to
  agents in Portuguese; the app itself is English.
- **Always dark.** Only the hue changes: each chat (and terminal) has its own
  hue; the accent is `oklch(0.78 0.14 <hue>)` and every surface, line and text
  color in `base.css` is derived from the same `--h` at a fixed low chroma, so
  the page is faintly tinted and any hue reads well. `setHue()` (ui.js) sets it.
- **Agent-agnostic** UI and chat engine (see Architecture).
- **Tailscale stays** as the network layer. Exposing the app publicly with a
  homemade token was discussed and rejected: the agent runs with
  `--dangerously-skip-permissions` on a machine inside the office network.
- Minimal chrome: no header bar. The sidebar toggle sits inside the sidebar
  when open and floats top-left when closed; the connection status is just a
  dot next to it. The open chat's title, model and usage live in a status line
  under the composer.
- Look: Instrument Sans for text, Martian Mono for labels, code and readouts
  (self-hosted in `public/fonts/`); small radii, hairlines, a faint grain. The
  thread is a log — numbered prompts, the reply on a rail with tool calls as
  nodes — not chat bubbles.

## Architecture

```
browser ──HTTPS──► tailscale serve ──► server.js (127.0.0.1:7680)
                                         ├─ /ws/chat      lib/chat.js ──► agent process per chat (lib/agents/<type>.js)
                                         ├─ /ws/tabs/<id> lib/terminal.js ──► node-pty ⇄ tmux -L term-hub
                                         ├─ /api/*        REST (chats, uploads, local images, tabs, files)
                                         └─ static        public/ (no build step)
```

| Path | Role |
| --- | --- |
| `server.js` | HTTP + WebSocket wiring, access checks, static files |
| `lib/config.js` | `config.json` loading/defaults, shared helpers (auth, origin check, env cleaning) |
| `lib/chat.js` | chats: processes, queue, interrupt, persistence, broadcast, uploads/media, accent hues |
| `lib/agents/claude.js` | **the only Claude-specific code**: CLI args, message encoding, interrupt, event parsing, labels |
| `lib/agents/index.js` | adapter registry by `agent.type` |
| `lib/terminal.js` | tmux tabs + file API (list/read/write/mkdir/rename/trash) + PTY WebSocket |
| `public/base.css`, `public/ui.js` | **shared by both pages**: fonts, tokens, sidebar, item rows, menus, inline rename, status dot, page tint (`setHue`), accents, `api()`, `h()` |
| `public/index.html`, `app.js`, `style.css` | chat page (state, WebSocket, usage, shortcuts screen, composer) |
| `public/render.js` | chat items → DOM (markdown, tool cards via `TOOLS`, images, streaming drafts) |
| `public/loader.js` | the "working" indicator (small, swappable contract) |
| `public/terminal/*` | terminal page |
| `bin/hub` | open the same tmux tabs over SSH |
| `scripts/launchd.sh` | install / restart / uninstall the launchd agent |

### Chat engine

- One long-lived agent process per chat, JSON lines over stdin/stdout. Stopped
  after `agent.idleMinutes`; the next message respawns it with `--resume
  <sessionId>` (also works after restarts).
- The adapter's parser turns raw agent events into **neutral events**
  (`session`, `draft-start`, `draft-delta`, `block`, `tool-result`, `context`,
  `limits`, `result`, `notice` — documented at the top of `claude.js`).
  `chat.js` turns those into **items** appended to
  `~/.term-hub/chats/<id>/events.jsonl` and broadcast to every socket watching
  the chat. Live-only events (drafts) are not persisted.
- Messages sent while a turn runs go to an in-memory **queue**; one socket's
  messages are processed in order (so "stop" can't overtake "send").
- Per chat meta (`meta.json`): title, hue, sessionId, model, modelLabel,
  context `{ used, window }`, settings `{ model, effort }` (null = default),
  doneAt / readAt. Account-wide usage windows: `~/.term-hub/limits.json`.
- **Model / effort**: the chat's settings become the adapter's `--model` /
  `--effort` when its process spawns. A process keeps its flags, so changing
  them retires it (`retire()`: detach, then end stdin) — at once if idle, at
  the end of the turn otherwise — and the next message resumes the session
  with the new ones. Until the new process reports its model, `modelLabel` is
  the choice's label.
- **Unread**: `unread = doneAt > readAt`, where doneAt is set when a turn ends.
  It's read when a socket that has the chat open is visible (the page sends
  `{ op: 'visibility' }` on connect and on visibilitychange) — at turn end,
  on `open`, or when the page becomes visible. Shared by every device.
- Images from tool results are saved content-addressed in `~/.term-hub/media/`;
  uploads go there too. Attachments are passed to the agent as image blocks
  (png/jpeg/gif/webp) and always also by path.

### Adding another agent

Create `lib/agents/<type>.js` exporting `{ name, spawnArgs, userMessage,
interruptMessage, createParser }` (optionally `limitLabel`, `modelLabel`, and
`models` `[{ id, label, note, effort: false? }]` / `efforts` for the per-chat
picker; the UI shows whatever the adapter offers, nothing if it offers none),
register it in `lib/agents/index.js`, set `agent.type` in `config.json`.
Known limitation: `chat.js` assumes a **persistent process speaking JSON lines**.
A one-shot CLI (e.g. `codex exec`) or an HTTP API needs the transport moved into
the adapter (e.g. `start(session)` returning `send/interrupt/stop`). Tool cards
in `render.js` (`TOOLS`) know Claude Code's tool names; unknown tools fall back
to a generic card.

### Terminals

- Each tab is a tmux session `hub-<8 hex>` on the dedicated socket
  `tmux -L term-hub` (config: `tmux.conf`), running a login shell. Tabs survive
  browser disconnects and can be attached from several devices (`window-size
  latest`).
- Titles: user-set `@hub_title` wins, else the program's terminal title, else
  the folder name. Tab accent hue is derived from the id (no stored color).
- The Files API is confined to `config.root` (symlinks resolved); "delete" moves
  to the macOS Trash.

## Conventions

- Node ≥ 20, ESM, **no build step, no framework**: vanilla JS modules served
  as-is; vendor libs (xterm, marked, DOMPurify) are mapped from `node_modules`
  in `server.js`.
- Prettier-like style: 2 spaces, single quotes, semicolons, ~150 cols. Comments
  explain *why*, sparingly, in the file's existing voice.
- Anything both pages need goes in `base.css` / `ui.js`, not copied.
- Sidebar items are rendered **in place, keyed by id** (rebuilding them breaks
  double-click rename and focus). Hold re-renders while an inline rename is
  open.
- Shortcuts are one table per page (chat: `SHORTCUTS` in `app.js`, also drives
  the Shortcuts screen). Chat: ⌘1–9, ⌃⌘N, ⌘B, ⌘J, ⌘K, ⌘/. Terminal: ⌘1–9, ⌃⌘N, ⌘B,
  ⌘E — off macOS the terminal page uses Ctrl+Shift because plain Ctrl+B/E
  belong to the shell. ⌘N/⌘T/⌘W never reach a page in a Chrome tab (reserved),
  only in the installed app's window (Chrome reserves no keys for apps): ⌘N is
  "new chat / new terminal" there, and ⌃⌘N stays as the fallback that works in
  tabs. Don't rely on ⌘T/⌘W.

## Security model

- Server binds `127.0.0.1` only; remote access only via `tailscale serve`.
  Never `tailscale funnel` or `host: 0.0.0.0`.
- `config.allowedLogins` checks the `Tailscale-User-Login` header that
  `tailscale serve` injects.
- Cross-site protection: `Origin`/`Sec-Fetch-Site` checks on API and WebSocket
  upgrades, plus a required `X-Hub: 1` header on every write.
- Media and `/api/local-image` (images under `$HOME` only) are served with a
  sandboxing CSP and `nosniff`.
- `config.json` (has the owner's Tailscale login) is gitignored — never commit
  it. Don't put the tailnet hostname/URL in tracked files.

## Run, test, deploy

```bash
npm install                       # postinstall fixes node-pty's spawn-helper permissions
npm start                         # uses config.json (port 7680)
```

**Test against an isolated server, not production.** Use a separate config
with a cheap model and a scratch data dir:

```json
{ "port": 7681, "dataDir": "/tmp/hubtest/data", "agent": { "type": "claude", "model": "haiku", "idleMinutes": 1 } }
```

```bash
HUB_CONFIG=/path/to/test-config.json node server.js
```

- Drive the UI with headless Chrome over CDP (`--remote-debugging-port`,
  temporary `--user-data-dir`) and check behavior with real input events
  (`Input.dispatchKeyEvent`/`dispatchMouseEvent`), plus screenshots at desktop
  and 390×844 phone size (emulation resets when the CDP connection closes —
  emulate, measure and screenshot in one session).
- **The tmux socket is shared** between the test and production servers. The
  owner may have terminals open: only touch tabs you created, and close them
  afterwards.

**Deploy:**

- Files under `public/` are read from disk on every request — front-end changes
  are live on reload, no restart needed.
- Server changes (`server.js`, `lib/`) need `scripts/launchd.sh restart`. A
  restart kills running agent processes: **first check that no chat is running**
  (`curl -s http://127.0.0.1:7680/api/chats` → every `status` is `idle`).
- Logs: `~/Library/Logs/term-hub.log`.

## Gotchas already hit

- **tmux targets**: use `=name` for session commands and `=name:` for pane
  commands (`set-option`, `send-keys`, `paste-buffer`); the bare `=name` form
  fails there.
- **Claude stream-json**: one `assistant` event per finished content block
  (same message id), in stream order — block index = count per message id.
  Interrupt = `control_request` `{ subtype: 'interrupt' }`. Context = last
  main-agent `message_delta` usage (input + cache + output); window from
  `result.modelUsage[model].contextWindow` (1M for `[1m]` models). Usage limits
  come from `rate_limit_event.rate_limit_info.unifiedWindows` (`five_hour`,
  `seven_day`; utilization is 0–1).
- **Streaming drafts**: a block's last delta and its final version can land in
  the same frame, before the draft is painted (`draft.el` is null) — guard
  with optional chaining. Ignore drafts whose final block is already shown.
- **CSS `[hidden]`**: author `display` rules beat the `hidden` attribute; base
  CSS forces `[hidden] { display: none !important }`.
- **Pseudo-element sizing**: `* { box-sizing: border-box }` doesn't match
  `::before`/`::after`; give bordered pseudo-elements their own `box-sizing`
  or their borders shift anything centered by formula (the rail nodes).
- **Grid overflow**: long unbreakable titles widen `1fr` columns — use
  `minmax(0, 1fr)`.
- **xterm.js colors** must be sRGB; convert `oklch()` through a canvas.
- **Keyboard capture over xterm**: page shortcuts listen on `document` in the
  capture phase and `stopPropagation()` so the terminal never sees them.
- Launched from inside another terminal/agent, child processes inherit
  `CLAUDE*`/`CMUX*`/`TMUX*` env vars — `cleanEnv()` strips them.
- The launchd plist bakes in the current `node` path (nvm); re-run
  `scripts/launchd.sh install` after switching Node versions.

## Data and persistence

- `~/.term-hub/chats/<id>/{meta.json,events.jsonl}`, `~/.term-hub/media/`,
  `~/.term-hub/limits.json`. The agent's own transcripts (used by `--resume`)
  live in `~/.claude/`.
- Survives connection drops and restarts. Lost on a hard shutdown mid-turn:
  the block being streamed and the in-memory queue. Ideas not done yet:
  persist the queue, mark turns cut by a restart, checkpoint in-progress text.

## Working with the owner

- Communicate in Portuguese; keep the app and code in English.
- Commit and push only when asked; the repo is private
  (`github.com/matheuscorreiag/term-hub`).
- Verify UI changes in a real browser (desktop and phone sizes) before saying
  they work, and say what wasn't verified.
