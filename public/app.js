//#region STATE
const state = {
  sessions: [],
  currentSessionId: null,
  snapshot: null,
  search: '',
  kind: 'all',
  collapsed: new Set(),
  selected: null,
  expandAll: true,
  highlight: -1,
  visibleRows: [],
  staticMode: false,
};
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

function highlightMarkdown(md) {
  let s = esc(md);
  s = s.replace(/^(#{1,6}\s.*)$/gm, '<span class="md-h">$1</span>');
  s = s.replace(/(```[\s\S]*?```)/g, '<span class="md-code">$1</span>');
  s = s.replace(/(`[^`\n]+`)/g, '<span class="md-icode">$1</span>');
  s = s.replace(/(\*\*[^*\n]+\*\*)/g, '<span class="md-bold">$1</span>');
  s = s.replace(/^(\s*[-*+]\s+)/gm, '<span class="md-bullet">$1</span>');
  return s;
}

function basename(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function shortId(id) {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
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
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  $('toast').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function fmtChars(n) {
  if (n == null) return '';
  if (n < 1000) return `${n} chars`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k chars`;
}
function sumChars(list) {
  return list.reduce((a, b) => a + (b.chars || 0), 0);
}
//#endregion

//#region FETCH
async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function postJson(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!(r.headers.get('content-type') || '').includes('application/json')) {
    throw new Error(`server returned ${r.status}; restart the pi-inspect server`);
  }
  const j = await r.json();
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
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

//#region MODEL
const KIND_ORDER = ['context', 'tool', 'command', 'prompt', 'skill'];
const CHIP_KINDS = ['all', ...KIND_ORDER];
const KIND_LABEL = { all: 'All', context: 'Context', tool: 'Tools', command: 'Commands', prompt: 'Prompts', skill: 'Skills' };
const SOURCE_RANK = { user: 0, project: 1, auto: 2, builtin: 3 };

// Same rule as sourceLabel() in extensions/inspect.ts, so active and disabled items of one package group together.
function packageName(source) {
  if (source.startsWith('npm:')) return source.slice(4);
  const norm = source.replace(/\\/g, '/').replace(/\/$/, '');
  return norm.split('/').pop() || norm;
}

function inferPath(x) {
  const p = x?.sourceInfo?.path;
  if (!p || typeof p !== 'string') return null;
  if (/^<.*>$/.test(p) || /^[a-z][\w-]+:/i.test(p)) return null;
  return p;
}

function inferSource(x) {
  const si = x?.sourceInfo;
  if (si) {
    if (si.label) return si.label;
    if (si.source) {
      if (si.source === 'auto' && si.scope) return si.scope;
      return packageName(si.source);
    }
    if (si.origin) return si.origin;
    if (si.kind) return si.kind;
  }
  return x?.source ?? 'builtin';
}

function githubUrlFor(it) {
  const map = state.snapshot?.githubSources;
  const root = it.raw?.sourceInfo?.baseDir;
  if (!map || !root) return null;
  return map[root]?.url || null;
}

function normPath(p) {
  if (!p || typeof p !== 'string') return null;
  return p.replace(/\\/g, '/').toLowerCase();
}

const oneLine = (s) => (s ?? '').replace(/\s+/g, ' ').trim();
const textInfo = (text) => ({ description: oneLine(text), chars: (text ?? '').length });
const subgroupKey = (kind, source) => `${kind}::${source || '(unknown)'}`;

let itemsCache = { snapshot: null, items: [] };
function getItems() {
  if (itemsCache.snapshot !== state.snapshot) itemsCache = { snapshot: state.snapshot, items: buildItems(state.snapshot) };
  return itemsCache.items;
}

function buildItems(s) {
  if (!s) return [];
  const items = [];
  const activeSet = new Set(s.activeTools ?? []);
  const activeIds = new Set();
  // pi.getCommands() is frozen at session boot. After a toggle, the SDK-resolved
  // disabledItems is the source of truth — drop any active command whose path
  // matches a disabled resource so the UI reflects the post-toggle state.
  const disabledPaths = new Set(
    (s.disabledItems ?? []).map((d) => normPath(d.path)).filter(Boolean),
  );
  for (const t of s.tools ?? []) {
    const id = `tool:${t.name}`;
    activeIds.add(id);
    items.push({
      kind: 'tool',
      id,
      name: t.name ?? '(tool)',
      source: inferSource(t),
      ...textInfo(t.description),
      active: activeSet.has(t.name),
      path: inferPath(t),
      raw: t,
    });
  }
  for (const c of s.commands ?? []) {
    const cp = normPath(c?.sourceInfo?.path);
    if (cp && disabledPaths.has(cp)) continue;
    const name = c.name ?? c.command ?? '';
    const isSkill = name.startsWith('skill:');
    const isPrompt = !isSkill && c.source === 'prompt';
    const kind = isSkill ? 'skill' : isPrompt ? 'prompt' : 'command';
    const id = `${kind}:${isSkill ? name.slice('skill:'.length) : name}`;
    activeIds.add(id);
    items.push({
      kind,
      id,
      name: `/${name}`,
      source: inferSource(c),
      ...textInfo(c.description),
      path: inferPath(c),
      raw: c,
    });
  }
  for (const [list, flag] of [[s.disabledItems, 'disabled'], [s.pendingItems, 'pending']]) {
    for (const d of list ?? []) {
      const id = `${d.kind}:${d.name}`;
      if (activeIds.has(id)) continue;
      items.push({
        kind: d.kind,
        id,
        name: d.displayName ?? d.name,
        source: d.source ?? '(package)',
        ...textInfo(d.description),
        [flag]: true,
        path: d.path ?? null,
        raw: d,
      });
    }
  }
  if (s.systemPrompt) {
    for (const part of splitSystemPrompt(s.systemPrompt, s.cwd)) {
      items.push({
        kind: 'context',
        id: `context:${part.id}`,
        name: part.name,
        description: oneLine(part.text.slice(0, 240)),
        chars: part.text.length,
        path: part.path ?? null,
        raw: { systemPrompt: part.text, path: part.path ?? null },
      });
    }
  }
  return items;
}

function splitSystemPrompt(prompt, cwd) {
  // New XML format
  const ctxOpen = '<project_context>';
  const ctxClose = '</project_context>';
  const ctxStart = prompt.indexOf(ctxOpen);
  const ctxEnd = ctxStart >= 0 ? prompt.indexOf(ctxClose, ctxStart + ctxOpen.length) : -1;

  if (ctxStart >= 0 && ctxEnd > ctxStart) {
    const parts = [];
    parts.push({ id: 'system-prompt', name: 'system prompt', text: prompt.slice(0, ctxStart).trimEnd(), order: 0 });

    const inner = prompt.slice(ctxStart + ctxOpen.length, ctxEnd);

    const instrRe = /<project_instructions\s+path="([^"]+)">\n?([\s\S]*?)\n?<\/project_instructions>/g;
    let match;
    let idx = 0;
    while ((match = instrRe.exec(inner)) !== null) {
      const fullPath = match[1];
      const content = match[2].trim();
      const norm = fullPath.replace(/\\/g, '/').toLowerCase();
      const isUserScope = /\/\.pi\/agent\//.test(norm) || /\/\.agents\//.test(norm);
      const cwdNorm = cwd ? String(cwd).replace(/\\/g, '/').toLowerCase() : null;
      const isProject = !isUserScope && (cwdNorm ? norm.startsWith(cwdNorm) : true);
      const fileName = fullPath.split(/[\\/]/).pop() || 'memory';
      parts.push({
        id: `memory:${idx}`,
        name: `${isProject ? 'project' : 'user'} · ${fileName}`,
        text: content,
        path: fullPath,
        order: isProject ? 2 : 1,
      });
      idx++;
    }

    if (idx > 0) {
      parts.sort((a, b) => a.order - b.order);
      return parts;
    }
  }

  // Fall back to old Markdown-based format:
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
  const cwdNorm = normPath(cwd);
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].end;
    const end = i + 1 < hits.length ? hits[i + 1].index : memoryEnd;
    const pathMatch = hits[i].header.match(/##\s+(.+?\.md)\s*$/);
    const fullPath = pathMatch ? pathMatch[1].trim() : '(memory)';
    const norm = normPath(fullPath);
    const isUserScope = /\/\.pi\/agent\//.test(norm) || /\/\.agents\//.test(norm);
    const isProject = !isUserScope && (cwdNorm ? norm.startsWith(cwdNorm) : true);
    parts.push({
      id: `memory:${i}`,
      name: `${isProject ? 'project' : 'user'} · ${basename(fullPath) || 'memory'}`,
      text: prompt.slice(start, end).trim(),
      path: fullPath,
      order: isProject ? 2 : 1,
    });
  }
  parts.sort((a, b) => a.order - b.order);
  return parts;
}

