import { describe, test, expect } from 'bun:test';
import { aggregateEffectiveness } from '../x-build/lib/x-build/effectiveness-aggregate.mjs';

const now = () => new Date().toISOString();
const event = (buildId, profile, type, extra = {}) => ({
  build_id: buildId, profile, type, timestamp: now(), ...extra,
});

describe('build effectiveness aggregation', () => {
  test('ignores malformed, stale, legacy, and unlinked rows and honors profile filters', () => {
    const rows = [
      null, 'not-an-event', [], {},
      { type: 'build_complete', timestamp: now(), profile: 'light' },
      { type: 'build_complete', timestamp: now(), build_id: 'legacy' },
      event('old', 'light', 'build_complete', { timestamp: '2000-01-01T00:00:00.000Z' }),
      event('light-1', 'light', 'build_complete', { success: true }),
      event('deep-1', 'deep', 'build_complete', { success: true }),
    ];

    const result = aggregateEffectiveness(rows, { sinceDays: 30, profiles: ['light'] });
    expect(result.builds_observed).toBe(1);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].profile).toBe('light');
    expect(result.profiles[0].builds).toBe(1);
    expect(result.profiles[0].completion_rate).toBe(1);
  });

  test('uses build totals for planning duration and requires complete phase cost coverage', () => {
    const rows = [
      event('b1', 'standard', 'phase_effect', { phase: 'research', duration_ms: 100, cost_usd: 0.1 }),
      event('b1', 'standard', 'phase_effect', { phase: 'plan', duration_ms: 300, cost_usd: 0.2 }),
      event('b2', 'standard', 'phase_effect', { phase: 'research', duration_ms: 200, cost_usd: 0.4 }),
      event('b2', 'standard', 'phase_effect', { phase: 'plan', duration_ms: 400 }),
    ];

    const summary = aggregateEffectiveness(rows, { profiles: ['standard'] }).profiles[0];
    expect(summary.planning_duration_ms_avg).toBe(500);
    expect(summary.planning_cost_usd_avg).toBeCloseTo(0.3);
    expect(summary.planning_cost_coverage).toBe(0.75);
  });

  test('counts first-pass verification per build rather than per attempt', () => {
    const rows = [
      event('first-pass', 'deep', 'verify_outcome', { first_pass: true, passed: true, attempts: 1 }),
      event('retried', 'deep', 'verify_outcome', { first_pass: false, passed: false, attempts: 1 }),
      event('retried', 'deep', 'verify_outcome', { first_pass: false, passed: true, attempts: 2 }),
    ];

    const summary = aggregateEffectiveness(rows, { profiles: ['deep'] }).profiles[0];
    expect(summary.verify_first_pass_rate).toBe(0.5);
  });

  test('marks a profile sufficient at ten distinct builds', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      event(`light-${index}`, 'light', 'build_complete', { success: true }));

    const summary = aggregateEffectiveness(rows, { profiles: ['light'] }).profiles[0];
    expect(summary.builds).toBe(10);
    expect(summary.sufficient_sample).toBe(true);
  });

  test('attributes a build and all of its events to its latest selected profile', () => {
    const early = '2026-08-01T00:00:00.000Z';
    const late = '2026-08-02T00:00:00.000Z';
    const rows = [
      event('changed', 'light', 'phase_effect', { phase: 'plan', duration_ms: 100, timestamp: early }),
      event('changed', 'deep', 'profile_selected', { timestamp: late }),
      event('changed', 'deep', 'build_complete', { success: true, timestamp: late }),
    ];

    const result = aggregateEffectiveness(rows, { sinceDays: 365, profiles: ['deep'] });
    expect(result.builds_observed).toBe(1);
    expect(result.profiles[0].builds).toBe(1);
    expect(result.profiles[0].planning_duration_ms_avg).toBe(100);
    expect(result.profiles[0].completion_rate).toBe(1);
    expect(aggregateEffectiveness(rows, { sinceDays: 365, profiles: ['light'] }).builds_observed).toBe(0);
  });
});
