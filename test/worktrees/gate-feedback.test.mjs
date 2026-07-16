/**
 * Gate-optimization plan §3G (findings feedback) + §3B (release-gate visibility).
 *
 *   G — injectGateFindings folds a failed gate's findings into the task context
 *       (canonical artifact + worktree TASK-CONTEXT.md) via a marker-delimited
 *       section that is REPLACED across rounds, never duplicated.
 *   B — releaseGateStatus reports pending / pass / fail / stale for
 *       gate_phase=release projects from the integration-state sidecar.
 *
 * X_BUILD_ROOT is set BEFORE importing worktrees.mjs (mirrors artifacts.test.mjs).
 */
import { describe, test, expect, afterAll, beforeEach } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORIG_X_BUILD_ROOT = process.env.X_BUILD_ROOT;
const TEST_ROOT = mkdtempSync(join(tmpdir(), 'xb-gf-'));
process.env.X_BUILD_ROOT = TEST_ROOT;

const wt = await import('../../x-build/lib/x-build/worktrees.mjs');

const PROJECT = 'demo';
const TASK = 't1';

// A plain git repo stands in for the linked worktree — registerWorktreeExclude
// only needs `git rev-parse --git-path info/exclude` to resolve.
const REPO = mkdtempSync(join(tmpdir(), 'xb-gf-repo-'));
const gitq = (c) => execSync(`git ${c}`, { cwd: REPO, stdio: 'pipe', shell: '/bin/bash' });
gitq('init -q');
gitq('config user.email t@t.com');
gitq('config user.name T');
writeFileSync(join(REPO, 'f.txt'), 'x\n');
gitq('add -A && git commit -q -m c1');

afterAll(() => {
  if (ORIG_X_BUILD_ROOT !== undefined) process.env.X_BUILD_ROOT = ORIG_X_BUILD_ROOT;
  else delete process.env.X_BUILD_ROOT;
  for (const d of [TEST_ROOT, REPO]) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

beforeEach(() => {
  rmSync(join(TEST_ROOT, 'projects', PROJECT), { recursive: true, force: true });
  try { rmSync(join(REPO, 'TASK-CONTEXT.md')); } catch { /* absent is fine */ }
});

function writeGateArtifact(fields = {}) {
  const dir = join(TEST_ROOT, 'projects', PROJECT, 'worktrees', TASK);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'panel-before.json'), JSON.stringify({
    decision: 'fail', phase: 'before', round: 1,
    blocking_findings: [{ severity: 'high', kind: 'confirmed', file: 'src/a.ts', line: 3, claim: 'race on retry' }],
    advisory_findings: [{ severity: 'medium', file: 'src/b.ts', line: 9, claim: 'stale cache' }],
    ...fields,
  }));
}

describe('upsertGateFindingsSection (pure)', () => {
  test('appends when no section exists, replaces when one does', () => {
    const s1 = wt.upsertGateFindingsSection('# Task\nbody\n', '<!-- xm:gate-findings:start -->\nROUND1\n<!-- xm:gate-findings:end -->');
    expect(s1).toContain('ROUND1');
    const s2 = wt.upsertGateFindingsSection(s1, '<!-- xm:gate-findings:start -->\nROUND2\n<!-- xm:gate-findings:end -->');
    expect(s2).toContain('ROUND2');
    expect(s2).not.toContain('ROUND1');                          // replaced, not appended
    expect(s2.match(/xm:gate-findings:start/g)).toHaveLength(1); // exactly one section
    expect(s2).toContain('# Task\nbody');                        // original body intact
  });
});

