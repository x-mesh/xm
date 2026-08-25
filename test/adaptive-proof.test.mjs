import { describe, expect, test } from 'bun:test';
import { proveAdaptiveBenefit } from '../x-build/lib/x-build/adaptive-proof.mjs';

const usage = (input, cached, output) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });

function benchmark(count = 10, options = {}) {
  const rows = [];
  for (let trial = 1; trial <= count; trial += 1) {
    rows.push({
      fixture: 'independent', variant: 'adaptive-stress-plan-sol', trial,
      wall_ms: options.adaptive_wall ?? 50, agents: { usage: usage(100_000, 80_000, 1_000) },
      verification: { passed: options.adaptive_pass !== false },
    });
    rows.push({
      fixture: 'independent', variant: 'plan-sol-exec-sol', trial,
      wall_ms: options.baseline_wall ?? 100, agents: { usage: usage(200_000, 160_000, 3_000) },
      verification: { passed: true },
    });
  }
  return { _source_path: '/tmp/benchmark.json', model: 'gpt-5.6-sol', rows };
}

function blind(count = 10, winner = 'tie') {
  return {
    source: '/tmp/benchmark.json',
    left: 'adaptive-stress-plan-sol', right: 'plan-sol-exec-sol',
    pairs: Array.from({ length: count }, (_, index) => ({
      fixture: 'independent', trial: index + 1, winner,
      label_map: { A: 'adaptive-stress-plan-sol', B: 'plan-sol-exec-sol' },
    })),
  };
}

describe('adaptive A/B proof gate', () => {
  test('passes only with ten complete quality pairs and material cost/time savings', () => {
    const result = proveAdaptiveBenefit([benchmark()], [blind()], { fixtures: ['independent'] });
    expect(result.passed).toBe(true);
    expect(result.results[0]).toMatchObject({ passed: true, paired_trials: 10, blind_pairs: 10 });
    expect(result.results[0].p50.cost_saving).toBeGreaterThanOrEqual(0.2);
    expect(result.results[0].p50.latency_saving).toBeGreaterThanOrEqual(0.15);
  });

  test('fails on insufficient pairs, incomplete blind coverage, or adaptive quality loss', () => {
    expect(proveAdaptiveBenefit([benchmark(9)], [blind(9)]).results[0].blockers).toContain('insufficient_paired_trials');
    expect(proveAdaptiveBenefit([benchmark()], [blind(9)]).results[0].blockers).toContain('incomplete_blind_coverage');
    expect(proveAdaptiveBenefit([benchmark()], [blind(10, 'plan-sol-exec-sol')]).results[0].blockers).toContain('quality_inferior');
    expect(proveAdaptiveBenefit([benchmark(10, { adaptive_pass: false })], [blind()]).results[0].blockers).toContain('verification_failure');
  });

  test('fails when either cost or p50 latency improvement misses its threshold', () => {
    const slow = proveAdaptiveBenefit([benchmark(10, { adaptive_wall: 90 })], [blind()]);
    expect(slow.results[0].blockers).toContain('latency_saving_below_15_percent');
    const expensive = benchmark();
    for (const row of expensive.rows.filter((row) => row.variant === 'adaptive-stress-plan-sol')) {
      row.agents.usage = usage(190_000, 150_000, 3_000);
    }
    expect(proveAdaptiveBenefit([expensive], [blind()]).results[0].blockers).toContain('cost_saving_below_20_percent');
  });

  test('keeps repeated trial numbers from separate benchmark files distinct', () => {
    const first = benchmark(5); first._source_path = '/tmp/one.json';
    const second = benchmark(5); second._source_path = '/tmp/two.json';
    const oneBlind = blind(5); oneBlind.source = '/tmp/one.json';
    const twoBlind = blind(5); twoBlind.source = '/tmp/two.json';
    const result = proveAdaptiveBenefit([first, second], [oneBlind, twoBlind]);
    expect(result.results[0].paired_trials).toBe(10);
    expect(result.results[0].blind_pairs).toBe(10);
    expect(result.passed).toBe(true);
  });

  test('rejects duplicate or wrong-variant blind evidence', () => {
    const duplicate = blind(); duplicate.pairs.push({ ...duplicate.pairs[0] });
    expect(proveAdaptiveBenefit([benchmark()], [duplicate]).results[0].blockers).toContain('duplicate_blind_pair');
    const wrong = blind(); wrong.right = 'another-variant';
    expect(proveAdaptiveBenefit([benchmark()], [wrong]).results[0].blockers).toContain('blind_variant_mismatch');
  });

  test('rejects missing requested fixtures, duplicate execution rows, and invalid blind verdicts', () => {
    expect(proveAdaptiveBenefit([benchmark()], [blind()], { fixtures: ['independent', 'missing'] }).blockers).toContain('missing_fixture:missing');
    const duplicate = benchmark(); duplicate.rows.push({ ...duplicate.rows[0] });
    expect(proveAdaptiveBenefit([duplicate], [blind()]).results[0].blockers).toContain('duplicate_execution_pair');
    expect(proveAdaptiveBenefit([benchmark()], [blind(10, 'error')]).results[0].blockers).toContain('invalid_blind_verdict');
  });

  test('rejects malformed token accounting', () => {
    const bad = benchmark();
    bad.rows[0].agents.usage.cached_input_tokens = bad.rows[0].agents.usage.input_tokens + 1;
    expect(() => proveAdaptiveBenefit([bad], [blind()])).toThrow('invalid token usage');
  });

  test('rejects missing timing samples and blind rater errors', () => {
    const missingTiming = benchmark();
    delete missingTiming.rows[0].wall_ms;
    expect(() => proveAdaptiveBenefit([missingTiming], [blind()])).toThrow('invalid non-negative metric sample');

    const raterFailure = blind();
    raterFailure.pairs[0].error = true;
    expect(proveAdaptiveBenefit([benchmark()], [raterFailure]).results[0].blockers).toContain('blind_rating_error');
  });

  test('rejects every unmatched execution or blind row instead of proving an intersection', () => {
    const missingBaseline = benchmark();
    missingBaseline.rows = missingBaseline.rows.filter((row) => !(row.variant === 'plan-sol-exec-sol' && row.trial === 10));
    expect(proveAdaptiveBenefit([missingBaseline], [blind()]).results[0].blockers).toContain('unmatched_execution_pair');

    const extraBlind = blind();
    extraBlind.pairs.push({ ...extraBlind.pairs[0], trial: 99 });
    expect(proveAdaptiveBenefit([benchmark()], [extraBlind]).results[0].blockers).toContain('unmatched_blind_pair');
  });
});
