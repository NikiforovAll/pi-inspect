'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const githubSource = require('./github-source');
const { openInEditor } = require('./editor');
const { writeJsonAtomic } = require('./snapshot');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const RESOURCE_KINDS = ['skills', 'prompts', 'extensions', 'themes'];

// Path template a host such as the pi-kanban board fills in to open one session.
const SESSION_PATH = '/?session={id}';

function collectSourceRoots(snap) {
  const roots = new Set();
  for (const x of [...(snap.tools ?? []), ...(snap.commands ?? [])]) {
    const baseDir = x?.sourceInfo?.baseDir;
    if (typeof baseDir === 'string' && baseDir) roots.add(baseDir);
  }
  return [...roots];
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const ANY_ADDRESS = new Set(['0.0.0.0', '::', '[::]']);

// A DNS-rebinding page reaches the server under its own host name, where its origin checks pass.
// Serve the API only to loopback names and the listen address, unless the server listens on every address.
function hostAllowlist(listenHost) {
  return (req, res, next) => {
    if (ANY_ADDRESS.has(listenHost) || LOOPBACK_NAMES.has(req.hostname) || req.hostname === listenHost) return next();
    res.status(403).json({ ok: false, error: 'host not allowed' });
  };
}

// The routes change files or open programs, so a web page on another origin must not reach them.
// Browsers always send Origin on POST; tools such as the extension's fetch send none.
function sameOriginOnly(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch {}
    if (host !== req.get('host')) return res.status(403).json({ ok: false, error: 'cross-origin request refused' });
  }
  next();
}

function createApp({ store, inspectDir, host = '127.0.0.1', openEditor = openInEditor, resolveGithub = githubSource.resolveMany }) {
  const app = express();
  app.disable('x-powered-by');
  app.use('/api', hostAllowlist(host));
  app.use(express.json({ limit: '1mb' }));
  app.post('/api/*splat', sameOriginOnly);

  const sseClients = new Set();
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(payload);
  }

  app.get('/api/version', (_req, res) => {
    res.json({ name: pkg.name, version: pkg.version });
  });

  app.get('/api/companion', (_req, res) => {
    res.json({ name: pkg.name, version: pkg.version, session: SESSION_PATH });
  });

  app.get('/api/sessions', async (_req, res) => {
    res.json({ sessions: await store.listSessions() });
  });

  app.post('/api/sessions/cleanup', async (req, res) => {
    const keep = req.body?.keep;
    if (!keep || typeof keep !== 'string') return res.status(400).json({ ok: false, error: 'missing keep' });
    res.json({ ok: true, ...(await store.keepOnly(keep)) });
  });

  const githubMemo = new Map();
  app.get('/api/introspect', async (req, res) => {
    const sid = typeof req.query.session === 'string' && req.query.session ? req.query.session : null;
    const snap = sid ? await store.readSnapshot(sid) : await store.readLatestSnapshot();
    if (!snap) return res.status(404).json({ error: 'no snapshot found', sessionId: sid });
    let githubSources = snap.sessionId ? githubMemo.get(snap.sessionId) : null;
    if (!githubSources) {
      githubSources = await resolveGithub(collectSourceRoots(snap));
      if (snap.sessionId) githubMemo.set(snap.sessionId, githubSources);
    }
    res.json({ ...snap, githubSources });
  });

  app.post('/api/open', (req, res) => {
    const target = req.body?.path;
    if (!target || typeof target !== 'string') return res.status(400).json({ ok: false, error: 'missing path' });
    const file = path.normalize(target);
    if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: `path not found: ${file}` });
    res.json({ ok: true, editor: openEditor(file), path: file });
  });

  // The extension in the live pi session applies the request; see setupRequestWatcher in extensions/inspect.ts.
  app.post('/api/toggle', async (req, res) => {
    const { action, resourceKind, path: target, scope } = req.body || {};
    if (action !== 'enable' && action !== 'disable') return res.status(400).json({ ok: false, error: 'action must be enable or disable' });
    if (!RESOURCE_KINDS.includes(resourceKind)) return res.status(400).json({ ok: false, error: 'invalid resourceKind' });
    if (!target || typeof target !== 'string') return res.status(400).json({ ok: false, error: 'missing path' });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    await writeJsonAtomic(path.join(inspectDir, 'requests', `${id}.json`), {
      id, ts: Date.now(), action, resourceKind, path: target, scope: scope === 'project' ? 'project' : 'user',
    });
    res.json({ ok: true, id });
  });

  app.post('/api/focus', (req, res) => {
    const session = typeof req.body?.session === 'string' ? req.body.session : null;
    const delivered = sseClients.size;
    if (delivered) broadcast('navigate', { session });
    res.json({ delivered });
  });

  app.get('/api/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(': hello\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  app.use(express.static(PUBLIC_DIR));

  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  });

  function closeClients() {
    for (const c of sseClients) c.end();
    sseClients.clear();
  }

  return { app, broadcast, closeClients };
}

module.exports = { createApp, SESSION_PATH };
