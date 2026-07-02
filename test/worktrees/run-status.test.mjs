/**
 * run-status --json worktree_tasks[] exposure + stale-reconcile protection.
 *
 * Covers plan "상태 모델" + "검증 계획" reconcile items:
 *   (a) run-status --json exposes worktree_tasks[] with the plan fields.
 *   (b) a NEEDS_FIX RUNNING task is protected from stale reconcile.
 *   (c) a stale RUNNING task with no worktree artifact still reclaims to pending.
 *   (d) a stale RUNNING task whose worktree path is gone is reclaimed.
 *
 * Driven via the CLI as a subprocess (like phase-verify.test.mjs): core.ROOT is
 * captured at import, so in-process tests sharing bun's module registry would
 * see another file's root. A fresh `node` process per call reads ROOT from
 * cwd/.xm/build cleanly.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', '..', 'x-build', 'lib', 'x-build-cli.mjs');

const NAME = 'rs-demo';
const STALE_TS = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago (>30m)

let tmp;
let LIVE_WT;

function run(args) {
  const r = spawnSync('node', [CLI_PATH, ...args], {
    cwd: tmp,
    env: { ...process.env, XKIT_SERVER: undefined },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

function proj(...segments) {
  return join(tmp, '.xm', 'build', 'projects', NAME, ...segments);
}

function writeJSON(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}

function newRun(fields) {
  return {
    task_id: fields.task_id,
    branch: fields.branch ?? null,
    worktree: fields.worktree ?? null,
    base: fields.base ?? 'develop',
    task_status: 'running',
    worktree_status: fields.worktree_status ?? 'RUNNING',
    gk_runs: [],
    panel_artifacts: [],
    gk_gate_run_id: fields.gk_gate_run_id ?? null,
    last_error: fields.last_error ?? null,
    recover: [],
  };
}

function setupProject() {
  tmp = mkdtempSync(join(tmpdir(), 'xb-rs-'));
  LIVE_WT = join(tmp, 'live-wt');
  mkdirSync(LIVE_WT, { recursive: true });

  writeJSON(proj('manifest.json'), {
    display_name: NAME,
    current_phase: '03-execute',
    updated_at: new Date().toISOString(),
  });
  writeJSON(proj('phases', '02-plan', 'tasks.json'), {
    tasks: [
      { id: 't1', name: 'Setup', status: 'completed', size: 'small', depends_on: [] },
      { id: 't2', name: 'Auth', status: 'running', size: 'medium', depends_on: [], started_at: STALE_TS },
      { id: 't3', name: 'Search', status: 'running', size: 'small', depends_on: [], started_at: STALE_TS },
      { id: 't4', name: 'Index', status: 'running', size: 'small', depends_on: [], started_at: STALE_TS },
    ],
  });
  writeJSON(proj('phases', '02-plan', 'steps.json'), {
    steps: [
      { id: 's1', tasks: ['t1'] },
      { id: 's2', tasks: ['t2', 't3', 't4'] },
    ],
  });

  // t2 → NEEDS_FIX with a live worktree dir (protected from reconcile)
  writeJSON(proj('worktrees', 't2', 'run.json'), newRun({
    task_id: 't2', branch: 'feat/t2-auth', worktree: LIVE_WT,
    worktree_status: 'NEEDS_FIX', gk_gate_run_id: 'RID-t2',
    last_error: { code: 'worktree_gate_before_failed' },
  }));
  // t4 → artifact present but worktree path missing (lost → reclaimable)
  writeJSON(proj('worktrees', 't4', 'run.json'), newRun({
    task_id: 't4', branch: 'feat/t4-index', worktree: join(tmp, 'gone', 't4'),
    worktree_status: 'RUNNING',
  }));
  // t3 → intentionally no artifact (orphan → reclaimable)
}

beforeEach(setupProject);
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('run-status --json worktree_tasks[]', () => {
  test('(a) exposes worktree_tasks with plan fields', () => {
    const out = JSON.parse(run(['run-status', '--json']).stdout);
    expect(Array.isArray(out.worktree_tasks)).toBe(true);
    const t2 = out.worktree_tasks.find((w) => w.task_id === 't2');
    expect(t2).toBeDefined();
    expect(Object.keys(t2).sort()).toEqual(
      ['branch', 'gk_gate_run_id', 'last_error', 'task_id', 'task_status', 'worktree', 'worktree_status'].sort(),
    );
    expect(t2.branch).toBe('feat/t2-auth');
    expect(t2.worktree_status).toBe('NEEDS_FIX');
    expect(t2.gk_gate_run_id).toBe('RID-t2');
    expect(t2.last_error.code).toBe('worktree_gate_before_failed');
  });

  test('worktree_tasks is empty [] when no artifacts (back-compat fields kept)', () => {
    rmSync(proj('worktrees'), { recursive: true, force: true });
    const out = JSON.parse(run(['run-status', '--json']).stdout);
    expect(out.worktree_tasks).toEqual([]);
    expect(out).toHaveProperty('steps');
    expect(out).toHaveProperty('stale_running');
    expect(out).toHaveProperty('next_action');
  });

  test('next_action = worktrees resume when only NEEDS_FIX remains (no stale orphans)', () => {
    // Make t3/t4 non-stale so stale_running empties; t2 NEEDS_FIX stays protected.
    writeJSON(proj('phases', '02-plan', 'tasks.json'), {
      tasks: [
        { id: 't1', name: 'Setup', status: 'completed', size: 'small', depends_on: [] },
        { id: 't2', name: 'Auth', status: 'running', size: 'medium', depends_on: [], started_at: STALE_TS },
        { id: 't3', name: 'Search', status: 'running', size: 'small', depends_on: [], started_at: new Date().toISOString() },
        { id: 't4', name: 'Index', status: 'running', size: 'small', depends_on: [], started_at: new Date().toISOString() },
      ],
    });
    const out = JSON.parse(run(['run-status', '--json']).stdout);
    expect(out.stale_running).toEqual([]);
    expect(out.next_action).toContain('worktrees resume');
    expect(out.next_action).toContain('t2');
  });
});

describe('run --reconcile stale protection', () => {
  test('(b) NEEDS_FIX protected; (c) orphan + (d) lost-worktree reclaimed', () => {
    const out = JSON.parse(run(['run', '--reconcile', '--json']).stdout);
    expect(out.reconciled.sort()).toEqual(['t3', 't4']);
    expect(out.count).toBe(2);
    expect(out.protected.map((p) => p.id)).toEqual(['t2']);
    expect(out.protected[0].worktree_status).toBe('NEEDS_FIX');

    const data = JSON.parse(readFileSync(proj('phases', '02-plan', 'tasks.json'), 'utf8'));
    const byId = Object.fromEntries(data.tasks.map((t) => [t.id, t]));
    expect(byId.t2.status).toBe('running');
    expect(byId.t3.status).toBe('pending');
    expect(byId.t4.status).toBe('pending');
  });

  test('(F8) stale RUNNING with run.json but null/empty worktree path → reclaimed', () => {
    // A run.json exists but acquire never produced a worktree (e.g. BLOCKED
    // acquire). Previously read as "active" and never reclaimable; now the empty
    // path marks it reclaimable regardless of worktree_status.
    writeJSON(proj('phases', '02-plan', 'tasks.json'), {
      tasks: [
        { id: 't5', name: 'NullPath', status: 'running', size: 'small', depends_on: [], started_at: STALE_TS },
        { id: 't6', name: 'EmptyPath', status: 'running', size: 'small', depends_on: [], started_at: STALE_TS },
      ],
    });
    writeJSON(proj('worktrees', 't5', 'run.json'), newRun({ task_id: 't5', worktree: null, worktree_status: 'BLOCKED' }));
    writeJSON(proj('worktrees', 't6', 'run.json'), newRun({ task_id: 't6', worktree: '   ', worktree_status: 'MERGING' }));

    const out = JSON.parse(run(['run', '--reconcile', '--json']).stdout);
    expect(out.reconciled.sort()).toEqual(['t5', 't6']);
    expect(out.protected.map((p) => p.id)).not.toContain('t5');
    expect(out.protected.map((p) => p.id)).not.toContain('t6');

    const data = JSON.parse(readFileSync(proj('phases', '02-plan', 'tasks.json'), 'utf8'));
    expect(data.tasks.find((t) => t.id === 't5').status).toBe('pending');
    expect(data.tasks.find((t) => t.id === 't6').status).toBe('pending');
  });

  test('dry-run reports the same partition without writing', () => {
    const out = JSON.parse(run(['run', '--reconcile', '--dry-run', '--json']).stdout);
    expect(out.dry_run).toBe(true);
    expect(out.reconciled.sort()).toEqual(['t3', 't4']);
    expect(out.protected.map((p) => p.id)).toEqual(['t2']);
    // no write: t3 still running
    const data = JSON.parse(readFileSync(proj('phases', '02-plan', 'tasks.json'), 'utf8'));
    expect(data.tasks.find((t) => t.id === 't3').status).toBe('running');
  });
});
