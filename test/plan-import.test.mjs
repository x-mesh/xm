import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');
function run(cwd, args) {
  const result = spawnSync('node', [CLI, ...args], { cwd, env: { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: undefined, XKIT_SERVER: undefined }, encoding: 'utf8', timeout: 15_000 });
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'xb-import-plan-'));
  spawnSync('git', ['init', '-q'], { cwd }); spawnSync('git', ['config', 'user.email', 'import@example.com'], { cwd }); spawnSync('git', ['config', 'user.name', 'import'], { cwd });
  writeFileSync(join(cwd, 'README.md'), '# fixture\n'); spawnSync('git', ['add', 'README.md'], { cwd }); spawnSync('git', ['commit', '-qm', 'fixture'], { cwd });
  expect(run(cwd, ['init', 'demo']).code).toBe(0); return cwd;
}
function envelope(overrides = {}) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Ship imported plan',
    requirements: [{ id: 'R1', text: 'Add API', priority: 'must' }, { id: 'R2', text: 'Add tests', priority: 'must' }], assumptions: [],
    decision: { selected: 'Native plan', alternatives: [] },
    tasks: [
      { id: 'A', title: 'Implement API', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/api.mjs'], done_criteria: ['API returns expected data'] },
      { id: 'B', title: 'Implement docs', depends_on: [], requirement_refs: ['R1'], expected_files: ['docs/api.md'], done_criteria: ['Docs describe API'] },
      { id: 'C', title: 'Add tests', depends_on: ['A'], requirement_refs: ['R2'], expected_files: ['test/api.test.mjs'], done_criteria: ['node --test passes'] },
    ],
    steps: [['A', 'B'], ['C']], validation: { commands: ['node --test'], requirement_refs: ['R1', 'R2'] }, disagreements: [], unresolved_questions: [], provenance: { source: 'native' }, ...overrides,
  };
}

describe('import-plan execution compiler', () => {
  test('compiles a PlanEnvelope into tasks, DAG, parallel metadata, and an approval-gated Plan phase', () => {
    const cwd = setup();
    try {
      const file = join(cwd, 'plan.json'); writeFileSync(file, JSON.stringify(envelope()));
      const result = run(cwd, ['import-plan', file, '--project', 'demo', '--json']);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toMatchObject({ status: 'imported', tasks: 3, steps: 2, approval_required: true, next_action: 'plan-check', validation_commands_untrusted: true });
      expect(output.parallelism.safe_tasks.sort()).toEqual(['t1', 't2', 't3']);
      expect(output.parallelism.max_step_width).toBe(2);
      expect(output.parallelism).toMatchObject({ parallel_steps: 1, serial_task_units: 3, critical_path_task_units: 2, theoretical_task_speedup: 1.5 });
      const root = join(cwd, '.xm', 'build', 'projects', 'demo');
      const tasks = JSON.parse(readFileSync(join(root, 'phases', '02-plan', 'tasks.json'))).tasks;
      expect(tasks.map((task) => task.depends_on)).toEqual([[], [], ['t1']]);
      expect(tasks.every((task) => task.expected_files.length > 0 && task.done_criteria.length > 0)).toBe(true);
      expect(JSON.parse(readFileSync(join(root, 'manifest.json'))).current_phase).toBe('02-plan');
      expect(JSON.parse(readFileSync(join(root, 'manifest.json'))).build_profile).toBe('standard');
      const state = JSON.parse(readFileSync(join(root, 'phases', '02-plan', 'plan-state.json')));
      expect(state.approved_hash).toBeNull(); expect(state.requested_action).toBe('plan_only');
      expect(existsSync(join(root, 'phases', '02-plan', 'PRD.md'))).toBe(true);
      const checked = run(cwd, ['plan-check', '--project', 'demo', '--json']);
      expect(checked.code, checked.stderr + checked.stdout).toBe(0);
      const premature = run(cwd, ['run', '--project', 'demo', '--json']);
      expect(premature.code).toBe(2);
      expect(premature.stderr).toContain('Cannot execute');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('splits same-step expected-file overlap into separate conflict-free batches', () => {
    const cwd = setup();
    try {
      const plan = envelope(); plan.tasks[1].expected_files = ['src/api.mjs'];
      const file = join(cwd, 'overlap.json'); writeFileSync(file, JSON.stringify(plan));
      const result = run(cwd, ['import-plan', file, '--project', 'demo', '--json']);
      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.parallelism.sequential_tasks).toEqual([]);
      expect(output.parallelism.safe_tasks.sort()).toEqual(['t1', 't2', 't3']);
      expect(output.parallelism.batches[0].parallel_batches).toEqual([['t1'], ['t2']]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('preserves explicit PlanEnvelope step boundaries', () => {
    const cwd = setup();
    try {
      const plan = envelope(); plan.steps = [['A'], ['B'], ['C']];
      const file = join(cwd, 'steps.json'); writeFileSync(file, JSON.stringify(plan));
      const result = run(cwd, ['import-plan', file, '--project', 'demo', '--json']);
      expect(result.code).toBe(0);
      const root = join(cwd, '.xm', 'build', 'projects', 'demo');
      const steps = JSON.parse(readFileSync(join(root, 'phases', '02-plan', 'steps.json'))).steps;
      expect(steps.map((step) => step.tasks)).toEqual([['t1'], ['t2'], ['t3']]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('fails closed before writes when execution metadata is unsafe or incomplete', () => {
    const cwd = setup();
    try {
      const root = join(cwd, '.xm', 'build', 'projects', 'demo');
      const tasksPath = join(root, 'phases', '02-plan', 'tasks.json'); const before = readFileSync(tasksPath, 'utf8');
      const bad = envelope(); bad.tasks[0].expected_files = ['C:\\escape.mjs']; bad.tasks[1].expected_files = [];
      const file = join(cwd, 'bad.json'); writeFileSync(file, JSON.stringify(bad));
      const result = run(cwd, ['import-plan', file, '--project', 'demo', '--json']);
      expect(result.code).toBe(2); expect(JSON.parse(result.stdout).status).toBe('blocked');
      expect(readFileSync(tasksPath, 'utf8')).toBe(before);
      expect(existsSync(join(root, 'phases', '02-plan', 'imported-plan.json'))).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('requires explicit --replace before overwriting existing plan artifacts', () => {
    const cwd = setup();
    try {
      const root = join(cwd, '.xm', 'build', 'projects', 'demo');
      const file = join(cwd, 'plan.json'); writeFileSync(file, JSON.stringify(envelope()));
      writeFileSync(join(root, 'phases', '02-plan', 'PRD.md'), '# existing\n');
      const blocked = run(cwd, ['import-plan', file, '--project', 'demo', '--json']);
      expect(blocked.code).toBe(2); expect(JSON.parse(blocked.stdout).failures[0]).toContain('--replace');
      expect(readFileSync(join(root, 'phases', '02-plan', 'PRD.md'), 'utf8')).toBe('# existing\n');
      const replaced = run(cwd, ['import-plan', file, '--project', 'demo', '--json', '--replace']);
      expect(replaced.code).toBe(0); expect(JSON.parse(replaced.stdout).replaced_existing).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
