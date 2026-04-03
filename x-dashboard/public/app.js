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

async function renderHome() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Home</h1></div>
    <div class="card"><p class="text-muted">Loading...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const [projectsRes, solverRes, probeRes] = await Promise.all([
      fetchJSON('/api/projects'),
      fetchJSON('/api/solver'),
      fetchJSON('/api/probe/latest'),
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

    app.innerHTML = `
      <div class="view-header"><h1>Home</h1></div>

      <div class="stat-bar">
        <div class="card stat-card">
          <div class="stat-value">${projects.length}</div>
          <div class="stat-label">Projects</div>
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
        <div class="card-header"><strong>Recent Projects</strong></div>
        ${recent.length === 0 ? `<p class="text-muted">No projects found.</p>` : `
        <ul style="list-style:none;padding:0;margin:0">
          ${recent.map(p => `
          <li style="padding:0.5rem 0;border-bottom:1px solid var(--border, #e5e7eb);display:flex;align-items:center;justify-content:space-between">
            <a href="#/projects/${p.slug ?? p.name}">${nullSafe(p.name, p.slug ?? '—')}</a>
            <span style="display:flex;align-items:center;gap:0.5rem">
              ${phaseBadge(p.phase ?? p.current_phase)}
              <span class="text-muted" style="font-size:0.8em">${timeAgo(p.updated_at ?? p.created_at)}</span>
            </span>
          </li>`).join('')}
        </ul>`}
      </div>
    `;
  }, 3000);

  // Stop polling when navigating away
  window.addEventListener('hashchange', stopPolling, { once: true });
}

function renderProjectsList() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Projects</h1></div>
    <div class="card"><p class="text-muted">Loading projects...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const result = await fetchJSON('/api/projects');
    if (result.error) {
      app.innerHTML = `
        <div class="view-header"><h1>Projects</h1></div>
        <div class="card"><p class="text-muted">Error: ${result.message}</p></div>
      `;
      return;
    }

    const projects = result.data || [];
    if (projects.length === 0) {
      app.innerHTML = `
        <div class="view-header"><h1>Projects</h1></div>
        <div class="card"><p class="text-muted">No projects found.</p></div>
      `;
      return;
    }

    const rows = projects.map((p) => `
      <tr>
        <td><a href="#/projects/${nullSafe(p.slug, '')}">${nullSafe(p.name)}</a></td>
        <td>${phaseBadge(p.phase)}</td>
        <td>${timeAgo(p.created_at)}</td>
        <td>${timeAgo(p.updated_at)}</td>
      </tr>
    `).join('');

    app.innerHTML = `
      <div class="view-header"><h1>Projects</h1></div>
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

function switchTab(tabId, idx, btn) {
  const card = btn.closest('.card');
  card.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('tab-active'));
  btn.classList.add('tab-active');
  card.querySelectorAll('.tab-panel').forEach((p, i) => {
    p.style.display = i === idx ? '' : 'none';
  });
}

function renderProjectDetail(slug) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Project: <code>${slug}</code></h1></div>
    <div class="card"><p class="text-muted">Loading project...</p></div>
  `;

  const stopPolling = startPolling(async () => {
    const [projectResult, tasksResult] = await Promise.all([
      fetchJSON(`/api/projects/${slug}`),
      fetchJSON(`/api/projects/${slug}/tasks`),
    ]);

    if (projectResult.error) {
      app.innerHTML = `
        <div class="view-header"><h1>Project: <code>${slug}</code></h1></div>
        <div class="card"><p class="text-muted">Error: ${projectResult.message}</p></div>
      `;
      return;
    }

    const { manifest, circuitBreaker, handoff, context } = projectResult;
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

    // Context docs (tabs)
    const docs = Array.isArray(context) ? context : [];
    if (docs.length > 0) {
      const tabId = 'ctx-tab';
      const tabs = docs.map((d, i) => `
        <button class="tab-btn${i === 0 ? ' tab-active' : ''}" onclick="switchTab('${tabId}', ${i}, this)">${d.name}</button>
      `).join('');
      const panels = docs.map((d, i) => `
        <div class="tab-panel" id="${tabId}-panel-${i}" style="${i === 0 ? '' : 'display:none'}">
          <div class="markdown-body">${renderMarkdown(d.content)}</div>
        </div>
      `).join('');
      html += `
        <div class="card">
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

    app.innerHTML = html;
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
      <p class="text-muted" style="margin:4px 0 0">${ts}${data.domain ? ` · ${data.domain}` : ''}</p>
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
    fetchJSON('/api/probe/latest'),
    fetchJSON('/api/probe/history'),
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

  const files = (!historyRes.error && Array.isArray(historyRes.files)) ? historyRes.files : [];

  let historyHtml = '';
  if (files.length > 0) {
    const rows = files.slice().reverse().map((f) => {
      const date = f.length >= 10 ? f.substring(0, 10) : f;
      const label = f.replace(/\.json$/, '').substring(11).replace(/-/g, ' ');
      return `<tr data-file="${f}" style="cursor:pointer" onclick="window.location.hash='#/probes/${encodeURIComponent(f)}'">
        <td>${date}</td>
        <td>${label}</td>
        <td></td>
        <td></td>
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

  // Async-fill verdict/domain/idea for each history row
  files.forEach((f) => {
    fetchJSON(`/api/probe/history/${encodeURIComponent(f)}`).then((d) => {
      if (!d || d.error) return;
      const table = document.getElementById('probe-history-table');
      if (!table) return;
      table.querySelectorAll('tbody tr').forEach((row) => {
        if (row.dataset.file === f) {
          if (d.idea) row.cells[1].textContent = d.idea;
          row.cells[2].innerHTML = verdictBadge(d.verdict);
          row.cells[3].textContent = nullSafe(d.domain);
        }
      });
    });
  });
}

async function renderProbeDetail(file) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="view-header"><h1>Probe</h1></div>
    <div class="card"><p class="text-muted">Loading...</p></div>
  `;

  const url = file === 'latest'
    ? '/api/probe/latest'
    : `/api/probe/history/${encodeURIComponent(file)}`;
  const data = await fetchJSON(url);

  if (!data || data.error) {
    app.innerHTML = `
      <div class="view-header"><h1>Probe</h1></div>
      <div class="card"><p class="text-muted">Error: ${data ? data.message : 'unknown error'}</p></div>
    `;
    return;
  }

  app.innerHTML = buildProbeDetailHtml(data);
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
    const res = await fetchJSON('/api/solver');
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
    const res = await fetchJSON(`/api/solver/${encodeURIComponent(slug)}`);
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
        const { phase, ...data } = p;
        html += `
          <div class="card" style="margin-top:1rem">
            <div style="font-weight:600;margin-bottom:0.5rem">${solverPhaseBadge(phase)} ${phase}</div>
            <pre style="margin:0;white-space:pre-wrap;font-size:0.8rem;opacity:0.85">${JSON.stringify(data, null, 2)}</pre>
          </div>`;
      }
    }

    app.innerHTML = html;
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
    const res = await fetchJSON('/api/config');
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

function render404(hash) {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Not Found</h1></div>
    <div class="card"><p class="text-muted">No route matched: <code>${hash}</code></p></div>
  `;
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
];

function getPath() {
  const hash = window.location.hash;
  return hash.startsWith('#') ? hash.slice(1) || '/' : '/';
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
route();
