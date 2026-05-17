//#region STATE
const state = {
  sessions: [],
  currentSessionId: null,
  snapshot: null,
  search: '',
  kind: 'all',
  expanded: { context: true, tool: true, command: true, skill: true },
  selected: null,
  expandAll: true,
};
const els = {};
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

function inferSource(x) {
  const si = x?.sourceInfo;
  if (si) {
    if (si.label) return si.label;
    if (si.source) return si.source.startsWith('npm:') ? si.source.slice(4) : si.source;
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
  for (const t of s.tools ?? []) {
    items.push({
      kind: 'tool',
      id: `tool:${t.name}`,
      name: t.name ?? '(tool)',
      source: inferSource(t),
      description: t.description ?? '',
      active: (s.activeTools ?? []).includes(t.name),
      path: inferPath(t),
      raw: t,
    });
  }
  for (const c of s.commands ?? []) {
    const name = c.name ?? c.command ?? '';
    const isSkill = name.startsWith('skill:');
    items.push({
      kind: isSkill ? 'skill' : 'command',
      id: `${isSkill ? 'skill' : 'command'}:${name}`,
      name: `/${name}`,
      source: inferSource(c),
      description: c.description ?? '',
      path: inferPath(c),
      raw: c,
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
        path: part.path ?? null,
        raw: { systemPrompt: part.text, path: part.path ?? null },
      });
    }
  }
  return items;
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

const KIND_ORDER = ['context', 'tool', 'command', 'skill'];
const KIND_LABEL = { context: 'Context', tool: 'Tools', command: 'Commands', skill: 'Skills' };
//#endregion

//#region ICONS
function iconFor(kind) {
  if (kind === 'tool') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>`;
  }
  if (kind === 'command') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`;
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
  for (const kind of KIND_ORDER) {
    const list = groups.get(kind);
    if (!list.length) continue;
    const expanded = state.expanded[kind];
    html.push(`
      <div class="tree-row marketplace-row" data-group="${kind}">
        <div class="tree-chevron ${expanded ? 'expanded' : ''}">${chevronSvg()}</div>
        <div class="tree-icon">${iconFor(kind)}</div>
        <div class="tree-label"><span class="mkt-name">${esc(KIND_LABEL[kind])}</span></div>
        <div class="spacer"></div>
        <div class="tree-meta">${list.length}</div>
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
            if (a === 'builtin') return -1;
            if (b === 'builtin') return 1;
            return a.localeCompare(b);
          })
        : ['__all__'];
      if (!useSubgroups) bySource.set('__all__', list);
      for (const src of sources) {
        const sublist = bySource.get(src);
        const subKey = `${kind}::${src}`;
        const subExpanded = state.expanded[subKey] !== false;
        if (useSubgroups) {
          html.push(`
            <div class="tree-row marketplace-row tree-subgroup" data-subgroup="${esc(subKey)}" style="padding-left:24px">
              <div class="tree-chevron ${subExpanded ? 'expanded' : ''}">${chevronSvg()}</div>
              <div class="tree-icon">${packageSvg()}</div>
              <div class="tree-label"><span class="mkt-name">${esc(src)}</span></div>
              <div class="spacer"></div>
              <div class="tree-meta">${sublist.length}</div>
            </div>
          `);
        }
        if (!useSubgroups || subExpanded) {
          for (const it of sublist) {
            const selected = state.selected === it.id ? 'selected' : '';
            const pad = useSubgroups ? 48 : 32;
            html.push(`
              <div class="tree-row ${selected}" data-item="${esc(it.id)}" style="padding-left:${pad}px">
                <div class="tree-icon">${iconFor(it.kind)}</div>
                <div class="tree-label">${esc(it.name)}</div>
                <div class="spacer"></div>
                <div class="tree-meta">${esc(it.source)}</div>
              </div>
            `);
          }
        }
      }
    }
  }
  root.innerHTML = html.join('');

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

  bodySections.push(`
    <div class="detail-section">
      <h4>Metadata</h4>
      <div class="detail-meta-row">
        <span class="detail-meta-item">Kind: ${esc(it.kind)}</span>
        <span class="detail-meta-item">Source: ${esc(it.source)}</span>
        ${it.active != null ? `<span class="detail-meta-item">Active: ${it.active ? 'yes' : 'no'}</span>` : ''}
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

  panel.innerHTML = `
    <div class="detail-header">
      <h3>${iconFor(it.kind)} ${esc(it.name)} <span class="version">${esc(it.kind)}</span></h3>
      <div class="detail-header-actions">
        ${it.path ? `<button class="detail-action" id="openEditorBtn" title="Open in $EDITOR"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></button>` : ''}
        ${it.path ? `<button class="detail-action" id="copyPathBtn" title="Copy path"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>` : ''}
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

  $('themeBtn').addEventListener('click', () => {
    document.body.classList.toggle('light');
    try {
      localStorage.setItem('inspect.theme', document.body.classList.contains('light') ? 'light' : 'dark');
    } catch {}
  });

  $('expandToggle').addEventListener('click', () => {
    state.expandAll = !state.expandAll;
    for (const k of KIND_ORDER) state.expanded[k] = state.expandAll;
    $('expandToggle').textContent = state.expandAll ? 'Collapse all' : 'Expand all';
    renderTree();
  });

  window.addEventListener('popstate', async () => {
    await loadSnapshot(getUrlSession());
    renderTopbar();
    renderTree();
    renderDetail();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'SELECT') return;
    if (e.key === '/') { e.preventDefault(); $('searchInput').focus(); }
    else if (e.key === 'r' || e.key === 'R') $('refreshBtn').click();
    else if (e.key === 't' || e.key === 'T') $('themeBtn').click();
    else if (e.key === 'Escape') { state.selected = null; renderTree(); renderDetail(); }
  });
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
