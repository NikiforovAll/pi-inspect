'use strict';
const path = require('node:path');
const fsp = require('node:fs/promises');

const MAX_WALK = 8;
const cache = new Map(); // root -> { url, source } | null

function normalizeRepo(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^git\+/, '').replace(/\.git(\/|$)/, '$1').replace(/\/+$/, '');
  // shorthand: github:owner/repo or owner/repo
  let m = s.match(/^(?:github:)?([\w.-]+)\/([\w.-]+)$/i);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  // ssh: git@github.com:owner/repo
  m = s.match(/^git@github\.com:([\w.-]+)\/([\w.-]+)$/i);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  // ssh url: ssh://git@github.com/owner/repo
  m = s.match(/^ssh:\/\/git@github\.com\/([\w.-]+)\/([\w.-]+)$/i);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  // https / git protocols
  m = s.match(/^(?:https?|git):\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+)$/i);
  if (m) return `https://github.com/${m[1]}/${m[2]}`;
  return null;
}

async function tryPackageJson(dir) {
  try {
    const raw = await fsp.readFile(path.join(dir, 'package.json'), 'utf8');
    const pkg = JSON.parse(raw);
    const repo = pkg.repository;
    let urlStr = null;
    let subdir = null;
    if (typeof repo === 'string') urlStr = repo;
    else if (repo && typeof repo === 'object') {
      urlStr = repo.url;
      if (typeof repo.directory === 'string') subdir = repo.directory.replace(/^\/+|\/+$/g, '');
    }
    const base = normalizeRepo(urlStr);
    if (!base) return null;
    return { url: subdir ? `${base}/tree/HEAD/${subdir}` : base, source: 'package.json' };
  } catch {
    return null;
  }
}

async function tryGitConfig(dir) {
  try {
    const raw = await fsp.readFile(path.join(dir, '.git', 'config'), 'utf8');
    // Find [remote "origin"] section then its url
    const re = /\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|\s*$)/;
    const m = re.exec(raw);
    if (!m) return null;
    const urlM = /\burl\s*=\s*(.+)/.exec(m[1]);
    if (!urlM) return null;
    const url = normalizeRepo(urlM[1].trim());
    if (!url) return null;
    return { url, source: 'git' };
  } catch {
    return null;
  }
}

async function resolveGithubUrl(root) {
  if (!root || typeof root !== 'string') return null;
  if (cache.has(root)) return cache.get(root);
  const visited = [];
  let dir = path.resolve(root);
  let last = null;
  for (let i = 0; i < MAX_WALK; i++) {
    if (dir === last) break;
    if (cache.has(dir)) {
      const cached = cache.get(dir);
      for (const v of visited) cache.set(v, cached);
      cache.set(root, cached);
      return cached;
    }
    visited.push(dir);
    const [pj, gc] = await Promise.all([tryPackageJson(dir), tryGitConfig(dir)]);
    const hit = pj || gc;
    if (hit) {
      for (const v of visited) cache.set(v, hit);
      cache.set(root, hit);
      return hit;
    }
    last = dir;
    dir = path.dirname(dir);
  }
  for (const v of visited) cache.set(v, null);
  cache.set(root, null);
  return null;
}

async function resolveMany(roots) {
  const unique = [...new Set(roots.filter((r) => typeof r === 'string' && r))];
  const out = {};
  await Promise.all(unique.map(async (r) => {
    const hit = await resolveGithubUrl(r);
    if (hit) out[r] = hit;
  }));
  return out;
}

module.exports = { resolveGithubUrl, resolveMany, normalizeRepo };
