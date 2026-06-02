// Workspace state
let currentWsId = null;
let multiRootMode = false;
let knownWorkspaces = [];  // Cached list for Cmd+K palette; populated on init/switch

// Model color palette (used in trace charts)
const MODEL_COLORS = {
  haiku:  '#40c4ff',
  sonnet: '#FFAB40',
  opus:   '#b388ff',
};

// Model pricing for client-side cost calculation (per token)
const MODEL_PRICING = {
  haiku:  { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },
  sonnet: { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
  opus:   { input: 15.00 / 1_000_000, output: 75.00 / 1_000_000 },
};

function resolveModelKey(model) {
  if (!model) return null;
  const m = model.toLowerCase();
  if (m.includes('haiku'))  return 'haiku';
  if (m.includes('opus'))   return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  return null;
}

function calcEntryCost(e) {
  const mk = resolveModelKey(e.model);
  if (!mk) return 0;
  const pr = MODEL_PRICING[mk];
  const inTok = e.tokens_est?.input ?? 0;
  const outTok = e.tokens_est?.output ?? 0;
  return inTok * pr.input + outTok * pr.output;
}

// Poll sequence counter — incremented on every route change to discard stale responses
let _pollSequence = 0;

// Smart DOM update: replaces #app innerHTML while preserving scroll and focus.
// Skips the DOM swap when the rendered HTML is identical to the last paint — e.g. a
// 3s poll that returned 304/unchanged data. Avoids scroll jitter, focus loss, and
// re-triggered animations on every tick (P6).
let _lastAppHtml = null;
function updateApp(html) {
  const app = document.getElementById('app');
  if (html === _lastAppHtml && app && app.innerHTML !== '') return;
  _lastAppHtml = html;
  const content = document.querySelector('.content');
  const scrollTop = content ? content.scrollTop : 0;

  const focused = document.activeElement;
  const focusId = focused?.id;
  const focusValue = focused?.value;
  const focusSelStart = focused?.selectionStart;

  app.innerHTML = html;

  if (content) content.scrollTop = scrollTop;

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (focusValue !== undefined) el.value = focusValue;
      if (focusSelStart !== undefined) el.selectionStart = el.selectionEnd = focusSelStart;
    }
  }
}

function apiUrl(path) {
  const p = path.startsWith('/') ? path : '/' + path;
  if (multiRootMode && currentWsId) {
    return `/api/ws/${encodeURIComponent(currentWsId)}${p}`;
  }
  return `/api${p}`;
}

async function initWorkspaces() {
  const health = await fetchJSON('/api/health');
  const serverMultiRoot = health && !health.error && health.multiRoot;

  const res = await fetchJSON('/api/workspaces');
  if (res.error || !Array.isArray(res)) return;

  const workspaces = res;
  knownWorkspaces = workspaces;  // Expose for palette (+ any other global consumer)
  if (workspaces.length <= 1 && !serverMultiRoot) {
    currentWsId = workspaces[0]?.id ?? null;
    multiRootMode = false;
    return;
  }

  multiRootMode = true;
  const savedWs = localStorage.getItem('xm-workspace');
  const savedValid = savedWs && workspaces.find(w => w.id === savedWs);
  currentWsId = savedValid ? savedWs : workspaces[0].id;
  localStorage.setItem('xm-workspace', currentWsId);

  const currentWs = workspaces.find(w => w.id === currentWsId) || workspaces[0];

  const nav = document.getElementById('nav');
  if (!nav) return;
  const selector = document.createElement('div');
  selector.id = 'ws-selector';
  selector.innerHTML = `
    <div class="ws-selector-label">Workspace</div>
    <div class="ws-combo" id="ws-combo">
      <input type="text" id="ws-search" class="ws-search-input"
             placeholder="Search workspace…" value="${currentWs.name}"
             autocomplete="off" spellcheck="false"
             role="combobox" aria-expanded="false" aria-controls="ws-options" aria-label="Search workspace" />
      <ul id="ws-options" class="ws-options" role="listbox" hidden></ul>
    </div>
  `;

  const navLinks = nav.querySelector('.nav-links');
  nav.insertBefore(selector, navLinks);

  const wsInput = document.getElementById('ws-search');
  const wsList = document.getElementById('ws-options');
  let wsActiveIdx = -1;

  function wsRenderOptions(filter) {
    const q = (filter || '').trim().toLowerCase();
    const matches = workspaces.filter(w => !q || w.name.toLowerCase().includes(q));
    wsActiveIdx = -1;
    wsList.innerHTML = matches.length
      ? matches.map(w => `<li role="option" class="ws-option${w.id === currentWsId ? ' current' : ''}" data-wsid="${w.id}">
          <span class="ws-option-name">${w.name}</span>
          <span class="ws-option-count">${w.stats?.projects ?? 0}</span>
        </li>`).join('')
      : '<li class="ws-option ws-option-empty">No match</li>';
  }
  function wsOpen() {
    wsRenderOptions('');
    wsList.hidden = false;
    wsInput.setAttribute('aria-expanded', 'true');
  }
  function wsClose(restore = true) {
    wsList.hidden = true;
    wsInput.setAttribute('aria-expanded', 'false');
    wsActiveIdx = -1;
    if (restore) {
      const cur = workspaces.find(w => w.id === currentWsId);
      if (cur) wsInput.value = cur.name;
    }
  }
  function wsSelect(id) {
    const sel = workspaces.find(w => w.id === id);
    if (!sel) return;
    currentWsId = id;
    localStorage.setItem('xm-workspace', id);
    wsInput.value = sel.name;
    wsClose(false);
    route();
  }
  function wsHighlight(opts) {
    opts.forEach((o, i) => o.classList.toggle('active', i === wsActiveIdx));
    if (opts[wsActiveIdx]) opts[wsActiveIdx].scrollIntoView({ block: 'nearest' });
  }

  wsInput.addEventListener('focus', () => { wsInput.select(); wsOpen(); });
  wsInput.addEventListener('input', () => {
    wsRenderOptions(wsInput.value);
    wsList.hidden = false;
    wsInput.setAttribute('aria-expanded', 'true');
  });
  wsInput.addEventListener('keydown', (e) => {
    if (wsList.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { wsOpen(); return; }
    const opts = Array.from(wsList.querySelectorAll('.ws-option[data-wsid]'));
    if (e.key === 'ArrowDown') { e.preventDefault(); wsActiveIdx = Math.min(wsActiveIdx + 1, opts.length - 1); wsHighlight(opts); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); wsActiveIdx = Math.max(wsActiveIdx - 1, 0); wsHighlight(opts); }
    else if (e.key === 'Enter') { e.preventDefault(); const pick = opts[wsActiveIdx] || opts[0]; if (pick && pick.dataset.wsid) wsSelect(pick.dataset.wsid); }
    else if (e.key === 'Escape') { wsClose(true); wsInput.blur(); }
  });
  wsList.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.ws-option[data-wsid]');
    if (li) { e.preventDefault(); wsSelect(li.dataset.wsid); }
  });
  document.addEventListener('click', (e) => {
    const combo = document.getElementById('ws-combo');
    if (combo && !combo.contains(e.target)) wsClose(true);
  });
}

// Utility functions

function timeAgo(isoString) {
  if (!isoString) return '—';
  const diff = Date.now() - new Date(isoString).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 4) return `${w}w ago`;
  const mo = Math.floor(d / 30);
  return `${mo}mo ago`;
}

function phaseBadge(phase) {
  const map = {
    '01-research': { cls: 'badge-blue',   label: 'Research' },
    '02-plan':     { cls: 'badge-indigo', label: 'Plan'     },
    '03-execute':  { cls: 'badge-amber',  label: 'Execute'  },
    '04-verify':   { cls: 'badge-purple', label: 'Verify'   },
    '05-close':    { cls: 'badge-green',  label: 'Close'    },
  };
  const entry = map[phase];
  if (entry) return `<span class="badge ${entry.cls}">${entry.label}</span>`;
  const label = phase || 'Unknown';
  return `<span class="badge badge-gray">${label}</span>`;
}

function nullSafe(value, fallback = '—') {
  return (value === null || value === undefined || value === '') ? fallback : value;
}

// ── Shared render helpers ─────────────────────────────────────────────
function renderLoading() {
  return '<div class="card"><p class="text-muted">Loading…</p></div>';
}
function renderError(msg) {
  return '<div class="card card-error"><p>⚠ Error: ' + (msg ?? 'unknown error') + '</p></div>';
}
function renderEmpty(msg, cmd) {
  return `<div class="card empty-state">
    <div class="empty-icon">◇</div>
    <p class="text-muted">${msg}</p>
    ${cmd ? `<p class="empty-hint">Run <code>${cmd}</code></p>` : ''}
  </div>`;
}

function commandButton(command, label = 'Copy') {
  const e = escapeHtmlHumble;
  return `<button class="cmd-copy" type="button" onclick="copyCommand(${JSON.stringify(command)}, this)" title="${e(command)}">${e(label)}</button>`;
}

async function copyCommand(command, btn) {
  try {
    await navigator.clipboard.writeText(command);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = 'Copied';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = old;
        btn.disabled = false;
      }, 1100);
    }
  } catch {
    window.prompt('Copy command', command);
  }
}

function nextBuildAction(project) {
  const phase = project?.current_phase;
  const laterOpen = project?.later?.open || 0;
  if (laterOpen > 0) return 'Review later';
  if (phase === '04-verify') return 'Verify';
  if (phase === '05-close') return 'Closed';
  if (phase === '03-execute') return 'Run';
  return 'Next';
}

// Host alias map (first-seen → 3-letter code). Persisted in localStorage so
// the same host gets the same chip across sessions.
const HOST_ALIAS_KEY = 'xm-host-aliases';
function loadHostAliases() {
  try { return JSON.parse(localStorage.getItem(HOST_ALIAS_KEY) || '{}'); } catch { return {}; }
}
function saveHostAliases(m) {
  try { localStorage.setItem(HOST_ALIAS_KEY, JSON.stringify(m)); } catch {}
}
function aliasHost(host) {
  const map = loadHostAliases();
  if (map[host]) return map[host];
  // First-time: take capital letters or first 3 chars
  const caps = host.replace(/[^A-Z0-9]/g, '').slice(0, 4);
  const alias = caps.length >= 2 ? caps : host.split(/[.-]/)[0].slice(0, 4);
  map[host] = alias;
  saveHostAliases(map);
  return alias;
}

/**
 * Compact file-label formatter.
 *   "L2.jinwooui-MacBookPro.local-f675.jinwooui-Macmini.local-7a27.json"
 *   → "[L2] MBP→Mini · 7a27"
 *
 * Returns { chip: HTML string (with hover title), raw: original }.
 * Recognizes the xm sync convention `{id}.{host1-id1}.{host2-id2}...{.ext}`.
 */
function smartFileLabel(file) {
  if (!file) return { chip: '', raw: '' };
  const ext = (file.match(/\.(json|md|jsonl)$/) || [''])[0];
  const base = file.slice(0, file.length - ext.length);
  const parts = base.split('.');
  const id = parts[0];
  const hostSegments = parts.slice(1);
  const escTitle = escapeHtmlHumble(file);
  if (hostSegments.length === 0) {
    return { chip: `<code title="${escTitle}">${escapeHtmlHumble(id)}${escapeHtmlHumble(ext)}</code>`, raw: file };
  }
  // Each host segment looks like "{hostname}-{hash4}" — keep the 4-char tail as stable fingerprint
  const hostChips = hostSegments.map(seg => {
    const m = seg.match(/^(.*)-([a-z0-9]{4,8})$/i);
    if (m) return { host: m[1], hash: m[2] };
    return { host: seg, hash: '' };
  });
  const hosts = hostChips.map(h => aliasHost(h.host)).join('→');
  const tailHash = hostChips[hostChips.length - 1].hash;
  const chip = `<span title="${escTitle}" style="display:inline-flex;gap:6px;align-items:center">
    <code style="font-weight:600">${escapeHtmlHumble(id)}</code>
    ${hosts ? `<span class="text-muted" style="font-size:.85em">${escapeHtmlHumble(hosts)}</span>` : ''}
    ${tailHash ? `<code class="text-muted" style="font-size:.8em">${escapeHtmlHumble(tailHash)}</code>` : ''}
  </span>`;
  return { chip, raw: file };
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: true, message: `HTTP ${res.status}` };
    try {
      return await res.json();
    } catch (parseErr) {
      return { error: true, message: `Parse error: ${parseErr.message}` };
    }
  } catch (err) {
    console.error('fetchJSON error:', url, err);
    return { error: true, message: err.message };
  }
}

/** Returns an extra hint when multi-workspace is active and no data found. */
function wsEmptyHint() {
  if (!multiRootMode || !currentWsId) return '';
  return `<p style="margin-top:0.5rem;font-size:0.8rem;color:var(--text-muted)">현재 workspace에 데이터 없음 — 사이드바에서 workspace 전환</p>`;
}

function statusBadge(status) {
  const map = {
    completed: { cls: 'badge-green',  label: '✅ Completed' },
    pending:   { cls: 'badge-gray',   label: 'Pending'      },
    running:   { cls: 'badge-amber',  label: 'Running'      },
    failed:    { cls: 'badge-red',    label: '❌ Failed'    },
  };
  const entry = map[status];
  if (entry) return `<span class="badge ${entry.cls}">${entry.label}</span>`;
  return `<span class="badge badge-gray">${status || 'Unknown'}</span>`;
}

function sizeBadge(size) {
  const map = {
    small:  { cls: 'badge-blue',  label: 'small'  },
    medium: { cls: 'badge-amber', label: 'medium' },
    large:  { cls: 'badge-red',   label: 'large'  },
  };
  const entry = map[size];
  if (entry) return `<span class="badge ${entry.cls}">${entry.label}</span>`;
  return `<span class="badge badge-gray">${size || '—'}</span>`;
}

function laterStatusBadge(status) {
  const map = {
    open:      { cls: 'badge-amber', label: 'Open'      },
    promoted:  { cls: 'badge-green', label: 'Promoted'  },
    dismissed: { cls: 'badge-gray',  label: 'Dismissed' },
  };
  const entry = map[status];
  if (entry) return `<span class="badge ${entry.cls}">${entry.label}</span>`;
  return `<span class="badge badge-gray">${status || 'Unknown'}</span>`;
}

function laterImpactBadge(impact) {
  const map = {
    none:    { cls: 'badge-gray',  label: 'none'    },
    low:     { cls: 'badge-blue',  label: 'low'     },
    unknown: { cls: 'badge-amber', label: 'unknown' },
  };
  const entry = map[impact];
  if (entry) return `<span class="badge ${entry.cls}">${entry.label}</span>`;
  return `<span class="badge badge-gray">${impact || '—'}</span>`;
}

function severityBadge(severity) {
  const map = {
    critical: { cls: 'badge-red', label: 'critical' },
    high:     { cls: 'badge-red', label: 'high'     },
    medium:   { cls: 'badge-amber', label: 'medium' },
    low:      { cls: 'badge-blue', label: 'low'     },
  };
  const entry = map[String(severity || '').toLowerCase()];
  if (entry) return `<span class="badge ${entry.cls}">${entry.label}</span>`;
  return `<span class="badge badge-gray">${severity || '—'}</span>`;
}

function laterFilesCell(files) {
  const e = escapeHtmlHumble;
  if (!Array.isArray(files) || files.length === 0) return '<span class="text-muted">—</span>';
  return files.map(file => `<code>${e(file)}</code>`).join(' ');
}

