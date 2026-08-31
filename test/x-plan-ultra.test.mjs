import { describe, expect, test } from 'bun:test';
import { synthesizePlanCandidates } from '../x-plan/lib/x-plan/synthesize.mjs';
import { assignUltraRoles, killProcessTree, runUltraPlan } from '../x-plan/lib/x-plan/ultra.mjs';
import { join } from 'node:path';

const candidate = (goal, req, task, decision = 'A') => ({ schema_version: 1, status: 'complete', executable: true, goal, requirements: [{ id: 'R1', text: req, priority: 'must' }], assumptions: [], decision: { selected: decision, alternatives: [] }, tasks: [{ id: 'T1', title: task, depends_on: [], requirement_refs: ['R1'], expected_files: [], done_criteria: ['verified'] }], steps: [['T1']], validation: { commands: ['bun test'], requirement_refs: [] }, disagreements: [], unresolved_questions: [], provenance: {} });
describe('ultra synthesis', () => {
  test('drops invalid candidates and remaps IDs deterministically', () => {
    const out = synthesizePlanCandidates([{ source: 'm1', role: 'architect', ok: true, plan: candidate('G', 'Req A', 'Task A') }, { source: 'bad', ok: false, error: 'timeout' }, { source: 'm2', role: 'critic', ok: true, plan: candidate('G', 'Req B', 'Task B') }]);
    expect(out.ok).toBe(true); expect(out.plan.requirements.map((r) => r.id)).toEqual(['R1', 'R2']); expect(out.plan.tasks.map((t) => t.id)).toEqual(['T1', 'T2']); expect(out.candidates.find((c) => c.source === 'bad').valid).toBe(false);
  });
  test('preserves decision disagreement and disables executable', () => {
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan: candidate('G', 'Req', 'Task A', 'A') }, { source: 'm2', ok: true, plan: candidate('G', 'Req', 'Task B', 'B') }]);
    expect(out.plan.executable).toBe(false); expect(out.plan.disagreements.some((d) => d.topic === 'decision.selected')).toBe(true);
  });
  test('preserves goal disagreement and disables executable', () => {
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan: candidate('Goal A', 'Req', 'Task A') }, { source: 'm2', ok: true, plan: candidate('Goal B', 'Req', 'Task B') }]);
    expect(out.ok).toBe(true);
    expect(out.plan.executable).toBe(false);
    expect(out.plan.disagreements.some((item) => item.topic === 'goal')).toBe(true);
  });
  test('preserves requirement priority disagreement and disables executable', () => {
    const must = candidate('G', 'Req', 'Task A');
    const should = candidate('G', 'Req', 'Task B');
    should.requirements[0].priority = 'should';
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan: must }, { source: 'm2', ok: true, plan: should }]);
    expect(out.ok).toBe(true);
    expect(out.plan.executable).toBe(false);
    expect(out.plan.disagreements.some((item) => item.topic === 'requirement:Req:priority')).toBe(true);
  });
  test('preserves candidate disagreements and disables executable when unresolved', () => {
    const plan = candidate('G', 'Req', 'Task');
    plan.status = 'incomplete';
    plan.executable = false;
    plan.disagreements = [{ topic: 'storage', positions: ['A', 'B'], resolution: 'unresolved', confidence: 'low' }];
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan }]);
    expect(out.ok).toBe(true);
    expect(out.plan.status).toBe('incomplete');
    expect(out.plan.executable).toBe(false);
    expect(out.plan.disagreements).toEqual(plan.disagreements);
  });
  test('fails when no candidate validates', () => expect(synthesizePlanCandidates([{ source: 'x', ok: false }]).error).toBe('no_valid_candidates'));
  test('assigns roles stably and runs an offline backend', async () => {
    expect(assignUltraRoles(['a', 'b', 'c', 'd']).map((x) => x.role)).toEqual(['architect', 'implementer', 'critic', 'architect']);
    const out = await runUltraPlan('Build export', ['model-a', 'model-critic'], { command: join(import.meta.dirname, 'fixtures', 'x-plan-panel-stub.mjs'), timeoutMs: 2000 });
    expect(out.ok).toBe(true); expect(out.plan.provenance.mode).toBe('ultra'); expect(out.plan.disagreements.some((d) => d.topic === 'decision.selected')).toBe(true);
  });
  test('preserves mixed provider failure provenance', async () => {
    const out = await runUltraPlan('Build export', ['model-a', 'model-fail'], { command: join(import.meta.dirname, 'fixtures', 'x-plan-panel-stub.mjs'), timeoutMs: 2000 });
    expect(out.ok).toBe(true); expect(out.candidates.find((c) => c.source === 'model-fail').valid).toBe(false);
  });
  test('remaps dependencies that point to an equivalent merged task', () => {
    const first = candidate('G', 'Req', 'Shared');
    const second = candidate('G', 'Req', 'Shared');
    second.tasks.push({ id: 'T2', title: 'After shared', depends_on: ['T1'], requirement_refs: ['R1'], expected_files: [], done_criteria: ['verified'] });
    second.steps = [['T1'], ['T2']];
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan: first }, { source: 'm2', ok: true, plan: second }]);
    expect(out.ok).toBe(true);
    expect(out.plan.tasks.find((task) => task.title === 'After shared').depends_on).toEqual(['T1']);
  });
  test('creates real topological levels for dependency chains', () => {
    const p = candidate('G', 'Req', 'T1');
    p.tasks.push(
      { id: 'T2', title: 'T2', depends_on: ['T1'], requirement_refs: ['R1'], expected_files: [], done_criteria: ['verified'] },
      { id: 'T3', title: 'T3', depends_on: ['T2'], requirement_refs: ['R1'], expected_files: [], done_criteria: ['verified'] },
    );
    p.steps = [['T1'], ['T2'], ['T3']];
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan: p }]);
    expect(out.ok).toBe(true);
    expect(out.plan.steps).toEqual([['T1'], ['T2'], ['T3']]);
  });
  test('merges requirement coverage for equivalent tasks', () => {
    const a = candidate('G', 'Req A', 'Shared');
    const b = candidate('G', 'Req B', 'Shared');
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan: a }, { source: 'm2', ok: true, plan: b }]);
    expect(out.ok).toBe(true);
    expect(out.plan.tasks[0].requirement_refs).toEqual(['R1', 'R2']);
  });
  test('preserves validation-only requirement coverage after ID remapping', () => {
    const plan = candidate('G', 'Req', 'Task');
    plan.tasks[0].requirement_refs = [];
    plan.validation.requirement_refs = ['R1'];
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan }]);
    expect(out.ok).toBe(true);
    expect(out.plan.validation.requirement_refs).toEqual(['R1']);
  });
  test('does not create a self-dependency while merging equivalent tasks', () => {
    const plan = candidate('G', 'Req', 'Shared');
    plan.tasks.push({ id: 'T2', title: 'Shared', depends_on: ['T1'], requirement_refs: ['R1'], expected_files: [], done_criteria: ['verified'] });
    plan.steps = [['T1'], ['T2']];
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan }]);
    expect(out.ok).toBe(true);
    expect(out.plan.tasks.find((task) => task.title === 'Shared').depends_on).toEqual([]);
  });
  test('remaps downstream dependencies that target a same-candidate duplicate task', () => {
    const plan = candidate('G', 'Req', 'Shared');
    plan.tasks.push(
      { id: 'T2', title: 'Shared', depends_on: ['T1'], requirement_refs: ['R1'], expected_files: [], done_criteria: ['verified twice'] },
      { id: 'T3', title: 'After shared', depends_on: ['T2'], requirement_refs: ['R1'], expected_files: [], done_criteria: ['verified'] },
    );
    plan.steps = [['T1'], ['T2'], ['T3']];
    const out = synthesizePlanCandidates([{ source: 'm1', ok: true, plan }]);
    expect(out.ok).toBe(true);
    expect(out.plan.tasks.find((task) => task.title === 'After shared').depends_on).toEqual(['T1']);
  });
  test('uses taskkill to terminate the full process tree on Windows', () => {
    const calls = [];
    const child = { pid: 42, kill: () => { throw new Error('fallback should not run'); } };
    killProcessTree(child, { platform: 'win32', runTaskkill: (...args) => { calls.push(args); return { status: 0 }; } });
    expect(calls[0][0]).toBe('taskkill');
    expect(calls[0][1]).toEqual(['/PID', '42', '/T', '/F']);
  });
  test('limits backend concurrency', async () => {
    const stub = join(import.meta.dirname, 'fixtures', 'x-plan-panel-stub.mjs');
    const out = await runUltraPlan('Build export', ['m1', 'm2', 'm3', 'm4'], { command: stub, timeoutMs: 2000, maxParallel: 2 });
    expect(out.ok).toBe(true);
    expect(out.plan.provenance.requested_models).toEqual(['m1', 'm2', 'm3', 'm4']);
  });
});
