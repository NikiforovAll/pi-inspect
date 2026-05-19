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

async function writeIndex(sessions) {
  await fsp.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fsp.writeFile(INDEX_PATH, JSON.stringify({ sessions }, null, 2), 'utf8');
}

async function cleanupIndex() {
  const sessions = await readIndex();
  const kept = [];
  const removed = [];
  for (const s of sessions) {
    try {
      await fsp.access(snapshotPath(s.id));
      kept.push(s);
    } catch {
      removed.push(s.id);
    }
  }
  if (removed.length) await writeIndex(kept);
  return { kept: kept.length, removed };
}

async function keepOnly(sessionId) {
  if (!sessionId) throw new Error('sessionId required');
  const sessions = await readIndex();
  const kept = sessions.filter((s) => s.id === sessionId);
  const removed = [];
  let files;
  try { files = await fsp.readdir(SNAPSHOT_DIR); }
  catch { files = []; }
  const keepPath = path.basename(snapshotPath(sessionId));
  for (const f of files) {
    if (!f.endsWith('.json') || f === 'index.json' || f === keepPath) continue;
    try {
      await fsp.unlink(path.join(SNAPSHOT_DIR, f));
      removed.push(f.replace(/\.json$/, ''));
    } catch (e) {
      console.warn(`pi-inspect: unlink ${f}: ${e.message}`);
    }
  }
  await writeIndex(kept);
  return { kept: kept.length, removed };
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
  writeIndex,
  cleanupIndex,
  keepOnly,
  readSnapshot,
  readLatestSnapshot,
};
