/**
 * x-eval/bench — a bench run as a ledger protocol.
 *
 * Strategies are LLM prompt-programs, so node cannot execute a job. Instead:
 *   plan    → `.xm/eval/runs/<run>/manifest.json` lists every (case, arm, trial) job
 *   record  → the session scores one job through the judge panel and hands back
 *             metrics only (`records/<job>.json`, create-only, no output text)
 *   finish  → this module aggregates exactly the way subcommands/bench.md
 *             describes (pass@k, pass^k, σ, broken-task, σ-aware recommendation)
 *             and adds the `direct` control comparison.
 *
 * `finish` is the only authority on the numbers; the skill prints what it returns.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, lstatSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { evalDir, projectRoot } from './root.mjs';
import { DEFAULT_TRIALS, caseFingerprint, passThresholdFor, readCase, validateCase } from './cases.mjs';
import { ASSERTION_KINDS, runAssertions } from './assert.mjs';
import { mean, sigma, round } from './stats.mjs';

export const RUN_SCHEMA_V = 1;
export const CONTROL_ARM = 'direct';
/** bench.md: 0% pass everywhere AND avg < 4.5 everywhere ⇒ the task is broken, not the strategies. */
export const BROKEN_TASK_AVG = 4.5;
/** A strategy is recommended over the single-agent control only when it beats it by this much. */
export const MIN_DELTA_VS_DIRECT = 0.5;
export const BEST_VALUE_MIN_PASS_RATE = 0.67;
export const MAX_TRIALS = 100;
export const MAX_TOTAL_JOBS = 10_000;
export const MAX_RECORD_BYTES = 64 * 1024;
/** Keys a record may never carry: metrics, not model output, live in `.xm/eval/runs/`. */
export const FORBIDDEN_RECORD_KEYS = ['output', 'content', 'prompt', 'transcript', 'raw', 'response', 'text', 'rationale', 'judge_rationales'];
const ARM_RE = /^[a-z][a-z0-9-]{0,31}(\|[a-z][a-z0-9-]{0,31})*$/;
const RUN_ID_RE = /^bench-\d{8}T\d{6}Z-[0-9a-f]{4}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const CASE_ID_RE = /^case-[0-9a-f]{24}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CONFIDENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const RUBRIC_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const MAX_CASES = 1_000;
const MAX_ARMS = 128;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_BENCH_RESULT_BYTES = MAX_MANIFEST_BYTES;
const MAX_CRITERIA = 64;
const MAX_JUDGES = 16;
const MAX_ASSERTION_RESULTS = 128;
const ASSERTION_RESULT_KEYS = new Set(['result', 'source', 'name', 'assertion', 'kind', 'confidence', 'exit_code', 'error_code', 'duration_ms', 'command_sha256']);
const RAW_RECORD_KEYS = new Set(['overall', 'per_criterion', 'judges', 'output_sha256', 'cost_usd_est', 'duration_ms', 'sigma', 'assertion_results', 'passed']);
const STORED_RECORD_KEYS = new Set(['v', 'type', 'run_id', 'job_id', 'case_id', 'arm', 'trial', 'recorded_at', 'pass_threshold', 'cost_source', 'assertion_hard_fail', ...RAW_RECORD_KEYS]);
const MANIFEST_CASE_KEYS = new Set(['id', 'rubric', 'risk', 'tags', 'trials', 'pass_threshold', 'assertions', 'case_sha256', 'case_meta_sha256']);
const BENCH_KEYS = new Set(['type', 'schema_v', 'run_id', 'timestamp', 'task', 'cases', 'rubric', 'pass_threshold', 'control', 'strategies', 'per_case', 'broken_task_warning', 'recommendation', 'advisories', 'partial', 'missing_jobs', 'records', 'artifact_path']);
const BENCH_CASE_KEYS = new Set(['id', 'rubric', 'risk', 'trials', 'pass_threshold']);
const BENCH_ARM_KEYS = new Set(['name', 'trials', 'expected_trials', 'avg_score', 'sigma', 'pass_at_k', 'pass_hat_k', 'pass_at_k_rate', 'per_trial_overall', 'est_cost_usd', 'cost_source', 'avg_time_sec', 'score_per_dollar', 'assertion_hard_fails', 'delta_vs_direct']);
const BENCH_PER_CASE_KEYS = new Set(['case_id', 'pass_threshold', 'arms']);
const BENCH_RECOMMENDATION_KEYS = new Set(['best_quality', 'best_value', 'final', 'best_effort', 'reason']);

export function runsDir() { return evalDir('runs'); }
export function benchmarksDir() { return evalDir('benchmarks'); }

export function runDir(runId) {
  if (!RUN_ID_RE.test(String(runId))) throw new Error(`invalid run id "${runId}"`);
  return join(runsDir(), runId);
}

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `bench-${stamp}-${randomUUID().replace(/-/g, '').slice(0, 4)}`;
}

export function jobIdFor(caseId, arm, trial) {
  return `${caseId}.${arm}.t${trial}`;
}

/** Validate and de-duplicate arm names; `direct` is the control, never a strategy. */
export function parseStrategies(value) {
  const arms = [...new Set(String(value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean))];
  for (const arm of arms) if (!ARM_RE.test(arm)) throw new Error(`strategy "${arm}" must be lowercase letters/digits/dashes (compose pipelines as a|b)`);
  return arms.filter(arm => arm !== CONTROL_ARM);
}

export function buildManifest({ cases, strategies, includeDirect = true, trials = null, runId = newRunId(), createdAt = new Date().toISOString() }) {
  if (!cases?.length) throw new Error('bench plan needs at least one case');
  if (!strategies?.length) throw new Error('bench plan needs at least one strategy (--strategies "refine,debate")');
  if (trials != null && (!Number.isInteger(trials) || trials <= 0 || trials > MAX_TRIALS)) throw new Error(`--trials must be an integer between 1 and ${MAX_TRIALS}`);
  const arms = includeDirect ? [CONTROL_ARM, ...strategies] : [...strategies];
  if (new Set(arms).size !== arms.length) throw new Error('bench plan arms must be unique');
  const manifestCases = [];
  const jobs = [];
  for (const item of cases) {
    validateCase(item, item?.id);
    const n = trials ?? DEFAULT_TRIALS[item.risk || 'normal'] ?? DEFAULT_TRIALS.normal;
    if (!Number.isInteger(n) || n <= 0 || n > MAX_TRIALS) throw new Error(`case ${item.id} trials must be between 1 and ${MAX_TRIALS}`);
    const caseMeta = { id: item.id, rubric: item.rubric || 'general', risk: item.risk || 'normal', tags: item.tags || [], trials: n, pass_threshold: passThresholdFor(item), assertions: (item.assertions || []).length, case_sha256: caseFingerprint(item) };
    manifestCases.push({ ...caseMeta, case_meta_sha256: caseFingerprint(caseMeta) });
    for (const arm of arms) for (let t = 1; t <= n; t++) jobs.push({ job_id: jobIdFor(item.id, arm, t), case_id: item.id, arm, trial: t });
    if (jobs.length > MAX_TOTAL_JOBS) throw new Error(`bench plan exceeds ${MAX_TOTAL_JOBS} total jobs`);
  }
  const manifest = {
    v: RUN_SCHEMA_V, type: 'bench-run', run_id: runId, status: 'open', created_at: createdAt,
    control: includeDirect ? CONTROL_ARM : null, arms, trials_default: trials ?? DEFAULT_TRIALS,
    cases: manifestCases, jobs,
  };
  return validateManifest(manifest, runId);
}

