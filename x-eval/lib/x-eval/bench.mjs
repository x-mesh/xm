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
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { evalDir, projectRoot } from './root.mjs';
import { DEFAULT_TRIALS, caseFingerprint, passThresholdFor, readCase } from './cases.mjs';
import { runAssertions } from './assert.mjs';
import { mean, sigma, round } from './stats.mjs';

export const RUN_SCHEMA_V = 1;
export const CONTROL_ARM = 'direct';
/** bench.md: 0% pass everywhere AND avg < 4.5 everywhere ⇒ the task is broken, not the strategies. */
export const BROKEN_TASK_AVG = 4.5;
/** A strategy is recommended over the single-agent control only when it beats it by this much. */
export const MIN_DELTA_VS_DIRECT = 0.5;
export const BEST_VALUE_MIN_PASS_RATE = 0.67;
/** Keys a record may never carry: metrics, not model output, live in `.xm/eval/runs/`. */
export const FORBIDDEN_RECORD_KEYS = ['output', 'content', 'prompt', 'transcript', 'raw', 'response', 'text', 'rationale', 'judge_rationales'];
const ARM_RE = /^[a-z][a-z0-9-]{0,31}(\|[a-z][a-z0-9-]{0,31})*$/;
const RUN_ID_RE = /^bench-\d{8}T\d{6}Z-[0-9a-f]{4}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

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
  return `${String(caseId).slice(5, 13)}.${arm}.t${trial}`;
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
  if (trials != null && (!Number.isInteger(trials) || trials <= 0)) throw new Error('--trials must be a positive integer');
  const arms = includeDirect ? [CONTROL_ARM, ...strategies] : [...strategies];
  const manifestCases = [];
  const jobs = [];
  for (const item of cases) {
    const n = trials ?? DEFAULT_TRIALS[item.risk || 'normal'] ?? DEFAULT_TRIALS.normal;
    manifestCases.push({ id: item.id, rubric: item.rubric || 'general', risk: item.risk || 'normal', tags: item.tags || [], trials: n, pass_threshold: passThresholdFor(item), assertions: (item.assertions || []).length, case_sha256: caseFingerprint(item) });
    for (const arm of arms) for (let t = 1; t <= n; t++) jobs.push({ job_id: jobIdFor(item.id, arm, t), case_id: item.id, arm, trial: t });
  }
  return {
    v: RUN_SCHEMA_V, type: 'bench-run', run_id: runId, status: 'open', created_at: createdAt,
    control: includeDirect ? CONTROL_ARM : null, arms, trials_default: trials ?? DEFAULT_TRIALS,
    cases: manifestCases, jobs,
  };
}

function writeCreateOnly(path, payload, what) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { linkSync(tmp, path); } catch (err) {
      if (err?.code === 'EEXIST') throw new Error(`${what} already exists: ${path}`);
      throw err;
    }
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

export function writeManifest(manifest) {
  const dir = runDir(manifest.run_id);
  mkdirSync(join(dir, 'records'), { recursive: true });
  const path = join(dir, 'manifest.json');
  writeCreateOnly(path, manifest, 'run manifest');
  return path;
}

export function readManifest(runId) {
  const path = join(runDir(runId), 'manifest.json');
  if (!existsSync(path)) throw new Error(`unknown bench run "${runId}" (no manifest at ${path})`);
  if (lstatSync(path).isSymbolicLink()) throw new Error('run manifest must not be a symlink');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.v !== RUN_SCHEMA_V || manifest.type !== 'bench-run') throw new Error('unsupported run manifest');
  return manifest;
}

function updateManifest(manifest, patch) {
  const path = join(runDir(manifest.run_id), 'manifest.json');
  const next = { ...manifest, ...patch };
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  return next;
}