function laterScopeBadge(scope) {
  if (!scope || !scope.tracked) return '<span class="badge badge-gray">untracked</span>';
  if (scope.changed > 0) return `<span class="badge badge-red">${scope.changed} changed</span>`;
  return `<span class="badge badge-green">${scope.tracked} clean</span>`;
}

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined' && marked.parse) {
    // Pre-process: wrap ASCII diagram blocks in code fences so marked renders them as <pre>
    // Detect lines with box-drawing chars (─│┌┐└┘├┤┬┴┼), arrows (──▶ ◀── →), or tree chars (├── └──)
    const lines = text.split('\n');
    const processed = [];
    let inDiagram = false;
    for (const line of lines) {
      const isDiagramLine = /[─│┌┐└┘├┤┬┴┼▶◀▼▲═║╔╗╚╝╠╣╦╩╬]/.test(line) ||
        /^\s*[\[(\s].*──/.test(line) ||
        /^\s*[│├└┌]/.test(line);
      if (isDiagramLine && !inDiagram) {
        processed.push('```');
        inDiagram = true;
      } else if (!isDiagramLine && inDiagram && line.trim() === '') {
        processed.push('```');
        inDiagram = false;
      }
      processed.push(line);
    }
    if (inDiagram) processed.push('```');
    return marked.parse(processed.join('\n'));
  }
  // Fallback: escape HTML and preserve line breaks
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

function renderJsonSmart(obj) {
  if (!obj || typeof obj !== 'object') return `<span class="text-muted">${nullSafe(obj)}</span>`;

  // Array of objects → table
  if (Array.isArray(obj) && obj.length > 0 && typeof obj[0] === 'object') {
    const keys = [...new Set(obj.flatMap(o => Object.keys(o)))];
    const thead = keys.map(k => `<th>${k}</th>`).join('');
    const rows = obj.map(item => `<tr>${keys.map(k => {
      const v = item[k];
      if (v === null || v === undefined) return '<td class="text-muted">—</td>';
      if (typeof v === 'boolean') return `<td>${v ? '✅' : '—'}</td>`;
      if (typeof v === 'object') return `<td><code style="font-size:0.75rem">${JSON.stringify(v)}</code></td>`;
      return `<td>${v}</td>`;
    }).join('')}</tr>`).join('');
    return `<div class="table-wrapper" style="margin-top:0.25rem"><table class="table"><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // Simple array → bulleted list
  if (Array.isArray(obj)) {
    return `<ul style="margin:0.25rem 0 0 1.25rem">${obj.map(i => `<li>${i}</li>`).join('')}</ul>`;
  }

  // Flat object → key-value table
  const entries = Object.entries(obj);
  if (entries.length > 0 && entries.every(([, v]) => v === null || typeof v !== 'object')) {
    const rows = entries.map(([k, v]) => {
      let display = nullSafe(v);
      if (typeof v === 'boolean') display = v ? '<span class="badge badge-green">true</span>' : '<span class="badge badge-gray">false</span>';
      else if (k.includes('passed') || k.includes('success')) display = v ? '<span class="badge badge-green">✅ yes</span>' : '<span class="badge badge-red">❌ no</span>';
      else if (k.includes('duration') || k.includes('_ms')) display = typeof v === 'number' ? `${(v / 1000).toFixed(1)}s` : display;
      else if (k.includes('_at') && typeof v === 'string') display = `${timeAgo(v)} <span class="text-muted" style="font-size:0.75rem">(${v})</span>`;
      return `<tr><td style="font-weight:600;white-space:nowrap;width:1%;color:var(--text-muted)">${k}</td><td>${display}</td></tr>`;
    }).join('');
    return `<table class="table" style="margin-top:0.25rem"><tbody>${rows}</tbody></table>`;
  }

  // Nested object — recurse with sections
  let html = '';
  for (const [k, v] of entries) {
    if (typeof v === 'object' && v !== null) {
      html += `<div style="margin-top:0.5rem"><strong style="font-size:0.8rem;color:var(--text-muted)">${k}</strong>${renderJsonSmart(v)}</div>`;
    } else {
      let display = nullSafe(v);
      if (typeof v === 'boolean') display = v ? '✅' : '—';
      html += `<div style="margin-top:0.25rem"><span class="text-muted" style="font-size:0.8rem">${k}:</span> ${display}</div>`;
    }
  }
  return `<div style="margin-top:0.25rem">${html}</div>`;
}

function exportMarkdown(filename, content) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function startPolling(fetchFn, intervalMs = 3000) {
  fetchFn();
  const id = setInterval(fetchFn, intervalMs);
  return () => clearInterval(id);
}

function getHashParams() {
  const hash = window.location.hash;
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return {};
  return Object.fromEntries(new URLSearchParams(hash.slice(qIdx + 1)));
}

// View render functions

function verdictBadge(verdict) {
  if (!verdict) return `<span class="badge badge-gray">—</span>`;
  const map = {
    PROCEED: 'badge-green',
    RETHINK: 'badge-amber',
    KILL:    'badge-red',
  };
  const cls = map[verdict] ?? 'badge-gray';
  return `<span class="badge ${cls}">${verdict}</span>`;
}

async function renderAggregateHome() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Workspaces</h1></div>
    ${renderLoading()}
  `;

  const workspaces = await fetchJSON('/api/workspaces');
  if (!Array.isArray(workspaces) || workspaces.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Workspaces</h1></div>
      ${renderError('Error loading workspaces.')}
    `;
    return;
  }

  let totalProjects = 0;
  let totalProbes = 0;
  let totalSolvers = 0;
  for (const w of workspaces) {
    totalProjects += w.stats?.projects ?? 0;
    totalProbes   += w.stats?.probes   ?? 0;
    totalSolvers  += w.stats?.solvers  ?? 0;
  }

  const wsColors = ['#FFAB40', '#40c4ff', '#b388ff', '#69f0ae', '#ff5252', '#80cbc4'];
  const cards = workspaces.map((w, idx) => {
    const color = wsColors[idx % wsColors.length];
    const lastActivity = w.stats?.last_updated_at ?? w.updated_at ?? null;
    return `
    <div class="card ws-card" data-wsid="${w.id}" style="cursor:pointer;flex:1 1 200px;min-width:180px;border-left:4px solid ${color}">
      <div style="font-size:1.1em;font-weight:700;margin-bottom:0.25rem;color:${color}">${w.name}</div>
      <div class="text-muted" style="font-size:0.75em;font-family:var(--font-mono);margin-bottom:0.5rem;word-break:break-all">${w.path ?? ''}</div>
      ${lastActivity ? `<div class="text-muted" style="font-size:0.75em;margin-bottom:0.5rem">Last activity: ${timeAgo(lastActivity)}</div>` : ''}
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <span class="badge badge-blue">${w.stats?.projects ?? 0} builds</span>
        <span class="badge badge-indigo">${w.stats?.probes ?? 0} probes</span>
        <span class="badge badge-amber">${w.stats?.solvers ?? 0} solvers</span>
        ${w.stats?.cost > 0 ? `<span class="badge badge-green">$${w.stats.cost.toFixed(2)}</span>` : ''}
      </div>
    </div>
  `;
  }).join('');

  // Fetch session state from each workspace, merge results
  const sessResults = await Promise.all(
    workspaces.map(w => fetchJSON(`/api/ws/${encodeURIComponent(w.id)}/session-state`).then(r => ({ ws: w, data: r })))
  );
  const allActive = [];
  const allDecisions = [];
  let sessionHandoff = null;
  for (const { ws, data } of sessResults) {
    if (!data || data.error) continue;
    if (Array.isArray(data.active)) allActive.push(...data.active.map(a => ({ ...a, _ws: ws.name })));
    if (Array.isArray(data.decisions)) allDecisions.push(...data.decisions);
    if (data.session_handoff && !sessionHandoff) sessionHandoff = { ...data.session_handoff, _ws: ws.name };
    else if (data.session_handoff && sessionHandoff) {
      // keep the most recent handoff
      if (data.session_handoff.saved_at > sessionHandoff.saved_at) sessionHandoff = { ...data.session_handoff, _ws: ws.name };
    }
  }
  const sessionState = { active: allActive, recent: [], decisions: allDecisions.slice(-10) };

  const handoffHtml = sessionHandoff ? `
    <div class="card" style="margin-bottom:1rem;border-left:4px solid var(--accent)">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <strong>Session Handoff</strong>
        <span class="text-muted" style="font-size:12px">${timeAgo(sessionHandoff.saved_at)}</span>
      </div>
      ${sessionHandoff.why_stopped ? `<p style="margin:0.5rem 0">${sessionHandoff.why_stopped}</p>` : ''}
      <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:0.5rem;font-size:13px">
        ${sessionHandoff.where?.branch ? `<span><strong>Branch:</strong> ${sessionHandoff.where.branch}${sessionHandoff.where.ahead ? ` (+${sessionHandoff.where.ahead} ahead)` : ''}${sessionHandoff.where.behind ? ` (-${sessionHandoff.where.behind} behind)` : ''}</span>` : ''}
        ${sessionHandoff.what_done?.length ? `<span><strong>Commits today:</strong> ${sessionHandoff.what_done.length}</span>` : ''}
        ${sessionHandoff.where?.uncommitted_files?.length ? `<span><strong>Uncommitted:</strong> ${sessionHandoff.where.uncommitted_files.length} files</span>` : ''}
        ${sessionHandoff.context?.test_status ? `<span><strong>Tests:</strong> ${sessionHandoff.context.test_status}</span>` : ''}
      </div>
      ${sessionHandoff.what_done?.length ? `
      <details style="margin-top:0.75rem;font-size:13px">
        <summary style="cursor:pointer;font-weight:600;margin-bottom:4px">Commits today (${sessionHandoff.what_done.length})</summary>
        <ul style="margin:0.25rem 0 0;padding-left:20px;font-family:monospace;font-size:12px;color:var(--text-muted)">
          ${sessionHandoff.what_done.map(c => `<li style="margin-bottom:2px">${c}</li>`).join('')}
        </ul>
      </details>` : ''}
      ${sessionHandoff.what_remains?.active_projects?.length ? `
      <div style="margin-top:0.75rem;font-size:13px">
        <div style="font-weight:600;margin-bottom:4px">Active Projects</div>
        <ul style="margin:0;padding-left:20px">
          ${sessionHandoff.what_remains.active_projects.map(p => `<li>${p.name} — ${p.phase} (${p.tasks})${p.pending?.length ? ` <span class="text-muted">→ ${p.pending.join(', ')}</span>` : ''}</li>`).join('')}
        </ul>
      </div>` : ''}
      ${sessionHandoff.what_remains?.uncommitted?.length ? `
      <details style="margin-top:0.5rem;font-size:13px">
        <summary style="cursor:pointer;font-weight:600;margin-bottom:4px">Uncommitted files (${sessionHandoff.what_remains.uncommitted.length})</summary>
        <ul style="margin:0.25rem 0 0;padding-left:20px;font-family:monospace;font-size:12px;color:var(--text-muted)">
          ${sessionHandoff.what_remains.uncommitted.map(f => `<li>${f}</li>`).join('')}
        </ul>
      </details>` : ''}
      ${sessionHandoff.decisions?.length ? `
      <details style="margin-top:0.75rem;font-size:13px">
        <summary style="cursor:pointer;font-weight:600;margin-bottom:4px">Decisions (${sessionHandoff.decisions.length})</summary>
        <ul style="margin:0.25rem 0 0;padding-left:20px;font-size:12px">
          ${sessionHandoff.decisions.map(d => `<li style="margin-bottom:3px"><span class="text-muted" style="font-size:11px">${d.project}</span> ${d.what}${d.why ? ` <span class="text-muted">— ${d.why}</span>` : ''}</li>`).join('')}
        </ul>
      </details>` : ''}
      ${sessionHandoff.context?.quality_scores && Object.keys(sessionHandoff.context.quality_scores).length ? `
      <div style="margin-top:0.5rem;font-size:13px">
        <div style="font-weight:600;margin-bottom:4px">Quality Scores</div>
        <div style="display:flex;gap:0.75rem;flex-wrap:wrap">
          ${Object.entries(sessionHandoff.context.quality_scores).map(([k, v]) => {
            const color = v >= 8 ? 'var(--green,#4caf50)' : v >= 6 ? 'var(--amber,#ff9800)' : 'var(--red,#f44)';
            return `<span style="font-size:12px"><code>${k.split('/').pop()}</code> <strong style="color:${color}">${v}/10</strong></span>`;
          }).join('')}
        </div>
      </div>` : ''}
      ${sessionHandoff.context?.current_focus ? `
      <div style="margin-top:0.5rem;font-size:13px">
        <strong>Focus:</strong> ${sessionHandoff.context.current_focus}
      </div>` : ''}
      ${sessionHandoff.context?.blockers?.length ? `
      <div style="margin-top:0.5rem;font-size:13px;color:var(--red,#f44)">
        <strong>Blockers:</strong>
        <ul style="margin:0.25rem 0 0;padding-left:20px">
          ${sessionHandoff.context.blockers.map(b => `<li>${b}</li>`).join('')}
        </ul>
      </div>` : ''}
      ${sessionHandoff.context?.stashes?.length ? `
      <div style="margin-top:0.5rem;font-size:13px">
        <strong>Stashes (${sessionHandoff.context.stashes.length}):</strong>
        <ul style="margin:0.25rem 0 0;padding-left:20px;font-family:monospace;font-size:12px;color:var(--text-muted)">
          ${sessionHandoff.context.stashes.map(s => `<li>${s}</li>`).join('')}
        </ul>
      </div>` : ''}
      ${sessionHandoff.context?.key_files?.length ? `
      <div style="margin-top:0.5rem;font-size:12px;color:var(--text-muted)">
        <strong>Key files:</strong> ${sessionHandoff.context.key_files.join(', ')}
      </div>` : ''}
      ${sessionHandoff.context?.diff_summary ? `
      <div style="margin-top:0.5rem;font-size:12px;color:var(--text-muted)">
        <strong>Changes:</strong> ${sessionHandoff.context.diff_summary}
      </div>` : ''}
    </div>` : '';

  const activeWorkHtml = sessionState.active.length > 0 ? `
    <div class="card" style="margin-bottom:1rem">
      <div class="card-header"><strong>Active Work</strong></div>
      <table class="table" style="margin:0">
        <thead><tr><th>Project</th><th>Phase</th><th>Tasks</th><th>Updated</th></tr></thead>
        <tbody>
          ${sessionState.active.map(p => `
          <tr style="cursor:pointer" onclick="window.location.hash='#/projects/${p.name}'">
            <td><a href="#/projects/${p.name}">${p.display_name}</a></td>
            <td>${phaseBadge(p.phase)}</td>
            <td>${p.tasks.completed}/${p.tasks.total}${p.tasks.failed ? ` <span style="color:var(--red,#f44)">(${p.tasks.failed} failed)</span>` : ''}</td>
            <td class="text-muted">${timeAgo(p.updated_at)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  const decisionsHtml = sessionState.decisions.length > 0 ? `
    <div class="card" style="margin-bottom:1rem;padding:12px 16px">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:8px;font-weight:700">Recent Decisions</div>
      <ul style="margin:0;padding-left:20px;font-size:13px;color:var(--text)">
        ${sessionState.decisions.map(d => `<li style="margin-bottom:4px"><span class="text-muted" style="font-size:11px">${d.project}</span> ${d.decision}</li>`).join('')}
      </ul>
    </div>` : '';

  app.innerHTML = `
    <div class="view-header"><h1>Workspaces</h1></div>
    ${handoffHtml}
    ${activeWorkHtml}
    ${decisionsHtml}
    <div style="display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem">${cards}</div>
    <div class="stat-bar">
      <div class="card stat-card" aria-label="${totalProjects} total builds">
        <div class="stat-value">${totalProjects}</div>
        <div class="stat-label">Total Builds</div>
      </div>
      <div class="card stat-card" aria-label="${totalProbes} total probes">
        <div class="stat-value">${totalProbes}</div>
        <div class="stat-label">Total Probes</div>
      </div>
      <div class="card stat-card" aria-label="${totalSolvers} total solvers">
        <div class="stat-value">${totalSolvers}</div>
        <div class="stat-label">Total Solvers</div>
      </div>
    </div>
  `;

  app.querySelectorAll('.ws-card[data-wsid]').forEach(card => {
    card.addEventListener('click', () => {
      currentWsId = card.dataset.wsid;
      localStorage.setItem('xm-workspace', currentWsId);
      const sel = document.getElementById('ws-select');
      if (sel) sel.value = currentWsId;
      window.location.hash = '#/projects';
    });
  });
}

async function renderHome() {
  if (multiRootMode) return renderAggregateHome();

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Home</h1></div>
    ${renderLoading()}
  `;

  const stopPolling = startPolling(async () => {
    const seq = _pollSequence;
    const [projectsRes, solverRes, probeRes, healthRes, sessStateRes] = await Promise.all([
      fetchJSON(apiUrl('/projects')),
      fetchJSON(apiUrl('/solver')),
      fetchJSON(apiUrl('/probe/latest')),
      fetchJSON('/api/health'),
      fetchJSON(apiUrl('/session-state')),
    ]);
    if (seq !== _pollSequence) return;

    const sessionState = sessStateRes?.active ? sessStateRes : { active: [], recent: [], decisions: [] };
    const sessionHandoff = sessStateRes?.session_handoff || null;

    const projects = Array.isArray(projectsRes.data) ? projectsRes.data : [];
    const solvers  = Array.isArray(solverRes.data)   ? solverRes.data   : [];

    // Active tasks: sum tasks with status != completed across all projects
    // We use task counts from manifest if available; otherwise 0
    let activeTasks = 0;
    for (const p of projects) {
      const tasks = Array.isArray(p.tasks) ? p.tasks : [];
      activeTasks += tasks.filter(t => t.status !== 'completed').length;
    }

    const probe = (!probeRes.error) ? probeRes : null;
    const evidence = probe?.evidence_summary ?? {};

    // Recent projects: last 5 by updated_at
    const recent = [...projects]
      .sort((a, b) => {
        const da = a.updated_at ?? a.created_at ?? '';
        const db = b.updated_at ?? b.created_at ?? '';
        return db < da ? -1 : db > da ? 1 : 0;
      })
      .slice(0, 5);

    const projectName = healthRes?.project ?? 'unknown';
    const cwdPath = healthRes?.cwd ?? '';

    updateApp(`
      <div class="view-header">
        <h1>${projectName}</h1>
        <p style="font-family:var(--font-mono);font-size:11px;color:var(--text-muted)">${cwdPath}/.xm/</p>
      </div>

      <div class="stat-bar">
        <div class="card stat-card">
          <div class="stat-value">${projects.length}</div>
          <div class="stat-label">Builds</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${activeTasks}</div>
          <div class="stat-label">Active Tasks</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${solvers.length}</div>
          <div class="stat-label">Solver Problems</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${probe ? verdictBadge(probe.verdict) : '<span class="text-muted">—</span>'}</div>
          <div class="stat-label">${probe ? nullSafe(probe.idea, 'Latest Probe') : 'No Probe'}</div>
        </div>
      </div>

      ${sessionHandoff ? `
      <div class="card" style="margin-top:1rem;border-left:4px solid var(--accent)">
        <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
          <strong>Session Handoff</strong>
          <span class="text-muted" style="font-size:12px">${timeAgo(sessionHandoff.saved_at)}</span>
        </div>
        ${sessionHandoff.why_stopped ? `<p style="margin:0.5rem 0">${sessionHandoff.why_stopped}</p>` : ''}
        <div style="display:flex;gap:1rem;flex-wrap:wrap;margin-top:0.5rem;font-size:13px">
          ${sessionHandoff.where?.branch ? `<span><strong>Branch:</strong> ${sessionHandoff.where.branch}${sessionHandoff.where.ahead ? ` (+${sessionHandoff.where.ahead} ahead)` : ''}</span>` : ''}
          ${sessionHandoff.what_done?.length ? `<span><strong>Commits today:</strong> ${sessionHandoff.what_done.length}</span>` : ''}
          ${sessionHandoff.where?.uncommitted_files?.length ? `<span><strong>Uncommitted:</strong> ${sessionHandoff.where.uncommitted_files.length} files</span>` : ''}
        </div>
        ${sessionHandoff.what_remains?.active_projects?.length ? `
        <div style="margin-top:0.75rem;font-size:13px">
          <div style="font-weight:600;margin-bottom:4px">Active Projects</div>
          <ul style="margin:0;padding-left:20px">
            ${sessionHandoff.what_remains.active_projects.map(p => `<li>${p.name} — ${p.phase} (${p.tasks})</li>`).join('')}
          </ul>
        </div>` : ''}
        ${sessionHandoff.context?.key_files?.length ? `
        <div style="margin-top:0.5rem;font-size:12px;color:var(--text-muted)">
          <strong>Key files:</strong> ${sessionHandoff.context.key_files.join(', ')}
        </div>` : ''}
      </div>` : ''}

      ${sessionState.active.length > 0 ? `
      <div class="card" style="margin-top:1rem">
        <div class="card-header"><strong>Active Work</strong></div>
        <table class="table" style="margin:0">
          <thead><tr><th>Project</th><th>Phase</th><th>Tasks</th><th>Updated</th></tr></thead>
          <tbody>
            ${sessionState.active.map(p => `
            <tr style="cursor:pointer" onclick="window.location.hash='#/projects/${p.name}'">
              <td><a href="#/projects/${p.name}">${p.display_name}</a></td>
              <td>${phaseBadge(p.phase)}</td>
              <td>${p.tasks.completed}/${p.tasks.total}${p.tasks.failed ? ` <span style="color:var(--red,#f44)">(${p.tasks.failed} failed)</span>` : ''}</td>
              <td class="text-muted">${timeAgo(p.updated_at)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : ''}

      ${sessionState.decisions.length > 0 ? `
      <div class="card" style="margin-top:0.75rem;padding:12px 16px">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:8px;font-weight:700">Recent Decisions</div>
        <ul style="margin:0;padding-left:20px;font-size:13px;color:var(--text)">
          ${sessionState.decisions.map(d => `<li style="margin-bottom:4px"><span class="text-muted" style="font-size:11px">${d.project}</span> ${d.decision}</li>`).join('')}
        </ul>
      </div>` : ''}

      ${probe ? `
      <div class="card" style="margin-top:1rem">
        <div class="card-header" style="display:flex;align-items:center;gap:0.5rem">
          ${verdictBadge(probe.verdict)}
          <strong>${nullSafe(probe.idea, 'Latest Probe Verdict')}</strong>
        </div>
        <p style="margin:0.5rem 0 0">${nullSafe(probe.recommendation, '')}</p>
        ${Object.keys(evidence).length > 0 ? `
        <div style="margin-top:0.75rem;display:flex;gap:0.5rem;flex-wrap:wrap">
          ${evidence.validated    != null ? `<span class="badge badge-green">validated: ${evidence.validated}</span>`       : ''}
          ${evidence.data_backed  != null ? `<span class="badge badge-blue">data-backed: ${evidence.data_backed}</span>`   : ''}
          ${evidence.heuristic    != null ? `<span class="badge badge-amber">heuristic: ${evidence.heuristic}</span>`      : ''}
          ${evidence.assumption   != null ? `<span class="badge badge-gray">assumption: ${evidence.assumption}</span>`     : ''}
        </div>` : ''}
        <div style="margin-top:0.75rem">
          <a href="#/probes">View all probes →</a>
        </div>
      </div>` : `
      <div class="card" style="margin-top:1rem">
        <p class="text-muted">No probe verdict available. Run <code>x-probe</code> to generate one.</p>
      </div>`}

      <div class="card" style="margin-top:1rem">
        <div class="card-header"><strong>Recent Builds</strong></div>
        ${recent.length === 0 ? `<p class="text-muted">No projects found.</p>` : `
        <ul style="list-style:none;padding:0;margin:0">
          ${recent.map(p => `
          <li style="padding:0.5rem 0;border-bottom:1px solid var(--border, #e5e7eb);display:flex;align-items:center;justify-content:space-between">
            <a href="#/projects/${p.name}">${nullSafe(p.display_name || p.name)}</a>
            <span style="display:flex;align-items:center;gap:0.5rem">
              ${phaseBadge(p.current_phase)}
              <span class="text-muted" style="font-size:0.8em">${timeAgo(p.updated_at ?? p.created_at)}</span>
            </span>
          </li>`).join('')}
        </ul>`}
      </div>
    `);

    // Session metrics bar chart (async, non-blocking)
    fetchJSON(apiUrl('/metrics/sessions?limit=50')).then(sessionsRes => {
      if (seq !== _pollSequence) return;
      const sessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : [];
      if (sessions.length === 0) return;

      // Group by date
      const counts = {};
      for (const s of sessions) {
        const ts = s.started_at ?? s.timestamp ?? s.created_at ?? '';
        if (!ts) continue;
        const date = ts.slice(0, 10); // YYYY-MM-DD
        counts[date] = (counts[date] || 0) + 1;
      }
      const dates = Object.keys(counts).sort();
      if (dates.length === 0) return;

      const max = Math.max(...Object.values(counts));
      const bars = dates.map(d => {
        const pct = max > 0 ? Math.round((counts[d] / max) * 100) : 0;
        return `<div style="width:8px;background:var(--accent);height:${pct}%;min-height:2px;flex-shrink:0" title="${d}: ${counts[d]}"></div>`;
      }).join('');

      const metricsCard = document.createElement('div');
      metricsCard.className = 'card';
      metricsCard.style.marginTop = '1rem';
      metricsCard.innerHTML = `
        <div class="card-header" style="margin-bottom:0.75rem">
          <strong style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Session Metrics</strong>
          <span class="text-muted" style="font-size:11px;margin-left:0.5rem">${sessions.length} sessions</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:2px;height:60px;overflow:hidden">
          ${bars}
        </div>
        <div style="display:flex;justify-content:space-between;margin-top:4px">
          <span class="text-muted" style="font-size:10px">${dates[0]}</span>
          <span class="text-muted" style="font-size:10px">${dates[dates.length - 1]}</span>
        </div>
      `;
      app.appendChild(metricsCard);
    });

    // Cost widget (async, non-blocking)
    fetchJSON(apiUrl('/costs')).then(costsRes => {
      if (seq !== _pollSequence) return;
      if (costsRes.error) return;
      const totalCost = costsRes.totalCost ?? 0;
      const totalTokens = (costsRes.totalInputTokens ?? 0) + (costsRes.totalOutputTokens ?? 0);
      const byModel = costsRes.byModel ?? {};

      const costCard = document.createElement('div');
      costCard.className = 'card';
      costCard.style.marginTop = '1rem';

      if (totalCost === 0) {
        costCard.innerHTML = `
          <div class="card-header" style="margin-bottom:0.5rem">
            <strong style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Cost</strong>
          </div>
          <p class="text-muted" style="font-size:12px">No cost data. Run x-trace to track tokens.</p>
        `;
      } else {
        const modelKeys = Object.keys(byModel);
        const modelTotal = modelKeys.reduce((sum, k) => sum + (byModel[k].cost ?? 0), 0);

        const segmentColors = {
          haiku:  '#40c4ff',
          sonnet: '#FFAB40',
          opus:   '#b388ff',
        };

        const segments = modelKeys.map(k => {
          const pct = modelTotal > 0 ? ((byModel[k].cost ?? 0) / modelTotal) * 100 : 0;
          if (pct < 1) return '';
          const color = Object.keys(segmentColors).find(c => k.toLowerCase().includes(c));
          const bg = color ? segmentColors[color] : '#B0BEC5';
          const label = pct > 8 ? k.replace('claude-', '').split('-')[0] : '';
          return `<div class="cost-bar-segment" style="width:${pct}%;background:${bg};color:#000">${label}</div>`;
        }).join('');

        const modelBreakdown = modelKeys.map(k => {
          const c = byModel[k];
          const pct = modelTotal > 0 ? Math.round(((c.cost ?? 0) / modelTotal) * 100) : 0;
          const color = Object.keys(segmentColors).find(mc => k.toLowerCase().includes(mc));
          const fg = color ? segmentColors[color] : '#B0BEC5';
          return `<span style="font-size:11px;color:${fg};font-family:var(--font-mono)">${k.split('-').pop()}: $${(c.cost ?? 0).toFixed(4)} (${pct}%)</span>`;
        }).join(' &nbsp;·&nbsp; ');

        costCard.innerHTML = `
          <div class="card-header" style="margin-bottom:0.75rem;display:flex;align-items:center;gap:0.75rem">
            <strong style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Cost</strong>
            <span style="font-size:18px;font-weight:700;font-family:var(--font-mono);color:var(--accent)">$${totalCost.toFixed(4)}</span>
            ${totalTokens > 0 ? `<span class="text-muted" style="font-size:11px">/ ${totalTokens.toLocaleString()} tokens</span>` : ''}
          </div>
          ${segments ? `<div class="cost-bar">${segments}</div>` : ''}
          ${modelBreakdown ? `<div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">${modelBreakdown}</div>` : ''}
        `;
      }

      app.appendChild(costCard);
    });
  }, 3000);

  // Stop polling when navigating away
  window.addEventListener('hashchange', stopPolling, { once: true });
}

function renderProjectsList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Builds</h1><p>.xm/build/projects/</p></div>
    ${renderLoading()}
  `;

  const stopPolling = startPolling(async () => {
    const seq = _pollSequence;
    const result = await fetchJSON(apiUrl('/projects'));
    if (seq !== _pollSequence) return;
    if (result.error) {
      updateApp(`
        <div class="view-header"><h1>Builds</h1><p>.xm/build/projects/</p></div>
        ${renderError(result.message)}
      `);
      return;
    }

    const projects = result.data || [];
    if (projects.length === 0) {
      updateApp(`
        <div class="view-header"><h1>Builds</h1><p>.xm/build/projects/</p></div>
        ${renderEmpty('No projects found.', 'xm:build init')}
      `);
      return;
    }

    const rows = projects.map((p) => `
      <tr>
        <td>
          <a href="#/projects/${p.name}">${nullSafe(p.display_name || p.name)}</a>
          ${p.goal ? `<div class="text-muted" style="font-size:11px;margin-top:2px">${p.goal}</div>` : ''}
        </td>
        <td>${phaseBadge(p.current_phase)}</td>
        <td>
          ${(p.later?.open || 0) > 0
            ? `<a href="#/later" class="badge badge-amber">${p.later.open} open</a>`
            : '<span class="badge badge-gray">0 open</span>'}
        </td>
        <td>${statusBadge(nextBuildAction(p).toLowerCase())}</td>
        <td>${timeAgo(p.created_at)}</td>
        <td>${timeAgo(p.updated_at)}</td>
      </tr>
    `).join('');

    updateApp(`
      <div class="view-header"><h1>Builds</h1><p>.xm/build/projects/</p></div>
      <div class="card" style="padding:0">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phase</th>
              <th>Later</th>
              <th>Next</th>
              <th>Created</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `);
  });

  window.addEventListener('hashchange', stopPolling, { once: true });
}

async function renderLaterList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Later</h1><p>.xm/build/projects/*/later.json</p></div>
    ${renderLoading()}
  `;

  const result = await fetchJSON(apiUrl('/later'));
  if (result.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Later</h1><p>.xm/build/projects/*/later.json</p></div>
      ${renderError(result.message || result.error)}
    `;
    return;
  }

  const e = escapeHtmlHumble;
  const items = Array.isArray(result.data) ? result.data : [];
  const summary = result.summary || { total: items.length, open: 0, promoted: 0, dismissed: 0, changed_scope: 0 };

  const renderRows = (rows) => rows.map((item) => {
    const project = item.project || '';
    const actions = item.status === 'open'
      ? `${commandButton(`x-build later promote ${item.id} --size small`, 'Promote')} ${commandButton(`x-build later dismiss ${item.id} --reason ""`, 'Dismiss')}`
      : commandButton('x-build later list --status all', 'List');
    return `
      <tr data-status="${e(item.status || '')}" data-impact="${e(item.impact || '')}" data-search="${e(`${project} ${item.id || ''} ${item.title || ''} ${item.reason || ''} ${(item.files || []).join(' ')}`.toLowerCase())}">
        <td><a href="#/projects/${encodeURIComponent(project)}">${e(item.project_display_name || project)}</a></td>
        <td><code>${e(item.id || '')}</code></td>
        <td>
          <div>${e(item.title || '')}</div>
          ${item.reason ? `<div class="text-muted" style="margin-top:4px">${e(item.reason)}</div>` : ''}
        </td>
        <td>${laterStatusBadge(item.status)}</td>
        <td>${laterImpactBadge(item.impact)}</td>
        <td>${laterScopeBadge(item.scope)}</td>
        <td>${laterFilesCell(item.files)}</td>
        <td>${item.current_task ? `<code>${e(item.current_task)}</code>` : '<span class="text-muted">—</span>'}</td>
        <td>${item.promoted_task_id ? `<code>${e(item.promoted_task_id)}</code>` : '<span class="text-muted">—</span>'}</td>
        <td>${item.updated_at ? timeAgo(item.updated_at) : timeAgo(item.created_at)}</td>
        <td>${actions}</td>
      </tr>
    `;
  }).join('');

  app.innerHTML = `
    <div class="view-header">
      <h1>Later</h1>
      <p>.xm/build/projects/*/later.json</p>
      <div class="view-header-meta">
        <span class="badge badge-amber">${summary.open || 0} open</span>
        <span class="badge badge-green">${summary.promoted || 0} promoted</span>
        <span class="badge badge-gray">${summary.dismissed || 0} dismissed</span>
        ${summary.changed_scope ? `<span class="badge badge-red">${summary.changed_scope} scope changed</span>` : ''}
        <span style="margin-left:auto">${commandButton('x-build later verify-scope', 'Verify scope')}</span>
      </div>
    </div>

    <div class="card" style="padding:12px 16px">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="later-search" type="text" placeholder="Filter later items" style="min-width:220px;flex:1;padding:7px 10px;background:var(--bg);border:var(--border);color:var(--text);font-family:var(--font-mono);font-size:12px" />
        <select id="later-status-filter" aria-label="Filter status" style="padding:7px 10px;background:var(--bg);border:var(--border);color:var(--text);font-family:var(--font-mono);font-size:12px">
          <option value="all">All status</option>
          <option value="open">Open</option>
          <option value="promoted">Promoted</option>
          <option value="dismissed">Dismissed</option>
        </select>
        <select id="later-impact-filter" aria-label="Filter impact" style="padding:7px 10px;background:var(--bg);border:var(--border);color:var(--text);font-family:var(--font-mono);font-size:12px">
          <option value="all">All impact</option>
          <option value="none">None</option>
          <option value="low">Low</option>
          <option value="unknown">Unknown</option>
        </select>
      </div>
    </div>

    <div class="card" style="padding:0">
      <table class="table">
        <thead>
          <tr>
            <th>Project</th>
            <th>ID</th>
            <th>Item</th>
            <th>Status</th>
            <th>Impact</th>
            <th>Scope</th>
            <th>Files</th>
            <th>Task</th>
            <th>Promoted</th>
            <th>Updated</th>
            <th>Command</th>
          </tr>
        </thead>
        <tbody id="later-rows">${renderRows(items) || '<tr><td colspan="11" class="text-muted">No later items captured.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  const filter = () => {
    const q = document.getElementById('later-search')?.value.trim().toLowerCase() || '';
    const status = document.getElementById('later-status-filter')?.value || 'all';
    const impact = document.getElementById('later-impact-filter')?.value || 'all';
    app.querySelectorAll('#later-rows tr[data-status]').forEach(row => {
      const matchesSearch = !q || row.dataset.search.includes(q);
      const matchesStatus = status === 'all' || row.dataset.status === status;
      const matchesImpact = impact === 'all' || row.dataset.impact === impact;
      row.style.display = matchesSearch && matchesStatus && matchesImpact ? '' : 'none';
    });
  };
  document.getElementById('later-search')?.addEventListener('input', filter);
  document.getElementById('later-status-filter')?.addEventListener('change', filter);
  document.getElementById('later-impact-filter')?.addEventListener('change', filter);
}

const PHASES = ['01-research', '02-plan', '03-execute', '04-verify', '05-close'];
const PHASE_LABELS = {
  '01-research': 'Research',
  '02-plan': 'Plan',
  '03-execute': 'Execute',
  '04-verify': 'Verify',
  '05-close': 'Close',
};

function renderPhaseBar(currentPhase) {
  const parts = PHASES.map((p, i) => {
    const active = p === currentPhase;
    const dot = `<div class="phase-dot${active ? ' phase-dot-active' : ''}" title="${PHASE_LABELS[p] || p}">${p.slice(0, 2)}</div>`;
    return i < PHASES.length - 1 ? dot + '<div class="phase-connector"></div>' : dot;
  });
  return `<div class="phase-bar">${parts.join('')}</div>`;
}

const _activeTabState = {};
function switchTab(tabId, idx, btn) {
  _activeTabState[tabId] = idx;
  const card = btn.closest('.card');
  card.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.remove('tab-active');
    b.setAttribute('aria-selected', 'false');
  });
  btn.classList.add('tab-active');
  btn.setAttribute('aria-selected', 'true');
  card.querySelectorAll('.tab-panel').forEach((p, i) => {
    p.style.display = i === idx ? '' : 'none';
    p.setAttribute('role', 'tabpanel');
  });
}
function restoreTab(tabId) {
  const idx = _activeTabState[tabId];
  if (idx == null) return;
  const card = document.getElementById(tabId);
  if (!card) return;
  const btns = card.querySelectorAll('.tab-btn');
  const panels = card.querySelectorAll('.tab-panel');
  btns.forEach((b, i) => b.classList.toggle('tab-active', i === idx));
  panels.forEach((p, i) => { p.style.display = i === idx ? '' : 'none'; });
}

function renderProjectDetail(slug) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Project: <code>${slug}</code></h1></div>
    ${renderLoading()}
  `;

  const stopPolling = startPolling(async () => {
    const seq = _pollSequence;
    const [projectResult, tasksResult, laterResult, gateResult] = await Promise.all([
      fetchJSON(apiUrl(`/projects/${slug}`)),
      fetchJSON(apiUrl(`/projects/${slug}/tasks`)),
      fetchJSON(apiUrl(`/projects/${slug}/later`)),
      fetchJSON(apiUrl(`/projects/${slug}/gate`)),
    ]);
    if (seq !== _pollSequence) return;

    if (projectResult.error) {
      updateApp(`
        <div class="view-header"><h1>Project: <code>${slug}</code></h1></div>
        ${renderError(projectResult.message)}
      `);
      return;
    }

    const { manifest, circuitBreaker, handoff, phases: projectPhases, context } = projectResult;
    const name = nullSafe(manifest?.name, slug);
    const phase = nullSafe(manifest?.current_phase, '');
    const e = escapeHtmlHumble;

    // Extract goal from context docs
    const contextDocs = Array.isArray(context) ? context : [];
    let goal = '';
    const ctxDoc = contextDocs.find(d => d.name === 'CONTEXT.md' || d.name === 'brief.md');
    if (ctxDoc) {
      const goalMatch = ctxDoc.content.match(/^##\s*Goal\s*\n+(.+)/m);
      if (goalMatch) goal = goalMatch[1].trim();
    }

    // Header
    const projectRoutePath = `/projects/${encodeURIComponent(slug)}`;
    let html = `
      <div class="view-header">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <a href="#/projects" style="font-size:0.875rem;opacity:0.7">← Builds</a>
          ${pinButton(projectRoutePath, name)}
        </div>
        <h1 style="margin-top:0.5rem">${name}</h1>
        ${goal ? `<p style="margin:4px 0 0;font-size:13px">${goal}</p>` : ''}
        <div class="view-header-meta">
          ${phaseBadge(phase)}
          <span class="text-muted">Created: ${timeAgo(manifest?.created_at)}</span>
          <span class="text-muted">Updated: ${timeAgo(manifest?.updated_at)}</span>
          <button class="btn-export" id="btn-export-project" style="margin-left:auto;font-size:0.75rem;padding:0.25rem 0.6rem;background:transparent;border:1px solid var(--border,#e5e7eb);border-radius:4px;cursor:pointer;color:var(--text-muted)">↓ EXPORT</button>
        </div>
      </div>
    `;

    // Tasks (computed early for stat cards)
    const tasks = Array.isArray(tasksResult) ? tasksResult
      : Array.isArray(tasksResult?.tasks) ? tasksResult.tasks
      : Array.isArray(tasksResult?.data) ? tasksResult.data
      : [];
    const completedCount = tasks.filter((t) => t.status === 'completed').length;
    const laterItems = laterResult?.error ? [] : Array.isArray(laterResult?.items) ? laterResult.items : [];
    const laterSummary = laterResult?.summary || {
      total: laterItems.length,
      open: laterItems.filter(item => item.status === 'open').length,
      promoted: laterItems.filter(item => item.status === 'promoted').length,
      dismissed: laterItems.filter(item => item.status === 'dismissed').length,
    };

    // Phase bar
    html += `<div class="card">${renderPhaseBar(phase)}</div>`;

    if (!gateResult?.error) {
      const gateReady = gateResult.ready;
      const gateBadge = gateReady
        ? '<span class="badge badge-green">ready</span>'
        : '<span class="badge badge-amber">attention</span>';
      const missing = Array.isArray(gateResult.missing) && gateResult.missing.length
        ? gateResult.missing.map(file => `<code>${e(file)}</code>`).join(' ')
        : '<span class="text-muted">none</span>';
      const commands = Array.isArray(gateResult.commands) && gateResult.commands.length
        ? gateResult.commands.map(command => commandButton(command)).join(' ')
        : '<span class="text-muted">none</span>';
      html += `
        <div class="card" style="padding:12px 16px">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <h2 style="margin:0;font-size:13px">Phase Gate</h2>
            ${gateBadge}
            <span class="text-muted">Pending tasks: ${gateResult.tasks?.pending ?? 0}/${gateResult.tasks?.total ?? 0}</span>
            <span class="text-muted">Missing: ${missing}</span>
            <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">${commands}</span>
          </div>
        </div>
      `;
    }

    // Stat cards row
    const { steps: stepsData, cost: projectCost, quality: projectQuality, decisions: recentDecisions } = projectResult;
    const lastActivity = manifest?.updated_at ? timeAgo(manifest.updated_at) : '—';

    html += `
      <div class="stat-bar" style="margin-bottom:12px">
        <div class="card stat-card">
          <div class="stat-value">${completedCount}/${tasks.length}</div>
          <div class="stat-label">Tasks</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${laterSummary.open}/${laterSummary.total}</div>
          <div class="stat-label">Later</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${stepsData?.completed ?? 0}/${stepsData?.total ?? 0}</div>
          <div class="stat-label">Steps</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value stat-value-string">${projectCost > 0 ? '$' + projectCost.toFixed(2) : '—'}</div>
          <div class="stat-label">Cost</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value stat-value-string">${projectQuality != null ? projectQuality.toFixed(1) + '/10' : '—'}</div>
          <div class="stat-label">Quality</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value stat-value-string">${lastActivity}</div>
          <div class="stat-label">Activity</div>
        </div>
      </div>
    `;

    if (laterResult?.error) {
      html += `
        <div class="card card-warning" style="padding:12px 16px">
          <h2 style="margin:0 0 .35rem;font-size:13px">Later Queue</h2>
          <p class="text-muted" style="margin:0">Could not load later.json: ${e(laterResult.message || laterResult.error)}</p>
        </div>
      `;
    }

    // Recent decisions
    const decisionsList = Array.isArray(recentDecisions) && recentDecisions.length > 0 ? recentDecisions : [];
    if (decisionsList.length > 0) {
      html += `
        <div class="card" style="padding:12px 16px">
          <h3 style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted)">Recent Decisions</h3>
          <ul style="margin:0;padding-left:20px;font-size:13px;color:var(--text)">
            ${decisionsList.map(d => `<li style="margin-bottom:4px">${d.title || d.message || d}</li>`).join('')}
          </ul>
        </div>
      `;
    }

    const taskRows = tasks.map((t) => {
      const deps = Array.isArray(t.dependencies) ? t.dependencies.join(', ') : nullSafe(t.dependencies);
      return `
        <tr>
          <td><code>${nullSafe(t.id)}</code></td>
          <td>${nullSafe(t.name)}</td>
          <td>${statusBadge(t.status)}</td>
          <td>${sizeBadge(t.size)}</td>
          <td>${deps || '—'}</td>
          <td>${nullSafe(t.done_criteria)}</td>
        </tr>
      `;
    }).join('');

    html += `
      <div class="card" style="padding:0">
        <div style="padding:1rem 1.25rem 0"><h2 style="margin:0">Tasks</h2></div>
        <table class="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Size</th>
              <th>Dependencies</th>
              <th>Done Criteria</th>
            </tr>
          </thead>
          <tbody>${taskRows || '<tr><td colspan="6" class="text-muted">No tasks found.</td></tr>'}</tbody>
          <tfoot>
            <tr><td colspan="6" class="text-muted" style="padding:.75rem 1rem">${completedCount}/${tasks.length} tasks completed</td></tr>
          </tfoot>
        </table>
      </div>
    `;

    const laterRows = laterItems.map((item) => {
      const currentTask = item.current_task ? `<code>${e(item.current_task)}</code>` : '<span class="text-muted">—</span>';
      const promotedTask = item.promoted_task_id ? `<code>${e(item.promoted_task_id)}</code>` : '<span class="text-muted">—</span>';
      return `
        <tr>
          <td><code>${e(item.id || '')}</code></td>
          <td>
            <div>${e(item.title || '')}</div>
            ${item.reason ? `<div class="text-muted" style="margin-top:4px">${e(item.reason)}</div>` : ''}
          </td>
          <td>${laterStatusBadge(item.status)}</td>
          <td>${laterImpactBadge(item.impact)}</td>
          <td>${laterScopeBadge(item.scope)}</td>
          <td>${currentTask}</td>
          <td>${promotedTask}</td>
          <td>${laterFilesCell(item.files)}</td>
          <td>${item.updated_at ? timeAgo(item.updated_at) : timeAgo(item.created_at)}</td>
          <td>${item.status === 'open'
            ? `${commandButton(`x-build later promote ${item.id} --size small`, 'Promote')} ${commandButton(`x-build later dismiss ${item.id} --reason ""`, 'Dismiss')}`
            : commandButton('x-build later list --status all', 'List')}</td>
        </tr>
      `;
    }).join('');

    if (!laterResult?.error) {
      html += `
        <div class="card" style="padding:0">
          <div style="padding:1rem 1.25rem 0">
            <h2 style="margin:0">Later Queue</h2>
            <p class="text-muted" style="margin:.35rem 0 .75rem;font-size:12px">
              ${laterSummary.open} open, ${laterSummary.promoted} promoted, ${laterSummary.dismissed} dismissed
            </p>
          </div>
          <table class="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Item</th>
                <th>Status</th>
                <th>Impact</th>
                <th>Scope</th>
                <th>Task</th>
                <th>Promoted</th>
                <th>Files</th>
                <th>Updated</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>${laterRows || '<tr><td colspan="10" class="text-muted">No later items captured.</td></tr>'}</tbody>
          </table>
        </div>
      `;
    }

    // Context docs (tabs) — preserve active tab across polling
    const docs = Array.isArray(context) ? context : [];
    if (docs.length > 0) {
      const tabId = 'ctx-tab';
      const savedIdx = _activeTabState[tabId] ?? 0;
      const tabs = docs.map((d, i) => `
        <button class="tab-btn${i === savedIdx ? ' tab-active' : ''}" role="tab" aria-selected="${i === savedIdx ? 'true' : 'false'}" onclick="switchTab('${tabId}', ${i}, this)">${d.name}</button>
      `).join('');
      const panels = docs.map((d, i) => `
        <div class="tab-panel" id="${tabId}-panel-${i}" style="${i === savedIdx ? '' : 'display:none'}">
          <div class="markdown-body">${renderMarkdown(d.content)}</div>
        </div>
      `).join('');
      html += `
        <div class="card" id="${tabId}">
          <h2 style="margin:0 0 .75rem">Context Docs</h2>
          <div class="tab-bar" role="tablist" aria-label="Context docs">${tabs}</div>
          ${panels}
        </div>
      `;
    }

    // Circuit breaker warning
    if (circuitBreaker && circuitBreaker.state && circuitBreaker.state !== 'closed') {
      html += `
        <div class="card card-warning">
          <h2 style="margin:0 0 .5rem">Circuit Breaker</h2>
          <p><strong>State:</strong> ${circuitBreaker.state}</p>
          <p><strong>Failures:</strong> ${nullSafe(circuitBreaker.failures)}</p>
          <p><strong>Opened at:</strong> ${timeAgo(circuitBreaker.opened_at)}</p>
        </div>
      `;
    }

    // Handoff panel
    if (handoff) {
      const pending = Array.isArray(handoff.pending_tasks)
        ? handoff.pending_tasks.map((t) => typeof t === 'object' ? `<li>${t.id}: ${t.name}</li>` : `<li>${t}</li>`).join('')
        : '';
      html += `
        <div class="card">
          <h2 style="margin:0 0 .5rem">Handoff</h2>
          <p>${nullSafe(handoff.summary)}</p>
          ${pending ? `<ul>${pending}</ul>` : ''}
          <p class="text-muted">Saved: ${timeAgo(handoff.saved_at)}</p>
        </div>
      `;
    }

    // Build timeline
    const timelineEvents = [];
    if (manifest?.created_at) {
      timelineEvents.push({ label: 'Project Created', ts: manifest.created_at, color: 'var(--info)' });
    }
    const phases = Array.isArray(projectPhases) ? projectPhases : [];
    for (const p of phases) {
      const phaseLabel = { '01-research': 'Research', '02-plan': 'Plan', '03-execute': 'Execute', '04-verify': 'Verify', '05-close': 'Close' }[p.phase] ?? p.phase;
      const ts = p.started_at ?? p.completed_at ?? p.updated_at ?? '';
      if (ts) {
        timelineEvents.push({ label: phaseLabel, ts, color: 'var(--accent)', detail: p.status ? `Status: ${p.status}` : '' });
      }
    }
    if (manifest?.updated_at && manifest.updated_at !== manifest.created_at) {
      timelineEvents.push({ label: 'Last Activity', ts: manifest.updated_at, color: 'var(--success)' });
    }
    timelineEvents.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

    if (timelineEvents.length > 0) {
      const timelineItems = timelineEvents.map(e => `
        <div class="timeline-item">
          <div class="timeline-dot" style="background:${e.color};border-color:${e.color}"></div>
          <div class="timeline-content">
            <strong>${e.label}</strong>
            ${e.detail ? `<span class="text-muted" style="margin-left:6px">${e.detail}</span>` : ''}
            <span class="text-muted" style="display:block">${timeAgo(e.ts)}</span>
          </div>
        </div>
      `).join('');
      html += `
        <div class="card" style="margin-top:1rem">
          <h2 style="margin:0 0 1rem">Build Timeline</h2>
          <div class="timeline">${timelineItems}</div>
        </div>
      `;
    }

    // Phase Gate Timeline — from checkpoints[]
    const checkpoints = Array.isArray(projectResult.checkpoints) ? projectResult.checkpoints : [];
    if (checkpoints.length > 0) {
      const cpItems = checkpoints.map(cp => {
        const cpType = cp.type || 'checkpoint';
        const cpTs = cp.ts || cp.timestamp || '';
        const color = cpType.includes('pass') ? 'var(--success,#4caf50)'
          : cpType.includes('fail') ? 'var(--danger,#f44)'
          : 'var(--accent)';
        return `
          <div class="timeline-item">
            <div class="timeline-dot" style="background:${color};border-color:${color}"></div>
            <div class="timeline-content">
              <strong>${escapeHtmlHumble(cpType)}</strong>
              ${cpTs ? `<span class="text-muted" style="display:block">${timeAgo(cpTs)}</span>` : ''}
            </div>
          </div>
        `;
      }).join('');
      html += `
        <div class="card" style="margin-top:1rem">
          <h2 style="margin:0 0 1rem">Phase Gate Timeline</h2>
          <div class="timeline">${cpItems}</div>
        </div>
      `;
    }

    // Plan Quality — from plan_check
    const planCheck = projectResult.plan_check;
    if (planCheck && typeof planCheck === 'object') {
      const checks = Object.entries(planCheck);
      if (checks.length > 0) {
        const badges = checks.map(([key, val]) => {
          const passed = val === true || val === 'pass' || val === 'ok';
          const failed = val === false || val === 'fail';
          const cls = passed ? 'badge-green' : failed ? 'badge-red' : 'badge-amber';
          const display = typeof val === 'boolean' ? (val ? '✓' : '✗') : escapeHtmlHumble(String(val));
          return `<span class="badge ${cls}" style="margin:2px">${escapeHtmlHumble(key)}: ${display}</span>`;
        }).join('');
        html += `
          <div class="card" style="margin-top:1rem;padding:12px 16px">
            <h2 style="margin:0 0 0.75rem;font-size:0.9rem">Plan Quality</h2>
            <div style="display:flex;flex-wrap:wrap;gap:4px">${badges}</div>
          </div>
        `;
      }
    }

    // Review-Fix Gate Snapshot — surface note near gate card if present
    const rfGate = projectResult.review_fix_gate_snapshot;
    if (rfGate && typeof rfGate === 'object') {
      const rfStatus = rfGate.status || rfGate.gate_status || '';
      const rfCls = rfStatus === 'passed' || rfStatus === 'ready' ? 'badge-green'
        : rfStatus === 'blocked' ? 'badge-red'
        : 'badge-amber';
      const rfCount = rfGate.required_count ?? rfGate.open_count ?? null;
      html += `
        <div class="card" style="margin-top:0.5rem;padding:10px 16px;border-left:3px solid var(--border)">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:0.8rem;font-weight:600;color:var(--text-muted)">Review-Fix Gate</span>
            ${rfStatus ? `<span class="badge ${rfCls}">${escapeHtmlHumble(rfStatus)}</span>` : ''}
            ${rfCount != null ? `<span class="text-muted" style="font-size:0.8rem">${rfCount} finding${rfCount !== 1 ? 's' : ''} required</span>` : ''}
          </div>
        </div>
      `;
    }

    updateApp(html);

    // Export button handler
    const exportBtn = document.getElementById('btn-export-project');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const taskRows = tasks.map(t => {
          const deps = Array.isArray(t.dependencies) ? t.dependencies.join(', ') : (t.dependencies || '');
          return `| ${nullSafe(t.id)} | ${nullSafe(t.name)} | ${t.status || ''} | ${t.size || ''} | ${nullSafe(t.done_criteria)} |`;
        }).join('\n');
        const taskTable = tasks.length > 0
          ? `| ID | Name | Status | Size | Done Criteria |\n|---|---|---|---|---|\n${taskRows}`
          : '_No tasks found._';

        const contextSections = docs.map(d => `### ${d.name}\n\n${d.content || ''}`).join('\n\n');

        const md = [
          `# Project: ${name}`,
          `Phase: ${phase}`,
          `Created: ${manifest?.created_at || '—'}`,
          `Updated: ${manifest?.updated_at || '—'}`,
          '',
          '## Tasks',
          taskTable,
          '',
          docs.length > 0 ? '## Context\n\n' + contextSections : '',
        ].join('\n');

        exportMarkdown(`project-${slug}.md`, md);
      });
    }
  });

  window.addEventListener('hashchange', stopPolling, { once: true });
}

function premiseStatusIcon(status) {
  if (status === 'survived') return '✅';
  if (status === 'weakened') return '⚠️';
  if (status === 'refuted')  return '❌';
  return '—';
}

function gradeLabel(grade) {
  const map = {
    validated:   { cls: 'badge-green', label: 'validated'   },
    data_backed: { cls: 'badge-blue',  label: 'data-backed' },
    heuristic:   { cls: 'badge-amber', label: 'heuristic'   },
    assumption:  { cls: 'badge-gray',  label: 'assumption'  },
  };
  const entry = map[grade];
  if (entry) return `<span class="badge ${entry.cls}">${entry.label}</span>`;
  return `<span class="badge badge-gray">${grade || '—'}</span>`;
}

function buildProbeDetailHtml(data) {
  const isV2 = data.schema_version === 2;
  const ts = data.timestamp ? new Date(data.timestamp).toLocaleString() : '—';

  let premisesHtml = '';
  if (isV2 && Array.isArray(data.premises) && data.premises.length > 0) {
    const rows = data.premises.map((p) => {
      const gradeCell = p.initial_grade === p.final_grade
        ? gradeLabel(p.final_grade)
        : `${gradeLabel(p.initial_grade)} → ${gradeLabel(p.final_grade)}`;
      return `<tr>
        <td style="text-align:center">${p.id}</td>
        <td>${nullSafe(p.statement)}</td>
        <td style="text-align:center">${premiseStatusIcon(p.status)}</td>
        <td>${gradeCell}</td>
        <td>${nullSafe(p.evidence_summary)}</td>
      </tr>`;
    }).join('');
    premisesHtml = `
      <div class="card" style="margin-top:1rem;padding:0">
        <div style="padding:1rem 1.25rem 0"><h2 style="margin:0">Premises</h2></div>
        <table class="table">
          <thead>
            <tr><th>#</th><th>Statement</th><th>Status</th><th>Evidence Grade</th><th>Evidence Summary</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  let evidenceSummaryHtml = '';
  if (isV2 && data.evidence_summary) {
    const es = data.evidence_summary;
    evidenceSummaryHtml = `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 .75rem">Evidence Summary</h2>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;text-align:center">
          <div><div style="font-size:1.5em;font-weight:700">${es.validated ?? 0}</div><span class="badge badge-green">validated</span></div>
          <div><div style="font-size:1.5em;font-weight:700">${es.data_backed ?? 0}</div><span class="badge badge-blue">data-backed</span></div>
          <div><div style="font-size:1.5em;font-weight:700">${es.heuristic ?? 0}</div><span class="badge badge-amber">heuristic</span></div>
          <div><div style="font-size:1.5em;font-weight:700">${es.assumption ?? 0}</div><span class="badge badge-gray">assumption</span></div>
        </div>
      </div>`;
  }

  const makeList = (items, title) => {
    if (!Array.isArray(items) || items.length === 0) return '';
    return `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 .5rem">${title}</h2>
        <ul style="margin:0;padding-left:1.25rem">${items.map((i) => `<li>${i}</li>`).join('')}</ul>
      </div>`;
  };

  const recommendationHtml = data.recommendation ? `
    <div class="card" style="margin-top:1rem">
      <h2 style="margin:0 0 .5rem">Recommendation</h2>
      <p style="margin:0">${data.recommendation}</p>
    </div>` : '';

  return `
    <div class="view-header">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <a href="#/probes" style="font-size:0.875rem;opacity:0.7">← Probes</a>
        ${pinButton(`/probes/${encodeURIComponent(data._file || '')}`, nullSafe(data.idea, 'Probe'))}
      </div>
      <h1 style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-top:0.5rem">
        ${nullSafe(data.idea, 'Probe Detail')}
        ${verdictBadge(data.verdict)}
      </h1>
      <div style="display:flex;align-items:center;gap:1rem">
        <p class="text-muted" style="margin:4px 0 0">${ts}${data.domain ? ` · ${data.domain}` : ''}</p>
        <button id="btn-export-probe" style="font-size:0.75rem;padding:0.25rem 0.6rem;background:transparent;border:1px solid var(--border,#e5e7eb);border-radius:4px;cursor:pointer;color:var(--text-muted)">↓ EXPORT</button>
      </div>
    </div>
    ${premisesHtml}
    ${evidenceSummaryHtml}
    ${makeList(data.evidence_gaps, 'Evidence Gaps')}
    ${makeList(data.risks, 'Risks')}
    ${makeList(data.kill_criteria, 'Kill Criteria')}
    ${recommendationHtml}
  `;
}

async function renderProbeDiff() {
  const app = document.getElementById('app');
  const { a, b } = getHashParams();

  if (!a || !b) {
    app.innerHTML = `
      <div class="view-header"><h1>Probe Diff</h1></div>
      <div class="card"><p class="text-muted">Missing parameters: a and b are required.</p></div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="view-header"><h1>Probe Diff</h1></div>
    ${renderLoading()}
  `;

  const url = `/api/probe/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`;
  const data = await fetchJSON(url);

  if (!data || data.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Probe Diff</h1></div>
      ${renderError(data ? data.message : 'unknown error')}
    `;
    return;
  }

  const { a: pa, b: pb, diff } = data;

  // Header: side-by-side
  const headerHtml = `
    <div class="diff-grid" style="margin-bottom:1rem">
      <div class="diff-side card" style="margin-bottom:0">
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem">A (Before)</div>
        <div style="font-weight:700;margin-bottom:0.5rem">${nullSafe(pa.idea)}</div>
        <div style="margin-bottom:0.25rem">${verdictBadge(pa.verdict)}</div>
        <div class="text-muted" style="font-size:0.8rem;margin-top:0.5rem">${pa.timestamp ? new Date(pa.timestamp).toLocaleDateString() : '—'}</div>
      </div>
      <div class="diff-side card" style="margin-bottom:0">
        <div style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem">B (After)</div>
        <div style="font-weight:700;margin-bottom:0.5rem">${nullSafe(pb.idea)}</div>
        <div style="margin-bottom:0.25rem">${verdictBadge(pb.verdict)}</div>
        <div class="text-muted" style="font-size:0.8rem;margin-top:0.5rem">${pb.timestamp ? new Date(pb.timestamp).toLocaleDateString() : '—'}</div>
      </div>
    </div>
  `;

  // Verdict change
  let verdictChangeHtml = '';
  if (diff.verdict && diff.verdict.changed) {
    verdictChangeHtml = `
      <div class="card diff-changed" style="margin-bottom:1rem">
        <strong style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Verdict Changed</strong>
        <div style="margin-top:0.5rem;display:flex;align-items:center;gap:0.75rem;font-size:1.1em">
          ${verdictBadge(diff.verdict.a)}
          <span style="color:var(--accent)">→</span>
          ${verdictBadge(diff.verdict.b)}
        </div>
      </div>
    `;
  }

  // Recommendation diff
  let recommendationHtml = '';
  if (diff.recommendation) {
    if (diff.recommendation.changed) {
      recommendationHtml = `
        <div class="card" style="margin-bottom:1rem">
          <strong style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Recommendation Changed</strong>
          <div class="diff-grid" style="margin-top:0.75rem">
            <div class="diff-removed" style="padding:0.75rem;font-size:0.85rem">${nullSafe(diff.recommendation.a)}</div>
            <div class="diff-added" style="padding:0.75rem;font-size:0.85rem">${nullSafe(diff.recommendation.b)}</div>
          </div>
        </div>
      `;
    } else {
      recommendationHtml = `
        <div class="card" style="margin-bottom:1rem">
          <strong style="font-size:0.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.1em">Recommendation</strong>
          <p style="margin-top:0.5rem">${nullSafe(diff.recommendation.b || diff.recommendation.a)}</p>
        </div>
      `;
    }
  }

  // Premises diff table
  let premisesHtml = '';
  if (diff.premises) {
    const { added = [], removed = [], changed = [], unchanged = [] } = diff.premises;
    if (added.length + removed.length + changed.length + unchanged.length > 0) {
      const addedRows = added.map(p => `
        <tr class="diff-added">
          <td style="color:var(--success);font-weight:700">+</td>
          <td>${nullSafe(p.statement)}</td>
          <td style="text-align:center">${premiseStatusIcon(p.status)}</td>
          <td>${gradeLabel(p.final_grade)}</td>
          <td class="text-muted" style="font-size:0.8rem">Added</td>
        </tr>`).join('');

      const removedRows = removed.map(p => `
        <tr class="diff-removed">
          <td style="color:var(--danger);font-weight:700">−</td>
          <td>${nullSafe(p.statement)}</td>
          <td style="text-align:center">${premiseStatusIcon(p.status)}</td>
          <td>${gradeLabel(p.final_grade)}</td>
          <td class="text-muted" style="font-size:0.8rem">Removed</td>
        </tr>`).join('');

      const changedRows = changed.map(({ a: pa, b: pb }) => `
        <tr class="diff-changed">
          <td style="color:var(--accent);font-weight:700">~</td>
          <td>${nullSafe(pb.statement || pa.statement)}</td>
          <td style="text-align:center">
            ${pa.status !== pb.status
              ? `${premiseStatusIcon(pa.status)} → ${premiseStatusIcon(pb.status)}`
              : premiseStatusIcon(pb.status)}
          </td>
          <td>
            ${pa.final_grade !== pb.final_grade
              ? `${gradeLabel(pa.final_grade)} → ${gradeLabel(pb.final_grade)}`
              : gradeLabel(pb.final_grade)}
          </td>
          <td class="text-muted" style="font-size:0.8rem">Changed</td>
        </tr>`).join('');

      const unchangedRows = unchanged.map(p => `
        <tr style="opacity:0.55">
          <td style="color:var(--text-muted)"> </td>
          <td>${nullSafe(p.statement)}</td>
          <td style="text-align:center">${premiseStatusIcon(p.status)}</td>
          <td>${gradeLabel(p.final_grade)}</td>
          <td class="text-muted" style="font-size:0.8rem">Unchanged</td>
        </tr>`).join('');

      premisesHtml = `
        <div class="card" style="margin-bottom:1rem;padding:0">
          <div style="padding:1rem 1.25rem 0"><h2 style="margin:0">Premises</h2></div>
          <table class="table">
            <thead><tr><th></th><th>Statement</th><th>Status</th><th>Grade</th><th>Change</th></tr></thead>
            <tbody>${addedRows}${removedRows}${changedRows}${unchangedRows}</tbody>
          </table>
        </div>
      `;
    }
  }

  // List diff helper
  function renderListDiff(diffObj, title) {
    if (!diffObj) return '';
    const { added = [], removed = [], unchanged = [] } = diffObj;
    if (added.length + removed.length + unchanged.length === 0) return '';
    const items = [
      ...added.map(i => `<li class="diff-added" style="padding:0.35rem 0.75rem;margin:2px 0"><span style="color:var(--success);font-weight:700;margin-right:0.5rem">+</span>${i}</li>`),
      ...removed.map(i => `<li class="diff-removed" style="padding:0.35rem 0.75rem;margin:2px 0"><span style="color:var(--danger);font-weight:700;margin-right:0.5rem">−</span>${i}</li>`),
      ...unchanged.map(i => `<li style="padding:0.35rem 0.75rem;margin:2px 0;opacity:0.6">${i}</li>`),
    ].join('');
    return `
      <div class="card" style="margin-bottom:1rem">
        <h2 style="margin:0 0 0.75rem">${title}</h2>
        <ul style="list-style:none;padding:0;margin:0">${items}</ul>
      </div>
    `;
  }

  const evidenceHtml   = renderListDiff(diff.evidence_gaps, 'Evidence Gaps');
  const risksHtml      = renderListDiff(diff.risks, 'Risks');
  const killHtml       = renderListDiff(diff.kill_criteria, 'Kill Criteria');

  app.innerHTML = `
    <div class="view-header">
      <div><a href="#/probes" style="font-size:0.875rem;opacity:0.7">← Probes</a></div>
      <h1 style="margin-top:0.5rem">Probe Diff</h1>
    </div>
    ${headerHtml}
    ${verdictChangeHtml}
    ${premisesHtml}
    ${evidenceHtml}
    ${risksHtml}
    ${killHtml}
    ${recommendationHtml}
  `;
}

async function renderProbesList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Probes</h1></div>
    ${renderLoading()}
  `;

  const [latest, historyRes] = await Promise.all([
    fetchJSON(apiUrl('/probe/latest')),
    fetchJSON(apiUrl('/probe/history')),
  ]);

  let latestCardHtml = '';
  if (latest && !latest.error) {
    const ts = latest.timestamp ? new Date(latest.timestamp).toLocaleString() : '—';
    const evidence = latest.evidence_summary ?? {};
    latestCardHtml = `
      <div class="card" style="margin-bottom:1rem">
        <div style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-bottom:.5rem">
          <strong style="font-size:1.1em">${nullSafe(latest.idea, 'Latest Probe')}</strong>
          ${verdictBadge(latest.verdict)}
        </div>
        <p class="text-muted" style="margin:0 0 .5rem">${ts}${latest.domain ? ` · ${latest.domain}` : ''}</p>
        ${latest.recommendation ? `<p style="margin:0 0 .5rem">${latest.recommendation}</p>` : ''}
        ${Object.keys(evidence).length > 0 ? `
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem">
          ${evidence.validated   != null ? `<span class="badge badge-green">validated: ${evidence.validated}</span>` : ''}
          ${evidence.data_backed != null ? `<span class="badge badge-blue">data-backed: ${evidence.data_backed}</span>` : ''}
          ${evidence.heuristic   != null ? `<span class="badge badge-amber">heuristic: ${evidence.heuristic}</span>` : ''}
          ${evidence.assumption  != null ? `<span class="badge badge-gray">assumption: ${evidence.assumption}</span>` : ''}
        </div>` : ''}
      </div>`;
  }

  const history = (!historyRes.error && Array.isArray(historyRes.data)) ? historyRes.data : [];

  let historyHtml = '';
  if (history.length > 0) {
    const canCompare = history.length >= 2;
    const compareToggleHtml = canCompare ? `
      <button id="btn-compare-toggle" style="font-size:0.75rem;padding:0.25rem 0.6rem;background:transparent;border:1px solid var(--border,#333);border-radius:4px;cursor:pointer;color:var(--text-muted)">Compare</button>
    ` : '';

    const rows = history.map((item, idx) => {
      const date = item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '—';
      const idea = nullSafe(item.idea, '—');
      const fileParam = item._file ?? `history-${idx}`;
      const premiseCount = Array.isArray(item.premises) ? item.premises.length : 0;
      const survived = Array.isArray(item.premises) ? item.premises.filter(p => p.status === 'survived').length : 0;
      const killed = Array.isArray(item.premises) ? item.premises.filter(p => p.status === 'killed').length : 0;
      const es = item.evidence_summary ?? {};
      const evidenceBadges = [
        es.validated   ? `<span class="badge badge-green" style="font-size:0.7em">${es.validated}V</span>` : '',
        es.data_backed ? `<span class="badge badge-blue" style="font-size:0.7em">${es.data_backed}D</span>` : '',
        es.heuristic   ? `<span class="badge badge-amber" style="font-size:0.7em">${es.heuristic}H</span>` : '',
        es.assumption  ? `<span class="badge badge-gray" style="font-size:0.7em">${es.assumption}A</span>` : '',
      ].filter(Boolean).join(' ');
      const rec = item.recommendation ? item.recommendation.slice(0, 80) + (item.recommendation.length > 80 ? '…' : '') : '—';
      return `<tr style="cursor:pointer" data-href="#/probes/${encodeURIComponent(fileParam)}" data-file="${fileParam}">
        <td class="compare-cell" style="display:none;width:32px;padding:10px 8px">
          <input type="checkbox" class="compare-check" data-file="${fileParam}" style="cursor:pointer">
        </td>
        <td>${date}</td>
        <td>${idea}</td>
        <td>${verdictBadge(item.verdict)}</td>
        <td>${nullSafe(item.domain)}</td>
        <td style="white-space:nowrap">${premiseCount} <span class="text-muted" style="font-size:0.8em">(${survived}✓ ${killed}✗)</span></td>
        <td>${evidenceBadges || '—'}</td>
        <td style="font-size:0.85em;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${item.recommendation ?? ''}">${rec}</td>
      </tr>`;
    }).join('');

    historyHtml = `
      <div class="card" style="padding:0">
        <div style="padding:1rem 1.25rem 0;display:flex;align-items:center;justify-content:space-between">
          <h2 style="margin:0">History</h2>
          <div style="display:flex;align-items:center;gap:0.5rem">
            ${compareToggleHtml}
            <button id="btn-compare-go" style="display:none;font-size:0.75rem;padding:0.25rem 0.6rem;background:var(--accent);border:none;border-radius:4px;cursor:pointer;color:#000;font-weight:700">Compare Selected</button>
          </div>
        </div>
        <table class="table" id="probe-history-table">
          <thead>
            <tr>
              <th class="compare-cell" style="display:none;width:32px"></th>
              <th>Date</th><th>Idea</th><th>Verdict</th><th>Domain</th><th>Premises</th><th>Evidence</th><th>Recommendation</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } else {
    historyHtml = renderEmpty('No probe history found.', 'xm:probe');
  }

  app.innerHTML = `
    <div class="view-header"><h1>Probes</h1></div>
    ${latestCardHtml}
    ${historyHtml}
  `;

  // Event delegation for table row clicks (CSP-safe, no inline onclick)
  const table = document.getElementById('probe-history-table');
  if (table) {
    table.addEventListener('click', (e) => {
      // Don't navigate if clicking a checkbox
      if (e.target.classList.contains('compare-check')) return;
      const row = e.target.closest('tr[data-href]');
      if (row) window.location.hash = row.dataset.href;
    });
  }

  // Compare mode toggle
  const btnToggle = document.getElementById('btn-compare-toggle');
  const btnGo = document.getElementById('btn-compare-go');
  if (btnToggle) {
    let compareMode = false;
    btnToggle.addEventListener('click', () => {
      compareMode = !compareMode;
      btnToggle.textContent = compareMode ? 'Cancel' : 'Compare';
      btnToggle.style.color = compareMode ? 'var(--accent)' : 'var(--text-muted)';
      document.querySelectorAll('.compare-cell').forEach(el => {
        el.style.display = compareMode ? '' : 'none';
      });
      if (!compareMode) {
        document.querySelectorAll('.compare-check').forEach(cb => { cb.checked = false; });
        if (btnGo) btnGo.style.display = 'none';
      }
    });
  }

  if (table) {
    table.addEventListener('change', (e) => {
      if (!e.target.classList.contains('compare-check')) return;
      const checked = [...document.querySelectorAll('.compare-check:checked')];
      if (checked.length > 2) {
        e.target.checked = false;
        return;
      }
      if (btnGo) {
        btnGo.style.display = checked.length === 2 ? '' : 'none';
      }
    });
  }

  if (btnGo) {
    btnGo.addEventListener('click', () => {
      const checked = [...document.querySelectorAll('.compare-check:checked')];
      if (checked.length !== 2) return;
      const [fileA, fileB] = checked.map(cb => cb.dataset.file);
      window.location.hash = `#/probes/diff?a=${encodeURIComponent(fileA)}&b=${encodeURIComponent(fileB)}`;
    });
  }
}

async function renderProbeDetail(file) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Probe</h1></div>
    ${renderLoading()}
  `;

  const url = file === 'latest'
    ? apiUrl('/probe/latest')
    : apiUrl(`/probe/history/${encodeURIComponent(file)}`);
  const data = await fetchJSON(url);

  if (!data || data.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Probe</h1></div>
      ${renderError(data ? data.message : 'unknown error')}
    `;
    return;
  }

  app.innerHTML = buildProbeDetailHtml(data);

  // Export button handler
  const exportBtn = document.getElementById('btn-export-probe');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const ts = data.timestamp ? new Date(data.timestamp).toLocaleString() : '—';
      const premiseRows = (Array.isArray(data.premises) ? data.premises : []).map(p => {
        const grade = p.initial_grade === p.final_grade
          ? p.final_grade
          : `${p.initial_grade} → ${p.final_grade}`;
        return `| ${p.id} | ${nullSafe(p.statement)} | ${p.status || ''} | ${grade} | ${nullSafe(p.evidence_summary)} |`;
      }).join('\n');
      const premiseTable = data.premises && data.premises.length > 0
        ? `| # | Statement | Status | Grade | Evidence |\n|---|---|---|---|---|\n${premiseRows}`
        : '_No premises._';

      const md = [
        `# Probe: ${nullSafe(data.idea, 'Probe')}`,
        `Verdict: ${data.verdict || '—'}`,
        `Date: ${ts}`,
        data.domain ? `Domain: ${data.domain}` : '',
        '',
        '## Premises',
        premiseTable,
        '',
        data.recommendation ? `## Recommendation\n\n${data.recommendation}` : '',
      ].filter(l => l !== undefined).join('\n');

      const slug = (data.idea || 'probe').toLowerCase().replace(/\s+/g, '-').slice(0, 40);
      exportMarkdown(`probe-${slug}.md`, md);
    });
  }
}

function solverStateBadge(state) {
  if (state === 'solved') return `<span class="badge badge-success">solved</span>`;
  return `<span class="badge badge-warning">${state || 'unknown'}</span>`;
}

const SOLVER_PHASES = ['01-intake', '02-classify', '03-solve', '04-verify', '05-close'];
const SOLVER_PHASE_CSS = {
  '01-intake':  'phase-01',
  '02-classify':'phase-02',
  '03-solve':   'phase-03',
  '04-verify':  'phase-04',
  '05-close':   'phase-05',
};

function solverPhaseBadge(phase) {
  if (!phase) return `<span class="badge badge-neutral">—</span>`;
  const cls = SOLVER_PHASE_CSS[phase] || 'badge-neutral';
  return `<span class="badge ${cls}">${phase}</span>`;
}

function renderSolversList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Solvers</h1></div>
    ${renderLoading()}
  `;

  const stopPolling = startPolling(async () => {
    const seq = _pollSequence;
    const res = await fetchJSON(apiUrl('/solver'));
    if (seq !== _pollSequence) return;
    if (res.error) {
      updateApp(`
        <div class="view-header"><h1>Solvers</h1></div>
        ${renderError(res.message)}
      `);
      return;
    }

    const solvers = Array.isArray(res.data) ? res.data : [];

    updateApp(`
      <div class="view-header">
        <h1>Solvers <span class="badge badge-neutral" style="font-size:0.85rem;vertical-align:middle">${solvers.length}</span></h1>
      </div>
      <div class="card" style="padding:0">
        ${solvers.length === 0 ? `<p class="text-muted" style="padding:1rem">No solver problems found.</p>` : `
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>State</th>
              <th>Strategy</th>
              <th>Phase</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            ${solvers.map(s => {
              const slug = s.name;
              const displayName = s.display_name || s.name || '—';
              const truncated = displayName.length > 80 ? displayName.slice(0, 80) + '…' : displayName;
              return `
              <tr>
                <td><a href="#/solvers/${slug}" title="${displayName.replace(/"/g, '&quot;')}">${truncated}</a></td>
                <td>${solverStateBadge(s.state)}</td>
                <td>${s.strategy ? `<span class="badge badge-info">${s.strategy}</span>` : '<span class="text-muted">—</span>'}</td>
                <td>${solverPhaseBadge(s.current_phase)}</td>
                <td class="text-muted">${timeAgo(s.created_at)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`}
      </div>
    `);
  });

  window.addEventListener('hashchange', stopPolling, { once: true });
}

function renderSolverDetail(slug) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Solver</h1></div>
    ${renderLoading()}
  `;

  const stopPolling = startPolling(async () => {
    const seq = _pollSequence;
    const res = await fetchJSON(apiUrl(`/solver/${encodeURIComponent(slug)}`));
    if (seq !== _pollSequence) return;
    if (res.error) {
      updateApp(`
        <div class="view-header"><h1>Solver: <code>${slug}</code></h1></div>
        ${renderError(res.message || res.error)}
      `);
      return;
    }

    const m = res.manifest || {};
    const phases = Array.isArray(res.phases) ? res.phases : [];
    const phaseSet = new Set(phases.map(p => p.phase));

    const solverRoutePath = `/solvers/${encodeURIComponent(slug)}`;
    let html = `
      <div class="view-header">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <a href="#/solvers" style="font-size:0.875rem;opacity:0.7">← Solvers</a>
          ${pinButton(solverRoutePath, m.display_name || m.name || slug)}
        </div>
        <h1 style="margin-top:0.5rem">${m.display_name || m.name || slug}</h1>
        <div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;margin-top:0.5rem">
          ${solverStateBadge(m.state)}
          ${m.strategy ? `<span class="badge badge-info">${m.strategy}</span>` : ''}
          ${solverPhaseBadge(m.current_phase)}
          <span class="text-muted" style="font-size:0.8rem">created ${timeAgo(m.created_at)}</span>
          ${m.closed_at ? `<span class="text-muted" style="font-size:0.8rem">· closed ${timeAgo(m.closed_at)}</span>` : ''}
          <button id="btn-export-solver" style="margin-left:auto;font-size:0.75rem;padding:0.25rem 0.6rem;background:transparent;border:1px solid var(--border,#e5e7eb);border-radius:4px;cursor:pointer;color:var(--text-muted)">↓ EXPORT</button>
        </div>
      </div>

      <div class="card" style="margin-top:1rem">
        <div style="font-weight:600;margin-bottom:0.5rem">Phase Progression</div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          ${SOLVER_PHASES.map(ph => {
            const isCurrent = m.current_phase === ph;
            const hasData = phaseSet.has(ph);
            const cls = (isCurrent || hasData) ? (SOLVER_PHASE_CSS[ph] || 'badge-neutral') : 'badge-neutral';
            const style = isCurrent ? 'outline:2px solid currentColor;outline-offset:2px' : '';
            return `<span class="badge ${cls}" style="${style}">${ph}</span>`;
          }).join('')}
        </div>
      </div>
    `;

    if (phases.length > 0) {
      for (const p of phases) {
        const files = p.files || {};
        let contentHtml = '';
        for (const [fname, content] of Object.entries(files)) {
          if (fname.endsWith('.md')) {
            contentHtml += `<div style="margin-top:0.75rem"><strong style="font-size:0.8rem;color:var(--text-muted)">${fname}</strong><div class="markdown-body" style="margin-top:0.25rem">${renderMarkdown(content)}</div></div>`;
          } else if (fname.endsWith('.json')) {
            contentHtml += `<div style="margin-top:0.75rem"><strong style="font-size:0.8rem;color:var(--text-muted)">${fname}</strong>${renderJsonSmart(content)}</div>`;
          } else {
            contentHtml += `<div style="margin-top:0.75rem"><strong style="font-size:0.8rem;color:var(--text-muted)">${fname}</strong><pre style="margin:0.25rem 0 0;white-space:pre-wrap;font-size:0.8rem">${content}</pre></div>`;
          }
        }
        html += `
          <div class="card" style="margin-top:1rem">
            <div style="font-weight:600;margin-bottom:0.5rem">${solverPhaseBadge(p.phase)} ${p.phase}</div>
            ${contentHtml || '<p class="text-muted">No data</p>'}
          </div>`;
      }
    }

    updateApp(html);

    // Export button handler
    const exportBtn = document.getElementById('btn-export-solver');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => {
        const sections = phases.map(p => {
          const fileContents = Object.entries(p.files || {}).map(([fname, content]) => {
            const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
            return `### ${fname}\n\n${text}`;
          }).join('\n\n');
          return `## Phase: ${p.phase}\n\n${fileContents || '_No data._'}`;
        }).join('\n\n');

        const md = [
          `# Solver: ${m.display_name || m.name || slug}`,
          `State: ${m.state || '—'}`,
          m.strategy ? `Strategy: ${m.strategy}` : '',
          `Phase: ${m.current_phase || '—'}`,
          `Created: ${m.created_at || '—'}`,
          m.closed_at ? `Closed: ${m.closed_at}` : '',
          '',
          sections || '_No phase data._',
        ].filter(l => l !== undefined).join('\n');

        exportMarkdown(`solver-${slug}.md`, md);
      });
    }
  });

  window.addEventListener('hashchange', stopPolling, { once: true });
}

function renderConfig() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Config</h1></div>
    ${renderLoading()}
  `;

  const stopPolling = startPolling(async () => {
    const seq = _pollSequence;
    const res = await fetchJSON(apiUrl('/config'));
    if (seq !== _pollSequence) return;
    if (res.error) {
      updateApp(`
        <div class="view-header"><h1>Config</h1></div>
        ${renderError(res.message ?? res.error)}
      `);
      return;
    }
    updateApp(`
      <div class="view-header"><h1>Config</h1></div>
      <div class="card">
        <pre style="margin:0;overflow:auto;font-size:0.85em">${JSON.stringify(res, null, 2)}</pre>
      </div>
    `);
  });

  window.addEventListener('hashchange', stopPolling, { once: true });
}

// ── x-op views ──────────────────────────────────────────────────────

const STRATEGY_BADGES = {
  debate: 'badge-blue', tournament: 'badge-amber', refine: 'badge-green',
  review: 'badge-indigo', 'red-team': 'badge-red', hypothesis: 'badge-purple',
  investigate: 'badge-teal', council: 'badge-blue', brainstorm: 'badge-amber',
  scaffold: 'badge-green', decompose: 'badge-indigo', chain: 'badge-gray',
  persona: 'badge-purple', socratic: 'badge-teal',
  monitor: 'badge-red', distribute: 'badge-green', compose: 'badge-amber',
};

// Resolve the numeric overall score for an op, with a deep fallback for the
// `self_score: { dim: { score, note }, ... }` shape (no top-level `overall`).
// Used by the Ops list, sort, distribution chart, and compare view so they all
// agree on what counts as a score across schema generations.
function opScoreNumber(op) {
  if (!op) return null;
  let n = op.self_score?.overall ?? op.outcome?.confidence ?? op.confidence;
  if (n == null && op.self_score && typeof op.self_score === 'object') {
    const dims = Object.values(op.self_score)
      .filter(v => v && typeof v === 'object' && typeof v.score === 'number')
      .map(v => v.score);
    if (dims.length > 0) {
      n = Math.round((dims.reduce((a, b) => a + b, 0) / dims.length) * 10) / 10;
    }
  }
  return n;
}

async function renderOpsList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Ops</h1></div>
    ${renderLoading()}
  `;

  const res = await fetchJSON(apiUrl('/op'));
  const ops = (!res.error && Array.isArray(res.data)) ? res.data : [];

  if (ops.length === 0) {
    app.innerHTML = `
      <div class="view-header"><h1>Ops</h1></div>
      ${renderEmpty('No strategy results found.', '/xm:op')}${wsEmptyHint()}
    `;
    return;
  }

  _opsData = ops;
  _opsSortCol = null;
  _opsSortAsc = true;
  const rows = renderOpsRows(ops);

  const distribution = renderOpScoreDistribution(ops);

  const thStyle = 'cursor:pointer;user-select:none';
  app.innerHTML = `
    <div class="view-header">
      <h1>Ops <span class="badge badge-neutral" style="font-size:0.85rem;vertical-align:middle">${ops.length}</span></h1>
    </div>
    ${distribution}
    <div id="compare-bar" style="display:none;padding:8px 12px;margin-bottom:8px;background:var(--surface);border:1px solid var(--border);border-radius:4px">
      <span id="compare-count" style="font-size:.85em"></span>
      <button onclick="runOpCompare()" style="margin-left:12px;padding:4px 12px;cursor:pointer" id="compare-btn" disabled>Compare</button>
      <button onclick="clearCompareSelection()" style="margin-left:6px;padding:4px 12px;cursor:pointer">Clear</button>
    </div>
    <div class="card" style="padding:0">
      <table class="table" id="ops-table">
        <thead>
          <tr>
            <th style="width:32px"></th>
            <th data-sort="date" style="${thStyle}" onclick="sortOpsTable('date')">Date<span class="sort-ind"> ↕</span></th>
            <th data-sort="strategy" style="${thStyle}" onclick="sortOpsTable('strategy')">Strategy<span class="sort-ind"> ↕</span></th>
            <th>Topic</th><th>Outcome</th>
            <th data-sort="score" style="${thStyle}" onclick="sortOpsTable('score')">Score<span class="sort-ind"> ↕</span></th>
            <th>Agents</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

// ── Ops list client-side sort ────────────────────────────────────────
let _opsData = [];
let _opsSortCol = null;
let _opsSortAsc = true;

function renderOpsRows(ops) {
  return ops.map((op) => {
    const rawDate = op.completed_at ?? op.created_at ?? op.date ?? op.timestamp;
    const date = (() => {
      if (!rawDate) return '—';
      const d = new Date(rawDate);
      return isNaN(d) ? String(rawDate) : d.toLocaleDateString();
    })();
    const stratClass = STRATEGY_BADGES[op.strategy] ?? 'badge-neutral';
    const topic = nullSafe(
      op.topic ?? op.question ?? op.subject ?? op.prompt ?? op.problem ?? op.goal
      ?? op.task ?? op.focus ?? op.claim ?? op.scenario ?? op.target ?? op.theme,
      '—'
    );
    const truncTopic = topic.length > 60 ? topic.slice(0, 57) + '…' : topic;
    const verdict = op.outcome?.verdict ?? op.verdict ?? op.outcome?.summary ?? '—';
    const verdictStr = typeof verdict === 'string' ? verdict : JSON.stringify(verdict);
    const truncVerdict = verdictStr.length > 50 ? verdictStr.slice(0, 47) + '…' : verdictStr;
    const scoreNum = opScoreNumber(op);
    const score = scoreNum != null ? `${scoreNum}/10` : '—';
    const agents = op.options?.agents ?? op.agents ?? '—';
    const fileParam = op._file ?? '';
    const escFile = fileParam.replace(/"/g, '&quot;');
    return `<tr>
      <td style="text-align:center;padding-right:0">
        <input type="checkbox" class="op-compare-cb" data-file="${escFile}" aria-label="Select for compare" onclick="event.stopPropagation();updateCompareBar()">
      </td>
      <td onclick="window.location.hash='#/ops/${encodeURIComponent(fileParam)}'" style="cursor:pointer">${date}</td>
      <td onclick="window.location.hash='#/ops/${encodeURIComponent(fileParam)}'" style="cursor:pointer"><span class="badge ${stratClass}">${op.strategy ?? '—'}</span></td>
      <td onclick="window.location.hash='#/ops/${encodeURIComponent(fileParam)}'" style="cursor:pointer" title="${topic.replace(/"/g, '&quot;')}">${truncTopic}</td>
      <td onclick="window.location.hash='#/ops/${encodeURIComponent(fileParam)}'" style="cursor:pointer" title="${verdictStr.replace(/"/g, '&quot;')}">${truncVerdict}</td>
      <td onclick="window.location.hash='#/ops/${encodeURIComponent(fileParam)}'" style="cursor:pointer;text-align:center">${score}</td>
      <td onclick="window.location.hash='#/ops/${encodeURIComponent(fileParam)}'" style="cursor:pointer;text-align:center">${agents}</td>
    </tr>`;
  }).join('');
}

function sortOpsTable(col) {
  if (_opsSortCol === col) {
    _opsSortAsc = !_opsSortAsc;
  } else {
    _opsSortCol = col;
    _opsSortAsc = true;
  }
  const sorted = [..._opsData].sort((a, b) => {
    let va, vb;
    if (col === 'date') {
      va = new Date(a.completed_at ?? a.created_at ?? a.date ?? a.timestamp ?? 0).getTime();
      vb = new Date(b.completed_at ?? b.created_at ?? b.date ?? b.timestamp ?? 0).getTime();
    } else if (col === 'strategy') {
      va = (a.strategy ?? '').toLowerCase();
      vb = (b.strategy ?? '').toLowerCase();
    } else if (col === 'score') {
      va = opScoreNumber(a) ?? -1;
      vb = opScoreNumber(b) ?? -1;
    } else {
      return 0;
    }
    if (va < vb) return _opsSortAsc ? -1 : 1;
    if (va > vb) return _opsSortAsc ? 1 : -1;
    return 0;
  });
  const tbody = document.querySelector('#ops-table tbody');
  if (tbody) tbody.innerHTML = renderOpsRows(sorted);
  // Update sort indicators
  document.querySelectorAll('#ops-table th[data-sort]').forEach(th => {
    const ind = th.querySelector('.sort-ind');
    if (ind) ind.textContent = th.dataset.sort === col ? (_opsSortAsc ? ' ▲' : ' ▼') : ' ↕';
  });
}

// ── Op compare (2-way side-by-side) ─────────────────────────────────
function getSelectedOpFiles() {
  return [...document.querySelectorAll('.op-compare-cb:checked')].map(c => c.dataset.file);
}
function updateCompareBar() {
  const bar = document.getElementById('compare-bar');
  const countEl = document.getElementById('compare-count');
  const btn = document.getElementById('compare-btn');
  if (!bar) return;
  const selected = getSelectedOpFiles();
  if (selected.length === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  countEl.textContent = `${selected.length} selected`;
  btn.disabled = selected.length !== 2;
  btn.style.opacity = selected.length === 2 ? '1' : '.5';
}
function clearCompareSelection() {
  document.querySelectorAll('.op-compare-cb').forEach(c => c.checked = false);
  updateCompareBar();
}
function runOpCompare() {
  const selected = getSelectedOpFiles();
  if (selected.length !== 2) return;
  window.location.hash = `#/ops/compare?a=${encodeURIComponent(selected[0])}&b=${encodeURIComponent(selected[1])}`;
}

async function renderOpCompare(aFile, bFile) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Compare</h1></div>${renderLoading()}`;
  const [a, b] = await Promise.all([
    fetchJSON(apiUrl(`/op/${encodeURIComponent(aFile)}`)),
    fetchJSON(apiUrl(`/op/${encodeURIComponent(bFile)}`)),
  ]);
  if (a.error || b.error) {
    app.innerHTML = `<div class="view-header"><h1>Compare</h1></div>${renderError('Error loading ops: ' + ((a.error ? a.message : b.message) || 'unknown'))}`;
    return;
  }
  const fieldsToShow = [
    ['Strategy', x => x.strategy],
    ['Topic', x => x.topic ?? x.question ?? x.subject ?? x.theme ?? x.problem ?? x.goal ?? x.task ?? x.focus ?? x.claim ?? x.scenario ?? x.target ?? x.prompt],
    ['Date', x => x.date || x.completed_at || x.created_at],
    ['Agents', x => x.args?.agents || x.options?.agents || x.config?.agents],
    ['Verdict', x => x.outcome?.verdict],
    ['Self-score (overall)', x => opScoreNumber(x)],
    ['Theme count', x => Array.isArray(x.themes) ? x.themes.length : '—'],
    ['Self-score: accuracy', x => x.self_score?.criteria?.accuracy?.score ?? x.self_score?.criteria?.accuracy],
    ['Self-score: completeness', x => x.self_score?.criteria?.completeness?.score ?? x.self_score?.criteria?.completeness],
    ['Self-score: consistency', x => x.self_score?.criteria?.consistency?.score ?? x.self_score?.criteria?.consistency],
    ['Self-score: clarity', x => x.self_score?.criteria?.clarity?.score ?? x.self_score?.criteria?.clarity],
    ['4Q evidence', x => x.four_q_check?.evidence?.status],
    ['4Q assumptions', x => x.four_q_check?.assumptions?.status],
  ];
  const e = escapeHtmlHumble;
  const rowsHtml = fieldsToShow.map(([label, getter]) => {
    const va = getter(a) ?? '—';
    const vb = getter(b) ?? '—';
    const diff = JSON.stringify(va) !== JSON.stringify(vb);
    const diffStyle = diff ? 'background:rgba(250,204,21,0.08)' : '';
    return `<tr style="${diffStyle}">
      <td class="text-muted" style="white-space:nowrap">${e(label)}</td>
      <td>${e(String(va))}</td>
      <td>${e(String(vb))}</td>
    </tr>`;
  }).join('');

  app.innerHTML = `
    <div class="view-header">
      <div><a href="#/ops" style="font-size:.85rem">← Ops</a></div>
      <h1 style="margin-top:.5rem">Compare</h1>
      <p class="text-muted" style="margin:4px 0 0;font-size:.85em">
        <strong>A:</strong> ${e(aFile)} · <strong>B:</strong> ${e(bFile)}
      </p>
    </div>
    <div class="card">
      <table class="table">
        <thead><tr><th>Field</th><th>A</th><th>B</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p class="text-muted" style="font-size:.75em;margin:.75rem 0 0">Highlighted rows = differ between A and B.</p>
    </div>
  `;
}

/**
 * Self-score distribution per strategy — horizontal histogram (1.0-step bins).
 * Shows mean + count per strategy. Pure SVG, no D3.
 */
function renderOpScoreDistribution(ops) {
  const e = escapeHtmlHumble;
  // Group by strategy, collect numeric self_score.overall
  const byStrategy = new Map();
  for (const op of ops) {
    const s = op.strategy ?? 'unknown';
    const score = Number(opScoreNumber(op));
    if (!Number.isFinite(score)) continue;
    if (!byStrategy.has(s)) byStrategy.set(s, []);
    byStrategy.get(s).push(score);
  }
  if (byStrategy.size === 0) return '';

  // 10 bins: [0,1) ... [9,10]
  const binCount = 10;
  const rowH = 42;
  const labelW = 100;
  const binW = 32;
  const width = labelW + binCount * binW + 80;
  const height = 30 + byStrategy.size * rowH;

  const rows = [];
  const sortedStrategies = [...byStrategy.entries()].sort((a, b) => b[1].length - a[1].length);
  let y = 20;
  for (const [strategy, scores] of sortedStrategies) {
    const bins = new Array(binCount).fill(0);
    for (const s of scores) {
      const b = Math.min(binCount - 1, Math.floor(s));
      bins[b]++;
    }
    const maxBin = Math.max(...bins, 1);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const stratClass = STRATEGY_BADGES[strategy] ?? 'badge-neutral';

    // SVG row
    const bars = bins.map((count, i) => {
      if (count === 0) return '';
      const h = (count / maxBin) * (rowH - 14);
      const x = labelW + i * binW + 2;
      const yTop = y + (rowH - 14 - h);
      const opacity = 0.3 + (count / maxBin) * 0.7;
      return `<rect x="${x}" y="${yTop}" width="${binW - 4}" height="${h}" fill="var(--accent)" opacity="${opacity}" rx="1"/>
        <text x="${x + (binW - 4) / 2}" y="${yTop - 2}" font-size="9" text-anchor="middle" fill="var(--text-muted)">${count}</text>`;
    }).join('');

    // Mean marker
    const meanX = labelW + mean * binW;
    const markers = `<line x1="${meanX}" y1="${y}" x2="${meanX}" y2="${y + rowH - 14}" stroke="#ef4444" stroke-width="2" stroke-dasharray="3,2"/>`;

    rows.push(`
      <foreignObject x="0" y="${y}" width="${labelW - 6}" height="${rowH - 8}">
        <div xmlns="http://www.w3.org/1999/xhtml" style="display:flex;align-items:center;gap:4px;font-size:12px">
          <span class="badge ${stratClass}" style="font-size:10px">${e(strategy)}</span>
          <span class="text-muted" style="font-size:10px">n=${scores.length}, μ=${mean.toFixed(1)}</span>
        </div>
      </foreignObject>
      ${bars}
      ${markers}
    `);
    y += rowH;
  }

  // X axis
  const axisY = y + 2;
  const ticks = [];
  for (let i = 0; i <= binCount; i++) {
    const x = labelW + i * binW;
    ticks.push(`<line x1="${x}" y1="${axisY}" x2="${x}" y2="${axisY + 3}" stroke="var(--text-muted)"/>
      <text x="${x}" y="${axisY + 14}" font-size="9" text-anchor="middle" fill="var(--text-muted)">${i}</text>`);
  }

  return `<div class="card" style="margin-bottom:1rem;overflow-x:auto">
    <h2 style="margin-top:0;font-size:0.95rem">Self-Score Distribution by Strategy
      <span class="text-muted" style="font-size:.75em;font-weight:400;margin-left:6px">bin=1.0, red dash=mean</span>
    </h2>
    <svg viewBox="0 0 ${width} ${height + 20}" style="width:100%;min-width:${width}px;height:${height + 20}px">
      ${rows.join('')}
      <line x1="${labelW}" y1="${axisY}" x2="${labelW + binCount * binW}" y2="${axisY}" stroke="var(--text-muted)"/>
      ${ticks.join('')}
      <text x="${labelW + (binCount * binW) / 2}" y="${axisY + 28}" font-size="10" text-anchor="middle" fill="var(--text-muted)">self-score (0-10)</text>
    </svg>
  </div>`;
}

async function renderOpDetail(file) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Op Detail</h1></div>
    ${renderLoading()}
  `;

  const data = await fetchJSON(apiUrl(`/op/${encodeURIComponent(file)}`));
  if (data.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Op Detail</h1></div>
      ${renderError(data.error)}
    `;
    return;
  }

  const ts = (() => {
    const t = data.completed_at ?? data.created_at ?? data.date ?? data.timestamp;
    if (!t) return '—';
    const d = new Date(t);
    return isNaN(d) ? String(t) : d.toLocaleString();
  })();
  const stratClass = STRATEGY_BADGES[data.strategy] ?? 'badge-neutral';

  // Outcome card — supports both legacy (outcome.{verdict,confidence,summary})
  // and v2 shapes where verdict/summary live at the root of the op JSON.
  const oVerdict = data.outcome?.verdict ?? data.verdict ?? null;
  const oConfidence = data.outcome?.confidence ?? data.confidence ?? null;
  // v2 outcome shapes carry extra rich keys (consensus_statement, follow_up_rfcs,
  // draft_v2_required, key_insight, recommendation, implementation, …). verdict/
  // confidence render in the metric grid; every other outcome key becomes its
  // own sub-section with white-space:pre-line so long paragraphs wrap and
  // explicit newlines survive.
  const HEADER_OUTCOME_KEYS = new Set(['verdict', 'confidence']);
  const renderOutcomeValue = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) {
      if (v.length === 0) return '<span class="text-muted">[]</span>';
      const allObjects = v.every(x => x !== null && typeof x === 'object' && !Array.isArray(x));
      if (allObjects) {
        const keys = [...new Set(v.flatMap(o => Object.keys(o)))];
        const head = `<thead><tr>${keys.map(k => `<th>${escapeHtmlHumble(k)}</th>`).join('')}</tr></thead>`;
        const body = v.map(row => `<tr>${keys.map(k => {
          const cv = row[k];
          if (cv == null) return '<td></td>';
          if (typeof cv === 'object') return `<td><pre style="margin:0;font-size:.8em">${escapeHtmlHumble(JSON.stringify(cv))}</pre></td>`;
          return `<td>${escapeHtmlHumble(String(cv))}</td>`;
        }).join('')}</tr>`).join('');
        return `<table class="table" style="font-size:.9em">${head}<tbody>${body}</tbody></table>`;
      }
      return `<ul style="margin:0;padding-left:1.25rem;line-height:1.55">${
        v.map(x => `<li style="margin-bottom:.25rem">${
          typeof x === 'string'
            ? escapeHtmlHumble(x)
            : `<pre style="margin:0;font-size:.85em">${escapeHtmlHumble(JSON.stringify(x, null, 2))}</pre>`
        }</li>`).join('')
      }</ul>`;
    }
    if (typeof v === 'object') {
      const rows = Object.entries(v).map(([ok, ov]) => {
        const cell = (ov != null && typeof ov === 'object')
          ? `<pre style="margin:0;font-size:.85em">${escapeHtmlHumble(JSON.stringify(ov, null, 2))}</pre>`
          : `<span style="white-space:pre-line">${escapeHtmlHumble(String(ov))}</span>`;
        return `<tr><td class="text-muted" style="padding-right:1rem;vertical-align:top"><code>${escapeHtmlHumble(ok)}</code></td><td>${cell}</td></tr>`;
      }).join('');
      return `<table class="table" style="width:auto;font-size:.9em"><tbody>${rows}</tbody></table>`;
    }
    return `<p style="margin:0;white-space:pre-line;line-height:1.55">${escapeHtmlHumble(String(v))}</p>`;
  };
  const outcomeSubsections = (data.outcome && typeof data.outcome === 'object')
    ? Object.entries(data.outcome)
        .filter(([k]) => !HEADER_OUTCOME_KEYS.has(k))
        .map(([k, v]) => `
          <div style="margin-top:1rem">
            <h3 style="margin:0 0 .4rem;font-size:1rem;text-transform:capitalize">${escapeHtmlHumble(k.replace(/_/g, ' '))}</h3>
            ${renderOutcomeValue(v)}
          </div>`).join('')
    : (data.summary != null
        ? `<div style="margin-top:1rem">
             <h3 style="margin:0 0 .4rem;font-size:1rem">Summary</h3>
             ${renderOutcomeValue(data.summary)}
           </div>`
        : '');
  const hasOutcomeSignal = oVerdict != null || oConfidence != null || outcomeSubsections;
  const outcomeHtml = hasOutcomeSignal ? `
    <div class="card" style="margin-top:1rem">
      <h2 style="margin:0 0 .75rem">Outcome</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;text-align:center">
        <div><div style="font-size:1.3em;font-weight:700">${nullSafe(oVerdict, '—')}</div><span class="text-muted">Verdict</span></div>
        ${oConfidence != null ? `<div><div style="font-size:1.3em;font-weight:700">${oConfidence}/10</div><span class="text-muted">Confidence</span></div>` : ''}
      </div>
      ${outcomeSubsections}
    </div>` : '';

  // Themes / Ideas (brainstorm, council, etc.)
  let themesHtml = '';
  if (Array.isArray(data.themes) && data.themes.length > 0) {
    const themeCards = data.themes.map(t => {
      const ideas = Array.isArray(t.ideas) ? t.ideas : [];
      const ideasList = ideas.map(i => {
        if (typeof i === 'string') return `<li>${escapeHtmlHumble(i)}</li>`;
        const label = i.title || i.name || i.id || '';
        const body = i.description || i.content || i.text || '';
        return `<li style="margin-bottom:.35rem">${label ? `<strong>${escapeHtmlHumble(label)}</strong>${body ? ' — ' : ''}` : ''}${escapeHtmlHumble(body)}</li>`;
      }).join('');
      return `<details ${ideas.length <= 5 ? 'open' : ''} style="margin-bottom:.5rem;border-left:3px solid var(--border);padding:.5rem .75rem">
        <summary style="cursor:pointer;font-weight:600">
          ${t.id ? `<code style="margin-right:6px">${escapeHtmlHumble(t.id)}</code>` : ''}${escapeHtmlHumble(t.name ?? 'Theme')} <span class="text-muted" style="font-weight:400;font-size:.85em">(${ideas.length})</span>
        </summary>
        ${ideas.length ? `<ul style="margin:.5rem 0 0;padding-left:1.25rem;line-height:1.5">${ideasList}</ul>` : ''}
      </details>`;
    }).join('');
    themesHtml = `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 .75rem">Themes <span class="text-muted" style="font-size:.85em;font-weight:400">(${data.themes.length})</span></h2>
        ${themeCards}
      </div>`;
  }

  // Current surface (brainstorm / investigate: pre-analysis state)
  let surfaceHtml = '';
  if (data.current_surface && typeof data.current_surface === 'object') {
    const rows = Object.entries(data.current_surface).map(([k, v]) =>
      `<tr><td class="text-muted" style="white-space:nowrap;vertical-align:top;padding-right:1rem"><code>${escapeHtmlHumble(k)}</code></td><td>${escapeHtmlHumble(String(v))}</td></tr>`
    ).join('');
    surfaceHtml = `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 .75rem">Current Surface</h2>
        <table class="table" style="width:auto"><tbody>${rows}</tbody></table>
      </div>`;
  }

  // 4Q hallucination check
  let fourQHtml = '';
  if (data.four_q_check && typeof data.four_q_check === 'object') {
    const statusBadge = (s) => humbleBadge(s, s === 'ok' ? 'active' : s === 'warn' ? 'medium' : s === 'fail' ? 'high' : 'low');
    const rows = Object.entries(data.four_q_check).map(([k, v]) => {
      const status = v?.status ?? '—';
      const note = v?.note ?? '';
      return `<tr><td><strong>${escapeHtmlHumble(k)}</strong></td><td>${statusBadge(status)}</td><td style="font-size:.85em">${escapeHtmlHumble(note)}</td></tr>`;
    }).join('');
    fourQHtml = `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 .75rem">4Q Check</h2>
        <table class="table"><thead><tr><th>Check</th><th>Status</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
  }

  // Self-score card
  let scoreHtml = '';
  if (data.self_score) {
    const criteria = data.self_score.criteria ?? {};
    let criteriaRows = '';
    if (Object.keys(criteria).length > 0) {
      // Structured criteria: each value may be {score, note} or a plain number
      criteriaRows = Object.entries(criteria).map(([k, v]) => {
        if (v !== null && typeof v === 'object' && 'score' in v) {
          return `<tr><td>${escapeHtmlHumble(k)}</td><td style="text-align:center">${v.score}/10</td><td class="text-muted" style="font-size:0.85em">${v.note ? escapeHtmlHumble(String(v.note)) : ''}</td></tr>`;
        }
        return `<tr><td>${escapeHtmlHumble(k)}</td><td style="text-align:center">${v}/10</td><td></td></tr>`;
      }).join('');
    } else {
      // No explicit criteria key — scan top-level keys for {score,note} objects or numbers
      const scoreEntries = Object.entries(data.self_score).filter(([k, v]) =>
        k !== 'overall' && (
          (typeof v === 'object' && v !== null && 'score' in v) ||
          typeof v === 'number'
        )
      );
      const boolEntries = Object.entries(data.self_score).filter(([k, v]) =>
        k !== 'overall' && typeof v === 'object' && v !== null && !('score' in v)
      );
      if (scoreEntries.length > 0) {
        criteriaRows = scoreEntries.map(([k, v]) => {
          if (typeof v === 'object' && 'score' in v) {
            return `<tr><td>${escapeHtmlHumble(k)}</td><td style="text-align:center">${v.score}/10</td><td class="text-muted" style="font-size:0.85em">${v.note ? escapeHtmlHumble(String(v.note)) : ''}</td></tr>`;
          }
          return `<tr><td>${escapeHtmlHumble(k)}</td><td style="text-align:center">${v}/10</td><td></td></tr>`;
        }).join('');
        if (boolEntries.length > 0) {
          criteriaRows += `<tr><td colspan="3" class="text-muted" style="font-size:0.8em;padding-top:0.5rem">${boolEntries.map(([k, v]) => `<strong>${escapeHtmlHumble(k)}</strong>: ${escapeHtmlHumble(JSON.stringify(v))}`).join(' · ')}</td></tr>`;
        }
      }
    }
    scoreHtml = `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 .75rem">Self-Score: ${data.self_score.overall ?? '—'}/10</h2>
        <table class="table">
          <thead><tr><th>Criterion</th><th>Score</th><th>Note</th></tr></thead>
          <tbody>${criteriaRows}</tbody>
        </table>
      </div>`;
  }

  // Participants card
  let participantsHtml = '';
  if (Array.isArray(data.participants) && data.participants.length > 0) {
    const pRows = data.participants.map(p =>
      `<tr><td>${nullSafe(p.role)}</td><td>${nullSafe(p.position, '—')}</td></tr>`
    ).join('');
    participantsHtml = `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 .75rem">Participants</h2>
        <table class="table">
          <thead><tr><th>Role</th><th>Position</th></tr></thead>
          <tbody>${pRows}</tbody>
        </table>
      </div>`;
  }

  // Rounds summary card — strategies have heterogeneous per-phase fields
  // (brainstorm: agents/mode/seed_angles/ideas_produced/deduplicated;
  //  debate: round/phase/summary; etc.). Render what's present.
  let roundsHtml = '';
  if (Array.isArray(data.rounds_summary) && data.rounds_summary.length > 0) {
    const rCards = data.rounds_summary.map((r, i) => {
      const head = `${r.round != null ? `Round ${r.round}` : `Phase ${i + 1}`}${r.name ? ` — ${escapeHtmlHumble(r.name)}` : ''}${r.phase ? ` — ${escapeHtmlHumble(r.phase)}` : ''}`;
      const rows = Object.entries(r)
        .filter(([k]) => k !== 'round' && k !== 'phase')
        .map(([k, v]) => {
          let display;
          if (Array.isArray(v)) {
            if (v.length === 0) {
              display = '<span class="text-muted">[]</span>';
            } else if (v.every(x => x !== null && typeof x === 'object' && !Array.isArray(x))) {
              // array-of-objects (positions[], findings[], candidates[]) → column table
              const colKeys = [...new Set(v.flatMap(o => Object.keys(o)))];
              const head = `<thead><tr>${colKeys.map(ck => `<th>${escapeHtmlHumble(ck)}</th>`).join('')}</tr></thead>`;
              const body = v.map(row => `<tr>${colKeys.map(ck => {
                const cv = row[ck];
                if (cv == null) return '<td></td>';
                if (typeof cv === 'object') return `<td><pre style="margin:0;font-size:.8em">${escapeHtmlHumble(JSON.stringify(cv))}</pre></td>`;
                return `<td>${escapeHtmlHumble(String(cv))}</td>`;
              }).join('')}</tr>`).join('');
              display = `<table class="table" style="font-size:.85em">${head}<tbody>${body}</tbody></table>`;
            } else {
              display = v.map(x => typeof x === 'string' ? `<code>${escapeHtmlHumble(x)}</code>` : escapeHtmlHumble(JSON.stringify(x))).join(' ');
            }
          } else if (typeof v === 'object' && v !== null) {
            // plain object → key/value vertical table
            const objRows = Object.entries(v).map(([ok, ov]) => {
              const cell = (ov != null && typeof ov === 'object')
                ? `<pre style="margin:0;font-size:.8em">${escapeHtmlHumble(JSON.stringify(ov, null, 2))}</pre>`
                : escapeHtmlHumble(String(ov));
              return `<tr><td class="text-muted" style="padding-right:1rem;vertical-align:top"><code>${escapeHtmlHumble(ok)}</code></td><td>${cell}</td></tr>`;
            }).join('');
            display = `<table class="table" style="width:auto;font-size:.85em"><tbody>${objRows}</tbody></table>`;
          } else {
            display = escapeHtmlHumble(String(v));
          }
          return `<tr><td class="text-muted" style="white-space:nowrap;padding-right:1rem;vertical-align:top">${escapeHtmlHumble(k)}</td><td>${display}</td></tr>`;
        }).join('');
      return `<div style="margin-bottom:.75rem;padding:.5rem .75rem;border-left:3px solid var(--border)">
        <div style="font-weight:600;margin-bottom:.3rem">${head}</div>
        ${rows ? `<table class="table" style="width:auto;font-size:.9em"><tbody>${rows}</tbody></table>` : ''}
      </div>`;
    }).join('');
    roundsHtml = `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 .75rem">Rounds / Phases</h2>
        ${rCards}
      </div>`;
  }

  // Options card
  const optsHtml = data.options ? `
    <div class="card" style="margin-top:1rem">
      <h2 style="margin:0 0 .75rem">Options</h2>
      <pre style="margin:0;font-size:0.85em">${JSON.stringify(data.options, null, 2)}</pre>
    </div>` : '';

  // Catch-all: any top-level fields we didn't render in a dedicated card get
  // an "Additional Fields" table so v2 ops with new keys (key_findings,
  // recommendation, evidence_extensions, gaps, next_strategy, angles, depth …)
  // are visible instead of silently dropped.
  const KNOWN_FIELDS = new Set([
    '_file', 'schema_version', 'strategy', 'topic', 'args', 'options',
    'date', 'created_at', 'completed_at', 'timestamp', 'status',
    'outcome', 'verdict', 'summary', 'confidence',
    'themes', 'current_surface', 'four_q_check', 'self_score',
    'participants', 'rounds_summary', 'project', 'slug', 'source',
    'candidates_count',
  ]);
  // Recursive value renderer — prefers tables over raw JSON:
  //   array-of-objects → column-union table (keys become column headers)
  //   plain object     → key/value vertical table
  //   array-of-primitives or mixed → bullet list (objects within get a nested table)
  //   primitive        → escaped text
  const renderValue = (v) => {
    if (v == null) return '';
    if (Array.isArray(v)) {
      if (v.length === 0) return '<span class="text-muted">[]</span>';
      const allObjects = v.every(x => x !== null && typeof x === 'object' && !Array.isArray(x));
      if (allObjects) {
        const keys = [...new Set(v.flatMap(o => Object.keys(o)))];
        const head = `<thead><tr>${keys.map(k => `<th>${escapeHtmlHumble(k)}</th>`).join('')}</tr></thead>`;
        const body = v.map(row => {
          const cells = keys.map(k => {
            const cv = row[k];
            if (cv == null) return '<td></td>';
            if (Array.isArray(cv) || typeof cv === 'object') {
              return `<td>${renderValue(cv)}</td>`;
            }
            return `<td>${escapeHtmlHumble(String(cv))}</td>`;
          }).join('');
          return `<tr>${cells}</tr>`;
        }).join('');
        return `<table class="table" style="font-size:.9em">${head}<tbody>${body}</tbody></table>`;
      }
      return `<ul style="margin:0;padding-left:1.25rem;line-height:1.5">${
        v.map(x => `<li style="margin-bottom:.25rem">${
          x !== null && typeof x === 'object'
            ? renderValue(x)
            : escapeHtmlHumble(String(x))
        }</li>`).join('')
      }</ul>`;
    }
    if (typeof v === 'object') {
      const rows = Object.entries(v).map(([k, cv]) => {
        const cell = (cv != null && (Array.isArray(cv) || typeof cv === 'object'))
          ? renderValue(cv)
          : escapeHtmlHumble(String(cv));
        return `<tr><td class="text-muted" style="white-space:nowrap;vertical-align:top;padding-right:1rem"><code>${escapeHtmlHumble(k)}</code></td><td>${cell}</td></tr>`;
      }).join('');
      return `<table class="table" style="width:auto;font-size:.9em"><tbody>${rows}</tbody></table>`;
    }
    return escapeHtmlHumble(String(v));
  };

  const extraEntries = Object.entries(data).filter(([k]) => !KNOWN_FIELDS.has(k));
  const rawFieldsHtml = extraEntries.length > 0 ? `
    <div class="card" style="margin-top:1rem">
      <h2 style="margin:0 0 .75rem">Additional Fields <span class="text-muted" style="font-size:.85em;font-weight:400">(${extraEntries.length})</span></h2>
      <table class="table" style="width:auto"><tbody>${
        extraEntries.map(([k, v]) =>
          `<tr><td class="text-muted" style="white-space:nowrap;vertical-align:top;padding-right:1rem"><code>${escapeHtmlHumble(k)}</code></td><td>${renderValue(v)}</td></tr>`
        ).join('')
      }</tbody></table>
    </div>` : '';

  const opRoutePath = `/ops/${encodeURIComponent(file)}`;
  app.innerHTML = `
    <div class="view-header">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <a href="#/ops" style="font-size:0.875rem;opacity:0.7">← Ops</a>
        ${pinButton(opRoutePath, `${data.strategy || 'op'} · ${data.topic || file}`)}
      </div>
      <h1 style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap;margin-top:0.5rem">
        <span class="badge ${stratClass}">${data.strategy ?? '—'}</span>
        ${nullSafe(data.topic ?? data.question ?? data.subject ?? data.prompt ?? data.problem ?? data.goal ?? data.task ?? data.focus ?? data.claim ?? data.scenario ?? data.target ?? data.theme, 'Op Detail')}
      </h1>
      <p class="text-muted" style="margin:4px 0 0">${ts}</p>
    </div>
    ${outcomeHtml}
    ${themesHtml}
    ${participantsHtml}
    ${roundsHtml}
    ${surfaceHtml}
    ${fourQHtml}
    ${scoreHtml}
    ${optsHtml}
    ${rawFieldsHtml}
  `;
}

async function renderTracesList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Traces</h1><p>.xm/traces/</p></div>
    ${renderLoading()}
  `;

  const res = await fetchJSON(apiUrl('/traces'));
  if (res.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Traces</h1><p>.xm/traces/</p></div>
      ${renderError(res.message)}
    `;
    return;
  }

  const traces = Array.isArray(res.traces) ? res.traces : [];
  const activeFile = res.active ?? null;

  if (traces.length === 0) {
    app.innerHTML = `
      <div class="view-header"><h1>Traces</h1><p>.xm/traces/</p></div>
      <div class="card" style="text-align:center;padding:3rem">
        <div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">◇</div>
        <p class="text-muted">No trace data yet.</p>
        <p style="font-size:0.8rem;color:var(--text-muted)">Run <code>/xm:trace start</code> to begin recording agent execution.</p>
      </div>
    `;
    return;
  }

  const rows = traces.map(t => {
    const isActive = activeFile && t.file === activeFile;
    const liveBadge = isActive ? `<span class="badge badge-green" style="margin-left:6px;animation:none">LIVE</span>` : '';
    const statusBadgeHtml = t.status === 'active'
      ? `<span class="badge badge-amber">Active</span>`
      : `<span class="badge badge-gray">Done</span>`;
    const dur = t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)}s` : t.duration != null ? `${(t.duration / 1000).toFixed(1)}s` : '—';
    const cost = t.cost != null && t.cost > 0 ? `$${t.cost.toFixed(3)}` : '—';
    const agents = t.agents != null && t.agents > 0 ? t.agents : '—';
    return `
      <tr${isActive ? ' style="background:rgba(105,240,174,0.05)"' : ''}>
        <td><a href="#/traces/${encodeURIComponent(t.file)}">${t.name || t.file}</a>${liveBadge}</td>
        <td class="mono" style="font-size:11px">${t.date || timeAgo(t.startTime ?? t.started_at) || '—'}</td>
        <td>${nullSafe(t.entryCount ?? t.entries, '—')}</td>
        <td>${dur}</td>
        <td style="text-align:right">${cost}</td>
        <td style="text-align:center">${agents}</td>
        <td>${statusBadgeHtml}</td>
      </tr>
    `;
  }).join('');

  app.innerHTML = `
    <div class="view-header"><h1>Traces</h1><p>.xm/traces/</p></div>
    <div class="card" style="padding:0">
      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Date</th>
            <th>Entries</th>
            <th>Duration</th>
            <th style="text-align:right">Cost</th>
            <th style="text-align:center">Agents</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function traceTypeBadge(type) {
  const map = {
    session_start: ['badge-blue',   'START'],
    session_end:   ['badge-green',  'END'],
    agent_call:    ['badge-amber',  'AGENT'],
    agent_step:    ['badge-amber',  'STEP'],
    fan_out:       ['badge-purple', 'FAN-OUT'],
    synthesize:    ['badge-green',  'SYNTH'],
    checkpoint:    ['badge-gray',   'CHECKPOINT'],
  };
  const [cls, label] = map[type] ?? ['badge-gray', type || '?'];
  return `<span class="badge ${cls} trace-type">${label}</span>`;
}

async function renderTraceDetail(file) {
  const app = document.getElementById('app');
  const decodedFile = decodeURIComponent(file);
  app.innerHTML = `
    <div class="breadcrumb">${multiRootMode && currentWsId ? `<span class="text-accent" style="margin-right:4px">${currentWsId}</span><span class="sep">/</span>` : ''}<a href="#/traces">Traces</a><span class="sep">/</span>${decodedFile}</div>
    <div class="view-header"><h1>Trace: <code>${decodedFile}</code></h1></div>
    ${renderLoading()}
  `;

  let offset = 0;
  const limit = 200;

  async function loadEntries(currentOffset) {
    const res = await fetchJSON(apiUrl(`/traces/${encodeURIComponent(decodedFile)}?limit=${limit}&offset=${currentOffset}`));
    if (res.error) {
      app.innerHTML = `
        <div class="breadcrumb">${multiRootMode && currentWsId ? `<span class="text-accent" style="margin-right:4px">${currentWsId}</span><span class="sep">/</span>` : ''}<a href="#/traces">Traces</a><span class="sep">/</span>${decodedFile}</div>
        <div class="view-header"><h1>Trace: <code>${decodedFile}</code></h1></div>
        ${renderError(res.message)}
      `;
      return;
    }

    const entries = Array.isArray(res.entries) ? res.entries : [];
    const total = res.total ?? entries.length;
    const hasMore = (currentOffset + entries.length) < total;

    // Compute summary (calculate cost from tokens_est + model pricing)
    let totalCost = 0;
    let totalIn = 0;
    let totalOut = 0;
    let minTs = null;
    let maxTs = null;
    for (const e of entries) {
      const inTok = e.tokens_est?.input ?? e.input_tokens ?? e.tokens_in ?? 0;
      const outTok = e.tokens_est?.output ?? e.output_tokens ?? e.tokens_out ?? 0;
      totalIn += inTok;
      totalOut += outTok;
      // Compute cost from tokens if not pre-calculated
      const cost = e.cost ?? calcEntryCost(e);
      e._cost = cost; // cache for chart use
      totalCost += cost;
      const ts = e.timestamp ?? e.ts;
      if (ts) {
        // Skip checkpoint entries for time range — they record historical events, not session activity
        if (e.type === 'checkpoint') continue;
        if (!minTs || ts < minTs) minTs = ts;
        if (!maxTs || ts > maxTs) maxTs = ts;
      }
    }
    const totalDurMs = (minTs && maxTs) ? (new Date(maxTs) - new Date(minTs)) : null;
    const totalDurStr = totalDurMs != null ? `${(totalDurMs / 1000).toFixed(1)}s` : '—';

    // Build parent-child map for fan_out indentation
    const parentMap = {};
    for (const e of entries) {
      if (e.parent_id) {
        if (!parentMap[e.parent_id]) parentMap[e.parent_id] = [];
        parentMap[e.parent_id].push(e.id ?? e.seq);
      }
    }

    const entryRows = entries.map(e => {
      const isChild = !!e.parent_id;
      const ts = e.timestamp ?? e.ts ?? '';
      const tsDisplay = ts ? ts.slice(11, 19) : '—';
      const dur = e.duration_ms != null ? `${(e.duration_ms / 1000).toFixed(2)}s` : '—';
      const tokIn  = e.tokens_est?.input ?? e.input_tokens ?? e.tokens_in ?? null;
      const tokOut = e.tokens_est?.output ?? e.output_tokens ?? e.tokens_out ?? null;
      const cost   = e._cost || e.cost || null;

      let agentInfo = '';
      if (e.role || e.agent_role || e.model) {
        agentInfo = `<span style="color:var(--text)">${e.role || e.agent_role || ''}</span>`;
        if (e.model) agentInfo += ` <span class="text-muted">(${e.model})</span>`;
      } else if (e.message) {
        agentInfo = `<span class="text-muted" style="font-size:11px">${e.message.slice(0, 80)}</span>`;
      }

      const tokStr = (tokIn != null || tokOut != null)
        ? `<span class="trace-tokens">${tokIn != null ? tokIn.toLocaleString() : '?'} in / ${tokOut != null ? tokOut.toLocaleString() : '?'} out</span>`
        : '';
      const costStr = cost != null
        ? `<span class="trace-tokens" style="color:var(--accent)">$${cost.toFixed(4)}</span>`
        : '';

      return `
        <div class="trace-entry${isChild ? ' trace-entry-child' : ''}">
          <span class="text-muted mono" style="font-size:11px;min-width:70px">${tsDisplay}</span>
          ${traceTypeBadge(e.type)}
          <span style="flex:1">${agentInfo}</span>
          <span class="trace-tokens">${dur}</span>
          ${tokStr}
          ${costStr}
        </div>
      `;
    }).join('');

    const costDisplay = totalCost > 0 ? `$${totalCost.toFixed(4)}` : '—';
    const tokDisplay = (totalIn + totalOut) > 0 ? `${(totalIn + totalOut).toLocaleString()} tokens` : '';

    app.innerHTML = `
      <div class="breadcrumb">${multiRootMode && currentWsId ? `<span class="text-accent" style="margin-right:4px">${currentWsId}</span><span class="sep">/</span>` : ''}<a href="#/traces">Traces</a><span class="sep">/</span>${decodedFile}</div>
      <div class="view-header">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span></span>
          ${pinButton(`/traces/${encodeURIComponent(decodedFile)}`, `trace · ${decodedFile}`)}
        </div>
        <h1 style="margin-top:0.25rem">Trace: <code>${decodedFile}</code></h1>
      </div>
      <div class="stat-bar" style="margin-bottom:16px">
        <div class="card stat-card">
          <div class="stat-value">${total}</div>
          <div class="stat-label">Entries</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value" style="font-size:20px">${totalDurStr}</div>
          <div class="stat-label">Duration</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value" style="font-size:20px">${costDisplay}</div>
          <div class="stat-label">Total Cost</div>
        </div>
        ${tokDisplay ? `<div class="card stat-card">
          <div class="stat-value" style="font-size:16px">${tokDisplay}</div>
          <div class="stat-label">Tokens</div>
        </div>` : ''}
      </div>
      <div id="trace-charts" class="trace-charts-grid" style="margin-bottom:16px">
        <div class="card" style="grid-column:1/3;padding:16px">
          <h3 style="margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted)">Timeline</h3>
          <div id="gantt-container"></div>
        </div>
        <div class="card" style="padding:16px">
          <h3 style="margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted)">Cost</h3>
          <canvas id="cost-waterfall-chart"></canvas>
        </div>
        <div class="card" style="padding:16px">
          <h3 style="margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted)">Models</h3>
          <canvas id="model-donut-chart"></canvas>
        </div>
      </div>
      <div class="card" style="padding:0" id="trace-entries">
        ${entryRows || '<div class="trace-entry"><span class="text-muted">No entries.</span></div>'}
      </div>
      ${hasMore ? `<div style="margin-top:12px;text-align:center">
        <button id="btn-load-more" style="background:var(--surface);border:var(--border);color:var(--accent);padding:8px 20px;font-family:var(--font-mono);font-size:11px;font-weight:700;text-transform:uppercase;cursor:pointer;letter-spacing:0.08em">
          Load More (${total - currentOffset - entries.length} remaining)
        </button>
      </div>` : ''}
    `;

    const loadMoreBtn = document.getElementById('btn-load-more');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener('click', () => loadEntries(currentOffset + entries.length));
    }

    // Set Chart.js dark theme defaults before rendering
    if (window.Chart) {
      const cs = getComputedStyle(document.documentElement);
      const txtColor = cs.getPropertyValue('--text-muted').trim() || '#ccc';
      const gridColor = cs.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.1)';
      Chart.defaults.color = txtColor;
      Chart.defaults.borderColor = gridColor;
    }
    renderGanttChart(entries, minTs, maxTs);
    renderCostWaterfall(entries, minTs);
    renderModelDonut(entries);
  }

  await loadEntries(offset);
}

// ── Trace Charts ─────────────────────────────────────────────────────────────

function renderGanttChart(entries, minTs, maxTs) {
  const container = document.getElementById('gantt-container');
  if (!container) return;

  const agentSteps = entries.filter(e => e.type === 'agent_step');
  if (agentSteps.length === 0) {
    container.innerHTML = '<p class="text-muted" style="font-size:12px;padding:8px 0">No agent data for charts</p>';
    return;
  }

  const laneMap = { haiku: 0, sonnet: 1, opus: 2 };
  const laneLabels = ['haiku', 'sonnet', 'opus'];
  const usedLanes = new Set();
  for (const e of agentSteps) {
    const m = (e.model || '').toLowerCase();
    usedLanes.add(laneMap[m] !== undefined ? laneMap[m] : 3);
  }
  const hasOther = usedLanes.has(3);
  if (hasOther) laneLabels.push('other');
  const laneCount = hasOther ? 4 : Math.max(...[...usedLanes]) + 1 || 1;

  const totalMs = (minTs && maxTs) ? (new Date(maxTs) - new Date(minTs)) : 0;
  const totalSeconds = Math.max(totalMs / 1000, 1);
  const pxPerSecond = Math.max(600 / totalSeconds, 8);
  const labelMargin = 60;
  const svgWidth = Math.max(600, totalSeconds * pxPerSecond + labelMargin);
  const svgHeight = laneCount * 40 + 30;

  const bars = agentSteps.map(e => {
    const m = (e.model || '').toLowerCase();
    const lane = laneMap[m] !== undefined ? laneMap[m] : 3;
    const startSec = minTs ? (new Date(e.ts || e.timestamp) - new Date(minTs)) / 1000 : 0;
    const durSec = (e.duration_ms || 0) / 1000;
    const x = labelMargin + startSec * pxPerSecond;
    const w = Math.max(durSec * pxPerSecond, 4);
    const y = lane * 40 + 8;
    const color = MODEL_COLORS[m] || '#888';
    const costStr = e._cost ? `$${e._cost.toFixed(4)}` : '';
    const durStr = `${durSec.toFixed(2)}s`;
    const role = e.role || e.agent_role || e.model || '?';
    return `<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="24" rx="3" fill="${color}" opacity="0.8"><title>${role} — ${durStr}${costStr ? ', ' + costStr : ''}</title></rect>`;
  }).join('');

  const yLabels = laneLabels.slice(0, laneCount).map((label, i) =>
    `<text x="0" y="${i * 40 + 25}" fill="var(--text-muted)" font-size="11" font-family="var(--font-mono)">${label}</text>`
  ).join('');

  const tickCount = Math.min(10, Math.floor(totalSeconds));
  const tickStep = tickCount > 0 ? totalSeconds / tickCount : 1;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const sec = i * tickStep;
    const tx = labelMargin + sec * pxPerSecond;
    return `<text x="${tx.toFixed(1)}" y="${svgHeight}" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)" text-anchor="middle">${sec.toFixed(0)}s</text>`;
  }).join('');

  container.innerHTML = `
    <svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" style="min-width:${svgWidth}px">
      ${yLabels}
      ${bars}
      ${ticks}
    </svg>
  `;
}

function renderCostWaterfall(entries, minTs) {
  const ctx = document.getElementById('cost-waterfall-chart');
  if (!ctx || !window.Chart) return;
  window.Chart.getChart(ctx)?.destroy();  // avoid "Canvas already in use" on re-render/skip
  const cs = getComputedStyle(document.documentElement);
  const gridColor = cs.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.1)';

  const agentSteps = entries
    .filter(e => e.type === 'agent_step')
    .sort((a, b) => (a.ts || a.timestamp || '').localeCompare(b.ts || b.timestamp || ''));

  if (agentSteps.length === 0) {
    ctx.parentElement.innerHTML += '<p class="text-muted" style="font-size:12px;padding:8px 0">No agent data for charts</p>';
    ctx.remove();
    return;
  }

  let cumCost = 0;
  const dataPoints = agentSteps.map(e => {
    cumCost += e._cost || e.cost || calcEntryCost(e);
    const secFromStart = minTs ? (new Date(e.ts || e.timestamp) - new Date(minTs)) / 1000 : 0;
    return { x: secFromStart, y: cumCost, model: resolveModelKey(e.model) || 'sonnet' };
  });

  new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        data: dataPoints.map(p => ({ x: p.x, y: p.y })),
        showLine: true,
        stepped: 'after',
        borderColor: '#FFAB40',
        backgroundColor: 'rgba(255,171,64,0.1)',
        fill: true,
        pointRadius: 3,
        pointBackgroundColor: dataPoints.map(p => MODEL_COLORS[p.model] || '#888'),
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          title: { display: true, text: 'Elapsed' },
          grid: { color: gridColor },
          ticks: { callback: v => { const m = Math.floor(v/60); const s = Math.floor(v%60); return m > 0 ? `${m}m${s?s+'s':''}` : `${s}s`; } },
        },
        y: {
          title: { display: true, text: 'Cost ($)' },
          grid: { color: gridColor },
          ticks: { callback: v => '$' + v.toFixed(4) },
        },
      },
    },
  });
}

