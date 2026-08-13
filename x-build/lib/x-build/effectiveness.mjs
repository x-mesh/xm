/**
 * x-build/effectiveness — semantic build telemetry and post-hoc aggregation.
 *
 * Trace files answer "what ran and how much did it cost?". These events answer
 * "did the workflow change the plan or prevent rework?". Payloads deliberately
 * contain counts and hashes only; artifact text and prompts never enter metrics.
 */

import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  ROOT, appendCostEvent, manifestPath, phaseDir, phaseStatusPath, prdPath, contextDir, readJSON, readMD,
  tasksPath, writeJSON, metricsPath, C, exitFail,
} from './core.mjs';
import { BUILD_PROFILES, aggregateEffectiveness } from './effectiveness-aggregate.mjs';

export { BUILD_PROFILES, aggregateEffectiveness } from './effectiveness-aggregate.mjs';
export const REVISION_REASONS = ['research', 'user', 'critique', 'plan-check', 'execution', 'unknown'];

export function normalizeBuildProfile(value) {
  if (value == null || value === '') return null;
  const profile = String(value).trim().toLowerCase();
  if (!BUILD_PROFILES.includes(profile)) {
    throw new Error(`invalid build profile "${value}" (expected: ${BUILD_PROFILES.join('|')})`);
  }
  return profile;
}

export function normalizeRevisionReason(value) {
  const reason = value == null || value === true || value === '' ? 'unknown' : String(value).trim().toLowerCase();
  if (!REVISION_REASONS.includes(reason)) {
    throw new Error(`invalid revision reason "${value}" (expected: ${REVISION_REASONS.join('|')})`);
  }
  return reason;
}

function planStatePath(project) {
  return join(phaseDir(project, '02-plan'), 'plan-state.json');
}

function activeTraceId() {
  const active = join(dirname(ROOT), 'traces', '.active');
  if (!existsSync(active)) return null;
  try { return readFileSync(active, 'utf8').trim() || null; } catch { return null; }
}