function writeCreateOnly(path, payload, what) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, serializeJson(payload), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { linkSync(tmp, path); } catch (err) {
      if (err?.code === 'EEXIST') {
        const conflict = new Error(`${what} already exists: ${path}`);
        conflict.code = 'EEXIST';
        throw conflict;
      }
      throw err;
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function serializeJson(payload) {
  return JSON.stringify(payload, null, 2) + '\n';
}

function exactObjectKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  const unsupported = Object.keys(value).filter(key => !allowed.has(key));
  if (unsupported.length) throw new Error(`${label} contains an unsupported field: ${unsupported[0]}`);
}

function finiteInRange(value, min, max, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number between ${min} and ${max}`);
}

function validateBenchArm(arm, { expectedName = null, expectedTrials = null, allowDelta = true, passThreshold = null } = {}) {
  exactObjectKeys(arm, BENCH_ARM_KEYS, 'bench arm');
  if (typeof arm.name !== 'string' || !ARM_RE.test(arm.name) || (expectedName != null && arm.name !== expectedName)) throw new Error('bench arm has an invalid name');
  if (!Number.isInteger(arm.trials) || arm.trials < 0 || arm.trials > MAX_TOTAL_JOBS) throw new Error(`bench arm ${arm.name} has an invalid trial count`);
  if (!Number.isInteger(arm.expected_trials) || arm.expected_trials <= 0 || arm.expected_trials > MAX_TOTAL_JOBS
    || (expectedTrials != null && arm.expected_trials !== expectedTrials) || arm.trials > arm.expected_trials) throw new Error(`bench arm ${arm.name} has an invalid expected trial count`);
  finiteInRange(arm.avg_score, 0, 10, `bench arm ${arm.name} avg_score`, { nullable: true });
  finiteInRange(arm.sigma, 0, 10, `bench arm ${arm.name} sigma`, { nullable: true });
  if (!Number.isInteger(arm.pass_at_k) || arm.pass_at_k < 0 || arm.pass_at_k > arm.trials) throw new Error(`bench arm ${arm.name} pass_at_k is inconsistent with trials`);
  const expectedPassHat = arm.trials === arm.expected_trials ? (arm.trials > 0 && arm.pass_at_k === arm.trials ? 1 : 0) : null;
  if (arm.pass_hat_k !== expectedPassHat) throw new Error(`bench arm ${arm.name} pass_hat_k is inconsistent with pass/trial counts`);
  const expectedRate = arm.trials ? round(arm.pass_at_k / arm.trials, 3) : null;
  if (arm.pass_at_k_rate !== expectedRate) throw new Error(`bench arm ${arm.name} pass_at_k_rate is inconsistent with pass/trial counts`);
  if (!Array.isArray(arm.per_trial_overall) || arm.per_trial_overall.length !== arm.trials) throw new Error(`bench arm ${arm.name} per_trial_overall must match trials`);
  for (const score of arm.per_trial_overall) finiteInRange(score, 0, 10, `bench arm ${arm.name} trial score`);
  if (passThreshold != null && arm.pass_at_k !== arm.per_trial_overall.filter(score => score >= passThreshold).length) {
    throw new Error(`bench arm ${arm.name} pass_at_k does not match trial scores and case threshold`);
  }
  const expectedAvg = arm.trials ? round(mean(arm.per_trial_overall), 2) : null;
  const expectedSigma = arm.trials ? round(sigma(arm.per_trial_overall), 2) : null;
  if (arm.avg_score !== expectedAvg || arm.sigma !== expectedSigma) throw new Error(`bench arm ${arm.name} aggregate score fields are inconsistent`);
  finiteInRange(arm.est_cost_usd, 0, Number.MAX_VALUE, `bench arm ${arm.name} est_cost_usd`, { nullable: true });
  if (arm.cost_source !== 'estimated') throw new Error(`bench arm ${arm.name} cost_source must be estimated`);
  finiteInRange(arm.avg_time_sec, 0, Number.MAX_VALUE, `bench arm ${arm.name} avg_time_sec`, { nullable: true });
  finiteInRange(arm.score_per_dollar, 0, Number.MAX_VALUE, `bench arm ${arm.name} score_per_dollar`, { nullable: true });
  const expectedValue = arm.est_cost_usd != null && arm.est_cost_usd > 0 && arm.avg_score != null ? round(arm.avg_score / arm.est_cost_usd, 1) : null;
  if (arm.score_per_dollar !== expectedValue) throw new Error(`bench arm ${arm.name} score_per_dollar is inconsistent`);
  if (!Number.isInteger(arm.assertion_hard_fails) || arm.assertion_hard_fails < 0 || arm.assertion_hard_fails > arm.trials) throw new Error(`bench arm ${arm.name} assertion_hard_fails is inconsistent with trials`);
  if (!allowDelta && Object.hasOwn(arm, 'delta_vs_direct')) throw new Error(`per-case bench arm ${arm.name} must not contain delta_vs_direct`);
  if (Object.hasOwn(arm, 'delta_vs_direct')) finiteInRange(arm.delta_vs_direct, -10, 10, `bench arm ${arm.name} delta_vs_direct`, { nullable: true });
  return arm;
}

/** Strict validation for a persisted `*-bench.json` document. */
export function validatePersistedBench(bench) {
  exactObjectKeys(bench, BENCH_KEYS, 'bench result');
  if (bench.type !== 'bench' || bench.schema_v !== RUN_SCHEMA_V) throw new Error('unsupported bench result schema');
  if (!RUN_ID_RE.test(String(bench.run_id))) throw new Error('bench result has an invalid run id');
  if (typeof bench.timestamp !== 'string' || !Number.isFinite(Date.parse(bench.timestamp)) || new Date(bench.timestamp).toISOString() !== bench.timestamp) throw new Error('bench result has an invalid finish timestamp');
  if (typeof bench.task !== 'string' || !bench.task.length || bench.task.length > 1_024) throw new Error('bench result task must be a bounded string');
  if (!Array.isArray(bench.cases) || !bench.cases.length || bench.cases.length > MAX_CASES) throw new Error(`bench result cases must contain 1-${MAX_CASES} items`);
  const caseIds = new Set();
  let expectedPerArm = 0;
  for (const item of bench.cases) {
    exactObjectKeys(item, BENCH_CASE_KEYS, 'bench case');
    if (!CASE_ID_RE.test(String(item.id)) || caseIds.has(item.id)) throw new Error('bench result case ids must be valid and unique');
    caseIds.add(item.id);
    if (typeof item.rubric !== 'string' || !RUBRIC_RE.test(item.rubric)) throw new Error(`bench case ${item.id} has an invalid rubric`);
    if (!['normal', 'high'].includes(item.risk)) throw new Error(`bench case ${item.id} has an invalid risk`);
    if (!Number.isInteger(item.trials) || item.trials <= 0 || item.trials > MAX_TRIALS) throw new Error(`bench case ${item.id} has an invalid trial count`);
    finiteInRange(item.pass_threshold, 0, 10, `bench case ${item.id} pass_threshold`);
    expectedPerArm += item.trials;
  }
  if (bench.task !== `${bench.cases.length} case(s) from .xm/eval/cases`) throw new Error('bench result task does not match its case count');
  const expectedRubric = [...new Set(bench.cases.map(item => item.rubric))].join(',');
  if (bench.rubric !== expectedRubric) throw new Error('bench result rubric does not match its cases');
  finiteInRange(bench.pass_threshold, 0, 10, 'bench result pass_threshold', { nullable: true });
  const thresholds = [...new Set(bench.cases.map(item => item.pass_threshold))];
  if (bench.pass_threshold !== (thresholds.length === 1 ? thresholds[0] : null)) throw new Error('bench result pass_threshold does not match its cases');
  if (!Array.isArray(bench.strategies) || !bench.strategies.length || bench.strategies.length > MAX_ARMS) throw new Error(`bench result strategies must contain 1-${MAX_ARMS} arms`);
  const armNames = new Set();
  for (const arm of bench.strategies) {
    validateBenchArm(arm, { expectedTrials: expectedPerArm });
    if (armNames.has(arm.name)) throw new Error('bench result arm names must be unique');
    armNames.add(arm.name);
  }
  if (bench.control !== null && (bench.control !== CONTROL_ARM || !armNames.has(bench.control))) throw new Error('bench result control must be direct or null');
  const control = bench.control ? bench.strategies.find(arm => arm.name === bench.control) : null;
  for (const arm of bench.strategies) {
    const expectedDelta = control?.avg_score != null ? (arm.avg_score != null ? (arm.name === CONTROL_ARM ? 0 : round(arm.avg_score - control.avg_score, 2)) : null) : undefined;
    if (expectedDelta === undefined) {
      if (Object.hasOwn(arm, 'delta_vs_direct')) throw new Error(`bench arm ${arm.name} has delta_vs_direct without a measured control`);
    } else if (arm.delta_vs_direct !== expectedDelta) throw new Error(`bench arm ${arm.name} delta_vs_direct is inconsistent`);
  }
  if (!Array.isArray(bench.per_case) || bench.per_case.length !== bench.cases.length) throw new Error('bench result per_case must match cases');
  const perCaseIds = new Set();
  for (const row of bench.per_case) {
    exactObjectKeys(row, BENCH_PER_CASE_KEYS, 'bench per_case row');
    const caseMeta = bench.cases.find(item => item.id === row.case_id);
    if (!caseMeta || perCaseIds.has(row.case_id)) throw new Error('bench result per_case ids must be valid and unique');
    perCaseIds.add(row.case_id);
    if (row.pass_threshold !== caseMeta.pass_threshold) throw new Error(`bench per_case ${row.case_id} pass threshold is inconsistent`);
    if (!Array.isArray(row.arms) || row.arms.length !== bench.strategies.length) throw new Error(`bench per_case ${row.case_id} arms must match strategies`);
    const names = new Set();
    for (const arm of row.arms) {
      validateBenchArm(arm, { expectedTrials: caseMeta.trials, allowDelta: false, passThreshold: caseMeta.pass_threshold });
      if (!armNames.has(arm.name) || names.has(arm.name)) throw new Error(`bench per_case ${row.case_id} arm names must be valid and unique`);
      names.add(arm.name);
    }
  }
  for (const top of bench.strategies) {
    const rows = bench.per_case.map(row => row.arms.find(arm => arm.name === top.name));
    if (rows.some(row => !row)) throw new Error(`bench per_case rows are missing arm ${top.name}`);
    const trialScores = rows.flatMap(row => row.per_trial_overall);
    if (rows.reduce((sum, row) => sum + row.trials, 0) !== top.trials
      || rows.reduce((sum, row) => sum + row.pass_at_k, 0) !== top.pass_at_k
      || rows.reduce((sum, row) => sum + row.assertion_hard_fails, 0) !== top.assertion_hard_fails
      || JSON.stringify(trialScores) !== JSON.stringify(top.per_trial_overall)) throw new Error(`bench arm ${top.name} aggregates do not match per_case trial results`);
  }
  if (typeof bench.broken_task_warning !== 'boolean' || typeof bench.partial !== 'boolean') throw new Error('bench result state flags must be booleans');
  if (!Array.isArray(bench.missing_jobs) || bench.missing_jobs.length > MAX_TOTAL_JOBS
    || new Set(bench.missing_jobs).size !== bench.missing_jobs.length
    || bench.missing_jobs.some(job => typeof job !== 'string' || job.length > 256)) throw new Error('bench result missing_jobs must be a bounded unique string list');
  if (!Number.isInteger(bench.records) || bench.records < 0 || bench.records > MAX_TOTAL_JOBS) throw new Error('bench result records must be a bounded integer');
  const observed = bench.strategies.reduce((sum, arm) => sum + arm.trials, 0);
  const expected = expectedPerArm * bench.strategies.length;
  if (bench.records !== observed || bench.missing_jobs.length !== expected - observed || bench.partial !== (observed !== expected)) throw new Error('bench result record, missing-job, and partial counts are inconsistent');
  const expectedJobIds = new Set();
  for (const item of bench.cases) for (const arm of bench.strategies) for (let trial = 1; trial <= item.trials; trial++) expectedJobIds.add(jobIdFor(item.id, arm.name, trial));
  if (bench.missing_jobs.some(job => !expectedJobIds.has(job))) throw new Error('bench result missing_jobs contains an unplanned job');
  const measured = bench.strategies.filter(arm => arm.trials > 0);
  const expectedBroken = !bench.partial && measured.length > 0
    && measured.every(arm => arm.pass_at_k_rate === 0 && arm.avg_score != null && arm.avg_score < BROKEN_TASK_AVG && arm.trials >= 2);
  if (bench.broken_task_warning !== expectedBroken) throw new Error('bench result broken_task_warning is inconsistent');
  exactObjectKeys(bench.recommendation, BENCH_RECOMMENDATION_KEYS, 'bench recommendation');
  for (const key of ['best_quality', 'best_value', 'final', 'best_effort']) {
    if (bench.recommendation[key] !== null && (typeof bench.recommendation[key] !== 'string' || !armNames.has(bench.recommendation[key]))) throw new Error(`bench recommendation ${key} must name an existing arm or null`);
  }
  if (typeof bench.recommendation.reason !== 'string' || !bench.recommendation.reason.length || bench.recommendation.reason.length > 4_096) throw new Error('bench recommendation reason must be a bounded string');
  if (bench.partial && ['best_quality', 'best_value', 'final', 'best_effort'].some(key => bench.recommendation[key] !== null)) throw new Error('partial bench result must withhold recommendations');
  if (!Array.isArray(bench.advisories) || bench.advisories.length > 128 || bench.advisories.some(item => typeof item !== 'string' || item.length > 2_048)) throw new Error('bench advisories must be bounded strings');
  if (typeof bench.artifact_path !== 'string' || !bench.artifact_path.length || bench.artifact_path.length > 4_096) throw new Error('bench result artifact_path must be a bounded string');
  return bench;
}

export function writeManifest(manifest) {
  validateManifest(manifest, manifest?.run_id);
  const base = runsDir();
  mkdirSync(base, { recursive: true });
  if (lstatSync(base).isSymbolicLink() || !lstatSync(base).isDirectory()) throw new Error('runs path must be a regular directory');
  const dir = runDir(manifest.run_id);
  try { mkdirSync(dir); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('run path must be a regular directory');
  try { mkdirSync(join(dir, 'records')); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  if (lstatSync(join(dir, 'records')).isSymbolicLink() || !lstatSync(join(dir, 'records')).isDirectory()) throw new Error('records path must be a regular directory');
  const path = join(dir, 'manifest.json');
  writeCreateOnly(path, manifest, 'run manifest');
  return path;
}

export function readManifest(runId) {
  const dir = runDir(runId);
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory())) throw new Error('run path must be a regular directory');
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) throw new Error(`unknown bench run "${runId}" (no manifest at ${path})`);
  if (lstatSync(path).isSymbolicLink()) throw new Error('run manifest must not be a symlink');
  if (!statSync(path).isFile()) throw new Error('run manifest must be a regular file');
  if (statSync(path).size > MAX_MANIFEST_BYTES) throw new Error(`run manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  let manifest;
  try { manifest = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`run manifest is invalid JSON: ${error.message}`); }
  return validateManifest(manifest, runId);
}

