import { describe, expect, test } from 'bun:test';
import { normalizePlanEnvelope, validatePlanEnvelope } from '../x-plan/lib/x-plan/core.mjs';
import { renderPlan } from '../x-plan/lib/x-plan/render.mjs';

const base = () => ({ schema_version: 1, status: 'complete', executable: false, goal: 'g', requirements: [{ id: 'R1', text: 'r', priority: 'must' }], assumptions: [], decision: { selected: 'd', alternatives: [] }, tasks: [{ id: 'T1', title: 't', requirement_refs: ['R1'], done_criteria: ['d'] }], steps: [['T1']], validation: { commands: [] }, disagreements: [], unresolved_questions: [], provenance: {} });
const laneTask = (id, extra = {}) => ({ id, title: id, requirement_refs: ['R1'], done_criteria: ['d'], verify_commands: ['bun test ' + id], ...extra });
const lanePlan = (tasks, steps) => ({ ...base(), tasks, steps, execution: { lanes: true } });
const errorsOf = (plan) => validatePlanEnvelope(plan).errors.map(({ code, path }) => ({ code, path }));
const pathsOf = (execution) => validatePlanEnvelope({ ...base(), execution }).errors.map((item) => item.path);

describe('PlanEnvelope execution lanes', () => {
  test('a plan without execution normalizes as before', () => {
    const plan = normalizePlanEnvelope(base());
    expect('execution' in plan).toBe(false);
    expect(Object.keys(plan.tasks[0])).toEqual(['id', 'title', 'depends_on', 'requirement_refs', 'expected_files', 'done_criteria']);
    expect(normalizePlanEnvelope({ ...base(), execution: { lanes: false } }).execution).toBeUndefined();
  });

  test('emits lanes only when true', () => {
    const result = validatePlanEnvelope({ ...base(), execution: { lanes: true } });
    expect(result.valid).toBe(true);
    expect(result.value.execution).toEqual({ lanes: true });
  });

  test('rejects a non-boolean lanes', () => {
    for (const lanes of ['yes', 1, null]) expect(pathsOf({ lanes })).toEqual(['execution.lanes']);
  });

  test('lanes require verify_commands on every task of a multi-task step', () => {
    const plan = lanePlan([laneTask('T1'), laneTask('T2', { verify_commands: [] }), { id: 'T3', title: 'T3', requirement_refs: ['R1'], done_criteria: ['d'] }], [['T1', 'T2'], ['T3']]);
    expect(errorsOf(plan)).toEqual([{ code: 'execution.lane_needs_verify', path: 'tasks[1].verify_commands' }]);
    expect(validatePlanEnvelope(lanePlan([laneTask('T1'), laneTask('T2')], [['T1', 'T2']])).valid).toBe(true);
  });

  test('lanes reject two tasks of one step that share an expected file', () => {
    const plan = lanePlan([laneTask('T1', { expected_files: ['a.mjs', 'b.mjs'] }), laneTask('T2', { expected_files: ['b.mjs'] }), laneTask('T3', { expected_files: ['a.mjs'] })], [['T1', 'T2'], ['T3']]);
    const { errors } = validatePlanEnvelope(plan);
    expect(errors.map(({ code, path }) => ({ code, path }))).toEqual([{ code: 'execution.lane_shared_file', path: 'steps' }]);
    expect(errors[0].message).toContain('T1');
    expect(errors[0].message).toContain('T2');
    expect(errors[0].message).toContain('b.mjs');
    expect(errors[0].message).not.toContain('a.mjs');
  });

  test('lanes reject a contract dependency inside one lane step', () => {
    const plan = lanePlan([laneTask('T1', { expected_files: ['a'] }), laneTask('T2', { expected_files: ['b'], depends_on: ['T1'], contract_deps: ['T1'] })], [['T1', 'T2']]);
    expect(errorsOf(plan)).toEqual([{ code: 'execution.lane_contract_dep', path: 'tasks[1].contract_deps' }]);
  });

  test('step checks do not apply without lanes', () => {
    const plan = { ...lanePlan([laneTask('T1', { expected_files: ['a'], verify_commands: [] }), laneTask('T2', { expected_files: ['a'] })], [['T1', 'T2']]), execution: { lanes: false } };
    expect(validatePlanEnvelope(plan).valid).toBe(true);
  });

  test('renders lanes under Execution next to notes and timeout', () => {
    const plan = normalizePlanEnvelope({ ...base(), execution: { notes: 'Merge lanes in task order', command_timeout_seconds: 900, lanes: true } });
    expect(renderPlan(plan)).toContain('## Execution\n\n- Merge lanes in task order\n- Command timeout: 900 s\n- Lanes: on');
  });
});
