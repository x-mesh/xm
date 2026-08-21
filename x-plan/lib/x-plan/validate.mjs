import { ASSUMPTION_CONFIDENCE, PLAN_SCHEMA_VERSION, PLAN_STATUSES, REQUIRED_PLAN_FIELDS, REQUIREMENT_PRIORITIES, SAFE_ID_RE } from './schema.mjs';
import { normalizePlanEnvelope } from './normalize.mjs';

function issue(code, path, message) { return { code, path, message }; }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stringArray(value) { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
function duplicates(items) { const seen = new Set(), dup = new Set(); for (const item of items) { if (seen.has(item.id)) dup.add(item.id); seen.add(item.id); } return [...dup]; }
function hasCycle(tasks) {
  const deps = new Map(tasks.map((task) => [task.id, task.depends_on]));
  const visiting = new Set(), done = new Set();
  const visit = (id) => { if (visiting.has(id)) return true; if (done.has(id)) return false; visiting.add(id); for (const dep of deps.get(id) || []) if (deps.has(dep) && visit(dep)) return true; visiting.delete(id); done.add(id); return false; };
  return tasks.some((task) => visit(task.id));
}

export function validatePlanEnvelope(input) {
  const errors = [], warnings = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: [issue('plan.type', '$', 'plan must be an object')], warnings, value: null };
  for (const field of REQUIRED_PLAN_FIELDS) if (!(field in input)) errors.push(issue('plan.missing_field', field, `missing required field ${field}`));
  for (const field of ['requirements', 'assumptions', 'tasks', 'steps', 'disagreements', 'unresolved_questions']) {
    if (field in input && !Array.isArray(input[field])) errors.push(issue('plan.field_type', field, `${field} must be an array`));
  }
  for (const field of ['decision', 'validation', 'provenance']) {
    if (field in input && !object(input[field])) errors.push(issue('plan.field_type', field, `${field} must be an object`));
  }
  if ('schema_version' in input && !Number.isInteger(input.schema_version)) errors.push(issue('plan.field_type', 'schema_version', 'schema_version must be an integer'));
  if ('goal' in input && typeof input.goal !== 'string') errors.push(issue('plan.field_type', 'goal', 'goal must be a string'));
  if ('status' in input && typeof input.status !== 'string') errors.push(issue('plan.field_type', 'status', 'status must be a string'));
  if (typeof input.status === 'string' && !input.status.trim()) errors.push(issue('plan.status', 'status', 'status must not be empty'));
  if ('executable' in input && typeof input.executable !== 'boolean') errors.push(issue('plan.field_type', 'executable', 'executable must be a boolean'));
  if (Array.isArray(input.requirements)) input.requirements.forEach((item, index) => {
    if (!object(item)) errors.push(issue('requirement.type', `requirements[${index}]`, 'requirement must be an object'));
    else for (const field of ['id', 'text', 'priority']) if (field in item && typeof item[field] !== 'string') errors.push(issue('requirement.field_type', `requirements[${index}].${field}`, `${field} must be a string`));
  });
  if (Array.isArray(input.assumptions)) input.assumptions.forEach((item, index) => {
    if (!object(item)) errors.push(issue('assumption.type', `assumptions[${index}]`, 'assumption must be an object'));
    else {
      for (const field of ['id', 'text', 'confidence']) if (field in item && typeof item[field] !== 'string') errors.push(issue('assumption.field_type', `assumptions[${index}].${field}`, `${field} must be a string`));
      if ('evidence' in item && item.evidence !== null && typeof item.evidence !== 'string') errors.push(issue('assumption.field_type', `assumptions[${index}].evidence`, 'evidence must be a string or null'));
    }
  });
  if (Array.isArray(input.tasks)) input.tasks.forEach((item, index) => {
    if (!object(item)) errors.push(issue('task.type', `tasks[${index}]`, 'task must be an object'));
    else for (const field of ['id', 'title']) if (field in item && typeof item[field] !== 'string') errors.push(issue('task.field_type', `tasks[${index}].${field}`, `${field} must be a string`));
  });
  if (object(input.decision)) {
    if ('selected' in input.decision && typeof input.decision.selected !== 'string') errors.push(issue('decision.field_type', 'decision.selected', 'selected must be a string'));
    if ('alternatives' in input.decision && !Array.isArray(input.decision.alternatives)) errors.push(issue('decision.field_type', 'decision.alternatives', 'alternatives must be an array'));
  }
  if (object(input.validation)) {
    for (const field of ['commands', 'requirement_refs']) if (field in input.validation && !stringArray(input.validation[field])) errors.push(issue('validation.field_type', `validation.${field}`, `${field} must be a string array`));
  }
  if (Array.isArray(input.steps)) input.steps.forEach((step, index) => { if (!stringArray(step)) errors.push(issue('steps.field_type', `steps[${index}]`, 'step must be a string array')); });
  if (Array.isArray(input.disagreements)) input.disagreements.forEach((item, index) => {
    if (!object(item)) errors.push(issue('disagreement.type', `disagreements[${index}]`, 'disagreement must be an object'));
    else {
      for (const field of ['topic', 'resolution', 'confidence']) if (field in item && typeof item[field] !== 'string') errors.push(issue('disagreement.field_type', `disagreements[${index}].${field}`, `${field} must be a string`));
      if ('positions' in item && !stringArray(item.positions)) errors.push(issue('disagreement.field_type', `disagreements[${index}].positions`, 'positions must be a string array'));
    }
  });
  if (Array.isArray(input.unresolved_questions) && !stringArray(input.unresolved_questions)) errors.push(issue('plan.field_type', 'unresolved_questions', 'unresolved_questions must be a string array'));
  const requestedExecutable = input.executable === true;
  const value = normalizePlanEnvelope(input);
  if (value.schema_version !== PLAN_SCHEMA_VERSION) errors.push(issue('plan.unsupported_version', 'schema_version', `expected ${PLAN_SCHEMA_VERSION}`));
  if (!PLAN_STATUSES.includes(value.status)) errors.push(issue('plan.status', 'status', 'invalid status'));
  if (value.status === 'invalid') errors.push(issue('plan.invalid_state', 'status', 'invalid status is not a valid plan result'));
  if (requestedExecutable && value.status !== 'complete') errors.push(issue('plan.status_executable', 'status', 'executable plans require status=complete'));
  if (!value.goal) errors.push(issue('plan.goal', 'goal', 'goal is required'));
  if (requestedExecutable && value.requirements.length === 0) errors.push(issue('plan.empty_requirements', 'requirements', 'executable plan requires at least one requirement'));
  if (requestedExecutable && value.tasks.length === 0) errors.push(issue('plan.empty_tasks', 'tasks', 'executable plan requires at least one task'));
  if (requestedExecutable && !value.decision.selected) errors.push(issue('plan.empty_decision', 'decision.selected', 'executable plan requires a selected decision'));
  for (const [kind, items] of [['requirement', value.requirements], ['assumption', value.assumptions], ['task', value.tasks]]) {
    for (const id of duplicates(items)) errors.push(issue(`${kind}.duplicate_id`, `${kind}s`, `duplicate id ${id}`));
    items.forEach((item, index) => { if (!SAFE_ID_RE.test(item.id)) errors.push(issue(`${kind}.id`, `${kind}s[${index}].id`, 'invalid id')); });
  }
  value.requirements.forEach((item, index) => { if (!item.text) errors.push(issue('requirement.text', `requirements[${index}].text`, 'text is required')); if (!REQUIREMENT_PRIORITIES.includes(item.priority)) errors.push(issue('requirement.priority', `requirements[${index}].priority`, 'invalid priority')); });
  value.assumptions.forEach((item, index) => { if (!ASSUMPTION_CONFIDENCE.includes(item.confidence)) errors.push(issue('assumption.confidence', `assumptions[${index}].confidence`, 'invalid confidence')); });
  const taskIds = new Set(value.tasks.map((task) => task.id));
  const reqIds = new Set(value.requirements.map((req) => req.id));
  value.tasks.forEach((task, index) => {
    if (!task.title) errors.push(issue('task.title', `tasks[${index}].title`, 'title is required'));
    if (!task.done_criteria.length) errors.push(issue('task.done_criteria', `tasks[${index}].done_criteria`, 'at least one criterion is required'));
    for (const dep of task.depends_on) if (!taskIds.has(dep)) errors.push(issue('task.dangling_dependency', `tasks[${index}].depends_on`, `unknown task ${dep}`));
    for (const ref of task.requirement_refs) if (!reqIds.has(ref)) errors.push(issue('task.unknown_requirement', `tasks[${index}].requirement_refs`, `unknown requirement ${ref}`));
  });
  if (Array.isArray(input.tasks)) input.tasks.forEach((task, index) => {
    for (const field of ['depends_on', 'requirement_refs', 'expected_files', 'done_criteria']) {
      if (task && field in task && (!Array.isArray(task[field]) || task[field].some((item) => typeof item !== 'string'))) errors.push(issue('task.field_type', `tasks[${index}].${field}`, `${field} must be a string array`));
    }
  });
  if (hasCycle(value.tasks)) errors.push(issue('task.dependency_cycle', 'tasks', 'task dependency cycle detected'));
  const covered = new Set([...value.tasks.flatMap((task) => task.requirement_refs), ...value.validation.requirement_refs]);
  for (const id of reqIds) if (!covered.has(id)) errors.push(issue('requirement.uncovered', 'requirements', `requirement ${id} is not covered`));
  const scheduled = new Map();
  value.steps.forEach((step, stepIndex) => step.forEach((id) => {
    if (!taskIds.has(id)) errors.push(issue('steps.unknown_task', 'steps', `unknown task ${id}`));
    if (scheduled.has(id)) errors.push(issue('steps.duplicate_task', 'steps', `task ${id} scheduled more than once`));
    scheduled.set(id, stepIndex);
  }));
  for (const task of value.tasks) {
    if (!scheduled.has(task.id)) errors.push(issue('steps.missing_task', 'steps', `task ${task.id} is not scheduled`));
    for (const dep of task.depends_on) if (scheduled.has(dep) && scheduled.has(task.id) && scheduled.get(dep) >= scheduled.get(task.id)) errors.push(issue('steps.dependency_order', 'steps', `${dep} must be scheduled before ${task.id}`));
  }
  if (value.unresolved_questions.length && requestedExecutable) errors.push(issue('plan.executable_with_questions', 'executable', 'unresolved questions require executable=false'));
  const hasUnresolvedDisagreement = value.disagreements.some((item) => item.resolution === 'unresolved');
  if (hasUnresolvedDisagreement && requestedExecutable) errors.push(issue('plan.executable_with_disagreement', 'executable', 'unresolved disagreements require executable=false'));
  if (!value.unresolved_questions.length && !hasUnresolvedDisagreement && !value.executable) warnings.push(issue('plan.not_executable', 'executable', 'plan has no unresolved questions or disagreements but is not executable'));
  return { valid: errors.length === 0, errors, warnings, value };
}
