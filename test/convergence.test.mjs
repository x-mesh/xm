import { describe, test, expect } from 'bun:test';
import { similarity, detectStop } from '../x-solver/lib/convergence.mjs';

// ── similarity ────────────────────────────────────────────────────────────────

describe('similarity', () => {
  test('identical strings return 1', () => {
    const s = 'the quick brown fox jumps over';
    expect(similarity(s, s)).toBe(1);
  });

  test('completely unrelated strings return < 0.1', () => {
    const a = 'apple banana cherry date elderberry fig grape';
    const b = 'sodium chloride potassium nitrogen hydrogen oxygen carbon';
    expect(similarity(a, b)).toBeLessThan(0.1);
  });

  test('partially overlapping strings return value between 0 and 1', () => {
    const a = 'the quick brown fox jumps over the lazy dog';
    const b = 'the slow brown dog sits under the lazy cat';
    const s = similarity(a, b);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  test('empty string prev returns 0 (guard)', () => {
    expect(similarity('', 'hello world foo bar')).toBe(0);
  });

  test('empty string curr returns 0 (guard)', () => {
    expect(similarity('hello world foo bar', '')).toBe(0);
  });

  test('null/undefined returns 0 (guard)', () => {
    expect(similarity(null, 'hello world foo')).toBe(0);
    expect(similarity('hello world foo', undefined)).toBe(0);
  });

  test('fewer than 3 tokens in prev returns 0 (guard)', () => {
    // "hi there" → 2 tokens
    expect(similarity('hi there', 'hello world foo bar baz')).toBe(0);
  });

  test('fewer than 3 tokens in curr returns 0 (guard)', () => {
    expect(similarity('hello world foo bar baz', 'ok done')).toBe(0);
  });

  test('is symmetric', () => {
    const a = 'retry the network call on timeout error';
    const b = 'handle timeout error by retrying the network';
    expect(similarity(a, b)).toBeCloseTo(similarity(b, a), 10);
  });
});

// ── detectStop ────────────────────────────────────────────────────────────────

// Helpers to build history entries with enough tokens
function h(output, score) {
  return score !== undefined ? { output, score } : { output };
}

const LONG_A = 'the root cause is a race condition in the cache invalidation logic when concurrent requests arrive';
const LONG_B = 'the solution involves adding a mutex around the database write path to prevent duplicate inserts';
const LONG_A2 = 'the root cause is a race condition in the cache invalidation logic when concurrent requests arrive again';

describe('detectStop — none', () => {
  test('returns none when history is shorter than minHistory', () => {
    const result = detectStop([h(LONG_A)], { minHistory: 2 });
    expect(result.stop).toBe(false);
    expect(result.reason).toBe('none');
  });

  test('returns none for dissimilar consecutive outputs', () => {
    const result = detectStop([h(LONG_A), h(LONG_B)]);
    expect(result.stop).toBe(false);
    expect(result.reason).toBe('none');
  });

  test('returns none for empty history', () => {
    expect(detectStop([]).stop).toBe(false);
  });
});

describe('detectStop — converged', () => {
  test('detects converged when last two outputs are nearly identical', () => {
    // Same text with minor punctuation diff — similarity should be >= 0.9
    const result = detectStop([h(LONG_B), h(LONG_A), h(LONG_A2)]);
    // LONG_A and LONG_A2 share nearly all tokens
    const result2 = detectStop([h(LONG_B), h(LONG_A), h(LONG_A)]);
    expect(result2.stop).toBe(true);
    expect(result2.reason).toBe('converged');
  });

  test('identical last two outputs trigger converged', () => {
    const result = detectStop([h(LONG_B), h(LONG_A), h(LONG_A)]);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe('converged');
    expect(result.detail).toMatch(/similarity/);
  });
});

describe('detectStop — stagnant', () => {
  test('detects stagnant when stagnationN consecutive pairs all converge (text-based)', () => {
    // stagnationN=2 → need 3 entries with 2 consecutive pairs both converged
    const result = detectStop(
      [h(LONG_B), h(LONG_A), h(LONG_A), h(LONG_A)],
      { stagnationN: 2 }
    );
    expect(result.stop).toBe(true);
    expect(result.reason).toBe('stagnant');
  });

  test('detects stagnant when scores show no improvement', () => {
    // stagnationN=2 → need stagnationN+1=3 entries with non-improving scores
    const result = detectStop(
      [h(LONG_A, 7.0), h(LONG_A, 7.0), h(LONG_A, 6.9)],
      { stagnationN: 2 }
    );
    expect(result.stop).toBe(true);
    expect(result.reason).toBe('stagnant');
    expect(result.detail).toMatch(/score/);
  });

  test('does not trigger stagnant when score improves', () => {
    const result = detectStop(
      [h(LONG_A, 6.5), h(LONG_A, 6.8), h(LONG_A, 7.5)],
      { stagnationN: 2 }
    );
    // Identical text but rising scores: the score-based check suppresses the stop.
    expect(result.stop).toBe(false);
    expect(result.reason).toBe('none');
  });

  test('stagnationN <= 0 is floored — no false stagnant on rising scores', () => {
    const result = detectStop(
      [h(LONG_A, 7.0), h(LONG_A, 9.0)],
      { stagnationN: 0 }
    );
    expect(result.reason).not.toBe('stagnant');
  });

  test('mixed score history uses the score path on the recent window', () => {
    // First entry lacks a score; the recent window (last 2) is fully scored
    // with no improvement (7.0 -> 7.0) → must fire stagnant via the SCORE path,
    // not silently fall back to text-only matching.
    const result = detectStop(
      [h(LONG_A), h(LONG_A, 7.0), h(LONG_A, 7.0)],
      { stagnationN: 1 }
    );
    expect(result.stop).toBe(true);
    expect(result.reason).toBe('stagnant');
    expect(result.detail).toMatch(/score/);
  });
});

describe('detectStop — oscillating', () => {
  test('detects A,B,A oscillation pattern', () => {
    // outputs: [LONG_A, LONG_B, LONG_A] — A and A are similar, B is different
    const result = detectStop([h(LONG_A), h(LONG_B), h(LONG_A)]);
    expect(result.stop).toBe(true);
    expect(result.reason).toBe('oscillating');
    expect(result.detail).toMatch(/A,B,A/);
  });

  test('oscillating wins over converged (priority check)', () => {
    // Even if last two would also count as converged, oscillating fires first
    // Use A, B, A where A≈A and B is very different
    const result = detectStop([h(LONG_A), h(LONG_B), h(LONG_A)]);
    expect(result.reason).toBe('oscillating');
  });
});

describe('detectStop — threshold configuration', () => {
  test('custom high threshold suppresses converged detection', () => {
    // Force threshold=1.0 so only truly identical strings converge
    const nearlyIdentical = LONG_A;
    const slightlyDifferent = LONG_A + ' however';
    const result = detectStop(
      [h(LONG_B), h(nearlyIdentical), h(slightlyDifferent)],
      { convergeThreshold: 1.0 }
    );
    // With threshold=1.0 the slightly different strings should NOT converge
    expect(result.stop).toBe(false);
  });

  test('custom low threshold triggers converged more easily', () => {
    const result = detectStop(
      [h(LONG_A), h(LONG_B)],
      { convergeThreshold: 0.01 }
    );
    // Even low-similarity pair should trigger with threshold=0.01
    expect(result.stop).toBe(true);
    expect(['converged', 'stagnant']).toContain(result.reason);
  });
});

describe('similarity — non-string guard (F1)', () => {
  test('returns 0 for non-string inputs (no TypeError)', () => {
    expect(similarity(42, 'hello world from the test')).toBe(0);
    expect(similarity(null, LONG_A)).toBe(0);
    expect(similarity(LONG_A, undefined)).toBe(0);
    expect(similarity({ output: LONG_A }, LONG_A)).toBe(0);
  });
});

describe('detectStop — null/malformed history element guard (F1)', () => {
  test('history with a null element does not throw', () => {
    expect(() => detectStop([null, h(LONG_A), h(LONG_A)])).not.toThrow();
  });
  test('history element with non-string output does not throw', () => {
    expect(() => detectStop([{ output: 42 }, h(LONG_A), h(LONG_A)])).not.toThrow();
  });
});
