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
  dot next to it. The agent's folder, model and usage live in a status line
  under the composer — not the chat's name (the owner dropped it; the sidebar
  shows which chat is open).
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
| `lib/config.js` | `config.json` loading/defaults, shared helpers (auth, origin check, this-Mac check, env cleaning) |
| `lib/power.js` | on / off: the keep-awake assertion (`caffeinate -i -w <pid>`) and the `off` marker |
| `lib/network.js` | `GET /api/network` for the sidebar's Share button: the `tailscale serve` URL that proxies to our port, the tailnet name and IPs (tailscale CLI, cached 15 s) |
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
| `scripts/launchd.sh` | install / start / stop / restart / uninstall the launchd agent |
| `macos/` | the macOS app (Swift package, `build.sh`); see below |

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
  cwd (the agent's folder now; Claude: the last `cwd` stamp in its own
  session log, `~/.claude/projects/*/<sessionId>.jsonl` — the stream only
  reports the starting one), pinned (its place in Pinned, from 1; absent =
  not pinned), doneAt / readAt. Account-wide usage windows: `~/.term-hub/limits.json`.
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
interruptMessage, createParser }` (optionally `limitLabel`, `modelLabel`,
`models` `[{ id, label, note, effort: false? }]` / `efforts` for the per-chat
picker — the UI shows whatever the adapter offers, nothing if it offers none —
and `currentDir(sessionId)`, where the agent works now: the status line's
folder, refreshed after tool results and turns into meta `cwd`),
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
- Pinned: the session option `@hub_pinned` (its place, from 1 — tmux's `#{?}`
  reads 0 as false). `bin/hub` lists in the same order as the sidebar.
- The Files API is confined to `config.root` (symlinks resolved); "delete" moves
  to the macOS Trash.

### macOS app

- `macos/` builds `Hub.app` (`macos/build.sh`; SwiftPM, no Xcode project). It
  is a client like a browser: a WKWebView on the panel's URL (This Mac =
  `http://127.0.0.1:7680`, or another Mac's Tailscale URL), so the UI stays one
  codebase. Native code only adds what a tab can't do. The bundle has to be
  called something ("Hub"); the UI inside still shows no name. The title bar
  shows no title (`titleVisibility = .hidden`) — the chat and its folder are
  in the status line; the window's title stays the app's name, never the open
  chat's, for the Window menu and Mission Control. Its icon is
  `macos/AppIcon.svg` (drawn on Apple's 1024 grid: two bars and the cyan hub
  between them); the menu-bar glyph is the same mark drawn in code
  (`StatusMenu.glyph()`). The web favicon (`public/icon.svg`) is separate.
- The page knows it's inside through the `hub` message handler (`native` in
  ui.js: standalone-style ⌘N hints, and it posts `{ op: 'power', on }`). The
  app's own pages ("Not running") post `start` / `retry`.
- **Shortcuts**: the page gets ⌘-keys first (WKWebView hands key equivalents to
  the focused page before the menus); every page shortcut also has a menu item
  that dispatches the same keydown into the page, so the page's tables stay
  the source of truth. Add new page shortcuts to `mainMenu()` too.
- **Notifications / badge** come from the app's own `/ws/chat` socket (the
  same `chats` broadcast), not the page, so they work on the terminal page and
  with the window closed. That socket never sends `visibility`, so it never
  marks a chat read. In front, the page's notice covers it (no banner).
- Closing the window hides it; external links and `target=_blank` open in the
  default browser; confirm/prompt/file inputs/downloads get native panels.
