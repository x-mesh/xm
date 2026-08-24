import { describe, expect, test } from 'bun:test';
import { FIXTURES, summarize } from '../scripts/benchmark-adaptive-routing.mjs';

function row(fixture, buildProfile, buildTurns, researchAgents, planMode, planTurns, planStages) {
  return { fixture, build: { profile: buildProfile, human_turns: buildTurns, research_agents: researchAgents }, plan: { mode: planMode, human_turns: planTurns, model_stages: planStages } };
}

describe('offline adaptive-routing benchmark aggregation', () => {
  test('passes only when structural time improves without a safety downgrade', () => {
    const baseline = FIXTURES.map((fixture) => row(fixture.id, fixture.expectedProfile, fixture.id === 'bounded-local' ? 1 : 0, fixture.expectedProfile === 'deep' ? 4 : fixture.expectedProfile === 'standard' ? 1 : 0, 'standard', 1, 5));
    const candidate = FIXTURES.map((fixture) => row(fixture.id, fixture.expectedProfile, 0, fixture.expectedProfile === 'deep' ? 4 : fixture.expectedProfile === 'standard' ? 1 : 0, fixture.expectedPlanMode, 0, 5));
    const result = summarize(baseline, candidate, { human_turn_ms: 30_000, model_stage_ms: 60_000 });
    expect(result.passed).toBe(true);
    expect(result.aggregate.plan.reduction_ratio).toBeGreaterThan(0);
    expect(result.aggregate.work.delta.human_turns).toBeLessThan(0);
    expect(result.aggregate.work.delta.plan_model_stages).toBe(0);
    expect(result.sample).toMatchObject({ fixtures: FIXTURES.length, trials_per_variant: 1, confidence: 'preliminary' });
  });

  test('fails when a broad fixture is routed below its minimum profile', () => {
    const baseline = FIXTURES.map((fixture) => row(fixture.id, fixture.expectedProfile, 1, 1, 'standard', 1, 5));
    const candidate = FIXTURES.map((fixture) => row(fixture.id, fixture.id === 'broad-architecture' ? 'light' : fixture.expectedProfile, 0, 0, fixture.expectedPlanMode, 0, 5));
    const result = summarize(baseline, candidate, { human_turn_ms: 30_000, model_stage_ms: 60_000 });
    expect(result.passed).toBe(false);
    expect(result.gates.safety).toBe(false);
  });

  test('reports unsafe-to-safe escalation separately from comparable performance', () => {
    const baseline = FIXTURES.map((fixture) => row(fixture.id, fixture.id === 'broad-architecture' ? 'light' : fixture.expectedProfile, 0, fixture.id === 'broad-architecture' ? 0 : 1, 'standard', 1, 5));
    const candidate = FIXTURES.map((fixture) => row(fixture.id, fixture.expectedProfile, 0, fixture.expectedProfile === 'light' ? 0 : 1, fixture.expectedPlanMode, 0, 5));
    const result = summarize(baseline, candidate, { human_turn_ms: 30_000, model_stage_ms: 60_000 });
    expect(result.aggregate.build.safety_corrections).toEqual(['broad-architecture']);
    expect(result.aggregate.build.comparable_fixtures).not.toContain('broad-architecture');
    expect(result.gates.build_non_regression).toBe(true);
  });

  test('fails exact routing fit even when a profile remains above the safety floor', () => {
    const baseline = FIXTURES.map((fixture) => row(fixture.id, fixture.expectedProfile, 0, 1, 'standard', 1, 5));
    const candidate = FIXTURES.map((fixture) => row(fixture.id, fixture.id === 'normal-brownfield' ? 'deep' : fixture.expectedProfile, 0, 1, fixture.expectedPlanMode, 0, 5));
    const result = summarize(baseline, candidate, { human_turn_ms: 30_000, model_stage_ms: 60_000 });
    expect(result.gates.safety).toBe(true);
    expect(result.gates.routing_fit).toBe(false);
    expect(result.passed).toBe(false);
  });

});
