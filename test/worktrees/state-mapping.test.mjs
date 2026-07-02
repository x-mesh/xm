/**
 * Contract tests for gk finish envelope -> xm state mapping.
 * Covers all 7 rows of the canonical mapping table plus the
 * worktree_resume_not_merged (--resume-accept unmerged) guard case.
 *
 * The envelopes come from the shared fake-gk factories so the stub subprocess
 * and these unit tests can never drift apart.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { mapGkFinishResult, WORKTREE_STATUS, TASK_STATUS } from '../../x-build/lib/x-build/worktrees.mjs';
import { GK_SCENARIOS, buildEnvelope, exitCodeForState } from './fake-gk.mjs';

const map = (scenario) => mapGkFinishResult(buildEnvelope(scenario));

describe('mapGkFinishResult — canonical table', () => {
  test('ok -> completed / DONE', () => {
    const r = map('ok');
    expect(r.task_status).toBe(TASK_STATUS.COMPLETED);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.DONE);
    expect(r.retryable).toBe(false);
    expect(r.save.run_id).toBe('20260702-120102-123');
  });

  test('blocked worktree_gate_before_failed (exit 1) -> running / NEEDS_FIX', () => {
    const r = map('before_failed');
    expect(r.task_status).toBe(TASK_STATUS.RUNNING);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.NEEDS_FIX);
    expect(r.retryable).toBe(false);
  });

  test('blocked worktree_gate_before_failed (gate exit 2) -> running / BLOCKED', () => {
    const r = map('before_error');
    expect(r.task_status).toBe(TASK_STATUS.RUNNING);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.BLOCKED);
  });

  test('blocked worktree_gate_dirty -> running / NEEDS_FIX', () => {
    const r = map('dirty');
    expect(r.task_status).toBe(TASK_STATUS.RUNNING);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.NEEDS_FIX);
  });

  test('blocked worktree_gate_locked -> running / MERGING (retryable)', () => {
    const r = map('locked');
    expect(r.task_status).toBe(TASK_STATUS.RUNNING);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.MERGING);
    expect(r.retryable).toBe(true);
  });

  test('blocked worktree_gate_no_target -> running / BLOCKED', () => {
    const r = map('no_target');
    expect(r.task_status).toBe(TASK_STATUS.RUNNING);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.BLOCKED);
    expect(r.retryable).toBe(false);
  });

  test('paused after-gate -> running / BLOCKED + patch + recover', () => {
    const r = map('after_paused');
    expect(r.task_status).toBe(TASK_STATUS.RUNNING);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.BLOCKED);
    expect(r.save.patch).toBe('/tmp/gk-gate-after.patch');
    expect(Array.isArray(r.save.recover)).toBe(true);
    expect(r.save.recover.length).toBe(2);
    // recover pairs carry safety classification for human decision
    expect(r.save.recover.map((x) => x.safety)).toEqual(['safe', 'destructive']);
  });

  test('paused merge conflict -> running / BLOCKED + resume/abort remedies', () => {
    const r = map('merge_conflict');
    expect(r.task_status).toBe(TASK_STATUS.RUNNING);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.BLOCKED);
    expect(r.save.recover.length).toBe(2);
    expect(r.save.recover[0].command).toContain('merge --continue');
  });
});

describe('mapGkFinishResult — resume-accept guard', () => {
  test('worktree_resume_not_merged -> running / BLOCKED, remedies preserved', () => {
    const r = map('resume_not_merged');
    expect(r.task_status).toBe(TASK_STATUS.RUNNING);
    expect(r.worktree_status).toBe(WORKTREE_STATUS.BLOCKED);
    expect(r.retryable).toBe(false);
    expect(r.save.last_error.code).toBe('worktree_resume_not_merged');
    expect(r.save.remedies.length).toBeGreaterThan(0);
  });
});

describe('mapGkFinishResult — robustness', () => {
  test('throws on unrecognized envelope state (never silently maps)', () => {
    expect(() => mapGkFinishResult({ state: 'weird' })).toThrow(/unrecognized/);
    expect(() => mapGkFinishResult({})).toThrow(/unrecognized/);
  });

  test('unknown blocked reason surfaces as BLOCKED with error preserved', () => {
    const r = mapGkFinishResult({ state: 'blocked', error: { code: 'brand_new_reason' } });
    expect(r.worktree_status).toBe(WORKTREE_STATUS.BLOCKED);
    expect(r.save.last_error.code).toBe('brand_new_reason');
  });
});

describe('fake-gk stub — subprocess contract', () => {
  const STUB = join(import.meta.dirname, 'fake-gk.mjs');

  const run = (scenario, useEnv = false) =>
    spawnSync('node', [STUB, ...(useEnv ? [] : [scenario])], {
      encoding: 'utf8',
      env: useEnv ? { ...process.env, FAKE_GK_SCENARIO: scenario } : process.env,
    });

  test('emits JSON envelope + state exit code (arg selection)', () => {
    for (const scenario of Object.keys(GK_SCENARIOS)) {
      const out = run(scenario);
      const env = JSON.parse(out.stdout);
      expect(env.state).toBe(buildEnvelope(scenario).state);
      expect(out.status).toBe(exitCodeForState(env.state));
    }
  });

  test('exit codes: ok=0, blocked=1, paused=3', () => {
    expect(run('ok').status).toBe(0);
    expect(run('before_failed').status).toBe(1);
    expect(run('after_paused').status).toBe(3);
  });

  test('scenario via FAKE_GK_SCENARIO env', () => {
    const out = run('ok', true);
    expect(JSON.parse(out.stdout).state).toBe('ok');
    expect(out.status).toBe(0);
  });

  test('unknown scenario exits 2 with message', () => {
    const out = run('nonsense');
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('unknown scenario');
  });
});
