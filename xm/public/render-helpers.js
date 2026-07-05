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

  // Prepare markdown so ASCII diagrams survive marked.parse(). Two rules:
  //  1. Content already inside a ``` / ~~~ fenced block is passed through
  //     UNTOUCHED. The PRD template fences every diagram; re-fencing it is the
  //     bug that broke every dashboard diagram — an injected ``` closes the
  //     source fence, spilling box-drawing art into markdown context where
  //     [..] becomes a link, blank lines split the block, and alignment dies.
  //  2. Only *unfenced* runs of diagram lines (defensive: model output that
  //     forgot to fence) get wrapped in a ``` fence. A blank line inside such a
  //     run does not close it as long as the diagram continues afterward.
  const DIAGRAM_RE = /[─│┌┐└┘├┤┬┴┼▶◀▼▲►◄═║╔╗╚╝╠╣╦╩╬]|──|╌╌/;
  const FENCE_RE = /^\s*(```|~~~)/;
  function preprocessDiagrams(text) {
    const lines = String(text ?? '').split('\n');
    const out = [];
    let inSourceFence = false; // inside a ``` / ~~~ block authored in the source
    let inAutoFence = false;   // inside a ``` we injected for an unfenced diagram
    const isDiagram = (s) => s != null && DIAGRAM_RE.test(s);
    const nextNonBlank = (i) => {
      for (let j = i; j < lines.length; j++) {
        if (lines[j].trim() !== '') return lines[j];
      }
      return null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (FENCE_RE.test(line)) {
        if (inAutoFence) { out.push('```'); inAutoFence = false; }
        inSourceFence = !inSourceFence;
        out.push(line);
        continue;
      }
      if (inSourceFence) { out.push(line); continue; }
      if (isDiagram(line)) {
        if (!inAutoFence) { out.push('```'); inAutoFence = true; }
        out.push(line);
        continue;
      }
      if (inAutoFence) {
        // Keep a blank line inside the auto-fenced run only if the diagram
        // resumes after it; otherwise the run is over — close the fence.
        if (line.trim() === '' && isDiagram(nextNonBlank(i + 1))) {
          out.push(line);
          continue;
        }
        out.push('```');
        inAutoFence = false;
      }
      out.push(line);
    }
    if (inAutoFence) out.push('```');
    return out.join('\n');
  }

  g.XMRender = { escapeHtml, renderValue, renderEmpty, fmtAgents, preprocessDiagrams };
})(typeof globalThis !== 'undefined' ? globalThis : this);
