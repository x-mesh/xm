import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');
const RUN = 'run-1';
const TIMEOUT = 60_000;

// A stand-in for git-kit that implements the four subcommands lane mode uses with raw git and
// prints the agent envelope. FAKE_GK_PRECHECK makes merge report a conflict without starting,
// as the real git-kit precheck does.
const FAKE_GK = `
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_GK_LOG, JSON.stringify(argv) + '\\n');
const args = argv.filter((arg) => !['--json', '--yes', '--no-ai'].includes(arg));
const git = (...rest) => spawnSync('git', rest, { encoding: 'utf8' });
const emit = (value, code = 0) => { process.stdout.write(JSON.stringify({ schema: 1, ok: value.state === 'ok', ...value }) + '\\n'); process.exit(code); };
const error = (code, message, exit = 1) => emit({ state: 'error', error: { code, message } }, exit);
const mergeHead = () => git('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
if (args[0] === 'worktree' && args[1] === 'acquire') {
  const branch = args[2];
  const base = args[args.indexOf('--from') + 1];
  for (const block of git('worktree', 'list', '--porcelain').stdout.split('\\n\\n')) {
    const lines = block.split('\\n');
    if (lines.includes('branch refs/heads/' + branch)) emit({ state: 'ok', result: { path: lines[0].slice('worktree '.length), branch, reused: true } });
  }
  const path = join(process.env.FAKE_GK_WORKTREES, branch.replaceAll('/', '-'));
  const exists = git('rev-parse', '-q', '--verify', 'refs/heads/' + branch).status === 0;
  const added = exists ? git('worktree', 'add', path, branch) : git('worktree', 'add', '-b', branch, path, base);
  if (added.status !== 0) error('acquire', added.stderr);
  emit({ state: 'ok', result: { path, branch } });
}
if (args[0] === 'commit') {
  const message = args[args.indexOf('-m') + 1];
  const files = args.slice(args.indexOf('--') + 1);
  const added = git('add', '--', ...files);
  if (added.status !== 0) error('commit', added.stderr);
  const made = git('commit', '-q', '-m', message, '--', ...files);
  if (made.status !== 0) error('commit', made.stderr + made.stdout);
  emit({ state: 'ok', result: { commits: [{ message, files }] } });
}
if (args[0] === 'merge') {
  const branch = args[1];
  if (process.env.FAKE_GK_PRECHECK && git('merge-tree', '--write-tree', 'HEAD', branch).status !== 0) error('conflict', 'merge not started, HEAD unchanged: precheck found a conflict merging ' + branch);
  const merged = git('merge', '--no-ff', '--no-commit', branch);
  if (merged.status !== 0) {
    if (mergeHead()) emit({ state: 'paused', error: { code: 'conflict', message: merged.stdout + merged.stderr } }, 3);
    error('merge_failed', merged.stderr);
  }
  emit({ state: 'ok', result: { merged: branch } });
}
if (args[0] === 'abort') {
  if (!mergeHead()) error('in-progress-op', 'no rebase/merge/cherry-pick in progress');
  const aborted = git('merge', '--abort');
  if (aborted.status !== 0) error('abort', aborted.stderr);
  // The real git-kit prints nothing when abort succeeds.
  process.exit(0);
}
error('unsupported', argv.join(' '), 2);
`;

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + result.stderr);
  return result.stdout.trim();
}

function envelope({ lanes = true, aVerify = ['test -f src/a.txt'] } = {}) {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Ship lanes',
    requirements: [{ id: 'R1', text: 'Lanes', priority: 'must' }], assumptions: [],
    decision: { selected: 'Lanes', alternatives: [] },
    tasks: [
      { id: 'P', title: 'Prepare', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/p.txt'], done_criteria: ['P exists'], verify_commands: ['test -f src/p.txt'] },
      { id: 'A', title: 'Lane A', depends_on: ['P'], requirement_refs: ['R1'], expected_files: ['src/a.txt'], done_criteria: ['A exists'], verify_commands: aVerify },
      { id: 'B', title: 'Lane B', depends_on: ['P'], requirement_refs: ['R1'], expected_files: ['src/b.txt'], done_criteria: ['B exists'], verify_commands: ['test -f src/b.txt'] },
    ],
    steps: [['P'], ['A', 'B']], validation: { commands: ['true'], requirement_refs: ['R1'] },
    ...(lanes ? { execution: { lanes: true } } : {}),
    disagreements: [], unresolved_questions: [], provenance: {},
  };
}

