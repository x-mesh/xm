// Workspace state
let currentWsId = null;
let multiRootMode = false;

function apiUrl(path) {
  const p = path.startsWith('/') ? path : '/' + path;
  if (multiRootMode && currentWsId) {
    return `/api/ws/${encodeURIComponent(currentWsId)}${p}`;
  }
  return `/api${p}`;
}

async function initWorkspaces() {
  const res = await fetchJSON('/api/workspaces');
  if (res.error || !Array.isArray(res)) return;

  const workspaces = res;
  if (workspaces.length <= 1) {
    currentWsId = workspaces[0]?.id ?? null;
    multiRootMode = false;
    return;
  }

  multiRootMode = true;
  currentWsId = workspaces[0].id;

  const nav = document.getElementById('nav');
  if (!nav) return;
  const selector = document.createElement('div');
  selector.id = 'ws-selector';
  selector.style.cssText = 'padding:8px 14px;border-bottom:2px solid #333';
  selector.innerHTML = `
    <select id="ws-select" style="width:100%;background:var(--surface);border:2px solid #444;color:var(--accent);padding:6px 10px;font-family:var(--font-mono);font-size:11px;text-transform:uppercase">
      ${workspaces.map(w => `<option value="${w.id}">${w.name} (${w.stats?.projects ?? 0})</option>`).join('')}
    </select>
  `;

  const navLinks = nav.querySelector('.nav-links');
  nav.insertBefore(selector, navLinks);

  document.getElementById('ws-select').addEventListener('change', (e) => {
    currentWsId = e.target.value;
    route();
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

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked !== 'undefined' && marked.parse) {
    return marked.parse(text);
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
    <div class="card"><p class="text-muted">Loading workspaces...</p></div>
  `;

  const workspaces = await fetchJSON('/api/workspaces');
  if (!Array.isArray(workspaces) || workspaces.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Workspaces</h1></div>
      <div class="card"><p class="text-muted">Error loading workspaces.</p></div>
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

  const cards = workspaces.map(w => `
    <div class="card ws-card" data-wsid="${w.id}" style="cursor:pointer;flex:1 1 200px;min-width:180px">
      <div style="font-size:1.1em;font-weight:700;margin-bottom:0.25rem">${w.name}</div>
      <div class="text-muted" style="font-size:0.78em;font-family:var(--font-mono);margin-bottom:0.75rem;word-break:break-all">${w.path ?? ''}</div>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <span class="badge badge-blue">${w.stats?.projects ?? 0} builds</span>
        <span class="badge badge-indigo">${w.stats?.probes ?? 0} probes</span>
        <span class="badge badge-amber">${w.stats?.solvers ?? 0} solvers</span>
      </div>
    </div>
  `).join('');

  app.innerHTML = `
    <div class="view-header"><h1>Workspaces</h1></div>
    <div style="display:flex;flex-wrap:wrap;gap:1rem;margin-bottom:1rem">${cards}</div>
    <div class="stat-bar">
      <div class="card stat-card">
        <div class="stat-value">${totalProjects}</div>
        <div class="stat-label">Total Builds</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${totalProbes}</div>
        <div class="stat-label">Total Probes</div>
      </div>
      <div class="card stat-card">
        <div class="stat-value">${totalSolvers}</div>
        <div class="stat-label">Total Solvers</div>
      </div>
    </div>
  `;

  app.querySelectorAll('.ws-card[data-wsid]').forEach(card => {
    card.addEventListener('click', () => {
      currentWsId = card.dataset.wsid;
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
    <div class="card"><p class="text-muted">Loading...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const [projectsRes, solverRes, probeRes, healthRes] = await Promise.all([
      fetchJSON(apiUrl('/projects')),
      fetchJSON(apiUrl('/solver')),
      fetchJSON(apiUrl('/probe/latest')),
      fetchJSON('/api/health'),
    ]);

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

    app.innerHTML = `
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
    `;

    // Session metrics bar chart (async, non-blocking)
    fetchJSON(apiUrl('/metrics/sessions?limit=50')).then(sessionsRes => {
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
  }, 3000);

  // Stop polling when navigating away
  window.addEventListener('hashchange', stopPolling, { once: true });
}

function renderProjectsList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Builds</h1><p>.xm/build/projects/</p></div>
    <div class="card"><p class="text-muted">Loading projects...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const result = await fetchJSON(apiUrl('/projects'));
    if (result.error) {
      app.innerHTML = `
        <div class="view-header"><h1>Builds</h1><p>.xm/build/projects/</p></div>
        <div class="card"><p class="text-muted">Error: ${result.message}</p></div>
      `;
      return;
    }

    const projects = result.data || [];
    if (projects.length === 0) {
      app.innerHTML = `
        <div class="view-header"><h1>Builds</h1><p>.xm/build/projects/</p></div>
        <div class="card"><p class="text-muted">No projects found.</p></div>
      `;
      return;
    }

    const rows = projects.map((p) => `
      <tr>
        <td><a href="#/projects/${p.name}">${nullSafe(p.display_name || p.name)}</a></td>
        <td>${phaseBadge(p.current_phase)}</td>
        <td>${timeAgo(p.created_at)}</td>
        <td>${timeAgo(p.updated_at)}</td>
      </tr>
    `).join('');

    app.innerHTML = `
      <div class="view-header"><h1>Builds</h1><p>.xm/build/projects/</p></div>
      <div class="card" style="padding:0">
        <table class="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phase</th>
              <th>Created</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  });

  window.addEventListener('hashchange', stopPolling, { once: true });
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
  card.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('tab-active'));
  btn.classList.add('tab-active');
  card.querySelectorAll('.tab-panel').forEach((p, i) => {
    p.style.display = i === idx ? '' : 'none';
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
    <div class="card"><p class="text-muted">Loading project...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const [projectResult, tasksResult] = await Promise.all([
      fetchJSON(apiUrl(`/projects/${slug}`)),
      fetchJSON(apiUrl(`/projects/${slug}/tasks`)),
    ]);

    if (projectResult.error) {
      app.innerHTML = `
        <div class="view-header"><h1>Project: <code>${slug}</code></h1></div>
        <div class="card"><p class="text-muted">Error: ${projectResult.message}</p></div>
      `;
      return;
    }

    const { manifest, circuitBreaker, handoff, phases: projectPhases, context } = projectResult;
    const name = nullSafe(manifest?.name, slug);
    const phase = nullSafe(manifest?.phase, '');

    // Header
    let html = `
      <div class="view-header">
        <h1>${name}</h1>
        <div class="view-header-meta">
          ${phaseBadge(phase)}
          <span class="text-muted">Created: ${timeAgo(manifest?.created_at)}</span>
          <span class="text-muted">Updated: ${timeAgo(manifest?.updated_at)}</span>
          <button class="btn-export" id="btn-export-project" style="margin-left:auto;font-size:0.75rem;padding:0.25rem 0.6rem;background:transparent;border:1px solid var(--border,#e5e7eb);border-radius:4px;cursor:pointer;color:var(--text-muted)">↓ EXPORT</button>
        </div>
      </div>
    `;

    // Phase bar
    html += `<div class="card">${renderPhaseBar(phase)}</div>`;

    // Tasks table
    const tasks = Array.isArray(tasksResult) ? tasksResult
      : Array.isArray(tasksResult?.tasks) ? tasksResult.tasks
      : Array.isArray(tasksResult?.data) ? tasksResult.data
      : [];
    const completedCount = tasks.filter((t) => t.status === 'completed').length;

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

    // Context docs (tabs) — preserve active tab across polling
    const docs = Array.isArray(context) ? context : [];
    if (docs.length > 0) {
      const tabId = 'ctx-tab';
      const savedIdx = _activeTabState[tabId] ?? 0;
      const tabs = docs.map((d, i) => `
        <button class="tab-btn${i === savedIdx ? ' tab-active' : ''}" onclick="switchTab('${tabId}', ${i}, this)">${d.name}</button>
      `).join('');
      const panels = docs.map((d, i) => `
        <div class="tab-panel" id="${tabId}-panel-${i}" style="${i === savedIdx ? '' : 'display:none'}">
          <div class="markdown-body">${renderMarkdown(d.content)}</div>
        </div>
      `).join('');
      html += `
        <div class="card" id="${tabId}">
          <h2 style="margin:0 0 .75rem">Context Docs</h2>
          <div class="tab-bar">${tabs}</div>
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
        ? handoff.pending_tasks.map((t) => `<li>${t}</li>`).join('')
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

    app.innerHTML = html;

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
      <h1 style="display:flex;align-items:center;gap:.75rem;flex-wrap:wrap">
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

async function renderProbesList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Probes</h1></div>
    <div class="card"><p class="text-muted">Loading probes...</p></div>
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
    const rows = history.map((item, idx) => {
      const date = item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '—';
      const idea = nullSafe(item.idea, '—');
      const fileParam = item._file ?? `history-${idx}`;
      return `<tr style="cursor:pointer" data-href="#/probes/${encodeURIComponent(fileParam)}">
        <td>${date}</td>
        <td>${idea}</td>
        <td>${verdictBadge(item.verdict)}</td>
        <td>${nullSafe(item.domain)}</td>
      </tr>`;
    }).join('');
    historyHtml = `
      <div class="card" style="padding:0">
        <div style="padding:1rem 1.25rem 0"><h2 style="margin:0">History</h2></div>
        <table class="table" id="probe-history-table">
          <thead><tr><th>Date</th><th>Idea</th><th>Verdict</th><th>Domain</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } else {
    historyHtml = `<div class="card"><p class="text-muted">No probe history found.</p></div>`;
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
      const row = e.target.closest('tr[data-href]');
      if (row) window.location.hash = row.dataset.href;
    });
  }
}

