import { PLAN_SCHEMA_VERSION } from './schema.mjs';

function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function strings(value) { return Array.isArray(value) ? value.map(text).filter(Boolean) : []; }
function byId(a, b) { return String(a.id).localeCompare(String(b.id)); }

export function normalizePlanEnvelope(input = {}) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const unresolved = strings(value.unresolved_questions);
  const requirements = (Array.isArray(value.requirements) ? value.requirements : []).map((item) => ({
    id: text(item?.id), text: text(item?.text), priority: text(item?.priority) || 'must',
  })).sort(byId);
  const assumptions = (Array.isArray(value.assumptions) ? value.assumptions : []).map((item) => ({
    id: text(item?.id), text: text(item?.text), confidence: text(item?.confidence) || 'unknown', evidence: item?.evidence == null ? null : text(item.evidence),
  })).sort(byId);
  const tasks = (Array.isArray(value.tasks) ? value.tasks : []).map((item) => {
    const verifyCommands = strings(item?.verify_commands);
    const contractDeps = strings(item?.contract_deps).sort();
    return {
      id: text(item?.id), title: text(item?.title), depends_on: strings(item?.depends_on).sort(),
      requirement_refs: strings(item?.requirement_refs).sort(), expected_files: strings(item?.expected_files).sort(),
      done_criteria: strings(item?.done_criteria),
      // Both emitted only when set, and appended in the order they were added: x-build hashes
      // the normalized task to detect a revised plan, so an always-present or reordered key
      // would reset the progress of every session stored before it.
      ...(verifyCommands.length ? { verify_commands: verifyCommands } : {}),
      ...(contractDeps.length ? { contract_deps: contractDeps } : {}),
    };
  }).sort(byId);
  // mode 'none — <justification>' is the explicit "no failure mode" form, so
  // silence and "nothing to defend" stay distinguishable.
  const failureModes = (Array.isArray(value.failure_modes) ? value.failure_modes : []).map((item) => ({
    requirement_ref: text(item?.requirement_ref), mode: text(item?.mode),
    mitigation: text(item?.mitigation), verification: text(item?.verification),
  }));
  const outOfScope = strings(value.out_of_scope);
  const validation = value.validation && typeof value.validation === 'object' && !Array.isArray(value.validation) ? value.validation : {};
  return {
    schema_version: Number(value.schema_version ?? PLAN_SCHEMA_VERSION),
    status: text(value.status) || (unresolved.length ? 'incomplete' : 'complete'),
    executable: Boolean(value.executable) && unresolved.length === 0,
    goal: text(value.goal), requirements, assumptions,
    decision: { selected: text(value.decision?.selected), alternatives: (Array.isArray(value.decision?.alternatives) ? value.decision.alternatives : []).map((item) => ({ name: text(item?.name), rejected_because: text(item?.rejected_because) })) },
    tasks, steps: (Array.isArray(value.steps) ? value.steps : []).map(strings),
    validation: { commands: strings(validation.commands), requirement_refs: strings(validation.requirement_refs).sort() },
    failure_modes: failureModes,
    // Emitted only when set: x-build batch receipts store a hash of the normalized envelope,
    // so an always-present key would invalidate every receipt written before it.
    ...(outOfScope.length ? { out_of_scope: outOfScope } : {}),
    disagreements: (Array.isArray(value.disagreements) ? value.disagreements : []).map((item) => ({ topic: text(item?.topic), positions: strings(item?.positions), resolution: text(item?.resolution), confidence: text(item?.confidence) || 'unknown' })),
    unresolved_questions: unresolved,
    provenance: value.provenance && typeof value.provenance === 'object' && !Array.isArray(value.provenance) ? { ...value.provenance } : {},
  };
}

export function stablePlanJSON(input, { pretty = false } = {}) {
  return JSON.stringify(normalizePlanEnvelope(input), null, pretty ? 2 : 0);
}
