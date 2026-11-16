/**
 * A task may name the commands that observe its own done criteria.
 * The field is optional, and a task without it normalizes to the shape it had
 * before, so progress hashes of stored plans do not change.
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

function envelope(taskFields = {}) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Ship the export',
    requirements: [{ id: 'R1', text: 'Export the report', priority: 'must' }], assumptions: [],
    decision: { selected: 'Native plan', alternatives: [] },
    tasks: [{ id: 'T1', title: 'Implement export', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/export.mjs'], done_criteria: ['report is written'], ...taskFields }],
    steps: [['T1']], validation: { commands: ['node --test'], requirement_refs: ['R1'] },
    disagreements: [], unresolved_questions: [], provenance: {},
  };
}

describe('task verify_commands', () => {
  test('normalization keeps the commands and drops blanks', () => {
    const task = normalizePlanEnvelope(envelope({ verify_commands: [' node --test test/export.test.mjs ', ''] })).tasks[0];
    expect(task.verify_commands).toEqual(['node --test test/export.test.mjs']);
  });

  test.each([
    ['absent', {}],
    ['empty', { verify_commands: [] }],
    ['blank only', { verify_commands: ['  '] }],
  ])('a task with the field %s has no such key', (_label, fields) => {
    const task = normalizePlanEnvelope(envelope(fields)).tasks[0];
    expect(Object.keys(task)).toEqual(['id', 'title', 'depends_on', 'requirement_refs', 'expected_files', 'done_criteria']);
  });

  test('a value that is not a string array is a type error', () => {
    const result = validatePlanEnvelope(envelope({ verify_commands: 'node --test' }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((item) => item.path)).toContain('tasks[0].verify_commands');
  });

  test('the readable plan shows them under the task', () => {
    const withCommands = renderPlan(normalizePlanEnvelope(envelope({ verify_commands: ['node --test test/export.test.mjs'] })));
    expect(withCommands).toContain('  - Verify: node --test test/export.test.mjs');
    expect(renderPlan(normalizePlanEnvelope(envelope()))).not.toContain('Verify:');
  });

  test('ultra synthesis keeps the commands of every candidate that proposes the same task', () => {
    const out = synthesizePlanCandidates([
      { source: 'm1', ok: true, plan: envelope({ verify_commands: ['node --test test/a.test.mjs'] }) },
      { source: 'm2', ok: true, plan: envelope({ verify_commands: ['node --test test/b.test.mjs'] }) },
      { source: 'm3', ok: true, plan: envelope() },
    ]);
    expect(out.ok).toBe(true);
    expect(out.plan.tasks).toHaveLength(1);
    expect(out.plan.tasks[0].verify_commands).toEqual(['node --test test/a.test.mjs', 'node --test test/b.test.mjs']);
  });

  test('import-plan shows the commands to the executor as done criteria', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'plan-task-verify-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd });
      const env = { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: join(cwd, '.xm', 'build'), XKIT_SERVER: '0' };
      expect(spawnSync('node', [BUILD_CLI, 'init', 'demo'], { cwd, env, encoding: 'utf8' }).status).toBe(0);
      const file = join(cwd, 'plan.json');
      writeFileSync(file, JSON.stringify(envelope({ verify_commands: ['node --test test/export.test.mjs'] })));
      const result = spawnSync('node', [BUILD_CLI, 'import-plan', file, '--json'], { cwd, env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      const tasks = JSON.parse(readFileSync(join(cwd, '.xm', 'build', 'projects', 'demo', 'phases', '02-plan', 'tasks.json'), 'utf8')).tasks;
      expect(tasks[0].done_criteria).toEqual(['report is written', '검증 명령: node --test test/export.test.mjs']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
