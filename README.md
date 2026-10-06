# Term Hub

A chat UI of your own for the **coding agent running on this Mac**, reachable
from your phone or any device on your tailnet. The work happens here — files,
commands, the office VPN, the local network. The UI doesn't care which agent
is behind it; today the available adapter is Claude Code (`claude -p` in
headless mode, using your subscription).

```
phone / laptop ──(Tailscale, HTTPS)──► tailscale serve ──► term-hub :7680 (localhost only)
      ▲                                                        │
      └──────────── WebSocket /ws/chat (live events) ──────────┤
                                                               ├─ chat A → agent process ─┐
                                                               ├─ chat B → agent process  ├─ lib/agents/<type>.js
                                                               └─ ~/.term-hub/chats/<id>/  ┘
```

## How it works

- Each chat has its own agent process running in `agent.cwd` (default `~`). An
  **adapter** (`lib/agents/`) turns the agent's protocol into neutral events —
  streamed text, blocks, tool calls and results, images, context and usage
  limits. The rest of the app only knows those events.
- The server appends them to `~/.term-hub/chats/<id>/events.jsonl` and
  broadcasts them over a WebSocket to every device that has the chat open.
  Start on the laptop, carry on from the phone.
- The process stays alive between messages; after `idleMinutes` without use it
  stops, and the next message resumes the session — also after restarting the
  server or the Mac.
- A message sent while the agent is still working is **queued** (and can be
  removed). **Stop**: the ■ button or Esc.

## In the UI

- **Chats** — the sidebar keeps a stable, numbered order (newest created
  first; the number is the ⌘ shortcut). Every chat gets its own random
  **color**: the accent at a fixed OKLCH lightness/chroma, and the whole page
  faintly tinted with the same hue, so any of them reads well on the dark UI.
  **Rename**: double-click a name in the sidebar or use its ⋯ menu.
  **Width**: drag the sidebar's right edge (double-click it for the default);
  both pages share it.
- **Status line under the message box** — this chat (number and title), the
  model, this chat's **context** and the account's **usage windows** (5h and
  7d for Claude) as progress bars; tap any of them for token counts and
  reset times.
- **Model and effort per chat** — tap the model in the status line: Default /
  Fable / Opus / Sonnet / Haiku and an effort level (low … max; Haiku has
  none). Changes apply from the next message: the agent process restarts and
  resumes the session with the new flags (after the current turn, if one is
  running). On a new chat the pick goes with the first message and is
  remembered on that device for the next new chats.
- **New replies** — a chat whose turn ended while no device had it open (and
  visible) is marked unread: a dot and "replied …" in the sidebar, a count on
  the sidebar button and in the tab title, the installed app's badge, a count
  on "Back to chats" in the terminal page, and a notice with the start of the
  reply that stays 30 s (paused while hovered or while the page is in the
  background) — tap it or press ⌘J to open the chat.
  Opening the chat marks it read on every device.
