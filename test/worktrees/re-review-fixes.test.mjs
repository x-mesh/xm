/**
 * Regression tests for the re-review wave (2nd cross-vendor pass):
 *   R3  — expected_files overlap must canonicalize path spellings
 *         (./src/a.mjs vs src/a.mjs) so equivalent paths never batch parallel.
 *   R4  — a successful finish (state ok) clears stale recover[]/patch left by
 *         a prior BLOCKED attempt.
 *   R2  — mapGkFinishResult still throws on an unrecognized state (queue-level
 *         isolation is exercised in finish.test.mjs; the throw contract here).
 */
import { describe, test, expect } from 'bun:test';

const shared = await import('../../x-build/lib/x-build/worktree-shared.mjs');
const wt = await import('../../x-build/lib/x-build/worktrees.mjs');

describe('R3 — expected_files path canonicalization', () => {
  test('normalizeExpectedFiles strips ./ and duplicate slashes', () => {
    expect(shared.normalizeExpectedFiles(['./src/a.mjs', 'src//b.mjs', 'src/c/../c.mjs']))
      .toEqual(['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
  });

  test('equivalent spellings overlap instead of batching parallel', () => {
    const a = { expected_files: ['./src/a.mjs'] };
    const b = { expected_files: ['src/a.mjs'] };
    expect(shared.expectedFilesOverlap(a, b)).toEqual(['src/a.mjs']);
  });
});

describe('R4 — ok finish clears stale recover state', () => {
  test('state ok maps with save.recover=[] and save.patch=null', () => {
    const mapped = wt.mapGkFinishResult({
      state: 'ok', ok: true,
      result: { gate: { phase: 'before', before: 'passed', merged: true, run_id: 'r1' } },
    });
    expect(mapped.worktree_status).toBe(wt.WORKTREE_STATUS.DONE);
    expect(mapped.save.recover).toEqual([]);
    expect(mapped.save.patch).toBeNull();
  });
});

describe('R2 — malformed envelope stays loud', () => {
  test('unrecognized state throws (queue catches per task, not silently benign)', () => {
    expect(() => wt.mapGkFinishResult({ state: 'weird', ok: false })).toThrow();
  });
});
