# pi-inspect — agent notes

Three-piece pattern shared with pi-kanban / pi-cost:

1. `extensions/inspect.ts` — TS extension registering `/inspect` slash command. Captures a snapshot on `session_start` and writes it to `~/.pi/agent/inspect/snapshots/<sessionId>.json` (plus `index.json`). Spawns `server.js`, opens browser with `?session=<currentId>`.
2. `server.js` — Express on port **5462**. Endpoints: `/api/version`, `/api/sessions`, `/api/introspect?session=<id>`, `/api/themes`, SSE `/api/events`. Watches the snapshots dir via chokidar.
3. `public/` — vanilla HTML/CSS/JS. `app.js` is single-file, `//#region` blocks. Vertical card list, URL `?session=` drives state, kind chips + search filter.