function renderModelDonut(entries) {
  const donutCtx = document.getElementById('model-donut-chart');
  if (!donutCtx || !window.Chart) return;
  window.Chart.getChart(donutCtx)?.destroy();  // avoid "Canvas already in use" on re-render/skip

  const agentSteps = entries.filter(e => e.type === 'agent_step');

  if (agentSteps.length === 0) {
    donutCtx.parentElement.innerHTML += '<p class="text-muted" style="font-size:12px;padding:8px 0">No agent data for charts</p>';
    donutCtx.remove();
    return;
  }

  const modelStats = {};
  for (const e of agentSteps) {
    const m = resolveModelKey(e.model) || 'unknown';
    if (!modelStats[m]) modelStats[m] = { calls: 0, cost: 0, duration: 0 };
    modelStats[m].calls++;
    modelStats[m].cost += e._cost || e.cost || calcEntryCost(e);
    modelStats[m].duration += e.duration_ms || 0;
  }

  // Compute totals for summary line
  const totalCalls = Object.values(modelStats).reduce((a, s) => a + s.calls, 0);
  const totalCostSum = Object.values(modelStats).reduce((a, s) => a + s.cost, 0);
  const totalDurSum = Object.values(modelStats).reduce((a, s) => a + s.duration, 0);
  const legendColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#fff';

  donutCtx.style.maxHeight = '180px';
  new Chart(donutCtx, {
    type: 'doughnut',
    data: {
      labels: Object.keys(modelStats),
      datasets: [{
        data: Object.values(modelStats).map(s => s.cost),
        backgroundColor: Object.keys(modelStats).map(m => MODEL_COLORS[m] || '#888'),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      cutout: '60%',
      plugins: {
        legend: { display: false },
      },
    },
  });

  // Custom HTML legend (respects CSS theme colors)
  const legendDiv = document.createElement('div');
  legendDiv.style.cssText = 'margin-top:12px;font-family:var(--font-mono);font-size:11px;';
  const fmtDur = ms => ms >= 60000 ? `${(ms/60000).toFixed(1)}m` : `${(ms/1000).toFixed(0)}s`;
  for (const [m, stats] of Object.entries(modelStats)) {
    const color = MODEL_COLORS[m] || '#888';
    legendDiv.innerHTML += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span style="display:inline-block;width:12px;height:12px;background:${color};border-radius:2px;flex-shrink:0"></span>
      <span style="color:var(--text)">${m}: ${stats.calls} calls, $${stats.cost.toFixed(3)}, ${fmtDur(stats.duration)}</span>
    </div>`;
  }
  const totalDurStr = fmtDur(totalDurSum);
  legendDiv.innerHTML += `<div style="display:flex;align-items:center;gap:8px;margin-top:6px;padding-top:6px;border-top:1px solid var(--border)">
    <span style="display:inline-block;width:12px;height:12px;flex-shrink:0"></span>
    <span style="color:var(--text);font-weight:700">TOTAL: ${totalCalls} calls, $${totalCostSum.toFixed(3)}, ${totalDurStr}</span>
  </div>`;
  donutCtx.parentElement.appendChild(legendDiv);
}

function memoryTypeBadge(type) {
  const map = {
    decision: 'badge-blue',
    pattern:  'badge-indigo',
    failure:  'badge-red',
    learning: 'badge-green',
  };
  const cls = map[(type ?? '').toLowerCase()] ?? 'badge-gray';
  return `<span class="badge ${cls}">${type || '—'}</span>`;
}

function confidenceBadge(confidence) {
  if (confidence === null || confidence === undefined || confidence === '') return `<span class="badge badge-gray">—</span>`;
  // String confidence levels (high/medium/low) commonly used by memory entries
  // — parseFloat would yield NaN and lose the signal; map to numeric bands and
  // display the original label so users see "high" rather than "90%".
  if (typeof confidence === 'string') {
    const map = { high: 0.9, medium: 0.6, mid: 0.6, low: 0.3 };
    const lvl = map[confidence.trim().toLowerCase()];
    if (lvl != null) {
      const cls = lvl >= 0.8 ? 'badge-green' : lvl >= 0.5 ? 'badge-amber' : 'badge-red';
      return `<span class="badge ${cls}">${confidence}</span>`;
    }
  }
  const n = typeof confidence === 'number' ? confidence : parseFloat(confidence);
  if (isNaN(n)) return `<span class="badge badge-gray">—</span>`;
  const cls = n >= 0.8 ? 'badge-green' : n >= 0.5 ? 'badge-amber' : 'badge-red';
  return `<span class="badge ${cls}">${(n * 100).toFixed(0)}%</span>`;
}

async function renderMemoryList() {
  const app = document.getElementById('app');
  const emptyState = `
    <div class="view-header"><h1>Memory</h1><p>.xm/memory/</p></div>
    <div class="card" style="text-align:center;padding:3rem">
      <div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">◇</div>
      <p class="text-muted">No memory data yet.</p>
      <p style="font-size:0.8rem;color:var(--text-muted)">Run <code>/xm:memory</code> to begin storing cross-session decisions.</p>
      ${wsEmptyHint()}
    </div>
  `;

  app.innerHTML = `<div class="view-header"><h1>Memory</h1><p>.xm/memory/</p></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl('/memory'));
  if (res.error) {
    app.innerHTML = emptyState;
    return;
  }

  const decisions = Array.isArray(res.decisions) ? res.decisions : [];
  if (decisions.length === 0) {
    app.innerHTML = emptyState;
    return;
  }

  const TYPES = ['All', 'Decision', 'Pattern', 'Failure', 'Learning'];
  let activeType = 'All';
  let searchQuery = '';

  function filtered() {
    return decisions.filter(e => {
      const matchType = activeType === 'All' || (e.type ?? '').toLowerCase() === activeType.toLowerCase();
      const q = searchQuery.toLowerCase();
      const matchSearch = !q ||
        (e.title ?? '').toLowerCase().includes(q) ||
        (e.why ?? '').toLowerCase().includes(q) ||
        (Array.isArray(e.tags) ? e.tags.join(' ').toLowerCase().includes(q) : false);
      return matchType && matchSearch;
    });
  }

  function renderTable() {
    const rows = filtered();
    if (rows.length === 0) {
      return `<p class="text-muted">No entries match.</p>`;
    }
    const tbody = rows.map(e => {
      const tags = Array.isArray(e.tags) ? e.tags.map(t => `<code style="font-size:0.75rem;margin-right:3px">${t}</code>`).join('') : '—';
      return `<tr>
        <td><a href="#/memory/${encodeURIComponent(e.id)}">${e.title || e.id || '—'}</a></td>
        <td>${memoryTypeBadge(e.type)}</td>
        <td>${tags}</td>
        <td>${confidenceBadge(e.confidence)}</td>
        <td class="text-muted" style="font-size:0.8rem">${e.source || '—'}</td>
        <td class="text-muted" style="font-size:0.8rem">${(e.created_at ?? e.created) ? timeAgo(e.created_at ?? e.created) : '—'}</td>
      </tr>`;
    }).join('');
    return `
      <div class="table-wrapper">
        <table class="table">
          <thead><tr>
            <th>Title</th><th>Type</th><th>Tags</th><th>Confidence</th><th>Source</th><th>Created</th>
          </tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>`;
  }

  function renderView() {
    const filterBtns = TYPES.map(t =>
      `<button class="memory-filter-btn${activeType === t ? ' active' : ''}" data-type="${t}">${t}</button>`
    ).join('');

    app.innerHTML = `
      <div class="view-header"><h1>Memory</h1><p>${res.total} entries in .xm/memory/</p></div>
      <div class="card">
        <input id="memory-search" type="text" placeholder="Search title, tags, why…"
          style="width:100%;background:var(--surface);border:2px solid #333;color:var(--text);padding:6px 10px;font-family:var(--font-mono);font-size:12px;margin-bottom:12px;box-sizing:border-box"
          value="${searchQuery.replace(/"/g, '&quot;')}">
        <div class="memory-filters">${filterBtns}</div>
        <div id="memory-table">${renderTable()}</div>
      </div>
    `;

    document.getElementById('memory-search').addEventListener('input', e => {
      searchQuery = e.target.value;
      document.getElementById('memory-table').innerHTML = renderTable();
    });

    app.querySelectorAll('.memory-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeType = btn.dataset.type;
        renderView();
      });
    });
  }

  renderView();
}

