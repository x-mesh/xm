/**
 * x-eval/gate — regression comparison between two bench results.
 *
 * "Did this SKILL.md / prompt / model change make the strategy worse on the
 * fixed case set?" is answered per arm: a lost pass^k, or an average drop past
 * the threshold, blocks. Thresholds mirror subcommands/diff.md (Δ ≤ −0.5 is a
 * regression). The gate never re-runs anything; it compares two saved bench
 * files and records both files' sha256 so the verdict is auditable.
 */

import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { validatePersistedBench } from './bench.mjs';
import { round } from './stats.mjs';

export const DEFAULT_MAX_AVG_DROP = 0.5;
export const MAX_BENCH_FILE_BYTES = 4 * 1024 * 1024;

function armMap(bench) {
  return new Map((bench?.strategies || []).map(arm => [arm.name, arm]));
}

/** Pure comparison. `current` and `baseline` are bench result objects. */
export function compareBench(current, baseline, { maxAvgDrop = DEFAULT_MAX_AVG_DROP } = {}) {
  const blockers = [];
  const arms = [];
  const currentArms = armMap(current);
  const baselineArms = armMap(baseline);
  if (!currentArms.size) blockers.push({ code: 'no_current_arms', detail: 'current bench has no strategies' });
  if (!baselineArms.size) blockers.push({ code: 'no_baseline_arms', detail: 'baseline bench has no strategies' });
  if (current?.partial) blockers.push({ code: 'insufficient_records', detail: `current run is partial (${(current.missing_jobs || []).length} job(s) missing)` });
  if (baseline?.partial) blockers.push({ code: 'baseline_insufficient_records', detail: `baseline run is partial (${(baseline.missing_jobs || []).length} job(s) missing)` });
  if (current?.broken_task_warning) blockers.push({ code: 'broken_task', detail: 'current run tripped the broken-task warning' });
  if (baseline?.broken_task_warning) blockers.push({ code: 'baseline_broken_task', detail: 'baseline run tripped the broken-task warning' });
  const currentCases = new Map((current?.cases || []).map(item => [item.id, item]));
  const baselineCases = new Map((baseline?.cases || []).map(item => [item.id, item]));
  const currentIds = [...currentCases.keys()].sort();
  const baselineIds = [...baselineCases.keys()].sort();
  if (!currentIds.length && !baselineIds.length) {
    blockers.push({ code: 'case_metadata_missing', detail: 'both bench results must record at least one case for a compatible comparison' });
  } else if (JSON.stringify(currentIds) !== JSON.stringify(baselineIds)) {
    blockers.push({ code: 'case_set_mismatch', detail: `case sets differ (baseline ${baselineIds.join(',') || 'none'}; current ${currentIds.join(',') || 'none'})` });
  } else {
    const rubricDrift = baselineIds.filter(id => currentCases.get(id)?.rubric !== baselineCases.get(id)?.rubric);
    const thresholdDrift = baselineIds.filter(id => currentCases.get(id)?.pass_threshold !== baselineCases.get(id)?.pass_threshold);
    const trialDrift = baselineIds.filter(id => currentCases.get(id)?.trials !== baselineCases.get(id)?.trials);
    if (rubricDrift.length) blockers.push({ code: 'rubric_mismatch', detail: `rubric differs for case(s): ${rubricDrift.join(', ')}` });
    if (thresholdDrift.length) blockers.push({ code: 'pass_threshold_mismatch', detail: `pass threshold differs for case(s): ${thresholdDrift.join(', ')}` });
    if (trialDrift.length) blockers.push({ code: 'trial_count_mismatch', detail: `trial count differs for case(s): ${trialDrift.join(', ')}` });
  }

  for (const [name, base] of baselineArms) {
    const cur = currentArms.get(name);
    if (!cur) {
      blockers.push({ code: 'arm_missing', arm: name, detail: `baseline arm "${name}" is absent from the current run` });
      arms.push({ arm: name, baseline: summarize(base), current: null, delta_avg: null, status: 'missing' });
      continue;
    }
    const deltaAvg = cur.avg_score != null && base.avg_score != null ? round(cur.avg_score - base.avg_score, 3) : null;
    const status = [];
    if (base.pass_hat_k === 1 && cur.pass_hat_k === 0) {
      blockers.push({ code: 'pass_hat_k_lost', arm: name, detail: `pass^k dropped from all-pass to ${cur.pass_at_k}/${cur.trials}` });
      status.push('pass_hat_k_lost');
    }
    if (deltaAvg != null && deltaAvg <= -Math.abs(maxAvgDrop)) {
      blockers.push({ code: 'avg_drop_over_threshold', arm: name, detail: `avg ${base.avg_score} → ${cur.avg_score} (Δ ${deltaAvg}, limit −${Math.abs(maxAvgDrop)})` });
      status.push('avg_drop');
    }
    if (cur.trials < base.trials) status.push('fewer_trials');
    arms.push({ arm: name, baseline: summarize(base), current: summarize(cur), delta_avg: deltaAvg, status: status.length ? status.join('+') : (deltaAvg != null && deltaAvg > 0 ? 'improved' : 'ok') });
  }
  for (const [name, cur] of currentArms) {
    if (!baselineArms.has(name)) arms.push({ arm: name, baseline: null, current: summarize(cur), delta_avg: null, status: 'new' });
  }
  return { schema_v: 1, passed: blockers.length === 0, max_avg_drop: Math.abs(maxAvgDrop), blockers, arms };
}

function summarize(arm) {
  return {
    avg_score: arm.avg_score ?? null,
    sigma: arm.sigma ?? null,
    trials: arm.trials ?? 0,
    pass_at_k: arm.pass_at_k ?? 0,
    pass_hat_k: arm.pass_hat_k ?? null,
    pass_at_k_rate: arm.pass_at_k_rate ?? null,
  };
}

/** Read a bench file with its sha256 for provenance. */
export function readBenchFile(path) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`bench result must be a regular non-symlink file: ${path}`);
  if (info.size > MAX_BENCH_FILE_BYTES) throw new Error(`bench result exceeds ${MAX_BENCH_FILE_BYTES} bytes: ${path}`);
  const bytes = readFileSync(path);
  let bench;
  try { bench = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`bench result is invalid JSON: ${error.message}`); }
  return { bench: validatePersistedBench(bench), sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function formatGateReport(report, { currentPath, baselinePath } = {}) {
  const lines = [];
  lines.push(`${report.passed ? '✅' : '⛔'} [eval] Regression gate: ${report.passed ? 'PASS' : 'FAIL'}  (max avg drop ${report.max_avg_drop})`);
  if (currentPath || baselinePath) lines.push(`  current: ${currentPath || '—'}\n  baseline: ${baselinePath || '—'}`);
  lines.push('');
  lines.push('| Arm | Baseline avg | Current avg | Δ | pass^k (base→cur) | Status |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of report.arms) {
    const b = row.baseline; const c = row.current;
    const passHat = arm => !arm || arm.pass_hat_k == null ? '—' : (arm.pass_hat_k ? '✓' : '·');
    lines.push(`| ${row.arm} | ${b ? b.avg_score : '—'} | ${c ? c.avg_score : '—'} | ${row.delta_avg ?? '—'} | ${passHat(b)}→${passHat(c)} | ${row.status} |`);
  }
  if (report.blockers.length) {
    lines.push('');
    lines.push('Blockers:');
    for (const blocker of report.blockers) lines.push(`  - ${blocker.code}${blocker.arm ? ` [${blocker.arm}]` : ''}: ${blocker.detail}`);
  }
  return lines.join('\n');
}
