/**
 * PlanEnvelope failure-mode enumeration.
 *
 * docs/phase-model-routing-experiment.md measured this as the robustness lever:
 * with no enumeration, sonnet execution solved 0/3 pathological cases; with
 * enumeration plus a concrete prescription it solved 3/3, beating opus execution
 * (2/3). The lean transition moved planning to x-plan, whose envelope had no
 * field for it — these tests pin the restored path end to end.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePlanEnvelope, validatePlanEnvelope } from '../x-plan/lib/x-plan/core.mjs';
import { renderPlan } from '../x-plan/lib/x-plan/render.mjs';

const CLI = join(import.meta.dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

function envelope(overrides = {}) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Ship the matcher',
    requirements: [
      { id: 'R1', text: 'Parse user input into tokens', priority: 'must' },
      { id: 'R2', text: 'Render the summary line', priority: 'must' },
    ],
    assumptions: [],
    decision: { selected: 'Native plan', alternatives: [] },
    tasks: [
      { id: 'A', title: 'Implement the parser', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/parse.mjs'], done_criteria: ['tokens returned'] },
      { id: 'B', title: 'Implement the renderer', depends_on: [], requirement_refs: ['R2'], expected_files: ['src/render.mjs'], done_criteria: ['line rendered'] },
    ],
    steps: [['A', 'B']],
    validation: { commands: ['node --test'], requirement_refs: ['R1', 'R2'] },
    disagreements: [], unresolved_questions: [], provenance: { source: 'native' },
    ...overrides,
  };
}

const REDOS = {
  requirement_ref: 'R1',
  mode: '100k-char adversarial input with nested quantifiers causes catastrophic backtracking',
  mitigation: 'reject input over 10k chars with a validation error instead of matching',
  verification: 'stress test with the pathological string asserts completion under 100ms',
};

describe('PlanEnvelope failure modes', () => {
  test('normalizes to an empty list when the field is absent', () => {
    const plan = normalizePlanEnvelope(envelope());
    expect(plan.failure_modes).toEqual([]);
  });

  test('a legacy envelope without the field stays valid', () => {
    const result = validatePlanEnvelope(envelope());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('an executable plan warns about an unenumerated risk-domain requirement', () => {
    const result = validatePlanEnvelope(envelope());
    const codes = result.warnings.map((item) => item.code);
    expect(codes).toContain('plan.failure_modes_missing');
    // R2 renders a summary line — no risk domain, so it must not be flagged.
    expect(result.warnings.filter((item) => item.message.includes('R2'))).toEqual([]);
  });

  test('enumeration with a prescription clears the warning', () => {
    const result = validatePlanEnvelope(envelope({ failure_modes: [REDOS] }));
    expect(result.valid).toBe(true);
    expect(result.warnings.map((item) => item.code)).not.toContain('plan.failure_modes_missing');
  });

  test('enumeration without a prescription is reported separately', () => {
    const result = validatePlanEnvelope(envelope({ failure_modes: [{ ...REDOS, mitigation: '' }] }));
    expect(result.valid).toBe(true);
    expect(result.warnings.map((item) => item.code)).toContain('failure_mode.no_prescription');
  });

  test('an explicit "none" is accepted as an answer, not silence', () => {
    const result = validatePlanEnvelope(envelope({
      failure_modes: [{ requirement_ref: 'R1', mode: 'none — fixed enum input, no untrusted source', mitigation: '', verification: '' }],
    }));
    expect(result.warnings.map((item) => item.code)).not.toContain('plan.failure_modes_missing');
    expect(result.warnings.map((item) => item.code)).not.toContain('failure_mode.no_prescription');
  });

  test('a failure mode pointing at an unknown requirement is an error', () => {
    const result = validatePlanEnvelope(envelope({ failure_modes: [{ ...REDOS, requirement_ref: 'R9' }] }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain('failure_mode.unknown_requirement');
  });

  test('a non-array field is a type error', () => {
    const result = validatePlanEnvelope(envelope({ failure_modes: 'nope' }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.code)).toContain('plan.field_type');
  });

  test('renders as its own section with prescription and verification', () => {
    const plan = normalizePlanEnvelope(envelope({ failure_modes: [REDOS] }));
    const output = renderPlan(plan);
    expect(output).toContain('## Failure modes');
    expect(output).toContain('[R1]');
    expect(output).toContain('처방: ' + REDOS.mitigation);
    expect(output).toContain('검증: ' + REDOS.verification);
  });

  test('omits the section when nothing is enumerated', () => {
    expect(renderPlan(normalizePlanEnvelope(envelope()))).not.toContain('## Failure modes');
  });
});

describe('import-plan carries failure modes to the executor', () => {
  test('writes PRD section 7.5 and injects stress criteria on the covering task', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'plan-failure-modes-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd });
      const env = { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: join(cwd, '.xm', 'build'), XKIT_SERVER: '0' };
      expect(spawnSync('node', [CLI, 'init', 'demo'], { cwd, env, encoding: 'utf8' }).status).toBe(0);

      const file = join(cwd, 'plan.json');
      writeFileSync(file, JSON.stringify(envelope({ failure_modes: [REDOS] })));
      const result = spawnSync('node', [CLI, 'import-plan', file, '--json'], { cwd, env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);

      const planDir = join(cwd, '.xm', 'build', 'projects', 'demo', 'phases', '02-plan');
      const prd = readFileSync(join(planDir, 'PRD.md'), 'utf8');
      expect(prd).toContain('## 7.5 Failure Modes & Adversarial Inputs');
      expect(prd).toContain(REDOS.mode);
      expect(prd).toContain('처방: ' + REDOS.mitigation);

      const tasks = JSON.parse(readFileSync(join(planDir, 'tasks.json'), 'utf8')).tasks;
      const parser = tasks.find((task) => task.name.includes('parser'));
      const renderer = tasks.find((task) => task.name.includes('renderer'));
      expect(parser.done_criteria.some((line) => line.startsWith('스트레스: '))).toBe(true);
      // R2 has no enumerated mode, so its task must stay untouched.
      expect(renderer.done_criteria.some((line) => line.startsWith('스트레스: '))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a plan with no failure modes produces no 7.5 section', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'plan-failure-modes-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd });
      const env = { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: join(cwd, '.xm', 'build'), XKIT_SERVER: '0' };
      expect(spawnSync('node', [CLI, 'init', 'demo'], { cwd, env, encoding: 'utf8' }).status).toBe(0);

      const file = join(cwd, 'plan.json');
      writeFileSync(file, JSON.stringify(envelope()));
      expect(spawnSync('node', [CLI, 'import-plan', file, '--json'], { cwd, env, encoding: 'utf8' }).status).toBe(0);

      const prd = join(cwd, '.xm', 'build', 'projects', 'demo', 'phases', '02-plan', 'PRD.md');
      expect(existsSync(prd)).toBe(true);
      expect(readFileSync(prd, 'utf8')).not.toContain('7.5 Failure Modes');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
