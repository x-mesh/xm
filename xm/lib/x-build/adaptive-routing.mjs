/**
 * Adaptive execution routing. The long-lived metrics ledger stores numeric
 * metadata only. Short-lived local leases hold expected files and gate commands
 * so the CLI can verify execution without copying command output into receipts.
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './root.mjs';
import { COST_EVENT_MAX_BYTES, METRICS_MAX_BYTES, metricsPath } from './cost-engine.mjs';
import { appendCostEvent, readCostEvents } from '../cost/index.mjs';

export const ADAPTIVE_MIN_SAMPLES = 10;
export const ADAPTIVE_MAX_ESCALATION_RATE = 0.40;
export const ADAPTIVE_MIN_COST_SAVING = 0.20;
export const ADAPTIVE_MIN_LATENCY_SAVING = 0.15;
export const ADAPTIVE_EVALUATION_WINDOW = 30;
export const ADAPTIVE_CALIBRATION_INTERVAL = 10;
export const ADAPTIVE_MIN_PLANNED_SAMPLES = 3;
const STRONG_GATES = new Set(['boundary', 'property', 'schema', 'stress', 'typecheck', 'build']);
const ROUTES = new Set(['direct', 'planned']);
const OUTCOMES = new Set(['accepted', 'escalated', 'failed']);
const TASK_KINDS = new Set(['bugfix', 'feature', 'refactor', 'docs', 'test', 'config', 'dependency', 'schema', 'security', 'architecture']);
const HIGH_RISK_KINDS = new Set(['dependency', 'schema', 'security', 'architecture']);
const QUALITY_GATES = new Set(['test', 'boundary', 'property', 'schema', 'stress', 'typecheck', 'build']);
const TASK_CLASS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function adaptiveRoutingPath() {
  return join(process.env.X_BUILD_ROOT || ROOT, 'metrics', 'adaptive-routing.jsonl');
}

function adaptiveRunDir() {
  return join(process.env.X_BUILD_ROOT || ROOT, 'adaptive-runs');
}

function leasePath(decisionId) {
  return join(adaptiveRunDir(), `${decisionId}.lease.json`);
}

function receiptPath(decisionId) {
  return join(adaptiveRunDir(), `${decisionId}.receipt.json`);
}

function failedReceiptPath(decisionId) {
  return join(adaptiveRunDir(), `${decisionId}.direct-failed.receipt.json`);
}

function readLocalJSON(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeLocalJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function createLocalJSON(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('decision_id already has an execution lease');
    throw error;
  }
}

function sha256File(path) {
  if (!existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeRelativeFile(cwd, file) {
  const value = normalize(String(file || '').trim());
  if (!value || isAbsolute(value) || value === '..' || value.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`unsafe expected file path: ${file}`);
  }
  const absolute = resolve(cwd, value);
  const rel = relative(cwd, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`expected file escapes cwd: ${file}`);
  const realCwd = realpathSync(cwd);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = realpathSync(existing);
  const realRel = relative(realCwd, realExisting);
  if (realRel === '..' || realRel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(realRel)) {
    throw new Error(`expected file resolves outside cwd: ${file}`);
  }
  return rel.split('\\').join('/');
}

function gitStatus(cwd) {
  const result = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git status failed: ${(result.stderr || '').trim()}`);
  const fields = String(result.stdout || '').split('\0').filter(Boolean);
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (/[RC]/.test(status) && fields[index + 1]) paths.push(fields[++index]);
  }
  return [...new Set(paths)].sort();
}

function gitHead(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git rev-parse HEAD failed: ${(result.stderr || '').trim()}`);
  return result.stdout.trim();
}

function hashMap(cwd, files) {
  return Object.fromEntries(files.map((file) => [file, sha256File(resolve(cwd, file))]));
}

function parseGateCommands(values) {
  const commands = {};
  for (const value of values || []) {
    const split = String(value).indexOf('=');
    if (split <= 0 || split === String(value).length - 1) throw new Error(`gate command must be gate=command: ${value}`);
    const gate = String(value).slice(0, split).trim().toLowerCase();
    const command = String(value).slice(split + 1).trim();
    if (!QUALITY_GATES.has(gate)) throw new Error(`unknown gate command: ${gate}`);
    if (commands[gate]) throw new Error(`duplicate gate command: ${gate}`);
    commands[gate] = command;
  }
  return commands;
}

function measuredCostForEvent(eventId, decisionId) {
  if (!eventId) return null;
  const matches = readCostEvents({ filePath: metricsPath() }).filter((event) => event?.event_id === eventId);
  if (matches.length !== 1) throw new Error('cost_event_id must match exactly one cost event');
  const event = matches[0];
  if (event.cost_source !== 'actual' || finiteNonNegative(event.cost_usd) == null) {
    throw new Error('cost_event_id must reference an actual measured cost');
  }
  if (event.routing_decision_id !== decisionId && event.correlation_id !== decisionId) {
    throw new Error('cost_event_id is not bound to this route decision');
  }
  return event.cost_usd;
}

function measuredCostForDecision(decisionId) {
  const seen = new Set();
  const costs = readCostEvents({ filePath: metricsPath() })
    .filter((event) => event?.cost_source === 'actual'
      && (event.routing_decision_id === decisionId || event.correlation_id === decisionId)
      && finiteNonNegative(event.cost_usd) != null)
    .filter((event) => {
      const key = event.event_id || JSON.stringify([event.timestamp, event.cost_usd]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((event) => event.cost_usd);
  return costs.length ? costs.reduce((sum, value) => sum + value, 0) : null;
}

function normalizeGates(gates) {
  return [...new Set((gates || []).map((gate) => String(gate).trim().toLowerCase()).filter(Boolean))];
}

function finiteNonNegative(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function mean(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : null;
}

function percentile50(values) {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function fileSurface(files) {
  const paths = (files || []).map((file) => String(file).toLowerCase());
  if (paths.length && paths.every((file) => /(^|\/)(docs?|readme)|\.(md|mdx|txt)$/.test(file))) return 'docs';
  if (paths.length && paths.every((file) => /(^|\/)(__tests__|test|tests|spec)(\/|$)|\.(test|spec)\.[^.]+$/.test(file))) return 'test';
  if (paths.length && paths.every((file) => /(^|\/)(package(-lock)?\.json|bun\.lockb?|pnpm-lock\.yaml|yarn\.lock|[^/]+\.(json|ya?ml|toml|ini))$/.test(file))) return 'config';
  return paths.length ? 'code' : 'unknown';
}

export function classifyAdaptiveTask(input) {
  const files = (input.files || []).map((file) => String(file).trim()).filter(Boolean);
  const surface = fileSurface(files);
  let kind = String(input.kind || '').trim().toLowerCase();
  if (!kind && ['docs', 'test', 'config'].includes(surface)) kind = surface;
  const signals = [];
  if (!TASK_KINDS.has(kind)) signals.push('task_kind_missing_or_invalid');
  if (input.public_contract === true) signals.push('public_contract');
  if (input.shared_state === true) signals.push('shared_state');
  if (input.external_dependency === true) signals.push('external_dependency');
  if (input.data_migration === true) signals.push('data_migration');
  if (input.security_sensitive === true) signals.push('security_sensitive');
  const forcedHighRisk = HIGH_RISK_KINDS.has(kind) || signals.some((signal) => [
    'public_contract', 'external_dependency', 'data_migration', 'security_sensitive',
  ].includes(signal));
  return {
    task_class: TASK_KINDS.has(kind) ? `${kind}-${surface}` : null,
    kind: TASK_KINDS.has(kind) ? kind : null,
    surface,
    scope: input.scope || (files.length > 0 && files.length <= 5 ? 'bounded' : 'broad'),
    independent: input.independent === true && input.shared_state !== true,
    file_count: files.length,
    risk: forcedHighRisk ? 'high' : String(input.risk || 'unknown').toLowerCase(),
    signals,
  };
}

export function aggregateAdaptiveRouting(events, taskClass) {
  // Concurrent record attempts can both pass the pre-append replay check. Keep
  // one outcome per recorded decision so a duplicate cannot weight routing.
  const seenDecisions = new Set();
  const allRows = events.filter((row) => {
    if (row?.type !== 'adaptive_route_outcome' || row.task_class !== taskClass) return false;
    if (row.learning_eligible !== true) return false;
    if (!row.decision_id || seenDecisions.has(row.decision_id)) return false;
    seenDecisions.add(row.decision_id);
    return true;
  });
  const historicalFinalFailures = allRows.filter((row) => row.quality_passed === false || row.outcome === 'failed').length;
  const rows = allRows.slice(-ADAPTIVE_EVALUATION_WINDOW);
  const adaptive = rows.filter((row) => row.selected_route === 'direct');
  const planned = rows.filter((row) => row.selected_route === 'planned');
  const escalations = adaptive.filter((row) => row.outcome === 'escalated').length;
  const finalFailures = rows.filter((row) => row.quality_passed === false || row.outcome === 'failed').length;
  const adaptiveCost = mean(adaptive.map((row) => finiteNonNegative(row.cost_usd)));
  const plannedCost = mean(planned.map((row) => finiteNonNegative(row.cost_usd)));
  const adaptiveLatency = percentile50(adaptive.map((row) => finiteNonNegative(row.duration_ms)));
  const plannedLatency = percentile50(planned.map((row) => finiteNonNegative(row.duration_ms)));
  const directCostSamples = adaptive.filter((row) => finiteNonNegative(row.cost_usd) != null).length;
  const plannedCostSamples = planned.filter((row) => finiteNonNegative(row.cost_usd) != null).length;
  const directLatencySamples = adaptive.filter((row) => finiteNonNegative(row.duration_ms) != null).length;
  const plannedLatencySamples = planned.filter((row) => finiteNonNegative(row.duration_ms) != null).length;
  return {
    task_class: taskClass,
    observed_samples: allRows.length,
    observed_planned_samples: allRows.filter((row) => row.selected_route === 'planned').length,
    samples: rows.length,
    direct_samples: adaptive.length,
    planned_samples: planned.length,
    escalations,
    escalation_rate: adaptive.length ? escalations / adaptive.length : null,
    final_quality_failures: finalFailures,
    historical_final_quality_failures: historicalFinalFailures,
    quality_pass_rate: rows.length ? (rows.length - finalFailures) / rows.length : null,
    direct_cost_usd_avg: adaptiveCost,
    planned_cost_usd_avg: plannedCost,
    direct_latency_ms_p50: adaptiveLatency,
    planned_latency_ms_p50: plannedLatency,
    cost_saving: adaptiveCost != null && plannedCost ? 1 - adaptiveCost / plannedCost : null,
    latency_saving: adaptiveLatency != null && plannedLatency ? 1 - adaptiveLatency / plannedLatency : null,
    direct_cost_samples: directCostSamples,
    planned_cost_samples: plannedCostSamples,
    direct_latency_samples: directLatencySamples,
    planned_latency_samples: plannedLatencySamples,
    cost_measurement_coverage: rows.length
      ? rows.filter((row) => finiteNonNegative(row.cost_usd) != null).length / rows.length
      : null,
    latency_measurement_coverage: rows.length
      ? rows.filter((row) => finiteNonNegative(row.duration_ms) != null).length / rows.length
      : null,
    sufficient_sample: adaptive.length >= ADAPTIVE_MIN_SAMPLES,
    evaluation_window: ADAPTIVE_EVALUATION_WINDOW,
  };
}

export function adaptiveEvidenceBlockers(stats) {
  const blockers = [];
  // Planned successes do not prove that a previously failing direct path is
  // safe. Keep the class fail-closed until telemetry is explicitly reset or
  // versioned by a future policy migration.
  if (stats.historical_final_quality_failures > 0) blockers.push('historical_quality_failure');
  if (stats.sufficient_sample && stats.escalation_rate != null && stats.escalation_rate > ADAPTIVE_MAX_ESCALATION_RATE) {
    blockers.push('escalation_rate_above_40_percent');
  }
  if (stats.observed_samples > 0
    && stats.observed_samples % ADAPTIVE_CALIBRATION_INTERVAL === 0) {
    blockers.push('calibration_sample_due');
  }
  if (stats.planned_samples >= ADAPTIVE_MIN_PLANNED_SAMPLES) {
    if (stats.direct_cost_samples >= ADAPTIVE_MIN_PLANNED_SAMPLES
      && stats.planned_cost_samples >= ADAPTIVE_MIN_PLANNED_SAMPLES
      && stats.cost_saving < ADAPTIVE_MIN_COST_SAVING) blockers.push('cost_saving_below_20_percent');
    if (stats.direct_latency_samples >= ADAPTIVE_MIN_PLANNED_SAMPLES
      && stats.planned_latency_samples >= ADAPTIVE_MIN_PLANNED_SAMPLES
      && stats.latency_saving < ADAPTIVE_MIN_LATENCY_SAVING) blockers.push('latency_saving_below_15_percent');
  }
  return blockers;
}

function appendAdaptiveEvent(event) {
  return appendCostEvent({
    filePath: adaptiveRoutingPath(), event, maxBytes: COST_EVENT_MAX_BYTES, rotateAtBytes: METRICS_MAX_BYTES,
  });
}

function unresolvedVerificationFailures(events, taskClass) {
  const outcomes = new Set(events.filter((event) => event?.type === 'adaptive_route_outcome').map((event) => event.decision_id));
  return events.filter((event) => event?.type === 'adaptive_route_verification_failed'
    && event.task_class === taskClass && !outcomes.has(event.decision_id));
}

export function recordAdaptiveDecision(decision) {
  if (!decision?.decision_id || !TASK_CLASS_PATTERN.test(String(decision.task_class || '')) || !ROUTES.has(decision.route)) {
    throw new Error('invalid adaptive route decision');
  }
  return appendAdaptiveEvent({
    schema_v: 1,
    type: 'adaptive_route_decision',
    event_id: `ard-${randomBytes(8).toString('hex')}`,
    timestamp: new Date().toISOString(),
    decision_id: decision.decision_id,
    task_class: decision.task_class,
    selected_route: decision.route,
    quality_hard_gate: true,
    blockers: decision.blockers,
    required_gates: normalizeGates(decision.gates),
  });
}

export function decideAdaptiveRoute(input, events = []) {
  const classification = input.classification || null;
  const taskClass = String(input.task_class || classification?.task_class || '').trim();
  const fileCount = Number(input.file_count ?? classification?.file_count ?? 0);
  const requestedGates = normalizeGates(input.gates);
  const unknownGates = requestedGates.filter((gate) => !QUALITY_GATES.has(gate));
  const gates = requestedGates.filter((gate) => QUALITY_GATES.has(gate));
  const failureModes = Number(input.failure_modes || 0);
  const blockers = [];
  if (!taskClass) blockers.push('task_class_missing');
  else if (!TASK_CLASS_PATTERN.test(taskClass)) blockers.push('task_class_invalid');
  const scope = input.scope || classification?.scope;
  const independent = input.independent ?? classification?.independent;
  const risk = input.risk || classification?.risk;
  if (classification?.signals?.includes('task_kind_missing_or_invalid')) blockers.push('task_kind_missing_or_invalid');
  if (scope !== 'bounded') blockers.push('scope_not_bounded');
  if (independent !== true) blockers.push('files_not_independent');
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 5) blockers.push('file_scope_not_small');
  if (!['low', 'medium'].includes(risk)) blockers.push('risk_high_or_unknown');
  if (failureModes < 1) blockers.push('failure_modes_missing');
  if (!gates.length) blockers.push('quality_gate_missing');
  if (unknownGates.length) blockers.push('unknown_quality_gate');
  if (!gates.some((gate) => STRONG_GATES.has(gate))) blockers.push('strong_quality_gate_missing');

  const stats = aggregateAdaptiveRouting(events, taskClass);
  blockers.push(...adaptiveEvidenceBlockers(stats));
  const unresolvedFailures = unresolvedVerificationFailures(events, taskClass);
  if (unresolvedFailures.length) blockers.push('unresolved_verification_failure');

  const route = blockers.length ? 'planned' : 'direct';
  return {
    schema: 1,
    decision_id: `route-${randomBytes(8).toString('hex')}`,
    task_class: taskClass || null,
    route,
    quality_hard_gate: true,
    max_escalations: route === 'direct' ? 1 : 0,
    clean_state_fallback: route === 'direct',
    gates,
    unknown_gates: unknownGates,
    classification,
    blockers,
    telemetry: stats,
    unresolved_verification_failures: unresolvedFailures.map((event) => event.decision_id),
    thresholds: {
      min_samples: ADAPTIVE_MIN_SAMPLES,
      max_escalation_rate: ADAPTIVE_MAX_ESCALATION_RATE,
      min_cost_saving: ADAPTIVE_MIN_COST_SAVING,
      min_latency_saving: ADAPTIVE_MIN_LATENCY_SAVING,
      evaluation_window: ADAPTIVE_EVALUATION_WINDOW,
      calibration_interval: ADAPTIVE_CALIBRATION_INTERVAL,
      min_planned_samples: ADAPTIVE_MIN_PLANNED_SAMPLES,
    },
  };
}

export function readAdaptiveRoutingEvents() {
  return readCostEvents({ filePath: adaptiveRoutingPath() });
}

export function recordAdaptiveOutcome(input) {
  const selectedRoute = String(input.selected_route || '');
  const outcome = String(input.outcome || '');
  if (!input.task_class) throw new Error('task_class is required');
  if (!TASK_CLASS_PATTERN.test(String(input.task_class))) throw new Error('task_class must be a stable lowercase kebab-case id');
  if (!ROUTES.has(selectedRoute)) throw new Error('selected_route must be direct or planned');
  if (!OUTCOMES.has(outcome)) throw new Error('outcome must be accepted, escalated, or failed');
  if (typeof input.quality_passed !== 'boolean') throw new Error('quality_passed must be true or false');
  if (selectedRoute === 'planned' && outcome === 'escalated') throw new Error('planned route cannot have escalated outcome');
  if (outcome === 'accepted' && input.quality_passed !== true) throw new Error('accepted outcome requires quality_passed=true');
  if (input.duration_ms != null && finiteNonNegative(input.duration_ms) == null) throw new Error('duration_ms must be a non-negative number');
  if (input.cost_usd != null && finiteNonNegative(input.cost_usd) == null) throw new Error('cost_usd must be a non-negative number');
  if (!input.decision_id) throw new Error('decision_id is required');
  const ledger = input.events || readAdaptiveRoutingEvents();
  const decisions = ledger.filter((row) => row?.type === 'adaptive_route_decision' && row.decision_id === input.decision_id);
  if (decisions.length !== 1) throw new Error('decision_id must match exactly one recorded route decision');
  const decision = decisions[0];
  if (decision.task_class !== input.task_class) throw new Error('task_class does not match the recorded route decision');
  if (decision.selected_route !== selectedRoute) throw new Error('selected_route does not match the recorded route decision');
  if (ledger.some((row) => row?.type === 'adaptive_route_outcome' && row.decision_id === input.decision_id)) {
    throw new Error('decision_id already has an outcome');
  }
  const gatesRun = normalizeGates(input.gates_run);
  if (gatesRun.some((gate) => !QUALITY_GATES.has(gate))) throw new Error('gates_run contains an unknown quality gate');
  const requiredGates = normalizeGates(decision.required_gates);
  const missingGates = requiredGates.filter((gate) => !gatesRun.includes(gate));
  if (input.quality_passed && missingGates.length) {
    throw new Error(`quality pass is missing required gates: ${missingGates.join(', ')}`);
  }
  const decisionStartedAt = Date.parse(decision.timestamp);
  const measuredDuration = input.duration_ms == null && Number.isFinite(decisionStartedAt)
    ? Math.max(0, (input.now_ms ?? Date.now()) - decisionStartedAt)
    : input.duration_ms;
  const event = {
    schema_v: 1,
    type: 'adaptive_route_outcome',
    event_id: `aro-${randomBytes(8).toString('hex')}`,
    timestamp: new Date().toISOString(),
    decision_id: input.decision_id || null,
    task_class: String(input.task_class),
    selected_route: selectedRoute,
    outcome,
    quality_passed: input.quality_passed,
    gates_run: gatesRun,
    duration_ms: finiteNonNegative(measuredDuration),
    cost_usd: finiteNonNegative(input.cost_usd),
    evidence_source: input.receipt_verified === true ? 'receipt' : 'manual',
    learning_eligible: input.receipt_verified === true,
  };
  return appendAdaptiveEvent(event);
}

export function startAdaptiveRun(input) {
  const cwd = realpathSync(resolve(input.cwd || process.cwd()));
  const ledger = input.events || readAdaptiveRoutingEvents();
  const decisions = ledger.filter((row) => row?.type === 'adaptive_route_decision' && row.decision_id === input.decision_id);
  if (decisions.length !== 1) throw new Error('decision_id must match exactly one recorded route decision');
  const decision = decisions[0];
  const previousLease = readLocalJSON(leasePath(input.decision_id));
  const fallback = input.fallback === true;
  if (previousLease && !fallback) throw new Error('decision_id already has an execution lease');
  if (fallback && (!previousLease || previousLease.status !== 'verification_failed' || decision.selected_route !== 'direct')) {
    throw new Error('fallback requires a failed direct execution lease');
  }
  const expectedInput = fallback ? previousLease.expected_files : input.expected_files;
  const expectedFiles = [...new Set((expectedInput || []).map((file) => safeRelativeFile(cwd, file)))].sort();
  if (!expectedFiles.length) throw new Error('at least one expected file is required');
  const requiredGates = normalizeGates(decision.required_gates);
  const gateCommands = fallback ? previousLease.gate_commands : parseGateCommands(input.gate_commands);
  const missingCommands = requiredGates.filter((gate) => !gateCommands[gate]);
  if (missingCommands.length) throw new Error(`missing gate commands: ${missingCommands.join(', ')}`);
  const baselineDirty = gitStatus(cwd);
  if (baselineDirty.length && (fallback || input.allow_dirty !== true)) {
    throw new Error(`working tree must be clean before route start: ${baselineDirty.join(', ')}`);
  }
  const lease = {
    schema: 1,
    decision_id: decision.decision_id,
    task_class: decision.task_class,
    selected_route: decision.selected_route,
    cwd,
    baseline_head: gitHead(cwd),
    baseline_dirty: baselineDirty,
    baseline_dirty_hashes: hashMap(cwd, baselineDirty),
    expected_files: expectedFiles,
    baseline_hashes: hashMap(cwd, expectedFiles),
    required_gates: requiredGates,
    gate_commands: gateCommands,
    started_at: fallback ? previousLease.started_at : new Date(input.now_ms ?? Date.now()).toISOString(),
    fallback_started_at: fallback ? new Date(input.now_ms ?? Date.now()).toISOString() : null,
    execution_phase: fallback ? 'planned-fallback' : decision.selected_route,
    failed_direct_receipt: fallback ? failedReceiptPath(decision.decision_id) : null,
    status: 'started',
  };
  if (fallback) writeLocalJSON(leasePath(decision.decision_id), lease);
  else createLocalJSON(leasePath(decision.decision_id), lease);
  return lease;
}

export function verifyAdaptiveRun(input) {
  const lease = readLocalJSON(leasePath(input.decision_id));
  if (!lease) throw new Error('execution lease not found');
  // A failed planned verification is re-verifiable: the planned route has no fallback, so
  // correcting the run and verifying again is its only way forward. A direct lease keeps
  // exactly two exits — `route start --fallback`, recorded as `escalated`, and `route abandon`,
  // recorded as `failed`. finishAdaptiveRun labels anything that is not a `planned-fallback`
  // as `accepted`, and escalation telemetry counts only `escalated`, so letting a direct lease
  // re-verify would erase the escalation the routing evidence gate depends on.
  const reverifiable = lease.status === 'started'
    || (lease.status === 'verification_failed' && lease.execution_phase !== 'direct');
  if (!reverifiable) {
    throw new Error(`execution lease is not verifiable: ${lease.status}`);
  }
  // The declaration is fixed at start. Amending it on re-verification was tried twice and
  // produced a passing receipt for a no-op run both times: an added path has no recorded
  // baseline, so it compares as changed forever, and seeding that baseline from the stored
  // blob diverges from the worktree bytes wherever a git checkout filter applies. Correcting
  // an incomplete declaration therefore needs a new lease, not a mutable one.
  if (Array.isArray(input.expected_files) && input.expected_files.length > 0) {
    throw new Error('expected files are fixed at route start; abandon the lease and start again with the full declaration');
  }
  const gates = [];
  for (const gate of lease.required_gates) {
    const command = lease.gate_commands[gate];
    const result = spawnSync(process.env.SHELL || '/bin/sh', ['-lc', command], {
      cwd: lease.cwd, encoding: 'utf8', timeout: Number(input.timeout_ms || 120000), maxBuffer: 4 * 1024 * 1024,
    });
    gates.push({
      gate, command_sha256: createHash('sha256').update(command).digest('hex'),
      passed: result.status === 0 && !result.error, exit_code: result.status, signal: result.signal || null,
      error_code: result.error?.code || null,
    });
  }
  for (const file of lease.expected_files) safeRelativeFile(lease.cwd, file);
  const changedFiles = gitStatus(lease.cwd);
  const unexpectedFiles = changedFiles.filter((file) => !lease.expected_files.includes(file) && !lease.baseline_dirty.includes(file));
  const finalHashes = hashMap(lease.cwd, lease.expected_files);
  const baselineDirtyChanged = lease.baseline_dirty
    .filter((file) => !lease.expected_files.includes(file))
    .filter((file) => lease.baseline_dirty_hashes[file] !== sha256File(resolve(lease.cwd, file)));
  const changedExpectedFiles = lease.expected_files.filter((file) => lease.baseline_hashes[file] !== finalHashes[file]);
  const headChanged = gitHead(lease.cwd) !== lease.baseline_head;
  const passed = !headChanged && unexpectedFiles.length === 0 && baselineDirtyChanged.length === 0
    && changedExpectedFiles.length > 0 && gates.every((gate) => gate.passed);
  const receipt = {
    schema: 1, decision_id: lease.decision_id, task_class: lease.task_class, selected_route: lease.selected_route,
    baseline_head: lease.baseline_head, head_changed: headChanged, expected_files: lease.expected_files, changed_files: changedFiles,
    unexpected_files: unexpectedFiles, baseline_dirty_changed: baselineDirtyChanged,
    changed_expected_files: changedExpectedFiles, final_hashes: finalHashes, gates, passed,
    verified_at: new Date(input.now_ms ?? Date.now()).toISOString(),
  };
  writeLocalJSON(receiptPath(lease.decision_id), receipt);
  if (!passed && lease.execution_phase === 'direct') {
    writeLocalJSON(failedReceiptPath(lease.decision_id), receipt);
    appendAdaptiveEvent({
      schema_v: 1, type: 'adaptive_route_verification_failed', event_id: `arvf-${randomBytes(8).toString('hex')}`,
      timestamp: receipt.verified_at, decision_id: lease.decision_id, task_class: lease.task_class, selected_route: 'direct',
    });
  }
  writeLocalJSON(leasePath(lease.decision_id), {
    ...lease, status: passed ? 'verified' : 'verification_failed',
    // Retained on any failure, not just a direct one. Dropping them on a planned failure
    // left the lease unrecoverable: fallback is direct-only and re-verification needs the
    // commands to re-run the gates, so nothing could move the lease forward.
    gate_commands: passed ? undefined : lease.gate_commands,
  });
  return receipt;
}

export function finishAdaptiveRun(input) {
  const lease = readLocalJSON(leasePath(input.decision_id));
  const receipt = readLocalJSON(receiptPath(input.decision_id));
  if (!lease || !receipt) throw new Error('verified execution receipt is required');
  if (lease.status !== 'verified' || receipt.passed !== true) throw new Error('execution receipt did not pass');
  for (const file of lease.expected_files) safeRelativeFile(lease.cwd, file);
  if (gitHead(lease.cwd) !== receipt.baseline_head) throw new Error('HEAD changed after verification receipt');
  const currentHashes = hashMap(lease.cwd, lease.expected_files);
  if (JSON.stringify(currentHashes) !== JSON.stringify(receipt.final_hashes)) {
    throw new Error('expected files changed after verification receipt');
  }
  const currentUnexpected = gitStatus(lease.cwd).filter((file) => !lease.expected_files.includes(file) && !lease.baseline_dirty.includes(file));
  if (currentUnexpected.length) throw new Error(`unexpected files changed after verification: ${currentUnexpected.join(', ')}`);
  const startedAt = Date.parse(lease.started_at);
  const durationMs = Number.isFinite(startedAt) ? Math.max(0, (input.now_ms ?? Date.now()) - startedAt) : null;
  const measuredCost = input.cost_event_id
    ? measuredCostForEvent(input.cost_event_id, lease.decision_id)
    : measuredCostForDecision(lease.decision_id);
  const outcomeName = lease.execution_phase === 'planned-fallback' ? 'escalated' : 'accepted';
  const outcome = recordAdaptiveOutcome({
    decision_id: lease.decision_id, task_class: lease.task_class, selected_route: lease.selected_route,
    outcome: outcomeName, quality_passed: true, gates_run: receipt.gates.map((gate) => gate.gate),
    duration_ms: durationMs, cost_usd: measuredCost,
    receipt_verified: true,
  });
  writeLocalJSON(leasePath(lease.decision_id), { ...lease, status: 'finished', finished_at: outcome.timestamp });
  return { lease: readLocalJSON(leasePath(lease.decision_id)), receipt, outcome };
}

export function adaptiveRunStatus(decisionId = null, nowMs = Date.now()) {
  if (!existsSync(adaptiveRunDir())) return { schema: 1, runs: [] };
  const names = decisionId ? [`${decisionId}.lease.json`] : readdirSync(adaptiveRunDir()).filter((name) => name.endsWith('.lease.json'));
  const runs = names.map((name) => readLocalJSON(join(adaptiveRunDir(), name))).filter(Boolean).map((lease) => {
    const started = Date.parse(lease.started_at);
    const ageMs = Number.isFinite(started) ? Math.max(0, nowMs - started) : null;
    const changed = existsSync(lease.cwd) ? gitStatus(lease.cwd) : null;
    let nextAction = 'none';
    if (lease.status === 'started') nextAction = changed?.length ? 'verify' : 'abandon_or_resume';
    else if (lease.status === 'verification_failed') {
      // Only a direct execution can restart as a planned fallback (startAdaptiveRun rejects
      // --fallback for every other route). Recommending it for a planned run pointed the
      // user at a command that refuses to run, after telling them to discard clean work.
      if (lease.execution_phase === 'direct') {
        nextAction = changed?.length ? 'restore_clean_then_fallback' : 'start_fallback';
      } else {
        const receipt = readLocalJSON(receiptPath(lease.decision_id));
        // Every action named here has to be one the CLI accepts for this lease — recommending
        // a command that refuses to run is the defect this branch was added to fix. The
        // declaration is fixed at start, so an undeclared change is resolved by restoring it,
        // not by amending the lease.
        if (receipt?.head_changed) nextAction = 'restore_head_then_abandon';
        else if (receipt?.unexpected_files?.length) nextAction = 'restore_undeclared_then_verify';
        else nextAction = 'fix_then_verify';
      }
    }
    else if (lease.status === 'verified') nextAction = 'finish';
    return {
      decision_id: lease.decision_id, task_class: lease.task_class, selected_route: lease.selected_route,
      status: lease.status, execution_phase: lease.execution_phase, started_at: lease.started_at, age_ms: ageMs,
      stale: ageMs != null && ageMs > 24 * 60 * 60 * 1000 && !['finished', 'abandoned'].includes(lease.status),
      changed_files: changed, next_action: nextAction,
    };
  });
  if (decisionId && !runs.length) throw new Error('execution lease not found');
  return { schema: 1, runs: runs.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at))) };
}

export function abandonAdaptiveRun(input) {
  const lease = readLocalJSON(leasePath(input.decision_id));
  if (!lease) throw new Error('execution lease not found');
  if (['finished', 'abandoned'].includes(lease.status)) throw new Error(`execution lease is already ${lease.status}`);
  if (!existsSync(lease.cwd)) throw new Error('execution repository is unavailable; lease preserved for manual recovery');
  if (gitHead(lease.cwd) !== lease.baseline_head) throw new Error('cannot abandon after HEAD changed');
  const changed = gitStatus(lease.cwd);
  if (JSON.stringify(changed) !== JSON.stringify(lease.baseline_dirty)) {
    throw new Error('cannot abandon while worktree differs from the recorded baseline');
  }
  const currentDirtyHashes = hashMap(lease.cwd, lease.baseline_dirty);
  if (JSON.stringify(currentDirtyHashes) !== JSON.stringify(lease.baseline_dirty_hashes)) {
    throw new Error('cannot abandon after baseline dirty bytes changed');
  }
  if (lease.status === 'verification_failed') {
    const receipt = readLocalJSON(receiptPath(lease.decision_id));
    recordAdaptiveOutcome({
      decision_id: lease.decision_id, task_class: lease.task_class, selected_route: lease.selected_route,
      outcome: 'failed', quality_passed: false, gates_run: receipt?.gates?.filter((gate) => gate.passed).map((gate) => gate.gate) || [],
      receipt_verified: true,
    });
  }
  const abandoned = { ...lease, status: 'abandoned', abandoned_at: new Date(input.now_ms ?? Date.now()).toISOString() };
  writeLocalJSON(leasePath(lease.decision_id), abandoned);
  return abandoned;
}

function take(args, name, fallback = null) {
  const direct = args.indexOf(`--${name}`);
  if (direct >= 0) return args[direct + 1] ?? fallback;
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function has(args, name) { return args.includes(`--${name}`); }
function list(value) { return String(value || '').split(',').map((item) => item.trim()).filter(Boolean); }
function values(args, name) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}` && args[index + 1]) result.push(args[index + 1]);
    else if (args[index].startsWith(`--${name}=`)) result.push(args[index].slice(name.length + 3));
  }
  return result;
}

export function cmdAdaptiveRoute(args) {
  const [verb] = args;
  const json = has(args, 'json');
  try {
    if (verb === 'decide') {
      const files = list(take(args, 'files'));
      const classification = classifyAdaptiveTask({
        kind: take(args, 'kind'), files, scope: take(args, 'scope'),
        independent: has(args, 'independent') && !has(args, 'shared'),
        shared_state: has(args, 'shared-state') || has(args, 'shared'),
        public_contract: has(args, 'public-contract'),
        external_dependency: has(args, 'external-dependency'),
        data_migration: has(args, 'data-migration'),
        security_sensitive: has(args, 'security-sensitive'),
        risk: take(args, 'risk'),
      });
      const decision = decideAdaptiveRoute({
        task_class: take(args, 'class'),
        classification,
        failure_modes: Number(take(args, 'failure-modes', 0)),
        gates: list(take(args, 'gates')),
      }, readAdaptiveRoutingEvents());
      recordAdaptiveDecision(decision);
      console.log(JSON.stringify(decision, null, 2));
      return decision;
    }
    if (verb === 'record') {
      const quality = take(args, 'quality');
      const event = recordAdaptiveOutcome({
        decision_id: take(args, 'decision-id'),
        task_class: take(args, 'class'),
        selected_route: take(args, 'route'),
        outcome: take(args, 'outcome'),
        quality_passed: quality === 'pass' ? true : quality === 'fail' ? false : null,
        gates_run: list(take(args, 'gates-run')),
        duration_ms: take(args, 'duration-ms'),
        cost_usd: take(args, 'cost-usd'),
      });
      const result = { schema: 1, recorded: true, event };
      console.log(json ? JSON.stringify(result, null, 2) : `Recorded adaptive outcome ${event.event_id}`);
      return result;
    }
    if (verb === 'start') {
      const result = startAdaptiveRun({
        decision_id: take(args, 'decision-id'), expected_files: list(take(args, 'expected-files')),
        gate_commands: values(args, 'gate-cmd'), allow_dirty: has(args, 'allow-dirty'), fallback: has(args, 'fallback'),
      });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (verb === 'verify') {
      const result = verifyAdaptiveRun({
        decision_id: take(args, 'decision-id'), timeout_ms: take(args, 'timeout-ms'),
        expected_files: list(take(args, 'expected-files')),
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.passed) process.exitCode = 2;
      return result;
    }
    if (verb === 'finish') {
      if (take(args, 'cost-usd') != null) throw new Error('route finish does not accept self-reported --cost-usd; actual cost is linked automatically');
      const result = finishAdaptiveRun({
        decision_id: take(args, 'decision-id'), cost_event_id: take(args, 'cost-event-id'),
      });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (verb === 'status') {
      const result = adaptiveRunStatus(take(args, 'decision-id'));
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (verb === 'abandon') {
      const result = abandonAdaptiveRun({ decision_id: take(args, 'decision-id') });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (verb === 'report') {
      const events = readAdaptiveRoutingEvents();
      const requestedClass = take(args, 'class');
      const classes = requestedClass
        ? [requestedClass]
        : [...new Set(events.map((event) => event?.task_class).filter((value) => TASK_CLASS_PATTERN.test(String(value))))].sort();
      const reports = classes.map((taskClass) => {
        const telemetry = aggregateAdaptiveRouting(events, taskClass);
        return {
          task_class: taskClass,
          evidence_blockers: adaptiveEvidenceBlockers(telemetry),
          comparison_ready: telemetry.direct_samples >= ADAPTIVE_MIN_PLANNED_SAMPLES
            && telemetry.planned_samples >= ADAPTIVE_MIN_PLANNED_SAMPLES,
          coverage: {
            cost: telemetry.cost_measurement_coverage,
            latency: telemetry.latency_measurement_coverage,
            quality: telemetry.samples ? 1 : null,
          },
          telemetry,
        };
      });
      const result = { schema: 1, reports };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    throw new Error('Usage: xm build route decide|start|verify|finish|status|abandon|record|report [options]');
  } catch (error) {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
    return null;
  }
}
