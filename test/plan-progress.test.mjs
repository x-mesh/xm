import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');
const RUN = 'run-1';

function run(cwd, args) {
  const result = spawnSync('node', [CLI, ...args], { cwd, env: { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: undefined, XKIT_SERVER: undefined }, encoding: 'utf8', timeout: 15_000 });
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function envelope(overrides = {}) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Ship progress',
    requirements: [{ id: 'R1', text: 'Add API', priority: 'must' }], assumptions: [],
    decision: { selected: 'Native plan', alternatives: [] },
    tasks: [
      { id: 'A', title: 'Implement API', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/a.txt'], done_criteria: ['A exists'] },
      { id: 'B', title: 'Implement docs', depends_on: ['A'], requirement_refs: ['R1'], expected_files: ['src/b.txt'], done_criteria: ['B exists'] },
    ],
    steps: [['A'], ['B']], validation: { commands: ['true'], requirement_refs: ['R1'] }, disagreements: [], unresolved_questions: [], provenance: {}, ...overrides,
  };
}
function setup(plan = envelope()) {
  const cwd = mkdtempSync(join(tmpdir(), 'xb-progress-'));
  spawnSync('git', ['init', '-q'], { cwd }); spawnSync('git', ['config', 'user.email', 'p@example.com'], { cwd }); spawnSync('git', ['config', 'user.name', 'p'], { cwd });
  writeFileSync(join(cwd, 'README.md'), '# fixture\n'); spawnSync('git', ['add', 'README.md'], { cwd }); spawnSync('git', ['commit', '-qm', 'fixture'], { cwd });
  writeEnvelope(cwd, plan);
  mkdirSync(join(cwd, 'src'), { recursive: true });
  return cwd;
}
function writeEnvelope(cwd, plan) {
  const dir = join(cwd, '.xm', 'plan', RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'envelope.json'), JSON.stringify(plan));
}
const tasksMd = (cwd) => readFileSync(join(cwd, '.xm', 'plan', RUN, 'tasks.md'), 'utf8');
const progress = (cwd, sub, task) => run(cwd, ['progress', sub, '--plan', RUN, ...(task ? ['--task', task] : []), '--json']);
function verifyA(cwd) {
  expect(progress(cwd, 'start', 'A').code).toBe(0);
  writeFileSync(join(cwd, 'src', 'a.txt'), 'a\n');
  return progress(cwd, 'verify', 'A');
}
const statuses = (cwd) => Object.fromEntries(JSON.parse(progress(cwd, 'show').stdout).tasks.map((t) => [t.id, t.status]));

describe('xm build progress', () => {
  test('start, edit, verify with a passing command checks the task', () => {
    const cwd = setup();
    try {
      const result = verifyA(cwd);
      expect(result.code, result.stderr + result.stdout).toBe(0);
      const md = tasksMd(cwd);
      expect(md).toContain('- [x] A Implement API');
      expect(md).toContain('- [ ] B Implement docs');
      expect(md).toContain('1/2 verified');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('failing validation command exits 2 and leaves the task unchecked', () => {
    const cwd = setup(envelope({ validation: { commands: ['true', 'exit 3'], requirement_refs: ['R1'] } }));
    try {
      const result = verifyA(cwd);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: 'failed', failed_command: 'exit 3', exit_code: 3 });
      expect(tasksMd(cwd)).toContain('- [ ] A Implement API');
      expect(statuses(cwd).A).toBe('in_progress');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('verify without any expected file change is rejected', () => {
    const cwd = setup();
    try {
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      const result = progress(cwd, 'verify', 'A');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('no expected file changed');
      expect(statuses(cwd).A).toBe('in_progress');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('revising a task resets only that task', () => {
    const cwd = setup();
    try {
      expect(verifyA(cwd).code).toBe(0);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      expect(progress(cwd, 'verify', 'B').code).toBe(0);
      const plan = envelope(); plan.tasks[0].title = 'Implement API v2';
      writeEnvelope(cwd, plan);
      expect(statuses(cwd)).toEqual({ A: 'reset', B: 'verified' });
      expect(tasksMd(cwd)).toContain('- [ ] A Implement API v2');
      expect(progress(cwd, 'verify', 'A').code).toBe(1);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('modifying a file after verification reports changed_after_verification', () => {
    const cwd = setup();
    try {
      expect(verifyA(cwd).code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'changed\n');
      expect(statuses(cwd).A).toBe('changed_after_verification');
      expect(tasksMd(cwd)).toContain('- [ ] A Implement API');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('rejects non-executable plans and unsafe run ids', () => {
    const cwd = setup(envelope({ executable: false }));
    try {
      const notExecutable = progress(cwd, 'start', 'A');
      expect(notExecutable.code).toBe(1);
      expect(notExecutable.stderr).toContain('not executable');
      const badId = run(cwd, ['progress', 'start', '--plan', '../x', '--task', 'A']);
      expect(badId.code).toBe(1);
      expect(badId.stderr).toContain('invalid');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
