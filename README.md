# pi-inspect

[![npm version](https://img.shields.io/npm/v/pi-inspect.svg)](https://www.npmjs.com/package/pi-inspect)
[![npm downloads](https://img.shields.io/npm/dm/pi-inspect.svg)](https://www.npmjs.com/package/pi-inspect)

Introspection dashboard for the [pi coding agent](https://pi.dev) — see what's actually loaded into a session: tools, slash commands, skills, and the current system prompt.

<p align="center">
  <img src="https://raw.githubusercontent.com/NikiforovAll/pi-inspect/main/assets/demo.png" alt="pi-inspect demo" width="49%">
  <img src="https://raw.githubusercontent.com/NikiforovAll/pi-inspect/main/assets/demo-light.png" alt="pi-inspect demo light" width="49%">
</p>

## Installation

```sh
pi install npm:pi-inspect
```

Then use `/inspect start | stop | restart | status | open | list | snapshot` from inside pi.

## Usage (inside a pi session)

| Command | What it does |
| --- | --- |
| `/inspect` | Open the dashboard for the **current** session in your browser (`http://localhost:5462/?session=<id>`) |
| `/inspect <sessionId>` | Open dashboard pinned to a captured active session |
| `/inspect snapshot` | Re-capture the current session snapshot now |
| `/inspect list` | Print captured active-session IDs in the terminal |
| `/inspect open web\|app` | Open in browser or as a PWA window |
| `/inspect start` / `stop` / `restart` / `status` | Manage the local server |

State is driven entirely through the `?session=` URL param — share or refresh URLs to pin views. The in-page picker also writes to the URL.

## Sharing a snapshot

Click **Share** in the topbar to copy a self-contained link of the current snapshot. The snapshot is `deflate-raw` compressed and base64url-encoded into the URL hash (`#s=…`) — no server, no upload, no account.

Recipients open the link on the hosted static dashboard at **https://nikiforovall.blog/pi-inspect/** and see the exact same tools / commands / skills / system prompt. The page makes no network requests; everything is in the URL.

Heads up: the link includes the system prompt and `cwd`. Don't share secrets you wouldn't paste in chat.

## What it captures

- **Tools** — name, description, parameter schema, source
- **Slash commands** — name, source
- **System prompt** — full text injected on init, split into system / user `AGENTS.md` / project `AGENTS.md` sections
- **Session meta** — cwd, model, sessionId, sessionName, captured timestamp

The extension creates snapshots only when you run `/inspect` or `/inspect snapshot`. It keeps them in a private temporary directory and removes the current session snapshot on shutdown. Snapshot directories use mode `0700`, and files use mode `0600`.

## Port

`5462` — override via `PORT` env var. The server always binds to `127.0.0.1`.
