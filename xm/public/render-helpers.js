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

  // ── Cost dashboard mock data + aggregation ─────────────────────────────
  // t4 deliberately keeps this browser-only and deterministic.  t5 owns the
  // live /api/costs/* contract; do not let a dashboard prototype invent it.
  const COST_MODELS = ['haiku', 'sonnet', 'opus'];
  const COST_STRATEGIES = ['direct', 'review', 'debate', 'tournament'];
  const COST_PROJECTS = ['x-build', 'x-panel', 'x-dashboard'];
  const COST_ROLES = ['executor', 'reviewer', 'planner', 'critic', 'verifier', 'researcher', 'security', 'debugger', 'optimizer', 'documenter', 'architect', 'test-engineer'];
  const COST_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  function utcDay(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }

  function addUtcDays(date, amount) {
    const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 12));
    result.setUTCDate(result.getUTCDate() + amount);
    return result;
  }

  // Fixed formula, not fixed calendar dates: a screen opened months later still
  // has a complete 90-day mock range, while tests can pass a fixed reference.
  function makeCostMockEvents(reference = new Date()) {
    const today = new Date(reference);
    const anchor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 12));
    const events = [];
    for (let i = 0; i < 120; i++) {
      const timestamp = addUtcDays(anchor, -i);
      timestamp.setUTCHours(7 + ((i * 5) % 13), (i * 11) % 60, 0, 0);
      events.push({
        timestamp: timestamp.toISOString(),
        model: COST_MODELS[i % COST_MODELS.length],
        strategy: COST_STRATEGIES[(i * 3) % COST_STRATEGIES.length],
        project: COST_PROJECTS[(i * 5) % COST_PROJECTS.length],
        role: COST_ROLES[(i * 7) % COST_ROLES.length],
        cost: Number((0.008 + ((i * 17) % 29) / 1000).toFixed(4)),
      });
      // A second call creates visible stacking and a non-uniform heatmap.
      if (i % 3 === 0) {
        const followUp = new Date(timestamp);
        followUp.setUTCHours((timestamp.getUTCHours() + 4) % 24);
        events.push({
          timestamp: followUp.toISOString(),
          model: COST_MODELS[(i + 1) % COST_MODELS.length],
          strategy: COST_STRATEGIES[(i + 1) % COST_STRATEGIES.length],
          project: COST_PROJECTS[(i + 1) % COST_PROJECTS.length],
          role: COST_ROLES[(i + 3) % COST_ROLES.length],
          cost: Number((0.004 + ((i * 7) % 17) / 1000).toFixed(4)),
        });
      }
    }
    return events;
  }

  function filterCostEvents(events, filters = {}, reference = new Date()) {
    const period = Number(filters.period || 30);
    const safePeriod = [7, 30, 90].includes(period) ? period : 30;
    const start = addUtcDays(reference, -(safePeriod - 1));
    start.setUTCHours(0, 0, 0, 0);
    return (Array.isArray(events) ? events : []).filter((event) => {
      const timestamp = new Date(event.timestamp);
      if (Number.isNaN(timestamp.getTime()) || timestamp < start) return false;
      return (!filters.model || filters.model === 'all' || event.model === filters.model)
        && (!filters.strategy || filters.strategy === 'all' || event.strategy === filters.strategy)
        && (!filters.project || filters.project === 'all' || event.project === filters.project);
    });
  }

  function buildCostChartModel(events, filters = {}, reference = new Date()) {
    const period = [7, 30, 90].includes(Number(filters.period)) ? Number(filters.period) : 30;
    const filtered = filterCostEvents(events, { ...filters, period }, reference);
    const days = Array.from({ length: period }, (_, index) => utcDay(addUtcDays(reference, -(period - 1) + index)));
    const costsByDay = new Map(days.map((day) => [day, 0]));
    const strategyCosts = new Map();
    const strategyModelCosts = new Map();
    const roleCosts = new Map();
    const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));

    for (const event of filtered) {
      const cost = Number(event.cost) || 0;
      const day = utcDay(event.timestamp);
      if (costsByDay.has(day)) costsByDay.set(day, costsByDay.get(day) + cost);
      strategyCosts.set(event.strategy, (strategyCosts.get(event.strategy) || 0) + cost);
      const strategyModelKey = `${event.strategy}\u0000${event.model}`;
      strategyModelCosts.set(strategyModelKey, (strategyModelCosts.get(strategyModelKey) || 0) + cost);
      roleCosts.set(event.role, (roleCosts.get(event.role) || 0) + cost);
      const timestamp = new Date(event.timestamp);
      heatmap[timestamp.getUTCDay()][timestamp.getUTCHours()] += cost;
    }

    const strategies = [...strategyCosts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([label, value]) => ({ label, value: Number(value.toFixed(4)) }));
    const strategyModels = [...new Set(filtered.map((event) => event.model))].sort();
    const roles = [...roleCosts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([label, value]) => ({ label, value: Number(value.toFixed(4)) }));
    const total = filtered.reduce((sum, event) => sum + (Number(event.cost) || 0), 0);

    return {
      events: filtered,
      total: Number(total.toFixed(4)),
      daily: { labels: days, values: days.map((day) => Number((costsByDay.get(day) || 0).toFixed(4))) },
      strategies,
      strategyBars: {
        labels: strategyModels,
        datasets: strategies.map(({ label }) => ({
          label,
          values: strategyModels.map((model) => Number((strategyModelCosts.get(`${label}\u0000${model}`) || 0).toFixed(4))),
        })),
      },
      roles,
      heatmap: { weekdays: COST_WEEKDAYS, values: heatmap.map((row) => row.map((value) => Number(value.toFixed(4)))) },
    };
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

  g.XMRender = {
    escapeHtml, renderValue, renderEmpty, fmtAgents, preprocessDiagrams,
    makeCostMockEvents, filterCostEvents, buildCostChartModel,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
