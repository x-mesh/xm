import { describe, test, expect } from 'bun:test';
import { buildManifest, aggregateRun, validateRecord, validateManifest, parseStrategies, jobIdFor, CONTROL_ARM, MIN_DELTA_VS_DIRECT, MAX_TRIALS, formatBenchReport, validatePersistedBench } from '../x-eval/lib/x-eval/bench.mjs';
import { compareBench } from '../x-eval/lib/x-eval/gate.mjs';
import { mean, sigma, median, round } from '../x-eval/lib/x-eval/stats.mjs';
import { buildCase, caseId, passThresholdFor, DEFAULT_TRIALS, MAX_CUSTOM_RUBRIC_BYTES, validateCase } from '../x-eval/lib/x-eval/cases.mjs';

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
    expect(MAX_CUSTOM_RUBRIC_BYTES).toBe(64 * 1024);
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

  test('stored task cases revalidate every identity and execution field', () => {
    const bad = [
      { v: 2 }, { type: 'other' }, { id: 'case-000000000000000000000000' },
      { prompt: 42 }, { rubric: '../bad' }, { risk: 'extreme' }, { tags: 'op' },
      { assertions: 'none' }, { expected: [] }, { expected: { min_overall: '8' } },
    ];
    for (const patch of bad) expect(() => validateCase({ ...caseA, ...patch }, caseA.id)).toThrow();
    expect(() => validateCase({ ...caseA, extra: true }, caseA.id)).toThrow(/unsupported field/);
    expect(() => validateCase({ ...caseA, source: { plugin: 'manual', ref: null, nested: {} } }, caseA.id)).toThrow(/source.*unsupported/);
    expect(() => validateCase({ ...caseA, created_at: 'yesterday' }, caseA.id)).toThrow(/timestamp/);
  });

  test('case construction bounds merged executable and judge assertions by count and serialized bytes', () => {
    const judges = Array.from({ length: 128 }, (_, index) => ({ kind: 'judge', text: `${index}: ${'x'.repeat(1_990)}` }));
    expect(() => buildCase({ prompt: 'oversized assertions', assertions: judges })).toThrow(/exceeds 262144 bytes/);
    expect(() => buildCase({ prompt: 'too many assertions', assertions: [...judges.slice(0, 128), { kind: 'file', name: 'src', spec: 'exists=src' }] })).toThrow(/at most 128/);
    const executable = Array.from({ length: 65 }, (_, index) => ({ kind: 'file', name: `f${index}`, spec: 'exists=src' }));
    expect(() => buildCase({ prompt: 'too many executable assertions', assertions: executable })).toThrow(/64 executable assertions/);
    let axes = {};
    for (let i = 0; i < 40; i++) axes = { child: axes };
    const replay = {
      v: 1, type: 'replay', id: 'replay-000000000000000000000000', replay_of: { trace_id: 't', span_id: 's' }, rubric: 'general',
      artifact: { manifest_sha256: 'a'.repeat(64) }, axes, status: 'awaiting_result', created_at: '2026-08-26T00:00:00.000Z',
    };
    expect(() => validateCase(replay, replay.id)).toThrow(/maximum depth/);
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
    expect(jobIdFor('case-aaaaaaaa0000000000000000', 'refine', 1)).not.toBe(jobIdFor('case-aaaaaaaa1111111111111111', 'refine', 1));
    const noDirect = buildManifest({ cases: [caseA], strategies: ['refine'], includeDirect: false, trials: 2 });
    expect(noDirect.arms).toEqual(['refine']);
    expect(noDirect.control).toBeNull();
    expect(noDirect.jobs.length).toBe(2);
    expect(() => buildManifest({ cases: [caseA], strategies: [] })).toThrow(/at least one strategy/);
    expect(() => buildManifest({ cases: [caseA], strategies: ['refine'], trials: MAX_TRIALS + 1 })).toThrow(/between 1 and/);
    const manyStrategies = Array.from({ length: 100 }, (_, index) => `s${index}`);
    expect(() => buildManifest({ cases: [caseA, caseHigh], strategies: manyStrategies, trials: 100 })).toThrow(/10000 total jobs/);
    const duplicateJob = structuredClone(manifest);
    duplicateJob.jobs[1] = { ...duplicateJob.jobs[0] };
    expect(() => validateManifest(duplicateJob, duplicateJob.run_id)).toThrow(/unique|invalid job/);
    const thresholdTamper = structuredClone(manifest);
    thresholdTamper.cases[0].pass_threshold = 0;
    expect(() => validateManifest(thresholdTamper, thresholdTamper.run_id)).toThrow(/metadata changed/);
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
    const hard = validateRecord({ overall: 9, assertion_results: [{ name: 'tests', kind: 'cmd', result: 'HARD_FAIL', source: 'executable' }] }, { passThreshold: 7 });
    expect(hard.passed).toBe(false);
    expect(hard.assertion_hard_fail).toBe(true);
    const timedOut = validateRecord({ overall: 9, assertion_results: [{ name: 'tests', kind: 'cmd', result: 'HARD_FAIL', source: 'executable', error_code: 'ETIMEDOUT' }] }, { passThreshold: 7 });
    expect(timedOut.assertion_results[0].error_code).toBe('ETIMEDOUT');
    expect(() => validateRecord({ overall: 8, output: 'leak' }, { passThreshold: 7 })).toThrow(/output text/);
    expect(() => validateRecord({ overall: 11 }, { passThreshold: 7 })).toThrow(/overall/);
    expect(() => validateRecord({ overall: '8' }, { passThreshold: 7 })).toThrow(/overall/);
    expect(() => validateRecord({ overall: 8, output_sha256: 'zz' }, { passThreshold: 7 })).toThrow(/sha256/);
    expect(() => validateRecord({ overall: 8, cost_usd_est: -1 }, { passThreshold: 7 })).toThrow(/cost/);
    expect(() => validateRecord({ overall: 8, passed: 'yes' }, { passThreshold: 7 })).toThrow(/boolean/);
    expect(() => validateRecord({ overall: 8, per_criterion: { 'bad name': 8 } }, { passThreshold: 7 })).toThrow(/identifier/);
    expect(() => validateRecord({ overall: 8, per_criterion: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`c${i}`, 8])) }, { passThreshold: 7 })).toThrow(/at most 64/);
    expect(() => validateRecord({ overall: 8, judges: Array.from({ length: 17 }, (_, i) => `j${i}`) }, { passThreshold: 7 })).toThrow(/1-16/);
    expect(() => validateRecord({ overall: 8, judges: ['good', 'bad judge'] }, { passThreshold: 7 })).toThrow(/identifier/);
    expect(() => validateRecord({ overall: 8, note: 'not in schema' }, { passThreshold: 7 })).toThrow(/unsupported field/);
    expect(() => validateRecord({ overall: 8, assertion_results: [{ assertion: 'safe', result: 'PASS', source: 'judge', output: 'leak' }] }, { passThreshold: 7 })).toThrow(/unsupported field/);
    expect(() => validateRecord({ overall: 8, assertion_results: [{ assertion: 'safe', result: 'PASS', source: 'judge', error_code: 'ETIMEDOUT' }] }, { passThreshold: 7 })).toThrow(/fields that do not match/);
  });
});