export function newBuildId() {
  return `b-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

export function buildIdentity(project) {
  const state = readJSON(planStatePath(project)) || {};
  const manifest = readJSON(manifestPath(project)) || {};
  return {
    build_id: state.build_id || manifest.build_id || null,
    trace_id: state.trace_id || manifest.trace_id || null,
    profile: state.profile || manifest.build_profile || null,
  };
}

export function ensureBuildIdentity(project, profile = null) {
  const statePath = planStatePath(project);
  const state = readJSON(statePath) || {};
  const manifest = readJSON(manifestPath(project)) || {};
  const previousProfile = state.profile || manifest.build_profile || null;
  const buildId = state.build_id || manifest.build_id || newBuildId();
  const traceId = state.trace_id || manifest.trace_id || activeTraceId();
  const selectedProfile = profile || previousProfile || null;
  const now = new Date().toISOString();

  Object.assign(state, { build_id: buildId, trace_id: traceId, profile: selectedProfile, updated_at: now });
  Object.assign(manifest, { build_id: buildId, trace_id: traceId, build_profile: selectedProfile, updated_at: now });
  writeJSON(statePath, state);
  writeJSON(manifestPath(project), manifest);
  if (manifest.current_phase) seedPhaseEffect(project, manifest.current_phase);

  if (selectedProfile && selectedProfile !== previousProfile) {
    appendCostEvent({
      type: 'profile_selected', project, build_id: buildId, trace_id: traceId,
      profile: selectedProfile, selection: 'explicit', previous_profile: previousProfile, timestamp: now,
    });
  }
  return { build_id: buildId, trace_id: traceId, profile: selectedProfile };
}

function hash(text) {
  return createHash('sha256').update(String(text || '')).digest('hex');
}

function countMatches(text, pattern) {
  return [...String(text || '').matchAll(pattern)].length;
}

export function artifactSnapshot(project, prdOverride = undefined) {
  const prd = prdOverride === undefined ? readMD(prdPath(project)) : String(prdOverride || '');
  const context = readMD(join(contextDir(project), 'CONTEXT.md'));
  const requirements = readMD(join(contextDir(project), 'REQUIREMENTS.md'));
  const roadmap = readMD(join(contextDir(project), 'ROADMAP.md'));
  const tasks = readJSON(tasksPath(project))?.tasks || [];
  return {
    artifact_hash: hash([context, requirements, roadmap, prd].join('\n---\n')),
    requirements: Math.max(
      countMatches(prd, /^\s*-\s*\[R(?:EQ-?)?\d+\]/gim),
      countMatches(requirements, /^\s*-\s*\[R(?:EQ-?)?\d+\]/gim),
    ),
    risks: countMatches(prd, /^\s*-\s*(?:\[?Risk|RISK-|위험)/gim),
    decisions: countMatches(prd, /^\s*-\s*(?:\[?D\d+|Decision|결정)/gim),
    alternatives: countMatches(prd, /^\s*-\s*(?:Alternative|Option|대안)/gim),
    tasks: tasks.length,
  };
}

export function seedPhaseEffect(project, phaseId) {
  const path = phaseStatusPath(project, phaseId);
  const status = readJSON(path) || {};
  if (!status.effectiveness_start) {
    status.effectiveness_start = artifactSnapshot(project);
    writeJSON(path, status);
  }
  return status.effectiveness_start;
}

export function recordPhaseEffect(project, phaseId, phaseName, durationMs, nextPhaseId = null) {
  const status = readJSON(phaseStatusPath(project, phaseId)) || {};
  const before = status.effectiveness_start || artifactSnapshot(project, '');
  const after = artifactSnapshot(project);
  recordEffectiveness(project, 'phase_effect', {
    phase: phaseName, duration_ms: durationMs, before, after, delta: snapshotDelta(before, after),
  });
  if (nextPhaseId) seedPhaseEffect(project, nextPhaseId);
}

export function snapshotDelta(before, after) {
  const fields = ['requirements', 'risks', 'decisions', 'alternatives', 'tasks'];
  return Object.fromEntries(fields.map((field) => [field, (after?.[field] || 0) - (before?.[field] || 0)]));
}

export function recordEffectiveness(project, type, payload = {}) {
  const identity = buildIdentity(project);
  return appendCostEvent({
    type, project, ...identity, timestamp: new Date().toISOString(), ...payload,
  });
}

export function recordPlanRevision(project, before, after, reason = 'unknown') {
  const firstDraft = !before || !String(before).trim();
  return recordEffectiveness(project, firstDraft ? 'plan_drafted' : 'plan_revision', {
    reason: normalizeRevisionReason(reason),
    before: artifactSnapshot(project, before),
    after: artifactSnapshot(project, after),
    delta: snapshotDelta(artifactSnapshot(project, before), artifactSnapshot(project, after)),
  });
}

function readMetricRows() {
  const file = metricsPath();
  const files = [file + '.1', file];
  const rows = [];
  let malformed = 0;
  for (const candidate of files) {
    if (!existsSync(candidate)) continue;
    for (const line of readFileSync(candidate, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { malformed++; }
    }
  }
  return { rows, malformed };
}

function parseEffectivenessArgs(args) {
  let sinceDays = 30;
  let profiles = null;
  let compare = null;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') json = true;
    else if (arg === '--since') {
      const raw = args[++i];
      const match = /^(\d+)(?:d)?$/.exec(raw || '');
      if (!match) throw new Error('--since expects a number of days, e.g. --since 30d');
      sinceDays = Number(match[1]);
    } else if (arg.startsWith('--since=')) {
      const match = /^(\d+)(?:d)?$/.exec(arg.slice(8));
      if (!match) throw new Error('--since expects a number of days, e.g. --since 30d');
      sinceDays = Number(match[1]);
    } else if (arg === '--profile') profiles = String(args[++i] || '').split(',').filter(Boolean).map(normalizeBuildProfile);
    else if (arg.startsWith('--profile=')) profiles = arg.slice(10).split(',').filter(Boolean).map(normalizeBuildProfile);
    else if (arg === '--compare') compare = String(args[++i] || '').split(',').filter(Boolean).map(normalizeBuildProfile);
    else if (arg.startsWith('--compare=')) compare = arg.slice(10).split(',').filter(Boolean).map(normalizeBuildProfile);
    else throw new Error(`unknown effectiveness option: ${arg}`);
  }
  if (compare && compare.length !== 2) throw new Error('--compare expects exactly two profiles');
  if (compare) profiles = compare;
  return { sinceDays, profiles, compare, json };
}

function pct(value) { return value == null ? 'n/a' : `${Math.round(value * 100)}%`; }
function ms(value) { return value == null ? 'n/a' : `${Math.round(value)}ms`; }

export function cmdEffectiveness(args) {
  let opts;
  try { opts = parseEffectivenessArgs(args); } catch (error) {
    console.error(`❌ ${error.message}`);
    exitFail(1);
    return;
  }
  const { rows, malformed } = readMetricRows();
  const result = aggregateEffectiveness(rows, opts);
  // The aggregator drops a row when it has no build_id, and drops a whole build
  // when none of its rows ever named a profile. Both exclusions are counted here
  // from the aggregator's own verdict rather than re-derived, so the number
  // cannot drift from the rule it reports on.
  // No event-type allow-list: it named three legacy cost events and therefore
  // stayed silent on the aggregated types (phase_effect, verify_outcome,
  // build_complete, ...), which are the rows whose loss actually moves a rate.
  // Every emitter now carries build identity, so a row without one is either
  // pre-feature data or a genuine gap — both worth reporting.
  const unattributed = new Set(result.unattributed_build_ids || []);
  const unlinked = rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row)
    && (!row.build_id || unattributed.has(row.build_id))).length;
  result.coverage = { malformed_rows: malformed, legacy_or_unlinked_events: unlinked };
  result.compare = opts.compare || null;
  if (opts.json) { console.log(JSON.stringify(result, null, 2)); return; }

  console.log(`\n${C.bold}Build Effectiveness${C.reset} — last ${opts.sinceDays}d\n`);
  console.log('  Profile    Builds  Plan time  Research changed  Replan  Reopen  Verify  Complete  Sample');
  for (const row of result.profiles) {
    console.log(`  ${row.profile.padEnd(10)} ${String(row.builds).padEnd(7)} ${ms(row.planning_duration_ms_avg).padEnd(10)} ${pct(row.research_change_rate).padEnd(17)} ${pct(row.execution_replan_rate).padEnd(7)} ${pct(row.task_reopen_rate).padEnd(7)} ${pct(row.verify_first_pass_rate).padEnd(7)} ${pct(row.completion_rate).padEnd(9)} ${row.sufficient_sample ? 'ok' : 'insufficient_sample'}`);
  }
  if (malformed || unlinked) console.log(`\n  ${C.yellow}Coverage: ${malformed} malformed rows, ${unlinked} legacy/unlinked events excluded${C.reset}`);
  console.log('');
}