- **Test**: `macos/build.sh --debug` builds `Hub-debug.app` (own bundle id) with
  `SelfTest.swift`; run `macos/.build/Hub-debug.app/Contents/MacOS/Hub -selfTest
  <dir> -localPort 7681` against a test server. It sends real ⌘-key events
  through AppKit, flips the power switch, goes through the native confirm and
  writes `results.txt` plus snapshots (screen capture isn't available to an
  agent, the web view's snapshot is). It refuses port 7680. A window and a
  menu-bar icon appear while it runs. `-launchdLabel com.example.none` plays a
  Mac without a server (the "Connect to Another Mac…" page).
- **Releases**: bump `macos/VERSION`, commit and push, then `macos/release.sh`
  builds a universal (arm64 + x86_64) `Hub.app`, zips it with `ditto` (keeps the
  bundle and signature) and creates the GitHub release `macos-v<VERSION>` with
  the zip. Ad hoc signed: downloads need "Open Anyway" once; notarizing would
  need a paid Apple developer account.

## Conventions

- Node ≥ 20, ESM, **no build step, no framework**: vanilla JS modules served
  as-is; vendor libs (xterm, marked, DOMPurify) are mapped from `node_modules`
  in `server.js`.
- Prettier-like style: 2 spaces, single quotes, semicolons, ~150 cols. Comments
  explain *why*, sparingly, in the file's existing voice.
- Anything both pages need goes in `base.css` / `ui.js`, not copied.
- Sidebar items are rendered **in place, keyed by id** (rebuilding them breaks
  double-click rename and focus). Hold re-renders while an inline rename is
  open, and while an item is being dragged (`pinning.dragging`).
- **Pinned** (both pages): `setupPinning()` in ui.js builds the section above
  the page's list and does the dragging — pointer events, not HTML5 drag and
  drop (which phones don't do); a mouse drags past 5px, a finger after holding
  still for 450ms, so a swipe still scrolls. The page renders pinned items
  into `pinning.nav` and gets `onDrop(id, index | null)`; it sends the whole
  pinned order (`PUT /api/chats/pinned` / `/api/tabs/pinned` `{ ids }`) and
  applies it locally at once. Lists come sorted from the server — pinned
  first, by place — so ⌘1–9 and the numbers count pinned items first.
- Confirmations and one-line prompts use `ask()` (ui.js), not `confirm()` /
  `prompt()`: the app's look, Enter / Esc / click outside, focus kept inside,
  page ⌘-shortcuts held while it's open. Delete chat (⇧⌘D and the ⋯ menu) and
  rename (⇧⌘E) use it; older `confirm()` calls (terminal page, Turn off) can
  move to it.
- Recent messages (↑ / ↓ / Tab in an empty message box, app.js `remember` /
  `suggest`) come from the open chat's `user` items — history plus live
  items — so nothing extra is stored; the suggestion is the textarea's
  placeholder, never its value.
- The sidebar's width is `--side-w` (base.css). Dragging its right edge
  (`setupResize()` in ui.js, desktop only) overrides it on `<html>`, clamped to
  200–520px, and saves it in localStorage `ui:sidebarWidth` for both pages.
  Size sidebar content against `--side-w`, never a fixed 272px.
- Shortcuts are one table per page (chat: `SHORTCUTS` in `app.js`, also drives
  the Shortcuts screen). Chat: ⌘1–9, ⌘B, ⌘J, ⌘K, ⌘/, ⇧⌘E rename, ⇧⌘D delete
  (not ⌘⌫, the Mac's usual delete: in the message box it erases the line;
  not ⇧⌘R, the browser's hard reload), ⇧⌘P pin / unpin (also on the
  terminal page). Terminal: ⌘1–9, ⌘B, ⌘E
  — off macOS the terminal page uses Ctrl+Shift because plain Ctrl+B/E belong
  to the shell. Both: N = new chat / terminal, T = chats ↔ terminal, via
  `appKey()` / `isAppKey()` in ui.js: plain ⌘N / ⌘T in the macOS app or an
  installed app window (`standalone`), ⇧⌘N / ⇧⌘T in a browser
  (Ctrl+Shift+N / T off macOS); either form matches. The owner chose these over
  ⌃⌘ — no Control or Option combos. Caveat: a plain Chrome tab keeps ⌘N/⌘T/⌘W
  and ⇧⌘N/⇧⌘T/⇧⌘W (new window/tab, incognito, reopen tab) and pages can't
  take them; only app windows get them. In the macOS app ⌘W closes (hides) the
  window.

## Security model

- Server binds `127.0.0.1` only; remote access only via `tailscale serve`.
  Never `tailscale funnel` or `host: 0.0.0.0`.
- `config.allowedLogins` checks the `Tailscale-User-Login` header that
  `tailscale serve` injects.
- **Turn off / on** (`POST /api/turn-off`, `/api/turn-on`) only work from a
  browser on the Mac itself, and the buttons only show there (`thisMac` in
  `/api/config`): `fromThisMac()` compares the client address — `X-Forwarded-For`, which
  `tailscale serve` overwrites with the client's tailnet IP, or the peer for
  direct localhost requests — with this machine's own interface addresses.
- The Share popover (the button next to the status dot, `setupShare()` in
  ui.js, both pages) shows the tailnet name, IPs and serve URL, computed at
  runtime — they still never go in tracked files. It flags Tailscale Funnel
  if it's on.
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
- **On / off** is a state of the running server, not of the process: a page
  can't start a stopped server, so off keeps the process up (idle) and only
  drops the keep-awake assertion, stops agents and closes every socket. While
  off, the API (except `/api/config` and the switches), media and WebSockets
  answer 503; static files still load, and the pages show the "Turned off"
  screen (the terminal page sends you to it). The server holds the assertion
  itself (`lib/power.js`), so the launchd plist runs plain `node` — re-run
  `scripts/launchd.sh install` if an old plist still wraps it in `caffeinate`.
- `scripts/launchd.sh stop` / `start` stop the process entirely (disable +
  bootout, so neither KeepAlive nor the next login restarts it).
  `HUB_LABEL=<other label>` makes the script manage another job with its own
  plist and log — test launchd changes that way, with a config on another port.

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
- **iPhone Home Screen app** (`navigator.standalone`, black-translucent status
  bar): the page starts under the status bar but iOS makes it only
  `innerHeight` tall — that bar's height (47pt) short of the screen's bottom.
  The band below is not the page's: nothing can be painted there (a "fill the
  screen" attempt just cut the footer off). The home bar sits in that band, so
  `syncHeight()` (ui.js) sets `html.no-home-bar` (`--safe-bottom: 0`) then, as
  it does while the keyboard covers the home bar. The page is always exactly
  the visual viewport: `body` is `position: fixed` at `--app-top` (the
  viewport's `offsetTop` — iOS pans it to the focused field) with `--app-h`;
  `html` stays `100%`, since anything taller than the browser's viewport makes
  the page scrollable. Anything floating above the message box (`#jump`) is
  anchored to `#composer-wrap`, not a fixed `bottom`. `classList.toggle(x,
  undefined)` flips the class — pass real booleans (`navigator.standalone` is
  undefined off iOS). A different `apple-mobile-web-app-status-bar-style`
  (e.g. `black`) might make iOS size the page to the bottom; untried.
- **xterm.js colors** must be sRGB; convert `oklch()` through a canvas.
- **Keyboard capture over xterm**: page shortcuts listen on `document` in the
  capture phase and `stopPropagation()` so the terminal never sees them.
- Launched from inside another terminal/agent, child processes inherit
  `CLAUDE*`/`CMUX*`/`TMUX*` env vars — `cleanEnv()` strips them.
- The launchd plist bakes in the current `node` path (nvm); re-run
  `scripts/launchd.sh install` after switching Node versions.
- **WKWebView**: `evaluateJavaScript` doesn't await promises (use
  `callAsyncJavaScript`); WebKit refuses some ports outright (e.g. 9), so test
  "unreachable" with a closed ordinary port; `innerText` follows CSS
  `text-transform`. Delegate methods must match the SDK's signatures exactly
  (`@MainActor @Sendable` handlers) or AppKit never calls them — a clean build
  must show no "nearly matches" warnings.
- **Typing is never rewritten** (prompts are code and commands): the message
  box (and the Files editor) carry `autocorrect="off" autocapitalize="off"
  spellcheck="false" writingsuggestions="false"`, and the macOS app registers
  `WebAutomatic{SpellingCorrection,QuoteSubstitution,DashSubstitution,
  TextReplacement}Enabled = false` (main.swift) plus `allowsInlinePredictions
  = false` — otherwise WebKit turns `"x" --y` into `“x” —y`. Each layer alone
  stops it (verified: the self-test types real keystrokes).

## Data and persistence

- `~/.term-hub/chats/<id>/{meta.json,events.jsonl}`, `~/.term-hub/media/`,
  `~/.term-hub/limits.json`, `~/.term-hub/off` (present while turned off). The
  agent's own transcripts (used by `--resume`) live in `~/.claude/`.
- Survives connection drops and restarts. Lost on a hard shutdown mid-turn:
  the block being streamed and the in-memory queue. Ideas not done yet:
  persist the queue, mark turns cut by a restart, checkpoint in-progress text.

## Working with the owner

- Communicate in Portuguese; keep the app and code in English.
- Commit and push only when asked; the repo is private
  (`github.com/matheuscorreiag/term-hub`).
- Verify UI changes in a real browser (desktop and phone sizes) before saying
  they work, and say what wasn't verified.
