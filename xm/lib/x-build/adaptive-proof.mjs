import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const PROOF_MIN_PAIRS = 10;
export const PROOF_MIN_COST_SAVING = 0.20;
export const PROOF_MIN_LATENCY_SAVING = 0.15;

const PRICES = {
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
};
const PRICE_SOURCE = 'OpenAI Standard short-context pricing checked 2026-08-25; USD per 1M tokens';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function usageCost(usage, model) {
  const price = PRICES[model];
  if (!price) throw new Error(`missing price for model ${model}`);
  const input = Number(usage?.input_tokens || 0);
  const cached = Number(usage?.cached_input_tokens || 0);
  const output = Number(usage?.output_tokens || 0);
  if (![input, cached, output].every((value) => Number.isFinite(value) && value >= 0) || cached > input) {
    throw new Error(`invalid token usage for model ${model}`);
  }
  return ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000;
}

function rowCost(row, fallbackModel) {
  if (row.planning_usage || row.execution_usage) {
    return usageCost(row.planning_usage || {}, row.planning_usage?.model || fallbackModel)
      + usageCost(row.execution_usage || {}, row.execution_usage?.model || row.exec_model || fallbackModel);
  }
  return usageCost(row.agents?.usage || {}, row.exec_model || fallbackModel);
}

function blindPairs(blindReports) {
  return blindReports.flatMap((report) => (report.pairs || []).map((pair) => ({
    benchmark_id: basename(report.source || report._source_path || ''), fixture: pair.fixture, trial: pair.trial, winner: pair.winner,
    variants: [report.left, report.right].filter(Boolean).sort(),
    labels: Object.values(pair.label_map || {}).sort(),
  })));
}

export function proveAdaptiveBenefit(reports, blindReports, options = {}) {
  const adaptive = options.adaptive || 'adaptive-stress-plan-sol';
  const baseline = options.baseline || 'plan-sol-exec-sol';
  const minPairs = Number(options.min_pairs || PROOF_MIN_PAIRS);
  const selectedFixtures = options.fixtures?.length ? new Set(options.fixtures) : null;
  const rows = reports.flatMap((report) => report.rows || []);
  const modelByReport = new Map(reports.map((report) => [report, report.model || 'gpt-5.6-sol']));
  const entries = reports.flatMap((report) => (report.rows || []).map((row) => ({
    row, model: modelByReport.get(report), benchmark_id: basename(report._source_path || report.output || `${report.created_at || 'report'}.json`),
  })));
  const quality = blindPairs(blindReports);
  const fixtures = [...new Set(rows.map((row) => row.fixture))].filter((fixture) => !selectedFixtures || selectedFixtures.has(fixture)).sort();
  const results = [];
  const globalBlockers = [];
  if (selectedFixtures) {
    for (const fixture of selectedFixtures) if (!fixtures.includes(fixture)) globalBlockers.push(`missing_fixture:${fixture}`);
  }

  for (const fixture of fixtures) {
    const adaptiveRows = entries.filter((entry) => entry.row.fixture === fixture && entry.row.variant === adaptive);
    const baselineRows = entries.filter((entry) => entry.row.fixture === fixture && entry.row.variant === baseline);
    const key = (entry) => `${entry.benchmark_id}:${entry.row.trial}`;
    const adaptiveByTrial = new Map(adaptiveRows.map((entry) => [key(entry), entry]));
    const baselineByTrial = new Map(baselineRows.map((entry) => [key(entry), entry]));
    const duplicateExecutionRows = adaptiveByTrial.size !== adaptiveRows.length || baselineByTrial.size !== baselineRows.length;
    const trialIds = [...adaptiveByTrial.keys()].filter((trial) => baselineByTrial.has(trial)).sort();
    const fixtureBlind = quality.filter((pair) => pair.fixture === fixture);
    const blindGroups = new Map();
    for (const pair of fixtureBlind) {
      const blindKey = `${pair.benchmark_id}:${pair.trial}`;
      if (!blindGroups.has(blindKey)) blindGroups.set(blindKey, []);
      blindGroups.get(blindKey).push(pair);
    }
    const blindByTrial = new Map([...blindGroups].map(([blindKey, pairs]) => [blindKey, pairs[0]]));
    const coveredTrials = trialIds.filter((trial) => blindByTrial.has(trial));
    const adaptiveCosts = trialIds.map((trial) => rowCost(adaptiveByTrial.get(trial).row, adaptiveByTrial.get(trial).model));
    const baselineCosts = trialIds.map((trial) => rowCost(baselineByTrial.get(trial).row, baselineByTrial.get(trial).model));
    const adaptiveWall = trialIds.map((trial) => adaptiveByTrial.get(trial).row.wall_ms);
    const baselineWall = trialIds.map((trial) => baselineByTrial.get(trial).row.wall_ms);
    const adaptiveP50Cost = median(adaptiveCosts);
    const baselineP50Cost = median(baselineCosts);
    const adaptiveP50Wall = median(adaptiveWall);
    const baselineP50Wall = median(baselineWall);
    const costSaving = baselineP50Cost ? 1 - adaptiveP50Cost / baselineP50Cost : null;
    const latencySaving = baselineP50Wall ? 1 - adaptiveP50Wall / baselineP50Wall : null;
    const adaptivePasses = adaptiveRows.filter((entry) => entry.row.verification?.passed).length;
    const baselinePasses = baselineRows.filter((entry) => entry.row.verification?.passed).length;
    const adaptiveBlindLosses = fixtureBlind.filter((pair) => pair.winner === baseline).length;
    const adaptiveBlindWins = fixtureBlind.filter((pair) => pair.winner === adaptive).length;
    const blockers = [];
    if (trialIds.length < minPairs) blockers.push('insufficient_paired_trials');
    if (duplicateExecutionRows) blockers.push('duplicate_execution_pair');
    if (coveredTrials.length !== trialIds.length) blockers.push('incomplete_blind_coverage');
    if ([...blindGroups.values()].some((pairs) => pairs.length !== 1)) blockers.push('duplicate_blind_pair');
    const expectedVariants = [adaptive, baseline].sort();
    if (fixtureBlind.some((pair) => JSON.stringify(pair.variants) !== JSON.stringify(expectedVariants)
      || JSON.stringify(pair.labels) !== JSON.stringify(expectedVariants))) blockers.push('blind_variant_mismatch');
    if (fixtureBlind.some((pair) => ![adaptive, baseline, 'tie'].includes(pair.winner))) blockers.push('invalid_blind_verdict');
    if (adaptivePasses !== adaptiveRows.length || baselinePasses !== baselineRows.length) blockers.push('verification_failure');
    if (adaptiveBlindLosses > 0) blockers.push('quality_inferior');
    if (costSaving == null || costSaving < PROOF_MIN_COST_SAVING) blockers.push('cost_saving_below_20_percent');
    if (latencySaving == null || latencySaving < PROOF_MIN_LATENCY_SAVING) blockers.push('latency_saving_below_15_percent');
    results.push({
      fixture, passed: blockers.length === 0, blockers, paired_trials: trialIds.length, blind_pairs: coveredTrials.length,
      verification: { adaptive: `${adaptivePasses}/${adaptiveRows.length}`, baseline: `${baselinePasses}/${baselineRows.length}` },
      blind: { adaptive_wins: adaptiveBlindWins, baseline_wins: adaptiveBlindLosses, ties: fixtureBlind.filter((pair) => pair.winner === 'tie').length },
      p50: { adaptive_cost_usd: adaptiveP50Cost, baseline_cost_usd: baselineP50Cost, cost_saving: costSaving, adaptive_wall_ms: adaptiveP50Wall, baseline_wall_ms: baselineP50Wall, latency_saving: latencySaving },
    });
  }
  return {
    schema: 1, passed: globalBlockers.length === 0 && results.length > 0 && results.every((result) => result.passed),
    blockers: globalBlockers, adaptive, baseline, min_pairs: minPairs,
    thresholds: { min_cost_saving: PROOF_MIN_COST_SAVING, min_latency_saving: PROOF_MIN_LATENCY_SAVING },
    pricing: { source: PRICE_SOURCE, models: PRICES },
    provenance: {
      benchmarks: reports.map((report) => ({ path: report._source_path || null, sha256: report._source_sha256 || null })),
      blind_reports: blindReports.map((report) => ({ path: report._source_path || null, sha256: report._source_sha256 || null })),
    },
    results,
  };
}