function updateManifest(manifest, patch) {
  const path = join(runDir(manifest.run_id), 'manifest.json');
  if (lstatSync(path).isSymbolicLink()) throw new Error('run manifest must not be a symlink');
  const next = validateManifest({ ...manifest, ...patch }, manifest.run_id);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  return next;
}

export function validateManifest(manifest, expectedRunId = manifest?.run_id) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('run manifest must be a JSON object');
  if (manifest.v !== RUN_SCHEMA_V || manifest.type !== 'bench-run') throw new Error('unsupported run manifest');
  if (!RUN_ID_RE.test(String(manifest.run_id)) || manifest.run_id !== expectedRunId) throw new Error('run manifest id does not match its directory');
  if (!['open', 'finished'].includes(manifest.status)) throw new Error('run manifest status must be open or finished');
  if (typeof manifest.created_at !== 'string' || !Number.isFinite(Date.parse(manifest.created_at))) throw new Error('run manifest created_at must be an ISO timestamp');
  if (manifest.status === 'finished') {
    const expectedPath = join(benchmarksDir(), `${manifest.run_id}-bench.json`);
    if (typeof manifest.finished_at !== 'string' || !Number.isFinite(Date.parse(manifest.finished_at)) || manifest.result_path !== expectedPath) throw new Error('finished run manifest has invalid result metadata');
  } else if (manifest.finished_at != null || manifest.result_path != null) throw new Error('open run manifest must not contain result metadata');
  if (!Array.isArray(manifest.arms) || !manifest.arms.length || manifest.arms.length > MAX_ARMS) throw new Error(`run manifest arms must contain 1-${MAX_ARMS} items`);
  if (new Set(manifest.arms).size !== manifest.arms.length) throw new Error('run manifest arms must be unique');
  for (const arm of manifest.arms) if (typeof arm !== 'string' || !ARM_RE.test(arm)) throw new Error(`invalid arm in run manifest: ${arm}`);
  if (manifest.control !== null && manifest.control !== CONTROL_ARM) throw new Error('run manifest control must be direct or null');
  if ((manifest.control === CONTROL_ARM) !== manifest.arms.includes(CONTROL_ARM)) throw new Error('run manifest direct arm and control do not agree');
  if (Number.isInteger(manifest.trials_default)) {
    if (manifest.trials_default <= 0 || manifest.trials_default > MAX_TRIALS) throw new Error(`run manifest trials_default must be between 1 and ${MAX_TRIALS}`);
  } else {
    const defaults = manifest.trials_default;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)
      || Object.keys(defaults).sort().join(',') !== 'high,normal'
      || Object.values(defaults).some(value => !Number.isInteger(value) || value <= 0 || value > MAX_TRIALS)) {
      throw new Error(`run manifest trials_default must contain bounded normal/high counts`);
    }
  }
  if (!Array.isArray(manifest.cases) || !manifest.cases.length || manifest.cases.length > MAX_CASES) throw new Error(`run manifest cases must contain 1-${MAX_CASES} items`);
  if (new Set(manifest.cases.map(item => item?.id)).size !== manifest.cases.length) throw new Error('run manifest case ids must be unique');
  let expectedJobs = 0;
  for (const item of manifest.cases) {
    if (!item || typeof item !== 'object' || !CASE_ID_RE.test(String(item.id))) throw new Error('run manifest contains an invalid case id');
    if (Object.keys(item).some(key => !MANIFEST_CASE_KEYS.has(key))) throw new Error(`run manifest case ${item.id} contains an unsupported field`);
    if (typeof item.rubric !== 'string' || !RUBRIC_RE.test(item.rubric)) throw new Error(`run manifest case ${item.id} has an invalid rubric`);
    if (!['normal', 'high'].includes(item.risk)) throw new Error(`run manifest case ${item.id} has an invalid risk`);
    if (!Array.isArray(item.tags) || item.tags.length > 64 || new Set(item.tags).size !== item.tags.length || item.tags.some(tag => typeof tag !== 'string' || !TAG_RE.test(tag))) throw new Error(`run manifest case ${item.id} has invalid tags`);
    if (!Number.isInteger(item.trials) || item.trials <= 0 || item.trials > MAX_TRIALS) throw new Error(`run manifest case ${item.id} trials must be between 1 and ${MAX_TRIALS}`);
    if (typeof item.pass_threshold !== 'number' || !Number.isFinite(item.pass_threshold) || item.pass_threshold < 0 || item.pass_threshold > 10) throw new Error(`run manifest case ${item.id} has an invalid pass threshold`);
    if (!Number.isInteger(item.assertions) || item.assertions < 0 || item.assertions > MAX_ASSERTION_RESULTS) throw new Error(`run manifest case ${item.id} has an invalid assertion count`);
    if (!SHA_RE.test(String(item.case_sha256))) throw new Error(`run manifest case ${item.id} has an invalid fingerprint`);
    if (!SHA_RE.test(String(item.case_meta_sha256))) throw new Error(`run manifest case ${item.id} has an invalid metadata fingerprint`);
    const { case_meta_sha256: metadataFingerprint, ...boundMetadata } = item;
    if (caseFingerprint(boundMetadata) !== metadataFingerprint) throw new Error(`run manifest case ${item.id} metadata changed after bench plan`);
    expectedJobs += item.trials * manifest.arms.length;
  }
  if (expectedJobs > MAX_TOTAL_JOBS) throw new Error(`run manifest exceeds ${MAX_TOTAL_JOBS} total jobs`);
  if (!Array.isArray(manifest.jobs) || manifest.jobs.length !== expectedJobs) throw new Error(`run manifest must contain exactly ${expectedJobs} jobs`);
  const expected = new Map();
  for (const item of manifest.cases) for (const arm of manifest.arms) for (let trial = 1; trial <= item.trials; trial++) {
    const id = jobIdFor(item.id, arm, trial);
    expected.set(id, { case_id: item.id, arm, trial });
  }
  const seen = new Set();
  for (const job of manifest.jobs) {
    if (!job || typeof job !== 'object' || typeof job.job_id !== 'string' || seen.has(job.job_id)) throw new Error('run manifest job ids must be unique');
    seen.add(job.job_id);
    const planned = expected.get(job.job_id);
    if (!planned || job.case_id !== planned.case_id || job.arm !== planned.arm || job.trial !== planned.trial) throw new Error(`run manifest contains an invalid job: ${job.job_id}`);
  }
  return manifest;
}

