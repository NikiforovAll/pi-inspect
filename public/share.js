// Shareable snapshot encoding: JSON → deflate-raw → base64url.
// URL shape mirrors plannotator.ai: `#s=<base64url>`.

const HASH_PREFIX = '#s=';

function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function streamThrough(transformer, bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(transformer);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// Path-redaction: strip the sender's HOME prefix from every string and key,
// in both slash flavors. Preserves project basename + relative tail so the
// shared view still has useful structure ("<home>/dev/pi-inspect").
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveHome(cwd) {
  if (!cwd || typeof cwd !== 'string') return null;
  const patterns = [
    /^([a-zA-Z]:[\\/]Users[\\/][^\\/]+)/,   // Windows: C:\Users\<user>
    /^(\/Users\/[^/]+)/,                    // macOS:   /Users/<user>
    /^(\/home\/[^/]+)/,                     // Linux:   /home/<user>
    /^(\/[a-zA-Z]\/Users\/[^/]+)/,          // Git Bash: /c/Users/<user>
  ];
  for (const re of patterns) {
    const m = cwd.match(re);
    if (m) return m[1];
  }
  return null;
}

function buildHomeReplacers(cwd) {
  const home = deriveHome(cwd);
  if (!home) return [];
  const alt = home.includes('\\') ? home.replace(/\\/g, '/') : home.replace(/\//g, '\\');
  const variants = new Set([home, alt]);
  return [...variants].map((v) => [new RegExp(escapeRegex(v), 'g'), '<home>']);
}

function redactString(s, reps) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const [re, rep] of reps) out = out.replace(re, rep);
  return out;
}

// Keys whose values are home-path-keyed maps — redact keys here too.
const PATH_KEYED_MAPS = new Set(['githubSources']);

function redactDeep(value, reps, redactKeys) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value, reps);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, reps, false));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const newKey = redactKeys ? redactString(k, reps) : k;
      out[newKey] = redactDeep(v, reps, PATH_KEYED_MAPS.has(k));
    }
    return out;
  }
  return value;
}

function redactSnapshot(snapshot) {
  if (!snapshot) return snapshot;
  const reps = buildHomeReplacers(snapshot.cwd || '');
  if (!reps.length) return snapshot;
  return redactDeep(snapshot, reps, false);
}

async function encodeSnapshot(snapshot) {
  const json = JSON.stringify(redactSnapshot(snapshot));
  const raw = new TextEncoder().encode(json);
  const compressed = await streamThrough(new CompressionStream('deflate-raw'), raw);
  return bytesToBase64Url(compressed);
}

async function decodeSnapshot(encoded) {
  const compressed = base64UrlToBytes(encoded);
  const raw = await streamThrough(new DecompressionStream('deflate-raw'), compressed);
  return JSON.parse(new TextDecoder().decode(raw));
}

function getSharedSnapshotParam() {
  const h = location.hash || '';
  return h.startsWith(HASH_PREFIX) ? h.slice(HASH_PREFIX.length) : null;
}

const PUBLIC_BASE_URL = 'https://nikiforovall.blog/pi-inspect/';

function buildShareUrl(encoded) {
  // Local pi-inspect runs on localhost — recipients can't open that. Always
  // anchor share links on the hosted static dashboard. When the current page
  // is already a non-localhost origin (e.g. the hosted site itself), reuse it.
  const host = location.hostname;
  const isLocal = !host || host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const base = isLocal ? PUBLIC_BASE_URL : `${location.origin}${location.pathname}`;
  return `${base}${HASH_PREFIX}${encoded}`;
}

window.piShare = { encodeSnapshot, decodeSnapshot, getSharedSnapshotParam, buildShareUrl, redactSnapshot };
