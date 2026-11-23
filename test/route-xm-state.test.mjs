/**
 * xm keeps its runtime state in .xm/: the routing ledger, leases, receipts, plan progress.
 * A repository that ignores .xm/ never shows those files to `git status`. One that does not
 * showed them to the route commands, so `route start` refused the tree because of the ledger
 * and `route verify` failed on the run's own lease file. The route commands now see what
 * `git status` prints when .xm/ is ignored: untracked files under .xm/ are left out, and a
 * tracked file there is still reported.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');
const RUN = 'run-1';
const GATES = ['--gate-cmd', 'test=grep -q v2 src/a.txt', '--gate-cmd', 'boundary=test -s src/a.txt'];
const PLAN = {
  schema_version: 1, status: 'complete', executable: true, goal: 'Ship v2',
  requirements: [{ id: 'R1', text: 'Write v2', priority: 'must' }], assumptions: [],
  decision: { selected: 'Native plan', alternatives: [] },
  tasks: [{ id: 'A', title: 'Write v2', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/a.txt'], done_criteria: ['a.txt holds v2'] }],
  steps: [['A']], validation: { commands: ['grep -q v2 src/a.txt'], requirement_refs: ['R1'] }, disagreements: [], unresolved_questions: [], provenance: {},
};

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.email=p@example.com', '-c', 'user.name=p', ...args], { cwd, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}
// The state lands in the repository's own .xm: no X_BUILD_ROOT or XM_ROOT is set.
function xm(cwd, ...args) {
  const env = { ...process.env, X_BUILD_ROOT: undefined, XM_ROOT: undefined, XKIT_SERVER: undefined, GIT_CEILING_DIRECTORIES: tmpdir() };
  const result = spawnSync('node', [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}
function repo({ ignore }) {
  const cwd = mkdtempSync(join(tmpdir(), 'xb-route-xm-state-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'a.txt'), 'v1\n');
  if (ignore) writeFileSync(join(cwd, '.gitignore'), '.xm/\n');
  git(cwd, 'init', '-q');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'fixture');
  return cwd;
}
function confirmedDecision(cwd) {
  const decided = xm(cwd, 'route', 'decide', '--kind', 'bugfix', '--scope', 'bounded', '--independent', '--files', 'src/a.txt,src/b.txt', '--risk', 'low', '--failure-modes', '2', '--gates', 'test,boundary', '--json');
  const id = JSON.parse(decided.stdout).decision_id;
  expect(xm(cwd, 'route', 'confirm', '--decision-id', id, '--host', 'claude', '--session-model', 'unknown', '--source', 'default').code).toBe(0);
  return id;
}
const start = (cwd, id, ...extra) => xm(cwd, 'route', 'start', '--decision-id', id, '--expected-files', 'src/a.txt', ...GATES, ...extra, '--json');
function writePlan(cwd) {
  mkdirSync(join(cwd, '.xm', 'plan', RUN), { recursive: true });
  writeFileSync(join(cwd, '.xm', 'plan', RUN, 'envelope.json'), JSON.stringify(PLAN));
}
// Decide, plan, start, track the task, change the file, verify, finish. No --allow-dirty.
function fullRun(cwd) {
  const id = confirmedDecision(cwd);
  writePlan(cwd);
  const started = start(cwd, id);
  expect(started.code, started.stderr).toBe(0);
  const lease = JSON.parse(started.stdout);
  expect(xm(cwd, 'progress', 'start', '--plan', RUN, '--task', 'A').code).toBe(0);
  writeFileSync(join(cwd, 'src', 'a.txt'), 'v2\n');
  const tracked = xm(cwd, 'progress', 'verify', '--plan', RUN, '--task', 'A');
  expect(tracked.code, tracked.stderr).toBe(0);
  const verified = xm(cwd, 'route', 'verify', '--decision-id', id, '--json');
  const receipt = JSON.parse(verified.stdout);
  const finished = xm(cwd, 'route', 'finish', '--decision-id', id, '--json');
  expect(finished.code, finished.stderr).toBe(0);
  return {
    baseline_dirty: lease.baseline_dirty, passed: receipt.passed, changed_files: receipt.changed_files,
    unexpected_files: receipt.unexpected_files, baseline_dirty_changed: receipt.baseline_dirty_changed,
    outcome: JSON.parse(finished.stdout).outcome.outcome,
  };
}

describe('route commands and xm state under .xm/', () => {
  test('a repository that does not ignore .xm/ runs start, progress, verify and finish like one that does', () => {
    const plain = repo({ ignore: false });
    const ignoring = repo({ ignore: true });
    try {
      const expected = { baseline_dirty: [], passed: true, changed_files: ['src/a.txt'], unexpected_files: [], baseline_dirty_changed: [], outcome: 'accepted' };
      expect(fullRun(ignoring)).toEqual(expected);
      expect(fullRun(plain)).toEqual(expected);
    } finally { rmSync(plain, { recursive: true, force: true }); rmSync(ignoring, { recursive: true, force: true }); }
  });

  test('an untracked .xm directory below the root is left out too', () => {
    const cwd = repo({ ignore: false });
    try {
      const id = confirmedDecision(cwd);
      mkdirSync(join(cwd, 'packages', 'a', '.xm'), { recursive: true });
      writeFileSync(join(cwd, 'packages', 'a', '.xm', 'state.json'), '{}\n');
      const started = start(cwd, id);
      expect(started.code, started.stderr).toBe(0);
      expect(JSON.parse(started.stdout).baseline_dirty).toEqual([]);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test.each([['not ignored', false], ['ignored', true]])('an untracked file outside .xm/ still blocks start and is still reported by verify: .xm/ %s', (_label, ignore) => {
    const cwd = repo({ ignore });
    try {
      const id = confirmedDecision(cwd);
      writeFileSync(join(cwd, 'notes.txt'), 'before\n');
      const refused = start(cwd, id);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('working tree must be clean before route start: notes.txt');
      rmSync(join(cwd, 'notes.txt'));
      expect(start(cwd, id).code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'v2\n');
      writeFileSync(join(cwd, 'extra.txt'), 'undeclared\n');
      const receipt = JSON.parse(xm(cwd, 'route', 'verify', '--decision-id', id, '--json').stdout);
      expect(receipt.passed).toBe(false);
      expect(receipt.unexpected_files).toEqual(['extra.txt']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // An ignore rule never hides a tracked file, so a repository that ignores .xm/ reports this
  // too. Hiding tracked paths would remove the check from both.
  test.each([['not ignored', false], ['ignored', true]])('a tracked file under .xm/ that the run edits is still reported: .xm/ %s', (_label, ignore) => {
    const cwd = repo({ ignore });
    try {
      mkdirSync(join(cwd, '.xm'), { recursive: true });
      writeFileSync(join(cwd, '.xm', 'config.json'), '{"profile":"default"}\n');
      git(cwd, 'add', '-f', '.xm/config.json');
      git(cwd, 'commit', '-qm', 'track the shared config');
      const id = confirmedDecision(cwd);
      expect(start(cwd, id).code).toBe(0);
      writeFileSync(join(cwd, 'src', 'a.txt'), 'v2\n');
      writeFileSync(join(cwd, '.xm', 'config.json'), '{"profile":"max"}\n');
      const receipt = JSON.parse(xm(cwd, 'route', 'verify', '--decision-id', id, '--json').stdout);
      expect(receipt.passed).toBe(false);
      expect(receipt.unexpected_files).toEqual(['.xm/config.json']);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // A first commit made with `git add -A` after xm ran takes the ledger in. It is then a tracked
  // file that every decision changes, so start refuses and says why the file is listed.
  test('xm state that the first commit swept in is reported, with the reason', () => {
    const cwd = repo({ ignore: false });
    try {
      confirmedDecision(cwd);
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-qm', 'sweep .xm in');
      const id = confirmedDecision(cwd);
      const refused = start(cwd, id);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain('working tree must be clean before route start: .xm/build/metrics/adaptive-routing.jsonl');
      expect(refused.stderr).toContain('git tracks');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
