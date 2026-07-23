// Render-layer gate (Theme 3 / dash-render-untested): the dashboard's pure
// render helpers ship untested in a 6.7k-line app.js, so object/empty/unknown
// shapes reached the UI as "[object Object]" or raw JSON dumps and were caught
// only by the user after a release. These assert the contract instead.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import '../public/render-helpers.js'; // IIFE sets globalThis.XMRender

const {
  renderValue, renderEmpty, fmtAgents, preprocessDiagrams,
  makeCostMockEvents, filterCostEvents, buildCostChartModel,
} = globalThis.XMRender;

describe('renderValue', () => {
  test('never emits "[object Object]" for any shape', () => {
    const fixtures = [
      { a: 1, b: 'x' },
      [{ name: 'codex' }, { name: 'claude' }],
      { nested: { deep: { x: [1, 2, { y: 3 }] } } },
      null,
      undefined,
      '',
      [],
      {},
      { fn: () => 1 },
      0,
      false,
      // 9-level deep nesting — must hit the depth guard without leaking "[object Object]"
      { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: 1 } } } } } } } } } },
      [[[[[[[[[['deep']]]]]]]]]],
    ];
    for (const f of fixtures) {
      expect(renderValue(f)).not.toContain('[object Object]');
    }
  });

  test('object input produces a table, not a raw JSON dump', () => {
    const html = renderValue({ strategy: 'debate', rounds: 2 });
    expect(html).toContain('<table');
    expect(html).toContain('strategy');
    expect(html).toContain('debate');
    expect(html).not.toContain('{'); // no JSON.stringify braces
  });

  test('array input produces a list', () => {
    const html = renderValue(['a', 'b']);
    expect(html).toContain('<ul');
    expect(html).toContain('<li>');
  });

  test('escapes HTML in string values', () => {
    expect(renderValue('<script>x</script>')).not.toContain('<script>');
    expect(renderValue({ k: '<b>' })).toContain('&lt;b&gt;');
  });

  test('null/empty render as an em-dash, not literal null', () => {
    expect(renderValue(null)).toContain('—');
    expect(renderValue(null)).not.toContain('null');
    expect(renderValue({})).toContain('—');
  });
});

describe('renderEmpty', () => {
  test('discloses scanned paths when provided', () => {
    const html = renderEmpty('No PRDs found', 'xm build plan', ['.xm/build/projects']);
    expect(html).toContain('searched:');
    expect(html).toContain('.xm/build/projects');
    expect(html).toContain('0 found');
  });

  test('omits the searched line when no paths given (back-compat)', () => {
    const html = renderEmpty('No PRDs found', 'xm build plan');
    expect(html).not.toContain('searched:');
    expect(html).toContain('No PRDs found');
  });

  test('accepts a single path string', () => {
    expect(renderEmpty('empty', null, '.xm/op')).toContain('.xm/op');
  });
});

describe('fmtAgents', () => {
  test('formats array of agent objects without "[object Object]"', () => {
    const out = fmtAgents([{ name: 'codex' }, { role: 'critic' }]);
    expect(out).toBe('codex, critic');
    expect(out).not.toContain('[object Object]');
  });
  test('handles number, string, null', () => {
    expect(fmtAgents(3)).toBe('3');
    expect(fmtAgents('claude')).toBe('claude');
    expect(fmtAgents(null)).toBe('—');
  });
});