/** Normalize one job record; throws on anything that is not metrics. */
export function validateRecord(raw, { passThreshold }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('score file must be a JSON object');
  const keys = Object.keys(raw);
  const forbidden = keys.filter(key => FORBIDDEN_RECORD_KEYS.includes(key.toLowerCase()));
  if (forbidden.length) throw new Error(`score file must not contain output text (found: ${forbidden.join(', ')})`);
  const overall = raw.overall;
  if (typeof overall !== 'number' || !Number.isFinite(overall) || overall < 0 || overall > 10) throw new Error('overall must be a number between 0 and 10');
  const record = { overall: round(overall, 3), pass_threshold: passThreshold, cost_source: 'estimated' };
  if (raw.per_criterion != null) {
    if (typeof raw.per_criterion !== 'object' || Array.isArray(raw.per_criterion)) throw new Error('per_criterion must be an object');
    record.per_criterion = {};
    for (const [name, value] of Object.entries(raw.per_criterion)) {
      const n = Number(value);
      if (!(n >= 0 && n <= 10)) throw new Error(`per_criterion.${name} must be between 0 and 10`);
      record.per_criterion[name] = round(n, 3);
    }
  }
  if (raw.judges != null) {
    if (Array.isArray(raw.judges)) record.judges = raw.judges.map(String);
    else if (Number.isInteger(Number(raw.judges)) && Number(raw.judges) > 0) record.judges = Number(raw.judges);
    else throw new Error('judges must be a positive integer or a vendor list');
  }
  if (raw.output_sha256 != null) {
    if (!SHA_RE.test(String(raw.output_sha256))) throw new Error('output_sha256 must be 64 hex characters');
    record.output_sha256 = String(raw.output_sha256);
  }
  if (raw.cost_usd_est != null) {
    const cost = Number(raw.cost_usd_est);
    if (!(cost >= 0)) throw new Error('cost_usd_est must be a non-negative number');
    record.cost_usd_est = round(cost, 6);
  }
  if (raw.duration_ms != null) {
    const ms = Number(raw.duration_ms);
    if (!(Number.isInteger(ms) && ms >= 0)) throw new Error('duration_ms must be a non-negative integer');
    record.duration_ms = ms;
  }
  if (raw.sigma != null) {
    const s = Number(raw.sigma);
    if (!(s >= 0)) throw new Error('sigma must be a non-negative number');
    record.sigma = round(s, 3);
  }
  if (raw.assertion_results != null) {
    if (!Array.isArray(raw.assertion_results)) throw new Error('assertion_results must be an array');
    record.assertion_results = raw.assertion_results.map(item => {
      const result = String(item?.result || '').toUpperCase();
      if (!['PASS', 'HARD_FAIL', 'UNCERTAIN'].includes(result)) throw new Error('assertion_results[].result must be PASS, HARD_FAIL, or UNCERTAIN');
      const row = { result, source: item.source === 'executable' ? 'executable' : 'judge' };
      if (item.name != null) row.name = String(item.name).slice(0, 64);
      if (item.assertion != null) row.assertion = String(item.assertion).slice(0, 200);
      if (item.kind != null) row.kind = String(item.kind);
      if (item.confidence != null) row.confidence = String(item.confidence);
      return row;
    });
  }
  const hardFail = (record.assertion_results || []).some(item => item.result === 'HARD_FAIL');
  const declared = typeof raw.passed === 'boolean' ? raw.passed : true;
  record.passed = overall >= passThreshold && declared && !hardFail;
  record.assertion_hard_fail = hardFail;
  return record;
}

/** Score one job. Optionally runs the case's executable assertions first. */
export function recordJob({ runId, jobId, raw, runExecutableAssertions = false, cwd = projectRoot(), now = new Date().toISOString() }) {
  const manifest = readManifest(runId);
  const job = manifest.jobs.find(item => item.job_id === jobId);
  if (!job) throw new Error(`unknown job "${jobId}" in run ${runId}`);
  const caseMeta = manifest.cases.find(item => item.id === job.case_id);
  validatePlannedCase(caseMeta);
  const record = validateRecord(raw, { passThreshold: caseMeta.pass_threshold });
  if (runExecutableAssertions) {
    const caseDoc = readCase(job.case_id);
    const executable = (caseDoc?.assertions || []).filter(item => item.kind !== 'judge').map(item => ({ kind: item.kind, name: item.name, spec: item.spec, command: item.spec }));
    if (executable.length) {
      const report = runAssertions(executable, { cwd });
      const rows = report.results.map(r => ({ name: r.name, kind: r.kind, result: r.result, source: 'executable', ...(r.exit_code != null ? { exit_code: r.exit_code } : {}), ...(r.duration_ms != null ? { duration_ms: r.duration_ms } : {}), ...(r.command_sha256 ? { command_sha256: r.command_sha256 } : {}) }));
      record.assertion_results = [...rows, ...(record.assertion_results || [])];
      if (!report.passed) { record.passed = false; record.assertion_hard_fail = true; }
    }
  }
  const payload = { v: RUN_SCHEMA_V, type: 'bench-record', run_id: runId, job_id: jobId, case_id: job.case_id, arm: job.arm, trial: job.trial, recorded_at: now, ...record };
  const path = join(runDir(runId), 'records', `${jobId}.json`);
  writeCreateOnly(path, payload, 'job record');
  return { path, record: payload };
}

function validatePlannedCase(caseMeta) {
  const current = readCase(caseMeta.id);
  if (!current) throw new Error(`planned case ${caseMeta.id} was deleted after bench plan`);
  if (!caseMeta.case_sha256 || caseFingerprint(current) !== caseMeta.case_sha256) {
    throw new Error(`planned case ${caseMeta.id} changed after bench plan`);
  }
}