/** Normalize one job record; throws on anything that is not bounded metrics. */
export function validateRecord(raw, { passThreshold, stored = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('score file must be a JSON object');
  let serialized;
  try { serialized = JSON.stringify(raw); } catch (error) { throw new Error(`score file must be serializable JSON: ${error.message}`); }
  if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES) throw new Error(`score file exceeds ${MAX_RECORD_BYTES} bytes`);
  const keys = Object.keys(raw);
  const forbidden = keys.filter(key => FORBIDDEN_RECORD_KEYS.includes(key.toLowerCase()));
  if (forbidden.length) throw new Error(`score file must not contain output text (found: ${forbidden.join(', ')})`);
  const allowed = stored ? STORED_RECORD_KEYS : RAW_RECORD_KEYS;
  const unknown = keys.filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`score file contains unsupported field: ${unknown[0]}`);
  if (typeof passThreshold !== 'number' || !Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 10) throw new Error('pass threshold must be a number between 0 and 10');
  const overall = raw.overall;
  if (typeof overall !== 'number' || !Number.isFinite(overall) || overall < 0 || overall > 10) throw new Error('overall must be a number between 0 and 10');
  const record = { overall: round(overall, 3), pass_threshold: passThreshold, cost_source: 'estimated' };
  if (raw.per_criterion != null) {
    if (typeof raw.per_criterion !== 'object' || Array.isArray(raw.per_criterion)) throw new Error('per_criterion must be an object');
    const criteria = Object.entries(raw.per_criterion);
    if (criteria.length > MAX_CRITERIA) throw new Error(`per_criterion must contain at most ${MAX_CRITERIA} entries`);
    record.per_criterion = {};
    for (const [name, value] of criteria) {
      if (!IDENTIFIER_RE.test(name)) throw new Error(`per_criterion identifier "${name}" is invalid`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) throw new Error(`per_criterion.${name} must be a number between 0 and 10`);
      record.per_criterion[name] = round(value, 3);
    }
  }
  if (raw.judges != null) {
    if (Array.isArray(raw.judges)) {
      if (!raw.judges.length || raw.judges.length > MAX_JUDGES) throw new Error(`judges must contain 1-${MAX_JUDGES} identifiers`);
      if (new Set(raw.judges).size !== raw.judges.length) throw new Error('judges must not contain duplicates');
      for (const judge of raw.judges) if (typeof judge !== 'string' || !IDENTIFIER_RE.test(judge)) throw new Error(`judge identifier "${judge}" is invalid`);
      record.judges = [...raw.judges];
    } else if (Number.isInteger(raw.judges) && raw.judges > 0 && raw.judges <= MAX_JUDGES) record.judges = raw.judges;
    else throw new Error(`judges must be an integer from 1-${MAX_JUDGES} or a bounded identifier list`);
  }
  if (raw.output_sha256 != null) {
    if (typeof raw.output_sha256 !== 'string' || !SHA_RE.test(raw.output_sha256)) throw new Error('output_sha256 must be 64 hex characters');
    record.output_sha256 = raw.output_sha256;
  }
  if (raw.cost_usd_est != null) {
    const cost = raw.cost_usd_est;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) throw new Error('cost_usd_est must be a finite non-negative number');
    record.cost_usd_est = round(cost, 6);
  }
  if (raw.duration_ms != null) {
    const ms = raw.duration_ms;
    if (!(Number.isInteger(ms) && ms >= 0)) throw new Error('duration_ms must be a non-negative integer');
    record.duration_ms = ms;
  }
  if (raw.sigma != null) {
    const s = raw.sigma;
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) throw new Error('sigma must be a finite non-negative number');
    record.sigma = round(s, 3);
  }
  if (raw.assertion_results != null) {
    if (!Array.isArray(raw.assertion_results)) throw new Error('assertion_results must be an array');
    if (raw.assertion_results.length > MAX_ASSERTION_RESULTS) throw new Error(`assertion_results must contain at most ${MAX_ASSERTION_RESULTS} rows`);
    record.assertion_results = raw.assertion_results.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('assertion_results[] must be an object');
      const unknown = Object.keys(item).filter(key => !ASSERTION_RESULT_KEYS.has(key));
      if (unknown.length) throw new Error(`assertion_results[] contains unsupported field: ${unknown[0]}`);
      const result = String(item?.result || '').toUpperCase();
      if (!['PASS', 'HARD_FAIL', 'UNCERTAIN'].includes(result)) throw new Error('assertion_results[].result must be PASS, HARD_FAIL, or UNCERTAIN');
      if (item.source !== 'executable' && item.source !== 'judge') throw new Error('assertion_results[].source must be executable or judge');
      const row = { result, source: item.source === 'executable' ? 'executable' : 'judge' };
      if (item.name != null) {
        if (typeof item.name !== 'string' || !IDENTIFIER_RE.test(item.name)) throw new Error(`assertion result name "${item.name}" is invalid`);
        row.name = item.name;
      }
      if (item.assertion != null) {
        if (typeof item.assertion !== 'string' || item.assertion.length > 200) throw new Error('assertion_results[].assertion must be at most 200 characters');
        row.assertion = item.assertion;
      }
      if (item.kind != null) {
        if (typeof item.kind !== 'string' || !ASSERTION_KINDS.includes(item.kind)) throw new Error('assertion_results[].kind must be cmd, file, grep, or json');
        row.kind = item.kind;
      }
      if (item.confidence != null) {
        if (typeof item.confidence !== 'string' || !CONFIDENCE_RE.test(item.confidence)) throw new Error('assertion_results[].confidence must be a safe identifier');
        row.confidence = item.confidence;
      }
      if (item.exit_code != null) {
        if (!Number.isInteger(item.exit_code)) throw new Error('assertion_results[].exit_code must be an integer');
        row.exit_code = item.exit_code;
      }
      if (item.error_code != null) {
        if (typeof item.error_code !== 'string' || !CONFIDENCE_RE.test(item.error_code)) throw new Error('assertion_results[].error_code must be a safe identifier');
        row.error_code = item.error_code;
      }
      if (item.duration_ms != null) {
        if (!Number.isInteger(item.duration_ms) || item.duration_ms < 0) throw new Error('assertion_results[].duration_ms must be a non-negative integer');
        row.duration_ms = item.duration_ms;
      }
      if (item.command_sha256 != null) {
        if (typeof item.command_sha256 !== 'string' || !SHA_RE.test(item.command_sha256)) throw new Error('assertion_results[].command_sha256 must be 64 hex characters');
        row.command_sha256 = item.command_sha256;
      }
      if (row.source === 'executable') {
        if (!row.name || !row.kind || row.result === 'UNCERTAIN' || row.assertion != null || row.confidence != null) throw new Error('executable assertion result has fields that do not match its source');
      } else if (!row.assertion || row.name != null || row.kind != null || row.exit_code != null || row.error_code != null || row.duration_ms != null || row.command_sha256 != null) {
        throw new Error('judge assertion result has fields that do not match its source');
      }
      return row;
    });
  }
  const hardFail = (record.assertion_results || []).some(item => item.result === 'HARD_FAIL');
  if (Object.hasOwn(raw, 'passed') && typeof raw.passed !== 'boolean') throw new Error('passed must be a boolean');
  const declared = typeof raw.passed === 'boolean' ? raw.passed : true;
  record.passed = overall >= passThreshold && declared && !hardFail;
  record.assertion_hard_fail = hardFail;
  return record;
}

