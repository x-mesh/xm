import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const XM = join(REPO, 'xm', 'scripts', 'xm');

function xm(cwd, args) {
  const result = spawnSync('bash', [XM, 'build', ...args], {
    cwd,
    env: {
      ...process.env,
      XM_LIB: REPO,
      XM_ROOT: join(cwd, '.xm'),
      X_BUILD_ROOT: undefined,
      XKIT_SERVER: undefined,
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: result.status ?? 1 };
}

function json(cwd, args) {
  const result = xm(cwd, args);
  expect(result.exitCode, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`).toBe(0);
  return JSON.parse(result.stdout);
}

function initGit(cwd) {
  spawnSync('git', ['init', '-q'], { cwd });
  spawnSync('git', ['config', 'user.email', 'xm-e2e@example.com'], { cwd });
  spawnSync('git', ['config', 'user.name', 'xm e2e'], { cwd });
  writeFileSync(join(cwd, 'README.md'), '# fixture\n');
  spawnSync('git', ['add', 'README.md'], { cwd });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd });
}

function decisionPrd(profile) {
  const tier = profile === 'light' ? '<!-- prd-tier: delta -->\n' : '';
  return `${tier}# PRD: ${profile} fixture

## Goal
Ship the ${profile} fixture.

## Success Criteria
- [ ] Fixture lifecycle completes [R1]

## Decision Plan
- Selected approach: exercise the existing CLI state machine.
- Single path: no alternative implementation is needed for this fixture.
- Risk-first order: validate plan and gate contracts before execution.

## Requirements Traceability
- [R1] Fixture lifecycle completes → SC1

## 12. Acceptance Criteria
- [ ] Fixture lifecycle completes [R1]
`;
}

function runLifecycle(cwd, profile) {
  const project = `profile-${profile}`;
  expect(xm(cwd, ['init', project]).exitCode).toBe(0);
  const planned = json(cwd, ['legacy-plan', `Build and verify the ${profile} lifecycle fixture`, '--profile', profile]);
  expect(planned.profile).toBe(profile);
  expect(planned.profile_explicit).toBe(true);
  expect(planned.research_scope).toBe(profile === 'light' ? 'none' : profile === 'standard' ? 'slim' : 'full');

  expect(xm(cwd, ['phase', 'set', 'plan']).exitCode).toBe(0);
  if (profile !== 'light') {
    expect(xm(cwd, ['save', 'context', '--content', `# Context\n\n## Goal\nBuild ${profile} fixture`]).exitCode).toBe(0);
    expect(xm(cwd, ['save', 'requirements', '--content', '- [R1] Fixture lifecycle completes']).exitCode).toBe(0);
  }
  if (profile === 'deep') {
    expect(xm(cwd, ['save', 'roadmap', '--content', '# Roadmap\n\n- Validate before execution']).exitCode).toBe(0);
  }
  expect(xm(cwd, ['save', 'plan', '--reason', 'research', '--content', decisionPrd(profile)]).exitCode).toBe(0);
  expect(xm(cwd, [
    'tasks', 'add', 'Implement fixture [R1]', '--size', 'small',
    '--desc', 'Exercise the lifecycle contract.', '--done-criteria', 'Fixture lifecycle completes [R1]',
    '--expected-files', 'README.md', '--reason', 'research',
  ]).exitCode).toBe(0);
  expect(xm(cwd, ['steps', 'compute']).exitCode).toBe(0);
  expect(xm(cwd, ['plan-check']).exitCode).toBe(0);
  expect(xm(cwd, ['gate', 'pass', 'Direction approved']).exitCode).toBe(0);
  expect(xm(cwd, ['phase', 'next']).exitCode).toBe(0);

  const dispatched = json(cwd, ['run', '--json']);
  expect(dispatched.tasks).toHaveLength(1);
  expect(dispatched.tasks[0].task_id).toBe('t1');
  expect(xm(cwd, ['task-check', 't1']).exitCode).toBe(0);
  expect(xm(cwd, ['tasks', 'update', 't1', '--status', 'completed', '--no-commit']).exitCode).toBe(0);
  const checked = json(cwd, ['group-check', 'build', '--json']);
  expect(checked.ok).toBe(true);
  expect(xm(cwd, ['phase', 'next']).exitCode).toBe(0);
  expect(xm(cwd, ['quality']).exitCode).toBe(0);
  expect(xm(cwd, ['close', '--summary', `${profile} lifecycle fixture`]).exitCode).toBe(0);
  return { project, planned };
}

describe('adaptive build effectiveness E2E', () => {
  test('light, standard, and deep profiles traverse the CLI state machine and aggregate metrics', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'xm-build-effectiveness-'));
    try {
      initGit(cwd);
      for (const profile of ['light', 'standard', 'deep']) runLifecycle(cwd, profile);

      const metrics = join(cwd, '.xm', 'build', 'metrics', 'sessions.jsonl');
      expect(existsSync(metrics)).toBe(true);
      const rows = readFileSync(metrics, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      for (const profile of ['light', 'standard', 'deep']) {
        const selected = rows.find(row => row.type === 'profile_selected' && row.profile === profile);
        expect(selected?.build_id).toMatch(/^b-/);
        expect(rows.some(row => row.type === 'plan_drafted' && row.build_id === selected.build_id)).toBe(true);
        expect(rows.some(row => row.type === 'gate_outcome' && row.build_id === selected.build_id && row.passed)).toBe(true);
        expect(rows.some(row => row.type === 'task_complete' && row.build_id === selected.build_id)).toBe(true);
        expect(rows.some(row => row.type === 'phase_effect' && row.build_id === selected.build_id && row.phase === 'execute')).toBe(true);
        expect(rows.some(row => row.type === 'verify_outcome' && row.build_id === selected.build_id)).toBe(true);
        expect(rows.some(row => row.type === 'build_complete' && row.build_id === selected.build_id)).toBe(true);
      }

      const report = json(cwd, ['effectiveness', '--since', '30d', '--json']);
      expect(report.builds_observed).toBe(3);
      expect(report.profiles.map(row => [row.profile, row.builds])).toEqual([
        ['light', 1], ['standard', 1], ['deep', 1],
      ]);
      expect(report.profiles.every(row => row.sufficient_sample === false)).toBe(true);
      expect(report.coverage.malformed_rows).toBe(0);

      appendFileSync(metrics, '{torn-json\n' + JSON.stringify({
        type: 'phase_complete', project: 'legacy', timestamp: new Date().toISOString(),
      }) + '\n');
      const compared = json(cwd, ['effectiveness', '--compare', 'light,deep', '--json']);
      expect(compared.compare).toEqual(['light', 'deep']);
      expect(compared.profiles.map(row => row.profile)).toEqual(['light', 'deep']);
      expect(compared.builds_observed).toBe(2);
      expect(compared.coverage).toEqual({ malformed_rows: 1, legacy_or_unlinked_events: 1 });

      // An aggregated event type with no build_id is dropped from every rate.
      // The counter used to allow-list three legacy cost events, so this row —
      // the kind whose loss actually moves research_change_rate — went
      // unreported. It must now be counted like any other orphan.
      appendFileSync(metrics, JSON.stringify({
        type: 'phase_effect', project: 'orphan', phase: 'research',
        duration_ms: 10, delta: { requirements: 1 }, timestamp: new Date().toISOString(),
      }) + '\n');
      const widened = json(cwd, ['effectiveness', '--since', '30d', '--json']);
      expect(widened.coverage).toEqual({ malformed_rows: 1, legacy_or_unlinked_events: 2 });
      expect(widened.builds_observed).toBe(3);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);

  test('closing a profiled project with no tasks does not inflate completion_rate', () => {
    // `close` runs no gate — it force-marks every phase completed — so a project
    // that picked a profile at `plan` can reach it with zero tasks. `total ===
    // done` read that as 0 === 0, so an empty build counted as completed and
    // completion_rate reported 100%. The profile matters: a build that skips
    // `plan` has none and is excluded from the rate regardless of `success`.
    const cwd = mkdtempSync(join(tmpdir(), 'xm-build-empty-close-'));
    try {
      initGit(cwd);
      expect(xm(cwd, ['init', 'empty']).exitCode).toBe(0);
      expect(xm(cwd, ['legacy-plan', 'Empty fixture', '--profile', 'light', '--draft']).exitCode).toBe(0);
      expect(xm(cwd, ['close', '--summary', 'nothing was built']).exitCode).toBe(0);

      const rows = readFileSync(join(cwd, '.xm', 'build', 'metrics', 'sessions.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      const closed = rows.find(row => row.type === 'build_complete');
      expect(closed).toBeTruthy();
      expect(closed.task_count).toBe(0);
      expect(closed.success).toBe(false);

      const report = json(cwd, ['effectiveness', '--since', '30d', '--json']);
      const light = report.profiles.find(row => row.profile === 'light');
      expect(light.builds).toBe(1);
      expect(light.completion_rate).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test('--quick remains the light alias and conflicts fail loudly', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'xm-build-profile-'));
    try {
      initGit(cwd);
      expect(xm(cwd, ['init', 'alias']).exitCode).toBe(0);
      const quick = json(cwd, ['legacy-plan', 'Build quick fixture', '--quick']);
      expect(quick.quick).toBe(true);
      expect(quick.profile).toBe('light');
      expect(quick.flow).toBe('quick');
      const resumed = json(cwd, ['legacy-plan', 'Build quick fixture']);
      expect(resumed.profile).toBe('light');
      expect(resumed.profile_explicit).toBe(false);
      expect(resumed.research_scope).toBe('none');
      expect(resumed.required_artifacts).toEqual(['PRD:delta', 'tasks', 'checks']);
      const conflict = xm(cwd, ['legacy-plan', 'Build conflict fixture', '--quick', '--profile', 'deep']);
      expect(conflict.exitCode).not.toBe(0);
      expect(conflict.stderr).toContain('alias for --profile light');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