describe('renderGateFindingsSection (pure)', () => {
  test('carries blocking + advisory + category-fix instruction', () => {
    const s = wt.renderGateFindingsSection({
      phase: 'before', round: 2,
      blocking_findings: [{ severity: 'high', kind: 'confirmed', file: 'a.ts', line: 1, claim: 'boom' }],
      advisory_findings: [{ severity: 'medium', file: 'b.ts', line: 2, claim: 'meh' }],
    });
    expect(s).toContain('round 2');
    expect(s).toContain('[high/confirmed] a.ts:1 — boom');
    expect(s).toContain('Advisory');
    expect(s).toContain('[medium] b.ts:2 — meh');
    expect(s).toContain('CATEGORY');
  });
});

describe('injectGateFindings (§3G)', () => {
  test('failed gate → section lands in canonical artifact AND worktree snapshot; idempotent across calls', () => {
    writeGateArtifact();
    const r1 = wt.injectGateFindings({ project: PROJECT, taskId: TASK, phase: 'before', worktreePath: REPO });
    expect(r1.injected).toBe(true);

    const snapshot = readFileSync(join(REPO, 'TASK-CONTEXT.md'), 'utf8');
    expect(snapshot).toContain('race on retry');
    const canonical = readFileSync(wt.taskContextArtifactPath(PROJECT, TASK), 'utf8');
    expect(canonical).toContain('race on retry');

    // The snapshot must be excluded — our own feedback must never dirty the worktree.
    const excl = readFileSync(join(REPO, '.git', 'info', 'exclude'), 'utf8');
    expect(excl).toContain('TASK-CONTEXT.md');

    // Round 2: section is replaced, not appended.
    writeGateArtifact({ round: 2, blocking_findings: [{ severity: 'high', kind: 'confirmed', file: 'src/a.ts', line: 3, claim: 'ROUND2-claim' }] });
    wt.injectGateFindings({ project: PROJECT, taskId: TASK, phase: 'before', worktreePath: REPO });
    const snap2 = readFileSync(join(REPO, 'TASK-CONTEXT.md'), 'utf8');
    expect(snap2).toContain('ROUND2-claim');
    expect(snap2).not.toContain('race on retry');
    expect(snap2.match(/xm:gate-findings:start/g)).toHaveLength(1);
  });

  test('no failed gate artifact → no-op (dirty-guard NEEDS_FIX must not inject)', () => {
    const r = wt.injectGateFindings({ project: PROJECT, taskId: TASK, phase: 'before', worktreePath: REPO });
    expect(r.injected).toBe(false);
    expect(existsSync(join(REPO, 'TASK-CONTEXT.md'))).toBe(false);
  });

  test('pass artifact → no-op', () => {
    writeGateArtifact({ decision: 'pass' });
    const r = wt.injectGateFindings({ project: PROJECT, taskId: TASK, phase: 'before', worktreePath: REPO });
    expect(r.injected).toBe(false);
  });
});

describe('releaseGateStatus (§3B visibility)', () => {
  const stateDir = () => join(TEST_ROOT, 'projects', PROJECT, 'worktrees', wt.INTEGRATION_TASK_ID);
  const headOf = (ref) => execSync(`git rev-parse ${ref}`, { cwd: REPO, encoding: 'utf8', shell: '/bin/bash' }).trim();

  test('no integration state → pending', () => {
    const s = wt.releaseGateStatus({ project: PROJECT, cwd: REPO });
    expect(s.state).toBe('pending');
  });

  test('recorded head matches → last decision; target moved → stale', () => {
    gitq('branch -f develop HEAD');
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), 'integration-state.json'), JSON.stringify({
      base: 'main', target: 'develop', target_head: headOf('develop'), decision: 'pass',
    }));
    expect(wt.releaseGateStatus({ project: PROJECT, cwd: REPO }).state).toBe('pass');

    // develop moves → the recorded pass is stale.
    writeFileSync(join(REPO, 'g.txt'), 'y\n');
    gitq('add -A && git commit -q -m c2 && git branch -f develop HEAD');
    const s = wt.releaseGateStatus({ project: PROJECT, cwd: REPO });
    expect(s.state).toBe('stale');
    expect(s.reason).toContain('review-integration');
  });
});
