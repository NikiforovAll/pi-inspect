'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-inspect-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function snapshot(id, capturedAt, extra = {}) {
  return { sessionId: id, sessionName: null, cwd: '/work/demo', model: 'test-model', systemPrompt: 'You are pi.', commands: [], tools: [], activeTools: [], disabledItems: [], pendingItems: [], capturedAt, ...extra };
}

// Writes snapshot files and an index the way the extension does.
function seed(dir, snaps) {
  fs.mkdirSync(dir, { recursive: true });
  for (const s of snaps) fs.writeFileSync(path.join(dir, `${s.sessionId}.json`), JSON.stringify(s));
  const sessions = snaps.map((s) => ({ id: s.sessionId, cwd: s.cwd, name: s.sessionName, model: s.model, capturedAt: s.capturedAt }));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ sessions }));
}

async function readUntil(reader, done) {
  const decoder = new TextDecoder();
  let text = '';
  while (!done(text)) text += decoder.decode((await reader.read()).value, { stream: true });
  return text;
}

module.exports = { tempDir, snapshot, seed, readUntil };
