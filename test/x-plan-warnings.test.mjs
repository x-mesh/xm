/**
 * Two PlanEnvelope checks that used to pass silently:
 * an assumption nobody verified could ride into an executable plan, and
 * validator warnings were printed only with --json, which the skill does not use.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validatePlanEnvelope } from '../x-plan/lib/x-plan/core.mjs';
import { vacuousTestFilter } from '../x-plan/lib/x-plan/validate.mjs';
import { synthesizePlanCandidates } from '../x-plan/lib/x-plan/synthesize.mjs';

const CLI = join(import.meta.dirname, '..', 'x-plan', 'lib', 'x-plan-cli.mjs');
const run = (args, stdin, cwd) => spawnSync('node', [CLI, ...args], { cwd, input: stdin, encoding: 'utf8' });

function plan(overrides = {}) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Export',
    requirements: [{ id: 'R1', text: 'Export the report', priority: 'must' }], assumptions: [],
    decision: { selected: 'Implement', alternatives: [] },
    tasks: [{ id: 'T1', title: 'Implement export', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/export.mjs'], done_criteria: ['Works'] }],
    steps: [['T1']], validation: { commands: ['bun test'], requirement_refs: [] }, disagreements: [], unresolved_questions: [], provenance: {},
    ...overrides,
  };
}

const assumption = (fields) => ({ id: 'A1', text: 'The worker can reach the store', ...fields });
const codes = (result) => result.warnings.map((item) => item.code);

function session(dir) {
  const evidence = join(dir, 'evidence.json');
  const questions = join(dir, 'questions.json');
  const critique = join(dir, 'critique.json');
  writeFileSync(evidence, JSON.stringify({ schema_version: 1, items: [{ kind: 'path', value: 'src/export.mjs', verified: true }] }));
  writeFileSync(questions, JSON.stringify({ schema_version: 1, items: [] }));
  writeFileSync(critique, JSON.stringify({ schema_version: 1, status: 'passed', findings: [] }));
  return ['--persist', '--mode', 'standard', '--evidence', evidence, '--questions', questions, '--critique', critique];
}

describe('unverified assumptions', () => {
  test.each([
    ['confidence omitted, which defaults to unknown', {}],
    ['unknown with null evidence', { confidence: 'unknown', evidence: null }],
    ['low with null evidence', { confidence: 'low', evidence: null }],
    ['low with blank evidence', { confidence: 'low', evidence: '   ' }],
  ])('the validator warns on %s', (_label, fields) => {
    const result = validatePlanEnvelope(plan({ assumptions: [assumption(fields)] }));
    expect(result.valid).toBe(true);
    expect(codes(result)).toContain('assumption.unverified');
    expect(result.warnings.find((item) => item.code === 'assumption.unverified').message).toContain('A1');
  });

  test.each([
    ['low with evidence', { confidence: 'low', evidence: 'src/store.mjs exports connect()' }],
    ['unknown with evidence', { confidence: 'unknown', evidence: 'README states the store is local' }],
    ['medium without evidence', { confidence: 'medium', evidence: null }],
    ['high without evidence', { confidence: 'high', evidence: null }],
  ])('the validator stays quiet on %s', (_label, fields) => {
    expect(codes(validatePlanEnvelope(plan({ assumptions: [assumption(fields)] })))).not.toContain('assumption.unverified');
  });

  test('a draft held back by an assumption is not also reported as unexplained', () => {
    const result = validatePlanEnvelope(plan({ executable: false, assumptions: [assumption({ confidence: 'low' })] }));
    expect(codes(result)).toContain('assumption.unverified');
    expect(codes(result)).not.toContain('plan.not_executable');
  });

  test('a standard session refuses an executable plan that rests on one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-assumption-'));
    try {
      const refused = run(session(dir), JSON.stringify(plan({ assumptions: [assumption({ confidence: 'unknown', evidence: null })] })), dir);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('executable session is not ready');
      expect(refused.stderr).toContain('A1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a standard session accepts the same plan once the assumption has evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-assumption-'));
    try {
      const accepted = run(session(dir), JSON.stringify(plan({ assumptions: [assumption({ confidence: 'low', evidence: 'src/store.mjs exports connect()' })] })), dir);
      expect(accepted.status, accepted.stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a standard session still saves a non-executable draft that carries one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-assumption-'));
    try {
      const draft = run(session(dir), JSON.stringify(plan({ executable: false, assumptions: [assumption({ confidence: 'low' })] })), dir);
      expect(draft.status, draft.stderr).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('ultra synthesis keeps the candidate and returns a non-executable plan', () => {
    const candidate = plan({ assumptions: [assumption({ confidence: 'unknown', evidence: null })] });
    const out = synthesizePlanCandidates([{ source: 'm1', role: 'architect', ok: true, plan: candidate }]);
    expect(out.ok).toBe(true);
    expect(out.candidates[0].valid).toBe(true);
    expect(out.plan.executable).toBe(false);
    expect(out.warnings.map((item) => item.code)).toContain('assumption.unverified');
  });
});

describe('validator warnings on text output', () => {
  const risky = () => plan({ requirements: [{ id: 'R1', text: 'Parse user input into tokens', priority: 'must' }] });

  test('--validate prints them without --json', () => {
    const result = run(['--validate'], JSON.stringify(risky()));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PlanEnvelope is valid. Executable: yes');
    expect(result.stdout).toContain('[plan.failure_modes_missing]');
  });

  test('--validate prints them for an invalid plan too, after the errors', () => {
    const result = run(['--validate'], JSON.stringify({ ...risky(), out_of_scope: 'CSV export' }));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PlanEnvelope is invalid.');
    expect(result.stdout).toContain('[plan.field_type] out_of_scope');
    expect(result.stdout).toContain('Warnings:\n- [plan.failure_modes_missing]');
    expect(result.stdout.indexOf('Warnings:')).toBeGreaterThan(result.stdout.indexOf('[plan.field_type]'));
  });

  test('--persist prints them after the readable plan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-warnings-'));
    try {
      const result = run(session(dir), JSON.stringify(risky()), dir);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('# Plan: Export');
      expect(result.stdout).toContain('## Warnings');
      expect(result.stdout.indexOf('## Warnings')).toBeGreaterThan(result.stdout.indexOf('## Validation'));
      expect(result.stdout).toContain('[plan.failure_modes_missing]');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a plan without warnings prints no warnings section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-plan-warnings-'));
    try {
      const saved = run(session(dir), JSON.stringify(plan()), dir);
      expect(saved.status, saved.stderr).toBe(0);
      expect(saved.stdout).not.toContain('Warnings');
      const checked = run(['--validate'], JSON.stringify(plan()));
      expect(checked.stdout).toBe('PlanEnvelope is valid. Executable: yes\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('verify commands that pass with no matching test', () => {
  test('flags a cargo test filter and go test -run, and nothing else', () => {
    expect(vacuousTestFilter('cargo test -p packet-mesh calls::body')).toBe('cargo test');
    expect(vacuousTestFilter('cargo test --features ebpf -- calls::body --exact')).toBe('cargo test');
    expect(vacuousTestFilter('cd crates/x && cargo test calls')).toBe('cargo test');
    expect(vacuousTestFilter('go test ./... -run TestFoo')).toBe('go test -run');
    expect(vacuousTestFilter('go test ./... -run=TestFoo')).toBe('go test -run');
    for (const command of ['cargo test -p packet-mesh', 'cargo test --workspace --features ebpf', 'cargo test -- --test-threads 1', 'go test ./...', 'bun test', 'cargo test -p x calls 2>&1 | grep -E "[1-9][0-9]* passed"']) {
      expect(vacuousTestFilter(command)).toBe(null);
    }
  });
  test('warns on task verify_commands and validation.commands', () => {
    const result = validatePlanEnvelope(plan({
      tasks: [{ id: 'T1', title: 'Implement export', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/export.mjs'], done_criteria: ['Works'], verify_commands: ['cargo test -p app export::csv'] }],
      validation: { commands: ['go test ./... -run TestExport'], requirement_refs: [] },
    }));
    expect(result.valid).toBe(true);
    const paths = result.warnings.filter((item) => item.code === 'verify.vacuous_filter').map((item) => item.path);
    expect(paths).toEqual(['tasks[0].verify_commands', 'validation.commands']);
  });
});
