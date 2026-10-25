# Changelog

## 0.6.0

### Breaking changes

- The server listens on `127.0.0.1` only. To reach it from another machine, start it with `--host 0.0.0.0`.

### Features

- **New dashboard.** A keyboard-first tree of tools, commands, skills, and the system prompt, in light and dark mode.
- **Server options.** `--port` (`0` picks a free port), `--host`, `--open`, `--no-open`, and `--session`.
- **pi-kanban pane.** `GET /api/companion` and the embed theme handshake let the pi-kanban board show pi-inspect in a pane, in the board's colors.
- The snapshot records the model from pi's current context.

### Fixes

- `pi -p` with pi-inspect loaded exits when the prompt is done.

### Security

- The API answers only to local host names, and refuses `POST` requests from other origins.

### Other

- Express 5, without chokidar. The browser opener loads only when it is needed.
- Snapshot files are written atomically.
- `node:test` suites for the store, routes, flags, and server.