function setup(plan = envelope()) {
  const aux = realpathSync(mkdtempSync(join(tmpdir(), 'xb-lanes-aux-')));
  const cwd = join(aux, 'repo');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'l@example.com');
  git(cwd, 'config', 'user.name', 'l');
  writeFileSync(join(cwd, 'README.md'), '# fixture\n');
  git(cwd, 'add', 'README.md');
  git(cwd, 'commit', '-qm', 'fixture');
  const dir = join(cwd, '.xm', 'plan', RUN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'envelope.json'), JSON.stringify(plan));
  writeFileSync(join(aux, 'fake-gk.mjs'), FAKE_GK);
  mkdirSync(join(aux, 'worktrees'));
  return { cwd, aux, env: { X_BUILD_GK_ARGV: JSON.stringify(['node', join(aux, 'fake-gk.mjs')]), FAKE_GK_WORKTREES: join(aux, 'worktrees'), FAKE_GK_LOG: join(aux, 'gk.log') } };
}

function cli(ctx, args, env = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd: ctx.cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, XM_ROOT: join(ctx.cwd, '.xm'), X_BUILD_ROOT: undefined, XKIT_SERVER: undefined, ...ctx.env, ...env },
  });
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}
const progress = (ctx, sub, task, env) => cli(ctx, ['progress', sub, '--plan', RUN, ...(task ? ['--task', task] : []), '--json'], env);
const json = (result) => JSON.parse(result.stdout);
const progressFile = (ctx) => JSON.parse(readFileSync(join(ctx.cwd, '.xm', 'plan', RUN, 'progress.json'), 'utf8'));
const statuses = (ctx) => Object.fromEntries(json(progress(ctx, 'show')).tasks.map((t) => [t.id, t.status]));
const gkCalls = (ctx) => (existsSync(ctx.env.FAKE_GK_LOG) ? readFileSync(ctx.env.FAKE_GK_LOG, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const hasMergeHead = (cwd) => spawnSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd }).status === 0;
const cleanup = (ctx) => rmSync(ctx.aux, { recursive: true, force: true });

// Step 1 done and committed in the root, so lanes can branch from HEAD.
function finishP(ctx) {
  expect(progress(ctx, 'start', 'P').code).toBe(0);
  writeFileSync(join(ctx.cwd, 'src', 'p.txt'), 'p\n');
  const verified = progress(ctx, 'verify', 'P');
  expect(verified.code, verified.stderr + verified.stdout).toBe(0);
  git(ctx.cwd, 'add', 'src/p.txt');
  git(ctx.cwd, 'commit', '-qm', 'P');
}

function startLane(ctx, id) {
  const started = progress(ctx, 'start', id);
  expect(started.code, started.stderr + started.stdout).toBe(0);
  return json(started).lane_path;
}

function laneVerified(ctx, id, content = id + '\n') {
  const path = startLane(ctx, id);
  writeFileSync(join(path, 'src', id.toLowerCase() + '.txt'), content);
  const verified = progress(ctx, 'verify', id);
  expect(verified.code, verified.stderr + verified.stdout).toBe(0);
  expect(json(verified).status).toBe('lane_verified');
  return path;
}