/** Score one job. Optionally runs the case's executable assertions first. */
export function recordJob({ runId, jobId, raw, runExecutableAssertions = false, cwd = projectRoot(), now = new Date().toISOString() }) {
  const manifest = readManifest(runId);
  if (manifest.status !== 'open') throw new Error(`bench run ${runId} is already finished`);
  if (typeof now !== 'string' || !Number.isFinite(Date.parse(now))) throw new Error('recorded_at must be an ISO timestamp');
  const job = manifest.jobs.find(item => item.job_id === jobId);
  if (!job) throw new Error(`unknown job "${jobId}" in run ${runId}`);
  const caseMeta = manifest.cases.find(item => item.id === job.case_id);
  validatePlannedCase(caseMeta);
  const record = validateRecord(raw, { passThreshold: caseMeta.pass_threshold });
  if (runExecutableAssertions) {
    const caseDoc = readCase(job.case_id);
    const executable = (caseDoc?.assertions || []).filter(item => item.kind !== 'judge').map(item => ({ kind: item.kind, name: item.name, spec: item.spec, command: item.spec }));
    if (executable.length) {
      if (executable.length + (record.assertion_results || []).length > MAX_ASSERTION_RESULTS) throw new Error(`merged assertion_results exceeds ${MAX_ASSERTION_RESULTS} rows`);
      const report = runAssertions(executable, { cwd });
      const rows = report.results.map(r => ({ name: r.name, kind: r.kind, result: r.result, source: 'executable', ...(r.exit_code != null ? { exit_code: r.exit_code } : {}), ...(r.error_code ? { error_code: r.error_code } : {}), ...(r.duration_ms != null ? { duration_ms: r.duration_ms } : {}), ...(r.command_sha256 ? { command_sha256: r.command_sha256 } : {}) }));
      if (rows.length + (record.assertion_results || []).length > MAX_ASSERTION_RESULTS) throw new Error(`merged assertion_results exceeds ${MAX_ASSERTION_RESULTS} rows`);
      record.assertion_results = [...rows, ...(record.assertion_results || [])];
      if (!report.passed) { record.passed = false; record.assertion_hard_fail = true; }
    }
  }
  const payload = { v: RUN_SCHEMA_V, type: 'bench-record', run_id: runId, job_id: jobId, case_id: job.case_id, arm: job.arm, trial: job.trial, recorded_at: now, ...record };
  const revalidated = validateRecord(payload, { passThreshold: caseMeta.pass_threshold, stored: true });
  if (payload.passed !== revalidated.passed || payload.assertion_hard_fail !== revalidated.assertion_hard_fail
    || caseFingerprint(payload.assertion_results || []) !== caseFingerprint(revalidated.assertion_results || [])) throw new Error('merged assertion results are not normalized');
  if (Buffer.byteLength(serializeJson(payload)) > MAX_RECORD_BYTES) throw new Error(`merged score file exceeds ${MAX_RECORD_BYTES} bytes`);
  const recordsPath = join(runDir(runId), 'records');
  if (lstatSync(recordsPath).isSymbolicLink() || !lstatSync(recordsPath).isDirectory()) throw new Error('records path must be a regular directory');
  const path = join(recordsPath, `${jobId}.json`);
  writeCreateOnly(path, payload, 'job record');
  return { path, record: payload };
}