async function renderMemoryDetail(id) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Memory</h1></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl(`/memory/${encodeURIComponent(id)}`));
  if (res.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Memory</h1></div>
      ${renderError(res.message || res.error)}
    `;
    return;
  }

  const meta = res.meta ?? {};
  const tags = Array.isArray(meta.tags) ? meta.tags.map(t => `<code style="font-size:0.75rem;margin-right:3px">${t}</code>`).join('') : '—';
  const relatedFiles = Array.isArray(meta.related_files) ? meta.related_files : [];

  const memRoutePath = `/memory/${encodeURIComponent(id)}`;
  app.innerHTML = `
    <div class="view-header">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <a href="#/memory" style="font-size:0.85rem">← Memory</a>
        ${pinButton(memRoutePath, meta.title || id)}
      </div>
      <h1 style="margin-top:0.5rem">${meta.title || res.id}</h1>
    </div>
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;margin-bottom:0.75rem">
        ${memoryTypeBadge(meta.type)}
        ${confidenceBadge(meta.confidence)}
        ${meta.source ? `<span class="text-muted" style="font-size:0.8rem;font-family:var(--font-mono)">${meta.source}</span>` : ''}
        ${meta.created_at ? `<span class="text-muted" style="font-size:0.8rem">${timeAgo(meta.created_at)}</span>` : ''}
      </div>
      ${tags !== '—' ? `<div style="margin-bottom:0.5rem"><span class="text-muted" style="font-size:0.8rem">Tags: </span>${tags}</div>` : ''}
      ${relatedFiles.length > 0 ? `<div><span class="text-muted" style="font-size:0.8rem">Related: </span>${relatedFiles.map(f => `<code style="font-size:0.75rem;margin-right:4px">${f}</code>`).join('')}</div>` : ''}
    </div>
    <div class="card markdown-body">${renderMarkdown(res.content)}</div>
  `;
}

// ── x-review views ─────────────────────────────────────────────────

function reviewVerdictBadge(verdict) {
  if (!verdict) return '';
  const v = String(verdict);
  let color = 'var(--text-muted)';
  if (v.includes('LGTM')) color = '#4ade80';
  else if (v.includes('Request')) color = '#fbbf24';
  else if (v.includes('Block')) color = '#f87171';
  return `<span style="color:${color};font-weight:bold">${v}</span>`;
}

function reviewGateBadge(status) {
  const map = {
    passed: 'badge-green',
    ready: 'badge-blue',
    blocked: 'badge-red',
    no_review: 'badge-gray',
  };
  const cls = map[status] || 'badge-gray';
  return `<span class="badge ${cls}">${status || 'unknown'}</span>`;
}

async function renderReviewsList() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Reviews</h1><p>.xm/review/</p></div>${renderLoading()}`;

  const [last, history, gate] = await Promise.all([
    fetchJSON(apiUrl('/review/last')),
    fetchJSON(apiUrl('/review/history')),
    fetchJSON(apiUrl('/review/gate')),
  ]);

  const lastBlock = (last && !last.error && (last.json || last.md))
    ? (() => {
        const j = last.json ?? {};
        const target = j.target ? `${j.target.type || 'diff'}: ${j.target.ref || ''}` : '(unknown)';
        const verdict = j.verdict ?? '(unknown)';
        const lenses = Array.isArray(j.lenses) ? j.lenses.join(', ') : '—';
        const findings = Array.isArray(j.findings) ? j.findings.length : 0;
        const obsCount = Array.isArray(j.observations) ? j.observations.length : 0;
        const mdLink = last.md
          ? `<details style="margin-top:0.75rem"><summary style="cursor:pointer;font-size:0.85rem;color:var(--text-muted)">Full report (markdown)</summary><div class="markdown-body" style="margin-top:0.5rem">${renderMarkdown(last.md)}</div></details>`
          : '';
        return `
          <div class="card" style="margin-bottom:1rem">
            <h2 style="margin-top:0">Last review</h2>
            <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:baseline;margin-bottom:0.5rem">
              <span>${reviewVerdictBadge(verdict)}</span>
              <code style="font-size:0.85rem">${nullSafe(target)}</code>
            </div>
            <div class="text-muted" style="font-size:0.8rem">
              Lenses: ${nullSafe(lenses)} · Findings: ${findings} · Observations: ${obsCount}
              ${j.reviewed_commit ? ` · Commit: <code>${j.reviewed_commit.slice(0, 7)}</code>` : ''}
            </div>
            ${mdLink}
          </div>
        `;
      })()
    : '';

  const gateBlock = gate && !gate.error
    ? (() => {
        const requiredRows = (gate.required || []).map(f => `
          <tr>
            <td><code>${escapeHtmlHumble(f.id)}</code></td>
            <td>${severityBadge(f.severity)}</td>
            <td>${f.file ? `<code>${escapeHtmlHumble(f.file)}${f.line ? ':' + escapeHtmlHumble(f.line) : ''}</code>` : '<span class="text-muted">—</span>'}</td>
            <td>${escapeHtmlHumble(f.summary || '')}</td>
            <td>${f.decision ? `<span class="badge badge-blue">${escapeHtmlHumble(f.decision)}</span>` : '<span class="badge badge-amber">undecided</span>'}</td>
          </tr>
        `).join('');
        const failures = (gate.failures || []).map(f => `<li>${escapeHtmlHumble(f)}</li>`).join('');
        const commands = (gate.commands || []).map(command => commandButton(command)).join(' ');
        const allowed = gate.triage?.allowed_files?.length
          ? gate.triage.allowed_files.map(file => `<code>${escapeHtmlHumble(file)}</code>`).join(' ')
          : '<span class="text-muted">none</span>';
        return `
          <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:.75rem">
              <h2 style="margin:0">Review-Fix Gate</h2>
              ${reviewGateBadge(gate.status)}
              <span class="text-muted">Required: ${gate.review?.required ?? 0}/${gate.review?.findings ?? 0}</span>
              <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">${commands}</span>
            </div>
            <div class="text-muted" style="font-size:12px;margin-bottom:.5rem">Allowed files: ${allowed}</div>
            ${failures ? `<ul style="margin:0 0 .75rem 1.25rem;color:var(--danger);font-size:12px">${failures}</ul>` : ''}
            ${requiredRows ? `
              <div class="table-wrapper">
                <table class="table">
                  <thead><tr><th>ID</th><th>Severity</th><th>File</th><th>Finding</th><th>Decision</th></tr></thead>
                  <tbody>${requiredRows}</tbody>
                </table>
              </div>
            ` : '<p class="text-muted" style="margin:0">No triage-required findings.</p>'}
          </div>
        `;
      })()
    : '';

  const historyRows = (history?.data ?? []).map(r => {
    return `<tr style="cursor:pointer" onclick="window.location.hash='#/reviews/${encodeURIComponent(r.file)}'">
      <td>${reviewVerdictBadge(r.verdict)}</td>
      <td><code style="font-size:0.8rem">${nullSafe(r.target)}</code></td>
      <td class="text-muted" style="font-size:0.8rem">${nullSafe(r.lenses)}</td>
      <td class="text-muted" style="font-size:0.8rem">${nullSafe(r.findings_summary)}</td>
      <td class="text-muted" style="font-size:0.8rem">${nullSafe(r.date)}</td>
    </tr>`;
  }).join('');

  const historyBlock = historyRows
    ? `<div class="card">
        <h2 style="margin-top:0">History</h2>
        <div class="table-wrapper">
          <table class="table">
            <thead><tr><th>Verdict</th><th>Target</th><th>Lenses</th><th>Findings</th><th>Date</th></tr></thead>
            <tbody>${historyRows}</tbody>
          </table>
        </div>
      </div>`
    : '<div class="card"><p class="text-muted">No review history yet.</p></div>';

  const emptyBlock = (!lastBlock && !historyRows)
    ? `<div class="card" style="text-align:center;padding:3rem">
        <div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">◇</div>
        <p class="text-muted">No reviews yet.</p>
        <p style="font-size:0.8rem;color:var(--text-muted)">Run <code>/xm:review</code> to create one.</p>
      </div>`
    : '';

  app.innerHTML = `
    <div class="view-header"><h1>Reviews</h1><p>.xm/review/</p></div>
    ${gateBlock}
    ${lastBlock}
    ${historyRows ? historyBlock : ''}
    ${emptyBlock}
  `;
}

