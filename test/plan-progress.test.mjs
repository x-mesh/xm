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

  // A has no command of its own and B is still open, so a failed plan-wide command defers A
  // instead of failing it. B is the last task: nothing later can make the command pass.
  test('a failing plan-wide command defers a task while another is open, and fails the last one', () => {
    const cwd = setup(envelope({ validation: { commands: ['true', 'exit 3'], requirement_refs: ['R1'] } }));
    try {
      const deferred = verifyA(cwd);
      expect(deferred.code, deferred.stderr + deferred.stdout).toBe(0);
      expect(JSON.parse(deferred.stdout)).toMatchObject({ status: 'deferred', task: 'A', reason: 'plan_command_failed', failed_command: 'exit 3', exit_code: 3 });
      expect(tasksMd(cwd)).toContain('- [ ] A Implement API  [R1]  (deferred)');
      expect(tasksMd(cwd)).toContain('0/2 verified');
      expect(statuses(cwd).A).toBe('deferred');
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const last = progress(cwd, 'verify', 'B');
      expect(last.code).toBe(2);
      expect(JSON.parse(last.stdout)).toMatchObject({ status: 'failed', failed_command: 'exit 3', exit_code: 3, scope: 'plan' });
      expect(statuses(cwd)).toEqual({ A: 'deferred', B: 'in_progress' });
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

  // A task with no command of its own is decided by the plan-wide commands at its own position.
  // When one of them needs a later task, the task waits as deferred and is checked off with
  // the task whose verification makes the plan-wide commands pass.
  test('a task with no command of its own waits for a plan-wide command that needs a later task', () => {
    const cwd = setup(envelope({ validation: { commands: ['test -f src/b.txt'], requirement_refs: ['R1'] } }));
    try {
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'a\n');
      const text = run(cwd, ['progress', 'verify', '--plan', RUN, '--task', 'A']);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain('Deferred A Implement API');
      expect(text.stdout).toContain('plan-wide command `test -f src/b.txt` exited with 1');
      expect(text.stdout).toContain('A has no verify_commands of its own');
      expect(statuses(cwd)).toEqual({ A: 'deferred', B: 'pending' });
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const closed = progress(cwd, 'verify', 'B');
      expect(closed.code, closed.stderr + closed.stdout).toBe(0);
      expect(JSON.parse(closed.stdout)).toMatchObject({ status: 'verified', task: 'B', promoted: ['A'] });
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified' });
      expect(record(cwd, 'A')).toMatchObject({ state: 'verified', verified_with: 'B', commands: ['test -f src/b.txt'] });
      expect(tasksMd(cwd)).toContain('2/2 verified');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // The shape of the plan that exposed this: the first task has its own command, the second has
  // none and a plan-wide command needs the third.
  test('a plan whose plan-wide command needs the last task verifies to the end', () => {
    const plan = envelope({ validation: { commands: ['test -f src/c.txt'], requirement_refs: ['R1'] }, steps: [['A'], ['B'], ['C']] });
    plan.tasks[0].verify_commands = ['test -f src/a.txt'];
    plan.tasks.push({ id: 'C', title: 'Implement demo', depends_on: ['A', 'B'], requirement_refs: ['R1'], expected_files: ['src/c.txt'], done_criteria: ['C exists'], verify_commands: ['test -f src/c.txt'] });
    const cwd = setup(plan);
    try {
      expect(verifyA(cwd).code).toBe(0);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      expect(JSON.parse(progress(cwd, 'verify', 'B').stdout)).toMatchObject({ status: 'deferred', reason: 'plan_command_failed' });
      expect(progress(cwd, 'start', 'C').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'c.txt'), 'c\n');
      const last = progress(cwd, 'verify', 'C');
      expect(last.code, last.stderr + last.stdout).toBe(0);
      expect(JSON.parse(last.stdout)).toMatchObject({ status: 'verified', promoted: ['B'] });
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified', C: 'verified' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // A consumer is not checked off before its producer. When the producer is deferred, the
  // consumer's own commands can pass, and it then waits with the producer.
  test('a task whose dependency is deferred is deferred too, and both are checked off together', () => {
    const plan = envelope({ validation: { commands: ['test -f src/c.txt'], requirement_refs: ['R1'] }, steps: [['A'], ['B'], ['C']] });
    plan.tasks[1].verify_commands = ['test -f src/b.txt'];
    plan.tasks.push({ id: 'C', title: 'Implement demo', depends_on: ['B'], requirement_refs: ['R1'], expected_files: ['src/c.txt'], done_criteria: ['C exists'] });
    const cwd = setup(plan);
    try {
      expect(JSON.parse(verifyA(cwd).stdout)).toMatchObject({ status: 'deferred', reason: 'plan_command_failed' });
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const consumer = progress(cwd, 'verify', 'B');
      expect(consumer.code).toBe(0);
      expect(JSON.parse(consumer.stdout)).toMatchObject({ status: 'deferred', reason: 'dependency_not_verified', waiting_for: ['A'] });
      expect(statuses(cwd)).toEqual({ A: 'deferred', B: 'deferred', C: 'pending' });
      expect(progress(cwd, 'start', 'C').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'c.txt'), 'c\n');
      const last = progress(cwd, 'verify', 'C');
      expect(last.code, last.stderr + last.stdout).toBe(0);
      expect(JSON.parse(last.stdout).promoted.sort()).toEqual(['A', 'B']);
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified', C: 'verified' });
      expect(record(cwd, 'B').commands).toEqual(['test -f src/b.txt', 'test -f src/c.txt']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // When the plan-wide commands pass, a deferred task is checked off only if the tasks it
  // depends on are checked off. A dependency can have been started again or revised since.
  test.each([
    ['started again', (cwd) => { expect(progress(cwd, 'start', 'A').code).toBe(0); }, 'in_progress'],
    ['revised', (cwd, plan) => { plan.tasks[0].done_criteria = ['A exists and is documented']; writeEnvelope(cwd, plan); }, 'reset'],
  ])('a deferred consumer is not checked off while its dependency was %s', (_label, disturb, stateOfA) => {
    const plan = envelope({ validation: { commands: ['test -f src/c.txt'], requirement_refs: ['R1'] }, steps: [['A'], ['B'], ['C']] });
    plan.tasks[1].verify_commands = ['test -f src/b.txt'];
    plan.tasks.push({ id: 'C', title: 'Implement demo', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/c.txt'], done_criteria: ['C exists'] });
    const cwd = setup(plan);
    try {
      expect(JSON.parse(verifyA(cwd).stdout)).toMatchObject({ status: 'deferred' });
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      expect(JSON.parse(progress(cwd, 'verify', 'B').stdout)).toMatchObject({ status: 'deferred', waiting_for: ['A'] });
      disturb(cwd, plan);
      expect(progress(cwd, 'start', 'C').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'c.txt'), 'c\n');
      const third = progress(cwd, 'verify', 'C');
      expect(third.code, third.stderr + third.stdout).toBe(0);
      const verified = JSON.parse(third.stdout);
      expect(verified.status).toBe('verified');
      expect('promoted' in verified).toBe(false);
      expect(statuses(cwd)).toEqual({ A: stateOfA, B: 'deferred', C: 'verified' });
      // A is checked off again, and B follows it in the same write.
      if (stateOfA === 'reset') expect(progress(cwd, 'start', 'A').code).toBe(0);
      const again = progress(cwd, 'verify', 'A');
      expect(again.code, again.stderr + again.stdout).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ status: 'verified', task: 'A', promoted: ['B'] });
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified', C: 'verified' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // A deferred task passed its own checks some time ago. When the plan-wide commands pass, it
  // is checked off only if those checks still hold: its own commands run again, and an expected
  // file still differs from the start.
  test.each([
    ['its own command fails now', (cwd) => { writeFileSync(join(cwd, 'src', 'b.txt'), 'broken\n'); }, { reason: 'own_command_failed', failed_command: 'grep -q ^b$ src/b.txt' }],
    ['its file is back to the start', (cwd) => { rmSync(join(cwd, 'src', 'b.txt')); }, { reason: 'own_command_failed' }],
  ])('a deferred task is not checked off when %s', (_label, disturb, expected) => {
    const plan = envelope({ validation: { commands: ['test -f src/c.txt'], requirement_refs: ['R1'] }, steps: [['A'], ['B'], ['C']] });
    plan.tasks[1].verify_commands = ['grep -q ^b$ src/b.txt'];
    plan.tasks.push({ id: 'C', title: 'Implement demo', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/c.txt'], done_criteria: ['C exists'] });
    const cwd = setup(plan);
    try {
      expect(JSON.parse(verifyA(cwd).stdout)).toMatchObject({ status: 'deferred' });
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      expect(JSON.parse(progress(cwd, 'verify', 'B').stdout)).toMatchObject({ status: 'deferred', reason: 'dependency_not_verified' });
      disturb(cwd);
      expect(progress(cwd, 'start', 'C').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'c.txt'), 'c\n');
      const third = progress(cwd, 'verify', 'C');
      expect(third.code, third.stderr + third.stdout).toBe(0);
      const verified = JSON.parse(third.stdout);
      expect(verified).toMatchObject({ status: 'verified', promoted: ['A'] });
      expect(verified.still_deferred).toEqual([expect.objectContaining({ task: 'B', ...expected })]);
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'deferred', C: 'verified' });
      expect(tasksMd(cwd)).toContain('2/3 verified');
      // Once B is right again, its own verification checks it off.
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const again = progress(cwd, 'verify', 'B');
      expect(again.code, again.stderr + again.stdout).toBe(0);
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified', C: 'verified' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('a deferred task with no command of its own is not checked off when its file is back to the start', () => {
    const plan = envelope({ validation: { commands: ['test -f src/c.txt'], requirement_refs: ['R1'] }, steps: [['A'], ['C']] });
    plan.tasks[1] = { id: 'C', title: 'Implement demo', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/c.txt'], done_criteria: ['C exists'] };
    const cwd = setup(plan);
    try {
      expect(JSON.parse(verifyA(cwd).stdout)).toMatchObject({ status: 'deferred' });
      rmSync(join(cwd, 'src', 'a.txt'));
      expect(progress(cwd, 'start', 'C').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'c.txt'), 'c\n');
      const second = progress(cwd, 'verify', 'C');
      expect(second.code, second.stderr + second.stdout).toBe(0);
      const verified = JSON.parse(second.stdout);
      expect('promoted' in verified).toBe(false);
      expect(verified.still_deferred).toEqual([{ task: 'A', reason: 'no_file_change' }]);
      expect(statuses(cwd)).toEqual({ A: 'deferred', C: 'verified' });
      const text = run(cwd, ['progress', 'show', '--plan', RUN]);
      expect(text.stdout).toContain('1/2 verified');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // Each sees the other task as open while the plan-wide command runs. The first to reach the
  // lock is deferred. The second then finds no open task, so it fails instead of being
  // deferred too: the plan cannot end with every task waiting and none checked off.
  test('of two tasks that fail the plan-wide commands at the same time, one is deferred and the other fails', async () => {
    const plan = envelope({ validation: { commands: ['sleep 1; test -f src/release.marker'], requirement_refs: ['R1'] }, steps: [['A', 'B']] });
    plan.tasks[1].depends_on = [];
    const cwd = setup(plan);
    try {
      expect(progress(cwd, 'start', 'A').code).toBe(0);
      expect(progress(cwd, 'start', 'B').code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'a\n');
      writeFileSync(join(cwd, 'src', 'b.txt'), 'b\n');
      const tasks = ['A', 'B'];
      const results = await Promise.all(tasks.map((task) => runAsync(cwd, ['progress', 'verify', '--plan', RUN, '--task', task, '--json'])));
      expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
      const failedTask = tasks[results.findIndex((result) => result.code === 2)];
      const deferredTask = tasks.find((task) => task !== failedTask);
      expect(statuses(cwd)).toEqual({ [deferredTask]: 'deferred', [failedTask]: 'in_progress' });
      expect(tasksMd(cwd)).toContain('0/2 verified');
      writeFileSync(join(cwd, 'src', 'release.marker'), 'ok\n');
      const closed = progress(cwd, 'verify', failedTask);
      expect(closed.code, closed.stderr + closed.stdout).toBe(0);
      expect(JSON.parse(closed.stdout)).toMatchObject({ status: 'verified', promoted: [deferredTask] });
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'verified' });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }, 30_000);

  test('a deferred task can be verified again, and is checked off when the plan-wide commands pass', () => {
    const cwd = setup(envelope({ validation: { commands: ['test -f src/release.marker'], requirement_refs: ['R1'] } }));
    try {
      expect(JSON.parse(verifyA(cwd).stdout)).toMatchObject({ status: 'deferred' });
      writeFileSync(join(cwd, 'src', 'release.marker'), 'ok\n');
      const again = progress(cwd, 'verify', 'A');
      expect(again.code, again.stderr + again.stdout).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ status: 'verified', task: 'A' });
      expect(statuses(cwd)).toEqual({ A: 'verified', B: 'pending' });
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

describe('plan execution context', () => {
  test('execution.command_timeout_seconds sets the limit of each verify command', () => {
    const cwd = setup(envelope({ execution: { command_timeout_seconds: 1 }, validation: { commands: ['sleep 5'], requirement_refs: ['R1'] }, tasks: [envelope().tasks[0]], steps: [['A']] }));
    try {
      const started = Date.now();
      const result = verifyA(cwd);
      expect(result.code).toBe(2);
      expect(Date.now() - started).toBeLessThan(4500);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('execution.notes is written at the top of tasks.md', () => {
    const cwd = setup(envelope({ execution: { notes: 'Build on the Linux host; merge lanes in task order.' } }));
    try {
      expect(progress(cwd, 'show').code).toBe(0);
      expect(tasksMd(cwd)).toContain('Execution: Build on the Linux host; merge lanes in task order.');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('adding execution to a plan does not reset the progress of its tasks', () => {
    const cwd = setup();
    try {
      expect(verifyA(cwd).code).toBe(0);
      writeEnvelope(cwd, envelope({ execution: { notes: 'n', command_timeout_seconds: 600 } }));
      expect(statuses(cwd).A).toBe('verified');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