function validatePlannedCase(caseMeta) {
  const current = readCase(caseMeta.id);
  if (!current) throw new Error(`planned case ${caseMeta.id} was deleted after bench plan`);
  const currentFingerprint = caseFingerprint(current);
  if (!caseMeta.case_sha256 || currentFingerprint !== caseMeta.case_sha256) {
    throw new Error(`planned case ${caseMeta.id} changed after bench plan`);
  }
  const derived = {
    rubric: current.rubric,
    risk: current.risk,
    tags: current.tags,
    pass_threshold: passThresholdFor(current),
    assertions: current.assertions.length,
    case_sha256: currentFingerprint,
  };
  for (const [key, value] of Object.entries(derived)) {
    if (JSON.stringify(caseMeta[key]) !== JSON.stringify(value)) throw new Error(`planned case ${caseMeta.id} metadata changed after bench plan (${key})`);
  }
}

function validatePlannedCases(manifest) {
  for (const caseMeta of manifest.cases) validatePlannedCase(caseMeta);
}

export function readRecords(runId) {
  const manifest = readManifest(runId);
  const dir = join(runDir(runId), 'records');
  const records = new Map();
  const invalid = [];
  if (!existsSync(dir)) return { records, invalid };
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('records path must be a regular directory');
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error('record must be a regular file');
      if (statSync(path).size > MAX_RECORD_BYTES) throw new Error(`record exceeds ${MAX_RECORD_BYTES} bytes`);
      const payload = JSON.parse(readFileSync(path, 'utf8'));
      if (payload.v !== RUN_SCHEMA_V || payload.type !== 'bench-record') throw new Error('not a supported bench record');
      const job = manifest.jobs.find(item => item.job_id === payload.job_id);
      if (!job) throw new Error('record job is not present in the manifest');
      if (name !== `${job.job_id}.json`) throw new Error('record file name does not match job id');
      const caseMeta = manifest.cases.find(item => item.id === job.case_id);
      if (payload.run_id !== runId || payload.case_id !== job.case_id || payload.arm !== job.arm || payload.trial !== job.trial) throw new Error('record identity does not match its manifest job');
      if (typeof payload.recorded_at !== 'string' || !Number.isFinite(Date.parse(payload.recorded_at))) throw new Error('recorded_at must be an ISO timestamp');
      if (payload.pass_threshold !== caseMeta.pass_threshold || payload.cost_source !== 'estimated') throw new Error('record threshold or cost source does not match the manifest');
      const normalized = validateRecord(payload, { passThreshold: caseMeta.pass_threshold, stored: true });
      if (payload.overall !== normalized.overall || payload.passed !== normalized.passed || payload.assertion_hard_fail !== normalized.assertion_hard_fail) throw new Error('record derived score fields are inconsistent');
      for (const key of ['per_criterion', 'judges', 'output_sha256', 'cost_usd_est', 'duration_ms', 'sigma']) {
        if (JSON.stringify(payload[key]) !== JSON.stringify(normalized[key])) throw new Error(`record ${key} is not normalized`);
      }
      if (caseFingerprint(payload.assertion_results || []) !== caseFingerprint(normalized.assertion_results || [])) throw new Error('record assertion_results is not normalized');
      if (records.has(payload.job_id)) throw new Error('duplicate record for job id');
      records.set(payload.job_id, payload);
    } catch (error) {
      invalid.push({ file: name, reason: error.message });
    }
  }
  return { records, invalid };
}