async function renderReviewDetail(file) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Review</h1></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl(`/review/history/${encodeURIComponent(file)}`));
  if (res.error) {
    app.innerHTML = `<div class="view-header"><h1>Review</h1><p><a href="#/reviews" style="font-size:0.85rem">← Reviews</a></p></div>${renderError(res.message || res.error)}`;
    return;
  }

  const reviewRoutePath = `/reviews/${encodeURIComponent(file)}`;
  app.innerHTML = `
    <div class="view-header">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <a href="#/reviews" style="font-size:0.85rem">← Reviews</a>
        ${pinButton(reviewRoutePath, `review · ${file}`)}
      </div>
      <h1 style="margin-top:0.5rem">Review — ${file}</h1>
    </div>
    <div class="card markdown-body">${renderMarkdown(res.content)}</div>
  `;
}

// ── x-eval views ───────────────────────────────────────────────────

async function renderEvalList() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Eval</h1><p>.xm/eval/</p></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl('/eval'));
  if (res.error) {
    app.innerHTML = `<div class="view-header"><h1>Eval</h1></div>${renderError(res.message || res.error)}`;
    return;
  }

  const cats = res.categories || {};
  const totalCount = Object.values(cats).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);

  if (totalCount === 0) {
    app.innerHTML = `
      <div class="view-header"><h1>Eval</h1><p>.xm/eval/</p></div>
      <div class="card" style="text-align:center;padding:3rem">
        <div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">◇</div>
        <p class="text-muted">No eval data yet.</p>
        <p style="font-size:0.8rem;color:var(--text-muted)">Run <code>/xm:eval score</code> or <code>/xm:eval bench</code>.</p>
        ${wsEmptyHint()}
      </div>`;
    return;
  }

  function renderCategory(cat, items) {
    if (!items.length) return '';
    const rows = items.map(i => {
      const s = i.summary ?? {};
      const desc = s.type || s.rubric || s.name || s.verdict || '—';
      const score = (s.overall != null) ? `<code>${s.overall}</code>` : '—';
      return `<tr style="cursor:pointer" onclick="window.location.hash='#/eval/${encodeURIComponent(cat)}/${encodeURIComponent(i.file)}'">
        <td><code style="font-size:0.8rem">${i.file}</code></td>
        <td class="text-muted" style="font-size:0.8rem">${nullSafe(desc)}</td>
        <td>${score}</td>
        <td class="text-muted" style="font-size:0.8rem">${nullSafe(i.timestamp)}</td>
      </tr>`;
    }).join('');
    return `<div class="card" style="margin-bottom:1rem">
      <h2 style="margin-top:0;text-transform:capitalize">${cat} <span class="text-muted" style="font-size:0.8rem">(${items.length})</span></h2>
      <div class="table-wrapper">
        <table class="table">
          <thead><tr><th>File</th><th>Type/Rubric</th><th>Score</th><th>When</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  app.innerHTML = `
    <div class="view-header"><h1>Eval</h1><p>.xm/eval/ · ${totalCount} items</p></div>
    ${['results', 'benchmarks', 'diffs', 'rubrics'].map(c => renderCategory(c, cats[c] || [])).join('')}
  `;
}

async function renderEvalDetail(category, file) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Eval</h1></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl(`/eval/${encodeURIComponent(category)}/${encodeURIComponent(file)}`));
  if (res.error) {
    app.innerHTML = `<div class="view-header"><h1>Eval</h1><p><a href="#/eval" style="font-size:0.85rem">← Eval</a></p></div>${renderError(res.message || res.error)}`;
    return;
  }

  const e_eval = escapeHtmlHumble;
  let body;
  if (res.json) {
    const j = res.json;
    // results category: criterion×judge table
    if (category === 'results' && (j.results || j.scores)) {
      const entries = j.results ?? j.scores ?? {};
      if (typeof entries === 'object' && !Array.isArray(entries)) {
        const criteria = Object.keys(entries);
        const judges = criteria.length > 0
          ? [...new Set(Object.values(entries).flatMap(v => typeof v === 'object' ? Object.keys(v) : []))]
          : [];
        if (criteria.length > 0 && judges.length > 0) {
          const headerRow = `<tr><th>Criterion</th>${judges.map(j => `<th>${e_eval(j)}</th>`).join('')}</tr>`;
          const dataRows = criteria.map(c => {
            const cells = judges.map(jj => {
              const val = entries[c]?.[jj];
              return `<td style="text-align:center">${val != null ? e_eval(String(val)) : '—'}</td>`;
            }).join('');
            return `<tr><td>${e_eval(c)}</td>${cells}</tr>`;
          }).join('');
          body = `<div class="table-wrapper"><table class="table"><thead>${headerRow}</thead><tbody>${dataRows}</tbody></table></div>`;
          if (j.overall != null) body = `<div style="margin-bottom:1rem"><strong>Overall:</strong> ${e_eval(String(j.overall))}</div>` + body;
        } else {
          body = `<pre style="white-space:pre-wrap;font-size:0.8rem;background:var(--surface);padding:1rem;overflow:auto">${JSON.stringify(j, null, 2)}</pre>`;
        }
      } else {
        body = `<pre style="white-space:pre-wrap;font-size:0.8rem;background:var(--surface);padding:1rem;overflow:auto">${JSON.stringify(j, null, 2)}</pre>`;
      }
    } else if (category === 'benchmarks' && Array.isArray(j.runs ?? j.benchmarks ?? j.results)) {
      // benchmarks: comparison table
      const runs = j.runs ?? j.benchmarks ?? j.results ?? [];
      if (runs.length > 0) {
        const cols = [...new Set(runs.flatMap(r => Object.keys(r)))];
        const headerRow = `<tr>${cols.map(c => `<th>${e_eval(c)}</th>`).join('')}</tr>`;
        const dataRows = runs.map(r => `<tr>${cols.map(c => `<td>${r[c] != null ? e_eval(String(r[c])) : '—'}</td>`).join('')}</tr>`).join('');
        body = `<div class="table-wrapper"><table class="table"><thead>${headerRow}</thead><tbody>${dataRows}</tbody></table></div>`;
      } else {
        body = `<pre style="white-space:pre-wrap;font-size:0.8rem;background:var(--surface);padding:1rem;overflow:auto">${JSON.stringify(j, null, 2)}</pre>`;
      }
    } else {
      body = `<pre style="white-space:pre-wrap;font-size:0.8rem;background:var(--surface);padding:1rem;overflow:auto">${JSON.stringify(j, null, 2)}</pre>`;
    }
  } else {
    body = `<div class="markdown-body">${renderMarkdown(res.content || '')}</div>`;
  }

  app.innerHTML = `
    <div class="view-header">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <a href="#/eval" style="font-size:0.85rem">← Eval</a>
        ${pinButton(`/eval/${encodeURIComponent(category)}/${encodeURIComponent(file)}`, `eval · ${file}`)}
      </div>
      <h1 style="margin-top:0.5rem">Eval — ${e_eval(category)} / ${e_eval(file)}</h1>
    </div>
    <div class="card">${body}</div>
  `;
}

// ── x-humble views ─────────────────────────────────────────────────

async function renderHumbleList() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Humble</h1><p>.xm/humble/</p></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl('/humble'));
  if (res.error) {
    app.innerHTML = `<div class="view-header"><h1>Humble</h1></div>${renderError(res.message || res.error)}`;
    return;
  }

  const kinds = res.kinds || {};
  const totalCount = Object.values(kinds).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);

  if (totalCount === 0) {
    app.innerHTML = `
      <div class="view-header"><h1>Humble</h1><p>.xm/humble/</p></div>
      <div class="card" style="text-align:center;padding:3rem">
        <div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">◇</div>
        <p class="text-muted">No humble data yet.</p>
        <p style="font-size:0.8rem;color:var(--text-muted)">Run <code>/xm:humble</code> to add retrospectives or lessons.</p>
        ${wsEmptyHint()}
      </div>`;
    return;
  }

  function renderKind(kind, items) {
    // Filter out host-suffixed sync copies (same logic as renderHumbleSankey)
    const isCanonicalFile = (file) => {
      const base = (file || '').replace(/\.(json|md|jsonl)$/, '');
      const segments = base.split('.');
      return segments.length === 1 || !segments.slice(1).some(s => /-[a-z0-9]{4,}$/i.test(s));
    };
    const canonical = items.filter(i => isCanonicalFile(i.file));
    if (!canonical.length) return '';
    const rows = canonical.map(i => {
      const s = i.summary ?? {};
      const title = s.title ?? i.file;
      const tags = Array.isArray(s.tags)
        ? s.tags.map(t => `<code style="font-size:0.75rem;margin-right:3px">${t}</code>`).join('')
        : '—';
      const status = s.status ? `<span class="text-muted" style="font-size:0.8rem">${s.status}</span>` : '—';
      const confirmed = s.confirmed_count != null ? `<code>${s.confirmed_count}×</code>` : '—';
      return `<tr style="cursor:pointer" onclick="window.location.hash='#/humble/${encodeURIComponent(kind)}/${encodeURIComponent(i.file)}'">
        <td>${nullSafe(title)}</td>
        <td>${status}</td>
        <td>${confirmed}</td>
        <td>${tags}</td>
        <td class="text-muted" style="font-size:0.8rem">${nullSafe(i.timestamp)}</td>
      </tr>`;
    }).join('');
    return `<div class="card" style="margin-bottom:1rem">
      <h2 style="margin-top:0;text-transform:capitalize">${kind} <span class="text-muted" style="font-size:0.8rem">(${items.length})</span></h2>
      <div class="table-wrapper">
        <table class="table">
          <thead><tr><th>Title</th><th>Status</th><th>Confirmed</th><th>Tags</th><th>When</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }

  const sankey = renderHumbleSankey(kinds);

  app.innerHTML = `
    <div class="view-header"><h1>Humble</h1><p>.xm/humble/ · ${totalCount} items</p></div>
    ${sankey}
    ${['lessons', 'retrospectives'].map(k => renderKind(k, kinds[k] || [])).join('')}
  `;
}

