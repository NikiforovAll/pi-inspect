const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const net = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const root = join(__dirname, '..');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(url) {
  for (let i = 0; i < 50; i += 1) {
    try { return await fetch(url); } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  throw new Error('server did not start');
}

test('dashboard binds to loopback and protects state directories', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'pi-inspect-server-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, INSPECT_STATE_DIR: state, INSPECT_CAPABILITY: 'test-capability', PORT: String(port) },
    stdio: 'ignore',
  });
  t.after(() => { child.kill('SIGTERM'); rmSync(state, { recursive: true, force: true }); });
  const unauthorized = await waitFor(`http://127.0.0.1:${port}/api/version`);
  assert.equal(unauthorized.status, 401);
  const response = await fetch(`http://127.0.0.1:${port}/api/version`, { headers: { authorization: 'Bearer test-capability' } });
  assert.equal(response.status, 200);
  const version = await response.json();
  assert.equal(version.name, 'pi-inspect');
  assert.equal(version.pid, child.pid);
  const address = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      const remote = socket.remoteAddress;
      socket.destroy();
      resolve(remote);
    });
    socket.once('error', reject);
  });
  assert.equal(address, '127.0.0.1');
  assert.equal(statSync(join(state, 'snapshots')).mode & 0o777, 0o700);
  assert.equal(statSync(join(state, 'server.json')).mode & 0o777, 0o600);
  const toggle = await fetch(`http://127.0.0.1:${port}/api/toggle`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-capability', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'session-a', action: 'disable', resourceKind: 'skills', path: '/tmp/example', scope: 'user' }),
  });
  assert.equal(toggle.status, 200);
  assert.equal(statSync(join(state, 'requests', 'session-a')).mode & 0o777, 0o700);
});

test('snapshots are explicit and session-ephemeral', () => {
  const source = readFileSync(join(root, 'extensions', 'inspect.ts'), 'utf8');
  const startupBlock = source.slice(source.indexOf('pi.on("session_start"'), source.indexOf('pi.registerCommand("inspect"'));
  assert.doesNotMatch(startupBlock, /captureSnapshot/);
  assert.match(source, /tmpdir\(\)/);
  assert.match(source, /pi\.on\(['"]session_shutdown['"]/);
  assert.match(source, /removeIndexEntry\(id\)/);
});

test('snapshot writes repair broad permissions and latest skips stale entries', async (t) => {
  const state = mkdtempSync(join(tmpdir(), 'pi-inspect-permissions-'));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const snapshotsDir = join(state, 'snapshots');
  mkdirSync(snapshotsDir, { mode: 0o777 });
  const index = join(snapshotsDir, 'index.json');
  writeFileSync(index, '{}', { mode: 0o666 });
  const previous = process.env.INSPECT_STATE_DIR;
  process.env.INSPECT_STATE_DIR = state;
  delete require.cache[require.resolve('../lib/snapshot.js')];
  const snapshots = require('../lib/snapshot.js');
  t.after(() => {
    delete require.cache[require.resolve('../lib/snapshot.js')];
    if (previous === undefined) delete process.env.INSPECT_STATE_DIR;
    else process.env.INSPECT_STATE_DIR = previous;
  });
  await snapshots.writeIndex([{ id: 'active', capturedAt: 1 }, { id: 'closed', capturedAt: 2 }]);
  writeFileSync(snapshots.snapshotPath('active'), JSON.stringify({ sessionId: 'active' }), { mode: 0o666 });
  const latest = await snapshots.readLatestSnapshot();
  assert.equal(latest.sessionId, 'active');
  const cleaned = await snapshots.readIndex();
  assert.deepEqual(cleaned.map((entry) => entry.id), ['active']);
  assert.equal(statSync(snapshotsDir).mode & 0o777, 0o700);
  assert.equal(statSync(index).mode & 0o777, 0o600);
});

test('repairs all existing private state modes without following links', () => {
  const source = readFileSync(join(root, 'extensions', 'inspect.ts'), 'utf8');
  assert.match(source, /lstatSync\(path\)/);
  assert.match(source, /if \(stat\.isSymbolicLink\(\)\) return/);
  assert.match(source, /if \(stat\.isDirectory\(\)\)[\s\S]*chmodSync\(path, 0o700\)/);
  assert.match(source, /if \(stat\.isFile\(\)\) chmodSync\(path, 0o600\)/);
  assert.match(source, /secureStateTree\(INSPECT_DIR\)/);
});

test('service worker invalidates pre-authentication assets', () => {
  const source = readFileSync(join(root, 'public', 'sw.js'), 'utf8');
  assert.match(source, /pi-inspect-v7/);
  assert.doesNotMatch(source, /pi-inspect-v6/);
});

test('request watcher follows session lifecycle', () => {
  const source = readFileSync(join(root, 'extensions', 'inspect.ts'), 'utf8');
  assert.match(source, /pi\.on\(['"]session_shutdown['"]/);
  assert.match(source, /reqWatcher\?\.close\(\)/);
  assert.match(source, /reqWatcher = null/);
});
