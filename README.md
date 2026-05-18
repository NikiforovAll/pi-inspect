# pi-inspect

[![npm version](https://img.shields.io/npm/v/pi-inspect.svg)](https://www.npmjs.com/package/pi-inspect)
[![npm downloads](https://img.shields.io/npm/dm/pi-inspect.svg)](https://www.npmjs.com/package/pi-inspect)

Introspection dashboard for the [pi coding agent](https://pi.dev) — see what's actually loaded into a session: tools, slash commands, skills, and the system prompt injected on init.

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
| `/inspect <sessionId>` | Open dashboard pinned to a specific past session |
| `/inspect snapshot` | Re-capture the current session snapshot now |
| `/inspect list` | Print all captured session IDs in the terminal |
| `/inspect open web\|app` | Open in browser or as a PWA window |
| `/inspect start` / `stop` / `restart` / `status` | Manage the local server |

State is driven entirely through the `?session=` URL param — share or refresh URLs to pin views. The in-page picker also writes to the URL.

## What it captures

- **Tools** — name, description, parameter schema, source
- **Slash commands** — name, source
- **System prompt** — full text injected on init, split into system / user `AGENTS.md` / project `AGENTS.md` sections
- **Session meta** — cwd, model, sessionId, sessionName, captured timestamp

Snapshots live at `~/.pi/agent/inspect/snapshots/<sessionId>.json`.

## Port

`5462` — override via `PORT` env var.