function readReports(paths) {
  return paths.map((path) => {
    const bytes = readFileSync(path);
    return { ...JSON.parse(bytes.toString('utf8')), _source_path: path, _source_sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

export function cmdAdaptiveProof(args) {
  const benchmarkPaths = [];
  const blindPaths = [];
  let adaptive = 'adaptive-stress-plan-sol';
  let baseline = 'plan-sol-exec-sol';
  let minPairs = PROOF_MIN_PAIRS;
  const fixtures = [];
  let outputPath = null;
  let save = true;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--benchmark') benchmarkPaths.push(args[++index]);
    else if (args[index] === '--blind') blindPaths.push(args[++index]);
    else if (args[index] === '--adaptive') adaptive = args[++index];
    else if (args[index] === '--baseline') baseline = args[++index];
    else if (args[index] === '--min-pairs') minPairs = Number(args[++index]);
    else if (args[index] === '--fixture') fixtures.push(...String(args[++index] || '').split(',').filter(Boolean));
    else if (args[index] === '--out') outputPath = args[++index];
    else if (args[index] === '--no-save') save = false;
  }
  if (!benchmarkPaths.length || !blindPaths.length) throw new Error('route prove requires --benchmark and --blind files');
  let result = proveAdaptiveBenefit(readReports(benchmarkPaths), readReports(blindPaths), { adaptive, baseline, min_pairs: minPairs, fixtures });
  if (save) {
    const target = resolve(outputPath || join(process.cwd(), '.xm', 'eval', 'benchmarks', `adaptive-proof-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
    mkdirSync(dirname(target), { recursive: true });
    result = { ...result, artifact_path: target, generated_at: new Date().toISOString() };
    writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 2;
  return result;
}
