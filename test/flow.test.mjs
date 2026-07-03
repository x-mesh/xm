// x-agent flow — engine + skill wiring invariants.
//
// flow-template.mjs is a Workflow script (top-level `return`), so it cannot be
// imported in Node — it is read as text. The pure helpers are extracted with
// `new Function` and exercised directly; the orchestration body is asserted
// structurally.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TEMPLATE = join(ROOT, 'x-agent', 'skills', 'agent', 'flow', 'flow-template.mjs');
const FLOW_MD = join(ROOT, 'x-agent', 'skills', 'agent', 'flow.md');
const SKILL_MD = join(ROOT, 'x-agent', 'skills', 'agent', 'SKILL.md');

const src = readFileSync(TEMPLATE, 'utf8');

// Pull the pure-helper region (parseArgs .. just before the orchestration banner)
// and materialize it so the algorithm is tested, not a re-implementation.
function loadHelpers() {
  const start = src.indexOf('function parseArgs');
  const end = src.indexOf('// Orchestration');
  const region = src.slice(start, end);
  const fn = new Function(region + '; return { parseArgs, topoLevels, depBlock, LEAF_SCHEMA, PLAN_SCHEMA };');
  return fn();
}

describe('flow-template engine: structural invariants', () => {
  test('begins with a pure-literal meta export (no interpolation)', () => {
    expect(src.startsWith('export const meta = {')).toBe(true);
    const meta = src.slice(0, src.indexOf('\n}\n'));
    expect(meta).not.toContain('${'); // no template interpolation in the required literal
  });

  test('guards args that arrive as a JSON string', () => {
    expect(src).toContain("typeof a === 'string' ? JSON.parse(a)");
  });

  test('makes no sandbox-forbidden API calls (Date.now / Math.random / new Date)', () => {
    // strip line comments so the "no Date.now/Math.random" doc comment is ignored
    const code = src.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('Date.now(');
    expect(code).not.toContain('Math.random(');
    expect(code).not.toMatch(/new Date\s*\(/);
  });

  test('defines the topo batcher and both schemas', () => {
    expect(src).toContain('function topoLevels');
    expect(src).toContain('const LEAF_SCHEMA');
    expect(src).toContain('const PLAN_SCHEMA');
  });

  test('returns the documented contract keys', () => {
    const tail = src.slice(src.indexOf('const base = {'));
    for (const key of ['op,', 'topic,', 'created_at:', 'status:', 'failed_count:', 'options:', 'level_ids:', 'leaf_results:']) {
      expect(tail).toContain(key);
    }
    expect(tail).toContain('merge'); // both the no_merge and merge paths return a merge field
  });

  test('implements --no-merge, fail-loud merge, per-leaf catch (review-fix)', () => {
    expect(src).toContain('cfg.no_merge');                 // #1 flag honored
    expect(src).toMatch(/merge == null\)[\s\S]{0,40}throw/); // #2 null merge throws, not silent
    expect(src).toMatch(/\.catch\(\(e\)/);                  // #4 thrown leaf -> failed, not parallel()-semantics-dependent
    expect(src).toContain('error: String(');                // N1 thrown error cause is captured, not discarded
    expect(src).toContain('failed_count');                  // #3 top-level run health
    expect(src).toContain('invalid plan');                  // #6 decomposer null distinct from empty
  });
});

describe('flow-template engine: topoLevels', () => {
  const { topoLevels } = loadHelpers();

  test('independent leaves share one level', () => {
    const lv = topoLevels([{ id: 'A', deps: [] }, { id: 'B', deps: [] }]);
    expect(lv.length).toBe(1);
    expect(lv[0].map((l) => l.id).sort()).toEqual(['A', 'B']);
  });

  test('dependent leaf drops to the next level', () => {
    const lv = topoLevels([{ id: 'A', deps: [] }, { id: 'B', deps: [] }, { id: 'C', deps: ['A', 'B'] }]);
    expect(lv.map((l) => l.map((x) => x.id))).toEqual([['A', 'B'], ['C']]);
  });

  test('chain produces one level per leaf', () => {
    const lv = topoLevels([{ id: 'A', deps: [] }, { id: 'B', deps: ['A'] }, { id: 'C', deps: ['B'] }]);
    expect(lv.length).toBe(3);
  });

  test('throws on a dependency cycle', () => {
    expect(() => topoLevels([{ id: 'X', deps: ['Y'] }, { id: 'Y', deps: ['X'] }])).toThrow(/cycle/);
  });

  test('throws on an unknown dependency id', () => {
    expect(() => topoLevels([{ id: 'A', deps: ['ghost'] }])).toThrow(/unknown id/);
  });

  test('throws on a duplicate leaf id', () => {
    expect(() => topoLevels([{ id: 'A', deps: [] }, { id: 'A', deps: [] }])).toThrow(/duplicate/);
  });

  test('throws on a leaf without an id', () => {
    expect(() => topoLevels([{ deps: [] }])).toThrow(/needs an id/);
  });

  test('empty input returns empty levels', () => {
    expect(topoLevels([])).toEqual([]);
  });
});

describe('flow-template engine: depBlock', () => {
  const { depBlock } = loadHelpers();

  test('empty deps returns empty string', () => {
    expect(depBlock({ deps: [] }, {})).toBe('');
    expect(depBlock({}, {})).toBe('');
  });

  test('missing dependency result falls back to n/a', () => {
    const out = depBlock({ deps: ['L1'] }, {});
    expect(out).toContain('Dependency L1');
    expect(out).toContain('n/a');
  });

  test('prefers .summary over a full JSON dump', () => {
    const out = depBlock({ deps: ['L1'] }, { L1: { summary: 'SUMMARY_TEXT', extra: 'noise' } });
    expect(out).toContain('SUMMARY_TEXT');
    expect(out).not.toContain('noise');
  });

  test('falls back to JSON.stringify when the result has no summary', () => {
    const out = depBlock({ deps: ['L1'] }, { L1: { status: 'completed', value: 42 } });
    expect(out).toContain('Dependency L1');
    expect(out).toContain('"value":42');
  });
});

describe('flow-template engine: schema contracts', () => {
  const { LEAF_SCHEMA, PLAN_SCHEMA } = loadHelpers();

  test('LEAF_SCHEMA mandates the cross-op invariants', () => {
    expect(LEAF_SCHEMA.required).toEqual(['leaf_id', 'status', 'summary']);
    expect(LEAF_SCHEMA.properties.findings.items.required).toEqual(['claim', 'evidence']);
  });

  test('PLAN_SCHEMA is closed and requires leaves', () => {
    expect(PLAN_SCHEMA.additionalProperties).toBe(false);
    expect(PLAN_SCHEMA.required).toContain('leaves');
    expect(PLAN_SCHEMA.properties.leaves.items.required).toEqual(['id', 'prompt', 'deps']);
  });

  test('PLAN_SCHEMA.model accepts built-in tiers and vendor strings, rejects junk', () => {
    const model = PLAN_SCHEMA.properties.leaves.items.properties.model;
    // relaxed from a fixed enum to a token pattern so vendor models pass through
    expect(model.enum).toBeUndefined();
    const re = new RegExp(model.pattern);
    for (const ok of ['haiku', 'sonnet', 'opus', 'gpt-5.5:high', 'claude-opus-4-8', 'gpt-5-mini']) {
      expect(re.test(ok)).toBe(true);
    }
    for (const bad of ['', ' ', 'gpt 5', ':leading', '-dash']) {
      expect(re.test(bad)).toBe(false);
    }
  });
});

describe('flow-template engine: parseArgs', () => {
  const { parseArgs } = loadHelpers();

  test('parses a JSON string', () => {
    expect(parseArgs('{"op":"review"}').op).toBe('review');
  });

  test('passes an object through unchanged', () => {
    const o = { op: 'generic' };
    expect(parseArgs(o)).toBe(o);
  });

  test('throws when args is missing', () => {
    expect(() => parseArgs(undefined)).toThrow(/args missing/);
    expect(() => parseArgs(null)).toThrow(/args missing/);
  });
});

describe('flow skill wiring', () => {
  const flowMd = readFileSync(FLOW_MD, 'utf8');
  const skillMd = readFileSync(SKILL_MD, 'utf8');

  test('flow.md points at the engine and forbids hand-authoring', () => {
    expect(flowMd).toContain('flow/flow-template.mjs');
    expect(flowMd).toContain('Do not author a script from scratch');
  });

  test('flow.md keeps the required discipline sections', () => {
    expect(flowMd).toContain('## Common Rationalizations');
    expect(flowMd).toContain('## Red Flags');
    expect(flowMd).toContain('## Verification');
  });

  test('SKILL.md routes flow and links flow.md', () => {
    expect(skillMd).toContain('`flow` → [Subcommand: flow]');
    expect(skillMd).toContain('[flow.md](./flow.md)');
  });

  test('SKILL.md stays within the 500-line budget', () => {
    expect(skillMd.split('\n').length).toBeLessThanOrEqual(500);
  });
});