function armStats(name, rows, expected) {
  const overalls = rows.map(r => r.overall);
  const costs = rows.map(r => r.cost_usd_est).filter(v => v != null);
  const durations = rows.map(r => r.duration_ms).filter(v => v != null);
  const trials = rows.length;
  const passAtK = rows.filter(r => r.passed).length;
  const avg = trials ? round(mean(overalls), 2) : null;
  const estCost = costs.length ? round(mean(costs), 4) : null;
  return {
    name,
    trials,
    expected_trials: expected,
    avg_score: avg,
    sigma: trials ? round(sigma(overalls), 2) : null,
    pass_at_k: passAtK,
    // pass^k is defined over the planned k. A partial arm only has an
    // observed pass rate and must not be presented as all-pass/all-fail.
    pass_hat_k: trials === expected ? (trials > 0 && passAtK === trials ? 1 : 0) : null,
    pass_at_k_rate: trials ? round(passAtK / trials, 3) : null,
    per_trial_overall: overalls,
    est_cost_usd: estCost,
    cost_source: 'estimated',
    avg_time_sec: durations.length ? round(mean(durations) / 1000, 1) : null,
    score_per_dollar: estCost != null && estCost > 0 && avg != null ? round(avg / estCost, 1) : null,
    assertion_hard_fails: rows.filter(r => r.assertion_hard_fail).length,
  };
}

/** Aggregate a run exactly per subcommands/bench.md, plus the direct-control delta. */
export function aggregateRun(manifest, records, { now = new Date().toISOString() } = {}) {
  const expectedByArm = new Map();
  for (const job of manifest.jobs) expectedByArm.set(job.arm, (expectedByArm.get(job.arm) || 0) + 1);
  const rowsByArm = new Map(manifest.arms.map(arm => [arm, []]));
  const rowsByCaseArm = new Map();
  const missingJobs = [];
  for (const job of manifest.jobs) {
    const record = records.get(job.job_id);
    if (!record) { missingJobs.push(job.job_id); continue; }
    rowsByArm.get(job.arm).push(record);
    const key = `${job.case_id}\0${job.arm}`;
    if (!rowsByCaseArm.has(key)) rowsByCaseArm.set(key, []);
    rowsByCaseArm.get(key).push(record);
  }
  const strategies = manifest.arms.map(arm => armStats(arm, rowsByArm.get(arm), expectedByArm.get(arm) || 0));
  const partial = missingJobs.length > 0;
  const control = manifest.control ? strategies.find(s => s.name === manifest.control) : null;
  if (control && control.avg_score != null) {
    for (const arm of strategies) arm.delta_vs_direct = arm.name === CONTROL_ARM ? 0 : (arm.avg_score != null ? round(arm.avg_score - control.avg_score, 2) : null);
  }
  const perCase = manifest.cases.map(item => ({
    case_id: item.id,
    pass_threshold: item.pass_threshold,
    arms: manifest.arms.map(arm => armStats(arm, rowsByCaseArm.get(`${item.id}\0${arm}`) || [], item.trials)),
  }));

  const measured = strategies.filter(s => s.trials > 0);
  const brokenTask = !partial && measured.length > 0
    && measured.every(s => s.pass_at_k_rate === 0 && s.avg_score != null && s.avg_score < BROKEN_TASK_AVG && s.trials >= 2);

  const reliable = measured.filter(s => s.pass_hat_k === 1);
  const byAvg = [...measured].sort((a, b) => (b.avg_score ?? -1) - (a.avg_score ?? -1));
  const advisories = [];
  let bestQuality = partial ? null : (reliable.length ? [...reliable].sort((a, b) => b.avg_score - a.avg_score)[0] : byAvg[0] || null);
  if (bestQuality && bestQuality.pass_hat_k !== 1) advisories.push(`flaky-best: ${bestQuality.name} has the highest average but did not pass every trial`);
  const valueCandidates = measured.filter(s => s.pass_at_k_rate != null && s.pass_at_k_rate >= BEST_VALUE_MIN_PASS_RATE && s.score_per_dollar != null);
  const bestValue = !partial && valueCandidates.length ? [...valueCandidates].sort((a, b) => b.score_per_dollar - a.score_per_dollar)[0] : null;

  let final = null;
  let reason;
  const bestEffort = partial ? null : ([...measured].sort((a, b) => (b.pass_at_k_rate ?? -1) - (a.pass_at_k_rate ?? -1) || (b.avg_score ?? -1) - (a.avg_score ?? -1))[0] || null);
  if (partial) {
    reason = 'partial run — pass^k and recommendations are withheld until every planned job is recorded';
  } else if (reliable.length) {
    let candidates = [...reliable];
    if (control?.pass_hat_k === 1 && control.avg_score != null) {
      candidates = candidates.filter(arm => arm.name === CONTROL_ARM || round(arm.avg_score - control.avg_score, 2) >= MIN_DELTA_VS_DIRECT);
    }
    const ordered = candidates.sort((a, b) => (a.sigma ?? Infinity) - (b.sigma ?? Infinity) || (b.score_per_dollar ?? -1) - (a.score_per_dollar ?? -1));
    final = ordered[0];
    reason = `passes every trial; lowest σ among reliable arms${final.score_per_dollar != null ? ', best Score/$ on tie' : ''}`;
    const demoted = reliable.filter(arm => arm.name !== CONTROL_ARM && control?.avg_score != null && round(arm.avg_score - control.avg_score, 2) < MIN_DELTA_VS_DIRECT);
    if (final?.name === CONTROL_ARM && demoted.length) {
      reason = `${demoted.map(arm => arm.name).join(', ')} did not beat the single-agent control by ≥ ${MIN_DELTA_VS_DIRECT}; no qualifying reliable strategy outranked direct`;
    }
    if (final.trials <= 3 && final.sigma != null && final.sigma >= 1.0) {
      advisories.push(`low-confidence: ${final.name} recommended from ${final.trials} trial(s) with σ ${final.sigma} — a flaky arm can pass all of them by luck; increase --trials to 5+`);
    }
  } else {
    reason = 'no arm passed all trials — no reliable recommendation; increase --trials or check the pass threshold';
  }

  return {
    type: 'bench',
    schema_v: RUN_SCHEMA_V,
    run_id: manifest.run_id,
    timestamp: now,
    task: `${manifest.cases.length} case(s) from .xm/eval/cases`,
    cases: manifest.cases.map(({ id, rubric, risk, trials, pass_threshold }) => ({ id, rubric, risk, trials, pass_threshold })),
    rubric: [...new Set(manifest.cases.map(c => c.rubric))].join(','),
    pass_threshold: [...new Set(manifest.cases.map(c => c.pass_threshold))].length === 1 ? manifest.cases[0].pass_threshold : null,
    control: manifest.control,
    strategies,
    per_case: perCase,
    broken_task_warning: brokenTask,
    recommendation: {
      best_quality: bestQuality?.name ?? null,
      best_value: bestValue?.name ?? null,
      final: final?.name ?? null,
      best_effort: final ? null : bestEffort?.name ?? null,
      reason,
    },
    advisories,
    partial,
    missing_jobs: missingJobs,
    records: records.size,
  };
}