/**
 * Retrospective → Lesson → CLAUDE.md 3-column Sankey (SVG).
 * Uses summary.source_retrospective + summary.applied_to_claudemd to draw flows.
 * Skips host-suffixed sync duplicates (keeps canonical files only).
 */
function renderHumbleSankey(kinds) {
  const e = escapeHtmlHumble;
  const isCanonical = (file) => {
    // Canonical files end with just .json/.md; multi-host sync copies have `.{host}-{hash}.json`
    const base = file.replace(/\.(json|md|jsonl)$/, '');
    const segments = base.split('.');
    return segments.length === 1 || !segments.slice(1).some(s => /-[a-z0-9]{4,}$/i.test(s));
  };
  const lessons = (kinds.lessons || []).filter(l => isCanonical(l.file) && l.summary);
  const retros = (kinds.retrospectives || []).filter(r => isCanonical(r.file));
  if (lessons.length === 0) return '';

  // Group lessons by applied_to_claudemd
  const applied = lessons.filter(l => l.summary.applied_to_claudemd === true);
  const unapplied = lessons.filter(l => l.summary.applied_to_claudemd !== true);

  // Group lessons by source_retrospective
  const retroToLessons = new Map();
  for (const l of lessons) {
    const src = l.summary.source_retrospective || '(unknown)';
    if (!retroToLessons.has(src)) retroToLessons.set(src, []);
    retroToLessons.get(src).push(l);
  }
  const retroNodes = [...retroToLessons.entries()]
    .map(([src, ls]) => ({ src, count: ls.length, lessons: ls }))
    .sort((a, b) => b.count - a.count);

  if (retroNodes.length === 0) return '';

  // Layout
  const width = 720, rowH = 26, padTop = 24, colW = 220, nodePad = 6;
  const leftX = 0, midX = colW, rightX = colW * 2;
  const colWidth = 140;

  // Retro nodes (left)
  let y = padTop;
  const retroPositions = retroNodes.map(rn => {
    const h = Math.max(rowH, rn.count * 8);
    const pos = { ...rn, x: leftX, y, h };
    y += h + nodePad;
    return pos;
  });
  const leftHeight = y;

  // Lesson nodes (middle)
  y = padTop;
  const lessonPositions = lessons.map(l => {
    const size = Math.max(14, Math.min(40, 14 + (l.summary.confirmed_count || 1) * 4));
    const pos = { ...l, x: midX, y, h: size };
    y += size + nodePad;
    return pos;
  });
  const midHeight = y;

  // Right nodes (applied / not)
  const appliedH = Math.max(rowH, applied.length * 10);
  const unappliedH = Math.max(rowH, unapplied.length * 10);
  const rightTop = padTop;
  const appliedY = rightTop;
  const unappliedY = rightTop + appliedH + 12;
  const rightHeight = unappliedY + unappliedH;

  const height = Math.max(leftHeight, midHeight, rightHeight) + 20;

  // Draw flows (paths as bezier curves)
  const flows = [];
  for (const lp of lessonPositions) {
    const src = lp.summary.source_retrospective || '(unknown)';
    const retro = retroPositions.find(r => r.src === src);
    if (retro) {
      const x1 = retro.x + colWidth, y1 = retro.y + retro.h / 2;
      const x2 = lp.x, y2 = lp.y + lp.h / 2;
      const cx = (x1 + x2) / 2;
      flows.push(`<path d="M${x1} ${y1} C${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}" stroke="var(--accent)" stroke-width="2" fill="none" opacity="0.35"/>`);
    }
    // right side
    const rX = lp.x + colWidth, rY = lp.y + lp.h / 2;
    const rightYPos = lp.summary.applied_to_claudemd === true ? appliedY + appliedH / 2 : unappliedY + unappliedH / 2;
    const color = lp.summary.applied_to_claudemd === true ? '#22c55e' : '#9ca3af';
    const cx2 = (rX + rightX) / 2;
    flows.push(`<path d="M${rX} ${rY} C${cx2} ${rY}, ${cx2} ${rightYPos}, ${rightX} ${rightYPos}" stroke="${color}" stroke-width="2" fill="none" opacity="0.35"/>`);
  }

  const retroRects = retroPositions.map(r => {
    const label = r.src.length > 25 ? r.src.slice(0, 22) + '…' : r.src;
    return `<g>
      <rect x="${r.x}" y="${r.y}" width="${colWidth}" height="${r.h}" rx="4" fill="var(--surface)" stroke="var(--border)"/>
      <text x="${r.x + 8}" y="${r.y + r.h / 2 + 4}" font-size="11" fill="var(--text)">${e(label)} (${r.count})</text>
    </g>`;
  }).join('');

  const lessonRects = lessonPositions.map(lp => {
    const id = lp.summary.id || lp.file.replace(/\.json$/, '');
    const fill = lp.summary.type === 'STOP' ? '#fee2e2' : lp.summary.type === 'START' ? '#dcfce7' : 'var(--surface)';
    const stroke = lp.summary.type === 'STOP' ? '#991b1b' : lp.summary.type === 'START' ? '#166534' : 'var(--border)';
    const ct = lp.summary.confirmed_count || 1;
    return `<g style="cursor:pointer" onclick="window.location.hash='#/humble/lessons/${encodeURIComponent(lp.file)}'">
      <rect x="${lp.x}" y="${lp.y}" width="${colWidth}" height="${lp.h}" rx="3" fill="${fill}" stroke="${stroke}"/>
      <text x="${lp.x + 8}" y="${lp.y + lp.h / 2 + 4}" font-size="11" fill="#111">${e(id)} · ${ct}×</text>
    </g>`;
  }).join('');

  const rightRects = `
    <g>
      <rect x="${rightX}" y="${appliedY}" width="${colWidth}" height="${appliedH}" rx="4" fill="#dcfce7" stroke="#166534"/>
      <text x="${rightX + 8}" y="${appliedY + appliedH / 2 + 4}" font-size="12" font-weight="600" fill="#166534">✓ Applied (${applied.length})</text>
    </g>
    <g>
      <rect x="${rightX}" y="${unappliedY}" width="${colWidth}" height="${unappliedH}" rx="4" fill="#f3f4f6" stroke="#6b7280"/>
      <text x="${rightX + 8}" y="${unappliedY + unappliedH / 2 + 4}" font-size="12" font-weight="600" fill="#374151">Not applied (${unapplied.length})</text>
    </g>`;

  const headers = `
    <text x="${leftX + colWidth / 2}" y="14" font-size="10" text-anchor="middle" fill="var(--text-muted)">RETROSPECTIVE</text>
    <text x="${midX + colWidth / 2}" y="14" font-size="10" text-anchor="middle" fill="var(--text-muted)">LESSON (size ∝ confirmed)</text>
    <text x="${rightX + colWidth / 2}" y="14" font-size="10" text-anchor="middle" fill="var(--text-muted)">CLAUDE.md</text>
  `;

  return `<div class="card" style="margin-bottom:1rem;overflow-x:auto">
    <h2 style="margin-top:0;font-size:0.95rem">Retrospective → Lesson → CLAUDE.md</h2>
    <svg viewBox="0 0 ${rightX + colWidth} ${height}" style="width:100%;min-width:720px;height:${height}px">
      ${headers}
      ${flows.join('')}
      ${retroRects}
      ${lessonRects}
      ${rightRects}
    </svg>
    <p class="text-muted" style="margin:.5rem 0 0;font-size:.75em">클릭 가능: 레슨 노드 → 상세 페이지</p>
  </div>`;
}

