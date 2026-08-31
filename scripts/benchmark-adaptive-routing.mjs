#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROFILE_RANK = { light: 0, standard: 1, deep: 2 };

export const FIXTURES = [
  { id: 'bounded-local', goal: 'Update src/helper.mjs locally without changing public behavior', seedMemory: true, expectedProfile: 'light', expectedPlanMode: 'standard' },
  { id: 'docs-only', goal: 'Update docs/security.md only; no security behavior changes', seedMemory: true, expectedProfile: 'light', expectedPlanMode: 'standard' },
  { id: 'normal-brownfield', goal: 'Improve the local caching behavior and add focused regression coverage', seedMemory: false, expectedProfile: 'standard', expectedPlanMode: 'standard' },
  { id: 'high-risk-schema', goal: 'Migrate the public API schema and deploy the breaking change safely', seedMemory: false, expectedProfile: 'deep', expectedPlanMode: 'standard' },
  { id: 'broad-architecture', goal: 'Replace the internal architecture across every package and update docs everywhere', seedMemory: true, expectedProfile: 'standard', expectedPlanMode: 'standard' },
  { id: 'whole-codebase', goal: 'Refactor the whole codebase and update documentation', seedMemory: true, expectedProfile: 'standard', expectedPlanMode: 'standard' },
];

function parseArgs(argv) {
  // The candidate defaults to this checkout so `npm run bench:routing`
  // validates the code about to ship, not a previous release tag. A released
  // ref can still be supplied explicitly with `--candidate vX.Y.Z`.
  const options = { baseline: 'v2.19.1', candidate: 'worktree', trials: 3, human_turn_ms: 30_000, model_stage_ms: 60_000, json: false, keep: false, save: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline') options.baseline = argv[++i];
    else if (arg === '--candidate') options.candidate = argv[++i];
    else if (arg === '--trials') options.trials = Number(argv[++i]);
    else if (arg === '--human-turn-ms') options.human_turn_ms = Number(argv[++i]);
    else if (arg === '--model-stage-ms') options.model_stage_ms = Number(argv[++i]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--no-save') options.save = false;
    else throw new Error('unknown option: ' + arg);
  }
  if (![options.human_turn_ms, options.model_stage_ms].every((value) => Number.isFinite(value) && value >= 0)) throw new Error('simulation durations must be non-negative numbers');
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 20) throw new Error('trials must be an integer from 1 to 20');
  if (options.baseline === options.candidate) throw new Error('baseline and candidate must differ; baseline is interpreted with legacy pre-adaptive routing semantics');
  return options;
}

function saveResult(result) {
  const directory = join(REPO, '.xm', 'eval', 'benchmarks');
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const pair = (result.baseline + '-to-' + result.candidate).replace(/[^A-Za-z0-9_.-]+/g, '-');
  const path = join(directory, stamp + '-' + process.pid + '-' + pair + '-adaptive-routing.json');
  const stored = { ...result, artifact_path: path, metric_provenance: { routing: 'observed from isolated release/worktree CLIs', observed_cli_ms: 'measured local subprocess wall time', simulated_ms: 'derived from explicit human_turn_ms and model_stage_ms assumptions', provider_tokens_and_cost: 'not measured' } };
  writeFileSync(path, JSON.stringify(stored, null, 2) + '\n');
  return stored;
}

function archiveRef(ref, root, role) {
  if (ref === 'worktree') return REPO;
  const slug = ref.replace(/[^A-Za-z0-9_.-]+/g, '-');
  const target = join(root, role + '-' + slug);
  const archive = join(root, role + '-' + slug + '.tar');
  mkdirSync(target, { recursive: true });
  execFileSync('git', ['archive', '--format=tar', '-o', archive, ref], { cwd: REPO });
  execFileSync('tar', ['-xf', archive, '-C', target]);
  return realpathSync(target);
}

