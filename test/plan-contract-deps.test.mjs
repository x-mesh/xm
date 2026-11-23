/**
 * A task may mark a dependency as contract-only: it is written against an interface the plan
 * fixes, so it can share a step with the producer. The field is optional, and a task without
 * it normalizes to the shape it had before, so progress hashes of stored plans do not change.
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

function envelope({ consumer = {}, steps = [['T1', 'T2']] } = {}) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Ship the export',
    requirements: [{ id: 'R1', text: 'Export the report', priority: 'must' }], assumptions: [],
    decision: { selected: 'Native plan', alternatives: [] },
    tasks: [
      { id: 'T1', title: 'Implement the writer', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/writer.mjs'], done_criteria: ['write(rows) returns the byte count'] },
      { id: 'T2', title: 'Implement the command', depends_on: ['T1'], requirement_refs: ['R1'], expected_files: ['src/command.mjs'], done_criteria: ['the command calls write(rows)'], ...consumer },
    ],
    steps, validation: { commands: ['node --test'], requirement_refs: ['R1'] },
    disagreements: [], unresolved_questions: [], provenance: {},
  };
}
const codes = (plan) => validatePlanEnvelope(plan).errors.map((item) => item.code);

describe('task contract_deps', () => {
  test('normalization keeps the ids sorted and drops blanks', () => {
    const task = normalizePlanEnvelope(envelope({ consumer: { depends_on: ['T1', 'T0'], contract_deps: [' T1 ', '', 'T0'] } })).tasks[1];
    expect(task.contract_deps).toEqual(['T0', 'T1']);
  });

  test.each([
    ['absent', {}],
    ['empty', { contract_deps: [] }],
    ['blank only', { contract_deps: ['  '] }],
  ])('a task with the field %s has no such key', (_label, fields) => {
    const task = normalizePlanEnvelope(envelope({ consumer: fields })).tasks[1];
    expect(Object.keys(task)).toEqual(['id', 'title', 'depends_on', 'requirement_refs', 'expected_files', 'done_criteria']);
  });

  test('the key follows verify_commands, so a task that had only that field keeps its hash', () => {
    const task = normalizePlanEnvelope(envelope({ consumer: { contract_deps: ['T1'], verify_commands: ['node --test test/command.test.mjs'] } })).tasks[1];
    expect(Object.keys(task).slice(-2)).toEqual(['verify_commands', 'contract_deps']);
  });

  test('a contract dependency may share a step with its producer', () => {
    const result = validatePlanEnvelope(envelope({ consumer: { contract_deps: ['T1'] } }));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test('an output dependency in the same step is still rejected', () => {
    expect(codes(envelope())).toContain('steps.dependency_order');
  });

  test('a contract dependency scheduled after its consumer is rejected', () => {
    const result = validatePlanEnvelope(envelope({ consumer: { contract_deps: ['T1'] }, steps: [['T2'], ['T1']] }));
    expect(result.errors).toEqual([{ code: 'steps.dependency_order', path: 'steps', message: 'T1 must be scheduled before T2 or in the same step' }]);
  });

  test('a contract dependency in an earlier step stays valid', () => {
    expect(validatePlanEnvelope(envelope({ consumer: { contract_deps: ['T1'] }, steps: [['T1'], ['T2']] })).valid).toBe(true);
  });

  test('an id that is not in depends_on is rejected', () => {
    const result = validatePlanEnvelope(envelope({ consumer: { depends_on: [], contract_deps: ['T1'] } }));
    expect(result.errors.map((item) => [item.code, item.path])).toEqual([['task.contract_dependency_undeclared', 'tasks[1].contract_deps']]);
  });

  test('a file listed by both tasks is rejected, in any step order', () => {
    const fields = { contract_deps: ['T1'], expected_files: ['src/command.mjs', 'src/writer.mjs'] };
    for (const steps of [[['T1', 'T2']], [['T1'], ['T2']]]) {
      const result = validatePlanEnvelope(envelope({ consumer: fields, steps }));
      expect(result.errors.map((item) => item.code)).toEqual(['task.contract_dependency_shares_file']);
      expect(result.errors[0].message).toContain('src/writer.mjs');
    }
  });

  test('a value that is not a string array is a type error', () => {
    const result = validatePlanEnvelope(envelope({ consumer: { contract_deps: 'T1' }, steps: [['T1'], ['T2']] }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.path)).toContain('tasks[1].contract_deps');
  });

  test('the readable plan shows it under the task', () => {
    const marked = renderPlan(normalizePlanEnvelope(envelope({ consumer: { contract_deps: ['T1'] } })));
    expect(marked).toContain('  - Depends on: T1\n  - Contract only: T1');
    expect(renderPlan(normalizePlanEnvelope(envelope({ steps: [['T1'], ['T2']] })))).not.toContain('Contract only:');
  });

  test('ultra synthesis drops the mark and keeps the dependency', () => {
    const out = synthesizePlanCandidates([
      { source: 'm1', ok: true, plan: envelope({ consumer: { contract_deps: ['T1'] } }) },
      { source: 'm2', ok: true, plan: envelope({ steps: [['T1'], ['T2']] }) },
    ]);
    expect(out.ok, JSON.stringify(out.errors)).toBe(true);
    const consumer = out.plan.tasks.find((task) => task.title === 'Implement the command');
    expect(consumer.depends_on).toHaveLength(1);
    expect('contract_deps' in consumer).toBe(false);
    expect(out.plan.steps).toHaveLength(2);
  });

  // The imported project releases a whole step at once, so the pair must not share one there.
  test.each([
    ['a shared step is split so the dependency comes first', { consumer: { contract_deps: ['T1'] } }, [['t1'], ['t2']]],
    ['a plan without the mark keeps its steps', { steps: [['T1'], ['T2']] }, [['t1'], ['t2']]],
  ])('import-plan: %s', (_label, options, expected) => {
    const cwd = mkdtempSync(join(tmpdir(), 'plan-contract-deps-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd });
      const env = { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: join(cwd, '.xm', 'build'), XKIT_SERVER: '0' };
      expect(spawnSync('node', [BUILD_CLI, 'init', 'demo'], { cwd, env, encoding: 'utf8' }).status).toBe(0);
      const file = join(cwd, 'plan.json');
      writeFileSync(file, JSON.stringify(envelope(options)));
      const result = spawnSync('node', [BUILD_CLI, 'import-plan', file, '--json'], { cwd, env, encoding: 'utf8' });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      const phase = join(cwd, '.xm', 'build', 'projects', 'demo', 'phases', '02-plan');
      expect(JSON.parse(readFileSync(join(phase, 'steps.json'), 'utf8')).steps.map((step) => step.tasks)).toEqual(expected);
      expect(JSON.parse(readFileSync(join(phase, 'tasks.json'), 'utf8')).tasks[1].depends_on).toEqual(['t1']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
