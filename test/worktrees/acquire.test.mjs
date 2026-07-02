/**
 * t6 — worktree acquire automation + TASK-CONTEXT snapshot + env injection.
 *
 * gk is faked via X_BUILD_GK_ARGV → fake-gk.mjs; the ok path returns a REAL
 * linked worktree path (created by this test with `git worktree add`) so the
 * snapshot write + info/exclude registration exercise the true git plumbing.
 *
 * X_BUILD_ROOT is read at call time (buildRoot()), so the shared module import
 * is fine — we set it in beforeAll and restore in afterAll.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_GK = join(__dirname, 'fake-gk.mjs');

const ORIG_ROOT = process.env.X_BUILD_ROOT;
let main;   // main repo
let wtPath; // real linked worktree

const wt = await import('../../x-build/lib/x-build/worktrees.mjs');

const gitq = (cwd, c) => execSync(`git ${c}`, { cwd, stdio: 'pipe', shell: '/bin/bash' });

const PROJECT = 'demo';
const TASK = {
  id: 't1', name: 'Search Index', status: 'ready',
  description: 'Build the inverted index.',
  done_criteria: ['index builds', 'lookup works'],
  expected_files: ['src/search.mjs'],
  depends_on: [],
};

beforeAll(() => {
  main = mkdtempSync(join(tmpdir(), 'wt-acq-'));
  gitq(main, 'init -q');
  gitq(main, 'config user.email t@t.com');
  gitq(main, 'config user.name T');
  writeFileSync(join(main, 'f.txt'), 'x\n');
  gitq(main, 'add -A && git commit -q -m c1');
  gitq(main, 'branch develop');

  // A real linked worktree the fake gk will "return".
  wtPath = join(main, '..', `wt-acq-linked-${Date.now()}`);
  gitq(main, `worktree add -q -b feat/t1-search-index ${JSON.stringify(wtPath)} develop`);

  process.env.X_BUILD_ROOT = join(main, '.xm', 'build');
});

afterAll(() => {
  try { gitq(main, `worktree remove --force ${JSON.stringify(wtPath)}`); } catch {}
  for (const d of [main, wtPath]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  if (ORIG_ROOT !== undefined) process.env.X_BUILD_ROOT = ORIG_ROOT; else delete process.env.X_BUILD_ROOT;
});

function withGkEnv(scenario, fn) {
  const prevArgv = process.env.X_BUILD_GK_ARGV;
  const prevScn = process.env.FAKE_GK_SCENARIO;
  const prevPath = process.env.FAKE_GK_ACQUIRE_PATH;
  process.env.X_BUILD_GK_ARGV = JSON.stringify(['node', FAKE_GK]);
  process.env.FAKE_GK_SCENARIO = scenario;
  process.env.FAKE_GK_ACQUIRE_PATH = wtPath;
  try { return fn(); } finally {
    if (prevArgv === undefined) delete process.env.X_BUILD_GK_ARGV; else process.env.X_BUILD_GK_ARGV = prevArgv;
    if (prevScn === undefined) delete process.env.FAKE_GK_SCENARIO; else process.env.FAKE_GK_SCENARIO = prevScn;
    if (prevPath === undefined) delete process.env.FAKE_GK_ACQUIRE_PATH; else process.env.FAKE_GK_ACQUIRE_PATH = prevPath;
  }
}

describe('acquireWorktree — ok path', () => {
  test('creates run.json, snapshot, artifact, and registers exclude', () => {
    const res = withGkEnv('ok', () => wt.acquireWorktree({ project: PROJECT, task: TASK, config: { base: 'develop', branch_prefix: 'feat/' }, cwd: main }));
    expect(res.ok).toBe(true);
    expect(res.worktree).toBe(wtPath);
    expect(res.branch).toBe('feat/t1-search-index');

    // run.json → WORKTREE_CREATED
    const run = wt.readRun(PROJECT, TASK.id);
    expect(run.worktree_status).toBe(wt.WORKTREE_STATUS.WORKTREE_CREATED);
    expect(run.worktree).toBe(wtPath);

    // snapshot in the worktree
    const snap = join(wtPath, 'TASK-CONTEXT.md');
    expect(existsSync(snap)).toBe(true);
    const snapText = readFileSync(snap, 'utf8');
    expect(snapText).toContain('# Task');
    expect(snapText).toContain('t1: Search Index');
    expect(snapText).toContain('src/search.mjs');

    // canonical artifact
    expect(existsSync(wt.taskContextArtifactPath(PROJECT, TASK.id))).toBe(true);

    // info/exclude registered (use the resolved path the code reported)
    expect(res.context.excludePath).toBeTruthy();
    const excludeText = readFileSync(res.context.excludePath, 'utf8');
    expect(excludeText.split('\n').map(l => l.trim())).toContain('TASK-CONTEXT.md');
  });

  test('exclude registration is idempotent (no duplicate entry)', () => {
    const res = withGkEnv('ok', () => wt.acquireWorktree({ project: PROJECT, task: TASK, config: { base: 'develop', branch_prefix: 'feat/' }, cwd: main }));
    const text = readFileSync(res.context.excludePath, 'utf8');
    const count = text.split('\n').filter(l => l.trim() === 'TASK-CONTEXT.md').length;
    expect(count).toBe(1);
  });
});

describe('acquireWorktree — blocked path', () => {
  test('blocked envelope → BLOCKED with remedies, no snapshot', () => {
    const task = { ...TASK, id: 't2', name: 'Blocked One' };
    const res = withGkEnv('blocked', () => wt.acquireWorktree({ project: PROJECT, task, config: { base: 'develop', branch_prefix: 'feat/' }, cwd: main }));
    expect(res.ok).toBe(false);
    const run = wt.readRun(PROJECT, 't2');
    expect(run.worktree_status).toBe(wt.WORKTREE_STATUS.BLOCKED);
    expect(run.last_error.code).toBe('worktree_acquire_failed');
    expect(run.recover.length).toBeGreaterThan(0);
  });
});

describe('buildAgentEnv — root env injection contract', () => {
  test('emits all three roots pointing at main .xm/', () => {
    const env = wt.buildAgentEnv('/repo');
    expect(env).toEqual({
      X_BUILD_ROOT: '/repo/.xm/build',
      X_PANEL_ROOT: '/repo/.xm',
      XM_ROOT: '/repo/.xm',
    });
  });

  test('throws without a main repo root', () => {
    expect(() => wt.buildAgentEnv()).toThrow(/mainRepoRoot/);
  });
});
