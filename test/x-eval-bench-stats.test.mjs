import { describe, test, expect } from 'bun:test';
import { buildManifest, aggregateRun, validateRecord, parseStrategies, jobIdFor, CONTROL_ARM, MIN_DELTA_VS_DIRECT } from '../x-eval/lib/x-eval/bench.mjs';
import { compareBench } from '../x-eval/lib/x-eval/gate.mjs';
import { mean, sigma, median, round } from '../x-eval/lib/x-eval/stats.mjs';
import { buildCase, caseId, passThresholdFor, DEFAULT_TRIALS } from '../x-eval/lib/x-eval/cases.mjs';

const caseA = buildCase({ prompt: 'Find the bug in this code', rubric: 'general', tags: ['op'], createdAt: '2026-08-26T00:00:00.000Z' });
const caseHigh = buildCase({ prompt: 'Harden the parser', rubric: 'code-quality', tags: ['op', 'risk'], risk: 'high', minOverall: 8, createdAt: '2026-08-26T00:00:00.000Z' });

/** Build a records map from { arm: [overall, ...] } for a single-case manifest. */
function recordsFor(manifest, scoresByArm, extra = {}) {
  const records = new Map();
  for (const job of manifest.jobs) {
    const scores = scoresByArm[job.arm];
    if (!scores || scores[job.trial - 1] == null) continue;
    const overall = scores[job.trial - 1];
    const meta = manifest.cases.find(c => c.id === job.case_id);
    records.set(job.job_id, { job_id: job.job_id, overall, passed: overall >= meta.pass_threshold, cost_usd_est: (extra.cost || {})[job.arm] ?? 0.1, duration_ms: 1000 });
  }
  return records;
}

describe('stats', () => {
  test('mean / sigma / median / round', () => {
    expect(mean([8, 9, 10])).toBe(9);
    expect(round(sigma([8, 9, 10]), 3)).toBe(0.816);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(mean([])).toBeNull();
    expect(round(null)).toBeNull();
  });
});

describe('cases', () => {
  test('id is a hash of prompt + rubric + sorted tags; pass threshold honours min_overall', () => {
    expect(caseA.id).toMatch(/^case-[0-9a-f]{24}$/);
    expect(caseId({ prompt: 'Find the bug in this code', rubric: 'general', tags: ['op'] })).toBe(caseA.id);
    expect(caseId({ prompt: 'Find the bug in this code', rubric: 'general', tags: ['x', 'op'] })).not.toBe(caseA.id);
    expect(passThresholdFor(caseA)).toBe(7);
    expect(passThresholdFor(caseHigh)).toBe(8);
    expect(() => buildCase({ prompt: '' })).toThrow(/empty/);
    expect(() => buildCase({ prompt: 'x', rubric: '../etc' })).toThrow(/rubric/);
    expect(() => buildCase({ prompt: 'x', risk: 'extreme' })).toThrow(/risk/);
    expect(() => buildCase({ prompt: 'x', assertions: [{ kind: 'cmd', name: 'bad name', spec: 'ls' }] })).toThrow(/must match/);
  });
});

describe('bench manifest', () => {
  test('direct control is on by default and trials follow case risk', () => {
    const manifest = buildManifest({ cases: [caseA, caseHigh], strategies: parseStrategies('refine,debate,direct'), runId: 'bench-20260826T000000Z-abcd' });
    expect(manifest.arms).toEqual(['direct', 'refine', 'debate']);
    expect(manifest.control).toBe(CONTROL_ARM);
    const jobsA = manifest.jobs.filter(j => j.case_id === caseA.id);
    const jobsHigh = manifest.jobs.filter(j => j.case_id === caseHigh.id);
    expect(jobsA.length).toBe(3 * DEFAULT_TRIALS.normal);
    expect(jobsHigh.length).toBe(3 * DEFAULT_TRIALS.high);
    expect(manifest.jobs[0].job_id).toBe(jobIdFor(caseA.id, 'direct', 1));
    const noDirect = buildManifest({ cases: [caseA], strategies: ['refine'], includeDirect: false, trials: 2 });
    expect(noDirect.arms).toEqual(['refine']);
    expect(noDirect.control).toBeNull();
    expect(noDirect.jobs.length).toBe(2);
    expect(() => buildManifest({ cases: [caseA], strategies: [] })).toThrow(/at least one strategy/);
    expect(() => parseStrategies('Refine;rm')).toThrow(/strategy/);
    expect(parseStrategies('brainstorm|tournament|refine, debate')).toEqual(['brainstorm|tournament|refine', 'debate']);
  });
});

