const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const SNAPSHOT_DIR = process.env.INSPECT_SNAPSHOT_DIR
  || path.join(os.homedir(), '.pi', 'agent', 'inspect', 'snapshots');
const INDEX_PATH = path.join(SNAPSHOT_DIR, 'index.json');

function snapshotDir() {
  return SNAPSHOT_DIR;
}

function snapshotPath(sessionId) {
  return path.join(SNAPSHOT_DIR, `${sanitize(sessionId)}.json`);
}

function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function readIndex() {
  try {
    const raw = await fsp.readFile(INDEX_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`pi-inspect: read index: ${e.message}`);
    return [];
  }
}

async function readSnapshot(sessionId) {
  try {
    const raw = await fsp.readFile(snapshotPath(sessionId), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function readLatestSnapshot() {
  const sessions = await readIndex();
  if (!sessions.length) return null;
  const sorted = [...sessions].sort((a, b) => (b.capturedAt || 0) - (a.capturedAt || 0));
  return readSnapshot(sorted[0].id);
}

module.exports = {
  snapshotDir,
  snapshotPath,
  readIndex,
  readSnapshot,
  readLatestSnapshot,
};
