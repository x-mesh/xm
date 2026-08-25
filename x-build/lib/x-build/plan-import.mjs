/** Import a validated x-plan PlanEnvelope into x-build's execution harness. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASES, TASK_STATES, readJSON, writeJSON, writeMD, manifestPath, phaseStatusPath, tasksPath, stepsPath, prdPath, contextDir, phaseDir, resolveProject, exitFail } from './core.mjs';
import { computeSteps } from './tasks.mjs';
import { compileParallelBatches } from './worktree-shared.mjs';
import { savePlanIntent } from './plan-state.mjs';
import { ensureBuildIdentity, recordEffectiveness } from './effectiveness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadPlanCore() {
  const candidates = [join(HERE, '..', 'x-plan', 'core.mjs'), join(HERE, '..', '..', '..', 'x-plan', 'lib', 'x-plan', 'core.mjs')];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try { return await import(path); } catch {}
  }
  return null;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) return null;
  const path = normalize(value.trim()).split('\\').join('/').replace(/^\.\//, '');
  if (!path || /^[A-Za-z]:\//.test(path) || path.includes('\0') || path === '..' || path.startsWith('../') || path.includes('/../')) return null;
  return path;
}

function taskSize(task) {
  const files = task.expected_files?.length || 0;
  const criteria = task.done_criteria?.length || 0;
  return files >= 4 || criteria >= 6 ? 'large' : files >= 2 || criteria >= 3 ? 'medium' : 'small';
}

function compileTasks(plan) {
  const idMap = new Map(plan.tasks.map((task, index) => [task.id, 't' + (index + 1)]));
  const now = new Date().toISOString();
  return plan.tasks.map((task) => ({
    id: idMap.get(task.id), source_plan_id: task.id,
    name: task.title + (task.requirement_refs.length ? ' ' + task.requirement_refs.map((ref) => '[' + ref + ']').join(' ') : ''),
    description: 'Imported from native PlanEnvelope task ' + task.id + '.',
    depends_on: task.depends_on.map((id) => idMap.get(id)), size: taskSize(task), role: null, strategy: null, rubric: null, team: null, score: null,
    done_criteria: [...task.done_criteria], expected_files: task.expected_files.map(safeRelativePath), interface_contract: null,
    review_group: 'build', status: TASK_STATES.PENDING, created_at: now,
  }));
}

function importFailures(plan, compiled) {
  const failures = [];
  for (let index = 0; index < compiled.length; index += 1) {
    const source = plan.tasks[index]; const task = compiled[index];
    if (!source.expected_files.length) failures.push(source.id + ': expected_files is required for execution compilation');
    if (task.expected_files.some((path) => !path)) failures.push(source.id + ': expected_files contains an unsafe path');
    if (!source.done_criteria.length) failures.push(source.id + ': done_criteria is required');
    if (task.depends_on.some((id) => !id)) failures.push(source.id + ': dependency could not be mapped');
  }
  if (!plan.validation.commands.length) failures.push('validation.commands must contain at least one verified command');
  return failures;
}

function requirementsMarkdown(plan) { return ['# Requirements', '', ...plan.requirements.map((item) => '- [' + item.id + '] ' + item.text), ''].join('\n'); }
function deltaPrd(plan) {
  return ['<!-- prd-tier: delta -->', '# PRD: ' + plan.goal, '', '## Goal', plan.goal, '', '## Success Criteria', ...plan.requirements.map((item) => '- [ ] [' + item.id + '] ' + item.text), '', '## Decision Plan', '- Selected approach: imported native PlanEnvelope.', '', '## 12. Acceptance Criteria', ...plan.requirements.map((item) => '- [ ] ' + item.text + ' [' + item.id + ']'), '', '## Validation', ...plan.validation.commands.map((command) => '- ' + command), ''].join('\n');
}

function parallelismForSteps(tasks, steps) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const safe = new Set(); const sequential = new Set(); const batches = [];
  for (const step of steps) {
    const rows = step.tasks.map((id) => byId.get(id)).filter(Boolean);
    const result = compileParallelBatches(rows, 4);
    result.scheduled_parallel_tasks.forEach((id) => safe.add(id)); result.sequential.forEach((id) => sequential.add(id));
    batches.push({ step: step.id, parallel_batches: result.parallel_batches, sequential: result.sequential, conflict_edges: result.conflict_edges });
  }
  const parallelSteps = batches.filter((batch) => batch.parallel_batches.some((group) => group.length >= 2)).length;
  const serialTaskUnits = tasks.length;
  const criticalPathTaskUnits = steps.reduce((sum, step) => sum + (step.tasks.length ? 1 : 0), 0);
  return {
    safe_tasks: [...safe], sequential_tasks: [...sequential], safe_ratio: tasks.length ? safe.size / tasks.length : 0,
    max_step_width: Math.max(0, ...steps.map((step) => step.tasks.length)), parallel_steps: parallelSteps,
    serial_task_units: serialTaskUnits, critical_path_task_units: criticalPathTaskUnits,
    theoretical_task_speedup: criticalPathTaskUnits ? serialTaskUnits / criticalPathTaskUnits : 1, batches,
  };
}

function compileSteps(plan, tasks) {
  const idMap = new Map(plan.tasks.map((task, index) => [task.id, 't' + (index + 1)]));
  computeSteps(tasks); // cycle and dependency integrity guard
  return plan.steps.map((step, index) => ({ id: index + 1, tasks: step.map((id) => idMap.get(id)), status: 'pending' }));
}

function enterPlanPhase(project) {
  const manifest = readJSON(manifestPath(project));
  if (manifest.current_phase === '02-plan') return;
  const now = new Date().toISOString();
  const research = readJSON(phaseStatusPath(project, '01-research')) || { phase: 'research' };
  const plan = readJSON(phaseStatusPath(project, '02-plan')) || { phase: 'plan' };
  research.status = 'completed'; research.completed_at = now;
  plan.status = 'active'; plan.started_at = plan.started_at || now; plan.completed_at = null;
  manifest.current_phase = '02-plan'; manifest.updated_at = now;
  writeJSON(phaseStatusPath(project, '01-research'), research); writeJSON(phaseStatusPath(project, '02-plan'), plan); writeJSON(manifestPath(project), manifest);
}

export async function cmdImportPlan(args) {
  const file = args.find((arg) => !arg.startsWith('--')); const json = args.includes('--json'); const replace = args.includes('--replace');
  // --quiet keeps stdout free for a caller that already wrote a JSON document
  // there (the `xm build plan` bridge). Reports go to stderr instead.
  const emit = args.includes('--quiet') ? console.error : console.log;
  if (!file) { console.error('Usage: x-build import-plan <envelope.json> [--json] [--replace]'); exitFail(1); return; }
  const project = resolveProject(null); const manifest = readJSON(manifestPath(project));
  const currentPhase = PHASES.find((phase) => phase.id === manifest?.current_phase)?.name;
  if (!['research', 'plan'].includes(currentPhase)) { console.error('❌ import-plan requires Research or Plan phase; current phase is ' + currentPhase); exitFail(1); return; }
  const existingTasks = readJSON(tasksPath(project))?.tasks || [];
  const hadExistingPlan = existingTasks.length > 0 || existsSync(prdPath(project));
  if (!replace && hadExistingPlan) {
    emit(JSON.stringify({ action: 'import-plan', status: 'blocked', failures: ['project already has plan artifacts; pass --replace to overwrite them'] }, null, 2));
    process.exitCode = 2; return;
  }
  let input; try { input = readFileSync(resolve(file), 'utf8'); } catch (error) { console.error('❌ Cannot read plan: ' + error.message); exitFail(1); return; }
  const core = await loadPlanCore();
  if (!core?.parsePlanEnvelope) { console.error('❌ x-plan validator is unavailable'); exitFail(1); return; }
  const checked = core.parsePlanEnvelope(input);
  if (!checked.valid) { emit(JSON.stringify({ action: 'import-plan', status: 'invalid', errors: checked.errors }, null, 2)); process.exitCode = 2; return; }
  const plan = checked.value;
  if (!plan.executable || plan.status !== 'complete') { console.error('❌ Only complete executable PlanEnvelopes can be imported'); exitFail(1); return; }
  const tasks = compileTasks(plan); const failures = importFailures(plan, tasks);
  if (failures.length) { emit(JSON.stringify({ action: 'import-plan', status: 'blocked', failures }, null, 2)); process.exitCode = 2; return; }
  let steps; try { steps = compileSteps(plan, tasks); } catch (error) { console.error('❌ ' + error.message); exitFail(1); return; }
  const parallel = parallelismForSteps(tasks, steps);
  const identity = ensureBuildIdentity(project, manifest?.build_profile || 'standard', { source: 'imported', confidence: 'high', reasons: ['native_plan_import'] });
  writeJSON(tasksPath(project), { tasks });
  writeJSON(stepsPath(project), { steps, computed_at: new Date().toISOString(), source: 'import-plan' });
  writeMD(join(contextDir(project), 'REQUIREMENTS.md'), requirementsMarkdown(plan)); writeMD(prdPath(project), deltaPrd(plan));
  writeJSON(join(phaseDir(project, '02-plan'), 'imported-plan.json'), plan);
  savePlanIntent(project, { goal: plan.goal, requestedAction: 'plan_only', intentCheck: { readiness: 'ready', gaps: [], questions: [], fact_probes: [] }, draft: false, profile: identity.profile, buildId: identity.build_id, traceId: identity.trace_id });
  enterPlanPhase(project);
  const report = { action: 'import-plan', project, status: 'imported', replaced_existing: replace && hadExistingPlan, source: resolve(file), profile: identity.profile, tasks: tasks.length, steps: steps.length, validation_commands: plan.validation.commands, validation_commands_untrusted: true, parallelism: parallel, next_action: 'plan-check', approval_required: true };
  recordEffectiveness(project, 'plan_imported', { task_count: tasks.length, step_count: steps.length, parallel_safe_count: parallel.safe_tasks.length, source: 'PlanEnvelope' });
  emit(json ? JSON.stringify(report, null, 2) : '✅ Imported ' + tasks.length + ' tasks. Next: x-build plan-check'); return report;
}