describe('bench aggregation (subcommands/bench.md rules)', () => {
  const manifest = buildManifest({ cases: [caseA], strategies: ['refine', 'debate', 'tournament'], trials: 3, runId: 'bench-20260826T000000Z-0001' });

  test('pass@k / pass^k / σ and the σ-aware recommendation', () => {
    const records = recordsFor(manifest, { direct: [7.0, 7.1, 7.2], refine: [8.2, 8.0, 8.4], debate: [8.2, 7.9, 5.4], tournament: [8.5, 8.7, 8.3] }, { cost: { direct: 0.05, refine: 0.12, debate: 0.08, tournament: 0.15 } });
    const result = aggregateRun(manifest, records);
    const byName = Object.fromEntries(result.strategies.map(s => [s.name, s]));
    expect(byName.refine).toMatchObject({ trials: 3, pass_at_k: 3, pass_hat_k: 1, pass_at_k_rate: 1, per_trial_passed: [true, true, true] });
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

  test('a below-delta reliable candidate is skipped before considering later reliable strategies', () => {
    const records = recordsFor(manifest, {
      direct: [8.0, 7.6, 8.4],
      refine: [8.4, 8.2, 8.3],
      debate: [9.0, 9.1, 8.9],
      tournament: [6, 6, 6],
    });
    const result = aggregateRun(manifest, records);
    expect(result.strategies.find(s => s.name === 'refine').delta_vs_direct).toBe(0.3);
    expect(result.recommendation.final).toBe('debate');
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
    expect(result.strategies.find(s => s.name === 'refine').pass_hat_k).toBeNull();
    expect(result.recommendation).toMatchObject({ best_quality: null, best_value: null, final: null, best_effort: null });
    expect(result.recommendation.reason).toContain('withheld');
    expect(formatBenchReport(result)).toContain('|      — |');
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

  test('blocks partial and broken baselines', () => {
    const current = aggregateRun(manifest, recordsFor(manifest, { direct: [7, 7, 7], refine: [8.5, 8.4, 8.6] }));
    const partial = aggregateRun(manifest, recordsFor(manifest, { direct: [7], refine: [8.5] }));
    expect(compareBench(current, partial).blockers.map(item => item.code)).toContain('baseline_insufficient_records');
    const broken = aggregateRun(manifest, recordsFor(manifest, { direct: [3, 3, 3], refine: [3, 3, 3] }));
    expect(compareBench(current, broken).blockers.map(item => item.code)).toContain('baseline_broken_task');
  });

  test('persisted bench validation rejects schema, identity, duplicate, finite-range, and pass-count corruption', () => {
    const result = aggregateRun(manifest, recordsFor(manifest, { direct: [7, 7, 7], refine: [8.5, 8.4, 8.6] }), { now: '2026-08-26T00:00:00.000Z' });
    const stored = { ...result, artifact_path: '/tmp/bench.json' };
    expect(validatePersistedBench(stored)).toBe(stored);
    for (const mutated of [
      { ...structuredClone(stored), schema_v: 2 },
      { ...structuredClone(stored), run_id: '../bad' },
      { ...structuredClone(stored), cases: [stored.cases[0], stored.cases[0]] },
      { ...structuredClone(stored), strategies: [stored.strategies[0], stored.strategies[0]] },
      { ...structuredClone(stored), strategies: stored.strategies.map((arm, index) => index ? arm : { ...arm, avg_score: Infinity }) },
      { ...structuredClone(stored), strategies: stored.strategies.map((arm, index) => index ? arm : { ...arm, pass_at_k: 0 }) },
    ]) expect(() => validatePersistedBench(mutated)).toThrow();

    const forgedPass = structuredClone(stored);
    const perCaseRefine = forgedPass.per_case[0].arms.find(arm => arm.name === 'refine');
    perCaseRefine.per_trial_overall = [6, 6, 6];
    perCaseRefine.avg_score = 6;
    perCaseRefine.sigma = 0;
    perCaseRefine.score_per_dollar = 60;
    expect(() => validatePersistedBench(forgedPass)).toThrow(/passing trial below its case threshold/);

    const forgedTop = structuredClone(stored);
    const topRefine = forgedTop.strategies.find(arm => arm.name === 'refine');
    topRefine.per_trial_overall.reverse();
    expect(() => validatePersistedBench(forgedTop)).toThrow(/aggregates do not match per_case/);

    const forgedHardFails = structuredClone(stored);
    forgedHardFails.strategies.find(arm => arm.name === 'refine').assertion_hard_fails = 1;
    expect(() => validatePersistedBench(forgedHardFails)).toThrow(/aggregates do not match per_case/);
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
