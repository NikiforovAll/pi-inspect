'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { watchSnapshots } = require('../lib/watch');
const { tempDir, snapshot, readUntil } = require('./helpers');

const SERVER = path.join(__dirname, '..', 'server.js');

function run(t, args, env) {
  const child = spawn(process.execPath, [SERVER, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, exited, output: () => out };
}

function waitFor(check, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const v = check();
      if (v) return resolve(v);
      if (Date.now() > end) return reject(new Error('timed out'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

test('the embed spawn line starts the server and prints its URL', async (t) => {
  const agent = tempDir(t);
  const { output } = run(t, ['--port', '0', '--host', '127.0.0.1', '--no-open'], { PI_CODING_AGENT_DIR: agent, PORT: '' });
  const [, port] = await waitFor(() => output().match(/pi-inspect listening on http:\/\/localhost:(\d+)/));
  const info = await (await fetch(`http://127.0.0.1:${port}/api/companion`)).json();
  assert.equal(info.name, 'pi-inspect');
  assert.equal(info.session, '/?session={id}');
  assert.ok(fs.existsSync(path.join(agent, 'inspect', 'snapshots')), 'snapshot dir is under PI_CODING_AGENT_DIR');
});

test('the server sends a snapshot event when a snapshot file changes', async (t) => {
  const agent = tempDir(t);
  const { output } = run(t, ['--port', '0', '--no-open'], { PI_CODING_AGENT_DIR: agent });
  const [, port] = await waitFor(() => output().match(/listening on http:\/\/localhost:(\d+)/));
  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader();
  await reader.read();
  fs.writeFileSync(path.join(agent, 'inspect', 'snapshots', 's1.json'), JSON.stringify(snapshot('s1', 1)));
  const text = await readUntil(reader, (s) => s.includes('event: snapshot'));
  assert.match(text, /"files":\["s1\.json"\]/);
});

test('bad flags and a taken port exit 1', async (t) => {
  const bad = run(t, ['--port', 'abc']);
  assert.equal(await bad.exited, 1);
  assert.match(bad.output(), /invalid port: abc/);

  const agent = tempDir(t);
  const first = run(t, ['--port', '0', '--no-open'], { PI_CODING_AGENT_DIR: agent });
  const [, port] = await waitFor(() => first.output().match(/localhost:(\d+)/));
  const second = run(t, ['--port', port, '--no-open'], { PI_CODING_AGENT_DIR: agent });
  assert.equal(await second.exited, 1);
  assert.match(second.output(), /cannot listen on port/);
});

test('watchSnapshots batches changes and ignores other files', async (t) => {
  const dir = tempDir(t);
  const batches = [];
  const w = watchSnapshots(dir, (files) => batches.push(files.sort()), { delayMs: 100 });
  t.after(() => w.close());
  fs.writeFileSync(path.join(dir, 'a.json'), '{}');
  fs.writeFileSync(path.join(dir, 'a.json'), '{"x":1}');
  fs.writeFileSync(path.join(dir, 'b.json'), '{}');
  fs.writeFileSync(path.join(dir, 'c.txt'), 'x');
  await waitFor(() => batches.length);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(batches, [['a.json', 'b.json']]);
});