/** Aggregate, persist to `.xm/eval/benchmarks/`, and mark the manifest finished. */
export function finishRun({ runId, allowPartial = false, now = new Date() }) {
  const manifest = readManifest(runId);
  if (manifest.status !== 'open') throw new Error(`bench run ${runId} is already finished`);
  validatePlannedCases(manifest);
  const { records, invalid } = readRecords(runId);
  if (invalid.length) throw new Error(`run ${runId} has ${invalid.length} invalid record(s): ${invalid.map(item => item.file).join(', ')}`);
  const dir = benchmarksDir();
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('benchmarks path must be a regular directory');
  const path = join(dir, `${runId}-bench.json`);

  if (existsSync(path)) return finalizeOrphanedResult({ manifest, records, path, allowPartial });

  const result = aggregateRun(manifest, records, { now: now.toISOString() });
  assertCompleteEnough(result, runId, allowPartial);
  const persisted = validatePersistedBench({ ...result, artifact_path: path });
  try {
    writeCreateOnly(path, persisted, 'bench result');
    updateManifest(manifest, { status: 'finished', finished_at: result.timestamp, result_path: path });
  } catch (error) {
    if (error?.code === 'EEXIST') return finalizeOrphanedResult({ manifest, records, path, allowPartial });
    try { unlinkSync(path); } catch {}
    throw error;
  }
  return { path, result };
}

function assertCompleteEnough(result, runId, allowPartial) {
  if (!result.partial || allowPartial) return;
  const error = new Error(`run ${runId} has ${result.missing_jobs.length} unrecorded job(s); record them or pass --allow-partial`);
  error.result = result;
  throw error;
}

function finalizeOrphanedResult({ manifest, records, path, allowPartial }) {
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error(`existing bench result must be a regular file: ${path}`);
  if (statSync(path).size > MAX_BENCH_RESULT_BYTES) throw new Error(`existing bench result exceeds ${MAX_BENCH_RESULT_BYTES} bytes: ${path}`);
  const bytes = readFileSync(path, 'utf8');
  let stored;
  try { stored = JSON.parse(bytes); } catch (error) { throw new Error(`existing bench result is invalid JSON: ${error.message}`); }
  validatePersistedBench(stored);
  const result = aggregateRun(manifest, records, { now: stored.timestamp });
  assertCompleteEnough(result, manifest.run_id, allowPartial);
  const expected = serializeJson({ ...result, artifact_path: path });
  if (bytes !== expected) throw new Error(`existing bench result bytes do not match run ${manifest.run_id}; refusing to finalize manifest`);
  updateManifest(manifest, { status: 'finished', finished_at: stored.timestamp, result_path: path });
  return { path, result };
}

export function runStatus(runId) {
  const manifest = readManifest(runId);
  const { records, invalid } = readRecords(runId);
  const done = manifest.jobs.filter(job => records.has(job.job_id));
  const pending = manifest.jobs.filter(job => !records.has(job.job_id));
  return { run_id: runId, status: manifest.status, control: manifest.control, arms: manifest.arms, cases: manifest.cases.length, jobs: manifest.jobs.length, recorded: done.length, pending: pending.map(job => job.job_id), invalid, result_path: manifest.result_path || null };
}

/** Most recent finished bench file other than `excludeRunId`, or null. */
export function latestBenchPath({ excludeRunId = null } = {}) {
  const dir = benchmarksDir();
  if (!existsSync(dir)) return null;
  if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error('benchmarks path must be a regular directory');
  const candidates = [];
  const files = readdirSync(dir).filter(name => name.endsWith('-bench.json')).sort();
  for (const name of files) {
    try {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_BENCH_RESULT_BYTES) continue;
      const doc = validatePersistedBench(JSON.parse(readFileSync(path, 'utf8')));
      if (name === `${doc.run_id}-bench.json` && doc.run_id !== excludeRunId) candidates.push({ path, timestamp: Date.parse(doc.timestamp), name });
    } catch {}
  }
  candidates.sort((a, b) => b.timestamp - a.timestamp || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return candidates[0]?.path ?? null;
}

function cell(value, width, right = true) {
  const text = value == null ? '—' : String(value);
  return right ? text.padStart(width) : text.padEnd(width);
}

export function formatBenchReport(result) {
  const lines = [];
  lines.push(`📊 [eval] Benchmark ${result.run_id}: ${result.strategies.length} arm(s) × ${result.cases.length} case(s)${result.control ? ` · control: ${result.control}` : ''}`);
  lines.push(`Rubric: ${result.rubric}  (pass_threshold = ${result.pass_threshold ?? 'per case'})${result.partial ? `  ⚠ partial — ${result.missing_jobs.length} job(s) unrecorded` : ''}`);
  if (result.broken_task_warning) {
    lines.push('');
    lines.push(`⚠ 0% pass across all arms and avg_score < ${BROKEN_TASK_AVG} for all — this pattern suggests a broken CASE, not failing strategies. Check prompt ambiguity, rubric fit, pass_threshold.`);
  }
  lines.push('');
  const width = Math.max(8, ...result.strategies.map(s => s.name.length));
  lines.push(`| ${cell('Strategy', width, false)} | ${cell('Avg', 5)} | ${cell('σ', 5)} | ${cell('pass@k', 7)} | ${cell('pass^k', 6)} | ${cell('Cost', 8)} | ${cell('Score/$', 8)} |${result.control ? ` ${cell('Δ direct', 8)} |` : ''}`);
  for (const s of result.strategies) {
    const passHat = s.pass_hat_k == null ? '—' : (s.pass_hat_k ? '✓' : '·');
    lines.push(`| ${cell(s.name, width, false)} | ${cell(s.avg_score, 5)} | ${cell(s.sigma, 5)} | ${cell(`${s.pass_at_k}/${s.trials}`, 7)} | ${cell(passHat, 6)} | ${cell(s.est_cost_usd != null ? `$${s.est_cost_usd}` : null, 8)} | ${cell(s.score_per_dollar, 8)} |${result.control ? ` ${cell(s.delta_vs_direct, 8)} |` : ''}`);
  }
  lines.push('');
  const r = result.recommendation;
  lines.push(`Best quality:   ${r.best_quality ?? '—'}`);
  lines.push(`Best value:     ${r.best_value ?? '—'}`);
  lines.push(`Recommendation: ${r.final ?? (r.best_effort ? `none reliable (best-effort: ${r.best_effort})` : '—')} — ${r.reason}`);
  for (const advisory of result.advisories) lines.push(`⚠ ${advisory}`);
  lines.push('Cost figures are estimates (cost_source: estimated).');
  return lines.join('\n');
}
