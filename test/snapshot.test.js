'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSnapshotStore, sanitize } = require('../lib/snapshot');
const { tempDir, snapshot, seed } = require('./helpers');

test('an empty or missing directory has no sessions and no latest snapshot', async (t) => {
  const store = createSnapshotStore(path.join(tempDir(t), 'missing'));
  assert.deepEqual(await store.listSessions(), []);
  assert.equal(await store.readLatestSnapshot(), null);
  assert.equal(await store.readSnapshot('nope'), null);
});

test('listSessions sorts by capture time, newest first', async (t) => {
  const dir = tempDir(t);
  seed(dir, [snapshot('a', 100), snapshot('b', 300), snapshot('c', 200)]);
  const store = createSnapshotStore(dir);
  assert.deepEqual((await store.listSessions()).map((s) => s.id), ['b', 'c', 'a']);
  assert.equal((await store.readLatestSnapshot()).sessionId, 'b');
});

test('a corrupt index reads as empty', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'index.json'), '{not json');
  const store = createSnapshotStore(dir);
  t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await store.listSessions(), []);
});

test('a corrupt snapshot file is an error, not a missing snapshot', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{');
  await assert.rejects(createSnapshotStore(dir).readSnapshot('bad'), SyntaxError);
});

test('ids map to safe file names inside the directory', async (t) => {
  const dir = tempDir(t);
  const store = createSnapshotStore(dir);
  assert.equal(sanitize('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(path.dirname(store.snapshotPath('../../x')), dir);
  fs.writeFileSync(path.join(dir, 'a_b.json'), JSON.stringify(snapshot('a/b', 1)));
  assert.equal((await store.readSnapshot('a/b')).sessionId, 'a/b');
});

test('keepOnly deletes other snapshot files and rewrites the index', async (t) => {
  const dir = tempDir(t);
  seed(dir, [snapshot('a', 1), snapshot('b', 2), snapshot('c', 3)]);
  fs.writeFileSync(path.join(dir, 'orphan.json'), '{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me');
  const store = createSnapshotStore(dir);
  const result = await store.keepOnly('b');
  assert.equal(result.kept, 1);
  assert.deepEqual(result.removed.sort(), ['a', 'c', 'orphan']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['b.json', 'index.json', 'notes.txt']);
  assert.deepEqual((await store.listSessions()).map((s) => s.id), ['b']);
});

test('keepOnly needs an id', async (t) => {
  await assert.rejects(createSnapshotStore(tempDir(t)).keepOnly(''), /session id required/);
});

test('writeIndex leaves no temp file behind', async (t) => {
  const dir = tempDir(t);
  await createSnapshotStore(dir).writeIndex([{ id: 'x', capturedAt: 1 }]);
  assert.deepEqual(fs.readdirSync(dir), ['index.json']);
});