function run(command, args, options = {}) {
  const started = process.hrtime.bigint();
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, ...options });
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '', elapsed_ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

function parseJsonResult(result, label) {
  try { return JSON.parse(result.stdout); } catch (error) {
    throw new Error(label + ' returned invalid JSON (' + error.message + '): stdout=' + JSON.stringify(result.stdout.slice(0, 500)) + ' stderr=' + JSON.stringify(result.stderr.slice(0, 500)));
  }
}

function initFixture(root, fixture) {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.xm', 'memory'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'bench-' + fixture.id, scripts: { test: 'node --test' } }, null, 2));
  writeFileSync(join(root, 'src', 'helper.mjs'), 'export const helper = 1;\n');
  const memory = fixture.seedMemory ? [{ id: 'mem-001', title: fixture.goal, type: 'pattern', tags: ['benchmark'], created: '2026-01-01T00:00:00.000Z', ttl: null, expires_at: null, related_files: ['src/helper.mjs'], confidence: 'high', source: 'benchmark', why: fixture.goal }] : [];
  writeFileSync(join(root, '.xm', 'memory', 'index.json'), JSON.stringify(memory, null, 2));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'benchmark@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'xm benchmark'], { cwd: root });
  execFileSync('git', ['add', 'package.json', 'src/helper.mjs'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
}

function cliEnv(source, fixtureRoot) {
  return { ...process.env, XM_LIB: source, XM_ROOT: join(fixtureRoot, '.xm'), X_BUILD_ROOT: join(fixtureRoot, '.xm', 'build'), X_MEMORY_ROOT: join(fixtureRoot, '.xm', 'memory'), XKIT_SERVER: '0', NO_COLOR: '1' };
}

function researchAgents(profile, signal) {
  if (profile === 'light') return 0;
  if (profile === 'standard') return 1;
  if (profile === 'deep') return 4;
  if (signal === 'quick-eligible') return 0;
  if (signal === 'slim') return 1;
  return 4;
}

function legacyBuildDecision(output) {
  const signal = output.research_signal?.recommendation || 'full';
  if (signal === 'quick-eligible') return { profile: 'light', human_turns: 1, plan_calls: 2, source: 'legacy-confirmed-quick' };
  if (signal === 'slim') return { profile: 'standard', human_turns: 0, plan_calls: 1, source: 'legacy-slim' };
  return { profile: 'deep', human_turns: 0, plan_calls: 1, source: 'legacy-full' };
}

function planDecision(source, fixture, candidate) {
  if (!candidate) return { mode: 'standard', human_turns: 1, model_stages: 5, source: 'legacy-standard-default', elapsed_ms: 0 };
  const result = run('node', [join(source, 'x-plan', 'lib', 'x-plan-cli.mjs'), '--recommend', '--json', fixture.goal], { cwd: REPO });
  if (result.status !== 0) throw new Error('candidate plan failed for ' + fixture.id + ': ' + (result.stderr || result.stdout));
  const output = parseJsonResult(result, 'candidate x-plan ' + fixture.id);
  return { mode: output.mode, human_turns: output.confirmation_required ? 1 : 0, model_stages: output.mode === 'quick' ? 1 : output.mode === 'ultra' ? 8 : 5, source: output.source, elapsed_ms: result.elapsed_ms, risk: output.risk };
}

function buildDecision(source, fixture, ref, candidate, workspace) {
  const role = candidate ? 'candidate' : 'baseline';
  const root = join(workspace, role + '-' + ref.replace(/[^A-Za-z0-9_.-]+/g, '-') + '-' + fixture.id);
  mkdirSync(root, { recursive: true });
  initFixture(root, fixture);
  const env = cliEnv(source, root);
  const dispatcher = join(source, 'xm', 'scripts', 'xm');
  const init = run('bash', [dispatcher, 'build', 'init', 'bench-' + fixture.id], { cwd: root, env });
  if (init.status !== 0) throw new Error(ref + ' init failed for ' + fixture.id + ': ' + (init.stderr || init.stdout));
  const planned = run('bash', [dispatcher, 'build', 'plan', fixture.goal, '--json'], { cwd: root, env });
  if (planned.status !== 0) throw new Error(ref + ' plan failed for ' + fixture.id + ': ' + (planned.stderr || planned.stdout));
  const output = parseJsonResult(planned, ref + ' x-build ' + fixture.id);
  const decision = candidate ? { profile: output.profile, human_turns: output.profile_recommendation?.confirmation_required ? 1 : 0, plan_calls: output.profile_recommendation?.confirmation_required ? 2 : 1, source: output.profile_source || 'candidate' } : legacyBuildDecision(output);
  const signal = output.research_signal?.recommendation || 'none';
  return { ...decision, research_scope: output.research_scope, research_signal: signal, research_agents: researchAgents(decision.profile, signal), artifacts: output.required_artifacts || [], observed_cli_ms: init.elapsed_ms + planned.elapsed_ms, raw_profile: output.profile };
}

function scoreRow(row, assumptions) {
  const buildMs = row.build.human_turns * assumptions.human_turn_ms + (row.build.research_agents > 0 ? assumptions.model_stage_ms : 0);
  const planMs = row.plan.human_turns * assumptions.human_turn_ms + row.plan.model_stages * assumptions.model_stage_ms;
  return { ...row, build_simulated_ms: buildMs, plan_simulated_ms: planMs, build_work_units: row.build.research_agents, plan_work_units: row.plan.model_stages };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function percentile(values, ratio) {
  const ordered = [...values].sort((a, b) => a - b);
  const position = (ordered.length - 1) * ratio;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function distribution(values) {
  return { samples: values.length, min_ms: Math.min(...values), p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), max_ms: Math.max(...values) };
}

function structuralSignature(row) {
  return JSON.stringify({ profile: row.build.profile, research_agents: row.build.research_agents, mode: row.plan.mode, human_turns: row.build.human_turns + row.plan.human_turns });
}

function sampleVariant(source, fixture, ref, candidate, workspace, trials) {
  const rows = [];
  for (let trial = 0; trial < trials; trial += 1) {
    rows.push({ fixture: fixture.id, build: buildDecision(source, fixture, ref + '-trial-' + trial, candidate, workspace), plan: planDecision(source, fixture, candidate) });
  }
  const signatures = new Set(rows.map(structuralSignature));
  if (signatures.size !== 1) throw new Error(ref + ' produced nondeterministic routing for ' + fixture.id);
  const representative = rows[0];
  representative.metrics = { trials, deterministic: true, build_cli: distribution(rows.map((row) => row.build.observed_cli_ms)), plan_cli: distribution(rows.map((row) => row.plan.elapsed_ms)) };
  return representative;
}

export function summarize(baselineRows, candidateRows, assumptions) {
  const baseline = baselineRows.map((row) => scoreRow(row, assumptions));
  const candidate = candidateRows.map((row) => scoreRow(row, assumptions));
  const comparisons = FIXTURES.map((fixture, index) => {
    const before = baseline[index];
    const after = candidate[index];
    const baselineSafetyPass = PROFILE_RANK[before.build.profile] >= PROFILE_RANK[fixture.expectedProfile];
    const candidateSafetyPass = PROFILE_RANK[after.build.profile] >= PROFILE_RANK[fixture.expectedProfile];
    return { fixture: fixture.id, expected_profile: fixture.expectedProfile, expected_plan_mode: fixture.expectedPlanMode, baseline: before, candidate: after, build_delta_ms: after.build_simulated_ms - before.build_simulated_ms, plan_delta_ms: after.plan_simulated_ms - before.plan_simulated_ms, build_work_delta: after.build_work_units - before.build_work_units, plan_work_delta: after.plan_work_units - before.plan_work_units, baseline_safety_pass: baselineSafetyPass, safety_pass: candidateSafetyPass, routing_fit: after.build.profile === fixture.expectedProfile && after.plan.mode === fixture.expectedPlanMode, safety_correction: !baselineSafetyPass && candidateSafetyPass };
  });
  const comparable = comparisons.filter((row) => row.baseline_safety_pass && row.safety_pass);
  const baselineBuildMedian = median(comparable.map((row) => row.baseline.build_simulated_ms));
  const candidateBuildMedian = median(comparable.map((row) => row.candidate.build_simulated_ms));
  const baselinePlanMedian = median(baseline.map((row) => row.plan_simulated_ms));
  const candidatePlanMedian = median(candidate.map((row) => row.plan_simulated_ms));
  const bounded = comparisons.find((row) => row.fixture === 'bounded-local');
  const gates = { safety: comparisons.every((row) => row.safety_pass), routing_fit: comparisons.every((row) => row.routing_fit), deterministic: comparisons.every((row) => row.baseline.metrics?.deterministic !== false && row.candidate.metrics?.deterministic !== false), bounded_turn_reduction: bounded.candidate.build.human_turns < bounded.baseline.build.human_turns || bounded.candidate.plan.human_turns < bounded.baseline.plan.human_turns, build_non_regression: candidateBuildMedian <= baselineBuildMedian, plan_structural_reduction: candidatePlanMedian < baselinePlanMedian };
  const totals = (rows) => ({ human_turns: rows.reduce((sum, row) => sum + row.build.human_turns + row.plan.human_turns, 0), research_agents: rows.reduce((sum, row) => sum + row.build.research_agents, 0), plan_model_stages: rows.reduce((sum, row) => sum + row.plan.model_stages, 0) });
  const sensitivity = [15_000, 30_000, 60_000, 120_000].map((stage) => {
    const before = median(baseline.map((row) => row.plan.human_turns * assumptions.human_turn_ms + row.plan.model_stages * stage));
    const after = median(candidate.map((row) => row.plan.human_turns * assumptions.human_turn_ms + row.plan.model_stages * stage));
    return { model_stage_ms: stage, plan_reduction_ratio: before ? (before - after) / before : null };
  });
  const baselineWork = totals(baseline);
  const candidateWork = totals(candidate);
  const trials = Math.min(...comparisons.map((row) => Math.min(row.baseline.metrics?.trials || 1, row.candidate.metrics?.trials || 1)));
  const confidence = trials >= 10 ? 'strong' : trials >= 5 ? 'moderate' : 'preliminary';
  return { assumptions, sample: { fixtures: comparisons.length, trials_per_variant: trials, total_cli_runs: comparisons.length * trials * 2, confidence }, comparisons, aggregate: { work: { baseline: baselineWork, candidate: candidateWork, delta: { human_turns: candidateWork.human_turns - baselineWork.human_turns, research_agents: candidateWork.research_agents - baselineWork.research_agents, plan_model_stages: candidateWork.plan_model_stages - baselineWork.plan_model_stages } }, observed_cli: { baseline_build_p50_ms: median(baseline.map((row) => row.metrics?.build_cli?.p50_ms || row.build.observed_cli_ms || 0)), baseline_build_p95_ms: median(baseline.map((row) => row.metrics?.build_cli?.p95_ms || row.build.observed_cli_ms || 0)), candidate_build_p50_ms: median(candidate.map((row) => row.metrics?.build_cli?.p50_ms || row.build.observed_cli_ms || 0)), candidate_build_p95_ms: median(candidate.map((row) => row.metrics?.build_cli?.p95_ms || row.build.observed_cli_ms || 0)), candidate_plan_p50_ms: median(candidate.map((row) => row.metrics?.plan_cli?.p50_ms || row.plan.elapsed_ms || 0)), candidate_plan_p95_ms: median(candidate.map((row) => row.metrics?.plan_cli?.p95_ms || row.plan.elapsed_ms || 0)) }, build: { comparable_fixtures: comparable.map((row) => row.fixture), safety_corrections: comparisons.filter((row) => row.safety_correction).map((row) => row.fixture), baseline_median_simulated_ms: baselineBuildMedian, candidate_median_simulated_ms: candidateBuildMedian, reduction_ratio: baselineBuildMedian ? (baselineBuildMedian - candidateBuildMedian) / baselineBuildMedian : null }, plan: { baseline_median_simulated_ms: baselinePlanMedian, candidate_median_simulated_ms: candidatePlanMedian, reduction_ratio: baselinePlanMedian ? (baselinePlanMedian - candidatePlanMedian) / baselinePlanMedian : null }, sensitivity }, gates, passed: Object.values(gates).every(Boolean) };
}

export function runBenchmark(options) {
  const workspace = mkdtempSync(join(tmpdir(), 'xm-routing-bench-'));
  try {
    const baselineSource = archiveRef(options.baseline, workspace, 'baseline');
    const candidateSource = archiveRef(options.candidate, workspace, 'candidate');
    const baselineRows = FIXTURES.map((fixture) => sampleVariant(baselineSource, fixture, options.baseline, false, workspace, options.trials));
    const candidateRows = FIXTURES.map((fixture) => sampleVariant(candidateSource, fixture, options.candidate, true, workspace, options.trials));
    return { schema_version: 1, baseline: options.baseline, candidate: options.candidate, benchmark_kind: 'offline-structural', observed_cli_note: 'CLI elapsed time excludes real providers and is not used for the improvement gate.', ...summarize(baselineRows, candidateRows, options) };
  } finally {
    if (!options.keep) rmSync(workspace, { recursive: true, force: true });
  }
}

function render(result) {
  console.log('Offline adaptive-routing benchmark: ' + result.baseline + ' -> ' + result.candidate);
  console.log('fixture              build(before->after)   research agents   plan(before->after)   structural delta');
  for (const row of result.comparisons) {
    console.log(row.fixture.padEnd(20) + (row.baseline.build.profile + '->' + row.candidate.build.profile).padEnd(23) + (row.baseline.build.research_agents + '->' + row.candidate.build.research_agents).padEnd(18) + (row.baseline.plan.mode + '->' + row.candidate.plan.mode).padEnd(22) + 'build ' + Math.round(row.build_delta_ms) + 'ms / plan ' + Math.round(row.plan_delta_ms) + 'ms' + (row.safety_pass ? row.safety_correction ? ' SAFETY_CORRECTION' : '' : ' SAFETY_FAIL'));
  }
  console.log('build median simulated path: ' + Math.round(result.aggregate.build.baseline_median_simulated_ms) + 'ms -> ' + Math.round(result.aggregate.build.candidate_median_simulated_ms) + 'ms');
  if (result.aggregate.build.safety_corrections.length) console.log('build safety corrections excluded from perf median: ' + result.aggregate.build.safety_corrections.join(', '));
  console.log('plan median simulated path: ' + Math.round(result.aggregate.plan.baseline_median_simulated_ms) + 'ms -> ' + Math.round(result.aggregate.plan.candidate_median_simulated_ms) + 'ms (' + (result.aggregate.plan.reduction_ratio * 100).toFixed(1) + '%)');
  console.log('gates: ' + Object.entries(result.gates).map(([key, value]) => key + '=' + (value ? 'PASS' : 'FAIL')).join(' | '));
  console.log('verdict: ' + (result.passed ? 'PASS' : 'FAIL'));
}

if (import.meta.url === 'file://' + process.argv[1]) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const measured = runBenchmark(options);
    const result = options.save ? saveResult(measured) : measured;
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else render(result);
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error('benchmark failed: ' + error.message);
    process.exitCode = 2;
  }
}
