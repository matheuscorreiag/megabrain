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

- **Chats** — the sidebar keeps a stable order (newest created first). Every
  chat gets its own random **accent color** (fixed lightness/chroma in OKLCH,
  so any hue reads well on the dark UI). **Rename**: double-click a name in the
  sidebar, use its ⋯ menu, or click the title at the top.
- **Usage above the message box** (right side) — model, this chat's
  **context** and the account's **usage windows** (5h and 7d for Claude); tap
  any of them for token counts and reset times.
- **Shortcuts screen** (sidebar → Shortcuts, or ⌘/) — lists every shortcut
  and checks them live: press one and it gets a ✓ if it works in that window.
  On that screen keys are only checked, not run.

  | Keys | Action |
  | --- | --- |
  | ⌘1 … ⌘9 | open chat 1–9 |
  | ⌃⌘N | new chat |
  | ⌘B | show / hide the sidebar |
  | ⌘/ | Shortcuts screen |
  | Enter / ⇧Enter | send / new line |
  | Esc | stop the agent |

  Off macOS: Ctrl instead of ⌘, and Ctrl+Alt+N for a new chat. Install the app (Chrome: "Install"; Safari: "Add
  to Dock") so ⌘1…⌘9 aren't taken by browser tabs.
- Streaming Markdown, code blocks with "copy", tool calls as cards (Bash,
  Read, Edit with a diff, todo lists…).
- **Images** — the ones you attach (phone photos are downscaled first), the
  ones the agent reads with tools, and any image whose path it mentions. Tap
  to enlarge. Other attachments are saved to `~/.term-hub/media/` and their
  path goes into the message.

## Customize

| File | What |
| --- | --- |
| `public/loader.js` | the "Thinking… / Using Bash…" indicator (contract at the top) |
| `public/render.js` | how messages, tools (`TOOLS`) and images are drawn |
| `public/base.css` | shared by both pages: color tokens, sidebar, item rows, menus |
| `public/ui.js` | shared by both pages: sidebar, menus, inline rename, status dot, accents |
| `public/style.css` | chat page layout, thread, composer, loader animations |
| `public/app.js` | chat state, WebSocket, usage, shortcuts, composer |
| `public/terminal/*` | terminal page (tabs, Files panel, phone key strip) |
| `lib/chat.js` | processes, queue, persistence, item format, accent picking |
| `lib/agents/*.js` | one adapter per agent (contract at the top of `claude.js`) |

No build step: edit and reload the page (restart the server for `lib/`).

### Another agent

Create `lib/agents/<type>.js` exporting `{ name, spawnArgs, userMessage,
interruptMessage, createParser }` (and optionally `limitLabel`, `modelLabel`) —
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
| `agent.model` | `null` | model (`null` = the account default) |
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
```

On the phone: Tailscale app connected → open the URL → "Add to Home Screen".

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
| ⌃⌘N | new terminal (in the folder open in Files) |
| ⌘B | show / hide the sidebar |
| ⌘E | show / hide Files |

Off macOS they use Ctrl+Shift (Ctrl+Alt+N for a new terminal), since plain
Ctrl+B / Ctrl+E belong to the shell.
