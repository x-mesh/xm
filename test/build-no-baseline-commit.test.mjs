/**
 * `route start` and `progress start` record HEAD as the baseline. Where there is no repository,
 * or a repository with no commit, the error must name that and come first: no flag changes it.
 * The run that exposed this was told "missing gate commands" first, passed placeholder gate
 * commands, met the HEAD error next, and then ran without a lease.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');
const RUN = 'run-1';
const PLAN = {
  schema_version: 1, status: 'complete', executable: true, goal: 'Ship the API',
  requirements: [{ id: 'R1', text: 'Add API', priority: 'must' }], assumptions: [],
  decision: { selected: 'Native plan', alternatives: [] },
  tasks: [{ id: 'A', title: 'Implement API', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/a.txt'], done_criteria: ['A exists'] }],
  steps: [['A']], validation: { commands: ['true'], requirement_refs: ['R1'] }, disagreements: [], unresolved_questions: [], provenance: {},
};

function fixture(kind) {
  const cwd = mkdtempSync(join(tmpdir(), 'xb-no-baseline-'));
  const git = (...args) => spawnSync('git', args, { cwd });
  if (kind !== 'no repository') git('init', '-q');
  if (kind === 'one commit') git('-c', 'user.email=p@example.com', '-c', 'user.name=p', 'commit', '-q', '--allow-empty', '-m', 'fixture');
  mkdirSync(join(cwd, '.xm', 'plan', RUN), { recursive: true });
  writeFileSync(join(cwd, '.xm', 'plan', RUN, 'envelope.json'), JSON.stringify(PLAN));
  return cwd;
}
function run(cwd, args) {
  // The ceiling keeps git from finding a repository above the temporary directory.
  const env = { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: undefined, XKIT_SERVER: undefined, GIT_CEILING_DIRECTORIES: dirname(cwd) };
  const result = spawnSync('node', [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 15_000 });
  return { code: result.status ?? 1, text: (result.stdout || '') + (result.stderr || '') };
}
// No --gate-cmd: an error a flag can clear.
function routeStart(cwd) {
  const decided = run(cwd, ['route', 'decide', '--kind', 'feature', '--scope', 'bounded', '--independent', '--files', 'src/a.txt', '--risk', 'low', '--failure-modes', '1', '--gates', 'test', '--json']);
  const id = JSON.parse(decided.text).decision_id;
  expect(run(cwd, ['route', 'confirm', '--decision-id', id, '--host', 'claude', '--session-model', 'unknown', '--source', 'default']).code).toBe(0);
  return run(cwd, ['route', 'start', '--decision-id', id, '--expected-files', 'src/a.txt', '--json']);
}
const progressStart = (cwd) => run(cwd, ['progress', 'start', '--plan', RUN, '--task', 'A']);

const CASES = [
  ['no repository', 'is not in a git repository'],
  ['no commit', 'this repository has no commit yet'],
];

describe('a missing baseline commit', () => {
  test.each(CASES)('route start with %s names it before any other error', (kind, problem) => {
    const cwd = fixture(kind);
    try {
      const result = routeStart(cwd);
      expect(result.code).toBe(1);
      expect(result.text).toContain('route start records HEAD as the baseline, and ');
      expect(result.text).toContain(problem);
      expect(result.text).toContain('run route start again');
      expect(result.text).not.toContain('missing gate commands');
      expect(result.text).not.toContain('working tree must be clean');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('route start with a commit still reports the missing gate command', () => {
    const cwd = fixture('one commit');
    try {
      const result = routeStart(cwd);
      expect(result.code).toBe(1);
      expect(result.text).toContain('missing gate commands: test');
      expect(result.text).not.toContain('records HEAD as the baseline');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test.each(CASES)('progress start with %s names it', (kind, problem) => {
    const cwd = fixture(kind);
    try {
      const result = progressStart(cwd);
      expect(result.code).toBe(1);
      expect(result.text).toContain('progress records HEAD as the baseline, and ');
      expect(result.text).toContain(problem);
      expect(result.text).toContain('run this command again');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  // The rev-parse in progress has a 5 second limit. The diagnosis that follows a failure
  // had none, so a git that hangs turned an error after 5 seconds into no answer at all.
  // The diagnosis makes two calls, and each fake git stops a different one: the first call
  // when every call hangs, the second when only `--is-inside-work-tree` hangs.
  test.each([
    ['every call', '#!/bin/sh\nexec sleep 120\n'],
    ['only the second diagnosis call', '#!/bin/sh\ncase "$*" in *--is-inside-work-tree*) exec sleep 120;; esac\nexit 1\n'],
  ])('progress start still ends in an error when git does not answer: %s', (_label, script) => {
    const cwd = fixture('one commit');
    const bin = mkdtempSync(join(tmpdir(), 'xb-hung-git-'));
    try {
      writeFileSync(join(bin, 'git'), script);
      chmodSync(join(bin, 'git'), 0o755);
      const env = { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: undefined, XKIT_SERVER: undefined, PATH: bin + ':' + process.env.PATH };
      const result = spawnSync('node', [CLI, 'progress', 'start', '--plan', RUN, '--task', 'A'], { cwd, env, encoding: 'utf8', timeout: 25_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('progress requires a git repository with at least one commit');
    } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(bin, { recursive: true, force: true }); }
  }, 30_000);

  test('progress start with a commit starts the task', () => {
    const cwd = fixture('one commit');
    try {
      const result = progressStart(cwd);
      expect(result.code, result.text).toBe(0);
      expect(result.text).toContain('Started A Implement API');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