describe('preprocessDiagrams', () => {
  // Regression: the PRD template fences every ASCII diagram. The old heuristic
  // re-fenced already-fenced content, and the injected ``` closed the source
  // fence — spilling box-drawing art into markdown context (broke every
  // dashboard diagram). Fenced content must now pass through untouched.
  const F = '```';
  const fenceCount = (s) => (s.match(/```/g) || []).length;

  test('does not re-fence a diagram already inside a code fence (idempotent)', () => {
    const md = [
      '## 8. Architecture',
      '',
      F,
      '[A] ──▶ [B]',
      '        │',
      '        ▼',
      '[C]',
      F,
      '',
      'prose after',
    ].join('\n');
    expect(preprocessDiagrams(md)).toBe(md);   // untouched
    expect(fenceCount(preprocessDiagrams(md))).toBe(2); // no injected fences
  });

  test('leaves fenced blocks with a language info-string untouched', () => {
    const md = ['text', F + 'bash', 'echo ──▶ x', F, 'end'].join('\n');
    expect(preprocessDiagrams(md)).toBe(md);
  });

  test('wraps an unfenced ASCII diagram in exactly one fence pair', () => {
    const md = ['before', '[A] ──▶ [B]', '   │      │', '   ▼      ▼', '[C] ◀── [D]', '', 'after'].join('\n');
    const out = preprocessDiagrams(md);
    expect(fenceCount(out)).toBe(2);
    expect(out).toContain('[A] ──▶ [B]');
    expect(out).toContain('[C] ◀── [D]');
    // box art is fenced: the opening fence sits between prose and the diagram
    expect(out.indexOf('before')).toBeLessThan(out.indexOf(F));
    expect(out.indexOf(F)).toBeLessThan(out.indexOf('[A] ──▶ [B]'));
  });

  test('an internal blank line does not split an unfenced diagram', () => {
    const md = ['[A] ──▶ [B]', '', '[C] ──▶ [D]'].join('\n');
    expect(fenceCount(preprocessDiagrams(md))).toBe(2); // one pair, not two
  });

  test('empty / nullish input is safe', () => {
    expect(preprocessDiagrams('')).toBe('');
    expect(preprocessDiagrams(null)).toBe('');
    expect(preprocessDiagrams(undefined)).toBe('');
  });
});

describe('cost dashboard aggregation (mock-only t4)', () => {
  const reference = new Date('2026-07-23T12:00:00.000Z');
  const events = makeCostMockEvents(reference);

  test('mock fixture is deterministic for a fixed reference time', () => {
    expect(makeCostMockEvents(reference)).toEqual(events);
    expect(events.length).toBeGreaterThan(120);
  });

  test('period and dimension filters constrain the source events', () => {
    const sevenDays = filterCostEvents(events, { period: '7' }, reference);
    const modelOnly = filterCostEvents(events, { period: '90', model: 'opus' }, reference);
    const projectOnly = filterCostEvents(events, { period: '90', project: 'x-panel' }, reference);
    expect(sevenDays.length).toBeGreaterThan(0);
    expect(sevenDays.length).toBeLessThan(events.length);
    expect(modelOnly.every((event) => event.model === 'opus')).toBe(true);
    expect(projectOnly.every((event) => event.project === 'x-panel')).toBe(true);
  });

  test('builds line, stacked-bar, horizontal-bar, and weekday-hour models from one filter', () => {
    const model = buildCostChartModel(events, { period: '30', strategy: 'review' }, reference);
    expect(model.daily.labels).toHaveLength(30);
    expect(model.daily.values).toHaveLength(30);
    expect(model.strategyBars.datasets.length).toBeGreaterThan(0);
    expect(model.roles.length).toBeLessThanOrEqual(10);
    expect(model.heatmap.values).toHaveLength(7);
    expect(model.heatmap.values.every((row) => row.length === 24)).toBe(true);
    expect(model.events.every((event) => event.strategy === 'review')).toBe(true);
    expect(model.total).toBeGreaterThan(0);
  });
});

describe('cost dashboard static asset contract', () => {
  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  test('ships the canonical Cost nav while retaining the legacy costs route', () => {
    expect(indexHtml).toContain('href="#/cost" data-route="/cost"');
    expect(appSource).toContain("{ pattern: /^\\/cost$/, handler: () => renderCostDashboard() }");
    expect(appSource).toContain("{ pattern: /^\\/costs$/, handler: () => renderCostsPage() }");
    expect(appSource).toContain("if (path !== '/cost') {");
    expect(appSource).toContain('stopCostDashboard();');
  });

  test('renders four distinct chart surfaces and four wired filters', () => {
    for (const id of ['cost-daily-chart', 'cost-strategy-chart', 'cost-role-chart', 'cost-mape-chart', 'cost-heatmap-chart']) {
      expect(appSource).toContain(`id="${id}"`);
    }
    for (const name of ['period', 'model', 'strategy', 'project']) {
      expect(appSource).toContain(`name="${name}"`);
    }
    expect(appSource).toContain('Strategy by model');
    expect(appSource).toContain('stacked: true');
  });

  test('keeps replay cost out of primary charts and provides a persistent accessible separate-cost toggle', () => {
    expect(appSource).toContain("const COST_REPLAY_TOGGLE_KEY = 'xm-cost-show-replays';");
    expect(appSource).toContain('name="show_replays"');
    expect(appSource).toContain('Show replay cost separately');
    expect(appSource).toContain('Replay cost is excluded from primary totals and charts.');
    expect(appSource).toContain('replay cost (excluded)');
  });

  test('polls all live rollup endpoints and keeps mock data out of the Cost route', () => {
    for (const endpoint of ['/costs/timeline?', '/costs/breakdown?', '/costs/role-top?', '/costs/heatmap?', '/costs/calibration?']) {
      expect(appSource).toContain(endpoint);
    }
    expect(appSource).toContain('startPolling(refresh, 5000)');
    expect(appSource).toContain('Live cost API error:');
    expect(appSource).not.toContain('Mock dataset. Live cost API wiring follows in t5.');
  });

  test('resolves chart tokens from body so the light theme overrides apply', () => {
    expect(appSource).toContain('getComputedStyle(document.body || document.documentElement)');
    const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
    expect(css).toContain('body.theme-light');
    expect(css).toContain('--chart-line: #9a3e00');
    expect(css).toContain('--chart-heatmap-rgb: 154, 62, 0');
  });
});
