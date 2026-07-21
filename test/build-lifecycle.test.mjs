import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveTaskChecks, taskCheckFingerprint } from '../x-build/lib/x-build/build-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

function run(cwd, args, env = {}) {
  const out = spawnSync('node', [CLI, ...args], {
    cwd, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, XKIT_SERVER: undefined, XM_ROOT: join(cwd, '.xm'), ...env },
  });
  return { stdout: out.stdout || '', stderr: out.stderr || '', code: out.status ?? 1 };
}

function git(cwd, args) {
  const out = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(out.stderr || `git ${args.join(' ')} failed`);
}

function setup(cwd) {
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'xm-test@example.com']);
  git(cwd, ['config', 'user.name', 'xm test']);
  writeFileSync(join(cwd, '.baseline'), 'baseline\n');
  git(cwd, ['add', '.baseline']);
  git(cwd, ['commit', '-qm', 'baseline']);
  run(cwd, ['init', 'demo']);
  return join(cwd, '.xm', 'build', 'projects', 'demo');
}

describe('plan entry and conditional interview', () => {
  test('plan is plan-only, build continues after approval, interview asks at most three questions', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-'));
    try {
      setup(tmp);
      const plan = JSON.parse(run(tmp, ['plan', 'Add a settings export command']).stdout);
      expect(plan.requested_action).toBe('plan_only');
      expect(plan.stop_after).toBe('plan_bundle');
      expect(plan.intent_check.readiness).toBe('ready');

      const build = JSON.parse(run(tmp, ['build', '--project', 'demo', 'Add a settings export command']).stdout);
      expect(build.requested_action).toBe('build');
      expect(build.stop_after).toBe('execute_complete');

      const interview = JSON.parse(run(tmp, ['plan', '--project', 'demo', '--interview', 'Improve it']).stdout);
      expect(interview.intent_check.readiness).toBe('clarify');
      expect(interview.intent_check.questions.length).toBeLessThanOrEqual(3);
      expect(interview.executable).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a new explicit goal cannot silently overwrite an unrelated active plan', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-'));
    try {
      setup(tmp);
      run(tmp, ['plan', 'Add a settings export command']);
      const second = run(tmp, ['plan', 'Replace authentication system']);
      const out = JSON.parse(second.stdout);
      expect(second.code).toBe(2);
      expect(out.action).toBe('select-project');
      expect(out.reason).toBe('explicit_goal_does_not_match_active_project');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('content-bound approval and shared review groups', () => {
  test('untracked task-check fingerprint streams content through git and changes with the blob', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-'));
    try {
      setup(tmp);
      const large = join(tmp, 'large-untracked.bin');
      writeFileSync(large, Buffer.alloc(2 * 1024 * 1024, 0x61));
      const first = taskCheckFingerprint(tmp, { task_checks: [] });
      writeFileSync(large, Buffer.alloc(2 * 1024 * 1024, 0x62));
      const second = taskCheckFingerprint(tmp, { task_checks: [] });
      expect(first).toBeTruthy();
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('common task checks resolve in non-Node task working directories too', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-'));
    try {
      writeFileSync(join(tmp, 'Cargo.toml'), '[package]\nname="demo"\nversion="0.1.0"\n');
      expect(resolveTaskChecks(tmp, { task_checks: ['test', 'lint'] })).toEqual([
        { name: 'test', command: 'cargo test' },
        { name: 'lint', command: 'cargo clippy' },
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('task-check suppresses live-provider credentials unless explicitly opted in', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-offline-'));
    try {
      setup(tmp);
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({
        scripts: { test: 'node -e "process.exit(process.env.GROQ_API_KEY ? 9 : 0)"' },
      }));
      run(tmp, ['tasks', 'add', 'Offline check']);

      const offline = run(tmp, ['task-check', 't1', '--json'], { GROQ_API_KEY: 'live-secret' });
      expect(offline.code).toBe(0);
      const evidence = JSON.parse(offline.stdout);
      expect(evidence.passed).toBe(true);
      expect(evidence.network_policy.allow_live_provider_checks).toBe(false);
      expect(evidence.network_policy.suppressed_env).toContain('GROQ_API_KEY');

      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({
        build: { allow_live_provider_checks: true },
      }, null, 2));
      const optedIn = run(tmp, ['task-check', 't1', '--json'], { GROQ_API_KEY: 'live-secret' });
      expect(optedIn.code).toBe(2);
      expect(JSON.parse(optedIn.stdout).network_policy.allow_live_provider_checks).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('changing tasks after approval invalidates the plan hash', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-'));
    try {
      const project = setup(tmp);
      run(tmp, ['phase', 'set', 'plan']);
      run(tmp, ['plan', 'Add a settings export command']);
      for (const name of ['Create export model', 'Implement export command', 'Document export flow']) {
        run(tmp, ['tasks', 'add', name, '--done-criteria', `${name} works`]);
      }
      const dir = join(project, 'phases', '02-plan');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'PRD.md'), '# PRD\n\n## 1. Goal\nExport settings\n');
      run(tmp, ['steps', 'compute']);
      run(tmp, ['plan-check']);
      run(tmp, ['gate', 'pass', 'approved']);
      run(tmp, ['tasks', 'update', 't1', '--desc', 'changed after approval']);
      const next = run(tmp, ['phase', 'next']);
      expect(next.code).toBe(2);
      expect(next.stdout).toContain('Plan changed after approval');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase set cannot bypass approval and plan-only resumes only through run', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-'));
    try {
      const project = setup(tmp);
      run(tmp, ['phase', 'set', 'plan']);
      run(tmp, ['plan', 'Add a settings export command']);
      run(tmp, ['tasks', 'add', 'Implement export', '--done-criteria', 'works']);
      const planDir = join(project, 'phases', '02-plan');
      writeFileSync(join(planDir, 'PRD.md'), '# PRD\n\n## 1. Goal\nExport settings\n');
      run(tmp, ['steps', 'compute']);
      run(tmp, ['plan-check']);

      const bypass = run(tmp, ['phase', 'set', 'execute']);
      expect(bypass.code).toBe(2);
      expect(bypass.stderr).toContain('plan_not_approved');
      const forcedBypass = run(tmp, ['phase', 'set', 'execute', '--force']);
      expect(forcedBypass.code).toBe(2);
      expect(forcedBypass.stderr).toContain('plan_not_approved');

      run(tmp, ['gate', 'pass', 'approved']);
      const stopped = run(tmp, ['phase', 'next']);
      expect(stopped.stdout).toContain('Plan-only mode stops before Execute');
      const manifest = JSON.parse(readFileSync(join(project, 'manifest.json')));
      expect(manifest.current_phase).toBe('02-plan');

      const resumed = run(tmp, ['run', '--json']);
      expect(resumed.code).toBe(0);
      expect(JSON.parse(resumed.stdout).tasks[0].task_id).toBe('t1');
      const advanced = JSON.parse(readFileSync(join(project, 'manifest.json')));
      expect(advanced.current_phase).toBe('03-execute');

      const unchecked = run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']);
      expect(unchecked.code).toBe(2);
      expect(unchecked.stderr).toContain('no current passing task-check evidence');
      expect(JSON.parse(run(tmp, ['task-check', 't1', '--json']).stdout).passed).toBe(true);
      writeFileSync(join(tmp, '.baseline'), 'committed after checks\n');
      git(tmp, ['add', '.baseline']);
      git(tmp, ['commit', '-qm', 'move checked head']);
      const movedHead = run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']);
      expect(movedHead.code).toBe(2);
      expect(movedHead.stderr).toContain('no current passing task-check evidence');
      expect(JSON.parse(run(tmp, ['task-check', 't1', '--json']).stdout).passed).toBe(true);
      writeFileSync(join(tmp, '.baseline'), 'dirty after checks\n');
      const staleCheck = run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']);
      expect(staleCheck.code).toBe(2);
      expect(staleCheck.stderr).toContain('no current passing task-check evidence');
      writeFileSync(join(tmp, '.baseline'), 'committed after checks\n');
      expect(run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']).code).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('normal execution stops once at the completed group and exposes common task checks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-'));
    try {
      const project = setup(tmp);
      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({ build: { review_mode: 'auto' } }, null, 2));
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { test: 'echo ok', lint: 'echo ok' } }));
      git(tmp, ['add', 'package.json']);
      git(tmp, ['commit', '-qm', 'add package']);
      run(tmp, ['phase', 'set', 'plan']);
      run(tmp, ['plan', 'Implement feature']);
      run(tmp, ['tasks', 'add', 'Implement feature', '--done-criteria', 'works']);
      run(tmp, ['steps', 'compute']);
      const planDir = join(project, 'phases', '02-plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'PRD.md'), '# PRD\n\n## 1. Goal\nFeature\n');
      run(tmp, ['plan-check']);
      run(tmp, ['gate', 'pass', 'approved']);
      const dispatched = JSON.parse(run(tmp, ['run', '--json']).stdout);
      expect(dispatched.review_group).toBe('build');
      expect(dispatched.tasks[0].task_checks.map((c) => c.name)).toEqual(['test', 'lint']);
      run(tmp, ['task-check', 't1']);
      run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']);

      const blocked = JSON.parse(run(tmp, ['run', '--json']).stdout);
      expect(blocked.status).toBe('review_required');
      expect(blocked.next_action).toBe('review-group build');
      const routed = JSON.parse(run(tmp, ['next', '--json']).stdout);
      expect(routed.action).toBe('review-group');
      expect(routed.args).toEqual(['build']);

      writeFileSync(join(tmp, 'untracked-feature.js'), 'export const value = 1;\n');
      const dirtyReview = JSON.parse(run(tmp, ['review-group', 'build', '--json']).stdout);
      expect(dirtyReview.ok).toBe(false);
      expect(dirtyReview.error).toContain('untracked_files_present');
      rmSync(join(tmp, 'untracked-feature.js'), { force: true });

      const reviewed = run(tmp, ['review-group', 'build', '--json']);
      expect(JSON.parse(reviewed.stdout).ok).toBe(true);
      const state = JSON.parse(readFileSync(join(project, 'phases', '03-execute', 'review-groups.json')));
      expect(state.groups.build.status).toBe('passed');

      run(tmp, ['tasks', 'reopen', 't1', '--reason', 'follow-up fix']);
      const reopened = JSON.parse(run(tmp, ['run', '--json']).stdout);
      expect(reopened.tasks[0].task_id).toBe('t1');
      expect(reopened.review_group).toBe('build');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('manual review mode exposes an optional review without blocking Execute completion', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-manual-'));
    try {
      const project = setup(tmp);
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { test: 'echo ok', lint: 'echo ok' } }));
      git(tmp, ['add', 'package.json']);
      git(tmp, ['commit', '-qm', 'add package']);
      run(tmp, ['phase', 'set', 'plan']);
      run(tmp, ['plan', 'Implement feature']);
      run(tmp, ['tasks', 'add', 'Implement feature', '--done-criteria', 'works']);
      run(tmp, ['steps', 'compute']);
      const planDir = join(project, 'phases', '02-plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'PRD.md'), '# PRD\n\n## 1. Goal\nFeature\n');
      run(tmp, ['plan-check']);
      run(tmp, ['gate', 'pass', 'approved']);
      const dispatched = JSON.parse(run(tmp, ['run', '--json']).stdout);
      expect(dispatched.tasks[0].task_id).toBe('t1');
      run(tmp, ['task-check', 't1']);
      run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']);

      const status = JSON.parse(run(tmp, ['run-status', '--json']).stdout);
      expect(status.review_required).toBe(false);
      expect(status.review_available).toBe(true);
      expect(status.review_command).toBe('review-group build');
      expect(status.next_action).toBe('group-check build');
      const checked = run(tmp, ['group-check', 'build', '--json']);
      expect(JSON.parse(checked.stdout).ok).toBe(true);
      const afterCheck = JSON.parse(run(tmp, ['run-status', '--json']).stdout);
      expect(afterCheck.next_action).toBe('phase next');
      const routed = JSON.parse(run(tmp, ['next', '--json']).stdout);
      expect(routed.action).toBe('phase');
      expect(routed.args).toEqual(['next']);
      expect(run(tmp, ['phase', 'next']).code).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('solo depth (default) issues a pending spec, voids it on git drift, then records the verdict', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-solo-'));
    try {
      const project = setup(tmp);
      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({ build: { review_mode: 'auto' } }, null, 2));
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { test: 'echo ok', lint: 'echo ok' } }));
      git(tmp, ['add', 'package.json']);
      git(tmp, ['commit', '-qm', 'add package']);
      run(tmp, ['phase', 'set', 'plan']);
      run(tmp, ['plan', 'Implement feature']);
      run(tmp, ['tasks', 'add', 'Implement feature', '--done-criteria', 'works']);
      run(tmp, ['steps', 'compute']);
      const planDir = join(project, 'phases', '02-plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'PRD.md'), '# PRD\n\n## 1. Goal\nFeature\n');
      run(tmp, ['plan-check']);
      run(tmp, ['gate', 'pass', 'approved']);
      run(tmp, ['run', '--json']);
      // real work AFTER the baseline bind → non-empty group patch
      writeFileSync(join(tmp, 'feature.js'), 'export const value = 1;\n');
      git(tmp, ['add', 'feature.js']);
      git(tmp, ['commit', '-qm', 'feature']);
      run(tmp, ['task-check', 't1']);
      run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']);

      const pending = JSON.parse(run(tmp, ['review-group', 'build', '--json']).stdout);
      expect(pending.pending).toBe('solo');
      expect(pending.solo.model).toBeTruthy();
      expect(readFileSync(pending.solo.patch, 'utf8')).toContain('feature.js');

      // git moved under the pending review → verdict is void, fail-closed
      writeFileSync(join(tmp, 'drift.js'), 'export const drift = 1;\n');
      git(tmp, ['add', 'drift.js']);
      git(tmp, ['commit', '-qm', 'drift']);
      const voided = JSON.parse(run(tmp, ['review-group', 'build', '--verdict', 'pass', '--json']).stdout);
      expect(voided.ok).toBe(false);
      expect(voided.error).toBe('git_target_changed_during_review');

      // re-issue against the new target, then record the verdict
      const again = JSON.parse(run(tmp, ['review-group', 'build', '--json']).stdout);
      expect(again.pending).toBe('solo');
      expect(run(tmp, ['task-check', 't1']).code).toBe(0);
      const verdict = JSON.parse(run(tmp, ['review-group', 'build', '--verdict', 'pass', '--notes', 'lgtm', '--json']).stdout);
      expect(verdict.ok).toBe(true);
      expect(verdict.checks.reused_task_checks).toBe(true);
      const state = JSON.parse(readFileSync(join(project, 'phases', '03-execute', 'review-groups.json')));
      expect(state.groups.build.status).toBe('passed');
      expect(state.groups.build.decision).toBe('solo-pass');
      expect(state.groups.build.reviewer_model).toBeTruthy();
      expect(state.groups.build.group_quality.reused_task_checks).toBe(true);

      // Reopening without changing the reviewed target keeps both the solo pass
      // and exact-snapshot checks valid. It must not create another review loop.
      run(tmp, ['tasks', 'reopen', 't1', '--reason', 'metadata-only follow-up']);
      run(tmp, ['run', '--json']);
      run(tmp, ['task-check', 't1']);
      run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']);
      const resumed = JSON.parse(run(tmp, ['run-status', '--json']).stdout);
      expect(resumed.review_required).toBe(false);
      expect(resumed.next_action).toBe('phase next');
      expect(run(tmp, ['phase', 'next']).code).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('checks-only depth passes the group on group checks without any LLM review', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-checks-'));
    try {
      const project = setup(tmp);
      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({ build: { review_mode: 'auto', review_depth: 'checks-only' } }, null, 2));
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({ scripts: { test: 'echo ok', lint: 'echo ok' } }));
      git(tmp, ['add', 'package.json']);
      git(tmp, ['commit', '-qm', 'add package']);
      run(tmp, ['phase', 'set', 'plan']);
      run(tmp, ['plan', 'Implement feature']);
      run(tmp, ['tasks', 'add', 'Implement feature', '--done-criteria', 'works']);
      run(tmp, ['steps', 'compute']);
      const planDir = join(project, 'phases', '02-plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'PRD.md'), '# PRD\n\n## 1. Goal\nFeature\n');
      run(tmp, ['plan-check']);
      run(tmp, ['gate', 'pass', 'approved']);
      run(tmp, ['run', '--json']);
      writeFileSync(join(tmp, 'feature.js'), 'export const value = 1;\n');
      git(tmp, ['add', 'feature.js']);
      git(tmp, ['commit', '-qm', 'feature']);
      run(tmp, ['task-check', 't1']);
      run(tmp, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']);

      const reviewed = JSON.parse(run(tmp, ['review-group', 'build', '--json']).stdout);
      expect(reviewed.ok).toBe(true);
      expect(reviewed.depth).toBe('checks-only');
      const state = JSON.parse(readFileSync(join(project, 'phases', '03-execute', 'review-groups.json')));
      expect(state.groups.build.status).toBe('passed');
      expect(state.groups.build.decision).toBe('checks-only-pass');
      expect(state.groups.build.group_quality?.passed).toBe(true);
      expect(run(tmp, ['phase', 'next']).code).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('review group dispatch fails closed when git baseline is unavailable', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-lifecycle-no-git-'));
    try {
      const project = join(tmp, '.xm', 'build', 'projects', 'demo');
      run(tmp, ['init', 'demo']);
      run(tmp, ['phase', 'set', 'plan']);
      run(tmp, ['plan', 'Implement feature']);
      run(tmp, ['tasks', 'add', 'Implement feature', '--done-criteria', 'works']);
      run(tmp, ['steps', 'compute']);
      const planDir = join(project, 'phases', '02-plan');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(join(planDir, 'PRD.md'), '# PRD\n\n## 1. Goal\nFeature\n');
      run(tmp, ['plan-check']);
      run(tmp, ['gate', 'pass', 'approved']);
      const dispatched = JSON.parse(run(tmp, ['run', '--json']).stdout);
      expect(dispatched.status).toBe('blocked');
      expect(dispatched.blocked_reason).toBe('git_baseline_unavailable');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