function matchesSearch(items) {
  const q = state.search.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => it.name.toLowerCase().includes(q) || (it.source ?? '').toLowerCase().includes(q));
}

function defaultSelection() {
  return getItems().find((x) => x.kind === 'context')?.id ?? null;
}
//#endregion

//#region ICONS
const ICONS = {
  tool: '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>',
  command: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  prompt: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="13" y2="13"/>',
  skill: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  context: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  package: '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  chevron: '<polyline points="9 6 15 12 9 18"/>',
  editor: '<path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
  github: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${ICONS[name] ?? ICONS.context}</svg>`;
//#endregion

//#region RENDER TOPBAR
function renderTopbar() {
  const sel = $('sessionSelect');
  const id = state.currentSessionId;
  const options = state.sessions.map((s) => ({
    id: s.id,
    label: `${s.name || shortId(s.id)}${s.cwd ? ` · ${basename(s.cwd)}` : ''}`,
  }));
  if (id && !state.sessions.some((s) => s.id === id)) options.unshift({ id, label: `${shortId(id)} · not captured` });
  sel.innerHTML = options.length
    ? options.map((o) => `<option value="${esc(o.id)}"${o.id === id ? ' selected' : ''}>${esc(o.label)}</option>`).join('')
    : '<option value="">No sessions</option>';
  sel.disabled = !options.length;
  $('projectPath').textContent = state.snapshot?.cwd ?? '—';
}

function renderChips(matched) {
  const counts = { all: matched.length };
  for (const it of matched) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
  $('kindChips').innerHTML = CHIP_KINDS.map((k, i) => {
    const on = state.kind === k;
    return `<button class="chip${on ? ' active' : ''}" role="radio" aria-checked="${on}" data-kind="${k}" title="${KIND_LABEL[k]} (${i})">
      <kbd>${i}</kbd><span>${KIND_LABEL[k]}</span><span class="chip-count">${counts[k] ?? 0}</span>
    </button>`;
  }).join('');
}
//#endregion

//#region RENDER TREE
function emptyStateHtml() {
  if (state.staticMode) return 'No snapshot in this link. Open a share link, or run pi with pi-inspect loaded.';
  const id = state.currentSessionId;
  if (!id) {
    return state.sessions.length
      ? 'Cannot read the latest snapshot.'
      : 'No snapshots yet. Start pi with pi-inspect loaded, or run <code>/inspect snapshot</code> in a pi session.';
  }
  if (!state.sessions.some((s) => s.id === id)) {
    return `<strong>Session ${esc(shortId(id))} was not captured.</strong>
      pi-inspect captures a session when it starts with the extension loaded.
      To capture this session now, run <code>/inspect snapshot</code> in it.`;
  }
  return 'The snapshot for this session is missing or cannot be read. Run <code>/inspect snapshot</code> in the session.';
}

function groupRow(index, label, iconName, list, level, expanded, key) {
  return `
    <div class="tree-row tree-group level-${level}" id="row-${index}" data-index="${index}" role="treeitem" aria-level="${level}" aria-expanded="${expanded}" data-key="${esc(key)}">
      <span class="tree-chevron">${icon('chevron')}</span>
      <span class="tree-icon">${icon(iconName)}</span>
      <span class="tree-label">${esc(label)}</span>
      <span class="spacer"></span>
      <span class="tree-meta">${list.length} · ${fmtChars(sumChars(list))}</span>
    </div>`;
}

function itemRow(index, it, level) {
  const cls = [it.disabled && 'disabled', state.selected === it.id && 'selected'].filter(Boolean).join(' ');
  const meta = it.kind === 'context' ? fmtChars(it.chars) : it.source;
  const badge = it.disabled
    ? '<span class="tree-badge">disabled</span>'
    : it.pending
      ? '<span class="tree-badge warn" title="Enabled in settings, active after a pi restart">restart pi</span>'
      : '';
  return `
    <div class="tree-row level-${level} ${cls}" id="row-${index}" data-index="${index}" role="treeitem" aria-level="${level}" aria-selected="${state.selected === it.id}" data-key="${esc(it.id)}">
      <span class="tree-icon">${icon(it.kind)}</span>
      <span class="tree-label">${esc(it.name)}</span>${badge}
      <span class="tree-desc">${esc(it.description)}</span>
      ${level < 3 ? `<span class="tree-meta">${esc(meta)}</span>` : ''}
    </div>`;
}

function renderTree() {
  const root = $('treeContainer');
  const matched = matchesSearch(getItems());
  renderChips(matched);
  const rows = [];
  const html = [];
  state.visibleRows = rows;
  if (!state.snapshot) {
    root.innerHTML = `<div class="empty-state">${emptyStateHtml()}</div>`;
    return;
  }
  const items = state.kind === 'all' ? matched : matched.filter((it) => it.kind === state.kind);
  if (!items.length) {
    root.innerHTML = '<div class="empty-state">No items match the filter.</div>';
    return;
  }

  for (const kind of KIND_ORDER) {
    const list = items.filter((it) => it.kind === kind);
    if (!list.length) continue;
    const expanded = !state.collapsed.has(kind);
    html.push(groupRow(rows.length, KIND_LABEL[kind], kind, list, 1, expanded, kind));
    rows.push({ type: 'group', key: kind });
    if (!expanded) continue;

    const bySource = new Map();
    for (const it of list) {
      const k = it.source || '(unknown)';
      if (!bySource.has(k)) bySource.set(k, []);
      bySource.get(k).push(it);
    }
    if (bySource.size <= 1 || kind === 'context') {
      for (const it of list) {
        html.push(itemRow(rows.length, it, 2));
        rows.push({ type: 'item', key: it.id });
      }
      continue;
    }
    const sources = [...bySource.keys()].sort(
      (a, b) => ((SOURCE_RANK[a] ?? Infinity) - (SOURCE_RANK[b] ?? Infinity)) || a.localeCompare(b),
    );
    for (const src of sources) {
      const sublist = bySource.get(src);
      const subKey = subgroupKey(kind, src);
      const subExpanded = !state.collapsed.has(subKey);
      html.push(groupRow(rows.length, src, 'package', sublist, 2, subExpanded, subKey));
      rows.push({ type: 'subgroup', key: subKey });
      if (!subExpanded) continue;
      for (const it of sublist) {
        html.push(itemRow(rows.length, it, 3));
        rows.push({ type: 'item', key: it.id });
      }
    }
  }
  root.innerHTML = html.join('');
  if (state.highlight >= rows.length) state.highlight = rows.length - 1;
  paintHighlight();
}

function paintHighlight() {
  const root = $('treeContainer');
  root.querySelector('.tree-row.focused')?.classList.remove('focused');
  const el = state.highlight >= 0 ? root.children[state.highlight] : null;
  if (el?.classList.contains('tree-row')) {
    el.classList.add('focused');
    root.setAttribute('aria-activedescendant', el.id);
    el.scrollIntoView({ block: 'nearest' });
  } else {
    root.removeAttribute('aria-activedescendant');
  }
}

function selectItem(id) {
  state.selected = id;
  for (const el of $('treeContainer').querySelectorAll('.tree-row[aria-selected]')) {
    const on = el.dataset.key === id;
    el.classList.toggle('selected', on);
    el.setAttribute('aria-selected', String(on));
  }
  renderDetail();
}

function activateRow(idx) {
  const r = state.visibleRows[idx];
  if (!r) return;
  state.highlight = idx;
  if (r.type === 'item') {
    paintHighlight();
    selectItem(r.key);
    return;
  }
  setExpanded(r.key, state.collapsed.has(r.key));
}

function setExpanded(key, open) {
  if (open) state.collapsed.delete(key);
  else state.collapsed.add(key);
  renderTree();
}

function setHighlight(idx) {
  const rows = state.visibleRows;
  if (!rows.length) return;
  state.highlight = Math.max(0, Math.min(rows.length - 1, idx));
  paintHighlight();
  const r = rows[state.highlight];
  if (r.type === 'item' && r.key !== state.selected) selectItem(r.key);
}

function moveHighlight(delta) {
  const rows = state.visibleRows;
  if (!rows.length) return;
  let idx = state.highlight;
  if (idx < 0) {
    const sel = rows.findIndex((r) => r.type === 'item' && r.key === state.selected);
    idx = sel >= 0 ? sel + delta : delta > 0 ? 0 : rows.length - 1;
  } else idx += delta;
  setHighlight(idx);
}

function expandAtHighlight(open) {
  const r = state.visibleRows[state.highlight];
  if (!r) return;
  if (r.type === 'item') {
    if (open) return;
    for (let i = state.highlight - 1; i >= 0; i--) {
      if (state.visibleRows[i].type !== 'item') return setHighlight(i);
    }
    return;
  }
  if (state.collapsed.has(r.key) !== open) {
    if (open) setHighlight(state.highlight + 1);
    else if (r.type === 'subgroup') {
      for (let i = state.highlight - 1; i >= 0; i--) {
        if (state.visibleRows[i].type === 'group') return setHighlight(i);
      }
    }
    return;
  }
  setExpanded(r.key, open);
}

function toggleExpandAll() {
  state.expandAll = !state.expandAll;
  state.collapsed.clear();
  if (!state.expandAll) {
    for (const k of KIND_ORDER) state.collapsed.add(k);
    for (const it of getItems()) state.collapsed.add(subgroupKey(it.kind, it.source));
  }
  $('expandToggle').textContent = state.expandAll ? 'Collapse all' : 'Expand all';
  renderTree();
}

function setKind(kind) {
  if (!CHIP_KINDS.includes(kind) || state.kind === kind) return;
  state.kind = kind;
  state.highlight = -1;
  renderTree();
}
//#endregion

//#region RENDER DETAIL
function toggleRequestFor(it) {
  if (it.kind !== 'skill' && it.kind !== 'prompt') return null;
  if (!it.path) return null;
  const scope = it.disabled ? it.raw?.scope : it.raw?.sourceInfo?.scope;
  return {
    action: it.disabled ? 'enable' : 'disable',
    resourceKind: it.kind === 'skill' ? 'skills' : 'prompts',
    path: it.path,
    scope: scope === 'project' ? 'project' : 'user',
  };
}

const highlightedText = new WeakMap();
function promptHtml(it) {
  if (!highlightedText.has(it)) highlightedText.set(it, highlightMarkdown(it.raw.systemPrompt));
  return highlightedText.get(it);
}

function metaRow(label, value) {
  return value == null || value === '' ? '' : `<dt>${label}</dt><dd>${esc(value)}</dd>`;
}

let detailItem = null;
function renderDetail() {
  const panel = $('detailPanel');
  const it = state.snapshot && state.selected ? getItems().find((x) => x.id === state.selected) : null;
  if (it && it === detailItem) return;
  detailItem = it;
  if (!it) {
    panel.innerHTML = `
      <div class="detail-empty">
        ${icon('context')}
        <span>${state.selected && state.snapshot ? 'This item is not in the snapshot.' : 'Select an item to see its details.'}</span>
        <span class="hint"><kbd>j</kbd> <kbd>k</kbd> to move, <kbd>?</kbd> for all keys</span>
      </div>`;
    return;
  }

  const isPrompt = it.kind === 'context' && it.raw?.systemPrompt;
  const si = it.raw?.sourceInfo;
  const status = it.disabled
    ? `disabled${it.raw?.scope ? ` (${it.raw.scope})` : ''}`
    : it.pending ? 'restart pi to activate' : it.active === false ? 'inactive' : it.active ? 'active' : null;
  const sections = [];
  if (it.description && !isPrompt) {
    sections.push(`<section class="detail-section"><h4>Description</h4><p class="detail-desc">${esc(it.description)}</p></section>`);
  }
  sections.push(`
    <section class="detail-section">
      <h4>Details</h4>
      <dl class="meta-grid">
        ${metaRow('Kind', it.kind)}
        ${metaRow('Source', it.source)}
        ${si?.source && packageName(si.source) !== si.source ? metaRow('Package', si.source) : ''}
        ${metaRow('Scope', si?.scope)}
        ${metaRow('Status', status)}
        ${metaRow('Settings', it.raw?.settingsPath)}
        ${metaRow('Path', it.path)}
      </dl>
    </section>`);
  sections.push(isPrompt
    ? `<section class="detail-section"><h4>Text · ${fmtChars(it.raw.systemPrompt.length)}</h4><pre class="code-view"><code class="md">${promptHtml(it)}</code></pre></section>`
    : `<section class="detail-section"><h4>Raw</h4><pre class="code-view"><code class="json">${highlightJson(it.raw)}</code></pre></section>`);

  const ghUrl = githubUrlFor(it);
  const toggle = state.staticMode ? null : toggleRequestFor(it);
  const enable = toggle?.action === 'enable';
  const allowEditor = !state.staticMode && it.path;
  panel.innerHTML = `
    <div class="detail-header">
      <span class="tree-icon">${icon(it.kind)}</span>
      <h3>${esc(it.name)}</h3>
      <span class="kind-tag">${esc(it.kind)}</span>
      <span class="spacer"></span>
      ${toggle ? `<button class="btn btn-small" id="toggleBtn" title="${enable ? 'Enable' : 'Disable'} in ${toggle.scope} settings">${enable ? 'Enable' : 'Disable'}</button>` : ''}
      ${allowEditor ? `<button class="icon-btn" id="openEditorBtn" title="Open in editor (o)" aria-label="Open in editor">${icon('editor')}</button>` : ''}
      ${it.path ? `<button class="icon-btn" id="copyPathBtn" title="Copy path (c)" aria-label="Copy path">${icon('copy')}</button>` : ''}
      ${ghUrl ? `<a class="icon-btn" href="${esc(ghUrl)}" target="_blank" rel="noopener" title="Open on GitHub" aria-label="Open on GitHub">${icon('github')}</a>` : ''}
      <button class="icon-btn" id="detailCloseBtn" title="Close (Esc)" aria-label="Close">&#10005;</button>
    </div>
    <div class="detail-body">${sections.join('')}</div>`;

  $('detailCloseBtn').addEventListener('click', closeDetail);
  $('openEditorBtn')?.addEventListener('click', async () => {
    try {
      const j = await postJson('/api/open', { path: it.path });
      toast(`Opened in ${j.editor}`, 'success');
    } catch (e) { toast(`Open failed: ${e.message}`, 'error'); }
  });
  $('copyPathBtn')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(it.path); toast('Path copied', 'success'); }
    catch { toast('Copy failed', 'error'); }
  });
  const toggleBtn = $('toggleBtn');
  toggleBtn?.addEventListener('click', async () => {
    toggleBtn.disabled = true;
    try {
      await postJson('/api/toggle', toggle);
      toast(`${enable ? 'Enabled' : 'Disabled'} ${it.name}. Restart pi to apply it fully.`, 'success');
    } catch (e) {
      toast(`Toggle failed: ${e.message}`, 'error');
      toggleBtn.disabled = false;
    }
  });
}

function closeDetail() {
  if (!state.selected) return;
  selectItem(null);
}

function clickDetailButton(id, missing) {
  const btn = $(id);
  if (btn) btn.click();
  else toast(state.selected ? missing : 'Select an item first');
}
//#endregion

//#region MODALS
let confirmResolve = null;

function isOpen(id) { return $(id).classList.contains('open'); }
function setModal(id, open) {
  $(id).classList.toggle('open', open);
  $(id).setAttribute('aria-hidden', String(!open));
}

function confirmDialog(text) {
  $('confirmText').textContent = text;
  setModal('confirmModal', true);
  $('confirmCancel').focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function settleConfirm(value) {
  setModal('confirmModal', false);
  confirmResolve?.(value);
  confirmResolve = null;
  $('treeContainer').focus();
}

function trapTab(e, ids) {
  const i = ids.indexOf(document.activeElement?.id);
  e.preventDefault();
  $(ids[(i + (e.shiftKey ? ids.length - 1 : 1)) % ids.length]).focus();
}
//#endregion

//#region ACTIONS
function renderAll() {
  renderTopbar();
  renderTree();
  renderDetail();
}

async function switchSession(id, { push = true } = {}) {
  if (push) setUrlSession(id);
  await loadSnapshot(id);
  state.selected = defaultSelection();
  state.highlight = -1;
  renderAll();
}

async function reload() {
  await Promise.all([loadSessions(), loadSnapshot(state.currentSessionId)]);
  renderAll();
}

async function refresh() {
  if (state.staticMode) return;
  const btn = $('refreshBtn');
  btn.classList.add('loading');
  try {
    await reload();
    toast('Refreshed');
  } catch (e) {
    toast(`Refresh failed: ${e.message}`, 'error');
  } finally {
    setTimeout(() => btn.classList.remove('loading'), 200);
  }
}

async function cleanupSessions() {
  const keep = state.currentSessionId;
  if (!keep || !state.sessions.some((s) => s.id === keep)) { toast('Pick a captured session first'); return; }
  const others = state.sessions.length - 1;
  if (!others) { toast('Only one session. Nothing to delete.'); return; }
  if (!(await confirmDialog(`Delete ${others} other snapshot${others === 1 ? '' : 's'} and keep only this session?`))) return;
  const btn = $('cleanupSessionsBtn');
  btn.classList.add('loading');
  try {
    const { removed = [] } = await postJson('/api/sessions/cleanup', { keep });
    await loadSessions();
    renderTopbar();
    toast(removed.length ? `Deleted ${removed.length} snapshot${removed.length === 1 ? '' : 's'}` : 'Nothing to delete', 'success');
  } catch (e) {
    toast(`Delete failed: ${e.message}`, 'error');
  } finally {
    btn.classList.remove('loading');
  }
}

async function share() {
  if (!state.snapshot) { toast('No snapshot to share'); return; }
  const btn = $('shareBtn');
  btn.classList.add('loading');
  try {
    const url = window.piShare.buildShareUrl(await window.piShare.encodeSnapshot(state.snapshot));
    await navigator.clipboard.writeText(url);
    toast(`Share link copied (${Math.max(1, Math.round(url.length / 1024))} KB). Home paths are hidden.`, 'success');
  } catch (e) {
    toast(`Share failed: ${e.message}`, 'error');
  } finally {
    btn.classList.remove('loading');
  }
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
    document.body.classList.add('resizing');
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = panel.parentElement.getBoundingClientRect();
    const w = Math.max(220, Math.min(rect.width - 280, e.clientX - rect.left));
    panel.style.flexBasis = `${w}px`;
    try { localStorage.setItem('inspect.sidebarW', String(w)); } catch {}
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('is-dragging');
    document.body.classList.remove('resizing');
  });
  try {
    const w = Number(localStorage.getItem('inspect.sidebarW'));
    if (w >= 220) panel.style.flexBasis = `${w}px`;
  } catch {}
}

const KEYMAP = {
  '?': () => setModal('helpModal', true),
  '/': () => $('searchInput').focus(),
  s: () => { if (!$('sessionSelect').disabled) $('sessionSelect').focus(); },
  r: refresh,
  t: toggleTheme,
  e: toggleExpandAll,
  j: () => moveHighlight(1),
  ArrowDown: () => moveHighlight(1),
  k: () => moveHighlight(-1),
  ArrowUp: () => moveHighlight(-1),
  g: () => setHighlight(0),
  Home: () => setHighlight(0),
  G: () => setHighlight(state.visibleRows.length - 1),
  End: () => setHighlight(state.visibleRows.length - 1),
  l: () => expandAtHighlight(true),
  ArrowRight: () => expandAtHighlight(true),
  h: () => expandAtHighlight(false),
  ArrowLeft: () => expandAtHighlight(false),
  Enter: () => activateRow(state.highlight),
  ' ': () => activateRow(state.highlight),
  o: () => clickDetailButton('openEditorBtn', 'This item has no file to open'),
  c: () => clickDetailButton('copyPathBtn', 'This item has no path'),
  Escape: closeDetail,
};
CHIP_KINDS.forEach((k, i) => { KEYMAP[String(i)] = () => setKind(k); });

function handleKeydown(e) {
  if (isOpen('confirmModal')) {
    if (e.key === 'Escape') { e.preventDefault(); settleConfirm(false); }
    else if (e.key === 'Tab') trapTab(e, ['confirmCancel', 'confirmOk']);
    return;
  }
  if (isOpen('helpModal')) {
    if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); setModal('helpModal', false); }
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); $('treeContainer').focus(); }
    else if (e.key === 'Enter' && tag === 'INPUT') { e.preventDefault(); $('treeContainer').focus(); moveHighlight(1); }
    return;
  }
  if ((tag === 'BUTTON' || tag === 'A') && (e.key === 'Enter' || e.key === ' ')) return;
  const action = KEYMAP[e.key];
  if (!action) return;
  e.preventDefault();
  action();
}

function bindEvents() {
  $('sessionSelect').addEventListener('change', (e) => switchSession(e.target.value || null));
  $('kindChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-kind]');
    if (chip) setKind(chip.dataset.kind);
  });
  $('searchInput').addEventListener('input', (e) => {
    state.search = e.target.value;
    state.highlight = -1;
    renderTree();
  });
  $('treeContainer').addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (row) activateRow(Number(row.dataset.index));
  });
  $('shareBtn').addEventListener('click', share);
  $('refreshBtn').addEventListener('click', refresh);
  $('cleanupSessionsBtn').addEventListener('click', cleanupSessions);
  $('themeBtn').addEventListener('click', toggleTheme);
  $('expandToggle').addEventListener('click', toggleExpandAll);
  $('shortcutsBtn').addEventListener('click', () => setModal('helpModal', true));
  $('helpCloseBtn').addEventListener('click', () => setModal('helpModal', false));
  $('helpModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) setModal('helpModal', false); });
  $('confirmOk').addEventListener('click', () => settleConfirm(true));
  $('confirmCancel').addEventListener('click', () => settleConfirm(false));
  $('confirmModal').addEventListener('click', (e) => { if (e.target === e.currentTarget) settleConfirm(false); });
  window.addEventListener('popstate', () => switchSession(getUrlSession(), { push: false }));
  window.addEventListener('keydown', handleKeydown);
}

function bindSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', async (ev) => {
    let files = null;
    try { files = JSON.parse(ev.data).files; } catch {}
    const id = state.currentSessionId;
    // Same rule as sanitize() in lib/snapshot.js, which names the snapshot files.
    const ownFile = id && `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
    if (!ownFile || !Array.isArray(files) || files.includes(ownFile)) return reload();
    await loadSessions();
    renderTopbar();
  });
  es.addEventListener('navigate', async (ev) => {
    try {
      const { session } = JSON.parse(ev.data);
      const sid = session || state.sessions[0]?.id;
      if (!sid) return;
      setUrlSession(sid, true);
      await switchSession(sid, { push: false });
      window.focus();
    } catch {}
  });
}
//#endregion