async function renderHumbleDetail(kind, file) {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Humble</h1></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl(`/humble/${encodeURIComponent(kind)}/${encodeURIComponent(file)}`));
  if (res.error) {
    app.innerHTML = `<div class="view-header"><h1>Humble</h1><p><a href="#/humble" style="font-size:0.85rem">← Humble</a></p></div>${renderError(res.message || res.error)}`;
    return;
  }

  let body;
  if (res.json) {
    body = kind === 'lessons'
      ? renderLessonDetail(res.json, file)
      : kind === 'retrospectives'
        ? renderRetrospectiveDetail(res.json)
        : `<div class="card"><pre style="white-space:pre-wrap;font-size:0.8rem;background:var(--surface);padding:1rem;overflow:auto">${JSON.stringify(res.json, null, 2)}</pre></div>`;
  } else {
    body = `<div class="card"><div class="markdown-body">${renderMarkdown(res.content || '')}</div></div>`;
  }

  const humbleRoutePath = `/humble/${encodeURIComponent(kind)}/${encodeURIComponent(file)}`;
  app.innerHTML = `
    <div class="view-header">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <a href="#/humble" style="font-size:0.85rem">← Humble</a>
        ${pinButton(humbleRoutePath, `${kind} · ${file}`)}
      </div>
      <h1 style="margin-top:0.5rem">Humble — ${kind} / ${file}</h1>
    </div>
    ${body}
  `;
}

// ── Humble detail renderers ─────────────────────────────────────────

function humbleBadge(text, color) {
  const palette = {
    stop: 'background:#fee2e2;color:#991b1b',
    start: 'background:#dcfce7;color:#166534',
    active: 'background:#dbeafe;color:#1e40af',
    recorded: 'background:#f3f4f6;color:#374151',
    high: 'background:#fee2e2;color:#991b1b',
    medium: 'background:#fef3c7;color:#92400e',
    low: 'background:#dbeafe;color:#1e40af',
  };
  const style = palette[String(color).toLowerCase()] || 'background:var(--surface);color:var(--text)';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600;margin-right:4px;${style}">${text}</span>`;
}

