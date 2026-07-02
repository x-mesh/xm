/**
 * t7 — serialized finish queue + `worktrees resume`.
 *
 * gk is faked via X_BUILD_GK_ARGV → fake-gk.mjs. No real git-kit or panel runs.
 * X_BUILD_ROOT is read at call time (buildRoot()/taskDataPath()), so setting it
 * in beforeAll is enough even though the module is imported at top level.
 *
 * Serialization is proven from FAKE_GK_LOG: every finish subprocess appends its
 * {start,end,pid}; the queue is correct iff those windows never overlap and the
 * order matches the input.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE_GK = join(__dirname, 'fake-gk.mjs');

const wt = await import('../../x-build/lib/x-build/worktrees.mjs');

const ORIG_ROOT = process.env.X_BUILD_ROOT;
const PROJECT = 'demo';
const gitq = (cwd, c) => execSync(`git ${c}`, { cwd, stdio: 'pipe', shell: '/bin/bash' });

let main;      // main repo root
let counters;  // per-task call counter dir
let logFile;   // finish serialization log

beforeAll(() => {
  main = mkdtempSync(join(tmpdir(), 'wt-finish-'));
  gitq(main, 'init -q');
  gitq(main, 'config user.email t@t.com');
  gitq(main, 'config user.name T');
  writeFileSync(join(main, 'f.txt'), 'x\n');
  gitq(main, 'add -A && git commit -q -m c1');
  gitq(main, 'branch develop');
  process.env.X_BUILD_ROOT = join(main, '.xm', 'build');
});

afterAll(() => {
  try { rmSync(main, { recursive: true, force: true }); } catch {}
  if (ORIG_ROOT !== undefined) process.env.X_BUILD_ROOT = ORIG_ROOT; else delete process.env.X_BUILD_ROOT;
});

beforeEach(() => {
  counters = mkdtempSync(join(tmpdir(), 'wt-count-'));
  logFile = join(counters, 'finish.log');
});

// ── env helpers ───────────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const GK_ARGV = JSON.stringify(['node', FAKE_GK]);

// Seed a run.json whose worktree path exists (spawnSync cwd must resolve).
function seedRun(taskId, { status = wt.WORKTREE_STATUS.RUNNING, worktree = null } = {}) {
  const dir = worktree || mkdtempSync(join(tmpdir(), `wt-${taskId}-`));
  wt.initRun(PROJECT, taskId, { branch: `feat/${taskId}`, worktree: dir, base: 'develop' });
  wt.updateRun(PROJECT, taskId, { worktree_status: status });
  return dir;
}

// Seed tasks.json under the call-time build root so markTaskCompleted can flip.
function seedTasks(ids) {
  const p = join(process.env.X_BUILD_ROOT, 'projects', PROJECT, 'phases', '02-plan', 'tasks.json');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ tasks: ids.map((id) => ({ id, name: id, status: 'running' })) }, null, 2));
  return p;
}

function readTasks() {
  const p = join(process.env.X_BUILD_ROOT, 'projects', PROJECT, 'phases', '02-plan', 'tasks.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

// ── serialization ───────────────────────────────────────────────────────

describe('finishWorktrees — serialization', () => {
  test('3 finishes run one at a time (non-overlapping), in order', () => {
    const ids = ['s1', 's2', 's3'];
    seedTasks(ids);
    ids.forEach((id) => seedRun(id));

    const out = withEnv({
      X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SCENARIO: 'ok', FAKE_GK_LOG: logFile,
    }, () => wt.finishWorktrees({ project: PROJECT, taskIds: ids, config: { base: 'develop', gate_phase: 'before', cleanup: true }, cwd: main }));

    expect(out.results.map((r) => r.task_id)).toEqual(ids);
    expect(out.results.every((r) => r.worktree_status === wt.WORKTREE_STATUS.DONE)).toBe(true);

    const calls = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.map((c) => c.task)).toEqual(ids);            // order preserved
    expect(new Set(calls.map((c) => c.pid)).size).toBe(3);    // fresh subprocess each
    const byStart = [...calls].sort((a, b) => a.start - b.start);
    for (let i = 1; i < byStart.length; i++) {
      expect(byStart[i].start).toBeGreaterThanOrEqual(byStart[i - 1].end); // no overlap
    }
  });

  test('ok → tasks.json completed + run.json DONE', () => {
    seedTasks(['okc']);
    seedRun('okc');
    withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SCENARIO: 'ok' },
      () => wt.finishWorktrees({ project: PROJECT, taskIds: ['okc'], config: { base: 'develop' }, cwd: main }));

    const run = wt.readRun(PROJECT, 'okc');
    expect(run.worktree_status).toBe(wt.WORKTREE_STATUS.DONE);
    expect(run.task_status).toBe(wt.TASK_STATUS.COMPLETED);
    expect(readTasks().tasks.find((t) => t.id === 'okc').status).toBe('completed');
  });
});

// ── failure folding ───────────────────────────────────────────────────────

describe('finishWorktrees — failure folding', () => {
  test('before gate fail → NEEDS_FIX, task stays running (target unchanged)', () => {
    seedTasks(['bf']);
    seedRun('bf');
    const out = withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SCENARIO: 'before_failed' },
      () => wt.finishWorktrees({ project: PROJECT, taskIds: ['bf'], config: { base: 'develop' }, cwd: main }));

    expect(out.results[0].worktree_status).toBe(wt.WORKTREE_STATUS.NEEDS_FIX);
    const run = wt.readRun(PROJECT, 'bf');
    expect(run.worktree_status).toBe(wt.WORKTREE_STATUS.NEEDS_FIX);
    expect(run.task_status).toBe(wt.TASK_STATUS.RUNNING);
    expect(readTasks().tasks.find((t) => t.id === 'bf').status).toBe('running'); // not merged
  });

  test('after-gate paused → BLOCKED + recover saved (no cleanup)', () => {
    seedRun('ap', { status: wt.WORKTREE_STATUS.RUNNING });
    withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SCENARIO: 'after_paused' },
      () => wt.finishWorktrees({ project: PROJECT, taskIds: ['ap'], config: { base: 'develop' }, cwd: main }));

    const run = wt.readRun(PROJECT, 'ap');
    expect(run.worktree_status).toBe(wt.WORKTREE_STATUS.BLOCKED);
    expect(run.recover.length).toBeGreaterThan(0);
    expect(run.recover.some((r) => /resume-accept/.test(r.command))).toBe(true);
    expect(existsSync(run.worktree)).toBe(true); // worktree preserved (no cleanup)
  });

  test('merge conflict paused → BLOCKED + resume/abort remedies', () => {
    seedRun('mc');
    withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SCENARIO: 'merge_conflict' },
      () => wt.finishWorktrees({ project: PROJECT, taskIds: ['mc'], config: { base: 'develop' }, cwd: main }));

    const run = wt.readRun(PROJECT, 'mc');
    expect(run.worktree_status).toBe(wt.WORKTREE_STATUS.BLOCKED);
    expect(run.recover.some((r) => /--abort/.test(r.command))).toBe(true);
  });

  test('locked twice → retried once then MERGING (queue continues)', () => {
    seedRun('lk');
    const out = withEnv({
      X_BUILD_GK_ARGV: GK_ARGV,
      FAKE_GK_FINISH_SCENARIOS: JSON.stringify({ lk: ['locked', 'locked'] }),
      FAKE_GK_COUNTER_DIR: counters,
    }, () => wt.finishWorktrees({ project: PROJECT, taskIds: ['lk'], config: { base: 'develop', gate_lock_backoff_ms: 1 }, cwd: main }));

    expect(out.results[0].retried).toBe(true);
    expect(out.results[0].worktree_status).toBe(wt.WORKTREE_STATUS.MERGING);
    expect(readFileSync(join(counters, 'count-lk'), 'utf8')).toBe('2'); // called twice
  });

  test('locked then ok → retried once, DONE', () => {
    seedTasks(['lo']);
    seedRun('lo');
    const out = withEnv({
      X_BUILD_GK_ARGV: GK_ARGV,
      FAKE_GK_FINISH_SCENARIOS: JSON.stringify({ lo: ['locked', 'ok'] }),
      FAKE_GK_COUNTER_DIR: counters,
    }, () => wt.finishWorktrees({ project: PROJECT, taskIds: ['lo'], config: { base: 'develop', gate_lock_backoff_ms: 1 }, cwd: main }));

    expect(out.results[0].retried).toBe(true);
    expect(out.results[0].worktree_status).toBe(wt.WORKTREE_STATUS.DONE);
    expect(readTasks().tasks.find((t) => t.id === 'lo').status).toBe('completed');
  });

  test('unparseable finish output → BLOCKED, not silenced, queue continues', () => {
    // FAKE_GK with an unknown scenario exits 2 with empty stdout.
    seedRun('up1');
    seedRun('up2');
    const out = withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SCENARIO: 'ok' }, () => {
      // Force the first to emit nothing parseable by pointing at a bad scenario
      // via the per-task map; the second stays ok to prove the queue continues.
      return withEnv({
        FAKE_GK_FINISH_SCENARIOS: JSON.stringify({ up1: 'nope', up2: 'ok' }),
      }, () => wt.finishWorktrees({ project: PROJECT, taskIds: ['up1', 'up2'], config: { base: 'develop' }, cwd: main }));
    });
    expect(out.results[0].worktree_status).toBe(wt.WORKTREE_STATUS.BLOCKED);
    expect(out.results[0].error).toBeTruthy();
    expect(out.results[1].worktree_status).toBe(wt.WORKTREE_STATUS.DONE);
  });
});

// ── resume ───────────────────────────────────────────────────────────────

// Create a real linked worktree so the dirty check + gk sync operate on true
// git plumbing. Returns the worktree path.
function linkedWorktree(taskId) {
  const p = join(main, '..', `wt-finish-linked-${taskId}-${Date.now()}`);
  gitq(main, `worktree add -q -b feat/${taskId} ${JSON.stringify(p)} develop`);
  return p;
}

describe('resumeWorktrees', () => {
  const created = [];
  afterAll(() => {
    for (const p of created) { try { gitq(main, `worktree remove --force ${JSON.stringify(p)}`); } catch {} }
  });

  test('NEEDS_FIX (clean) → gk sync ok → re-gate → DONE', () => {
    seedTasks(['rf']);
    const p = linkedWorktree('rf'); created.push(p);
    seedRun('rf', { status: wt.WORKTREE_STATUS.NEEDS_FIX, worktree: p });

    const out = withEnv({
      X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SYNC_SCENARIO: 'ok', FAKE_GK_SCENARIO: 'ok',
    }, () => wt.resumeWorktrees({ project: PROJECT, taskIds: ['rf'], config: { base: 'develop' }, cwd: main }));

    expect(out.results[0].action).toBe('finished');
    expect(out.results[0].worktree_status).toBe(wt.WORKTREE_STATUS.DONE);
    expect(readTasks().tasks.find((t) => t.id === 'rf').status).toBe('completed');
  });

  test('(F2) RUNNING (clean, happy-path) worktree → resume finishes → DONE', () => {
    seedTasks(['rr']);
    const p = linkedWorktree('rr'); created.push(p);
    seedRun('rr', { status: wt.WORKTREE_STATUS.RUNNING, worktree: p });

    const out = withEnv({
      X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SYNC_SCENARIO: 'ok', FAKE_GK_SCENARIO: 'ok',
    }, () => wt.resumeWorktrees({ project: PROJECT, taskIds: ['rr'], config: { base: 'develop' }, cwd: main }));

    expect(out.results[0].action).toBe('finished');
    expect(out.results[0].worktree_status).toBe(wt.WORKTREE_STATUS.DONE);
    expect(readTasks().tasks.find((t) => t.id === 'rr').status).toBe('completed');
  });

  test('(F2) WORKTREE_CREATED worktree is a resume target too', () => {
    seedTasks(['rw']);
    const p = linkedWorktree('rw'); created.push(p);
    seedRun('rw', { status: wt.WORKTREE_STATUS.WORKTREE_CREATED, worktree: p });

    const out = withEnv({
      X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SYNC_SCENARIO: 'ok', FAKE_GK_SCENARIO: 'ok',
    }, () => wt.resumeWorktrees({ project: PROJECT, taskIds: ['rw'], config: { base: 'develop' }, cwd: main }));

    expect(out.results[0].action).toBe('finished');
    expect(out.results[0].worktree_status).toBe(wt.WORKTREE_STATUS.DONE);
  });

  test('(F2) DONE is NOT a resume target (skipped)', () => {
    seedRun('rdone', { status: wt.WORKTREE_STATUS.DONE });
    const out = withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SYNC_SCENARIO: 'ok', FAKE_GK_SCENARIO: 'ok' },
      () => wt.resumeWorktrees({ project: PROJECT, taskIds: ['rdone'], config: { base: 'develop' }, cwd: main }));
    expect(out.results[0].action).toBe('skip');
  });

  test('dirty worktree → skipped, stays NEEDS_FIX with guidance', () => {
    const p = linkedWorktree('rd'); created.push(p);
    seedRun('rd', { status: wt.WORKTREE_STATUS.NEEDS_FIX, worktree: p });
    writeFileSync(join(p, 'dirty.txt'), 'uncommitted\n'); // make it dirty

    const out = withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SYNC_SCENARIO: 'ok' },
      () => wt.resumeWorktrees({ project: PROJECT, taskIds: ['rd'], config: { base: 'develop' }, cwd: main }));

    expect(out.results[0].action).toBe('skip');
    expect(out.results[0].reason).toMatch(/uncommitted/);
    expect(wt.readRun(PROJECT, 'rd').worktree_status).toBe(wt.WORKTREE_STATUS.NEEDS_FIX);
  });

  test('gk sync conflict → BLOCKED with resume/abort remedies, no finish', () => {
    const p = linkedWorktree('rc'); created.push(p);
    seedRun('rc', { status: wt.WORKTREE_STATUS.NEEDS_FIX, worktree: p });

    const out = withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SYNC_SCENARIO: 'conflict' },
      () => wt.resumeWorktrees({ project: PROJECT, taskIds: ['rc'], config: { base: 'develop' }, cwd: main }));

    expect(out.results[0].action).toBe('blocked');
    const run = wt.readRun(PROJECT, 'rc');
    expect(run.worktree_status).toBe(wt.WORKTREE_STATUS.BLOCKED);
    expect(run.recover.some((r) => /--abort/.test(r.command))).toBe(true);
  });

  test('BLOCKED (after-gate paused) is refused with guidance, not auto-run', () => {
    seedRun('rb', { status: wt.WORKTREE_STATUS.BLOCKED });
    wt.updateRun(PROJECT, 'rb', { recover: [{ command: 'GK_AGENT=1 git-kit worktree finish --to develop --resume-accept --cleanup', safety: 'safe' }] });

    const out = withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SYNC_SCENARIO: 'ok', FAKE_GK_SCENARIO: 'ok' },
      () => wt.resumeWorktrees({ project: PROJECT, taskIds: ['rb'], config: { base: 'develop' }, cwd: main }));

    expect(out.results[0].action).toBe('skip');
    expect(out.results[0].reason).toMatch(/not auto-resumable/);
    expect(out.results[0].guidance).toMatch(/resume-accept/);
    // still BLOCKED — nothing was executed
    expect(wt.readRun(PROJECT, 'rb').worktree_status).toBe(wt.WORKTREE_STATUS.BLOCKED);
  });

  test('no taskIds → resumes all NEEDS_FIX/MERGING tasks', () => {
    seedRun('rm1', { status: wt.WORKTREE_STATUS.MERGING });
    seedRun('rm2', { status: wt.WORKTREE_STATUS.DONE }); // not a target
    const p = linkedWorktree('rm1b'); created.push(p);
    // point rm1 at a real worktree so sync/dirty run on git plumbing
    wt.updateRun(PROJECT, 'rm1', { worktree: p });

    const out = withEnv({ X_BUILD_GK_ARGV: GK_ARGV, FAKE_GK_SYNC_SCENARIO: 'ok', FAKE_GK_SCENARIO: 'ok' },
      () => wt.resumeWorktrees({ project: PROJECT, config: { base: 'develop' }, cwd: main }));

    const ids = out.results.map((r) => r.task_id);
    expect(ids).toContain('rm1');
    expect(ids).not.toContain('rm2'); // DONE is skipped from default set
  });
});