async function renderProbeDetail(file) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Probe</h1></div>
    <div class="card"><p class="text-muted">Loading...</p></div>
  `;

  const url = file === 'latest'
    ? apiUrl('/probe/latest')
    : apiUrl(`/probe/history/${encodeURIComponent(file)}`);
  const data = await fetchJSON(url);

  if (!data || data.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Probe</h1></div>
      <div class="card"><p class="text-muted">Error: ${data ? data.message : 'unknown error'}</p></div>
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
    <div class="card"><p class="text-muted">Loading solvers...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const res = await fetchJSON(apiUrl('/solver'));
    if (res.error) {
      app.innerHTML = `
        <div class="view-header"><h1>Solvers</h1></div>
        <div class="card"><p class="text-muted">Error: ${res.message}</p></div>
      `;
      return;
    }

    const solvers = Array.isArray(res.data) ? res.data : [];

    app.innerHTML = `
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
    `;
  });

  window.addEventListener('hashchange', stopPolling, { once: true });
}

function renderSolverDetail(slug) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Solver</h1></div>
    <div class="card"><p class="text-muted">Loading...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const res = await fetchJSON(apiUrl(`/solver/${encodeURIComponent(slug)}`));
    if (res.error) {
      app.innerHTML = `
        <div class="view-header"><h1>Solver: <code>${slug}</code></h1></div>
        <div class="card"><p class="text-muted">Error: ${res.message || res.error}</p></div>
      `;
      return;
    }

    const m = res.manifest || {};
    const phases = Array.isArray(res.phases) ? res.phases : [];
    const phaseSet = new Set(phases.map(p => p.phase));

    let html = `
      <div class="view-header">
        <div><a href="#/solvers" style="font-size:0.875rem;opacity:0.7">← Solvers</a></div>
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

    app.innerHTML = html;

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
    <div class="card"><p class="text-muted">Loading config...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const res = await fetchJSON(apiUrl('/config'));
    if (res.error) {
      app.innerHTML = `
        <div class="view-header"><h1>Config</h1></div>
        <div class="card"><p class="text-muted">Error: ${res.message ?? res.error}</p></div>
      `;
      return;
    }
    app.innerHTML = `
      <div class="view-header"><h1>Config</h1></div>
      <div class="card">
        <pre style="margin:0;overflow:auto;font-size:0.85em">${JSON.stringify(res, null, 2)}</pre>
      </div>
    `;
  });

  window.addEventListener('hashchange', stopPolling, { once: true });
}

