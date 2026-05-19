//#region STATE
const state = {
  sessions: [],
  currentSessionId: null,
  snapshot: null,
  search: '',
  kind: 'all',
  expanded: { context: true, tool: true, command: true, prompt: true, skill: true },
  selected: null,
  expandAll: true,
  highlight: -1,
  visibleRows: [],
};
const els = {};

function matchKey(e, ...keys) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  return keys.some((k) => e.key === k || e.code === k);
}
//#endregion

//#region UTIL
const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function highlightJson(value) {
  const json = JSON.stringify(value, null, 2);
  if (json == null) return '';
  return esc(json).replace(
    /(&quot;(?:\\.|(?!&quot;).)*&quot;)(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (m, str, colon, kw) => {
      if (str) return `<span class="jk-${colon ? 'key' : 'str'}">${str}</span>${colon ?? ''}`;
      if (kw) return `<span class="jk-${kw === 'null' ? 'null' : 'bool'}">${kw}</span>`;
      return `<span class="jk-num">${m}</span>`;
    },
  );
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function getUrlSession() {
  return new URLSearchParams(location.search).get('session');
}
function setUrlSession(id, replace = false) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('session', id);
  else url.searchParams.delete('session');
  (replace ? history.replaceState : history.pushState).call(history, null, '', url);
}

function toast(msg, kind = 'info') {
  const c = $('toast');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}
//#endregion

//#region FETCH
async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function loadSessions() {
  const data = await fetchJson('/api/sessions');
  state.sessions = data.sessions ?? [];
}

async function loadSnapshot(sessionId) {
  try {
    const qs = sessionId ? `?session=${encodeURIComponent(sessionId)}` : '';
    state.snapshot = await fetchJson(`/api/introspect${qs}`);
    state.currentSessionId = state.snapshot?.sessionId ?? sessionId ?? null;
  } catch {
    state.snapshot = null;
    state.currentSessionId = sessionId ?? null;
  }
}
//#endregion

function inferPath(x) {
  const p = x?.sourceInfo?.path;
  if (!p || typeof p !== 'string') return null;
  if (/^<.*>$/.test(p)) return null;
  return p;
}

function githubUrlFor(it) {
  const map = state.snapshot?.githubSources;
  const root = it.raw?.sourceInfo?.baseDir;
  if (!map || !root) return null;
  return map[root]?.url || null;
}

function inferSource(x) {
  const si = x?.sourceInfo;
  if (si) {
    if (si.label) return si.label;
    if (si.source) {
      const src = si.source.startsWith('npm:') ? si.source.slice(4) : si.source;
      if (src === 'auto' && si.scope) return si.scope;
      return src;
    }
    if (si.origin) return si.origin;
    if (si.kind) return si.kind;
  }
  return x?.source ?? 'builtin';
}

//#region MODEL
function buildItems() {
  const s = state.snapshot;
  if (!s) return [];
  const items = [];
  const activeSet = new Set(s.activeTools ?? []);
  const activeIds = new Set();
  for (const t of s.tools ?? []) {
    const description = (t.description ?? '').replace(/\s+/g, ' ').trim();
    const id = `tool:${t.name}`;
    activeIds.add(id);
    items.push({
      kind: 'tool',
      id,
      name: t.name ?? '(tool)',
      source: inferSource(t),
      description,
      chars: (t.description ?? '').length,
      active: activeSet.has(t.name),
      path: inferPath(t),
      raw: t,
    });
  }
  for (const c of s.commands ?? []) {
    const name = c.name ?? c.command ?? '';
    const isSkill = name.startsWith('skill:');
    const src = inferSource(c);
    const isPrompt = !isSkill && c.source === 'prompt';
    const kind = isSkill ? 'skill' : isPrompt ? 'prompt' : 'command';
    const description = (c.description ?? '').replace(/\s+/g, ' ').trim();
    const id = `${kind}:${name}`;
    activeIds.add(id);
    items.push({
      kind,
      id,
      name: `/${name}`,
      source: src,
      description,
      chars: (c.description ?? '').length,
      path: inferPath(c),
      raw: c,
    });
  }
  for (const d of s.disabledItems ?? []) {
    const id = `${d.kind}:${d.name}`;
    if (activeIds.has(id)) continue;
    const description = (d.description ?? '').replace(/\s+/g, ' ').trim();
    items.push({
      kind: d.kind,
      id,
      name: d.displayName ?? d.name,
      source: d.source ?? '(package)',
      description,
      chars: (d.description ?? '').length,
      disabled: true,
      path: d.path ?? null,
      raw: d,
    });
  }
  if (s.systemPrompt) {
    for (const part of splitSystemPrompt(s.systemPrompt, s.cwd)) {
      items.push({
        kind: 'context',
        id: `context:${part.id}`,
        name: part.name,
        source: `${part.text.length} chars`,
        description: part.text.slice(0, 240).replace(/\s+/g, ' '),
        chars: part.text.length,
        path: part.path ?? null,
        raw: { systemPrompt: part.text, path: part.path ?? null },
      });
    }
  }
  return items;
}

function fmtChars(n) {
  if (n == null) return '';
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k chars`;
}
function sumChars(list) {
  return list.reduce((a, b) => a + (b.chars || 0), 0);
}

function filterItems(items) {
  const q = state.search.trim().toLowerCase();
  return items.filter((it) => {
    if (state.kind !== 'all' && it.kind !== state.kind) return false;
    if (!q) return true;
    return (
      it.name.toLowerCase().includes(q) ||
      (it.source ?? '').toLowerCase().includes(q)
    );
  });
}

const KIND_ORDER = ['context', 'tool', 'command', 'prompt', 'skill'];
const KIND_LABEL = { context: 'Context', tool: 'Tools', command: 'Commands', prompt: 'Prompts', skill: 'Skills' };
const SOURCE_RANK = { user: 0, project: 1, auto: 2, builtin: 3 };
//#endregion

//#region ICONS
function iconFor(kind) {
  if (kind === 'tool') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>`;
  }
  if (kind === 'command') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
  }
  if (kind === 'prompt') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="13" y2="13"/></svg>`;
  }
  if (kind === 'skill') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
}
function chevronSvg() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 6 15 12 9 18"/></svg>`;
}
function highlightMarkdown(md) {
  let s = esc(md);
  s = s.replace(/^(#{1,6}\s.*)$/gm, '<span class="md-h">$1</span>');
  s = s.replace(/(```[\s\S]*?```)/g, '<span class="md-code">$1</span>');
  s = s.replace(/(`[^`\n]+`)/g, '<span class="md-icode">$1</span>');
  s = s.replace(/(\*\*[^*\n]+\*\*)/g, '<span class="md-bold">$1</span>');
  s = s.replace(/^(\s*[-*+]\s+)/gm, '<span class="md-bullet">$1</span>');
  return s;
}

function splitSystemPrompt(prompt, cwd) {
  const re = /\n(##\s+[^\n]*?(?:AGENTS|CLAUDE)\.md)\n/g;
  const hits = [];
  let m;
  while ((m = re.exec(prompt)) !== null) hits.push({ index: m.index, header: m[1], end: m.index + m[0].length });
  if (!hits.length) return [{ id: 'system-prompt', name: 'system prompt', text: prompt }];

  // Strip trailing skill-injection block from the final memory section.
  const skillMarker = prompt.search(/\nThe following skills provide specialized instructions/);
  const memoryEnd = skillMarker > 0 ? skillMarker : prompt.length;

  const parts = [];
  let sysEnd = hits[0].index;
  const ctxHeader = prompt.lastIndexOf('\n# Project Context', sysEnd);
  if (ctxHeader > 0) sysEnd = ctxHeader;
  parts.push({ id: 'system-prompt', name: 'system prompt', text: prompt.slice(0, sysEnd).trimEnd(), order: 0 });
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].end;
    const end = i + 1 < hits.length ? hits[i + 1].index : memoryEnd;
    const pathMatch = hits[i].header.match(/##\s+(.+?\.md)\s*$/);
    const fullPath = pathMatch ? pathMatch[1].trim() : '(memory)';
    const norm = fullPath.replace(/\\/g, '/').toLowerCase();
    const isUserScope = /\/\.pi\/agent\//.test(norm) || /\/\.agents\//.test(norm);
    const cwdNorm = cwd ? String(cwd).replace(/\\/g, '/').toLowerCase() : null;
    const isProject = !isUserScope && (cwdNorm ? norm.startsWith(cwdNorm) : true);
    const fileName = fullPath.split(/[\\/]/).pop() || 'memory';
    parts.push({
      id: `memory:${i}`,
      name: `${isProject ? 'project' : 'user'} · ${fileName}`,
      text: prompt.slice(start, end).trim(),
      path: fullPath,
      order: isProject ? 2 : 1,
    });
  }
  parts.sort((a, b) => a.order - b.order);
  return parts;
}

function packageSvg() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
}
//#endregion

//#region RENDER TOPBAR
function renderTopbar() {
  // Session picker
  const sel = $('sessionSelect');
  sel.innerHTML = '';
  if (!state.sessions.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(no sessions)';
    sel.appendChild(opt);
    sel.disabled = true;
  } else {
    sel.disabled = false;
    for (const s of state.sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      const label = s.name ? s.name : `${s.id.slice(0, 8)}…`;
      const cwd = s.cwd ? ` · ${basename(s.cwd)}` : '';
      opt.textContent = `${label}${cwd}`;
      if (s.id === state.currentSessionId) opt.selected = true;
      sel.appendChild(opt);
    }
  }
  // Project path
  $('projectPath').textContent = state.snapshot?.cwd ?? '—';
}
//#endregion

//#region RENDER TREE
function renderTree() {
  const root = $('treeContainer');
  const items = filterItems(buildItems());
  if (!state.snapshot) {
    root.innerHTML = `<div class="loading">No snapshot for this session. Run <code>/inspect snapshot</code> in a pi session.</div>`;
    return;
  }
  if (!items.length) {
    root.innerHTML = `<div class="loading">No items match the current filter.</div>`;
    return;
  }

  const groups = new Map();
  for (const k of KIND_ORDER) groups.set(k, []);
  for (const it of items) groups.get(it.kind).push(it);

  const html = [];
  const rows = [];
  for (const kind of KIND_ORDER) {
    const list = groups.get(kind);
    if (!list.length) continue;
    const expanded = state.expanded[kind];
    rows.push({ type: 'group', key: kind });
    const groupChars = sumChars(list);
    html.push(`
      <div class="tree-row marketplace-row" data-group="${kind}">
        <div class="tree-chevron ${expanded ? 'expanded' : ''}">${chevronSvg()}</div>
        <div class="tree-icon">${iconFor(kind)}</div>
        <div class="tree-label"><span class="mkt-name">${esc(KIND_LABEL[kind])}</span></div>
        <div class="spacer"></div>
        <div class="tree-meta">${list.length} · ${fmtChars(groupChars)}</div>
      </div>
    `);
    if (expanded) {
      const bySource = new Map();
      for (const it of list) {
        const k = it.source || '(unknown)';
        if (!bySource.has(k)) bySource.set(k, []);
        bySource.get(k).push(it);
      }
      const useSubgroups = bySource.size > 1 && kind !== 'context';
      const sources = useSubgroups
        ? [...bySource.keys()].sort((a, b) => {
            const ra = SOURCE_RANK[a] ?? Infinity;
            const rb = SOURCE_RANK[b] ?? Infinity;
            return (ra - rb) || a.localeCompare(b);
          })
        : ['__all__'];
      if (!useSubgroups) bySource.set('__all__', list);
      for (const src of sources) {
        const sublist = bySource.get(src);
        const subKey = `${kind}::${src}`;
        const subExpanded = state.expanded[subKey] !== false;
        if (useSubgroups) {
          rows.push({ type: 'subgroup', key: subKey });
          const subChars = sumChars(sublist);
          html.push(`
            <div class="tree-row marketplace-row tree-subgroup" data-subgroup="${esc(subKey)}" style="padding-left:24px">
              <div class="tree-chevron ${subExpanded ? 'expanded' : ''}">${chevronSvg()}</div>
              <div class="tree-icon">${packageSvg()}</div>
              <div class="tree-label"><span class="mkt-name">${esc(src)}</span></div>
              <div class="spacer"></div>
              <div class="tree-meta">${sublist.length} · ${fmtChars(subChars)}</div>
            </div>
          `);
        }
        if (!useSubgroups || subExpanded) {
          for (const it of sublist) {
            const selected = state.selected === it.id ? 'selected' : '';
            const pad = useSubgroups ? 48 : 32;
            rows.push({ type: 'item', key: it.id });
            const descHtml = it.description
              ? `<span class="tree-desc">${esc(it.description)}</span><div class="spacer"></div>`
              : '<div class="spacer"></div>';
            const disabledCls = it.disabled ? ' disabled' : '';
            html.push(`
              <div class="tree-row ${selected}${disabledCls}" data-item="${esc(it.id)}" style="padding-left:${pad}px">
                <div class="tree-icon">${iconFor(it.kind)}</div>
                <div class="tree-label">${esc(it.name)}</div>
                ${descHtml}
                <div class="tree-meta">${esc(it.source)}</div>
              </div>
            `);
          }
        }
      }
    }
  }
  root.innerHTML = html.join('');
  state.visibleRows = rows;
  if (state.highlight >= rows.length) state.highlight = rows.length - 1;
  if (state.highlight >= 0) {
    const el = root.children[state.highlight];
    if (el) el.classList.add('focused');
  }

  root.querySelectorAll('.tree-row[data-group]').forEach((el) => {
    el.addEventListener('click', () => {
      const k = el.dataset.group;
      state.expanded[k] = !state.expanded[k];
      renderTree();
    });
  });
  root.querySelectorAll('.tree-row[data-subgroup]').forEach((el) => {
    el.addEventListener('click', () => {
      const k = el.dataset.subgroup;
      state.expanded[k] = state.expanded[k] === false;
      renderTree();
    });
  });
  root.querySelectorAll('.tree-row[data-item]').forEach((el) => {
    el.addEventListener('click', () => {
      state.selected = el.dataset.item;
      state.highlight = -1;
      renderTree();
      renderDetail();
    });
  });
}
//#endregion

//#region RENDER DETAIL
function renderDetail() {
  const panel = $('detailPanel');
  if (!state.selected || !state.snapshot) {
    panel.innerHTML = `
      <div class="detail-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        <span>Select an item to view details</span>
      </div>`;
    return;
  }
  const items = buildItems();
  const it = items.find((x) => x.id === state.selected);
  if (!it) {
    panel.innerHTML = `<div class="detail-empty"><span>Item not found in current snapshot.</span></div>`;
    return;
  }

  const isPrompt = it.kind === 'context' && it.raw?.systemPrompt;
  const bodySections = [];

  if (it.description && !isPrompt) {
    bodySections.push(`
      <div class="detail-section">
        <h4>Description</h4>
        <div class="detail-desc">${esc(it.description)}</div>
      </div>
    `);
  }

  const scope = it.raw?.scope;
  const settingsPath = it.raw?.settingsPath;
  bodySections.push(`
    <div class="detail-section">
      <h4>Metadata</h4>
      <div class="detail-meta-row">
        <span class="detail-meta-item">Kind: ${esc(it.kind)}</span>
        <span class="detail-meta-item">Source: ${esc(it.source)}</span>
        ${it.active != null ? `<span class="detail-meta-item">Active: ${it.active ? 'yes' : 'no'}</span>` : ''}
        ${it.disabled ? `<span class="detail-meta-item">Disabled${scope ? ` (${esc(scope)})` : ''}</span>` : ''}
        ${settingsPath ? `<span class="detail-meta-item">Settings: ${esc(settingsPath)}</span>` : ''}
      </div>
    </div>
  `);

  if (isPrompt) {
    bodySections.push(`
      <div class="detail-section">
        <h4>System prompt (${it.raw.systemPrompt.length} chars)</h4>
        <pre class="content-viewer-code"><code class="md">${highlightMarkdown(it.raw.systemPrompt)}</code></pre>
      </div>
    `);
  } else {
    bodySections.push(`
      <div class="detail-section">
        <h4>Raw</h4>
        <pre class="content-viewer-code"><code class="json">${highlightJson(it.raw)}</code></pre>
      </div>
    `);
  }

  const ghUrl = githubUrlFor(it);
  panel.innerHTML = `
    <div class="detail-header">
      <h3>${iconFor(it.kind)} ${esc(it.name)} <span class="version">${esc(it.kind)}</span></h3>
      <div class="detail-header-actions">
        ${it.path ? `<button class="detail-action" id="openEditorBtn" title="Open in $EDITOR"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>` : ''}
        ${it.path ? `<button class="detail-action" id="copyPathBtn" title="Copy path"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>` : ''}
        ${ghUrl ? `<button class="detail-action" id="openGithubBtn" title="Open on GitHub"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.27-1.68-1.27-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.96 10.96 0 015.74 0c2.18-1.49 3.14-1.18 3.14-1.18.63 1.59.23 2.76.11 3.05.74.81 1.18 1.84 1.18 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.68.8.56C20.21 21.38 23.5 17.07 23.5 12 23.5 5.65 18.35.5 12 .5z"/></svg></button>` : ''}
        <button class="detail-close" id="detailCloseBtn" title="Close">&#10005;</button>
      </div>
    </div>
    <div class="detail-body">${bodySections.join('')}</div>
  `;
  $('detailCloseBtn').addEventListener('click', () => {
    state.selected = null;
    renderTree();
    renderDetail();
  });
  const openBtn = $('openEditorBtn');
  if (openBtn) openBtn.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: it.path }),
      });
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        toast(`Failed: server returned ${r.status} — restart pi-inspect server`);
        return;
      }
      const j = await r.json();
      toast(j.ok ? `Opened in ${j.editor}` : `Failed: ${j.error || 'unknown'}`);
    } catch (e) { toast(`Failed: ${e.message}`); }
  });
  const copyBtn = $('copyPathBtn');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(it.path); toast('Path copied'); }
    catch { toast('Copy failed'); }
  });
  const ghBtn = $('openGithubBtn');
  if (ghBtn && ghUrl) ghBtn.addEventListener('click', () => {
    window.open(ghUrl, '_blank', 'noopener');
  });
}
//#endregion

//#region EVENTS
function bindResize() {
  const handle = $('resizeHandle');
  const panel = $('treePanel');
  let dragging = false;
  handle.addEventListener('mousedown', () => {
    dragging = true;
    handle.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const layout = panel.parentElement;
    const rect = layout.getBoundingClientRect();
    const w = Math.max(220, Math.min(rect.width - 280, e.clientX - rect.left));
    panel.style.flex = `0 0 ${w}px`;
    try { localStorage.setItem('inspect.sidebarW', String(w)); } catch {}
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
  try {
    const w = Number(localStorage.getItem('inspect.sidebarW'));
    if (w >= 220) panel.style.flex = `0 0 ${w}px`;
  } catch {}
}

function bindEvents() {
  $('sessionSelect').addEventListener('change', async (e) => {
    const id = e.target.value || null;
    setUrlSession(id);
    await loadSnapshot(id);
    state.selected = null;
    renderTopbar();
    renderTree();
    renderDetail();
  });

  $('kindFilter').addEventListener('change', (e) => {
    state.kind = e.target.value;
    renderTree();
  });

  $('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderTree();
  });

  $('refreshBtn').addEventListener('click', async () => {
    const btn = $('refreshBtn');
    btn.classList.add('loading');
    await loadSessions();
    await loadSnapshot(state.currentSessionId);
    renderTopbar();
    renderTree();
    renderDetail();
    setTimeout(() => btn.classList.remove('loading'), 200);
    toast('refreshed');
  });

  $('cleanupSessionsBtn').addEventListener('click', async () => {
    const keep = state.currentSessionId;
    if (!keep) { toast('select a session first'); return; }
    const others = state.sessions.filter((s) => s.id !== keep).length;
    if (!others) { toast('only one session — nothing to remove'); return; }
    if (!confirm(`Delete ${others} other snapshot${others === 1 ? '' : 's'} and keep only the selected session?`)) return;
    const btn = $('cleanupSessionsBtn');
    btn.classList.add('loading');
    try {
      const r = await fetch('/api/sessions/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keep }),
      });
      const data = await r.json();
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      const n = data.removed?.length ?? 0;
      await loadSessions();
      renderTopbar();
      toast(n ? `removed ${n} session${n === 1 ? '' : 's'}` : 'nothing to remove');
    } catch (e) {
      toast(`cleanup failed: ${e.message}`);
    } finally {
      btn.classList.remove('loading');
    }
  });

  $('themeBtn').addEventListener('click', () => {
    document.body.classList.toggle('light');
    try {
      localStorage.setItem('inspect.theme', document.body.classList.contains('light') ? 'light' : 'dark');
    } catch {}
  });

  $('expandToggle').addEventListener('click', () => {
    state.expandAll = !state.expandAll;
    for (const k of KIND_ORDER) state.expanded[k] = state.expandAll;
    const subKeys = new Set(Object.keys(state.expanded).filter((k) => k.includes('::')));
    for (const it of buildItems()) subKeys.add(`${it.kind}::${it.source || '(unknown)'}`);
    for (const key of subKeys) {
      if (state.expandAll) delete state.expanded[key];
      else state.expanded[key] = false;
    }
    $('expandToggle').textContent = state.expandAll ? 'Collapse all' : 'Expand all';
    renderTree();
  });

  window.addEventListener('popstate', async () => {
    await loadSnapshot(getUrlSession());
    renderTopbar();
    renderTree();
    renderDetail();
  });

  window.addEventListener('keydown', handleKeydown);

  document.addEventListener('selectionchange', () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return;
    const node = sel.anchorNode;
    const host = node?.nodeType === 1 ? node : node?.parentElement;
    const row = host?.closest?.('.tree-row[data-item]');
    if (!row) return;
    const id = row.dataset.item;
    const root = $('treeContainer');
    const idx = Array.prototype.indexOf.call(root.children, row);
    if (idx >= 0) state.highlight = idx;
    if (state.selected !== id) {
      state.selected = id;
      renderTree();
      renderDetail();
    }
    row.scrollIntoView({ block: 'nearest' });
  });

  $('shortcutsBtn').addEventListener('click', showHelpModal);
  $('helpCloseBtn').addEventListener('click', hideHelpModal);
  $('helpModal').addEventListener('click', (e) => {
    if (e.target === $('helpModal')) hideHelpModal();
  });
}

function moveHighlight(delta) {
  const rows = state.visibleRows;
  if (!rows.length) return;
  const prev = state.highlight;
  let idx = prev;
  if (idx < 0) {
    const selIdx = state.selected ? rows.findIndex((r) => r.type === 'item' && r.key === state.selected) : -1;
    if (selIdx >= 0) idx = Math.max(0, Math.min(rows.length - 1, selIdx + delta));
    else idx = delta > 0 ? 0 : rows.length - 1;
  } else idx = Math.max(0, Math.min(rows.length - 1, idx + delta));
  if (idx === prev) return;
  state.highlight = idx;
  const root = $('treeContainer');
  if (prev >= 0) root.children[prev]?.classList.remove('focused');
  const el = root.children[idx];
  if (el) {
    el.classList.add('focused');
    el.scrollIntoView({ block: 'nearest' });
  }
}

function activateHighlight() {
  const r = state.visibleRows[state.highlight];
  if (!r) return;
  const root = $('treeContainer');
  const el = root.children[state.highlight];
  if (el) el.click();
}

function expandAtHighlight(open) {
  const r = state.visibleRows[state.highlight];
  if (!r) return;
  if (r.type === 'group') {
    state.expanded[r.key] = open;
    renderTree();
  } else if (r.type === 'subgroup') {
    if (open) delete state.expanded[r.key];
    else state.expanded[r.key] = false;
    renderTree();
  } else if (r.type === 'item' && !open) {
    for (let i = state.highlight - 1; i >= 0; i--) {
      if (state.visibleRows[i].type === 'group' || state.visibleRows[i].type === 'subgroup') {
        state.highlight = i;
        renderTree();
        break;
      }
    }
  }
}

function showHelpModal() { $('helpModal').classList.add('open'); }
function hideHelpModal() { $('helpModal').classList.remove('open'); }
function isHelpOpen() { return $('helpModal')?.classList.contains('open'); }

function handleKeydown(e) {
  if (isHelpOpen()) {
    if (e.key === 'Escape' || e.key === '?') {
      e.preventDefault();
      hideHelpModal();
    }
    return;
  }
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') {
      e.target.blur();
      e.preventDefault();
    }
    return;
  }
  if (e.key === '?') { e.preventDefault(); showHelpModal(); return; }
  if (matchKey(e, '/')) { e.preventDefault(); $('searchInput').focus(); return; }
  if (matchKey(e, 'f', 'F')) { e.preventDefault(); $('kindFilter').focus(); return; }
  if (matchKey(e, 'r', 'R')) { e.preventDefault(); $('refreshBtn').click(); return; }
  if (matchKey(e, 't', 'T')) { e.preventDefault(); $('themeBtn').click(); return; }
  if (matchKey(e, 'e', 'E')) { e.preventDefault(); $('expandToggle').click(); return; }
  if (matchKey(e, 'j', 'ArrowDown')) { e.preventDefault(); moveHighlight(1); return; }
  if (matchKey(e, 'k', 'ArrowUp')) { e.preventDefault(); moveHighlight(-1); return; }
  if (matchKey(e, 'l', 'ArrowRight')) { e.preventDefault(); expandAtHighlight(true); return; }
  if (matchKey(e, 'h', 'ArrowLeft')) { e.preventDefault(); expandAtHighlight(false); return; }
  if (matchKey(e, 'Enter', ' ', 'Space')) { e.preventDefault(); activateHighlight(); return; }
  if (e.key === 'Escape') {
    if (state.selected) { state.selected = null; renderTree(); renderDetail(); }
  }
}

function bindSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', async () => {
    await loadSessions();
    await loadSnapshot(state.currentSessionId);
    renderTopbar();
    renderTree();
    renderDetail();
  });
  es.addEventListener('navigate', async (ev) => {
    try {
      const { session } = JSON.parse(ev.data);
      const sid = session || (state.sessions[0] && state.sessions[0].id);
      if (!sid) return;
      const u = new URL(window.location.href);
      u.searchParams.set('session', sid);
      window.history.replaceState({}, '', u);
      state.currentSessionId = sid;
      await loadSnapshot(sid);
      renderTopbar();
      renderTree();
      renderDetail();
      try { window.focus(); } catch {}
    } catch {}
  });
  es.onerror = () => {};
}
//#endregion

//#region INIT
(async function init() {
  try {
    if (localStorage.getItem('inspect.theme') === 'light') document.body.classList.add('light');
  } catch {}

  bindResize();
  bindEvents();

  await loadSessions();
  const requested = getUrlSession();
  await loadSnapshot(requested);
  if (state.currentSessionId && !requested) setUrlSession(state.currentSessionId, true);

  if (state.snapshot?.systemPrompt) {
    const firstCtx = buildItems().find((x) => x.kind === 'context');
    if (firstCtx) state.selected = firstCtx.id;
  }

  renderTopbar();
  renderTree();
  renderDetail();
  bindSse();
})();
//#endregion
