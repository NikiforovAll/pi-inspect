'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../lib/app');
const { createSnapshotStore } = require('../lib/snapshot');
const pkg = require('../package.json');
const http = require('node:http');
const { tempDir, snapshot, seed, readUntil } = require('./helpers');

async function start(t, { snaps = [], ...opts } = {}) {
  const inspectDir = tempDir(t);
  const snapDir = path.join(inspectDir, 'snapshots');
  seed(snapDir, snaps);
  const opened = [];
  const github = [];
  const { app, closeClients } = createApp({
    store: createSnapshotStore(snapDir),
    inspectDir,
    openEditor: (file) => { opened.push(file); return 'test-editor'; },
    resolveGithub: async (roots) => { github.push(roots); return {}; },
    ...opts,
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { closeClients(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body, headers = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, post, inspectDir, snapDir, opened, github };
}

test('GET /api/companion answers the embed contract', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/api/companion`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { name: 'pi-inspect', version: pkg.version, session: '/?session={id}' });
});

test('GET /api/version', async (t) => {
  const { base } = await start(t);
  assert.deepEqual(await (await fetch(`${base}/api/version`)).json(), { name: 'pi-inspect', version: pkg.version });
});

test('GET /api/sessions lists newest first', async (t) => {
  const { base } = await start(t, { snaps: [snapshot('old', 1), snapshot('new', 2)] });
  const { sessions } = await (await fetch(`${base}/api/sessions`)).json();
  assert.deepEqual(sessions.map((s) => s.id), ['new', 'old']);
  assert.equal(sessions[0].model, 'test-model');
});

test('GET /api/introspect returns one session, the latest, or 404', async (t) => {
  const tool = { name: 't', sourceInfo: { baseDir: '/pkg/a' } };
  const { base, github } = await start(t, { snaps: [snapshot('old', 1, { tools: [tool] }), snapshot('new', 2)] });

  const latest = await (await fetch(`${base}/api/introspect`)).json();
  assert.equal(latest.sessionId, 'new');
  assert.deepEqual(latest.githubSources, {});

  const old = await (await fetch(`${base}/api/introspect?session=old`)).json();
  assert.equal(old.sessionId, 'old');
  await fetch(`${base}/api/introspect?session=old`);
  assert.deepEqual(github, [[], ['/pkg/a']], 'GitHub sources resolve once per session');

  const missing = await fetch(`${base}/api/introspect?session=nope`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'no snapshot found', sessionId: 'nope' });
});

test('GET /api/introspect with no snapshots is 404', async (t) => {
  const { base } = await start(t);
  assert.equal((await fetch(`${base}/api/introspect`)).status, 404);
});

test('POST /api/sessions/cleanup keeps only the given session', async (t) => {
  const { base, post, snapDir } = await start(t, { snaps: [snapshot('a', 1), snapshot('b', 2)] });
  const res = await post('/api/sessions/cleanup', { keep: 'a' });
  assert.deepEqual(await res.json(), { ok: true, kept: 1, removed: ['b'] });
  assert.ok(!fs.existsSync(path.join(snapDir, 'b.json')));
  const { sessions } = await (await fetch(`${base}/api/sessions`)).json();
  assert.deepEqual(sessions.map((s) => s.id), ['a']);
});

test('POST /api/sessions/cleanup needs keep in the body', async (t) => {
  const { post } = await start(t, { snaps: [snapshot('a', 1)] });
  assert.equal((await post('/api/sessions/cleanup?keep=a', {})).status, 400);
});

test('state-changing routes refuse other origins', async (t) => {
  const { base, post, snapDir } = await start(t, { snaps: [snapshot('a', 1), snapshot('b', 2)] });
  for (const route of ['/api/sessions/cleanup', '/api/toggle', '/api/open', '/api/focus']) {
    const res = await post(route, { keep: 'a' }, { origin: 'https://example.com' });
    assert.equal(res.status, 403, route);
  }
  assert.ok(fs.existsSync(path.join(snapDir, 'b.json')));
  const same = await post('/api/focus', {}, { origin: base });
  assert.equal(same.status, 200);
});

function statusWithHost(base, host) {
  return new Promise((resolve, reject) => {
    http.get(`${base}/api/sessions`, { headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
}

test('the API refuses host names other than loopback and the listen address', async (t) => {
  const { base } = await start(t);
  const port = new URL(base).port;
  assert.equal(await statusWithHost(base, `evil.example:${port}`), 403);
  for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
    assert.equal(await statusWithHost(base, host), 200, host);
  }

  const lan = await start(t, { host: 'pi-box' });
  assert.equal(await statusWithHost(lan.base, `pi-box:${new URL(lan.base).port}`), 200);
  const any = await start(t, { host: '0.0.0.0' });
  assert.equal(await statusWithHost(any.base, 'evil.example'), 200);
});

test('malformed JSON is a 400 with a JSON error', async (t) => {
  const { base } = await start(t);
  const res = await fetch(`${base}/api/focus`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

test('POST /api/toggle checks input and writes a request file', async (t) => {
  const { post, inspectDir } = await start(t);
  assert.equal((await post('/api/toggle', { action: 'flip', resourceKind: 'skills', path: '/x' })).status, 400);
  assert.equal((await post('/api/toggle', { action: 'enable', resourceKind: 'tools', path: '/x' })).status, 400);
  assert.equal((await post('/api/toggle', { action: 'enable', resourceKind: 'skills' })).status, 400);

  const res = await post('/api/toggle', { action: 'disable', resourceKind: 'skills', path: '/s/SKILL.md', scope: 'weird' });
  const { ok, id } = await res.json();
  assert.ok(ok);
  const files = fs.readdirSync(path.join(inspectDir, 'requests'));
  assert.deepEqual(files, [`${id}.json`]);
  const req = JSON.parse(fs.readFileSync(path.join(inspectDir, 'requests', files[0]), 'utf8'));
  assert.equal(req.action, 'disable');
  assert.equal(req.scope, 'user');
  assert.equal(req.path, '/s/SKILL.md');
});

test('POST /api/open opens existing files only', async (t) => {
  const { post, opened, inspectDir } = await start(t);
  assert.equal((await post('/api/open', {})).status, 400);
  assert.equal((await post('/api/open', { path: path.join(inspectDir, 'missing.md') })).status, 404);
  const file = path.join(inspectDir, 'note.md');
  fs.writeFileSync(file, '# hi');
  const res = await post('/api/open', { path: file });
  assert.deepEqual(await res.json(), { ok: true, editor: 'test-editor', path: file });
  assert.deepEqual(opened, [file]);
});

test('POST /api/focus reaches open dashboards over SSE', async (t) => {
  const { base, post } = await start(t);
  assert.deepEqual(await (await post('/api/focus', { session: 'x' })).json(), { delivered: 0 });

  const ac = new AbortController();
  t.after(() => ac.abort());
  const events = await fetch(`${base}/api/events`, { signal: ac.signal });
  assert.match(events.headers.get('content-type'), /^text\/event-stream/);
  const reader = events.body.getReader();
  await reader.read();

  assert.deepEqual(await (await post('/api/focus', { session: 'x' })).json(), { delivered: 1 });
  const text = await readUntil(reader, (s) => s.includes('navigate') && s.includes('\n\n', s.indexOf('navigate')));
  assert.match(text, /event: navigate\ndata: \{"session":"x"\}/);
});

test('unknown API paths are JSON 404s; the page is served', async (t) => {
  const { base } = await start(t);
  const api = await fetch(`${base}/api/themes`);
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: 'not found' });
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>pi-inspect<\/title>/);
});
