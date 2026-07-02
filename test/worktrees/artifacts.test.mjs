/**
 * Artifact-layer tests for the worktree pipeline: run.json / preflight.json
 * schema, path rules, atomic writes, and X_BUILD_ROOT env resolution.
 *
 * X_BUILD_ROOT must be set BEFORE importing core (ROOT is captured at import),
 * mirroring test/core-unit.test.mjs. So we set env, then dynamic-import the
 * module under test.
 */
import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORIG_X_BUILD_ROOT = process.env.X_BUILD_ROOT;
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'xb-wt-'));
process.env.X_BUILD_ROOT = TEST_ROOT;

const wt = await import('../../x-build/lib/x-build/worktrees.mjs');

afterAll(() => {
  if (ORIG_X_BUILD_ROOT !== undefined) process.env.X_BUILD_ROOT = ORIG_X_BUILD_ROOT;
  else delete process.env.X_BUILD_ROOT;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

const PROJECT = 'demo';
const TASK = 't3';

beforeEach(() => {
  // clean project dir between tests
  const dir = join(TEST_ROOT, 'projects', PROJECT);
  rmSync(dir, { recursive: true, force: true });
});

describe('path rules', () => {
  test('run.json path: <root>/projects/<project>/worktrees/<task-id>/run.json', () => {
    const p = wt.runJsonPath(PROJECT, TASK);
    expect(p).toBe(join(TEST_ROOT, 'projects', PROJECT, 'worktrees', TASK, 'run.json'));
  });

  test('preflight.json path: <root>/projects/<project>/worktrees/preflight.json', () => {
    const p = wt.preflightPath(PROJECT);
    expect(p).toBe(join(TEST_ROOT, 'projects', PROJECT, 'worktrees', 'preflight.json'));
  });

  test('honors X_BUILD_ROOT env (resolved under TEST_ROOT)', () => {
    expect(wt.runJsonPath(PROJECT, TASK).startsWith(TEST_ROOT)).toBe(true);
  });
});

describe('run.json schema', () => {
  test('newRunRecord has all minimal plan fields with safe defaults', () => {
    const r = wt.newRunRecord({ task_id: TASK, branch: 'feat/t3', worktree: '/wt/t3', base: 'develop' });
    expect(r).toEqual({
      task_id: TASK,
      branch: 'feat/t3',
      worktree: '/wt/t3',
      base: 'develop',
      task_status: 'running',
      worktree_status: 'READY',
      gk_runs: [],
      panel_artifacts: [],
      gk_gate_run_id: null,
      last_error: null,
      recover: [],
    });
  });

  test('newRunRecord requires task_id', () => {
    expect(() => wt.newRunRecord({})).toThrow(/task_id/);
  });
});

describe('init / read / update helpers', () => {
  test('initRun writes and readRun round-trips', () => {
    wt.initRun(PROJECT, TASK, { branch: 'feat/t3', base: 'develop' });
    const r = wt.readRun(PROJECT, TASK);
    expect(r.task_id).toBe(TASK);
    expect(r.branch).toBe('feat/t3');
    expect(r.worktree_status).toBe('READY');
  });

  test('readRun returns null when absent', () => {
    expect(wt.readRun(PROJECT, 'nope')).toBe(null);
  });

  test('updateRun (object patch) shallow-merges', () => {
    wt.initRun(PROJECT, TASK);
    const r = wt.updateRun(PROJECT, TASK, { worktree_status: 'RUNNING' });
    expect(r.worktree_status).toBe('RUNNING');
    expect(r.task_status).toBe('running'); // untouched
  });

  test('updateRun (function patch) sees current record', () => {
    wt.initRun(PROJECT, TASK);
    const r = wt.updateRun(PROJECT, TASK, (cur) => ({ ...cur, gk_runs: [...cur.gk_runs, { at: 'x' }] }));
    expect(r.gk_runs.length).toBe(1);
  });

  test('updateRun throws if record missing (no silent resurrect)', () => {
    expect(() => wt.updateRun(PROJECT, 'ghost', { worktree_status: 'RUNNING' })).toThrow(/no run.json/);
  });
});

describe('recordGkFinish composition', () => {
  test('ok envelope folds to completed / DONE and appends gk_runs', () => {
    wt.initRun(PROJECT, TASK, { base: 'develop' });
    const envelope = {
      state: 'ok', ok: true,
      result: { gate: { phase: 'before', before: 'passed', merged: true, run_id: 'RID-1' } },
      error: null,
    };
    const r = wt.recordGkFinish(PROJECT, TASK, envelope);
    expect(r.task_status).toBe('completed');
    expect(r.worktree_status).toBe('DONE');
    expect(r.gk_gate_run_id).toBe('RID-1');
    expect(r.gk_runs.length).toBe(1);
    expect(r.gk_runs[0].envelope).toEqual(envelope);
  });

  test('after-gate paused persists recover[] and keeps running', () => {
    wt.initRun(PROJECT, TASK);
    const envelope = {
      state: 'paused', ok: false,
      result: { gate: { paused: true, merged: true, patch: '/p.patch', run_id: 'RID-2',
        recover: [{ command: 'x', safety: 'safe' }] } },
      error: null,
    };
    const r = wt.recordGkFinish(PROJECT, TASK, envelope);
    expect(r.task_status).toBe('running');
    expect(r.worktree_status).toBe('BLOCKED');
    expect(r.recover.length).toBe(1);
  });
});

describe('atomicity', () => {
  test('writes leave no .tmp residue', () => {
    wt.initRun(PROJECT, TASK);
    wt.updateRun(PROJECT, TASK, { worktree_status: 'RUNNING' });
    const dir = wt.worktreeRunDir(PROJECT, TASK);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    expect(existsSync(wt.runJsonPath(PROJECT, TASK))).toBe(true);
  });

  test('preflight read/write round-trips atomically', () => {
    wt.writePreflight(PROJECT, { gate_capable: true, panel_ok: true, checked_at: 'now' });
    const r = wt.readPreflight(PROJECT);
    expect(r.gate_capable).toBe(true);
    const dir = wt.worktreesDir(PROJECT);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