function validatePlannedCases(manifest) {
  for (const caseMeta of manifest.cases) validatePlannedCase(caseMeta);
}

export function readRecords(runId) {
  const dir = join(runDir(runId), 'records');
  const records = new Map();
  const invalid = [];
  if (!existsSync(dir)) return { records, invalid };
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('symlink');
      const payload = JSON.parse(readFileSync(path, 'utf8'));
      if (payload.type !== 'bench-record' || typeof payload.overall !== 'number') throw new Error('not a bench record');
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
    pass_hat_k: trials > 0 && passAtK === trials ? 1 : 0,
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
  const brokenTask = measured.length > 0
    && measured.every(s => s.pass_at_k_rate === 0 && s.avg_score != null && s.avg_score < BROKEN_TASK_AVG && s.trials >= 2);

  const reliable = measured.filter(s => s.pass_hat_k === 1);
  const byAvg = [...measured].sort((a, b) => (b.avg_score ?? -1) - (a.avg_score ?? -1));
  const advisories = [];
  let bestQuality = reliable.length ? [...reliable].sort((a, b) => b.avg_score - a.avg_score)[0] : byAvg[0] || null;
  if (bestQuality && bestQuality.pass_hat_k !== 1) advisories.push(`flaky-best: ${bestQuality.name} has the highest average but did not pass every trial`);
  const valueCandidates = measured.filter(s => s.pass_at_k_rate != null && s.pass_at_k_rate >= BEST_VALUE_MIN_PASS_RATE && s.score_per_dollar != null);
  const bestValue = valueCandidates.length ? [...valueCandidates].sort((a, b) => b.score_per_dollar - a.score_per_dollar)[0] : null;

  let final = null;
  let reason;
  const bestEffort = [...measured].sort((a, b) => (b.pass_at_k_rate ?? -1) - (a.pass_at_k_rate ?? -1) || (b.avg_score ?? -1) - (a.avg_score ?? -1))[0] || null;
  if (reliable.length) {
    const ordered = [...reliable].sort((a, b) => (a.sigma ?? Infinity) - (b.sigma ?? Infinity) || (b.score_per_dollar ?? -1) - (a.score_per_dollar ?? -1));
    final = ordered[0];
    reason = `passes every trial; lowest σ among reliable arms${final.score_per_dollar != null ? ', best Score/$ on tie' : ''}`;
    if (control?.pass_hat_k === 1 && control.avg_score != null && final.name !== CONTROL_ARM) {
      const delta = round(final.avg_score - control.avg_score, 2);
      if (delta < MIN_DELTA_VS_DIRECT) {
        reason = `${final.name} does not beat the single-agent control by ≥ ${MIN_DELTA_VS_DIRECT} (Δ ${delta}); orchestration is not earning its cost here`;
        final = control;
      }
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
    partial: missingJobs.length > 0,
    missing_jobs: missingJobs,
    records: records.size,
  };
}

/** Aggregate, persist to `.xm/eval/benchmarks/`, and mark the manifest finished. */
export function finishRun({ runId, allowPartial = false, now = new Date() }) {
  const manifest = readManifest(runId);
  validatePlannedCases(manifest);
  const { records, invalid } = readRecords(runId);
  const result = aggregateRun(manifest, records, { now: now.toISOString() });
  if (invalid.length) result.invalid_records = invalid;
  if (result.partial && !allowPartial) {
    const error = new Error(`run ${runId} has ${result.missing_jobs.length} unrecorded job(s); record them or pass --allow-partial`);
    error.result = result;
    throw error;
  }
  const dir = benchmarksDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now.toISOString().replace(/[:.]/g, '-')}-bench.json`);
  writeFileSync(path, JSON.stringify({ ...result, artifact_path: path }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  updateManifest(manifest, { status: 'finished', finished_at: now.toISOString(), result_path: path });
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
  const files = readdirSync(dir).filter(name => name.endsWith('-bench.json')).sort().reverse();
  for (const name of files) {
    try {
      const doc = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (doc.type === 'bench' && doc.run_id && doc.run_id !== excludeRunId) return join(dir, name);
    } catch {}
  }
  return null;
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
    lines.push(`| ${cell(s.name, width, false)} | ${cell(s.avg_score, 5)} | ${cell(s.sigma, 5)} | ${cell(`${s.pass_at_k}/${s.trials}`, 7)} | ${cell(s.pass_hat_k ? '✓' : '·', 6)} | ${cell(s.est_cost_usd != null ? `$${s.est_cost_usd}` : null, 8)} | ${cell(s.score_per_dollar, 8)} |${result.control ? ` ${cell(s.delta_vs_direct, 8)} |` : ''}`);
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
