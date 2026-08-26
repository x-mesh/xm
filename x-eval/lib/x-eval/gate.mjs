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
import { readFileSync } from 'node:fs';
import { round } from './stats.mjs';

export const DEFAULT_MAX_AVG_DROP = 0.5;

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
  if (current?.broken_task_warning) blockers.push({ code: 'broken_task', detail: 'current run tripped the broken-task warning' });

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
    pass_hat_k: arm.pass_hat_k ?? 0,
    pass_at_k_rate: arm.pass_at_k_rate ?? null,
  };
}

/** Read a bench file with its sha256 for provenance. */
export function readBenchFile(path) {
  const bytes = readFileSync(path);
  return { bench: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
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
    lines.push(`| ${row.arm} | ${b ? b.avg_score : '—'} | ${c ? c.avg_score : '—'} | ${row.delta_avg ?? '—'} | ${b ? (b.pass_hat_k ? '✓' : '·') : '—'}→${c ? (c.pass_hat_k ? '✓' : '·') : '—'} | ${row.status} |`);
  }
  if (report.blockers.length) {
    lines.push('');
    lines.push('Blockers:');
    for (const blocker of report.blockers) lines.push(`  - ${blocker.code}${blocker.arm ? ` [${blocker.arm}]` : ''}: ${blocker.detail}`);
  }
  return lines.join('\n');
}
