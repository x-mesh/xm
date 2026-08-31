import { normalizePlanEnvelope } from './normalize.mjs';
import { validatePlanEnvelope } from './validate.mjs';

function slug(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'candidate'; }
function topoSteps(tasks) {
  const remaining = new Set(tasks.map((task) => task.id));
  const done = new Set();
  const steps = [];
  while (remaining.size) {
    const ready = tasks.filter((task) => remaining.has(task.id) && task.depends_on.every((dep) => done.has(dep))).map((task) => task.id);
    if (!ready.length) return [];
    steps.push(ready); ready.forEach((id) => { remaining.delete(id); done.add(id); });
  }
  return steps;
}
export function synthesizePlanCandidates(candidates, metadata = {}) {
  const valid = [], provenance = [];
  for (const [index, candidate] of candidates.entries()) {
    const source = candidate.source || candidate.model || `candidate-${index + 1}`;
    if (!candidate.ok || !candidate.plan) { provenance.push({ source, role: candidate.role || null, valid: false, error: candidate.error || 'provider_failed' }); continue; }
    const checked = validatePlanEnvelope(candidate.plan);
    provenance.push({ source, role: candidate.role || null, valid: checked.valid, errors: checked.errors });
    if (checked.valid) valid.push({ source, role: candidate.role || null, plan: checked.value });
  }
  if (!valid.length) return { ok: false, error: 'no_valid_candidates', candidates: provenance, plan: null };
  const requirements = [], tasks = [], assumptions = [], unresolved = new Set(), disagreements = [], validationRefs = new Set();
  const disagreementKeys = new Set();
  const addDisagreement = (item) => {
    const normalized = { ...item, positions: [...item.positions] };
    const key = JSON.stringify(normalized);
    if (!disagreementKeys.has(key)) { disagreementKeys.add(key); disagreements.push(normalized); }
  };
  const reqText = new Map(), taskTitle = new Map();
  for (const candidate of valid) {
    const prefix = slug(candidate.source); const reqMap = new Map(), taskMap = new Map();
    for (const req of candidate.plan.requirements) {
      const key = req.text.toLowerCase();
      if (!reqText.has(key)) { const id = `R${requirements.length + 1}`; reqText.set(key, id); requirements.push({ ...req, id }); }
      else {
        const existing = requirements.find((item) => item.id === reqText.get(key));
        if (existing.priority !== req.priority) addDisagreement({ topic: `requirement:${req.text}:priority`, positions: [`${existing.priority}`, `${req.priority}`], resolution: 'unresolved', confidence: 'low' });
      }
      reqMap.set(req.id, reqText.get(key));
    }
    let nextTask = tasks.length + 1;
    const candidateTitles = new Map();
    for (const task of candidate.plan.tasks) {
      const key = task.title.toLowerCase();
      const existing = taskTitle.get(key) || candidateTitles.get(key);
      const id = existing?.id || `T${nextTask++}`;
      taskMap.set(task.id, id);
      if (!existing) candidateTitles.set(key, { id, source: candidate.source });
    }
    for (const task of candidate.plan.tasks) {
      const key = task.title.toLowerCase();
      if (taskTitle.has(key)) {
        const existing = tasks.find((item) => item.id === taskTitle.get(key).id);
        existing.requirement_refs = [...new Set([...existing.requirement_refs, ...task.requirement_refs.map((ref) => reqMap.get(ref)).filter(Boolean)])].sort();
        existing.depends_on = [...new Set([...existing.depends_on, ...task.depends_on.map((dep) => taskMap.get(dep)).filter((dep) => dep && dep !== existing.id)])].sort();
        existing.done_criteria = [...new Set([...existing.done_criteria, ...task.done_criteria])];
        existing.expected_files = [...new Set([...existing.expected_files, ...task.expected_files])].sort();
        addDisagreement({ topic: `task:${task.title}`, positions: [taskTitle.get(key).source, candidate.source], resolution: 'merged equivalent task', confidence: 'medium' }); continue;
      }
      const id = taskMap.get(task.id); taskTitle.set(key, { id, source: candidate.source });
      tasks.push({ ...task, id, depends_on: task.depends_on.map((dep) => taskMap.get(dep)).filter(Boolean), requirement_refs: task.requirement_refs.map((ref) => reqMap.get(ref)).filter(Boolean) });
    }
    for (const assumption of candidate.plan.assumptions) assumptions.push({ ...assumption, id: `A${assumptions.length + 1}` });
    candidate.plan.validation.requirement_refs.map((ref) => reqMap.get(ref)).filter(Boolean).forEach((ref) => validationRefs.add(ref));
    candidate.plan.disagreements.forEach(addDisagreement);
    candidate.plan.unresolved_questions.forEach((item) => unresolved.add(item));
  }
  const goals = [...new Set(valid.map((item) => item.plan.goal).filter(Boolean))];
  if (goals.length > 1) addDisagreement({ topic: 'goal', positions: goals, resolution: 'unresolved', confidence: 'low' });
  const decisions = [...new Set(valid.map((item) => item.plan.decision.selected).filter(Boolean))];
  if (decisions.length > 1) addDisagreement({ topic: 'decision.selected', positions: decisions, resolution: 'unresolved', confidence: 'low' });
  const plan = normalizePlanEnvelope({
    schema_version: 1, status: unresolved.size || disagreements.some((d) => d.resolution === 'unresolved') ? 'incomplete' : 'complete',
    executable: unresolved.size === 0 && !disagreements.some((d) => d.resolution === 'unresolved'),
    goal: goals[0], requirements, assumptions, decision: { selected: decisions.length === 1 ? decisions[0] : '', alternatives: [] }, tasks,
    steps: topoSteps(tasks),
    validation: { commands: [...new Set(valid.flatMap((item) => item.plan.validation.commands))], requirement_refs: [...validationRefs].sort() }, disagreements, unresolved_questions: [...unresolved],
    provenance: { mode: 'ultra', models: valid.map((item) => item.source), roles: valid.map((item) => item.role), candidate_count: candidates.length, valid_candidate_count: valid.length, ...metadata },
  });
  const checked = validatePlanEnvelope(plan);
  return { ok: checked.valid, error: checked.valid ? null : 'synthesis_invalid', candidates: provenance, plan: checked.value, errors: checked.errors };
}