describe('bench records', () => {
  test('validateRecord keeps metrics, rejects output text, derives passed from threshold and assertions', () => {
    const ok = validateRecord({ overall: 8.25, per_criterion: { accuracy: 9 }, judges: 3, cost_usd_est: 0.12, duration_ms: 1500 }, { passThreshold: 7 });
    expect(ok).toMatchObject({ overall: 8.25, passed: true, cost_source: 'estimated', judges: 3 });
    expect(validateRecord({ overall: 6.9 }, { passThreshold: 7 }).passed).toBe(false);
    expect(validateRecord({ overall: 6.9, passed: true }, { passThreshold: 7 }).passed).toBe(false);
    expect(validateRecord({ overall: 9, passed: false }, { passThreshold: 7 }).passed).toBe(false);
    const hard = validateRecord({ overall: 9, assertion_results: [{ name: 'tests', result: 'HARD_FAIL', source: 'executable' }] }, { passThreshold: 7 });
    expect(hard.passed).toBe(false);
    expect(hard.assertion_hard_fail).toBe(true);
    expect(() => validateRecord({ overall: 8, output: 'leak' }, { passThreshold: 7 })).toThrow(/output text/);
    expect(() => validateRecord({ overall: 11 }, { passThreshold: 7 })).toThrow(/overall/);
    expect(() => validateRecord({ overall: '8' }, { passThreshold: 7 })).toThrow(/overall/);
    expect(() => validateRecord({ overall: 8, output_sha256: 'zz' }, { passThreshold: 7 })).toThrow(/sha256/);
    expect(() => validateRecord({ overall: 8, cost_usd_est: -1 }, { passThreshold: 7 })).toThrow(/cost/);
  });
});

describe('bench aggregation (subcommands/bench.md rules)', () => {
  const manifest = buildManifest({ cases: [caseA], strategies: ['refine', 'debate', 'tournament'], trials: 3, runId: 'bench-20260826T000000Z-0001' });

  test('pass@k / pass^k / σ and the σ-aware recommendation', () => {
    const records = recordsFor(manifest, { direct: [7.0, 7.1, 7.2], refine: [8.2, 8.0, 8.4], debate: [8.2, 7.9, 5.4], tournament: [8.5, 8.7, 8.3] }, { cost: { direct: 0.05, refine: 0.12, debate: 0.08, tournament: 0.15 } });
    const result = aggregateRun(manifest, records);
    const byName = Object.fromEntries(result.strategies.map(s => [s.name, s]));
    expect(byName.refine).toMatchObject({ trials: 3, pass_at_k: 3, pass_hat_k: 1, pass_at_k_rate: 1 });
    expect(byName.debate).toMatchObject({ pass_at_k: 2, pass_hat_k: 0, pass_at_k_rate: 0.667 });
    expect(byName.debate.avg_score).toBe(7.17);
    expect(byName.tournament.delta_vs_direct).toBe(1.4);
    expect(byName.direct.delta_vs_direct).toBe(0);
    expect(result.broken_task_warning).toBe(false);
    expect(result.recommendation.best_quality).toBe('tournament');
    // σ-aware: among all-pass arms (direct, refine, tournament) the lowest σ wins
    expect(result.recommendation.final).toBe('direct');
    expect(result.recommendation.reason).toContain('lowest σ');
    expect(result.partial).toBe(false);
  });

  test('a strategy that does not beat direct by ≥ 0.5 is demoted to direct', () => {
    // refine has the lowest σ and would win on the σ rule, but only leads direct by 0.3
    const records = recordsFor(manifest, { direct: [8.0, 7.6, 8.4], refine: [8.4, 8.2, 8.3], debate: [6, 6, 6], tournament: [6, 6, 6] });
    const result = aggregateRun(manifest, records);
    expect(result.recommendation.final).toBe('direct');
    expect(result.recommendation.reason).toContain(`≥ ${MIN_DELTA_VS_DIRECT}`);
    expect(result.strategies.find(s => s.name === 'refine').delta_vs_direct).toBe(0.3);
  });

  test('a strategy that clearly beats direct is recommended over it', () => {
    const records = recordsFor(manifest, { direct: [7.0, 7.2, 7.1], refine: [8.6, 8.8, 8.7], debate: [6, 6, 6], tournament: [6, 6, 6] });
    const result = aggregateRun(manifest, records);
    expect(result.recommendation.final).toBe('refine');
  });

  test('an unreliable direct control is never recommended', () => {
    const records = recordsFor(manifest, { direct: [8.5, 6.5, 8.5], refine: [8.1, 8.1, 8.1], debate: [6, 6, 6], tournament: [6, 6, 6] });
    const result = aggregateRun(manifest, records);
    expect(result.strategies.find(s => s.name === 'direct').pass_hat_k).toBe(0);
    expect(result.recommendation.final).toBe('refine');
  });

  test('flaky-high-avg arm (pass^k = 0 despite avg 8.2) is never recommended', () => {
    const records = recordsFor(manifest, { direct: [6, 6.5, 6.2], refine: [10, 10, 4.6], debate: [6, 6, 6], tournament: [6, 6, 6] });
    const result = aggregateRun(manifest, records);
    const refine = result.strategies.find(s => s.name === 'refine');
    expect(refine.avg_score).toBe(8.2);
    expect(refine.pass_hat_k).toBe(0);
    expect(result.recommendation.final).toBeNull();
    expect(result.recommendation.best_effort).toBe('refine');
    expect(result.advisories.some(a => a.startsWith('flaky-best'))).toBe(true);
  });

  test('broken-task warning needs 0% pass AND avg < 4.5 on every arm', () => {
    const broken = aggregateRun(manifest, recordsFor(manifest, { direct: [3, 3, 3], refine: [3, 3.5, 2], debate: [4, 4, 4], tournament: [2, 2, 2] }));
    expect(broken.broken_task_warning).toBe(true);
    const weak = aggregateRun(manifest, recordsFor(manifest, { direct: [6, 6, 6], refine: [6.5, 6, 6.9], debate: [6, 6, 6], tournament: [5, 5, 5] }));
    expect(weak.broken_task_warning).toBe(false);
  });

  test('missing records mark the run partial and list the jobs', () => {
    const result = aggregateRun(manifest, recordsFor(manifest, { direct: [7, 7, 7], refine: [8, 8] }));
    expect(result.partial).toBe(true);
    expect(result.missing_jobs.length).toBe(12 - 5);
    expect(result.strategies.find(s => s.name === 'refine').trials).toBe(2);
  });

  test('low-confidence advisory when the pick has σ ≥ 1.0 at ≤ 3 trials', () => {
    const solo = buildManifest({ cases: [caseA], strategies: ['refine'], includeDirect: false, trials: 3 });
    const result = aggregateRun(solo, recordsFor(solo, { refine: [7.1, 9.5, 7.0] }));
    expect(result.recommendation.final).toBe('refine');
    expect(result.advisories.some(a => a.startsWith('low-confidence'))).toBe(true);
  });
});

