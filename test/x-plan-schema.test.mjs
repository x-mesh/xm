import { describe, expect, test } from 'bun:test';
import { createPlanEnvelope, normalizePlanEnvelope, validatePlanEnvelope } from '../x-plan/lib/x-plan/core.mjs';

function validPlan() {
  return { schema_version: 1, status: 'complete', executable: true, goal: 'Ship plan JSON', requirements: [{ id: 'R1', text: 'Emit JSON', priority: 'must' }], assumptions: [], decision: { selected: 'CLI', alternatives: [] }, tasks: [{ id: 'T1', title: 'Implement CLI', depends_on: [], requirement_refs: ['R1'], expected_files: [], done_criteria: ['JSON parses'] }], steps: [['T1']], validation: { commands: ['bun test'], requirement_refs: [] }, disagreements: [], unresolved_questions: [], provenance: {} };
}
describe('PlanEnvelope v1', () => {
  test('normalization is deterministic and idempotent', () => {
    const a = normalizePlanEnvelope(validPlan());
    expect(normalizePlanEnvelope(a)).toEqual(a);
    expect(JSON.stringify(a)).toBe(JSON.stringify(normalizePlanEnvelope(validPlan())));
  });
  test('accepts a fully covered plan', () => expect(validatePlanEnvelope(validPlan()).valid).toBe(true));
  test('rejects duplicates, dangling deps, cycles, uncovered requirements, and empty criteria', () => {
    const p = validPlan();
    p.requirements.push({ ...p.requirements[0] }, { id: 'R2', text: 'Second', priority: 'must' });
    p.tasks[0].depends_on = ['T2']; p.tasks[0].done_criteria = [];
    p.tasks.push({ id: 'T2', title: 'Second', depends_on: ['T1'], requirement_refs: [], expected_files: [], done_criteria: ['done'] });
    const codes = validatePlanEnvelope(p).errors.map((e) => e.code);
    expect(codes).toContain('requirement.duplicate_id');
    expect(codes).toContain('task.dependency_cycle');
    expect(codes).toContain('requirement.uncovered');
    expect(codes).toContain('task.done_criteria');
  });
  test('unresolved questions force scaffold executable false', () => {
    const p = createPlanEnvelope('- Add export\n- Add tests');
    expect(p.executable).toBe(false);
    expect(p.requirements).toHaveLength(2);
    expect(p.tasks).toHaveLength(2);
    expect(p.unresolved_questions.length).toBeGreaterThan(0);
  });
  test('structured markdown preserves goal, explicit requirement ids, files, and validation', () => {
    const p = createPlanEnvelope('# Goal\nUpdate src/a.mjs safely.\n\n# Requirements\n- R1: Preserve default behavior.\n- R2: Add coverage.\n\n# Validation\n- node --test');
    expect(p.goal).toBe('Update src/a.mjs safely.');
    expect(p.requirements.map((item) => item.id)).toEqual(['R1', 'R2']);
    expect(p.tasks.every((task) => task.expected_files.includes('src/a.mjs'))).toBe(true);
    expect(p.validation.commands).toEqual(['node --test']);
    expect(p.executable).toBe(true);
  });
  test('structured path extraction strips prose punctuation', () => {
    const p = createPlanEnvelope('# Goal\nUpdate client.\n\n# Requirements\n- R1: expose API from lib/client.mjs.\n\n# Validation\n- node --test');
    expect(p.tasks[0].expected_files).toEqual(['lib/client.mjs']);
  });
  test('structured markdown ignores fenced examples inside requirements', () => {
    const p = createPlanEnvelope('# Goal\nUpdate src/a.mjs.\n\n# Requirements\n~~~js\nconst example = true\n~~~\n- R1: Preserve behavior.\n\n# Validation\n- node --test');
    expect(p.requirements).toEqual([{ id: 'R1', text: 'Preserve behavior.', priority: 'must' }]);
  });
  test('rejects an input that claims executable while questions remain', () => {
    const p = validPlan(); p.unresolved_questions = ['Which API?'];
    expect(validatePlanEnvelope(p).errors.map((e) => e.code)).toContain('plan.executable_with_questions');
  });
  test('rejects an executable plan with an unresolved disagreement', () => {
    const p = validPlan();
    p.disagreements = [{ topic: 'storage', positions: ['A', 'B'], resolution: 'unresolved', confidence: 'low' }];
    expect(validatePlanEnvelope(p).errors.map((e) => e.code)).toContain('plan.executable_with_disagreement');
  });
  test('rejects malformed disagreement fields before normalization', () => {
    const p = validPlan();
    p.disagreements = [{ topic: 1, positions: 'A', resolution: null, confidence: false }];
    const paths = validatePlanEnvelope(p).errors.filter((e) => e.code === 'disagreement.field_type').map((e) => e.path);
    expect(paths).toEqual([
      'disagreements[0].topic',
      'disagreements[0].resolution',
      'disagreements[0].confidence',
      'disagreements[0].positions',
    ]);
  });
  test('rejects unsupported schema and missing fields', () => {
    const p = validPlan(); p.schema_version = 9; delete p.tasks;
    const codes = validatePlanEnvelope(p).errors.map((e) => e.code);
    expect(codes).toContain('plan.unsupported_version');
    expect(codes).toContain('plan.missing_field');
  });
  test('rejects wrong field types before normalization can hide them', () => {
    const p = validPlan(); p.requirements = {}; p.tasks = {}; p.steps = {};
    const result = validatePlanEnvelope(p);
    expect(result.valid).toBe(false);
    expect(result.errors.filter((e) => e.code === 'plan.field_type').map((e) => e.path)).toEqual(['requirements', 'tasks', 'steps']);
  });
  test('rejects coerced schema versions and empty statuses', () => {
    const stringVersion = validPlan();
    stringVersion.schema_version = '1';
    expect(validatePlanEnvelope(stringVersion).errors.some((e) => e.path === 'schema_version')).toBe(true);

    const emptyStatus = validPlan();
    emptyStatus.status = '   ';
    expect(validatePlanEnvelope(emptyStatus).errors.some((e) => e.path === 'status')).toBe(true);
  });
  test('rejects nested task field types and invalid step schedules', () => {
    const p = validPlan();
    p.tasks[0].depends_on = 'none';
    p.steps = [];
    const codes = validatePlanEnvelope(p).errors.map((e) => e.code);
    expect(codes).toContain('task.field_type');
    expect(codes).toContain('steps.missing_task');
  });
  test('rejects dependency order violations in steps', () => {
    const p = validPlan();
    p.tasks.push({ id: 'T2', title: 'Second', depends_on: ['T1'], requirement_refs: ['R1'], expected_files: [], done_criteria: ['done'] });
    p.steps = [['T1', 'T2']];
    expect(validatePlanEnvelope(p).errors.map((e) => e.code)).toContain('steps.dependency_order');
  });
  test('rejects invalid status invariants and empty executable plans', () => {
    const invalid = validPlan(); invalid.status = 'invalid'; invalid.executable = false;
    expect(validatePlanEnvelope(invalid).errors.map((e) => e.code)).toContain('plan.invalid_state');
    const incomplete = validPlan(); incomplete.status = 'incomplete';
    expect(validatePlanEnvelope(incomplete).errors.map((e) => e.code)).toContain('plan.status_executable');
    const empty = validPlan(); empty.requirements = []; empty.tasks = []; empty.steps = [];
    const codes = validatePlanEnvelope(empty).errors.map((e) => e.code);
    expect(codes).toContain('plan.empty_requirements');
    expect(codes).toContain('plan.empty_tasks');
    const noDecision = validPlan(); noDecision.decision.selected = '';
    expect(validatePlanEnvelope(noDecision).errors.map((e) => e.code)).toContain('plan.empty_decision');
  });
});
