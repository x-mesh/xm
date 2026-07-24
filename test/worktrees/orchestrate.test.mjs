/**
 * t10 — `run --worktrees` orchestration wiring + worktree_signal + config
 * resolution priority.
 *
 * gk is faked via X_BUILD_GK_ARGV → fake-gk.mjs. No real git-kit or panel runs.
 * The CLI paths are exercised as a subprocess in a temp git repo (core.ROOT is
 * import-time bound, so a fresh `node` per call reads the right root). The
 * config-priority + signal-recomputation logic is unit-tested by direct import.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { execSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', '..', 'x-build', 'lib', 'x-build-cli.mjs');
const FAKE_GK = join(__dirname, 'fake-gk.mjs');
const GK_ARGV = JSON.stringify(['node', FAKE_GK]);
// fake `panel doctor` — node -e ignores the trailing doctor/--json args.
const PANEL_ARGV = JSON.stringify(['node', '-e', "process.stdout.write(JSON.stringify({ok:true}))"]);

const shared = await import('../../x-build/lib/x-build/worktree-shared.mjs');

const NAME = 'demo';
const gitq = (cwd, c) => execSync(`git ${c}`, { cwd, stdio: 'pipe', shell: '/bin/bash' });

// ── CLI integration: run --worktrees ─────────────────────────────────

describe('run --worktrees CLI', () => {
  let repo;
  let wt1, wt2; // real linked worktrees the fake gk "returns" from acquire

  function proj(...segs) {
    return join(repo, '.xm', 'build', 'projects', NAME, ...segs);
  }
  function writeJSON(p, data) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(data, null, 2));
  }
  const worktreeCount = () => execSync('git worktree list', { cwd: repo, encoding: 'utf8' }).trim().split('\n').length;

  function run(extraArgs, extraEnv = {}) {
    const env = {
      ...process.env, NO_COLOR: '1', XKIT_SERVER: undefined,
      X_BUILD_ROOT: join(repo, '.xm', 'build'),
      X_BUILD_GK_ARGV: GK_ARGV,
      X_BUILD_PANEL_ARGV: PANEL_ARGV,
      FAKE_GK_SCENARIO: 'ok',
      ...extraEnv,
    };
    const r = spawnSync('node', [CLI, 'run', '--project', NAME, ...extraArgs], { cwd: repo, env, encoding: 'utf8' });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
  }

  // Two parallel-safe ready tasks (non-overlapping expected_files).
  function seedTasks(tasks) {
    writeJSON(proj('phases', '02-plan', 'tasks.json'), { tasks });
    writeJSON(proj('phases', '02-plan', 'steps.json'), {
      steps: [{ id: 's1', tasks: tasks.map((t) => t.id) }],
    });
  }

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'wt-orch-'));
    gitq(repo, 'init -q');
    gitq(repo, 'config user.email t@t.com');
    gitq(repo, 'config user.name T');
    writeFileSync(join(repo, 'f.txt'), 'x\n');
    gitq(repo, 'add -A && git commit -q -m c1');
    gitq(repo, 'branch develop');

    writeJSON(proj('manifest.json'), {
      display_name: NAME, current_phase: '03-execute', updated_at: new Date().toISOString(),
    });
    seedTasks([
      { id: 't1', name: 'Alpha', status: 'pending', size: 'small', depends_on: [], expected_files: ['a.mjs'] },
      { id: 't2', name: 'Beta', status: 'pending', size: 'small', depends_on: [], expected_files: ['b.mjs'] },
    ]);

    // Real linked worktrees so acquire's snapshot + info/exclude use true git.
    // Create them on NON-colliding branch names (slot-*): the plan now avoids
    // pre-existing local branches (F9 existingBranches), so if these were named
    // feat/t1-alpha the plan would suffix to feat/t1-alpha-2 and the acquire map
    // key would no longer match. The map keys stay the plan branches; the paths
    // are just real worktrees for the snapshot/exclude to write into.
    wt1 = join(repo, '..', `wt-orch-t1-${Date.now()}`);
    wt2 = join(repo, '..', `wt-orch-t2-${Date.now()}`);
    gitq(repo, `worktree add -q -b slot-a ${JSON.stringify(wt1)} develop`);
    gitq(repo, `worktree add -q -b slot-b ${JSON.stringify(wt2)} develop`);
  });

  afterAll(() => {
    for (const p of [wt1, wt2]) { try { gitq(repo, `worktree remove --force ${JSON.stringify(p)}`); } catch {} }
    for (const d of [repo, wt1, wt2]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  // Reset task/step state between tests (some tests mutate tasks.json to RUNNING).
  beforeEach(() => {
    seedTasks([
      { id: 't1', name: 'Alpha', status: 'pending', size: 'small', depends_on: [], expected_files: ['a.mjs'] },
      { id: 't2', name: 'Beta', status: 'pending', size: 'small', depends_on: [], expected_files: ['b.mjs'] },
    ]);
    try { rmSync(proj('worktrees'), { recursive: true, force: true }); } catch {}
  });

  test('--dry-run: no gk acquire, plan JSON schema', () => {
    const before = worktreeCount();
    const r = run(['--worktrees', '--dry-run']);
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.mode).toBe('dry-run');
    // ui_mode must not overwrite the worktree backend's `mode` marker (t13).
    expect(['developer', 'normal']).toContain(plan.ui_mode);
    expect(typeof plan.autopilot).toBe('boolean');
    expect(plan.degraded).toBe(false);
    expect(plan.parallel_batches).toEqual([['t1', 't2']]);
    expect(plan.tasks).toHaveLength(2);
    expect(plan.tasks[0].acquire).toContain('git-kit worktree acquire');
    // Legacy projects have no final group lifecycle, so they retain the
    // per-task gate instead of silently deferring it to a nonexistent review.
    expect(plan.tasks[0].finish).toContain('--gate');
    expect(plan.worktree_signal.recommend).toBe(true);
    // invariant: dry-run created no worktree, tasks.json untouched (still pending)
    expect(worktreeCount()).toBe(before);
    const tasks = JSON.parse(readFileSync(proj('phases', '02-plan', 'tasks.json'), 'utf8'));
    expect(tasks.tasks.every((t) => t.status === 'pending' || t.status === 'ready')).toBe(true);
    expect(tasks.tasks.some((t) => t.status === 'running')).toBe(false);
  });

  test('--dry-run does not bind a planned lifecycle review-group baseline', () => {
    writeJSON(proj('phases', '02-plan', 'plan-state.json'), { status: 'approved' });
    const statePath = proj('phases', '03-execute', 'review-groups.json');
    try { rmSync(statePath, { force: true }); } catch {}

    const r = run(['--worktrees', '--dry-run']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).mode).toBe('dry-run');
    expect(existsSync(statePath)).toBe(false);

    rmSync(proj('phases', '02-plan', 'plan-state.json'), { force: true });
  });

  test('real: fan-out acquires batch, marks RUNNING, inits run.json + env', () => {
    const map = JSON.stringify({ 'feat/t1-alpha': wt1, 'feat/t2-beta': wt2 });
    const r = run(['--worktrees', '--max-parallel', '4'], { FAKE_GK_ACQUIRE_MAP: map });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.mode).toBe('worktree');
    expect(out.finish.auto).toBe(false);
    expect(out.tasks).toHaveLength(2);

    for (const entry of out.tasks) {
      expect(entry.acquired).toBe(true);
      expect(entry.worktree_status).toBe('WORKTREE_CREATED');
      expect(entry.branch).toMatch(/^feat\/t[12]-/);
      // root env injection: all three roots present, pointing at main .xm/
      expect(Object.keys(entry.env).sort()).toEqual(['X_BUILD_ROOT', 'X_PANEL_ROOT', 'XM_ROOT'].sort());
      expect(entry.env.X_BUILD_ROOT).toBe(join(repo, '.xm', 'build'));
      expect(entry.env.XM_ROOT).toBe(join(repo, '.xm'));
      expect(typeof entry.prompt).toBe('string'); // agent prompt present
    }

    // tasks.json → RUNNING; run.json initialized WORKTREE_CREATED; NOT completed.
    const tasks = JSON.parse(readFileSync(proj('phases', '02-plan', 'tasks.json'), 'utf8'));
    expect(tasks.tasks.find((t) => t.id === 't1').status).toBe('running');
    expect(tasks.tasks.find((t) => t.id === 't2').status).toBe('running');

    for (const id of ['t1', 't2']) {
      const run = JSON.parse(readFileSync(proj('worktrees', id, 'run.json'), 'utf8'));
      expect(run.worktree_status).toBe('WORKTREE_CREATED');
      expect(run.task_status).toBe('running'); // finish not auto-run → not completed
      expect(run.gk_runs).toEqual([]);         // no finish invocation recorded
    }
    // TASK-CONTEXT snapshot dropped into the worktree.
    expect(existsSync(join(wt1, 'TASK-CONTEXT.md'))).toBe(true);
  });

  test('(F1) worktree entries carry no task-status mutation; prompt forbids self-mark', () => {
    const map = JSON.stringify({ 'feat/t1-alpha': wt1, 'feat/t2-beta': wt2 });
    const out = JSON.parse(run(['--worktrees', '--max-parallel', '4'], { FAKE_GK_ACQUIRE_MAP: map }).stdout);
    for (const entry of out.tasks) {
      // no on_complete/on_fail — the gk finish gate is the ONLY completion path.
      expect(entry.on_complete).toBeUndefined();
      expect(entry.on_fail).toBeUndefined();
      expect(typeof entry.completion_note).toBe('string');
      // prompt must NOT tell the agent to run `tasks update ... completed`.
      expect(entry.prompt).not.toContain('tasks update');
      expect(entry.prompt).toContain('Do NOT mark the task complete');
    }
  });

  test('(F4/F5) no parallel-safe task → sequential fallback acquires one', () => {
    // Both tasks touch the same file → no parallel batch; the pipeline must still
    // make progress by acquiring the first sequential task alone.
    seedTasks([
      { id: 't1', name: 'Alpha', status: 'pending', size: 'small', depends_on: [], expected_files: ['shared.mjs'] },
      { id: 't2', name: 'Beta', status: 'pending', size: 'small', depends_on: [], expected_files: ['shared.mjs'] },
    ]);
    const map = JSON.stringify({ 'feat/t1-alpha': wt1 });
    const out = JSON.parse(run(['--worktrees', '--max-parallel', '4'], { FAKE_GK_ACQUIRE_MAP: map }).stdout);
    expect(out.mode).toBe('worktree');
    expect(out.sequential_fallback).toBe(true);
    expect(out.parallel).toBe(false);
    expect(out.parallel_batches ?? out.batches).toEqual([]);
    expect(out.sequential).toEqual(['t1', 't2']);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0].task_id).toBe('t1');
    expect(out.tasks[0].acquired).toBe(true);
    // only the acquired task flips to running
    const tasks = JSON.parse(readFileSync(proj('phases', '02-plan', 'tasks.json'), 'utf8'));
    expect(tasks.tasks.find((t) => t.id === 't1').status).toBe('running');
    expect(tasks.tasks.find((t) => t.id === 't2').status).not.toBe('running');
  });

  test('(F9) existing local branch collision → planned branch suffixed', () => {
    gitq(repo, 'branch feat/t1-alpha develop'); // pre-existing collision
    try {
      const plan = JSON.parse(run(['--worktrees', '--dry-run']).stdout);
      const t1 = plan.tasks.find((t) => t.task_id === 't1');
      expect(t1.branch).toBe('feat/t1-alpha-2'); // avoided the existing branch
    } finally {
      gitq(repo, 'branch -D feat/t1-alpha');
    }
  });

  test('legacy project keeps the per-task gate and degrades when it is unavailable', () => {
    const before = worktreeCount();
    const r = run(['--worktrees'], { FAKE_GK_NO_GATE: '1' });
    expect(r.status).toBe(0);
    const plan = JSON.parse(r.stdout);
    expect(plan.degraded).toBe(true);
    expect(plan.mode).toBe('manual-handoff');
    expect(existsSync(proj('worktrees', 't1', 'run.json'))).toBe(false);
    expect(worktreeCount()).toBe(before);
  });

  test('planned group lifecycle does not require the unused per-task gk gate capability', () => {
    const planState = proj('phases', '02-plan', 'plan-state.json');
    writeFileSync(planState, JSON.stringify({ version: 1, state: 'approved' }));
    try {
      const r = run(['--worktrees'], { FAKE_GK_NO_GATE: '1' });
      expect(r.status).toBe(0);
      const plan = JSON.parse(r.stdout);
      expect(plan.degraded).toBe(false);
      expect(plan.mode).toBe('worktree');
      expect(existsSync(proj('worktrees', 't1', 'run.json'))).toBe(true);
    } finally {
      rmSync(planState, { force: true });
    }
  });

  test('worktree_signal on run --json: 2 safe → recommend true', () => {
    const r = run(['--json']);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.worktree_signal).toEqual({
      enabled: true, parallel_safe_count: 2, sequential_count: 0, recommend: true,
    });
    // regression: existing run --json fields unchanged
    expect(out).toHaveProperty('tasks');
    expect(out).toHaveProperty('parallel');
    expect(out).toHaveProperty('estimated_cost_usd');
    expect(out.tasks).toHaveLength(2);
  });

  test('worktree_signal: 1 safe task → recommend false', () => {
    seedTasks([
      { id: 't1', name: 'Alpha', status: 'pending', size: 'small', depends_on: [], expected_files: ['a.mjs'] },
    ]);
    const out = JSON.parse(run(['--json']).stdout);
    expect(out.worktree_signal.parallel_safe_count).toBe(1);
    expect(out.worktree_signal.recommend).toBe(false);
  });

  test('worktree_signal: overlapping expected_files → recommend false', () => {
    seedTasks([
      { id: 't1', name: 'Alpha', status: 'pending', size: 'small', depends_on: [], expected_files: ['shared.mjs'] },
      { id: 't2', name: 'Beta', status: 'pending', size: 'small', depends_on: [], expected_files: ['shared.mjs'] },
    ]);
    const out = JSON.parse(run(['--json']).stdout);
    expect(out.worktree_signal.parallel_safe_count).toBe(0);
    expect(out.worktree_signal.sequential_count).toBe(2);
    expect(out.worktree_signal.recommend).toBe(false);
  });

  test('--no-worktrees stays on the normal path even with --worktrees absent', () => {
    // --no-worktrees + --json → normal plan (not worktree mode)
    const out = JSON.parse(run(['--json', '--no-worktrees']).stdout);
    expect(out.mode).toBeUndefined();
    expect(out.worktree_signal.enabled).toBe(false);
  });
});

// ── config resolution priority (unit) ────────────────────────────────

describe('loadWorktreeConfig — resolution priority', () => {
  let dir;
  const saved = {};

  function setEnv(vars) {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  function writeConfig(root, worktree) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'config.json'), JSON.stringify({ worktree }));
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wt-cfg-')); });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const k of Object.keys(saved)) delete saved[k];
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  test('default when no config present', () => {
    setEnv({ XM_ROOT: join(dir, 'empty', '.xm'), X_BUILD_ROOT: join(dir, 'empty', '.xm', 'build') });
    const cfg = shared.loadWorktreeConfig();
    expect(cfg.base).toBe('develop');
    expect(cfg.max_parallel).toBe(4);
    expect(cfg.gate_phase).toBe('release');
    expect(cfg.gate_deferred_to).toBe('review_group');
  });

  test('build.review_scope=task restores the per-task worktree gate', () => {
    const xm = join(dir, '.xm');
    mkdirSync(xm, { recursive: true });
    writeFileSync(join(xm, 'config.json'), JSON.stringify({ build: { review_scope: 'task' } }));
    setEnv({ XM_ROOT: xm, X_BUILD_ROOT: join(dir, 'nobuild', '.xm', 'build') });
    const cfg = shared.loadWorktreeConfig();
    expect(cfg.gate_phase).toBe('before');
    expect(cfg.gate_deferred_to).toBeUndefined();
  });

  test('shared (.xm/config.json) overrides default', () => {
    const xm = join(dir, '.xm');
    writeConfig(xm, { base: 'main' });
    setEnv({ XM_ROOT: xm, X_BUILD_ROOT: join(dir, 'nobuild', '.xm', 'build') });
    const cfg = shared.loadWorktreeConfig();
    expect(cfg.base).toBe('main');
  });

  test('build-local (.xm/build/config.json) overrides shared', () => {
    const xm = join(dir, '.xm');
    const build = join(xm, 'build');
    writeConfig(xm, { base: 'shared-base', max_parallel: 9 });
    writeConfig(build, { base: 'local-base' });
    setEnv({ XM_ROOT: xm, X_BUILD_ROOT: build });
    const cfg = shared.loadWorktreeConfig();
    expect(cfg.base).toBe('local-base');   // local wins
    expect(cfg.max_parallel).toBe(9);      // shared value retained where local silent
  });

  test('CLI flag overrides build-local', () => {
    const xm = join(dir, '.xm');
    const build = join(xm, 'build');
    writeConfig(build, { base: 'local-base' });
    setEnv({ XM_ROOT: join(dir, 'noshared', '.xm'), X_BUILD_ROOT: build });
    const cfg = shared.loadWorktreeConfig({ flags: { base: 'flag-base', max_parallel: 2 } });
    expect(cfg.base).toBe('flag-base');
    expect(cfg.max_parallel).toBe(2);
  });

  test('gate_policy merges per-key across layers', () => {
    const xm = join(dir, '.xm');
    const build = join(xm, 'build');
    writeConfig(xm, { gate_policy: { block_confirmed: ['critical'] } });
    writeConfig(build, { gate_policy: { allow_low: false } });
    setEnv({ XM_ROOT: xm, X_BUILD_ROOT: build });
    const cfg = shared.loadWorktreeConfig();
    expect(cfg.gate_policy.block_confirmed).toEqual(['critical']);       // shared
    expect(cfg.gate_policy.allow_low).toBe(false);                        // local
    expect(cfg.gate_policy.block_unreviewed).toEqual(['critical', 'high']); // default retained
  });

  test('worktreeGatePolicyConfigured true only when a layer sets gate_policy', () => {
    const xm = join(dir, '.xm');
    const build = join(xm, 'build');
    setEnv({ XM_ROOT: xm, X_BUILD_ROOT: build });
    expect(shared.worktreeGatePolicyConfigured()).toBe(false);
    writeConfig(build, { gate_policy: { allow_low: false } });
    expect(shared.worktreeGatePolicyConfigured()).toBe(true);
  });
});