function escapeHtmlHumble(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderLessonDetail(d, file) {
  const e = escapeHtmlHumble;
  const headerBadges = [
    d.type && humbleBadge(d.type, d.type),
    d.status && humbleBadge(d.status, d.status),
    d.action_type && `<code style="font-size:0.75rem">${e(d.action_type)}</code>`,
  ].filter(Boolean).join(' ');

  // Inline toggle UI for `applied_to_claudemd`
  // Some lesson writers serialize Python bools as the strings "True"/"False"
  // instead of JSON booleans — accept both shapes so the toggle reflects state.
  const applied = d.applied_to_claudemd === true || d.applied_to_claudemd === 'True' || d.applied_to_claudemd === 'true';
  const appliedCell = file
    ? `<label style="display:inline-flex;gap:6px;align-items:center;cursor:pointer">
         <input type="checkbox" ${applied ? 'checked' : ''}
                onchange="toggleLessonApplied('${encodeURIComponent(file)}', this)"
                data-lesson-file="${encodeURIComponent(file)}" />
         <span data-applied-label>${applied ? 'Yes' : 'No'}</span>
         <span class="text-muted" style="font-size:.75em" data-applied-status></span>
       </label>`
    : (applied ? 'Yes' : 'No');

  const metaRows = Object.entries({
    'ID': d.id,
    'Confirmed': d.confirmed_count != null ? `${d.confirmed_count}×` : null,
    'Applied to CLAUDE.md': appliedCell,
    'Source retrospective': d.source_retrospective,
    'Created': d.created_at,
    'Last confirmed': d.last_confirmed,
  }).filter(([, v]) => v != null && v !== '');

  const metaTable = `<table class="table" style="width:auto"><tbody>${
    metaRows.map(([k, v]) => `<tr><td class="text-muted" style="padding-right:1rem;white-space:nowrap">${k}</td><td>${k === 'Applied to CLAUDE.md' ? v : e(v)}</td></tr>`).join('')
  }</tbody></table>`;

  return `
    <div class="card" style="margin-bottom:1rem">
      <div style="margin-bottom:0.75rem">${headerBadges}</div>
      ${d.content ? `<div style="font-size:1rem;line-height:1.5;margin:0 0 1rem 0;white-space:pre-line">${e(d.content)}</div>` : ''}
      ${d.reason ? `<div style="padding:0.75rem 1rem;border-left:3px solid var(--border);background:var(--surface)"><div class="text-muted" style="font-size:0.75rem;margin-bottom:0.25rem">REASON</div><p style="margin:0;font-size:0.9rem;line-height:1.5">${e(d.reason)}</p></div>` : ''}
    </div>
    <div class="card"><h3 style="margin-top:0;font-size:0.9rem">Metadata</h3>${metaTable}</div>
  `;
}

/** Flip applied_to_claudemd via PATCH. Optimistic UI: revert on error. */
async function toggleLessonApplied(encFile, checkbox) {
  const file = decodeURIComponent(encFile);
  const newValue = checkbox.checked;
  const labelEl = checkbox.parentElement.querySelector('[data-applied-label]');
  const statusEl = checkbox.parentElement.querySelector('[data-applied-status]');
  if (labelEl) labelEl.textContent = newValue ? 'Yes' : 'No';
  if (statusEl) statusEl.textContent = 'saving…';
  try {
    const res = await fetch(apiUrl(`/humble/lessons/${encodeURIComponent(file)}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ applied_to_claudemd: newValue }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
    if (statusEl) statusEl.textContent = '✓ saved';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 1500);
  } catch (err) {
    // Revert optimistic change
    checkbox.checked = !newValue;
    if (labelEl) labelEl.textContent = !newValue ? 'Yes' : 'No';
    if (statusEl) statusEl.textContent = `⚠ ${err.message}`;
  }
}

function renderRetrospectiveDetail(d) {
  const e = escapeHtmlHumble;
  const section = (title, body) => body ? `<div class="card" style="margin-bottom:1rem"><h3 style="margin-top:0;font-size:0.95rem">${title}</h3>${body}</div>` : '';
  const bulletList = (arr) => Array.isArray(arr) && arr.length
    ? `<ul style="margin:0;padding-left:1.25rem;line-height:1.5">${arr.map(x => `<li style="margin-bottom:0.3rem">${e(x)}</li>`).join('')}</ul>`
    : '';

  const biasRows = Array.isArray(d.bias_tags) && d.bias_tags.length
    ? `<table class="table"><thead><tr><th>Bias</th><th>Severity</th><th>Context</th></tr></thead><tbody>${
        d.bias_tags.map(b => `<tr><td><code>${e(b.bias)}</code></td><td>${b.severity ? humbleBadge(b.severity, b.severity) : '—'}</td><td style="font-size:0.85rem">${e(b.context)}</td></tr>`).join('')
      }</tbody></table>`
    : '';

  const header = [
    d.type && humbleBadge(d.type, d.type),
    d.timestamp && `<code class="text-muted" style="font-size:0.8rem">${e(d.timestamp)}</code>`,
  ].filter(Boolean).join(' ');

  const lessonsCreated = Array.isArray(d.lessons_created) && d.lessons_created.length
    ? d.lessons_created.map(l => `<a href="#/humble/lessons/${encodeURIComponent(l)}.json" style="margin-right:6px"><code>${e(l)}</code></a>`).join('')
    : '';

  const checkin = d.commitment_checkin;
  const checkinBody = checkin ? `
    ${Array.isArray(checkin.previous_lessons) ? `<p class="text-muted" style="font-size:0.85rem;margin:0 0 0.5rem 0">Previous: ${checkin.previous_lessons.map(l => `<code>${e(l)}</code>`).join(' ')}</p>` : ''}
    ${checkin.notes ? `<p style="margin:0;font-size:0.9rem;line-height:1.5">${e(checkin.notes)}</p>` : ''}
  ` : '';

  return `
    <div class="card" style="margin-bottom:1rem">${header}</div>
    ${section('Session Summary', d.session_summary ? `<p style="margin:0;line-height:1.5">${e(d.session_summary)}</p>` : '')}
    ${section('Failures Identified', bulletList(d.failures_identified))}
    ${section('Root Causes', bulletList(d.root_causes))}
    ${section('Biases Detected', biasRows)}
    ${section('Alternatives', d.alternatives_explored != null ? `<p style="margin:0"><code>${d.alternatives_explored}</code> explored${d.user_choice ? ` — chose <code>${e(d.user_choice)}</code>` : ''}</p>` : '')}
    ${section('Lessons Created', lessonsCreated)}
    ${section('Commitment Check-in', checkinBody)}
  `;
}

// ── PRD views ─────────────────────────────────────────────────────────

async function renderPrdList() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>PRDs</h1><p>.xm/build/projects/*/prd/</p></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl('/prd'));
  if (res.error) {
    app.innerHTML = `<div class="view-header"><h1>PRDs</h1></div>${renderError(res.message || res.error)}`;
    return;
  }

  const items = Array.isArray(res) ? res : [];
  if (items.length === 0) {
    app.innerHTML = `
      <div class="view-header"><h1>PRDs</h1><p>.xm/build/projects/*/prd/</p></div>
      ${renderEmpty('No PRDs found', 'xm build plan')}
    `;
    return;
  }

  const e = escapeHtmlHumble;
  const cards = items.map(item => `
    <div class="card prd-card" style="cursor:pointer;padding:12px 16px;margin-bottom:0.5rem"
         onclick="window.location.hash='#/prd/${encodeURIComponent(item.name)}'">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <strong>${e(item.name)}</strong>
        <span class="text-muted" style="font-size:0.8rem">${timeAgo(item.mtime)}</span>
      </div>
      ${item.size != null ? `<div class="text-muted" style="font-size:0.75rem;margin-top:4px">${item.size} bytes</div>` : ''}
    </div>
  `).join('');

  app.innerHTML = `
    <div class="view-header"><h1>PRDs</h1><p>.xm/build/projects/*/prd/ · ${items.length} file${items.length !== 1 ? 's' : ''}</p></div>
    ${cards}
  `;
}

async function renderPrdDetail(name) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header">
      <div><a href="#/prd" style="font-size:0.875rem;opacity:0.7">← PRDs</a></div>
      <h1 style="margin-top:0.5rem">PRD: <code>${escapeHtmlHumble(name)}</code></h1>
    </div>
    ${renderLoading()}
  `;

  const res = await fetchJSON(apiUrl(`/prd/${encodeURIComponent(name)}`));
  if (res.error) {
    app.innerHTML = `
      <div class="view-header">
        <div><a href="#/prd" style="font-size:0.875rem;opacity:0.7">← PRDs</a></div>
        <h1 style="margin-top:0.5rem">PRD</h1>
      </div>
      ${renderError(res.message || res.error)}
    `;
    return;
  }

  const decodedName = name;
  app.innerHTML = `
    <div class="view-header">
      <div><a href="#/prd" style="font-size:0.875rem;opacity:0.7">← PRDs</a></div>
      <h1 style="margin-top:0.5rem">PRD: <code>${escapeHtmlHumble(res.name || decodedName)}</code></h1>
    </div>
    <div class="card markdown-body">${renderMarkdown(res.content || '')}</div>
  `;
}

// ── Research views ─────────────────────────────────────────────────────

async function renderResearchList() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Research</h1><p>.xm/op/</p></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl('/research'));
  if (res.error) {
    app.innerHTML = `<div class="view-header"><h1>Research</h1></div>${renderError(res.message || res.error)}`;
    return;
  }

  const items = Array.isArray(res) ? res : [];
  if (items.length === 0) {
    app.innerHTML = `
      <div class="view-header"><h1>Research</h1><p>.xm/op/</p></div>
      ${renderEmpty('No research runs found', '/xm op investigate')}
    `;
    return;
  }

  const e = escapeHtmlHumble;
  const rows = items.map(item => `
    <tr style="cursor:pointer" onclick="window.location.hash='#/research/${encodeURIComponent(item.id)}'">
      <td><a href="#/research/${encodeURIComponent(item.id)}">${e(item.id)}</a></td>
      <td class="text-muted">${item.agents != null ? item.agents : '—'}</td>
      <td class="text-muted">${item.rounds != null ? item.rounds : '—'}</td>
      <td class="text-muted">${item.findings != null ? item.findings : '—'}</td>
      <td class="text-muted" style="font-size:0.8rem">${timeAgo(item.mtime)}</td>
    </tr>
  `).join('');

  app.innerHTML = `
    <div class="view-header"><h1>Research</h1><p>.xm/op/ · ${items.length} run${items.length !== 1 ? 's' : ''}</p></div>
    <div class="card" style="padding:0">
      <table class="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Agents</th>
            <th>Rounds</th>
            <th>Findings</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

async function renderResearchDetail(id) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header">
      <div><a href="#/research" style="font-size:0.875rem;opacity:0.7">← Research</a></div>
      <h1 style="margin-top:0.5rem">Research: <code>${escapeHtmlHumble(id)}</code></h1>
    </div>
    ${renderLoading()}
  `;

  const res = await fetchJSON(apiUrl(`/research/${encodeURIComponent(id)}`));
  if (res.error) {
    app.innerHTML = `
      <div class="view-header">
        <div><a href="#/research" style="font-size:0.875rem;opacity:0.7">← Research</a></div>
        <h1 style="margin-top:0.5rem">Research</h1>
      </div>
      ${renderError(res.message || res.error)}
    `;
    return;
  }

  const e = escapeHtmlHumble;
  const entries = Array.isArray(res.entries) ? res.entries : [];

  // Group entries by round
  const byRound = new Map();
  for (const entry of entries) {
    const round = entry.round != null ? entry.round : 0;
    if (!byRound.has(round)) byRound.set(round, []);
    byRound.get(round).push(entry);
  }

  const sortedRounds = [...byRound.keys()].sort((a, b) => a - b);

  const timelineHtml = sortedRounds.map(round => {
    const roundEntries = byRound.get(round);
    const entryItems = roundEntries.map(entry => `
      <div class="timeline-item" style="margin-bottom:1rem">
        <div class="timeline-dot" style="background:var(--accent);border-color:var(--accent)"></div>
        <div class="timeline-content">
          ${entry.agent ? `<div style="font-weight:600;margin-bottom:0.25rem">${e(entry.agent)}</div>` : ''}
          ${entry.finding ? `<div style="margin-bottom:0.25rem">${e(entry.finding)}</div>` : ''}
          ${entry.source ? `<div class="text-muted" style="font-size:0.8rem;margin-bottom:0.2rem"><strong>Source:</strong> ${e(entry.source)}</div>` : ''}
          ${entry.implication ? `<div class="text-muted" style="font-size:0.8rem"><strong>Implication:</strong> ${e(entry.implication)}</div>` : ''}
        </div>
      </div>
    `).join('');

    return `
      <div class="card" style="margin-bottom:1rem">
        <h3 style="margin:0 0 0.75rem;font-size:0.9rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted)">
          Round ${round}
          <span class="badge badge-gray" style="margin-left:0.5rem">${roundEntries.length} finding${roundEntries.length !== 1 ? 's' : ''}</span>
        </h3>
        <div class="timeline">${entryItems}</div>
      </div>
    `;
  }).join('');

  app.innerHTML = `
    <div class="view-header">
      <div><a href="#/research" style="font-size:0.875rem;opacity:0.7">← Research</a></div>
      <h1 style="margin-top:0.5rem">Research: <code>${e(res.id || id)}</code></h1>
    </div>
    ${entries.length === 0 ? renderEmpty('No entries found in this research run.') : timelineHtml}
  `;
}

function render404(hash) {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Not Found</h1></div>
    <div class="card"><p class="text-muted">No route matched: <code>${hash}</code></p></div>
  `;
}


async function renderSearch(query) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Search: <code>${query}</code></h1></div>
    ${renderLoading()}
  `;

  const res = await fetchJSON(apiUrl(`/search?q=${encodeURIComponent(query)}`));
  if (res.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Search: <code>${query}</code></h1></div>
      ${renderError(res.message)}
    `;
    return;
  }

  const all = Array.isArray(res.data) ? res.data : [];

  function highlight(text, q) {
    if (!text || !q) return text || '';
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
  }

  function groupBy(arr, key) {
    return arr.reduce((acc, item) => {
      (acc[item[key]] = acc[item[key]] || []).push(item);
      return acc;
    }, {});
  }

  if (all.length === 0) {
    app.innerHTML = `
      <div class="view-header"><h1>Search: <code>${query}</code></h1></div>
      ${renderEmpty(`No results found for "<strong>${query}</strong>".`)}
    `;
    return;
  }

  const groups = groupBy(all, 'type');
  const ORDER = ['project', 'task', 'probe', 'solver', 'doc'];
  const LABELS = { project: 'Projects', task: 'Tasks', probe: 'Probes', solver: 'Solvers', doc: 'Context Docs' };

  let html = `<div class="view-header"><h1>Search: <code>${query}</code></h1><p class="text-muted">${all.length} result${all.length !== 1 ? 's' : ''}</p></div>`;

  for (const type of ORDER) {
    const items = groups[type];
    if (!items || items.length === 0) continue;
    const cards = items.map(item => {
      const name = highlight(item.name || '\u2014', query);
      const match = highlight(item.match || '', query);
      const sub = item.project ? `<span class="text-muted" style="font-size:0.8rem"> \u00b7 ${item.project}</span>` : '';
      return `
        <div style="padding:0.75rem 0;border-bottom:1px solid var(--border, #333)">
          <div><a href="${item.url}">${name}</a>${sub}</div>
          ${match ? `<div class="text-muted" style="font-size:0.82rem;margin-top:0.25rem;font-family:var(--font-mono)">${match}</div>` : ''}
        </div>`;
    }).join('');
    html += `
      <div class="card" style="margin-top:1rem">
        <h2 style="margin:0 0 0.5rem">${LABELS[type] || type} <span class="badge badge-gray">${items.length}</span></h2>
        ${cards}
      </div>`;
  }

  app.innerHTML = html;
}

// ── Handoffs ──────────────────────────────────────────────────────

async function renderHandoffsList() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Handoffs</h1></div>${renderLoading()}`;

  const res = await fetchJSON(apiUrl('/handoffs'));
  if (res.error) {
    app.innerHTML = `<div class="view-header"><h1>Handoffs</h1></div>${renderError(escapeHtmlHumble(res.message || res.error))}`;
    return;
  }

  const items = Array.isArray(res.data) ? res.data : [];
  if (items.length === 0) {
    app.innerHTML = `
      <div class="view-header"><h1>Handoffs</h1><p>.xm/handoff/ · .xm/build/projects/*/handoff.json</p></div>
      <div class="card" style="text-align:center;padding:3rem">
        <div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">◇</div>
        <p class="text-muted">No handoff data yet.</p>
        <p style="font-size:0.8rem;color:var(--text-muted)">Run <code>/xm:handoff</code> or <code>/xm:build handoff</code> to create one.</p>
      </div>`;
    return;
  }

  const e = escapeHtmlHumble;
  const rows = items.map(h => {
    const title = h.title ?? h.summary ?? h.project ?? h.file ?? '—';
    const project = h.project ?? '—';
    const ts = h.created_at ?? h.timestamp ?? h.updated_at;
    return `<tr>
      <td>${e(title)}</td>
      <td><code style="font-size:0.8rem">${e(project)}</code></td>
      <td class="text-muted" style="font-size:0.85rem">${ts ? timeAgo(ts) : '—'}</td>
      <td class="text-muted" style="font-size:0.8rem"><code>${e(h.file ?? '')}</code></td>
    </tr>`;
  }).join('');

  app.innerHTML = `
    <div class="view-header"><h1>Handoffs</h1><p>.xm/handoff/ · ${items.length} items</p></div>
    <div class="card" style="padding:0">
      <table class="table">
        <thead><tr><th>Title</th><th>Project</th><th>When</th><th>File</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Sync ──────────────────────────────────────────────────────────

async function renderSync() {
  const app = document.getElementById('app');
  app.innerHTML = '<div class="view-header"><h1>Sync</h1></div><p class="text-muted">Loading...</p>';

  const data = await fetchJSON(apiUrl('/sync'));
  if (!data || data.error) {
    app.innerHTML = '<div class="view-header"><h1>Sync</h1></div><div class="card"><p class="text-muted">Failed to load sync status.</p></div>';
    return;
  }

  if (!data.configured) {
    app.innerHTML = `<div class="view-header"><h1>Sync</h1></div>
      <div class="card">
        <p class="text-muted">x-sync is not configured.</p>
        <p style="margin-top:0.5rem"><code>~/.xm/sync.json</code> or run <code>/xm:sync setup</code></p>
      </div>`;
    return;
  }

  const serverOk = data.server && data.server.status === 'ok';
  const statusBadge = serverOk
    ? '<span class="badge badge-green">ONLINE</span>'
    : '<span class="badge badge-red">OFFLINE</span>';

  let html = `<div class="view-header"><h1>Sync ${statusBadge}</h1></div>`;

  // Stats row
  const projects = data.server?.projects || [];
  const totalFiles = data.server?.files ?? 0;
  const allMachines = new Set();
  projects.forEach(p => (p.machines || []).forEach(m => allMachines.add(m)));

  html += `<div class="stat-bar">
    <div class="card stat-card"><div class="stat-value">${projects.length}</div><div class="text-muted">Projects</div></div>
    <div class="card stat-card"><div class="stat-value">${totalFiles}</div><div class="text-muted">Files</div></div>
    <div class="card stat-card"><div class="stat-value">${allMachines.size}</div><div class="text-muted">Machines</div></div>
  </div>`;

  // Config card
  html += `<div class="card" style="margin-top:1rem">
    <h2 style="margin:0 0 0.75rem">Config</h2>
    <table class="data-table"><tbody>
      <tr><td class="text-muted" style="width:120px">Server</td><td><code>${data.server_url || '—'}</code></td></tr>
      <tr><td class="text-muted">Machine ID</td><td><code>${data.machine_id || '—'}</code></td></tr>
      <tr><td class="text-muted">API Key</td><td><code>${data.configured ? '****configured****' : 'not set'}</code></td></tr>
      <tr><td class="text-muted">Last Pull</td><td>${data.last_pull ? new Date(data.last_pull).toLocaleString() : 'never'}</td></tr>
      <tr><td class="text-muted">Server Version</td><td>${data.server?.version || '—'}</td></tr>
    </tbody></table>
  </div>`;

  // Projects table
  if (projects.length > 0) {
    html += `<div class="card" style="margin-top:1rem">
      <h2 style="margin:0 0 0.75rem">Projects <span class="badge badge-gray">${projects.length}</span></h2>
      <table class="data-table">
        <thead><tr><th>Project</th><th>Machines</th><th>Files</th><th>Last Push</th></tr></thead>
        <tbody>`;
    for (const p of projects) {
      const machines = (p.machines || []).map(m => {
        const isSelf = m === data.machine_id;
        return `<span class="badge ${isSelf ? 'badge-accent' : 'badge-gray'}" style="margin:1px">${m}${isSelf ? ' (you)' : ''}</span>`;
      }).join(' ');
      html += `<tr>
        <td><strong>${p.project_id}</strong></td>
        <td>${machines}</td>
        <td>${p.file_count}</td>
        <td class="text-muted">${p.last_push ? new Date(p.last_push).toLocaleString() : '—'}</td>
      </tr>`;
    }
    html += '</tbody></table></div>';
  }

  // Machines overview
  if (allMachines.size > 0) {
    html += `<div class="card" style="margin-top:1rem">
      <h2 style="margin:0 0 0.75rem">Machines <span class="badge badge-gray">${allMachines.size}</span></h2>
      <div style="display:flex;flex-wrap:wrap;gap:0.5rem">`;
    for (const m of allMachines) {
      const isSelf = m === data.machine_id;
      const count = projects.filter(p => (p.machines || []).includes(m)).length;
      html += `<div class="card" style="padding:0.75rem;min-width:180px;${isSelf ? 'border-color:var(--accent)' : ''}">
        <div style="font-weight:700;font-family:var(--font-mono);font-size:12px">${m}${isSelf ? ' <span class="badge badge-accent">YOU</span>' : ''}</div>
        <div class="text-muted" style="margin-top:0.25rem">${count} project${count !== 1 ? 's' : ''}</div>
      </div>`;
    }
    html += '</div></div>';
  }

  app.innerHTML = html;
}

// Router

const ROUTES = [
  { pattern: /^\/$/, handler: () => renderHome() },
  { pattern: /^\/projects$/, handler: () => renderProjectsList() },
  { pattern: /^\/later$/, handler: () => renderLaterList() },
  { pattern: /^\/projects\/(.+)$/, handler: (m) => renderProjectDetail(m[1]) },
  { pattern: /^\/probes$/, handler: () => renderProbesList() },
  { pattern: /^\/probes\/diff/, handler: () => renderProbeDiff() },
  { pattern: /^\/probes\/(.+)$/, handler: (m) => renderProbeDetail(m[1]) },
  { pattern: /^\/solvers$/, handler: () => renderSolversList() },
  { pattern: /^\/solvers\/(.+)$/, handler: (m) => renderSolverDetail(m[1]) },
  { pattern: /^\/ops$/, handler: () => renderOpsList() },
  { pattern: /^\/ops\/compare\?a=([^&]+)&b=(.+)$/, handler: (m) => renderOpCompare(decodeURIComponent(m[1]), decodeURIComponent(m[2])) },
  { pattern: /^\/ops\/(.+)$/, handler: (m) => renderOpDetail(m[1]) },
  { pattern: /^\/config$/, handler: () => renderConfig() },
  { pattern: /^\/traces$/, handler: () => renderTracesList() },
  { pattern: /^\/traces\/(.+)$/, handler: (m) => renderTraceDetail(m[1]) },
  { pattern: /^\/memory$/, handler: () => renderMemoryList() },
  { pattern: /^\/memory\/(.+)$/, handler: (m) => renderMemoryDetail(decodeURIComponent(m[1])) },
  { pattern: /^\/reviews$/, handler: () => renderReviewsList() },
  { pattern: /^\/reviews\/(.+)$/, handler: (m) => renderReviewDetail(decodeURIComponent(m[1])) },
  { pattern: /^\/costs$/, handler: () => renderCostsPage() },
  { pattern: /^\/eval$/, handler: () => renderEvalList() },
  { pattern: /^\/eval\/([^/]+)\/(.+)$/, handler: (m) => renderEvalDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2])) },
  { pattern: /^\/humble$/, handler: () => renderHumbleList() },
  { pattern: /^\/humble\/([^/]+)\/(.+)$/, handler: (m) => renderHumbleDetail(decodeURIComponent(m[1]), decodeURIComponent(m[2])) },
  { pattern: /^\/search\/(.+)$/, handler: (m) => renderSearch(decodeURIComponent(m[1])) },
  { pattern: /^\/sync$/, handler: () => renderSync() },
  { pattern: /^\/handoffs$/, handler: () => renderHandoffsList() },
  { pattern: /^\/prd$/, handler: () => renderPrdList() },
  { pattern: /^\/prd\/(.+)$/, handler: (m) => renderPrdDetail(m[1]) },
  { pattern: /^\/research$/, handler: () => renderResearchList() },
  { pattern: /^\/research\/(.+)$/, handler: (m) => renderResearchDetail(m[1]) },
];

function getPath() {
  const hash = window.location.hash;
  const raw = hash.startsWith('#') ? hash.slice(1) || '/' : '/';
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function updateActiveNav(path) {
  document.querySelectorAll('#nav .nav-links a').forEach((a) => {
    const route = a.getAttribute('data-route');
    const active = path === route || (route !== '/' && path.startsWith(route));
    a.classList.toggle('active', active);
    if (active) {
      a.setAttribute('aria-current', 'page');
    } else {
      a.removeAttribute('aria-current');
    }
  });
}

function route() {
  _pollSequence++;
  _lastAppHtml = null;  // invalidate paint cache on navigation so a returning view re-renders past its loading placeholder (P2)
  const path = getPath();
  updateActiveNav(path);

  for (const { pattern, handler } of ROUTES) {
    const match = path.match(pattern);
    if (match) {
      handler(match);
      // Track detail-view routes in recent history (skip list pages)
      if (path.split('/').length >= 3 && !path.endsWith('/')) {
        trackRecent(path);
      }
      return;
    }
  }

  render404(window.location.hash);
}

window.addEventListener('hashchange', route);

// ── Pin + Recent (localStorage-backed) ──────────────────────────────
const PINS_KEY = 'xm-pins';
const RECENT_KEY = 'xm-recent';
const RECENT_MAX = 8;

function wsScoped(key) {
  return `${key}:${currentWsId || '_single'}`;
}
function getPins() {
  try { return JSON.parse(localStorage.getItem(wsScoped(PINS_KEY)) || '[]'); } catch { return []; }
}
function savePins(list) {
  try { localStorage.setItem(wsScoped(PINS_KEY), JSON.stringify(list)); } catch {}
}
function isPinned(path) {
  return getPins().some(p => p.path === path);
}
function togglePin(path, label) {
  const pins = getPins();
  const idx = pins.findIndex(p => p.path === path);
  if (idx >= 0) pins.splice(idx, 1);
  else pins.unshift({ path, label, ts: Date.now() });
  savePins(pins);
  renderSideRail();
  return idx < 0;
}
function getRecent() {
  try { return JSON.parse(localStorage.getItem(wsScoped(RECENT_KEY)) || '[]'); } catch { return []; }
}
function trackRecent(path) {
  const list = getRecent();
  const existing = list.findIndex(r => r.path === path);
  if (existing >= 0) list.splice(existing, 1);
  list.unshift({ path, ts: Date.now() });
  while (list.length > RECENT_MAX) list.pop();
  try { localStorage.setItem(wsScoped(RECENT_KEY), JSON.stringify(list)); } catch {}
  renderSideRail();
}

function prettyRailLabel(path) {
  // /ops/foo.json → Op · foo.json (compact)
  const m = path.match(/^\/([^/]+)\/(.+)$/);
  if (!m) return path;
  const section = m[1];
  const file = decodeURIComponent(m[2]);
  const short = file.length > 28 ? file.slice(0, 25) + '…' : file;
  return `<span class="text-muted" style="font-size:.7em">${section}</span> ${escapeHtmlHumble(short)}`;
}

function renderSideRail() {
  const railEl = document.getElementById('side-rail');
  if (!railEl) return;
  const pins = getPins();
  const recent = getRecent();
  const currentHash = window.location.hash.slice(1) || '/';

  const section = (title, items, empty) => {
    if (!items.length) {
      return `<div style="padding:6px 14px;font-size:10px;color:var(--text-muted);text-transform:uppercase">${title}</div>
        <div style="padding:2px 14px 8px;font-size:11px;color:var(--text-muted);font-style:italic">${empty}</div>`;
    }
    const rows = items.map(item => {
      const active = item.path === currentHash;
      const style = `display:block;padding:4px 14px;font-size:11px;text-decoration:none;color:var(--text);${active ? 'background:var(--accent);color:white' : ''}`;
      return `<a href="#${item.path}" style="${style}" title="${escapeHtmlHumble(item.path)}">${prettyRailLabel(item.path)}</a>`;
    }).join('');
    return `<div style="padding:6px 14px;font-size:10px;color:var(--text-muted);text-transform:uppercase">${title}</div>${rows}`;
  };

  railEl.innerHTML = `
    ${section('★ Pinned', pins, 'Pin any detail view (★ button)')}
    <div style="height:6px"></div>
    ${section('🕘 Recent', recent, 'Visit any detail view')}
  `;
}

/** Pin button helper for detail views. Returns HTML string. */
function pinButton(path, label) {
  const pinned = isPinned(path);
  return `<button
    onclick="togglePin('${path.replace(/'/g, "\\'")}', '${(label||'').replace(/'/g, "\\'")}')"
    title="${pinned ? 'Unpin' : 'Pin to sidebar'}"
    style="background:none;border:1px solid var(--border);padding:4px 10px;cursor:pointer;border-radius:4px;font-size:.85em;color:${pinned ? '#eab308' : 'var(--text-muted)'}">
    ${pinned ? '★ Pinned' : '☆ Pin'}
  </button>`;
}

// Set sidebar brand to current project name
fetchJSON('/api/health').then(h => {
  if (h && !h.error && h.project) {
    const brand = document.querySelector('.nav-brand');
    if (brand) brand.textContent = h.project;
  }
});

// Inject search input into sidebar
(function() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const searchDiv = document.createElement('div');
  searchDiv.style.cssText = 'padding:8px 14px;border-bottom:2px solid #333';
  searchDiv.innerHTML = '<input type="text" id="search-input" class="sidebar-search-input" placeholder="Search .xm..." aria-label="Search workspace">';
  const navLinks = nav.querySelector('.nav-links');
  if (navLinks) {
    nav.insertBefore(searchDiv, navLinks);
  } else {
    nav.appendChild(searchDiv);
  }
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.id === 'search-input' && e.key === 'Enter') {
      const q = e.target.value.trim();
      if (q) window.location.hash = '#/search/' + encodeURIComponent(q);
    }
  });

  // Side rail for pins + recent (below search, above nav links)
  const railDiv = document.createElement('div');
  railDiv.id = 'side-rail';
  railDiv.style.cssText = 'border-bottom:2px solid #333;padding:4px 0';
  const navLinksEl = nav.querySelector('.nav-links');
  if (navLinksEl) {
    nav.insertBefore(railDiv, navLinksEl);
  } else {
    nav.appendChild(railDiv);
  }
  renderSideRail();
})();

// Theme toggle
(function initTheme() {
  const saved = localStorage.getItem('xm-theme');
  if (saved === 'light') document.body.classList.add('theme-light');

  const nav = document.getElementById('nav');
  if (!nav) return;
  const btn = document.createElement('button');
  btn.role = 'button';
  btn.setAttribute('aria-label', document.body.classList.contains('theme-light') ? 'Switch to dark theme' : 'Switch to light theme');
  btn.style.cssText = 'padding:12px 14px;border:none;border-top:2px solid #333;margin-top:auto;cursor:pointer;font-size:11px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);user-select:none;background:transparent;width:100%;text-align:left';
  btn.textContent = document.body.classList.contains('theme-light') ? '● DARK' : '◐ LIGHT';
  btn.addEventListener('click', () => {
    document.body.classList.toggle('theme-light');
    const isLight = document.body.classList.contains('theme-light');
    localStorage.setItem('xm-theme', isLight ? 'light' : 'dark');
    btn.textContent = isLight ? '● DARK' : '◐ LIGHT';
    btn.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme');
  });
  nav.appendChild(btn);
})();

// ── Costs page + cost-by-role stacked area ─────────────────────────
async function renderCostsPage() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="view-header"><h1>Costs</h1></div>${renderLoading()}`;
  const [summary, sessions] = await Promise.all([
    fetchJSON(apiUrl('/costs')),
    fetchJSON(apiUrl('/metrics/sessions?limit=10000')),
  ]);

  const summaryHtml = summary.error
    ? renderError('Costs summary: ' + (summary.message || summary.error))
    : renderCostsSummary(summary);

  const sessionEvents = (!sessions.error && Array.isArray(sessions.data)) ? sessions.data : [];
  const roleChart = renderCostByRoleStackedArea(sessionEvents);

  app.innerHTML = `
    <div class="view-header"><h1>Costs</h1></div>
    ${roleChart}
    ${summaryHtml}
  `;
}

function renderCostsSummary(s) {
  const e = escapeHtmlHumble;
  const fmtUSD = (v) => `$${Number(v || 0).toFixed(4)}`;
  const byModel = s.byModel || {};
  const modelRows = Object.entries(byModel).map(([m, v]) =>
    `<tr><td><code>${e(m)}</code></td><td style="text-align:right">${fmtUSD(v.cost)}</td>
    <td class="text-muted" style="text-align:right">${v.inputTokens}</td>
    <td class="text-muted" style="text-align:right">${v.outputTokens}</td></tr>`
  ).join('');
  return `<div class="card" style="margin-bottom:1rem">
    <h2 style="margin-top:0;font-size:.95rem">Summary</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px;text-align:center;margin-bottom:1rem">
      <div><div style="font-size:1.3em;font-weight:700">${fmtUSD(s.totalCost)}</div><span class="text-muted">Total</span></div>
      <div><div style="font-size:1.3em;font-weight:700">${s.totalInputTokens||0}</div><span class="text-muted">Input tok</span></div>
      <div><div style="font-size:1.3em;font-weight:700">${s.totalOutputTokens||0}</div><span class="text-muted">Output tok</span></div>
    </div>
    ${modelRows ? `<table class="table"><thead><tr><th>Model</th><th style="text-align:right">Cost</th><th style="text-align:right">Input</th><th style="text-align:right">Output</th></tr></thead><tbody>${modelRows}</tbody></table>` : ''}
  </div>`;
}

/**
 * Stacked area chart: cost_usd over time, stacked by role.
 * Input: array of session events ({type:'task_complete', timestamp, role, cost_usd, model})
 * Buckets by day; draws SVG polygon stack.
 */
function renderCostByRoleStackedArea(events) {
  const tc = events.filter(e => e && e.type === 'task_complete' && e.cost_usd != null);
  if (tc.length === 0) {
    return `<div class="card" style="margin-bottom:1rem">
      <h2 style="margin-top:0;font-size:.95rem">Cost by Role (stacked area)</h2>
      <p class="text-muted" style="margin:0;font-size:.85em">No task_complete events with cost_usd found in sessions.jsonl.</p>
    </div>`;
  }
  const e = escapeHtmlHumble;

  // Build date buckets
  const bucket = (ts) => new Date(ts).toISOString().slice(0, 10);
  const dateSet = new Set();
  const roleSet = new Set();
  const cell = new Map(); // key = "role|date" → cost
  for (const ev of tc) {
    if (!ev.timestamp) continue;
    const d = bucket(ev.timestamp);
    const r = ev.role || 'unknown';
    dateSet.add(d);
    roleSet.add(r);
    const key = `${r}|${d}`;
    cell.set(key, (cell.get(key) || 0) + Number(ev.cost_usd || 0));
  }
  const dates = [...dateSet].sort();
  const roles = [...roleSet].sort();
  if (dates.length === 0 || roles.length === 0) return '';

  // Role color palette (deterministic by role name)
  const palette = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  const colorFor = (role) => {
    let hash = 0;
    for (const c of role) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
    return palette[hash % palette.length];
  };

  // Compute stack: for each date, cumulative per role (in fixed role order)
  const dayTotals = dates.map(d => {
    let total = 0;
    for (const r of roles) total += cell.get(`${r}|${d}`) || 0;
    return total;
  });
  const maxTotal = Math.max(...dayTotals, 0.0001);

  const width = 720, height = 260, padL = 60, padR = 16, padT = 20, padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const xAt = (i) => padL + (dates.length === 1 ? plotW / 2 : (i / (dates.length - 1)) * plotW);
  const yAt = (v) => padT + plotH - (v / maxTotal) * plotH;

  // Build layered polygons top-down (reverse so later roles sit on top visually)
  const layers = [];
  const running = new Array(dates.length).fill(0);
  for (const role of roles) {
    const top = dates.map((d, i) => {
      const v = cell.get(`${role}|${d}`) || 0;
      const newRun = running[i] + v;
      return { x: xAt(i), yTop: yAt(newRun), yBottom: yAt(running[i]), cost: v };
    });
    // Update running totals after capturing for this layer
    for (let i = 0; i < dates.length; i++) {
      running[i] += cell.get(`${role}|${dates[i]}`) || 0;
    }
    // Polygon: top edge left→right, bottom edge right→left
    const points = [
      ...top.map(p => `${p.x.toFixed(1)},${p.yTop.toFixed(1)}`),
      ...top.slice().reverse().map(p => `${p.x.toFixed(1)},${p.yBottom.toFixed(1)}`),
    ].join(' ');
    const total = top.reduce((a, b) => a + b.cost, 0);
    layers.push({
      role,
      points,
      color: colorFor(role),
      total,
    });
  }

  // Axes
  const yTicks = 4;
  const yLabels = [];
  for (let i = 0; i <= yTicks; i++) {
    const v = (maxTotal * i) / yTicks;
    const y = yAt(v);
    yLabels.push(`<g>
      <line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="var(--border)" stroke-dasharray="2,3" opacity="0.4"/>
      <text x="${padL - 6}" y="${y + 3}" font-size="9" text-anchor="end" fill="var(--text-muted)">$${v.toFixed(3)}</text>
    </g>`);
  }
  const maxXLabels = 8;
  const xStep = Math.max(1, Math.ceil(dates.length / maxXLabels));
  const xLabels = dates.map((d, i) => {
    if (i % xStep !== 0 && i !== dates.length - 1) return '';
    const x = xAt(i);
    return `<text x="${x}" y="${height - padB + 14}" font-size="9" text-anchor="middle" fill="var(--text-muted)">${e(d.slice(5))}</text>`;
  }).join('');

  // Legend
  const legendItems = layers.map(l => `
    <span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:11px">
      <span style="display:inline-block;width:10px;height:10px;background:${l.color};border-radius:2px"></span>
      <code>${e(l.role)}</code>
      <span class="text-muted" style="font-size:.85em">($${l.total.toFixed(3)})</span>
    </span>
  `).join('');

  return `<div class="card" style="margin-bottom:1rem;overflow-x:auto">
    <h2 style="margin-top:0;font-size:.95rem">Cost by Role (stacked area)
      <span class="text-muted" style="font-size:.75em;font-weight:400;margin-left:6px">
        ${tc.length} events · ${dates.length} day${dates.length === 1 ? '' : 's'} · ${roles.length} role${roles.length === 1 ? '' : 's'}
      </span>
    </h2>
    <div style="margin-bottom:.5rem;line-height:1.6">${legendItems}</div>
    <svg viewBox="0 0 ${width} ${height}" style="width:100%;min-width:${width}px;height:${height}px">
      ${yLabels.join('')}
      ${layers.map(l => `<polygon points="${l.points}" fill="${l.color}" opacity="0.75"><title>${e(l.role)} · $${l.total.toFixed(4)}</title></polygon>`).join('')}
      ${xLabels}
      <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="var(--text-muted)"/>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="var(--text-muted)"/>
    </svg>
    <p class="text-muted" style="font-size:.7em;margin:.5rem 0 0">Source: <code>.xm/build/metrics/sessions.jsonl</code> task_complete events, bucketed by UTC day.</p>
  </div>`;
}

// ── Cmd+K Command Palette ──────────────────────────────────────────
// Global keyboard: Cmd/Ctrl+K opens overlay. Fuzzy matches routes,
// workspaces, pinned, recent. Enter navigates. Esc closes. Arrow keys
// move selection.

const PALETTE_ROUTES = [
  { path: '/', label: 'Home', kind: 'route' },
  { path: '/projects', label: 'Projects', kind: 'route' },
  { path: '/later', label: 'Later', kind: 'route' },
  { path: '/humble', label: 'Humble', kind: 'route' },
  { path: '/ops', label: 'Ops', kind: 'route' },
  { path: '/eval', label: 'Eval', kind: 'route' },
  { path: '/reviews', label: 'Reviews', kind: 'route' },
  { path: '/traces', label: 'Traces', kind: 'route' },
  { path: '/memory', label: 'Memory', kind: 'route' },
  { path: '/probes', label: 'Probes', kind: 'route' },
  { path: '/solvers', label: 'Solvers', kind: 'route' },
  { path: '/costs', label: 'Costs', kind: 'route' },
  { path: '/config', label: 'Config', kind: 'route' },
  { path: '/sync', label: 'Sync', kind: 'route' },
  { path: '/handoffs', label: 'Handoffs', kind: 'route' },
  { path: '/prd', label: 'PRDs', kind: 'route' },
  { path: '/research', label: 'Research', kind: 'route' },
];

function paletteItems() {
  const items = [...PALETTE_ROUTES];
  // Workspaces (switch, not navigate) — only in multi-root mode
  if (multiRootMode && Array.isArray(knownWorkspaces)) {
    for (const ws of knownWorkspaces) {
      items.push({
        path: null, wsSwitch: ws.id, label: ws.name || ws.id,
        kind: 'workspace', hint: ws.path || '',
      });
    }
  }
  // Pins
  for (const p of getPins()) {
    items.push({ path: p.path, label: p.label || p.path, kind: 'pinned', hint: '★' });
  }
  // Recent
  for (const r of getRecent()) {
    items.push({ path: r.path, label: r.path, kind: 'recent', hint: '🕘' });
  }
  return items;
}

function fuzzyScore(query, text) {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = (text || '').toLowerCase();
  if (!t) return 0;
  if (t === q) return 1000;
  if (t.startsWith(q)) return 800;
  if (t.includes(q)) return 500;
  // letter-by-letter subsequence
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length ? 100 : 0;
}

let _paletteState = null;

function openPalette() {
  if (_paletteState) return;
  // Capture and temporarily disable the previously-focused element so it
  // cannot reclaim focus when the keydown event finishes bubbling.
  const prevFocus = document.activeElement && document.activeElement !== document.body
    ? document.activeElement : null;
  let prevTabIndex = null;
  if (prevFocus) {
    try {
      prevFocus.blur();
      // Make it un-focusable until palette closes
      if (prevFocus.tabIndex !== -1) {
        prevTabIndex = prevFocus.tabIndex;
        prevFocus.tabIndex = -1;
      }
    } catch {}
  }

  const overlay = document.createElement('div');
  overlay.id = 'palette-overlay';
  // tabindex=-1 + focus the overlay first so Safari can't bounce focus out
  overlay.tabIndex = -1;
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding-top:10vh;outline:none';
  overlay.innerHTML = `
    <div id="palette-box" style="width:min(640px,90vw);background:var(--bg);border:1px solid var(--border);border-radius:8px;box-shadow:0 20px 60px rgba(0,0,0,0.4);overflow:hidden">
      <input id="palette-input" type="text" placeholder="Search routes, workspaces, pinned, recent…"
        autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" autofocus
        style="width:100%;padding:16px 20px;background:transparent;border:none;border-bottom:1px solid var(--border);color:var(--text);font-size:15px;outline:none;box-sizing:border-box">
      <div id="palette-list" style="max-height:400px;overflow-y:auto"></div>
      <div style="padding:6px 16px;border-top:1px solid var(--border);font-size:.7em;color:var(--text-muted);display:flex;gap:16px">
        <span>↑↓ select</span><span>↵ open</span><span>esc close</span>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePalette(); });

  const input = overlay.querySelector('#palette-input');
  const list = overlay.querySelector('#palette-list');
  _paletteState = { overlay, input, list, selectedIndex: 0, items: [], prevFocus, prevTabIndex };

  refreshPalette('');
  input.addEventListener('input', () => refreshPalette(input.value));
  input.addEventListener('keydown', onPaletteKey);

  // Multi-stage focus attempt. Browsers (especially Chromium with an
  // active input on the page) sometimes revert focus between stages.
  const tryFocus = (stage) => {
    if (!_paletteState || document.activeElement === input) return;
    try {
      input.focus({ preventScroll: true });
      input.select?.();
    } catch {}
    if (stage < 4 && document.activeElement !== input) {
      // Exponential retry: 0 → 16ms → 50ms → 100ms
      const delay = stage === 0 ? 0 : stage === 1 ? 16 : stage === 2 ? 50 : 100;
      setTimeout(() => tryFocus(stage + 1), delay);
    }
  };
  requestAnimationFrame(() => tryFocus(0));
}

function closePalette() {
  if (!_paletteState) return;
  const { overlay, prevFocus, prevTabIndex } = _paletteState;
  overlay.remove();
  _paletteState = null;
  // Restore the previous element's tabIndex so keyboard nav isn't broken
  if (prevFocus && prevTabIndex !== null) {
    try { prevFocus.tabIndex = prevTabIndex; } catch {}
  }
}

function refreshPalette(query) {
  if (!_paletteState) return;
  const all = paletteItems();
  const scored = all.map(item => {
    const scoreLabel = fuzzyScore(query, item.label);
    const scorePath = fuzzyScore(query, item.path || '');
    const scoreKind = fuzzyScore(query, item.kind);
    return { item, score: Math.max(scoreLabel, scorePath * 0.6, scoreKind * 0.3) };
  }).filter(x => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  _paletteState.items = scored.slice(0, 50).map(s => s.item);
  _paletteState.selectedIndex = 0;
  renderPaletteList();
}

function renderPaletteList() {
  if (!_paletteState) return;
  const { list, items, selectedIndex } = _paletteState;
  const e = escapeHtmlHumble;
  if (items.length === 0) {
    list.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:13px">No matches</div>`;
    return;
  }
  list.innerHTML = items.map((item, i) => {
    const active = i === selectedIndex;
    const kindBadge = {
      route: 'background:#dbeafe;color:#1e40af',
      workspace: 'background:#dcfce7;color:#166534',
      pinned: 'background:#fef3c7;color:#92400e',
      recent: 'background:#f3f4f6;color:#374151',
    }[item.kind] || 'background:var(--surface);color:var(--text)';
    return `<div class="palette-row" data-idx="${i}"
      style="padding:10px 16px;display:flex;align-items:center;gap:10px;cursor:pointer;${active ? 'background:var(--accent);color:white' : ''}">
      <span style="padding:1px 6px;border-radius:3px;font-size:9px;font-weight:600;text-transform:uppercase;${kindBadge}">${e(item.kind)}</span>
      <span style="flex:1;font-size:13px">${e(item.label)}</span>
      ${item.hint ? `<span style="font-size:10px;opacity:0.7">${e(item.hint)}</span>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('.palette-row').forEach(row => {
    row.addEventListener('click', () => {
      _paletteState.selectedIndex = Number(row.dataset.idx);
      executePaletteSelection();
    });
    row.addEventListener('mousemove', () => {
      const idx = Number(row.dataset.idx);
      if (_paletteState.selectedIndex !== idx) {
        _paletteState.selectedIndex = idx;
        renderPaletteList();
      }
    });
  });
  // Scroll selected into view
  const activeRow = list.querySelector('.palette-row[data-idx="' + selectedIndex + '"]');
  if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
}

function onPaletteKey(e) {
  if (!_paletteState) return;
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _paletteState.selectedIndex = Math.min(_paletteState.items.length - 1, _paletteState.selectedIndex + 1);
    renderPaletteList();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _paletteState.selectedIndex = Math.max(0, _paletteState.selectedIndex - 1);
    renderPaletteList();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    executePaletteSelection();
  }
}

function executePaletteSelection() {
  if (!_paletteState) return;
  const item = _paletteState.items[_paletteState.selectedIndex];
  if (!item) return;
  closePalette();
  if (item.wsSwitch) {
    // Switch workspace via the select dropdown
    const sel = document.getElementById('ws-select');
    if (sel) {
      sel.value = item.wsSwitch;
      sel.dispatchEvent(new Event('change'));
    } else {
      currentWsId = item.wsSwitch;
      try { localStorage.setItem('xm-workspace', currentWsId); } catch {}
      route();
    }
  } else if (item.path) {
    window.location.hash = '#' + item.path;
  }
}

// Global keybinding
document.addEventListener('keydown', (e) => {
  // Ignore when user is typing in an input/textarea (except our palette input)
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') && e.target.id !== 'palette-input') {
    if (!((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K'))) return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (_paletteState) closePalette();
    else openPalette();
  }
});

initWorkspaces().then(() => route()).catch(() => route());