function renderTracesPlaceholder() {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Traces</h1><p>.xm/traces/</p></div>
    <div class="card" style="text-align:center;padding:3rem">
      <div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">◇</div>
      <p class="text-muted">No trace data yet.</p>
      <p style="font-size:0.8rem;color:var(--text-muted)">Run <code>/x-trace start</code> to begin recording agent execution.</p>
    </div>
  `;
}

function renderMemoryPlaceholder() {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Memory</h1><p>.xm/memory/</p></div>
    <div class="card" style="text-align:center;padding:3rem">
      <div style="font-size:2rem;margin-bottom:1rem;opacity:0.3">◇</div>
      <p class="text-muted">No memory data yet.</p>
      <p style="font-size:0.8rem;color:var(--text-muted)">Run <code>/x-memory</code> to begin storing cross-session decisions.</p>
    </div>
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
    <div class="card"><p class="text-muted">Searching...</p></div>
  `;

  const res = await fetchJSON(apiUrl(`/search?q=${encodeURIComponent(query)}`));
  if (res.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Search: <code>${query}</code></h1></div>
      <div class="card"><p class="text-muted">Error: ${res.message}</p></div>
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
      <div class="card"><p class="text-muted">No results found for "<strong>${query}</strong>".</p></div>
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

// Router

const ROUTES = [
  { pattern: /^\/$/, handler: () => renderHome() },
  { pattern: /^\/projects$/, handler: () => renderProjectsList() },
  { pattern: /^\/projects\/(.+)$/, handler: (m) => renderProjectDetail(m[1]) },
  { pattern: /^\/probes$/, handler: () => renderProbesList() },
  { pattern: /^\/probes\/(.+)$/, handler: (m) => renderProbeDetail(m[1]) },
  { pattern: /^\/solvers$/, handler: () => renderSolversList() },
  { pattern: /^\/solvers\/(.+)$/, handler: (m) => renderSolverDetail(m[1]) },
  { pattern: /^\/config$/, handler: () => renderConfig() },
  { pattern: /^\/traces$/, handler: () => renderTracesPlaceholder() },
  { pattern: /^\/memory$/, handler: () => renderMemoryPlaceholder() },
  { pattern: /^\/search\/(.+)$/, handler: (m) => renderSearch(decodeURIComponent(m[1])) },
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
  });
}

