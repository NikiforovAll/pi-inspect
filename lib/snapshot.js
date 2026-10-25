'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path');

const INDEX_FILE = 'index.json';

// Same rule as the extension's file names, so an id maps to the file it wrote.
function sanitize(id) {
  return String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

const byCapturedDesc = (a, b) => (b.capturedAt || 0) - (a.capturedAt || 0);

function createSnapshotStore(dir) {
  const indexPath = path.join(dir, INDEX_FILE);
  const snapshotPath = (id) => path.join(dir, `${sanitize(id)}.json`);

  async function readIndex() {
    try {
      const parsed = JSON.parse(await fsp.readFile(indexPath, 'utf8'));
      return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`pi-inspect: read index: ${e.message}`);
      return [];
    }
  }

  function writeIndex(sessions) {
    return writeJsonAtomic(indexPath, { sessions });
  }

  async function listSessions() {
    return (await readIndex()).sort(byCapturedDesc);
  }

  async function readSnapshot(id) {
    try {
      return JSON.parse(await fsp.readFile(snapshotPath(id), 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async function readLatestSnapshot() {
    const [latest] = await listSessions();
    return latest ? readSnapshot(latest.id) : null;
  }

  async function keepOnly(id) {
    if (!id) throw new Error('session id required');
    const keepFile = path.basename(snapshotPath(id));
    let files;
    try { files = await fsp.readdir(dir); } catch { files = []; }
    const removed = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f === INDEX_FILE || f === keepFile) continue;
      try {
        await fsp.unlink(path.join(dir, f));
        removed.push(f.slice(0, -'.json'.length));
      } catch (e) {
        console.warn(`pi-inspect: unlink ${f}: ${e.message}`);
      }
    }
    const kept = (await readIndex()).filter((s) => s.id === id);
    await writeIndex(kept);
    return { kept: kept.length, removed };
  }

  return { dir, snapshotPath, writeIndex, listSessions, readSnapshot, readLatestSnapshot, keepOnly };
}

module.exports = { createSnapshotStore, sanitize, writeJsonAtomic };
