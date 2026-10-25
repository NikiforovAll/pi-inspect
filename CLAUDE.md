# pi-inspect — agent notes

Three-piece pattern shared with pi-kanban / pi-cost:

1. `extensions/inspect.ts` — TS extension registering `/inspect` slash command. Captures a snapshot on `session_start` and writes it atomically to `<agentDir>/inspect/snapshots/<sessionId>.json` (plus `index.json`), where `<agentDir>` is pi's `getAgentDir()` (`PI_CODING_AGENT_DIR` or `~/.pi/agent`). Spawns `server.js --port <n> --no-open` with the same agent dir, opens browser with `?session=<currentId>`. Its request-dir watcher is unref'd and closed on `session_shutdown`, so `pi -p` exits fast; keep it that way.
2. `server.js` — thin CLI. Default `127.0.0.1:5462` (`--port`, then `PORT`; `--host`). Prints `pi-inspect listening on http://localhost:<port>`. Modules:
   - `lib/args.js` — flag and env parsing (`parseOptions`).
   - `lib/agent-dir.js` — mirrors `getAgentDir()`.
   - `lib/snapshot.js` — `createSnapshotStore(dir)`: index, list, read, keep-only.
   - `lib/app.js` — `createApp({ store, inspectDir, host, openEditor, resolveGithub })`, the Express routes (API limited to loopback host names and `host`): `/api/version`, `/api/companion`, `/api/sessions`, `/api/introspect?session=<id>`, SSE `/api/events`, and same-origin-only POSTs `/api/sessions/cleanup`, `/api/open`, `/api/toggle`, `/api/focus`.
   - `lib/watch.js` — batched `fs.watch` on the snapshots dir (resolves 8.3 short paths on Windows first).
   - `lib/editor.js` — open a file in `$EDITOR` / VS Code.
3. `public/` — vanilla HTML/CSS/JS. `app.js` is single-file, `//#region` blocks. Tree of items grouped by kind and package, detail panel on the right, kind chips (`0`–`5`) + search filter, keyboard-first. URL `?session=` drives state. Tokens match the pi-kanban board's Ember theme; fonts are bundled in `public/fonts`. A framing host (pi-kanban) uses `/api/companion` and, with `?embed=1`, the `pi-companion:ready` / `pi-companion:theme` messages; see the README "Embedding" section. No `confirm()`/`alert()`: the board's pane sandbox has no `allow-modals`.

Tests: `npm test` (node:test, `test/`). Type check: `npm run typecheck:extensions`.
