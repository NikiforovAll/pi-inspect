#!/usr/bin/env node
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const chokidar = require('chokidar');
const open = require('open').default || require('open');
const snapshots = require('./lib/snapshot');
const pkg = require('./package.json');

const PORT = Number(process.env.PORT) || 5462;
const args = process.argv.slice(2);
const shouldOpen = args.includes('--open');
const openSession = (() => {
  const i = args.indexOf('--session');
  return i >= 0 ? args[i + 1] : null;
})();

const BUILTIN_THEME_DIR = path.join(__dirname, 'themes');
const USER_THEME_DIR = process.env.INSPECT_THEME_DIR
  || path.join(os.homedir(), '.pi', 'agent', 'inspect', 'themes');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/api/version', (_req, res) => {
  res.json({ name: pkg.name, version: pkg.version });
});

app.get('/api/sessions', async (_req, res) => {
  try {
    const sessions = await snapshots.readIndex();
    const sorted = [...sessions].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
    res.json({ sessions: sorted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/introspect', async (req, res) => {
  try {
    const sid = req.query.session ? String(req.query.session) : null;
    const snap = sid ? await snapshots.readSnapshot(sid) : await snapshots.readLatestSnapshot();
    if (!snap) return res.status(404).json({ error: 'no snapshot found', sessionId: sid });
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const themes = new Map();
async function loadThemes() {
  for (const dir of [BUILTIN_THEME_DIR, USER_THEME_DIR]) {
    let entries;
    try { entries = await fsp.readdir(dir); }
    catch (e) {
      if (e.code !== 'ENOENT') console.warn(`themes: cannot read ${dir}: ${e.message}`);
      continue;
    }
    for (const f of entries.filter((n) => n.toLowerCase().endsWith('.json'))) {
      try {
        const raw = await fsp.readFile(path.join(dir, f), 'utf8');
        const obj = JSON.parse(raw);
        const id = f.replace(/\.json$/i, '');
        themes.set(id, obj);
      } catch (e) {
        console.warn(`themes: skip ${f}: ${e.message}`);
      }
    }
  }
}

app.get('/api/themes', (_req, res) => {
  res.json({ themes: [...themes.values()] });
});

app.post('/api/open', (req, res) => {
  const target = (req.body && req.body.path) || '';
  if (!target || typeof target !== 'string') return res.status(400).json({ ok: false, error: 'missing path' });
  const normalized = path.normalize(target);
  if (!fs.existsSync(normalized)) return res.status(404).json({ ok: false, error: `path not found: ${normalized}` });
  const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'code' : 'vi');
  try {
    const { spawn } = require('node:child_process');
    const isWin = process.platform === 'win32';
    const parts = editor.split(/\s+/);
    const cmd = parts.shift();
    const args = [...parts, normalized];
    const quotedArgs = isWin ? args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`) : args;
    const child = spawn(cmd, quotedArgs, {
      detached: true,
      stdio: 'ignore',
      shell: isWin,
      windowsVerbatimArguments: isWin,
    });
    child.on('error', (err) => console.warn(`open failed: ${err.message}`));
    child.unref();
    res.json({ ok: true, editor, path: normalized });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/focus', (req, res) => {
  const sid = (req.body && req.body.session) || req.query.session || null;
  const count = sseClients.size;
  if (count > 0) broadcast('navigate', { session: sid });
  res.json({ delivered: count });
});

// SSE
const sseClients = new Set();
app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(': hello\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(payload); } catch {}
  }
}

const SNAP_DIR = snapshots.snapshotDir();
fs.mkdirSync(SNAP_DIR, { recursive: true });
chokidar
  .watch(SNAP_DIR, { ignoreInitial: true, depth: 1 })
  .on('all', (kind, file) => {
    if (!file.endsWith('.json')) return;
    broadcast('snapshot', { kind, file: path.basename(file) });
  });

app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await loadThemes();
  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}${openSession ? `/?session=${encodeURIComponent(openSession)}` : ''}`;
    console.log(`pi-inspect listening on http://localhost:${PORT}`);
    if (shouldOpen) open(url).catch(() => {});
  });
})();
