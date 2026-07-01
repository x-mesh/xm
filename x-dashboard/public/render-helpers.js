/*
 * render-helpers.js — pure, side-effect-free render/format helpers for the
 * dashboard, extracted from app.js so they are unit-testable (app.js is a
 * 6.7k-line classic <script> with no exports). Dual-loaded:
 *   - browser: a classic <script> tag (runs the IIFE, sets globalThis.XMRender)
 *     loaded BEFORE app.js, so app.js's delegators can call into it.
 *   - tests:   `import '../public/render-helpers.js'` runs the IIFE the same way,
 *     then reads globalThis.XMRender.
 *
 * Invariant under test (x-dashboard/test/render.test.mjs): renderValue NEVER
 * returns the literal "[object Object]" — the bug that shipped to the dashboard
 * (the agent column showed "[object Object]"; op/eval detail dumped raw JSON).
 */
(function (g) {
  'use strict';

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const EMPTY = '<span class="text-muted">—</span>';

  // Render any JS value as HTML without ever producing "[object Object]":
  // object → key/value table, array → list, primitive → escaped text. Recurses
  // for nested structures. Use this instead of `<pre>JSON.stringify(...)</pre>`.
  function renderValue(v, depth = 0) {
    if (v == null || v === '') return EMPTY;
    if (typeof v === 'boolean') return v ? '✓' : '✗';
    if (typeof v === 'number') return escapeHtml(String(v));
    if (typeof v === 'string') return escapeHtml(v);
    // Depth guard for cyclic/huge data. An object/array here must NOT fall to
    // String(v) — that is exactly the "[object Object]" we exist to prevent.
    if (depth > 6) return (v && typeof v === 'object') ? '<span class="text-muted">…</span>' : escapeHtml(String(v));
    if (Array.isArray(v)) {
      if (v.length === 0) return EMPTY;
      return '<ul class="rv-list">' +
        v.map((x) => `<li>${renderValue(x, depth + 1)}</li>`).join('') + '</ul>';
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length === 0) return EMPTY;
      const rows = keys.map((k) =>
        `<tr><th>${escapeHtml(k)}</th><td>${renderValue(v[k], depth + 1)}</td></tr>`).join('');
      return `<table class="rv-table">${rows}</table>`;
    }
    return escapeHtml(String(v)); // functions/symbols → source/desc, never "[object Object]"
  }

  // Empty-state card. `searched` (string | string[]) discloses which path(s) were
  // scanned, so a blank view reads as "nothing here yet" rather than "broken /
  // misconfigured" (the lib-mesh PRD "왜 값이 없지?" confusion).
  function renderEmpty(msg, cmd, searched) {
    const paths = searched == null ? [] : [].concat(searched).filter(Boolean);
    const searchedLine = paths.length
      ? `<p class="empty-hint text-muted">searched: ${paths.map(escapeHtml).join(', ')} — 0 found</p>`
      : '';
    return `<div class="card empty-state">
    <div class="empty-icon">◇</div>
    <p class="text-muted">${msg}</p>
    ${searchedLine}
    ${cmd ? `<p class="empty-hint">Run <code>${cmd}</code></p>` : ''}
  </div>`;
  }

  // Format an agents field that may be a number, string, or array of agent
  // objects. Avoids "[object Object]" when op results store agents as entries.
  function fmtAgents(a) {
    if (a == null || a === '') return '—';
    if (typeof a === 'number') return String(a);
    if (typeof a === 'string') return a;
    if (Array.isArray(a)) {
      if (a.length === 0) return '—';
      const names = a.map((x) => typeof x === 'string' ? x : (x && (x.name || x.role || x.strategy || x.label || x.dimension))).filter(Boolean);
      return names.length === a.length ? names.join(', ') : String(a.length);
    }
    if (typeof a === 'object') return a.name || a.role || a.strategy || '—';
    return '—';
  }

  g.XMRender = { escapeHtml, renderValue, renderEmpty, fmtAgents };
})(typeof globalThis !== 'undefined' ? globalThis : this);
