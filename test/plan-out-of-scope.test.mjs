/**
 * PlanEnvelope `out_of_scope`: what the plan deliberately leaves out.
 * It is carried to the reader and the executor and is never validated beyond its type.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePlanEnvelope, validatePlanEnvelope } from '../x-plan/lib/x-plan/core.mjs';
import { renderPlan } from '../x-plan/lib/x-plan/render.mjs';
import { synthesizePlanCandidates } from '../x-plan/lib/x-plan/synthesize.mjs';

const BUILD_CLI = join(import.meta.dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

function envelope(overrides = {}) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Ship the export',
    requirements: [{ id: 'R1', text: 'Export the report', priority: 'must' }], assumptions: [],
    decision: { selected: 'Native plan', alternatives: [] },
    tasks: [{ id: 'T1', title: 'Implement export', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/export.mjs'], done_criteria: ['report is written'] }],
    steps: [['T1']], validation: { commands: ['node --test'], requirement_refs: ['R1'] },
    disagreements: [], unresolved_questions: [], provenance: {},
    ...overrides,
  };
}

function importedPrd(plan) {
  const cwd = mkdtempSync(join(tmpdir(), 'plan-out-of-scope-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd });
    const env = { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: join(cwd, '.xm', 'build'), XKIT_SERVER: '0' };
    expect(spawnSync('node', [BUILD_CLI, 'init', 'demo'], { cwd, env, encoding: 'utf8' }).status).toBe(0);
    const file = join(cwd, 'plan.json');
    writeFileSync(file, JSON.stringify(plan));
    const result = spawnSync('node', [BUILD_CLI, 'import-plan', file, '--json'], { cwd, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(join(cwd, '.xm', 'build', 'projects', 'demo', 'phases', '02-plan', 'PRD.md'), 'utf8');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

describe('PlanEnvelope out_of_scope', () => {
  test('normalization trims entries and drops blanks', () => {
    expect(normalizePlanEnvelope(envelope({ out_of_scope: [' CSV export ', ''] })).out_of_scope).toEqual(['CSV export']);
  });

  // x-build batch receipts store a hash of the normalized envelope and compare it later, so a
  // plan that names no exclusion must normalize to the shape it had before the field existed.
  test.each([
    ['absent', {}],
    ['empty', { out_of_scope: [] }],
    ['blank only', { out_of_scope: ['  '] }],
  ])('an envelope with the field %s has no such key', (_label, fields) => {
    expect(Object.keys(normalizePlanEnvelope(envelope(fields)))).toEqual([
      'schema_version', 'status', 'executable', 'goal', 'requirements', 'assumptions', 'decision', 'tasks', 'steps',
      'validation', 'failure_modes', 'disagreements', 'unresolved_questions', 'provenance',
    ]);
  });

  test('an envelope without the field stays valid and executable', () => {
    const result = validatePlanEnvelope(envelope());
    expect(result.valid).toBe(true);
    expect(result.value.executable).toBe(true);
  });

  test('a non-array value is a type error', () => {
    const result = validatePlanEnvelope(envelope({ out_of_scope: 'CSV export' }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.path)).toContain('out_of_scope');
  });

  test('the readable plan lists the exclusions only when there are any', () => {
    const output = renderPlan(normalizePlanEnvelope(envelope({ out_of_scope: ['CSV export', 'Scheduling'] })));
    expect(output).toContain('## Out of scope\n\n- CSV export\n- Scheduling');
    expect(renderPlan(normalizePlanEnvelope(envelope()))).not.toContain('Out of scope');
  });

  test('ultra synthesis keeps every candidate exclusion once', () => {
    const out = synthesizePlanCandidates([
      { source: 'm1', ok: true, plan: envelope({ out_of_scope: ['CSV export'] }) },
      { source: 'm2', ok: true, plan: envelope({ out_of_scope: ['CSV export', 'Scheduling'] }) },
    ]);
    expect(out.ok).toBe(true);
    expect(out.plan.out_of_scope).toEqual(['CSV export', 'Scheduling']);
  });

  test('import-plan writes them into the PRD the executor reads', () => {
    const prd = importedPrd(envelope({ out_of_scope: ['CSV export'] }));
    expect(prd).toContain('## 6. Out of Scope\n- CSV export');
  });

  test('import-plan writes no such section for a plan without exclusions', () => {
    expect(importedPrd(envelope())).not.toContain('Out of Scope');
  });
});
