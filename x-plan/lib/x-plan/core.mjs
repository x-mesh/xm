import { PLAN_SCHEMA_VERSION } from './schema.mjs';
import { normalizePlanEnvelope } from './normalize.mjs';
import { validatePlanEnvelope } from './validate.mjs';

function lines(text) { return String(text || '').split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim()).filter(Boolean); }
export function createPlanEnvelope(requirementsText, { source = 'literal' } = {}) {
  const items = lines(requirementsText);
  const requirements = items.map((text, index) => ({ id: `R${index + 1}`, text, priority: 'must' }));
  const tasks = requirements.map((requirement, index) => ({
    id: `T${index + 1}`, title: `Implement ${requirement.id}: ${requirement.text}`, depends_on: [],
    requirement_refs: [requirement.id], expected_files: [],
    done_criteria: [`${requirement.id} is satisfied with verification evidence.`],
  }));
  const unresolved = requirements.length ? ['Task decomposition requires planner or user decisions.'] : ['At least one requirement is required.'];
  return normalizePlanEnvelope({
    schema_version: PLAN_SCHEMA_VERSION, status: 'incomplete', executable: false, goal: requirements[0]?.text || '', requirements, assumptions: [],
    decision: { selected: 'Requirements-aligned scaffold', alternatives: [] }, tasks, steps: tasks.length ? [tasks.map((task) => task.id)] : [], validation: { commands: [], requirement_refs: [] }, disagreements: [], unresolved_questions: unresolved,
    provenance: { source, generator: 'x-plan-deterministic', mode: 'scaffold' },
  });
}
export { normalizePlanEnvelope } from './normalize.mjs';
export { validatePlanEnvelope } from './validate.mjs';
export function parsePlanEnvelope(text) {
  try { const input = JSON.parse(String(text)); const result = validatePlanEnvelope(input); return { ok: result.valid, ...result }; }
  catch (error) { return { ok: false, valid: false, errors: [{ code: 'plan.invalid_json', path: '$', message: error.message }], warnings: [], value: null }; }
}
