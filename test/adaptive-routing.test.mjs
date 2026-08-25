import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'xm-adaptive-routing-'));
process.env.X_BUILD_ROOT = root;

beforeEach(async () => {
  const { adaptiveRoutingPath } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
  rmSync(adaptiveRoutingPath(), { force: true });
});

afterAll(() => {
  delete process.env.X_BUILD_ROOT;
  rmSync(root, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

function fixtureRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'xm-route-receipt-'));
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1;\n');
  git(cwd, ['init', '-q']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test']);
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-qm', 'fixture']);
  return cwd;
}

const eligible = {
  task_class: 'bounded-transform',
  scope: 'bounded',
  independent: true,
  file_count: 2,
  risk: 'low',
  failure_modes: 2,
  gates: ['test', 'boundary'],
};

let eventSequence = 0;
function event(route, outcome, quality, cost, duration) {
  return {
    type: 'adaptive_route_outcome', task_class: eligible.task_class, selected_route: route,
    decision_id: `route-fixture-${eventSequence += 1}`, outcome, quality_passed: quality,
    cost_usd: cost, duration_ms: duration, learning_eligible: true,
  };
}

describe('adaptive runtime routing', () => {
  test('derives a stable class and high-risk signals from task facts', async () => {
    const { classifyAdaptiveTask, decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const classification = classifyAdaptiveTask({
      kind: 'bugfix', files: ['src/parser.mjs', 'test/parser.test.mjs'], independent: true, risk: 'low',
    });
    expect(classification).toMatchObject({ task_class: 'bugfix-code', scope: 'bounded', risk: 'low' });
    expect(decideAdaptiveRoute({ classification, failure_modes: 2, gates: ['test', 'boundary'] }).route).toBe('direct');
    const risky = classifyAdaptiveTask({
      kind: 'feature', files: ['src/api.mjs'], independent: true, risk: 'low', public_contract: true,
    });
    expect(risky.risk).toBe('high');
    expect(decideAdaptiveRoute({ classification: risky, failure_modes: 1, gates: ['schema'] }).route).toBe('planned');
  });

  test('selects direct only for bounded independent work with a strong deterministic gate', async () => {
    const { decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    expect(decideAdaptiveRoute(eligible).route).toBe('direct');
    expect(decideAdaptiveRoute({ ...eligible, independent: false }).blockers).toContain('files_not_independent');
    expect(decideAdaptiveRoute({ ...eligible, gates: ['test'] }).blockers).toContain('strong_quality_gate_missing');
    expect(decideAdaptiveRoute({ ...eligible, risk: 'high' }).route).toBe('planned');
  });

  test('fails closed on unknown requested gates while keeping the decision recordable', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const decision = module.decideAdaptiveRoute({ ...eligible, gates: [...eligible.gates, 'looks-good'] });
    expect(decision.route).toBe('planned');
    expect(decision.blockers).toContain('unknown_quality_gate');
    expect(decision.unknown_gates).toEqual(['looks-good']);
    expect(decision.gates).toEqual(eligible.gates);
    module.recordAdaptiveDecision(decision);
    expect(() => module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: decision.task_class, selected_route: 'planned',
      outcome: 'accepted', quality_passed: true, gates_run: eligible.gates,
    })).not.toThrow();
  });

  test('fails closed after any historical final quality failure', async () => {
    const { decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const result = decideAdaptiveRoute(eligible, [event('direct', 'failed', false, 0.1, 10)]);
    expect(result.route).toBe('planned');
    expect(result.blockers).toContain('historical_quality_failure');
  });

  test('disables direct when ten samples exceed the 40 percent escalation ceiling', async () => {
    const { decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const rows = Array.from({ length: 10 }, (_, index) => event('direct', index < 5 ? 'escalated' : 'accepted', true, 0.1, 10));
    const result = decideAdaptiveRoute(eligible, rows);
    expect(result.telemetry.escalation_rate).toBe(0.5);
    expect(result.route).toBe('planned');
    expect(result.blockers).toContain('escalation_rate_above_40_percent');
  });

  test('does not claim sufficient escalation evidence from planned-only samples', async () => {
    const { decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const rows = Array.from({ length: 10 }, () => event('planned', 'accepted', true, 1, 100));
    const result = decideAdaptiveRoute(eligible, rows);
    expect(result.telemetry.sufficient_sample).toBe(false);
    expect(result.blockers).not.toContain('escalation_rate_above_40_percent');
  });

  test('requires measured cost and latency improvements when both routes have samples', async () => {
    const { decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const rows = [
      ...Array.from({ length: 3 }, () => event('direct', 'accepted', true, 0.9, 90)),
      ...Array.from({ length: 3 }, () => event('planned', 'accepted', true, 1.0, 100)),
    ];
    const result = decideAdaptiveRoute(eligible, rows);
    expect(result.route).toBe('planned');
    expect(result.blockers).toContain('cost_saving_below_20_percent');
    expect(result.blockers).toContain('latency_saving_below_15_percent');
  });

  test('records only bounded numeric outcome metadata and feeds it back into decisions', async () => {
    const module = await import(`../x-build/lib/x-build/adaptive-routing.mjs?root=${Date.now()}`);
    const decision = module.decideAdaptiveRoute(eligible);
    module.recordAdaptiveDecision(decision);
    const recorded = module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: eligible.task_class, selected_route: 'direct',
      outcome: 'accepted', quality_passed: true, duration_ms: 42, cost_usd: 0.02,
      gates_run: eligible.gates,
    });
    expect(recorded.type).toBe('adaptive_route_outcome');
    expect(recorded.learning_eligible).toBe(false);
    expect(module.readAdaptiveRoutingEvents()).toHaveLength(2);
    expect(JSON.stringify(recorded)).not.toContain('prompt');
    expect(JSON.stringify(recorded)).not.toContain('files');
  });

  test('keeps omitted cost unknown and measures duration from the recorded decision', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const decision = module.decideAdaptiveRoute(eligible);
    module.recordAdaptiveDecision(decision);
    const recorded = module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: eligible.task_class, selected_route: 'direct',
      outcome: 'accepted', quality_passed: true,
      gates_run: eligible.gates,
    });
    expect(recorded.duration_ms).toBeGreaterThanOrEqual(0);
    expect(recorded.cost_usd).toBeNull();
    const stats = module.aggregateAdaptiveRouting(module.readAdaptiveRoutingEvents(), eligible.task_class);
    expect(stats.direct_cost_usd_avg).toBeNull();
    expect(stats.direct_latency_ms_p50).toBeNull();
  });

  test('deduplicates concurrent outcome replays when aggregating route evidence', async () => {
    const { aggregateAdaptiveRouting } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const duplicate = { ...event('direct', 'accepted', true, 0.1, 10), decision_id: 'route-duplicate' };
    const stats = aggregateAdaptiveRouting([duplicate, { ...duplicate, event_id: 'second' }], eligible.task_class);
    expect(stats.samples).toBe(1);
    expect(stats.direct_samples).toBe(1);
  });

  test('rejects unstable class ids, invalid metrics, and contradictory outcomes', async () => {
    const { decideAdaptiveRoute, recordAdaptiveDecision, recordAdaptiveOutcome } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const decision = decideAdaptiveRoute(eligible);
    recordAdaptiveDecision(decision);
    expect(decideAdaptiveRoute({ ...eligible, task_class: 'src/foo.ts' }).blockers).toContain('task_class_invalid');
    expect(() => recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: 'bounded-transform', selected_route: 'planned', outcome: 'escalated',
      quality_passed: true, duration_ms: 1, cost_usd: 0.1,
      gates_run: eligible.gates,
    })).toThrow('planned route cannot have escalated outcome');
    expect(() => recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: 'bounded-transform', selected_route: 'direct', outcome: 'accepted',
      quality_passed: true, duration_ms: -1, cost_usd: 0.1,
    })).toThrow('duration_ms must be a non-negative number');
  });

  test('binds each outcome to one decision and rejects route mismatch or replay', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const decision = module.decideAdaptiveRoute(eligible);
    module.recordAdaptiveDecision(decision);
    expect(() => module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: eligible.task_class, selected_route: 'planned',
      outcome: 'accepted', quality_passed: true, duration_ms: 1, cost_usd: 0.1,
      gates_run: eligible.gates,
    })).toThrow('selected_route does not match');
    module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: eligible.task_class, selected_route: 'direct',
      outcome: 'accepted', quality_passed: true, duration_ms: 1, cost_usd: 0.1,
      gates_run: eligible.gates,
    });
    expect(() => module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: eligible.task_class, selected_route: 'direct',
      outcome: 'accepted', quality_passed: true, duration_ms: 1, cost_usd: 0.1,
      gates_run: eligible.gates,
    })).toThrow('decision_id already has an outcome');
  });

  test('requires evidence that every selected gate ran before recording a quality pass', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const decision = module.decideAdaptiveRoute(eligible);
    module.recordAdaptiveDecision(decision);
    expect(() => module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: eligible.task_class, selected_route: 'direct',
      outcome: 'accepted', quality_passed: true, gates_run: ['test'],
    })).toThrow('quality pass is missing required gates: boundary');
  });

  test('rejects unknown gate names so quality evidence stays comparable', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const decision = module.decideAdaptiveRoute(eligible);
    module.recordAdaptiveDecision(decision);
    expect(() => module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: eligible.task_class, selected_route: 'direct',
      outcome: 'accepted', quality_passed: true, gates_run: [...eligible.gates, 'looks-good'],
    })).toThrow('gates_run contains an unknown quality gate');
  });

  test('measures elapsed time automatically when the caller omits duration', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const decision = module.decideAdaptiveRoute(eligible);
    const recordedDecision = module.recordAdaptiveDecision(decision);
    const recorded = module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: eligible.task_class, selected_route: 'direct',
      outcome: 'accepted', quality_passed: true, gates_run: eligible.gates,
      now_ms: Date.parse(recordedDecision.timestamp) + 123,
    });
    expect(recorded.duration_ms).toBe(123);
  });

  test('routes periodic planned calibration samples without lowering the quality gate', async () => {
    const { ADAPTIVE_CALIBRATION_INTERVAL, decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const rows = Array.from({ length: ADAPTIVE_CALIBRATION_INTERVAL }, () => event('direct', 'accepted', true, 0.1, 10));
    const result = decideAdaptiveRoute(eligible, rows);
    expect(result.route).toBe('planned');
    expect(result.blockers).toContain('calibration_sample_due');
    expect(result.quality_hard_gate).toBe(true);
  });

  test('collects three planned calibration samples in the active comparison window', async () => {
    const { ADAPTIVE_EVALUATION_WINDOW, aggregateAdaptiveRouting, decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const rows = [];
    for (let index = 0; index < ADAPTIVE_EVALUATION_WINDOW; index += 1) {
      const route = decideAdaptiveRoute(eligible, rows).route;
      rows.push(event(route, 'accepted', true, route === 'direct' ? 0.1 : 1, route === 'direct' ? 10 : 100));
    }
    const stats = aggregateAdaptiveRouting(rows, eligible.task_class);
    expect(stats.planned_samples).toBe(2);
    expect(decideAdaptiveRoute(eligible, rows).blockers).toContain('calibration_sample_due');
  });

  test('keeps a direct quality failure fail-closed after the performance window advances', async () => {
    const { ADAPTIVE_EVALUATION_WINDOW, decideAdaptiveRoute } = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const rows = [
      event('direct', 'failed', false, 0.2, 20),
      ...Array.from({ length: ADAPTIVE_EVALUATION_WINDOW }, () => event('planned', 'accepted', true, 1, 100)),
    ];
    const result = decideAdaptiveRoute(eligible, rows);
    expect(result.telemetry.samples).toBe(ADAPTIVE_EVALUATION_WINDOW);
    expect(result.telemetry.observed_samples).toBe(ADAPTIVE_EVALUATION_WINDOW + 1);
    expect(result.telemetry.final_quality_failures).toBe(0);
    expect(result.telemetry.historical_final_quality_failures).toBe(1);
    expect(result.blockers).toContain('historical_quality_failure');
    expect(result.route).toBe('planned');
  });

  test('binds start, CLI-run gates, byte hashes, and finish into one receipt', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      const lease = module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'],
        gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'], now_ms: 1000,
      });
      expect(lease.baseline_head).toMatch(/^[0-9a-f]{40}$/);
      expect(statSync(join(root, 'adaptive-runs', `${decision.decision_id}.lease.json`)).mode & 0o077).toBe(0);
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      const receipt = module.verifyAdaptiveRun({ decision_id: decision.decision_id, now_ms: 1100 });
      expect(receipt.passed).toBe(true);
      expect(receipt.changed_expected_files).toEqual(['src/value.mjs']);
      expect(receipt.gates.every((gate) => gate.passed)).toBe(true);
      expect(JSON.stringify(receipt)).not.toContain('node --check');
      const finished = module.finishAdaptiveRun({ decision_id: decision.decision_id, now_ms: 1200 });
      expect(finished.outcome.duration_ms).toBe(200);
      expect(finished.outcome.cost_usd).toBeNull();
      expect(finished.outcome.quality_passed).toBe(true);
      expect(finished.outcome.learning_eligible).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('rejects unexpected files and post-verification mutations', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({ decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'], gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'] });
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      writeFileSync(join(cwd, 'unexpected.txt'), 'not allowed\n');
      const receipt = module.verifyAdaptiveRun({ decision_id: decision.decision_id });
      expect(receipt.passed).toBe(false);
      expect(receipt.unexpected_files).toContain('unexpected.txt');
      expect(() => module.finishAdaptiveRun({ decision_id: decision.decision_id })).toThrow('execution receipt did not pass');
    } finally { rmSync(cwd, { recursive: true, force: true }); }

    const second = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({ decision_id: decision.decision_id, cwd: second, expected_files: ['src/value.mjs'], gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'] });
      writeFileSync(join(second, 'src', 'value.mjs'), 'export const value = 2;\n');
      expect(module.verifyAdaptiveRun({ decision_id: decision.decision_id }).passed).toBe(true);
      writeFileSync(join(second, 'src', 'value.mjs'), 'export const value = 3;\n');
      expect(() => module.finishAdaptiveRun({ decision_id: decision.decision_id })).toThrow('changed after verification receipt');
    } finally { rmSync(second, { recursive: true, force: true }); }
  });

  test('restarts a failed direct run only from a clean planned fallback and records escalation', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({ decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'], gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'], now_ms: 1000 });
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      writeFileSync(join(cwd, 'unexpected.txt'), 'not allowed\n');
      expect(module.verifyAdaptiveRun({ decision_id: decision.decision_id }).passed).toBe(false);
      expect(() => module.startAdaptiveRun({ decision_id: decision.decision_id, cwd, fallback: true })).toThrow('working tree must be clean');
      rmSync(join(cwd, 'unexpected.txt'));
      git(cwd, ['checkout', '--', 'src/value.mjs']);
      const fallback = module.startAdaptiveRun({ decision_id: decision.decision_id, cwd, fallback: true, now_ms: 1100 });
      expect(fallback.execution_phase).toBe('planned-fallback');
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 3;\n');
      expect(module.verifyAdaptiveRun({ decision_id: decision.decision_id }).passed).toBe(true);
      const finished = module.finishAdaptiveRun({ decision_id: decision.decision_id, now_ms: 1300 });
      expect(finished.outcome.outcome).toBe('escalated');
      expect(finished.outcome.duration_ms).toBe(300);
      expect(finished.lease.failed_direct_receipt).toContain('direct-failed.receipt.json');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('rejects expected files that resolve through a symlink outside the repository', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    const outside = mkdtempSync(join(tmpdir(), 'xm-route-outside-'));
    try {
      symlinkSync(outside, join(cwd, 'linked'));
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      expect(() => module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['linked/value.mjs'],
        gate_commands: ['test=true', 'boundary=true'], allow_dirty: true,
      })).toThrow('resolves outside cwd');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('fails verification when a gate mutates an unexpected file or changes HEAD', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'],
        gate_commands: ['test=node --check src/value.mjs', 'boundary=touch gate-side-effect.txt'],
      });
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      const receipt = module.verifyAdaptiveRun({ decision_id: decision.decision_id });
      expect(receipt.passed).toBe(false);
      expect(receipt.unexpected_files).toContain('gate-side-effect.txt');
    } finally { rmSync(cwd, { recursive: true, force: true }); }

    const second = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd: second, expected_files: ['src/value.mjs'],
        gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'],
      });
      writeFileSync(join(second, 'src', 'value.mjs'), 'export const value = 2;\n');
      git(second, ['add', '.']);
      git(second, ['commit', '-qm', 'unexpected commit']);
      const receipt = module.verifyAdaptiveRun({ decision_id: decision.decision_id });
      expect(receipt.passed).toBe(false);
      expect(receipt.head_changed).toBe(true);
    } finally { rmSync(second, { recursive: true, force: true }); }
  });

  test('allows an expected dirty file while preventing changes to unrelated dirty baseline files', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    try {
      writeFileSync(join(cwd, 'notes.txt'), 'user work\n');
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 1; // starting edit\n');
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'], allow_dirty: true,
        gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'],
      });
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      expect(module.verifyAdaptiveRun({ decision_id: decision.decision_id }).passed).toBe(true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }

    const second = fixtureRepo();
    try {
      writeFileSync(join(second, 'notes.txt'), 'user work\n');
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd: second, expected_files: ['src/value.mjs'], allow_dirty: true,
        gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'],
      });
      writeFileSync(join(second, 'src', 'value.mjs'), 'export const value = 2;\n');
      writeFileSync(join(second, 'notes.txt'), 'agent overwrote user work\n');
      const receipt = module.verifyAdaptiveRun({ decision_id: decision.decision_id });
      expect(receipt.passed).toBe(false);
      expect(receipt.baseline_dirty_changed).toContain('notes.txt');
    } finally { rmSync(second, { recursive: true, force: true }); }
  });

  test('rejects an external symlink swap after verification even when bytes match', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    const outside = mkdtempSync(join(tmpdir(), 'xm-route-swap-'));
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'],
        gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'],
      });
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      expect(module.verifyAdaptiveRun({ decision_id: decision.decision_id }).passed).toBe(true);
      writeFileSync(join(outside, 'value.mjs'), 'export const value = 2;\n');
      rmSync(join(cwd, 'src', 'value.mjs'));
      symlinkSync(join(outside, 'value.mjs'), join(cwd, 'src', 'value.mjs'));
      expect(() => module.finishAdaptiveRun({ decision_id: decision.decision_id })).toThrow('resolves outside cwd');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('automatically sums only actual cost events bound to the route decision', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const { appendCostEvent } = await import('../x-build/lib/x-build/cost-engine.mjs');
    const cwd = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'],
        gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'],
      });
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      expect(module.verifyAdaptiveRun({ decision_id: decision.decision_id }).passed).toBe(true);
      appendCostEvent({ type: 'task_complete', cost_source: 'actual', cost_usd: 0.02, routing_decision_id: decision.decision_id });
      appendCostEvent({ type: 'task_complete', cost_source: 'actual', cost_usd: 0.03, correlation_id: decision.decision_id });
      appendCostEvent({ type: 'task_complete', cost_source: 'actual', cost_usd: 99, routing_decision_id: 'another-decision' });
      appendCostEvent({ type: 'task_complete', cost_source: 'estimated', cost_usd: 99, routing_decision_id: decision.decision_id });
      const finished = module.finishAdaptiveRun({ decision_id: decision.decision_id });
      expect(finished.outcome.cost_usd).toBeCloseTo(0.05, 8);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('keeps manual compatibility records out of routing decisions', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const decision = module.decideAdaptiveRoute(eligible);
    module.recordAdaptiveDecision(decision);
    module.recordAdaptiveOutcome({
      decision_id: decision.decision_id, task_class: decision.task_class, selected_route: decision.route,
      outcome: 'failed', quality_passed: false, gates_run: [], duration_ms: 1, cost_usd: 0.01,
    });
    const next = module.decideAdaptiveRoute(eligible, module.readAdaptiveRoutingEvents());
    expect(next.telemetry.samples).toBe(0);
    expect(next.blockers).not.toContain('historical_quality_failure');
  });

  test('reports interrupted lease recovery and abandons only an unchanged baseline', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'],
        gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'], now_ms: 0,
      });
      const status = module.adaptiveRunStatus(decision.decision_id, 25 * 60 * 60 * 1000).runs[0];
      expect(status).toMatchObject({ status: 'started', stale: true, next_action: 'abandon_or_resume', changed_files: [] });
      const abandoned = module.abandonAdaptiveRun({ decision_id: decision.decision_id, now_ms: 100 });
      expect(abandoned.status).toBe('abandoned');
      expect(() => module.startAdaptiveRun({ decision_id: decision.decision_id, cwd })).toThrow('already has an execution lease');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('refuses to abandon an interrupted run with changed files', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'],
        gate_commands: ['test=node --check src/value.mjs', 'boundary=test -s src/value.mjs'],
      });
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      expect(module.adaptiveRunStatus(decision.decision_id).runs[0].next_action).toBe('verify');
      expect(() => module.abandonAdaptiveRun({ decision_id: decision.decision_id })).toThrow('worktree differs');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('blocks new direct decisions while a failed verification is unresolved', async () => {
    const module = await import('../x-build/lib/x-build/adaptive-routing.mjs');
    const cwd = fixtureRepo();
    try {
      const decision = module.decideAdaptiveRoute(eligible);
      module.recordAdaptiveDecision(decision);
      module.startAdaptiveRun({
        decision_id: decision.decision_id, cwd, expected_files: ['src/value.mjs'],
        gate_commands: ['test=node --check src/value.mjs', 'boundary=false'],
      });
      writeFileSync(join(cwd, 'src', 'value.mjs'), 'export const value = 2;\n');
      expect(module.verifyAdaptiveRun({ decision_id: decision.decision_id }).passed).toBe(false);
      const next = module.decideAdaptiveRoute(eligible, module.readAdaptiveRoutingEvents());
      expect(next.route).toBe('planned');
      expect(next.blockers).toContain('unresolved_verification_failure');

      git(cwd, ['checkout', '--', 'src/value.mjs']);
      module.abandonAdaptiveRun({ decision_id: decision.decision_id });
      const after = module.decideAdaptiveRoute(eligible, module.readAdaptiveRoutingEvents());
      expect(after.blockers).toContain('historical_quality_failure');
      expect(after.blockers).not.toContain('unresolved_verification_failure');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
});