function route() {
  const path = getPath();
  updateActiveNav(path);

  for (const { pattern, handler } of ROUTES) {
    const match = path.match(pattern);
    if (match) {
      handler(match);
      return;
    }
  }

  render404(window.location.hash);
}

window.addEventListener('hashchange', route);

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
  searchDiv.innerHTML = '<input type="text" id="search-input" placeholder="Search .xm..." style="width:100%;background:#1a1a1a;border:2px solid #444;color:var(--text);padding:6px 10px;font-family:var(--font-mono);font-size:11px;box-sizing:border-box">';
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
})();

// Theme toggle
(function initTheme() {
  const saved = localStorage.getItem('xm-theme');
  if (saved === 'light') document.body.classList.add('theme-light');

  const nav = document.getElementById('nav');
  if (!nav) return;
  const btn = document.createElement('div');
  btn.style.cssText = 'padding:12px 14px;border-top:2px solid #333;margin-top:auto;cursor:pointer;font-size:11px;font-family:var(--font-mono);text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);user-select:none';
  btn.textContent = document.body.classList.contains('theme-light') ? '● DARK' : '◐ LIGHT';
  btn.addEventListener('click', () => {
    document.body.classList.toggle('theme-light');
    const isLight = document.body.classList.contains('theme-light');
    localStorage.setItem('xm-theme', isLight ? 'light' : 'dark');
    btn.textContent = isLight ? '● DARK' : '◐ LIGHT';
  });
  nav.appendChild(btn);
})();

initWorkspaces().then(() => route());
