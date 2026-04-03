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

function renderHome() {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Home</h1></div>
    <div class="card"><p class="text-muted">Loading home...</p></div>
  `;
}

function renderProjectsList() {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Projects</h1></div>
    <div class="card"><p class="text-muted">Loading projects...</p></div>
  `;
}

function renderProjectDetail(slug) {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Project: <code>${slug}</code></h1></div>
    <div class="card"><p class="text-muted">Loading project...</p></div>
  `;
}

function renderProbesList() {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Probes</h1></div>
    <div class="card"><p class="text-muted">Loading probes...</p></div>
  `;
}

function renderProbeDetail(file) {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Probe: <code>${file}</code></h1></div>
    <div class="card"><p class="text-muted">Loading probe...</p></div>
  `;
}

function renderSolversList() {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Solvers</h1></div>
    <div class="card"><p class="text-muted">Loading solvers...</p></div>
  `;
}

function renderSolverDetail(slug) {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Solver: <code>${slug}</code></h1></div>
    <div class="card"><p class="text-muted">Loading solver...</p></div>
  `;
}

function renderConfig() {
  document.getElementById('app').innerHTML = `
    <div class="view-header"><h1>Config</h1></div>
    <div class="card"><p class="text-muted">Loading config...</p></div>
  `;
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
