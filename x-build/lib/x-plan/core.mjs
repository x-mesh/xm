import { PLAN_SCHEMA_VERSION } from './schema.mjs';
import { normalizePlanEnvelope } from './normalize.mjs';
import { validatePlanEnvelope } from './validate.mjs';

function cleanItem(line) { return String(line || '').replace(/^\s*(?:[-*]|\d+[.)])\s*/, '').trim(); }
function sectionName(line) { return String(line || '').match(/^\s*#{1,6}\s+(.+?)\s*$/)?.[1].trim().toLowerCase() || null; }
function pathRefs(text) { return [...new Set([...String(text || '').matchAll(/(?:^|[\s'\"(])((?:src|lib|app|test|tests|docs|scripts)\/[A-Za-z0-9_.\/-]+)/g)].map((match) => match[1].replace(/[.,;:!?]+$/, '')))].sort(); }
function parseRequirements(text) {
  const source = String(text || '');
  const rows = source.split(/\r?\n/);
  const sections = { goal: [], requirements: [], validation: [] };
  let current = null;
  let fence = null;
  for (const raw of rows) {
    const fenceMatch = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = sectionName(raw);
    if (heading) {
      current = /^(goal|objective)$/.test(heading) ? 'goal'
        : /^(requirements?|acceptance criteria)$/.test(heading) ? 'requirements'
          : /^(validation|verification|checks?)$/.test(heading) ? 'validation' : null;
      continue;
    }
    const item = cleanItem(raw);
    if (item && current) sections[current].push(item);
  }
  const structured = sections.requirements.length > 0 || sections.goal.length > 0 || sections.validation.length > 0;
  const fallback = structured ? [] : rows.map(cleanItem).filter((line) => line && !sectionName(line));
  const requirementLines = sections.requirements.length ? sections.requirements : fallback;
  const requirements = requirementLines.map((line, index) => {
    const explicit = line.match(/^\[?(R(?:EQ-?)?\d+)\]?\s*[:.)-]?\s*(.+)$/i);
    return { id: explicit ? explicit[1].toUpperCase() : 'R' + (index + 1), text: explicit ? explicit[2].trim() : line, priority: 'must' };
  });
  return { goal: sections.goal[0] || requirements[0]?.text || '', requirements, validation: sections.validation, files: pathRefs(source) };
}
export function createPlanEnvelope(requirementsText, { source = 'literal' } = {}) {
  const parsed = parseRequirements(requirementsText);
  const requirements = parsed.requirements;
  const tasks = requirements.map((requirement, index) => ({
    id: `T${index + 1}`, title: `Implement ${requirement.id}: ${requirement.text}`, depends_on: [],
    requirement_refs: [requirement.id], expected_files: pathRefs(requirement.text).length ? pathRefs(requirement.text) : parsed.files,
    done_criteria: [requirement.text],
  }));
  const unresolved = requirements.length && parsed.files.length && parsed.validation.length ? [] : requirements.length ? ['Task decomposition requires planner or user decisions.'] : ['At least one requirement is required.'];
  return normalizePlanEnvelope({
    schema_version: PLAN_SCHEMA_VERSION, status: unresolved.length ? 'incomplete' : 'complete', executable: unresolved.length === 0, goal: parsed.goal, requirements, assumptions: [],
    decision: { selected: 'Requirements-aligned scaffold', alternatives: [] }, tasks, steps: tasks.length ? [tasks.map((task) => task.id)] : [], validation: { commands: parsed.validation, requirement_refs: requirements.map((item) => item.id) }, disagreements: [], unresolved_questions: unresolved,
    provenance: { source, generator: 'x-plan-deterministic', mode: 'scaffold' },
  });
}
export { normalizePlanEnvelope } from './normalize.mjs';
export { validatePlanEnvelope } from './validate.mjs';
export function parsePlanEnvelope(text) {
  try { const input = JSON.parse(String(text)); const result = validatePlanEnvelope(input); return { ok: result.valid, ...result }; }
  catch (error) { return { ok: false, valid: false, errors: [{ code: 'plan.invalid_json', path: '$', message: error.message }], warnings: [], value: null }; }
}
