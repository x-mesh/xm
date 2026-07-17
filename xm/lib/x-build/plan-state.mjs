/** Durable plan intent, state, and content-bound approval. */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  readJSON, writeJSON, readMD, manifestPath, tasksPath, stepsPath, prdPath, phaseDir,
} from './core.mjs';
import { loadBuildPolicy } from './build-policy.mjs';

export function planStatePath(project) {
  return join(phaseDir(project, '02-plan'), 'plan-state.json');
}

export function readPlanState(project) {
  return readJSON(planStatePath(project)) || null;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function computePlanHash(project) {
  const state = readPlanState(project) || {};
  const payload = stable({
    // Approval is bound to plan content and user intent. Whether the caller
    // wants to stop after planning or continue executing is a resume control,
    // not plan content; changing it must not invalidate an approved plan.
    intent: { goal: state.goal || null },
    prd: readMD(prdPath(project)),
    tasks: readJSON(tasksPath(project))?.tasks || [],
    steps: readJSON(stepsPath(project))?.steps || [],
    build: loadBuildPolicy(),
  });
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function setRequestedAction(project, requestedAction) {
  if (!['plan_only', 'build'].includes(requestedAction)) {
    throw new Error(`invalid requested action: ${requestedAction}`);
  }
  const state = readPlanState(project);
  if (!state) return null;
  state.requested_action = requestedAction;
  state.updated_at = new Date().toISOString();
  writeJSON(planStatePath(project), state);
  const manifest = readJSON(manifestPath(project));
  if (manifest) {
    manifest.requested_action = requestedAction;
    manifest.updated_at = state.updated_at;
    writeJSON(manifestPath(project), manifest);
  }
  return state;
}

export function savePlanIntent(project, { goal, requestedAction, intentCheck, forcedInterview = false, draft = false }) {
  const previous = readPlanState(project) || {};
  const next = {
    ...previous,
    version: 1,
    state: 'draft',
    goal,
    requested_action: requestedAction,
    intent_check: intentCheck,
    forced_interview: forcedInterview,
    draft_only: draft,
    executable: !draft && intentCheck.readiness === 'ready',
    approved_hash: null,
    updated_at: new Date().toISOString(),
  };
  writeJSON(planStatePath(project), next);
  const manifest = readJSON(manifestPath(project));
  if (manifest) {
    manifest.requested_action = requestedAction;
    manifest.goal = goal;
    manifest.updated_at = next.updated_at;
    writeJSON(manifestPath(project), manifest);
  }
  return next;
}

export function markPlanReady(project, passed) {
  const state = readPlanState(project);
  if (!state) return null; // legacy projects remain compatible
  state.state = passed && !state.draft_only && state.intent_check?.readiness === 'ready' ? 'ready' : 'draft';
  state.executable = state.state === 'ready';
  state.plan_hash = computePlanHash(project);
  if (state.approved_hash !== state.plan_hash) state.approved_hash = null;
  state.updated_at = new Date().toISOString();
  writeJSON(planStatePath(project), state);
  return state;
}

export function approvePlan(project) {
  const state = readPlanState(project);
  if (!state) return null;
  if (!state.executable || !['ready', 'approved'].includes(state.state)) {
    return { ...state, approval_error: 'plan_not_ready' };
  }
  const planHash = computePlanHash(project);
  state.plan_hash = planHash;
  state.approved_hash = planHash;
  state.state = 'approved';
  state.approved_at = new Date().toISOString();
  state.updated_at = state.approved_at;
  writeJSON(planStatePath(project), state);
  return state;
}

export function validatePlanApproval(project) {
  const state = readPlanState(project);
  if (!state) return { ok: true, legacy: true };
  const currentHash = computePlanHash(project);
  if (!state.executable) return { ok: false, reason: 'plan_not_executable', state: state.state, current_hash: currentHash };
  if (state.state !== 'approved' || !state.approved_hash) return { ok: false, reason: 'plan_not_approved', state: state.state, current_hash: currentHash };
  if (state.approved_hash !== currentHash) return { ok: false, reason: 'plan_changed_after_approval', approved_hash: state.approved_hash, current_hash: currentHash };
  return { ok: true, state: state.state, current_hash: currentHash, requested_action: state.requested_action };
}
