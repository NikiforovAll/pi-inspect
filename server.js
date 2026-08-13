#!/usr/bin/env node
const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const chokidar = require('chokidar');
const open = require('open').default || require('open');
const snapshots = require('./lib/snapshot');
const githubSource = require('./lib/github-source');
const pkg = require('./package.json');

const PORT = Number(process.env.PORT) || 5462;
const CAPABILITY = process.env.INSPECT_CAPABILITY || "";
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
app.use('/api', (req, res, next) => {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token || '';
  if (!CAPABILITY || token !== CAPABILITY) return res.status(401).json({ error: 'unauthorized' });
  res.set('Cache-Control', 'no-store');
  next();
});

app.get('/api/version', (_req, res) => {
  res.json({ name: pkg.name, version: pkg.version, pid: process.pid });
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

app.post('/api/sessions/cleanup', async (req, res) => {
  try {
    const keep = (req.body && req.body.keep) || req.query.keep || null;
    const result = keep
      ? await snapshots.keepOnly(String(keep))
      : await snapshots.cleanupIndex();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const githubMemo = new Map(); // sessionId -> Record<root, {url, source}>

function collectSourceRoots(snap) {
  const roots = new Set();
  const add = (x) => {
    const baseDir = x?.sourceInfo?.baseDir;
    if (typeof baseDir === 'string' && baseDir) roots.add(baseDir);
  };
  for (const t of snap.tools ?? []) add(t);
  for (const c of snap.commands ?? []) add(c);
  return [...roots];
}

app.get('/api/introspect', async (req, res) => {
  try {
    const sid = req.query.session ? String(req.query.session) : null;
    const snap = sid ? await snapshots.readSnapshot(sid) : await snapshots.readLatestSnapshot();
    if (!snap) return res.status(404).json({ error: 'no snapshot found', sessionId: sid });
    const memoKey = snap.sessionId;
    let githubSources = memoKey ? githubMemo.get(memoKey) : null;
    if (!githubSources) {
      githubSources = await githubSource.resolveMany(collectSourceRoots(snap));
      if (memoKey) githubMemo.set(memoKey, githubSources);
    }
    res.json({ ...snap, githubSources });
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

const STATE_DIR = process.env.INSPECT_STATE_DIR
  || path.join(os.tmpdir(), `pi-inspect-${process.getuid?.() ?? 'user'}`);
const REQ_DIR = path.join(STATE_DIR, 'requests');

app.post('/api/toggle', async (req, res) => {
  try {
    const { action, resourceKind, path: target, scope, sessionId } = req.body || {};
    if (!sessionId || typeof sessionId !== 'string') return res.status(400).json({ ok: false, error: 'missing sessionId' });
    if (action !== 'enable' && action !== 'disable') return res.status(400).json({ ok: false, error: 'action must be enable|disable' });
    if (!['skills', 'prompts', 'extensions', 'themes'].includes(resourceKind)) return res.status(400).json({ ok: false, error: 'invalid resourceKind' });
    if (!target || typeof target !== 'string') return res.status(400).json({ ok: false, error: 'missing path' });
    const useScope = scope === 'project' ? 'project' : 'user';
    const sessionReqDir = path.join(REQ_DIR, String(sessionId).replace(/[^a-zA-Z0-9._-]/g, '_'));
    await fsp.mkdir(sessionReqDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(sessionReqDir, 0o700);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const file = path.join(sessionReqDir, `${id}.json`);
    const tmp = `${file}.tmp`;
    const body = JSON.stringify({ id, sessionId, ts: Date.now(), action, resourceKind, path: target, scope: useScope });
    await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await fsp.chmod(tmp, 0o600);
    await fsp.rename(tmp, file);
    res.json({ ok: true, id });
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
fs.mkdirSync(SNAP_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(SNAP_DIR, 0o700);
chokidar
  .watch(SNAP_DIR, { ignoreInitial: true, depth: 1 })
  .on('all', (kind, file) => {
    if (!file.endsWith('.json')) return;
    broadcast('snapshot', { kind, file: path.basename(file) });
  });

app.use(express.static(path.join(__dirname, 'public')));

(async () => {
  await loadThemes();
  if (!CAPABILITY) throw new Error('INSPECT_CAPABILITY is required');
  const serverRecord = path.join(STATE_DIR, 'server.json');
  await fsp.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await fsp.chmod(STATE_DIR, 0o700);
  await fsp.writeFile(serverRecord, JSON.stringify({ pid: process.pid, port: PORT }), { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(serverRecord, 0o600);
  app.listen(PORT, '127.0.0.1', () => {
    const url = `http://localhost:${PORT}${openSession ? `/?session=${encodeURIComponent(openSession)}` : ''}`;
    console.log(`pi-inspect listening on http://localhost:${PORT}`);
    if (shouldOpen) open(url).catch(() => {});
  });
})();