describe('regression gate', () => {
  const manifest = buildManifest({ cases: [caseA], strategies: ['refine'], trials: 3, runId: 'bench-20260826T000000Z-0002' });
  const baseline = aggregateRun(manifest, recordsFor(manifest, { direct: [7, 7, 7], refine: [8.5, 8.4, 8.6] }));

  test('passes when nothing regressed and reports improvements', () => {
    const current = aggregateRun(manifest, recordsFor(manifest, { direct: [7, 7, 7], refine: [8.9, 8.8, 9.0] }));
    const report = compareBench(current, baseline);
    expect(report.passed).toBe(true);
    expect(report.arms.find(a => a.arm === 'refine').status).toBe('improved');
  });

  test('blocks on lost pass^k and on an average drop past the threshold', () => {
    const current = aggregateRun(manifest, recordsFor(manifest, { direct: [7, 7, 7], refine: [8.0, 7.9, 6.5] }));
    const report = compareBench(current, baseline, { maxAvgDrop: 0.5 });
    expect(report.passed).toBe(false);
    expect(report.blockers.map(b => b.code).sort()).toEqual(['avg_drop_over_threshold', 'pass_hat_k_lost']);
  });

  test('blocks when a baseline arm is missing or the current run is partial / broken', () => {
    const narrow = buildManifest({ cases: [caseA], strategies: ['debate'], trials: 2, runId: 'bench-20260826T000000Z-0003' });
    const current = aggregateRun(narrow, recordsFor(narrow, { direct: [7, 7], debate: [8] }));
    const report = compareBench(current, baseline);
    expect(report.passed).toBe(false);
    expect(report.blockers.map(b => b.code)).toContain('arm_missing');
    expect(report.blockers.map(b => b.code)).toContain('insufficient_records');
    expect(report.arms.find(a => a.arm === 'debate').status).toBe('new');
  });

  test('blocks comparisons with different case sets, rubrics, thresholds, or trials', () => {
    const complete = aggregateRun(manifest, recordsFor(manifest, { direct: [7, 7, 7], refine: [8.5, 8.4, 8.6] }));
    const mutateCase = patch => ({ ...complete, cases: complete.cases.map((item, index) => index === 0 ? { ...item, ...patch } : item) });
    expect(compareBench({ ...complete, cases: [] }, baseline).blockers.map(b => b.code)).toContain('case_set_mismatch');
    expect(compareBench(mutateCase({ rubric: 'security-audit' }), baseline).blockers.map(b => b.code)).toContain('rubric_mismatch');
    expect(compareBench(mutateCase({ pass_threshold: 8 }), baseline).blockers.map(b => b.code)).toContain('pass_threshold_mismatch');
    expect(compareBench(mutateCase({ trials: 5 }), baseline).blockers.map(b => b.code)).toContain('trial_count_mismatch');
  });
});