//#region THEME
// Companion embed contract with a framing host (the pi-kanban board): with ?embed=1 the dashboard
// posts `pi-companion:ready` to its parent, and the parent answers with `pi-companion:theme`
// ({ mode, colors }) then and on each theme change. The theme is not saved.
const EMBEDDED = window.parent !== window && new URLSearchParams(location.search).get('embed') === '1';
const THEME_KEY = 'inspect.theme';
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const THEME_KEYS = [
  'bgDeep', 'bgSurface', 'bgElevated', 'bgHover', 'border',
  'textPrimary', 'textSecondary', 'textTertiary', 'textMuted',
  'accent', 'accentText', 'success', 'warning', 'error',
];
const cssVar = (key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

function savedTheme() {
  if (EMBEDDED) return null;
  try { return localStorage.getItem(THEME_KEY); } catch { return null; }
}

function applyLocalTheme() {
  const theme = savedTheme() ?? (darkQuery.matches ? 'dark' : 'light');
  document.body.classList.toggle('light', theme === 'light');
}

function toggleTheme() {
  if (EMBEDDED) return;
  const light = document.body.classList.toggle('light');
  try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch {}
}

function applyHostTheme({ mode, colors }) {
  document.body.classList.toggle('light', mode === 'light');
  for (const key of THEME_KEYS) {
    const v = colors?.[key];
    if (typeof v === 'string' && CSS.supports('color', v)) document.body.style.setProperty(cssVar(key), v);
  }
}

applyLocalTheme();
if (EMBEDDED) {
  document.body.classList.add('embedded');
  window.addEventListener('message', (e) => {
    if (e.source === window.parent && e.data?.type === 'pi-companion:theme') applyHostTheme(e.data);
  });
  window.parent.postMessage({ type: 'pi-companion:ready' }, '*');
} else {
  darkQuery.addEventListener('change', () => { if (!savedTheme()) applyLocalTheme(); });
}
//#endregion

//#region INIT
async function loadSharedSnapshot() {
  const param = window.piShare?.getSharedSnapshotParam();
  if (!param) return false;
  try {
    state.snapshot = await window.piShare.decodeSnapshot(param);
    state.currentSessionId = state.snapshot?.sessionId ?? null;
    state.sessions = state.currentSessionId
      ? [{ id: state.currentSessionId, name: state.snapshot.sessionName, cwd: state.snapshot.cwd }]
      : [];
    state.staticMode = true;
    return true;
  } catch (e) {
    console.warn('Failed to decode shared snapshot:', e);
    toast(`Cannot read the share link: ${e.message}`, 'error');
    return false;
  }
}

(async function init() {
  bindResize();
  bindEvents();

  if (!(await loadSharedSnapshot())) {
    try {
      const requested = getUrlSession();
      await Promise.all([loadSessions(), loadSnapshot(requested)]);
      if (state.currentSessionId && !requested) setUrlSession(state.currentSessionId, true);
    } catch {
      state.staticMode = true;
      state.snapshot = null;
    }
  }

  if (state.staticMode) document.body.classList.add('static-mode');
  state.selected = defaultSelection();
  renderAll();
  if (!state.staticMode) bindSse();
})();
//#endregion