- **Turn off / Turn on** (only in a browser on the Mac itself: the sidebar's
  Turn off, the "Turned off" screen's Turn on) — off, the Mac can idle-sleep
  again, running chats stop, and every device gets the "Turned off" screen;
  terminals stay open in tmux. It stays off across restarts and logins until
  turned on. The server process keeps running while off (idle), so the button
  can turn it back on.
- **Settings** (the gear next to the status dot) — the address to open the
  panel on another device (Chrome on Windows, a phone…), with Copy: the
  `tailscale serve` URL, plus this Mac's Tailscale name and IPs. The server
  only answers through that HTTPS name, never on a LAN IP; if it isn't shared
  yet, it shows the `tailscale serve` command to run.
- **Shortcuts screen** (sidebar → Shortcuts, or ⌘/) — lists every shortcut
  and its keys.

  | Keys | Action |
  | --- | --- |
  | ⌘1 … ⌘9 | open chat 1–9 |
  | ⌘N (installed app) or ⌃⌘N | new chat |
  | ⌘B | show / hide the sidebar |
  | ⌘J | open the latest reply (the notice's chat, or the newest unread) |
  | ⌘K | go to the message box |
  | ⌘/ | Shortcuts screen |
  | Enter / ⇧Enter | send / new line |
  | Esc | stop the agent |

  Off macOS: Ctrl instead of ⌘, and Ctrl+Alt+N for a new chat. Install the app (Chrome: "Install"; Safari: "Add
  to Dock") so ⌘1…⌘9 aren't taken by browser tabs — and so ⌘N opens a new chat
  instead of a browser window (in a Chrome tab the browser keeps ⌘N).
- The thread reads like a log: numbered, timestamped prompts, and the reply
  hanging from each on a rail where tool calls (Bash, Read, Edit with a diff,
  todo lists…) are one-line entries that open on click. Streaming Markdown,
  code blocks with "copy".
- **Images** — the ones you attach (phone photos are downscaled first), the
  ones the agent reads with tools, and any image whose path it mentions. Tap
  to enlarge. Other attachments are saved to `~/.term-hub/media/` and their
  path goes into the message.

## Customize

| File | What |
| --- | --- |
| `public/loader.js` | the "Thinking… / Using Bash…" indicator (contract at the top) |
| `public/render.js` | how messages, tools (`TOOLS`) and images are drawn |
| `public/base.css` | shared by both pages: fonts, color tokens (all derived from the hue `--h`), sidebar, item rows, menus |
| `public/fonts/` | Instrument Sans and Martian Mono (OFL, licenses alongside) |
| `public/ui.js` | shared by both pages: sidebar, menus, inline rename, status dot, page tint and accents |
| `public/style.css` | chat page layout, thread rail, composer, status line, loader animations |
| `public/app.js` | chat state, WebSocket, usage, shortcuts, composer |
| `public/terminal/*` | terminal page (tabs, Files panel, phone key strip) |
| `lib/chat.js` | processes, queue, persistence, item format, accent picking |
| `lib/agents/*.js` | one adapter per agent (contract at the top of `claude.js`) |

No build step: edit and reload the page (restart the server for `lib/`).

### Another agent

Create `lib/agents/<type>.js` exporting `{ name, spawnArgs, userMessage,
interruptMessage, createParser }` (and optionally `limitLabel`, `modelLabel`,
and the per-chat choices `models` / `efforts`) —
see the neutral events at the top of `claude.js` — register it in
`lib/agents/index.js` and set `agent.type` in `config.json`.

## Configuration (`config.json`, server only)

| Key | Default | What it does |
| --- | --- | --- |
| `port` / `host` | `7680` / `127.0.0.1` | where the server listens (keep localhost) |
| `allowedLogins` | `[]` | Tailscale logins allowed in (recommended) |
| `dataDir` | `~/.term-hub` | chats, media and the last known usage limits |
| `agent.type` | `claude` | adapter in `lib/agents/` |
| `agent.command` | `claude` | the agent's binary |
| `agent.cwd` | `~` | folder the agent runs in |
| `agent.args` | `["--dangerously-skip-permissions"]` | extra arguments |
| `agent.model` | `null` | model for chats left on "Default" (`null` = the account default) |
| `agent.effort` | `null` | effort for chats left on "Default" (`null` = the agent's default) |
| `agent.idleMinutes` | `30` | stop idle processes (sessions resume later) |
| `agent.appendSystemPrompt` | (text about the UI) | extra instructions; `""` turns it off |
| `root`, `workdir`, `shell` | | used by the terminal part |

Changed it? `scripts/launchd.sh restart`.

## Run / publish

```bash
npm install
cp config.example.json config.json    # then adjust
npm start                             # http://127.0.0.1:7680

scripts/launchd.sh install            # always on (login, restarts, no idle sleep)
tailscale serve --bg 7680             # https://<mac>.<tailnet>.ts.net, tailnet only

scripts/launchd.sh stop               # stop the process entirely, until start
scripts/launchd.sh start              # start it again
```

While it's on, the Mac doesn't idle-sleep (closing the lid still sleeps it);
Turn off in the sidebar lifts that without stopping the process.

On the phone: Tailscale app connected → open the URL → "Add to Home Screen".

## macOS app (`macos/`)

A small native app (Swift: AppKit + WebKit) around the same UI, for everyday
use on a Mac — the browser stays for everything else (phone, Windows…):

- **Every ⌘ shortcut** — ⌘N, ⌘W, ⌘1…⌘9, all of them; no browser keeps any.
  They're in the menus too (File, View, Go).
- **Notifications** when a chat replies while the app isn't in front, and the
  unread count on the **Dock icon** — also with the window closed (closing
  only hides it; the app stays in the menu bar). Click one to open the chat.
- **Menu-bar item**: whether the server is on; on the server's own Mac, Turn On
  / Turn Off, and Start Server if the process isn't running at all.
- **Settings** (⌘,): This Mac, or Another Mac by its Tailscale URL; open at login.

**Download** it from the repo's [Releases](../../releases) (`Hub-macOS-<version>.zip`,
Apple silicon and Intel, macOS 14+), or build it:

```bash
macos/build.sh                        # builds and installs /Applications/Hub.app (Xcode or its Command Line Tools)
macos/release.sh                      # publishes macos/VERSION as a GitHub release (commit and push first)
```

It's signed ad hoc (no Apple developer account), so a downloaded copy is
blocked the first time: System Settings → Privacy & Security → Open Anyway.

**Another Mac** connects as a client — everything still runs on the server's
Mac. Sign it into Tailscale with a login in `allowedLogins`, open the app
(it sees there's no server on that Mac and offers **Connect to Another
Mac…**), and enter `https://<mac>.<tailnet>.ts.net`. Turn On / Off only show
on the server's Mac.

## Security

- With `--dangerously-skip-permissions` the agent runs any command without
  asking. Malicious content it reads (websites, files) may try to talk it into
  running something. Keep `allowedLogins` set and never expose this outside the
  tailnet (`tailscale funnel`, `host: 0.0.0.0`).
- Listens on `127.0.0.1` only; cross-site requests are refused
  (`Origin`/`Sec-Fetch-Site` checks plus an `X-Hub` header on writes and
  WebSockets).
- Media and local images are served with a strict CSP; `/api/local-image` only
  returns image files inside your home folder.

## Terminal (at `/terminal/`)

Same layout as the chat page: tmux-backed terminals listed in the sidebar
(each with its own accent), a **Files** panel on the right (browse, edit,
upload, download, rename, move to Trash, type a path into the terminal) and
**Back to chats** to return to the main view. Terminals keep running when the
browser closes and can be opened from several devices at once; `bin/hub`
opens the same ones over SSH (`hub`, `hub 2`, `hub new`).

| Keys | Action |
| --- | --- |
| ⌘1 … ⌘9 | switch terminal |
| ⌘N (installed app) or ⌃⌘N | new terminal (in the folder open in Files) |
| ⌘B | show / hide the sidebar |
| ⌘E | show / hide Files |

Off macOS they use Ctrl+Shift (Ctrl+Alt+N for a new terminal), since plain
Ctrl+B / Ctrl+E belong to the shell.
