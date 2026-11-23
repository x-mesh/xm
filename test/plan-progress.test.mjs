import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');
const RUN = 'run-1';

function run(cwd, args) {
  const result = spawnSync('node', [CLI, ...args], { cwd, env: { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: undefined, XKIT_SERVER: undefined }, encoding: 'utf8', timeout: 15_000 });
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function runAsync(cwd, args) {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], { cwd, env: { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: undefined, XKIT_SERVER: undefined } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
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
const record = (cwd, task) => JSON.parse(readFileSync(join(cwd, '.xm', 'plan', RUN, 'progress.json'), 'utf8')).tasks[task];
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

  test('a task verify command runs before the plan-wide commands and decides the task', () => {
    const plan = envelope();
    plan.tasks[0].verify_commands = ['test -f src/a.marker'];
    const cwd = setup(plan);
    try {
      const started = progress(cwd, 'start', 'A');
      // A has its own command, so start lists it alone and names the plan-wide ones separately.
      expect(JSON.parse(started.stdout)).toMatchObject({ verify_commands: ['test -f src/a.marker'], plan_commands_when_last: ['true'] });
      writeFileSync(join(cwd, 'src', 'a.txt'), 'a\n');
      const failed = progress(cwd, 'verify', 'A');
      expect(failed.code).toBe(2);
      expect(JSON.parse(failed.stdout)).toMatchObject({ status: 'failed', failed_command: 'test -f src/a.marker' });
      writeFileSync(join(cwd, 'src', 'a.marker'), 'ok\n');
      expect(progress(cwd, 'verify', 'A').code).toBe(0);
      expect(tasksMd(cwd)).toContain('  - Verify: test -f src/a.marker');
      // B declares none, so it still verifies against the plan-wide commands alone.
      const startedB = JSON.parse(progress(cwd, 'start', 'B').stdout);
      expect(startedB.verify_commands).toEqual(['true']);
      expect('plan_commands_when_last' in startedB).toBe(false);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a task without verify commands keeps the hash it had before the field existed', () => {
    const cwd = setup();
    try {
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      const stored = JSON.parse(readFileSync(join(cwd, '.xm', 'plan', RUN, 'progress.json'), 'utf8')).tasks.A.task_hash;
      const before = { id: 'A', title: 'Implement API', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/a.txt'], done_criteria: ['A exists'] };
      expect(stored).toBe(createHash('sha256').update(JSON.stringify(before)).digest('hex'));
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test.each([
    ['a contract dependency started in the same step', (plan) => { plan.tasks[1].contract_deps = ['A']; plan.steps = [['A', 'B']]; }],
    ['an output dependency', () => {}],
  ])('verify refuses a task until its dependency is verified: %s', (_label, mark) => {
    const plan = envelope(); mark(plan);
    const cwd = setup(plan);
    try {
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'a\n');
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const early = progress(cwd, 'verify', 'B');
      expect(early.code).toBe(1);
      expect(early.stderr).toContain('task B depends on A, not verified yet; verify A first');
      expect(statuses(cwd)).toEqual({ A: 'in_progress', B: 'in_progress' });
      expect(progress(cwd, 'verify', 'A').code).toBe(0);
      const late = progress(cwd, 'verify', 'B');
      expect(late.code, late.stderr + late.stdout).toBe(0);
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a dependency that never started blocks the consumer', () => {
    const cwd = setup();
    try {
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const result = progress(cwd, 'verify', 'B');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('task B depends on A, not verified yet');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // For a contract pair the producer's done criteria are the interface, so a record made for
  // an earlier definition of A does not let B through. A itself stays verifiable: start keeps
  // the first baseline of a file, so the finished file still counts as changed.
  test('a dependency revised after its verification blocks the consumer until it is verified again, with no new edit', () => {
    const cwd = setup();
    try {
      expect(verifyA(cwd).code).toBe(0);
      const plan = envelope(); plan.tasks[0].done_criteria = ['A exists and returns the byte count'];
      writeEnvelope(cwd, plan);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const blocked = progress(cwd, 'verify', 'B');
      expect(blocked.code).toBe(1);
      expect(blocked.stderr).toContain('task B depends on A, not verified yet');
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      const again = progress(cwd, 'verify', 'A');
      expect(again.code, again.stderr + again.stdout).toBe(0);
      expect(progress(cwd, 'verify', 'B').code).toBe(0);
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a revision that names another file is not verified until that file changes', () => {
    const cwd = setup();
    try {
      expect(verifyA(cwd).code).toBe(0);
      const plan = envelope(); plan.tasks[0].expected_files = ['src/a2.txt'];
      writeEnvelope(cwd, plan);
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      const refused = progress(cwd, 'verify', 'A');
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('no expected file changed since start of A');
      writeFileSync(join(cwd, 'src', 'a2.txt'), 'a2\n');
      expect(progress(cwd, 'verify', 'A').code).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('start run twice after a revision keeps the first baseline', () => {
    const cwd = setup();
    try {
      expect(verifyA(cwd).code).toBe(0);
      const plan = envelope(); plan.tasks[0].title = 'Implement API v2';
      writeEnvelope(cwd, plan);
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      const result = progress(cwd, 'verify', 'A');
      expect(result.code, result.stderr + result.stdout).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a task that was never worked on is still refused after a second start', () => {
    const cwd = setup();
    try {
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      const result = progress(cwd, 'verify', 'A');
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('no expected file changed since start of A');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a revised dependency that was started again blocks the consumer until it is verified', () => {
    const cwd = setup();
    try {
      expect(verifyA(cwd).code).toBe(0);
      const plan = envelope(); plan.tasks[0].title = 'Implement API v2';
      writeEnvelope(cwd, plan);
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      expect(progress(cwd, 'verify', 'B').code).toBe(1);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'a v2\n');
      expect(progress(cwd, 'verify', 'A').code).toBe(0);
      expect(progress(cwd, 'verify', 'B').code).toBe(0);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a dependency whose file changed after its verification does not block the consumer', () => {
    const cwd = setup();
    try {
      expect(verifyA(cwd).code).toBe(0);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'changed by B\n');
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const result = progress(cwd, 'verify', 'B');
      expect(result.code, result.stderr + result.stdout).toBe(0);
      expect(statuses(cwd)).toEqual({ A: 'changed_after_verification', B: 'verified' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('tasks.md marks a contract dependency', () => {
    const plan = envelope(); plan.tasks[1].contract_deps = ['A']; plan.steps = [['A', 'B']];
    const cwd = setup(plan);
    try {
      expect(progress(cwd, 'show').code).toBe(0);
      expect(tasksMd(cwd)).toContain('  - Depends on: A\n  - Contract only: A');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // The plan-wide commands used to run for every task. A plan whose plan-wide command needs a
  // later task could then never verify its first task, and since a consumer waits for its
  // dependency, it could not verify any task after it either.
  test('a task with its own command is verified before a plan-wide command can pass', () => {
    const plan = envelope({ validation: { commands: ['test -f src/b.txt'], requirement_refs: ['R1'] } });
    plan.tasks[0].verify_commands = ['test -f src/a.txt'];
    const cwd = setup(plan);
    try {
      const first = verifyA(cwd);
      expect(first.code, first.stderr + first.stdout).toBe(0);
      expect(record(cwd, 'A').commands).toEqual(['test -f src/a.txt']);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const second = progress(cwd, 'verify', 'B');
      expect(second.code, second.stderr + second.stdout).toBe(0);
      expect(record(cwd, 'B').commands).toEqual(['test -f src/b.txt']);
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('the last task left is not verified until the plan-wide commands pass', () => {
    const plan = envelope({ validation: { commands: ['test -f src/release.marker'], requirement_refs: ['R1'] } });
    plan.tasks[0].verify_commands = ['test -f src/a.txt'];
    plan.tasks[1].verify_commands = ['test -f src/b.txt'];
    const cwd = setup(plan);
    try {
      expect(verifyA(cwd).code).toBe(0);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const refused = progress(cwd, 'verify', 'B');
      expect(refused.code).toBe(2);
      expect(JSON.parse(refused.stdout)).toMatchObject({ status: 'failed', failed_command: 'test -f src/release.marker', scope: 'plan' });
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'in_progress' });
      writeFileSync(join(cwd, 'src', 'release.marker'), 'ok\n');
      expect(progress(cwd, 'verify', 'B').code).toBe(0);
      expect(record(cwd, 'B').commands).toEqual(['test -f src/b.txt', 'test -f src/release.marker']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a failed command of the task itself is reported as such', () => {
    const plan = envelope();
    plan.tasks[0].verify_commands = ['test -f src/a.marker'];
    const cwd = setup(plan);
    try {
      const failed = verifyA(cwd);
      expect(failed.code).toBe(2);
      expect(JSON.parse(failed.stdout)).toMatchObject({ status: 'failed', failed_command: 'test -f src/a.marker', scope: 'task' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // A task with no command of its own is still decided by the plan-wide commands at its own
  // position. When one of them needs a later task, only the plan can fix that, so the error says it.
  test('a task with no command of its own says that the plan-wide command decided it', () => {
    const cwd = setup(envelope({ validation: { commands: ['test -f src/b.txt'], requirement_refs: ['R1'] } }));
    try {
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'a\n');
      const json = progress(cwd, 'verify', 'A');
      expect(json.code).toBe(2);
      expect(JSON.parse(json.stdout)).toMatchObject({ status: 'failed', failed_command: 'test -f src/b.txt', scope: 'plan' });
      const text = run(cwd, ['progress', 'verify', '--plan', RUN, '--task', 'A']);
      expect(text.code).toBe(2);
      expect(text.stderr).toContain('plan-wide command `test -f src/b.txt`');
      expect(text.stderr).toContain('A has no verify_commands of its own');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // Each process sees the other task as not verified while its own command runs. If "last" were
  // decided then, both would skip the plan-wide commands and the plan would be complete with
  // those commands never run. It is decided under the lock of progress.json, when the record is written.
  test('two tasks verified at the same time cannot both skip the plan-wide commands', async () => {
    const plan = envelope({ validation: { commands: ['exit 3'], requirement_refs: ['R1'] }, steps: [['A', 'B']] });
    plan.tasks[0].verify_commands = ['sleep 1'];
    plan.tasks[1].verify_commands = ['sleep 1'];
    plan.tasks[1].depends_on = [];
    const cwd = setup(plan);
    try {
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'a\n');
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const results = await Promise.all(['A', 'B'].map((task) => runAsync(cwd, ['progress', 'verify', '--plan', RUN, '--task', task, '--json'])));
      expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
      expect(Object.values(statuses(cwd)).sort()).toEqual(['in_progress', 'verified']);
      const failed = results.find((result) => result.code === 2);
      expect(JSON.parse(failed.stdout)).toMatchObject({ status: 'failed', failed_command: 'exit 3', scope: 'plan' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 20_000);

  test('a plan with one task runs its own command and the plan-wide commands', () => {
    const plan = envelope({ steps: [['A']] });
    plan.tasks = [{ ...plan.tasks[0], verify_commands: ['test -f src/a.txt'] }];
    const cwd = setup(plan);
    try {
      expect(verifyA(cwd).code).toBe(0);
      expect(record(cwd, 'A').commands).toEqual(['test -f src/a.txt', 'true']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a task verified again after a revision runs the plan-wide commands when it is the last one left', () => {
    const plan = envelope();
    plan.tasks[0].verify_commands = ['test -f src/a.txt'];
    const cwd = setup(plan);
    try {
      expect(verifyA(cwd).code).toBe(0);
      expect(record(cwd, 'A').commands).toEqual(['test -f src/a.txt']);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      expect(progress(cwd, 'verify', 'B').code).toBe(0);
      const revised = envelope(); revised.tasks[0].verify_commands = ['test -f src/a.txt']; revised.tasks[0].title = 'Implement API v2';
      writeEnvelope(cwd, revised);
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      expect(progress(cwd, 'verify', 'A').code).toBe(0);
      expect(record(cwd, 'A').commands).toEqual(['test -f src/a.txt', 'true']);
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