describe('xm build progress lanes', () => {
  test('two lanes of one step branch from the same base', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      const head = git(ctx.cwd, 'rev-parse', 'HEAD');
      const started = progress(ctx, 'start', 'A');
      expect(started.code, started.stderr).toBe(0);
      const a = json(started);
      expect(a).toMatchObject({ status: 'started', task: 'A', lane_branch: 'xm-lane/' + RUN + '/A', base: head });
      expect(existsSync(join(a.lane_path, 'src', 'p.txt'))).toBe(true);
      // The root moves on before B starts; B still branches from the step base.
      writeFileSync(join(ctx.cwd, 'NOTES.md'), 'n\n');
      git(ctx.cwd, 'add', 'NOTES.md');
      git(ctx.cwd, 'commit', '-qm', 'notes');
      const b = json(progress(ctx, 'start', 'B'));
      expect(b.base).toBe(head);
      expect(git(b.lane_path, 'rev-parse', 'HEAD')).toBe(head);
      const data = progressFile(ctx);
      expect(data.step_bases['1']).toBe(head);
      expect(data.tasks.A.lane).toEqual({ branch: 'xm-lane/' + RUN + '/A', path: a.lane_path, base: head });
      expect(data.tasks.A.baseline_head).toBe(head);
      // Starting again reuses the lane and keeps the first baseline.
      writeFileSync(join(a.lane_path, 'src', 'a.txt'), 'a\n');
      const again = json(progress(ctx, 'start', 'A'));
      expect(again.lane_path).toBe(a.lane_path);
      expect(progressFile(ctx).tasks.A.baseline_files['src/a.txt']).toBeNull();
      expect(statuses(ctx)).toEqual({ P: 'verified', A: 'in_progress', B: 'in_progress' });
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('start refuses an unverified earlier step, a dirty root, and a tracked .xm', () => {
    const ctx = setup();
    try {
      const early = progress(ctx, 'start', 'A');
      expect(early.code).toBe(1);
      expect(early.stderr).toContain('P of an earlier step is not verified');
      finishP(ctx);
      writeFileSync(join(ctx.cwd, 'README.md'), 'changed\n');
      const dirty = progress(ctx, 'start', 'A');
      expect(dirty.code).toBe(1);
      expect(dirty.stderr).toContain('uncommitted changes to README.md');
      git(ctx.cwd, 'checkout', '--', 'README.md');
      git(ctx.cwd, 'add', '-f', '.xm/plan/' + RUN + '/envelope.json');
      git(ctx.cwd, 'commit', '-qm', 'track xm');
      const tracked = progress(ctx, 'start', 'A');
      expect(tracked.code).toBe(1);
      expect(tracked.stderr).toContain('.xm/ is tracked by git');
      expect(gkCalls(ctx)).toEqual([]);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('verify in the lane gives lane_verified and runs the command in the lane', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      const path = startLane(ctx, 'A');
      // The root has no src/a.txt, so the command passes only when it runs in the lane.
      writeFileSync(join(path, 'src', 'a.txt'), 'a\n');
      const verified = progress(ctx, 'verify', 'A');
      expect(verified.code, verified.stderr).toBe(0);
      expect(json(verified)).toMatchObject({ status: 'lane_verified', lane_path: path });
      expect(statuses(ctx).A).toBe('lane_verified');
      expect(readFileSync(join(ctx.cwd, '.xm', 'plan', RUN, 'tasks.md'), 'utf8')).toContain('- [ ] A Lane A  [R1]  (lane_verified)');
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('merging lane A then lane B verifies both and removes the lanes', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      const pathA = laneVerified(ctx, 'A');
      const pathB = laneVerified(ctx, 'B');
      const mergedA = progress(ctx, 'merge', 'A');
      expect(mergedA.code, mergedA.stderr + mergedA.stdout).toBe(0);
      expect(json(mergedA)).toMatchObject({ status: 'verified', task: 'A', lane_merged: 'xm-lane/' + RUN + '/A' });
      const mergedB = progress(ctx, 'merge', 'B');
      expect(mergedB.code, mergedB.stderr + mergedB.stdout).toBe(0);
      expect(json(mergedB)).toMatchObject({ status: 'verified', task: 'B' });
      expect(statuses(ctx)).toEqual({ P: 'verified', A: 'verified', B: 'verified' });
      expect(readFileSync(join(ctx.cwd, 'src', 'a.txt'), 'utf8')).toBe('A\n');
      expect(readFileSync(join(ctx.cwd, 'src', 'b.txt'), 'utf8')).toBe('B\n');
      expect(existsSync(pathA) || existsSync(pathB)).toBe(false);
      expect(git(ctx.cwd, 'branch', '--list', 'xm-lane/*')).toBe('');
      expect(git(ctx.cwd, 'status', '--porcelain', '--untracked-files=no')).toBe('');
      expect(existsSync(join(ctx.cwd, '.xm', 'plan', RUN, 'merge.lock'))).toBe(false);
      const record = progressFile(ctx).tasks.A;
      expect(record.lane.merged_at).toBeString();
      expect(record.verified_files['src/a.txt']).toBeString();
      expect(gkCalls(ctx).find((call) => call[0] === 'commit')).toEqual(['commit', '-m', 'chore(lane): Lane A (A)', '--', 'src/a.txt']);
      // A merged lane task is a root task: starting it again acquires no lane.
      const acquires = gkCalls(ctx).filter((call) => call[0] === 'worktree').length;
      const restarted = progress(ctx, 'start', 'A');
      expect(restarted.code, restarted.stderr).toBe(0);
      expect(json(restarted).lane_path).toBeUndefined();
      expect(gkCalls(ctx).filter((call) => call[0] === 'worktree').length).toBe(acquires);
      expect(progressFile(ctx).tasks.A.lane.merged_at).toBe(record.lane.merged_at);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a lane that changes or commits a file outside its list is refused', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      const path = laneVerified(ctx, 'A');
      writeFileSync(join(path, 'src', 'extra.txt'), 'x\n');
      const uncommitted = progress(ctx, 'merge', 'A');
      expect(uncommitted.code).toBe(1);
      expect(uncommitted.stderr).toContain('outside its expected_files: src/extra.txt');
      rmSync(join(path, 'src', 'extra.txt'));
      writeFileSync(join(path, 'README.md'), 'lane\n');
      git(path, 'commit', '-qam', 'stray');
      const committed = progress(ctx, 'merge', 'A');
      expect(committed.code).toBe(1);
      expect(committed.stderr).toContain('outside its expected_files: README.md');
      expect(statuses(ctx).A).toBe('lane_verified');
      expect(gkCalls(ctx).some((call) => call[0] === 'merge')).toBe(false);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a conflicting lane gives merge_conflict, restores the root, and recovers; the other lane still merges', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      const pathA = laneVerified(ctx, 'A');
      laneVerified(ctx, 'B');
      writeFileSync(join(ctx.cwd, 'src', 'a.txt'), 'root\n');
      git(ctx.cwd, 'add', 'src/a.txt');
      git(ctx.cwd, 'commit', '-qm', 'root a');
      const head = git(ctx.cwd, 'rev-parse', 'HEAD');
      const conflict = progress(ctx, 'merge', 'A');
      expect(conflict.code).toBe(2);
      expect(json(conflict)).toMatchObject({ status: 'merge_conflict', task: 'A', lane_path: pathA });
      expect(hasMergeHead(ctx.cwd)).toBe(false);
      expect(git(ctx.cwd, 'rev-parse', 'HEAD')).toBe(head);
      expect(gkCalls(ctx).some((call) => call[0] === 'abort')).toBe(true);
      expect(statuses(ctx).A).toBe('merge_conflict');
      const mergedB = progress(ctx, 'merge', 'B');
      expect(mergedB.code, mergedB.stderr + mergedB.stdout).toBe(0);
      // Recovery as printed: merge the root branch in the lane, resolve, verify, merge.
      const branch = git(ctx.cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
      spawnSync('git', ['merge', branch], { cwd: pathA });
      writeFileSync(join(pathA, 'src', 'a.txt'), 'resolved\n');
      git(pathA, 'add', 'src/a.txt');
      git(pathA, 'commit', '-qm', 'resolve', '--no-edit');
      expect(json(progress(ctx, 'verify', 'A')).status).toBe('lane_verified');
      const mergedA = progress(ctx, 'merge', 'A');
      expect(mergedA.code, mergedA.stderr + mergedA.stdout).toBe(0);
      expect(statuses(ctx)).toEqual({ P: 'verified', A: 'verified', B: 'verified' });
      expect(readFileSync(join(ctx.cwd, 'src', 'a.txt'), 'utf8')).toBe('resolved\n');
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a conflict found by the git-kit precheck gives merge_conflict without an abort', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      laneVerified(ctx, 'A');
      writeFileSync(join(ctx.cwd, 'src', 'a.txt'), 'root\n');
      git(ctx.cwd, 'add', 'src/a.txt');
      git(ctx.cwd, 'commit', '-qm', 'root a');
      const conflict = progress(ctx, 'merge', 'A', { FAKE_GK_PRECHECK: '1' });
      expect(conflict.code).toBe(2);
      expect(json(conflict).status).toBe('merge_conflict');
      expect(gkCalls(ctx).some((call) => call[0] === 'abort')).toBe(false);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a verify command that fails after the merge aborts it and keeps lane_verified', () => {
    const ctx = setup(envelope({ aVerify: ['test -f src/a.txt && test ! -f src/block'] }));
    try {
      finishP(ctx);
      const path = laneVerified(ctx, 'A');
      writeFileSync(join(ctx.cwd, 'src', 'block'), 'x\n');
      const head = git(ctx.cwd, 'rev-parse', 'HEAD');
      const failed = progress(ctx, 'merge', 'A');
      expect(failed.code).toBe(2);
      expect(json(failed)).toMatchObject({ status: 'failed', failed_command: 'test -f src/a.txt && test ! -f src/block', phase: 'merge', state: 'lane_verified' });
      expect(hasMergeHead(ctx.cwd)).toBe(false);
      expect(git(ctx.cwd, 'rev-parse', 'HEAD')).toBe(head);
      expect(existsSync(join(ctx.cwd, 'src', 'a.txt'))).toBe(false);
      expect(existsSync(path)).toBe(true);
      expect(statuses(ctx).A).toBe('lane_verified');
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a merge in progress in the root is refused and not aborted', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      laneVerified(ctx, 'A');
      git(ctx.cwd, 'checkout', '-qb', 'side');
      writeFileSync(join(ctx.cwd, 'SIDE.md'), 's\n');
      git(ctx.cwd, 'add', 'SIDE.md');
      git(ctx.cwd, 'commit', '-qm', 'side');
      git(ctx.cwd, 'checkout', '-q', '-');
      git(ctx.cwd, 'merge', '--no-ff', '--no-commit', 'side');
      expect(hasMergeHead(ctx.cwd)).toBe(true);
      const refused = progress(ctx, 'merge', 'A');
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('merge in progress (MERGE_HEAD)');
      expect(refused.stderr).toContain('git-kit abort');
      expect(hasMergeHead(ctx.cwd)).toBe(true);
      expect(gkCalls(ctx).some((call) => call[0] === 'abort' || call[0] === 'merge')).toBe(false);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a merge lock held by a live pid is refused, and one of a dead pid is taken over', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      laneVerified(ctx, 'A');
      const lock = join(ctx.cwd, '.xm', 'plan', RUN, 'merge.lock');
      writeFileSync(lock, String(process.pid));
      const refused = progress(ctx, 'merge', 'A');
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('pid ' + process.pid);
      expect(readFileSync(lock, 'utf8')).toBe(String(process.pid));
      const dead = spawnSync('true').pid;
      writeFileSync(lock, String(dead));
      const merged = progress(ctx, 'merge', 'A');
      expect(merged.code, merged.stderr + merged.stdout).toBe(0);
      expect(existsSync(lock)).toBe(false);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a refused merge releases the lock', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      const path = laneVerified(ctx, 'A');
      writeFileSync(join(path, 'src', 'extra.txt'), 'x\n');
      expect(progress(ctx, 'merge', 'A').code).toBe(1);
      expect(existsSync(join(ctx.cwd, '.xm', 'plan', RUN, 'merge.lock'))).toBe(false);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('text output names the lane, the next command, and the recovery steps', () => {
    const plan = envelope();
    plan.tasks[1].title = 'A lane task whose title is far longer than a commit header can hold in git-kit';
    const ctx = setup(plan);
    const text = (sub, task) => cli(ctx, ['progress', sub, '--plan', RUN, '--task', task]);
    try {
      finishP(ctx);
      const started = text('start', 'A');
      expect(started.code, started.stderr).toBe(0);
      const path = progressFile(ctx).tasks.A.lane.path;
      expect(started.stdout).toContain('in lane ' + path);
      expect(started.stdout).toContain('xm build progress merge --plan ' + RUN + ' --task A');
      writeFileSync(join(path, 'src', 'a.txt'), 'a\n');
      const verified = text('verify', 'A');
      expect(verified.code, verified.stderr).toBe(0);
      expect(verified.stdout).toContain('Lane verified A');
      writeFileSync(join(ctx.cwd, 'src', 'a.txt'), 'root\n');
      git(ctx.cwd, 'add', 'src/a.txt');
      git(ctx.cwd, 'commit', '-qm', 'root a');
      const conflict = text('merge', 'A');
      expect(conflict.code).toBe(2);
      expect(conflict.stderr).toContain('conflicts');
      expect(conflict.stderr).toContain('1. git -C ' + path + ' merge ');
      expect(conflict.stderr).toContain('2. xm build progress verify --plan ' + RUN + ' --task A');
      const message = gkCalls(ctx).find((call) => call[0] === 'commit')[2];
      expect(message.length).toBeLessThanOrEqual(72);
      expect(message).toStartWith('chore(lane): A lane task');
      expect(message).toEndWith('... (A)');
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a plan without lanes runs every task in the root as before', () => {
    const ctx = setup(envelope({ lanes: false }));
    try {
      finishP(ctx);
      const started = progress(ctx, 'start', 'A');
      expect(started.code).toBe(0);
      expect(json(started).lane_path).toBeUndefined();
      writeFileSync(join(ctx.cwd, 'src', 'a.txt'), 'a\n');
      expect(json(progress(ctx, 'verify', 'A')).status).toBe('verified');
      const merge = progress(ctx, 'merge', 'B');
      expect(merge.code).toBe(1);
      expect(merge.stderr).toContain('is not a lane task');
      expect(gkCalls(ctx)).toEqual([]);
      expect(progressFile(ctx).step_bases).toBeUndefined();
    } finally { cleanup(ctx); }
  }, TIMEOUT);
});

describe('xm build progress lanes: review fixes', () => {
  test('a lane whose command fails in the lane exits 2, goes back to in_progress, and cannot merge', () => {
    const ctx = setup(envelope({ aVerify: ['test -f src/a.txt', 'grep -q ready src/a.txt'] }));
    try {
      finishP(ctx);
      const path = startLane(ctx, 'A');
      writeFileSync(join(path, 'src', 'a.txt'), 'draft\n');
      const failed = progress(ctx, 'verify', 'A');
      expect(failed.code).toBe(2);
      expect(json(failed)).toMatchObject({ status: 'failed', failed_command: 'grep -q ready src/a.txt', lane_path: path });
      expect(progressFile(ctx).tasks.A.state).toBe('in_progress');
      const refused = progress(ctx, 'merge', 'A');
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('not lane_verified');
      writeFileSync(join(path, 'src', 'a.txt'), 'ready\n');
      expect(json(progress(ctx, 'verify', 'A')).status).toBe('lane_verified');
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a merge committed by a run that stopped before recording it is recorded on the next merge', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      const path = laneVerified(ctx, 'A');
      // What a run killed between the merge commit and the progress write leaves behind.
      git(path, 'add', 'src/a.txt');
      git(path, 'commit', '-qm', 'chore(lane): Lane A (A)');
      git(ctx.cwd, 'merge', '--no-ff', '--no-edit', 'xm-lane/' + RUN + '/A');
      const head = git(ctx.cwd, 'rev-parse', 'HEAD');
      expect(progressFile(ctx).tasks.A.state).toBe('lane_verified');
      const merged = progress(ctx, 'merge', 'A');
      expect(merged.code, merged.stderr + merged.stdout).toBe(0);
      expect(json(merged)).toMatchObject({ status: 'verified', task: 'A', recovered: true, merge_commit: head });
      expect(git(ctx.cwd, 'rev-parse', 'HEAD')).toBe(head);
      expect(existsSync(path)).toBe(false);
      expect(progressFile(ctx).tasks.A.lane.merged_at).toBeTruthy();
      expect(gkCalls(ctx).some((call) => call[0] === 'merge')).toBe(false);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a task started in the root before the plan turned lanes on stays a root task', () => {
    const ctx = setup(envelope({ lanes: false }));
    try {
      finishP(ctx);
      expect(progress(ctx, 'start', 'A').code).toBe(0);
      writeFileSync(join(ctx.cwd, '.xm', 'plan', RUN, 'envelope.json'), JSON.stringify(envelope()));
      writeFileSync(join(ctx.cwd, 'src', 'a.txt'), 'a\n');
      const verified = progress(ctx, 'verify', 'A');
      expect(verified.code, verified.stderr + verified.stdout).toBe(0);
      expect(json(verified).status).toBe('verified');
      const refused = progress(ctx, 'merge', 'A');
      expect(refused.code).toBe(1);
      expect(refused.stderr).toMatch(/lane of A was merged|started in the repository root/);
      expect(progressFile(ctx).tasks.A.lane).toBeUndefined();
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a first lane start that fails to create the worktree stores no step base', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      const failed = progress(ctx, 'start', 'A', { X_BUILD_GK_ARGV: JSON.stringify(['node', '-e', 'process.exit(1)']) });
      expect(failed.code).toBe(1);
      expect(progressFile(ctx).step_bases).toBeUndefined();
      writeFileSync(join(ctx.cwd, 'NOTES.md'), 'n\n');
      git(ctx.cwd, 'add', 'NOTES.md');
      git(ctx.cwd, 'commit', '-qm', 'notes');
      const head = git(ctx.cwd, 'rev-parse', 'HEAD');
      const started = json(progress(ctx, 'start', 'A'));
      expect(started.base).toBe(head);
      expect(progressFile(ctx).step_bases['1']).toBe(head);
    } finally { cleanup(ctx); }
  }, TIMEOUT);

  test('a stale merge lock is not taken over while another merge holds the takeover file', () => {
    const ctx = setup();
    try {
      finishP(ctx);
      laneVerified(ctx, 'A');
      const lock = join(ctx.cwd, '.xm', 'plan', RUN, 'merge.lock');
      writeFileSync(lock, String(spawnSync('true').pid));
      writeFileSync(lock + '.takeover', String(process.pid));
      const refused = progress(ctx, 'merge', 'A');
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('is replacing the stale lock');
      expect(existsSync(lock)).toBe(true);
      rmSync(lock + '.takeover');
      const merged = progress(ctx, 'merge', 'A');
      expect(merged.code, merged.stderr + merged.stdout).toBe(0);
      expect(existsSync(lock)).toBe(false);
      expect(existsSync(lock + '.takeover')).toBe(false);
    } finally { cleanup(ctx); }
  }, TIMEOUT);
});
