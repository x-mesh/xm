/**
 * t5 — `worktrees plan` (dry-run) + capability preflight + degraded mode.
 *
 * Pure planning (batch selection, branch collision, gk command strings) is
 * tested by direct import. The "gk is never executed" invariant + degraded mode
 * are tested by spawning the CLI in a temp git repo with an injected fake gk
 * (X_BUILD_GK_ARGV) — so no real git-kit is ever touched and `git worktree list`
 * must not change.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planWorktrees, selectReadyTasks, WORKTREE_CONFIG_DEFAULTS,
} from '../../x-build/lib/x-build/worktrees.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'x-build', 'lib', 'x-build-cli.mjs');
const FAKE_GK = join(__dirname, 'fake-gk.mjs');

// ── pure: batch selection ────────────────────────────────────────────

describe('planWorktrees — batch selection', () => {
  const cfg = { ...WORKTREE_CONFIG_DEFAULTS, base: 'develop', branch_prefix: 'feat/', max_parallel: 2 };

  test('non-overlapping tasks with files → parallel batches; overlapping/unknown → sequential', () => {
    const tasks = [
      { id: 't1', name: 'Alpha', expected_files: ['a.mjs'] },
      { id: 't2', name: 'Beta', expected_files: ['b.mjs'] },
      { id: 't3', name: 'Gamma', expected_files: ['a.mjs'] },   // overlaps t1 → sequential (both)
      { id: 't4', name: 'Delta' },                              // no expected_files → sequential
    ];
    const plan = planWorktrees({ project: 'p', tasks, config: cfg });
    // t2 is the only safe one (t1∩t3 overlap; t4 unknown)
    expect(plan.parallel_batches).toEqual([['t2']]);
    expect(plan.sequential.sort()).toEqual(['t1', 't3', 't4']);
    expect(plan.reason).toContain('a.mjs');
  });

  test('safe tasks are chunked by max_parallel', () => {
    const tasks = [
      { id: 't1', name: 'A', expected_files: ['a'] },
      { id: 't2', name: 'B', expected_files: ['b'] },
      { id: 't3', name: 'C', expected_files: ['c'] },
    ];
    const plan = planWorktrees({ project: 'p', tasks, config: { ...cfg, max_parallel: 2 } });
    expect(plan.parallel_batches).toEqual([['t1', 't2'], ['t3']]);
  });
});

// ── pure: branch names + collision ───────────────────────────────────

describe('planWorktrees — branch names + collision', () => {
  const cfg = { ...WORKTREE_CONFIG_DEFAULTS, branch_prefix: 'feat/', base: 'develop' };

  test('branch = <prefix><task-id>-<slug>', () => {
    const plan = planWorktrees({ project: 'p', tasks: [{ id: 't1', name: 'Search Index!', expected_files: ['a'] }], config: cfg });
    expect(plan.tasks[0].branch).toBe('feat/t1-search-index');
  });

  test('collision against existing branches → deterministic -2/-3 suffix', () => {
    const tasks = [{ id: 't1', name: 'Foo', expected_files: ['a'] }];
    const plan = planWorktrees({
      project: 'p', tasks, config: cfg,
      existingBranches: ['feat/t1-foo', 'feat/t1-foo-2'],
    });
    expect(plan.tasks[0].branch).toBe('feat/t1-foo-3');
  });

  test('gk command strings embed project literal + gate template vars', () => {
    const plan = planWorktrees({ project: 'demo', tasks: [{ id: 't1', name: 'Foo', expected_files: ['a'] }], config: cfg });
    const t = plan.tasks[0];
    expect(t.acquire).toBe('GK_AGENT=1 git-kit worktree acquire feat/t1-foo --from develop');
    expect(t.finish).toContain('--to develop');
    expect(t.finish).toContain('--project demo');
    expect(t.finish).toContain('{phase}');   // literal gk template var, not interpolated
    expect(t.finish).toContain('{patch}');
    expect(t.finish).toContain('--gate-phase before');
  });

  test('worktree_hint derives from worktreeBase when provided', () => {
    const plan = planWorktrees({ project: 'p', tasks: [{ id: 't1', name: 'Foo', expected_files: ['a'] }], config: cfg, worktreeBase: '/base' });
    expect(plan.tasks[0].worktree_hint).toBe('/base/feat/t1-foo');
  });

  test("gate_phase 'release' defers gating: finish command carries NO --gate (plan §3B)", () => {
    const plan = planWorktrees({
      project: 'demo', tasks: [{ id: 't1', name: 'Foo', expected_files: ['a'] }],
      config: { ...cfg, gate_phase: 'release' },
    });
    expect(plan.gate_deferred).toBe(true);
    const t = plan.tasks[0];
    expect(t.finish).toContain('--to develop');
    // 'release' must never leak into gk (--gate-phase only accepts before|after|both)
    expect(t.finish).not.toContain('--gate');
    expect(t.finish).not.toContain('--gate-phase');
  });

  test("default gate_phase 'before' keeps the gate (gate_deferred=false)", () => {
    const plan = planWorktrees({ project: 'demo', tasks: [{ id: 't1', name: 'Foo', expected_files: ['a'] }], config: cfg });
    expect(plan.gate_deferred).toBe(false);
    expect(plan.tasks[0].finish).toContain('--gate ');
  });
});

// ── pure: degraded mode + ready selection ────────────────────────────

describe('degraded mode + selectReadyTasks', () => {
  test('degraded=true → mode manual-handoff', () => {
    const plan = planWorktrees({ project: 'p', tasks: [], config: WORKTREE_CONFIG_DEFAULTS, degraded: true });
    expect(plan.mode).toBe('manual-handoff');
    expect(plan.degraded).toBe(true);
  });

  test('selectReadyTasks picks pending/ready with completed deps', () => {
    const taskData = { tasks: [
      { id: 't1', status: 'completed', depends_on: [] },
      { id: 't2', status: 'pending', depends_on: ['t1'] },   // dep done → ready
      { id: 't3', status: 'pending', depends_on: ['t2'] },   // dep not done → not ready
      { id: 't4', status: 'running', depends_on: [] },       // wrong status
    ] };
    const ready = selectReadyTasks(taskData).map(t => t.id);
    expect(ready).toEqual(['t2']);
  });
});

// ── integration: CLI never executes gk (worktree list invariant) ─────

describe('worktrees plan CLI — no gk execution', () => {
  let repo;

  const gitq = (c) => execSync(`git ${c}`, { cwd: repo, stdio: 'pipe', shell: '/bin/bash' });
  const worktreeList = () => execSync('git worktree list', { cwd: repo, encoding: 'utf8' }).trim().split('\n').length;

  function runPlan(extraEnv = {}, extraArgs = []) {
    const env = {
      ...process.env, NO_COLOR: '1',
      X_BUILD_ROOT: join(repo, '.xm', 'build'),
      X_BUILD_GK_ARGV: JSON.stringify(['node', FAKE_GK]),
      // fake `panel doctor` (node -e ignores the trailing doctor/--json args).
      X_BUILD_PANEL_ARGV: JSON.stringify(['node', '-e', "process.stdout.write(JSON.stringify({ok:true}))"]),
      ...extraEnv,
    };
    return spawnSync('node', [CLI, 'worktrees', 'plan', '--json', '--project', 'demo', ...extraArgs], { cwd: repo, env, encoding: 'utf8' });
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'wt-plan-'));
    gitq('init -q');
    gitq('config user.email t@t.com');
    gitq('config user.name T');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    gitq('add -A && git commit -q -m c1');
    gitq('branch develop');

    // Minimal project + tasks.json with two parallel-safe ready tasks.
    const planDir = join(repo, '.xm', 'build', 'projects', 'demo', 'phases', '02-plan');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(join(planDir, 'tasks.json'), JSON.stringify({ tasks: [
      { id: 't1', name: 'Alpha', status: 'pending', depends_on: [], expected_files: ['a.mjs'] },
      { id: 't2', name: 'Beta', status: 'pending', depends_on: [], expected_files: ['b.mjs'] },
    ] }));
  });

  afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

  test('plan runs, emits batches, and does NOT create a worktree', () => {
    const before = worktreeList();
    const r = runPlan();
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.parallel_batches).toEqual([['t1', 't2']]);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.degraded).toBe(false);
    // fake gk finish --help advertises --gate → not degraded
    expect(plan.preflight.gate_capable).toBe(true);
    // invariant: git worktree list unchanged (no acquire executed)
    expect(worktreeList()).toBe(before);
  });

  test('degraded mode when gk gate surface is missing', () => {
    const before = worktreeList();
    const r = runPlan({ FAKE_GK_NO_GATE: '1' });
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.degraded).toBe(true);
    expect(plan.mode).toBe('manual-handoff');
    expect(worktreeList()).toBe(before);
  });
});
