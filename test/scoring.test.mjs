/**
 * scoring.test.mjs — unit + CLI smoke tests for xm/lib/scoring.mjs
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { weightedScore, passes } from '../xm/lib/scoring.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'xm', 'lib', 'x-score-cli.mjs');

function run(args) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 8000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

// ── weightedScore ────────────────────────────────────────────────────

describe('weightedScore — full dimensions', () => {
  test('equal weights average the values', () => {
    const score = weightedScore(
      { goal: 0.8, constraints: 0.6 },
      { goal: 0.5, constraints: 0.5 }
    );
    expect(score).toBeCloseTo(0.7, 9);
  });

  test('proportional weights produce correct weighted average', () => {
    // goal weight 2x constraints
    const score = weightedScore(
      { goal: 0.9, constraints: 0.3 },
      { goal: 2, constraints: 1 }
    );
    // (0.9*2 + 0.3*1) / 3 = 2.1/3 = 0.7
    expect(score).toBeCloseTo(0.7, 9);
  });

  test('three dimensions all present', () => {
    const score = weightedScore(
      { goal: 0.8, constraints: 0.7, success: 0.9 },
      { goal: 0.4, constraints: 0.3, success: 0.3 }
    );
    // (0.8*0.4 + 0.7*0.3 + 0.9*0.3) / 1.0 = 0.32 + 0.21 + 0.27 = 0.80
    expect(score).toBeCloseTo(0.8, 9);
  });
});

describe('weightedScore — partial dimension renormalization', () => {
  test('single matching dimension returns its value', () => {
    const score = weightedScore(
      { goal: 0.8 },
      { goal: 0.4, constraints: 0.3, success: 0.3 }
    );
    // only goal present: weight = 0.4, renorm denom = 0.4 → 0.8*0.4/0.4 = 0.8
    expect(score).toBeCloseTo(0.8, 9);
  });

  test('two of three dimensions renormalized correctly', () => {
    const score = weightedScore(
      { goal: 1.0, constraints: 0.0 },
      { goal: 0.4, constraints: 0.4, success: 0.2 }
    );
    // denom = 0.4+0.4 = 0.8, num = 1.0*0.4 + 0.0*0.4 = 0.4 → 0.4/0.8 = 0.5
    expect(score).toBeCloseTo(0.5, 9);
  });

  test('no matching dimensions returns 0', () => {
    const score = weightedScore(
      { unrelated: 0.9 },
      { goal: 0.5, constraints: 0.5 }
    );
    expect(score).toBe(0);
  });

  test('empty parts returns 0', () => {
    expect(weightedScore({}, { goal: 0.5 })).toBe(0);
  });

  test('empty weights returns 0', () => {
    expect(weightedScore({ goal: 0.8 }, {})).toBe(0);
  });
});

describe('weightedScore — boundary values', () => {
  test('score of 0: all parts = 0', () => {
    const score = weightedScore(
      { a: 0, b: 0 },
      { a: 0.5, b: 0.5 }
    );
    expect(score).toBe(0);
  });

  test('score of 1: all parts = 1', () => {
    const score = weightedScore(
      { a: 1, b: 1 },
      { a: 0.5, b: 0.5 }
    );
    expect(score).toBe(1);
  });

  test('NaN part is clamped to 0', () => {
    const score = weightedScore(
      { a: NaN, b: 1 },
      { a: 0.5, b: 0.5 }
    );
    // a=0, b=1 → (0*0.5 + 1*0.5)/1.0 = 0.5
    expect(score).toBeCloseTo(0.5, 9);
  });

  test('out-of-range part >1 is clamped to 1', () => {
    const score = weightedScore(
      { a: 2.5 },
      { a: 1 }
    );
    expect(score).toBe(1);
  });

  test('out-of-range part <0 is clamped to 0', () => {
    const score = weightedScore(
      { a: -0.5 },
      { a: 1 }
    );
    expect(score).toBe(0);
  });

  test('negative weight is clamped to 0 (dimension ignored)', () => {
    const score = weightedScore(
      { a: 0.8, b: 0.2 },
      { a: 1, b: -1 }
    );
    // b weight clamped to 0, only a contributes: 0.8*1/1 = 0.8
    expect(score).toBeCloseTo(0.8, 9);
  });
});

// ── passes ───────────────────────────────────────────────────────────

describe('passes — operator boundary values', () => {
  test('>= passes when equal', () => expect(passes(0.7, '>=', 0.7)).toBe(true));
  test('>= fails when below', () => expect(passes(0.69, '>=', 0.7)).toBe(false));
  test('>= passes when above', () => expect(passes(0.71, '>=', 0.7)).toBe(true));

  test('<= passes when equal', () => expect(passes(0.7, '<=', 0.7)).toBe(true));
  test('<= fails when above', () => expect(passes(0.71, '<=', 0.7)).toBe(false));
  test('<= passes when below', () => expect(passes(0.69, '<=', 0.7)).toBe(true));

  test('> fails when equal', () => expect(passes(0.7, '>', 0.7)).toBe(false));
  test('> passes when above', () => expect(passes(0.71, '>', 0.7)).toBe(true));

  test('< fails when equal', () => expect(passes(0.7, '<', 0.7)).toBe(false));
  test('< passes when below', () => expect(passes(0.69, '<', 0.7)).toBe(true));

  test('unknown op throws', () => {
    expect(() => passes(0.5, '==', 0.5)).toThrow();
  });

  test('NaN threshold fails all comparisons (no silent pass)', () => {
    expect(passes(0.8, '>=', NaN)).toBe(false);
    expect(passes(0.8, '<=', NaN)).toBe(false);
  });

  test('NaN score fails all comparisons', () => {
    expect(passes(NaN, '>=', 0.5)).toBe(false);
    expect(passes(NaN, '<=', 0.5)).toBe(false);
  });
});

describe('weightedScore — null/undefined guard', () => {
  test('returns 0 for null/undefined/non-object inputs (no throw)', () => {
    expect(weightedScore(null, { goal: 1 })).toBe(0);
    expect(weightedScore({ goal: 0.5 }, null)).toBe(0);
    expect(weightedScore(undefined, undefined)).toBe(0);
  });
});

// ── xm score CLI smoke tests ─────────────────────────────────────────

describe('xm score CLI', () => {
  test('--json outputs valid JSON with score and passed', () => {
    const { stdout, exitCode } = run([
      '--parts', 'goal=0.8,constraints=0.7,success=0.9',
      '--weights', 'goal=0.4,constraints=0.3,success=0.3',
      '--op', '>=',
      '--threshold', '0.7',
      '--json',
    ]);
    expect(exitCode).toBe(0);
    const obj = JSON.parse(stdout.trim());
    expect(typeof obj.score).toBe('number');
    expect(typeof obj.passed).toBe('boolean');
    expect(obj.score).toBeCloseTo(0.8, 4);
    expect(obj.passed).toBe(true);
  });

  test('human-readable output (no --json)', () => {
    const { stdout, exitCode } = run([
      '--parts', 'goal=0.8',
      '--weights', 'goal=1',
      '--op', '>=',
      '--threshold', '0.5',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('score:');
    expect(stdout).toContain('passed');
  });

  test('--invert flips the score', () => {
    const { stdout, exitCode } = run([
      '--parts', 'goal=1.0',
      '--weights', 'goal=1',
      '--op', '<=',
      '--threshold', '0.5',
      '--json',
      '--invert',
    ]);
    expect(exitCode).toBe(0);
    const obj = JSON.parse(stdout.trim());
    // weightedScore = 1.0, inverted = 0.0
    expect(obj.score).toBeCloseTo(0, 9);
    expect(obj.passed).toBe(true); // 0 <= 0.5
  });

  test('missing --parts exits non-zero', () => {
    const { exitCode, stderr } = run(['--weights', 'goal=1']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--parts');
  });

  test('missing --weights exits non-zero', () => {
    const { exitCode, stderr } = run(['--parts', 'goal=0.8']);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain('--weights');
  });

  test('unknown flag exits non-zero', () => {
    const { exitCode } = run(['--bogus']);
    expect(exitCode).not.toBe(0);
  });

  test('--threshold below score: passed=false with <=', () => {
    const { stdout, exitCode } = run([
      '--parts', 'goal=0.8',
      '--weights', 'goal=1',
      '--op', '<=',
      '--threshold', '0.2',
      '--json',
    ]);
    expect(exitCode).toBe(0);
    const obj = JSON.parse(stdout.trim());
    expect(obj.passed).toBe(false);
  });

  test('--threshold without a value is rejected (N1)', () => {
    const { exitCode, stderr } = run([
      '--parts', 'goal=0.8',
      '--weights', 'goal=1',
      '--threshold',
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--threshold requires/);
  });

  test('--threshold followed by another flag is rejected (N1)', () => {
    const { exitCode, stderr } = run([
      '--parts', 'goal=0.8',
      '--weights', 'goal=1',
      '--threshold', '--json',
    ]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/--threshold requires/);
  });
});
