import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addUsage, aggregate, fastPathEligible, qualityProbe } from '../scripts/benchmark-execution-harness.mjs';

const usage = (input, cached, output) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 0,
});

const row = (trial, planningInput, executionInput, wallMs) => ({
  fixture: 'redos-matcher',
  variant: 'plan-sol-exec-luna',
  trial,
  wall_ms: wallMs,
  agents: {
    usage: usage(planningInput + executionInput, 30, 15),
    elapsed_ms_max: wallMs - 20,
  },
  planning_usage: {
    model: 'gpt-5.6-sol',
    reasoning_effort: 'high',
    wall_ms: 20,
    ...usage(planningInput, 10, 5),
  },
  execution_usage: {
    model: 'gpt-5.6-luna',
    reasoning_effort: 'low',
    wall_ms_sum: wallMs - 20,
    wall_ms_max: wallMs - 20,
    ...usage(executionInput, 20, 10),
  },
  retries: 0,
  verification: { passed: true, stress: { returned: true, hung: false } },
});

describe('execution harness benchmark aggregation', () => {
  test('keeps mixed-model planning and execution metrics separate', () => {
    const result = aggregate([
      row(1, 100, 1_000, 220),
      row(2, 200, 2_000, 320),
      row(3, 300, 3_000, 420),
    ])['redos-matcher']['plan-sol-exec-luna'];

    expect(result).toMatchObject({
      trials: 3,
      pass_rate: 1,
      median_wall_ms: 320,
      median_planning_wall_ms: 20,
      median_execution_wall_ms: 300,
      median_planning_input_tokens: 200,
      median_planning_cached_input_tokens: 10,
      median_planning_output_tokens: 5,
      median_execution_input_tokens: 2_000,
      median_execution_cached_input_tokens: 20,
      median_execution_output_tokens: 10,
      stress_returned: 3,
      stress_hung: 0,
    });
  });

  test('discovers planned variants from rows without relying on environment filters', () => {
    const result = aggregate([row(1, 100, 1_000, 220)]);
    expect(result['redos-matcher']['plan-sol-exec-luna'].trials).toBe(1);
  });

  test('adds retry and escalation token usage without losing cached tokens', () => {
    expect(addUsage(usage(100, 40, 10), usage(200, 80, 20))).toEqual(usage(300, 120, 30));
  });

  test('quality gate catches nullable-star, Unicode, malformed, and deep-nesting failures', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'xm-quality-probe-'));
    try {
      mkdirSync(join(cwd, 'src'));
      writeFileSync(join(cwd, 'src', 'match.mjs'), "export const match = (pattern, text) => pattern === text;\n");
      const result = qualityProbe(cwd, { id: 'redos-matcher' });
      expect(result.passed).toBe(false);
      expect(result.errors.some((error) => error.startsWith('nullable-star:'))).toBe(true);
      expect(result.errors.some((error) => error.startsWith('unicode-dot:'))).toBe(true);
      expect(result.errors.some((error) => error.startsWith('deep-nesting:'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('allows fast routing only when deterministic quality is observable', () => {
    expect(fastPathEligible({ id: 'independent-modules' })).toBe(true);
    expect(fastPathEligible({ id: 'independent-config' })).toBe(true);
    expect(fastPathEligible({ id: 'redos-matcher' })).toBe(true);
    expect(fastPathEligible({ id: 'shared-registry' })).toBe(false);
    expect(fastPathEligible({ id: 'shared-validator' })).toBe(false);
  });
});
