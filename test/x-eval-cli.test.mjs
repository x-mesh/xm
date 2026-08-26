import { describe, test, expect } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'x-eval', 'lib', 'x-eval-cli.mjs');

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), 'xe-cli-'));
  mkdirSync(join(dir, '.xm'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  return dir;
}

function cli(dir, args) {
  const r = spawnSync('node', [CLI, ...args], {
    cwd: dir,
    env: { ...process.env, XM_ROOT: join(dir, '.xm') },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status ?? 1 };
}

function cliAsync(dir, args) {
  return new Promise(resolveResult => {
    const child = spawn('node', [CLI, ...args], { cwd: dir, env: { ...process.env, XM_ROOT: join(dir, '.xm') }, encoding: 'utf8' });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolveResult({ stdout, stderr, code }));
  });
}

function json(result) {
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function addCases(dir) {
  const a = json(cli(dir, ['case', 'add', '--prompt', 'Rename foo to bar in src/a.mjs', '--rubric', 'general', '--tag', 'smoke',
    '--assert-file', 'src=exists=src/a.mjs', '--assert', 'keeps the export', '--json']));
  const b = json(cli(dir, ['case', 'add', '--prompt', 'Harden the regex matcher', '--rubric', 'code-quality', '--tag', 'smoke', '--risk', 'high',
    '--assert-cmd', 'exit0=node -e process.exit(0)', '--min-overall', '8', '--json']));
  return { a, b };
}

function planRun(dir, args = []) {
  return json(cli(dir, ['bench', 'plan', '--set', 'smoke', '--strategies', 'refine,debate', '--json', ...args]));
}

/** Record every job with a score chosen per arm (optionally per-trial override). */
function recordAll(dir, plan, scoreFor) {
  let i = 0;
  for (const job of plan.job_ids) {
    const [, arm, trial] = job.split('.');
    const overall = scoreFor(arm, Number(trial.slice(1)), job);
    const file = join(dir, `score-${i++}.json`);
    writeFileSync(file, JSON.stringify({ overall, judges: 3, cost_usd_est: 0.1, duration_ms: 1200 }));
    const r = cli(dir, ['bench', 'record', '--run', plan.run_id, '--job', job, '--score-file', file, '--run-assertions']);
    expect(r.code, r.stderr).toBe(0);
  }
}

describe('xm eval case', () => {
  test('add is idempotent, list shows tags/risk, show returns the payload', () => {
    const dir = makeProject();
    try {
      const { a, b } = addCases(dir);
      expect(a.created).toBe(true);
      expect(a.id).toMatch(/^case-[0-9a-f]{24}$/);
      expect(b.risk).toBe('high');
      const again = json(cli(dir, ['case', 'add', '--prompt', 'Rename foo to bar in src/a.mjs', '--rubric', 'general', '--tag', 'smoke',
        '--assert-file', 'src=exists=src/a.mjs', '--assert', 'keeps the export', '--json']));
      expect(again.created).toBe(false);
      expect(again.id).toBe(a.id);
      const list = json(cli(dir, ['case', 'list', '--json']));
      expect(list.cases.map(c => c.id).sort()).toEqual([a.id, b.id].sort());
      expect(list.cases.find(c => c.id === b.id)).toMatchObject({ risk: 'high', rubric: 'code-quality', assertions: 1 });
      expect(json(cli(dir, ['case', 'list', '--tag', 'smoke', '--json'])).cases.length).toBe(2);
      expect(json(cli(dir, ['case', 'list', '--tag', 'missing', '--json'])).cases.length).toBe(0);
      const shown = json(cli(dir, ['case', 'show', a.id]));
      expect(shown.assertions).toEqual([{ kind: 'file', name: 'src', spec: 'exists=src/a.mjs' }, { kind: 'judge', text: 'keeps the export' }]);
      const text = cli(dir, ['case', 'list']);
      expect(text.stdout).toContain('2 case(s)');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('replay cases from x-trace are listed but skipped by plan; symlinked cases are rejected', () => {
    const dir = makeProject();
    try {
      const { a } = addCases(dir);
      const casesDir = join(dir, '.xm', 'eval', 'cases');
      writeFileSync(join(casesDir, 'replay-000000000000000000000000.json'), JSON.stringify({
        v: 1, type: 'replay', id: 'replay-000000000000000000000000', replay_of: { trace_id: 'trace', span_id: 'span' }, rubric: 'general',
        artifact: { manifest_sha256: 'a'.repeat(64) }, axes: {}, status: 'awaiting_result', created_at: '2026-08-26T00:00:00.000Z',
      }));
      const list = json(cli(dir, ['case', 'list', '--json']));
      expect(list.cases.find(c => c.type === 'replay')).toMatchObject({ status: 'awaiting_result' });
      const plan = json(cli(dir, ['bench', 'plan', '--set', 'all', '--strategies', 'refine', '--json']));
      expect(plan.skipped.length).toBe(1);
      expect(plan.case_ids).toContain(a.id);
      symlinkSync(join(dir, 'src', 'a.mjs'), join(casesDir, 'case-ffffffffffffffffffffffff.json'));
      const relisted = json(cli(dir, ['case', 'list', '--json']));
      expect(relisted.invalid.some(i => /symlink/.test(i.reason))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('usage errors exit 2', () => {
    const dir = makeProject();
    try {
      expect(cli(dir, ['case', 'add']).code).toBe(2);
      expect(cli(dir, ['case', 'add', '--prompt', 'x', '--risk', 'extreme']).code).toBe(2);
      expect(cli(dir, ['case', 'show', 'nope']).code).toBe(2);
      expect(cli(dir, ['case', 'frob']).code).toBe(2);
      expect(cli(dir, ['case', 'list', '--wat', 'x']).code).toBe(2);
      expect(cli(dir, ['case', 'list', 'unused']).code).toBe(2);
      expect(cli(dir, ['bench', 'plan', '--set', 'smoke', '--strategies', 'refine']).code).toBe(2); // no cases yet
      addCases(dir);
      expect(cli(dir, ['bench', 'plan', '--set', 'smoke', '--strategies', 'refine', '--trials', '101']).code).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('prompt files and the cases directory reject symlinks, non-files, and oversized input', () => {
    const dir = makeProject();
    try {
      const prompt = join(dir, 'prompt.txt');
      writeFileSync(prompt, 'safe prompt');
      symlinkSync(prompt, join(dir, 'prompt-link.txt'));
      expect(cli(dir, ['case', 'add', '--prompt-file', 'prompt-link.txt']).stderr).toContain('regular non-symlink');
      mkdirSync(join(dir, 'prompt-dir'));
      expect(cli(dir, ['case', 'add', '--prompt-file', 'prompt-dir']).stderr).toContain('regular non-symlink');
      writeFileSync(join(dir, 'prompt-large.txt'), 'x'.repeat(64 * 1024 + 1));
      expect(cli(dir, ['case', 'add', '--prompt-file', 'prompt-large.txt']).stderr).toContain('exceeds 65536 bytes');
    } finally { rmSync(dir, { recursive: true, force: true }); }

    const linked = makeProject();
    try {
      mkdirSync(join(linked, '.xm', 'eval'), { recursive: true });
      symlinkSync(join(linked, 'src'), join(linked, '.xm', 'eval', 'cases'));
      const rejected = cli(linked, ['case', 'add', '--prompt', 'x']);
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain('cases path must be a regular directory');
    } finally { rmSync(linked, { recursive: true, force: true }); }
  });

  test('case id collisions with different payloads are rejected', () => {
    const dir = makeProject();
    try {
      const first = json(cli(dir, ['case', 'add', '--prompt', 'same identity', '--rubric', 'general', '--tag', 'x', '--json']));
      const conflict = cli(dir, ['case', 'add', '--prompt', 'same identity', '--rubric', 'general', '--tag', 'x', '--risk', 'high']);
      expect(conflict.code).toBe(2);
      expect(conflict.stderr).toContain('payload differs');
      expect(first.created).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('bench resolves built-in and custom rubric pass thresholds', () => {
    const dir = makeProject();
    try {
      mkdirSync(join(dir, '.xm', 'eval', 'rubrics'), { recursive: true });
      writeFileSync(join(dir, '.xm', 'eval', 'rubrics', 'strict-code.json'), JSON.stringify({ name: 'strict-code', pass_threshold: 7.5 }));
      const secure = json(cli(dir, ['case', 'add', '--prompt', 'audit auth', '--rubric', 'security-audit', '--tag', 'thresholds', '--json']));
      const custom = json(cli(dir, ['case', 'add', '--prompt', 'review strict code', '--rubric', 'strict-code', '--tag', 'thresholds', '--json']));
      const plan = json(cli(dir, ['bench', 'plan', '--set', 'thresholds', '--strategies', 'refine', '--trials', '1', '--json']));
      const manifest = JSON.parse(readFileSync(plan.manifest, 'utf8'));
      expect(manifest.cases.find(c => c.id === secure.id).pass_threshold).toBe(8);
      expect(manifest.cases.find(c => c.id === custom.id).pass_threshold).toBe(7.5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('xm eval bench plan → record → finish', () => {
  test('plans direct + strategies with risk-based trials and records metrics only', () => {
    const dir = makeProject();
    try {
      const { a, b } = addCases(dir);
      const plan = planRun(dir);
      expect(plan.arms).toEqual(['direct', 'refine', 'debate']);
      expect(plan.control).toBe('direct');
      // caseA normal → 3 trials, caseB high → 5 trials, × 3 arms
      expect(plan.jobs).toBe(3 * 3 + 3 * 5);
      expect(existsSync(plan.manifest)).toBe(true);

      // first direct trial of case A (file assertion only → a single executable row)
      const job = plan.job_ids.find(id => id.startsWith(`${a.id}.direct.`));
      const scoreFile = join(dir, 'score.json');
      writeFileSync(scoreFile, JSON.stringify({ overall: 8.2, pad: 'x'.repeat(70_000) }));
      const oversized = cli(dir, ['bench', 'record', '--run', plan.run_id, '--job', job, '--score-file', scoreFile]);
      expect(oversized.code).toBe(2);
      expect(oversized.stderr).toContain('exceeds 65536 bytes');
      writeFileSync(scoreFile, JSON.stringify({ overall: 8.2, output: 'raw model text' }));
      const leak = cli(dir, ['bench', 'record', '--run', plan.run_id, '--job', job, '--score-file', scoreFile]);
      expect(leak.code).toBe(2);
      expect(leak.stderr).toContain('must not contain output text');
      expect(readdirSync(join(dir, '.xm', 'eval', 'runs', plan.run_id, 'records')).length).toBe(0);

      writeFileSync(scoreFile, JSON.stringify({ overall: 8.2, judges: 3, cost_usd_est: 0.12, duration_ms: 900 }));
      const first = json(cli(dir, ['bench', 'record', '--run', plan.run_id, '--job', job, '--score-file', scoreFile, '--run-assertions', '--json']));
      expect(first).toMatchObject({ job_id: job, arm: 'direct', overall: 8.2, passed: true, cost_source: 'estimated' });
      expect(first.assertion_results).toEqual([{ name: 'src', kind: 'file', result: 'PASS', source: 'executable' }]);
      expect(readFileSync(first.path, 'utf8')).not.toContain('raw model text');

      const dup = cli(dir, ['bench', 'record', '--run', plan.run_id, '--job', job, '--score-file', scoreFile]);
      expect(dup.code).toBe(2);
      expect(dup.stderr).toContain('already exists');

      const status = json(cli(dir, ['bench', 'status', '--run', plan.run_id, '--json']));
      expect(status.recorded).toBe(1);
      expect(status.pending.length).toBe(plan.jobs - 1);

      const partial = cli(dir, ['bench', 'finish', '--run', plan.run_id]);
      expect(partial.code).toBe(2);
      expect(partial.stderr).toContain('--allow-partial');

      const forced = json(cli(dir, ['bench', 'finish', '--run', plan.run_id, '--allow-partial', '--json']));
      expect(forced.partial).toBe(true);
      expect(forced.missing_jobs.length).toBe(plan.jobs - 1);
      expect(forced.strategies.find(s => s.name === 'direct').trials).toBe(1);
      expect(existsSync(forced.path)).toBe(true);
      expect(forced.path).toContain(`${plan.run_id}-bench.json`);
      expect(cli(dir, ['bench', 'finish', '--run', plan.run_id, '--allow-partial']).code).toBe(2);
      expect(b.id).toBeTruthy();
      expect(a.id).toBeTruthy();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('full run: finish reproduces the bench.md table and the direct-control rule', () => {
    const dir = makeProject();
    try {
      addCases(dir);
      const plan = planRun(dir, ['--trials', '3']);
      expect(plan.jobs).toBe(2 * 3 * 3);
      recordAll(dir, plan, (arm) => ({ direct: 8.0, refine: 8.3, debate: 6.0 })[arm]);
      const text = cli(dir, ['bench', 'finish', '--run', plan.run_id]);
      expect(text.code, text.stderr).toBe(0);
      expect(text.stdout).toContain('Δ direct');
      expect(text.stdout).toContain('Recommendation: direct');
      expect(text.stdout).toContain('cost_source: estimated');
      const benchFiles = readdirSync(join(dir, '.xm', 'eval', 'benchmarks')).filter(f => f.endsWith('-bench.json'));
      expect(benchFiles.length).toBe(1);
      const result = JSON.parse(readFileSync(join(dir, '.xm', 'eval', 'benchmarks', benchFiles[0]), 'utf8'));
      expect(result.strategies.find(s => s.name === 'refine').delta_vs_direct).toBe(0.3);
      expect(result.recommendation.final).toBe('direct');
      // debate fails the code-quality case (min_overall 8) and the general case (7)
      expect(result.strategies.find(s => s.name === 'debate').pass_hat_k).toBe(0);
      const manifest = JSON.parse(readFileSync(plan.manifest, 'utf8'));
      expect(manifest.status).toBe('finished');
      expect(manifest.result_path).toBe(join(dir, '.xm', 'eval', 'benchmarks', benchFiles[0]));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('record and finish fail closed when a planned case changes or disappears', () => {
    const dir = makeProject();
    try {
      const { a } = addCases(dir);
      const changed = planRun(dir, ['--trials', '1']);
      const casePath = join(dir, '.xm', 'eval', 'cases', `${a.id}.json`);
      const payload = JSON.parse(readFileSync(casePath, 'utf8'));
      writeFileSync(casePath, JSON.stringify({ ...payload, risk: 'high' }));
      const score = join(dir, 'drift-score.json');
      writeFileSync(score, JSON.stringify({ overall: 8 }));
      const job = changed.job_ids.find(id => id.startsWith(a.id));
      const drift = cli(dir, ['bench', 'record', '--run', changed.run_id, '--job', job, '--score-file', score]);
      expect(drift.code).toBe(2);
      expect(drift.stderr).toContain('changed after bench plan');

      rmSync(dir, { recursive: true, force: true });
      const fresh = makeProject();
      try {
        const { a: freshA } = addCases(fresh);
        const planned = planRun(fresh, ['--trials', '1']);
        recordAll(fresh, planned, () => 8);
        rmSync(join(fresh, '.xm', 'eval', 'cases', `${freshA.id}.json`));
        const missing = cli(fresh, ['bench', 'finish', '--run', planned.run_id]);
        expect(missing.code).toBe(2);
        expect(missing.stderr).toContain('deleted after bench plan');
      } finally { rmSync(fresh, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('finish rejects record filename, identity, and derived-score tampering', () => {
    const dir = makeProject();
    try {
      addCases(dir);
      const plan = planRun(dir, ['--trials', '1']);
      const score = join(dir, 'score.json');
      writeFileSync(score, JSON.stringify({ overall: 8, judges: 3 }));
      const first = json(cli(dir, ['bench', 'record', '--run', plan.run_id, '--job', plan.job_ids[0], '--score-file', score, '--json']));
      const payload = JSON.parse(readFileSync(first.path, 'utf8'));
      const recordsDir = join(dir, '.xm', 'eval', 'runs', plan.run_id, 'records');

      const rogue = join(recordsDir, 'rogue.json');
      writeFileSync(rogue, JSON.stringify(payload));
      let rejected = cli(dir, ['bench', 'finish', '--run', plan.run_id, '--allow-partial']);
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain('invalid record');
      rmSync(rogue);

      writeFileSync(first.path, JSON.stringify({ ...payload, case_id: plan.case_ids[1] }));
      rejected = cli(dir, ['bench', 'finish', '--run', plan.run_id, '--allow-partial']);
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain('invalid record');

      writeFileSync(first.path, JSON.stringify({ ...payload, assertion_results: [{ assertion: 'safe', result: 'PASS', source: 'judge', output: 'leak' }] }));
      rejected = cli(dir, ['bench', 'finish', '--run', plan.run_id, '--allow-partial']);
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain('invalid record');

      writeFileSync(first.path, JSON.stringify({ ...payload, overall: 1, passed: true }));
      rejected = cli(dir, ['bench', 'finish', '--run', plan.run_id, '--allow-partial']);
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain('invalid record');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('finish recovers an identical orphaned result and rejects different bytes', () => {
    const dir = makeProject();
    try {
      addCases(dir);
      const recovered = planRun(dir, ['--trials', '1']);
      recordAll(dir, recovered, () => 8);
      const first = json(cli(dir, ['bench', 'finish', '--run', recovered.run_id, '--json']));
      const originalBytes = readFileSync(first.path, 'utf8');
      const manifestPath = recovered.manifest;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      delete manifest.finished_at;
      delete manifest.result_path;
      manifest.status = 'open';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

      const retried = json(cli(dir, ['bench', 'finish', '--run', recovered.run_id, '--json']));
      expect(readFileSync(first.path, 'utf8')).toBe(originalBytes);
      const finalized = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(finalized).toMatchObject({ status: 'finished', finished_at: retried.timestamp, result_path: first.path });

      const rejected = planRun(dir, ['--trials', '1']);
      recordAll(dir, rejected, () => 8);
      const second = json(cli(dir, ['bench', 'finish', '--run', rejected.run_id, '--json']));
      const secondManifest = JSON.parse(readFileSync(rejected.manifest, 'utf8'));
      delete secondManifest.finished_at;
      delete secondManifest.result_path;
      secondManifest.status = 'open';
      writeFileSync(rejected.manifest, JSON.stringify(secondManifest, null, 2) + '\n');
      writeFileSync(second.path, readFileSync(second.path, 'utf8') + ' ');

      const mismatch = cli(dir, ['bench', 'finish', '--run', rejected.run_id]);
      expect(mismatch.code).toBe(2);
      expect(mismatch.stderr).toContain('bytes do not match');
      expect(JSON.parse(readFileSync(rejected.manifest, 'utf8')).status).toBe('open');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('xm eval gate', () => {
  test('finish --baseline latest and gate: pass on parity, exit 3 on regression, provenance recorded', () => {
    const dir = makeProject();
    try {
      addCases(dir);
      const baseline = planRun(dir, ['--trials', '2']);
      recordAll(dir, baseline, (arm) => ({ direct: 7.5, refine: 8.6, debate: 8.2 })[arm]);
      expect(cli(dir, ['bench', 'finish', '--run', baseline.run_id]).code).toBe(0);
      // no earlier result → latest resolution from the baseline run itself is refused
      expect(cli(dir, ['gate', '--run', baseline.run_id, '--baseline', 'latest']).code).toBe(2);
      const baselineManifest = JSON.parse(readFileSync(baseline.manifest, 'utf8'));
      expect(cli(dir, ['gate', '--current', baselineManifest.result_path, '--baseline', 'latest']).code).toBe(2);

      const parity = planRun(dir, ['--trials', '2']);
      recordAll(dir, parity, (arm) => ({ direct: 7.6, refine: 8.7, debate: 8.1 })[arm]);
      const ok = cli(dir, ['bench', 'finish', '--run', parity.run_id, '--baseline', 'latest', '--json']);
      expect(ok.code, ok.stderr).toBe(0);
      const combined = JSON.parse(ok.stdout);
      expect(combined.gate.passed).toBe(true);
      const gates = readdirSync(join(dir, '.xm', 'eval', 'gates'));
      expect(gates.length).toBe(1);
      const gateDoc = JSON.parse(readFileSync(join(dir, '.xm', 'eval', 'gates', gates[0]), 'utf8'));
      expect(gateDoc.baseline.run_id).toBe(baseline.run_id);
      expect(gateDoc.current.sha256).toMatch(/^[0-9a-f]{64}$/);

      const regressed = planRun(dir, ['--trials', '2']);
      recordAll(dir, regressed, (arm, trial) => ({ direct: 7.5, refine: trial === 1 ? 8.0 : 6.4, debate: 8.2 })[arm]);
      expect(cli(dir, ['bench', 'finish', '--run', regressed.run_id]).code).toBe(0);
      const fail = cli(dir, ['gate', '--run', regressed.run_id, '--baseline', baseline.run_id, '--json']);
      expect(fail.code).toBe(3);
      const report = JSON.parse(fail.stdout);
      expect(report.passed).toBe(false);
      expect(report.blockers.map(b => b.code).sort()).toEqual(['avg_drop_over_threshold', 'pass_hat_k_lost']);
      expect(report.blockers.every(b => b.arm === 'refine')).toBe(true);

      // a looser threshold still blocks on the lost pass^k
      const loose = cli(dir, ['gate', '--run', regressed.run_id, '--baseline', baseline.run_id, '--max-avg-drop', '5', '--json']);
      expect(loose.code).toBe(3);
      expect(JSON.parse(loose.stdout).blockers.map(b => b.code)).toEqual(['pass_hat_k_lost']);

      expect(cli(dir, ['gate', '--run', regressed.run_id, '--baseline', baseline.run_id, '--max-avg-drop', '0']).code).toBe(3);
      for (const value of ['-0.1', 'Infinity', '1e309']) {
        const invalid = cli(dir, ['gate', '--run', regressed.run_id, '--baseline', baseline.run_id, '--max-avg-drop', value]);
        expect(invalid.code).toBe(2);
        expect(invalid.stderr).toContain('finite non-negative number');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('gate rejects corrupt and unsafe bench files before comparison', () => {
    const dir = makeProject();
    try {
      addCases(dir);
      const baseline = planRun(dir, ['--trials', '1']);
      recordAll(dir, baseline, () => 8);
      const baselineResult = json(cli(dir, ['bench', 'finish', '--run', baseline.run_id, '--json']));
      const current = planRun(dir, ['--trials', '1']);
      recordAll(dir, current, () => 8.2);
      const currentResult = json(cli(dir, ['bench', 'finish', '--run', current.run_id, '--json']));

      const corrupt = join(dir, 'corrupt-bench.json');
      const document = JSON.parse(readFileSync(baselineResult.path, 'utf8'));
      writeFileSync(corrupt, JSON.stringify({ ...document, schema_v: 2 }));
      expect(cli(dir, ['gate', '--current', currentResult.path, '--baseline', corrupt]).stderr).toContain('unsupported bench result schema');

      const linked = join(dir, 'linked-bench.json');
      symlinkSync(baselineResult.path, linked);
      expect(cli(dir, ['gate', '--current', currentResult.path, '--baseline', linked]).stderr).toContain('regular non-symlink');
      mkdirSync(join(dir, 'bench-dir'));
      expect(cli(dir, ['gate', '--current', currentResult.path, '--baseline', './bench-dir']).stderr).toContain('regular non-symlink');
      const oversized = join(dir, 'oversized-bench.json');
      writeFileSync(oversized, ' '.repeat(4 * 1024 * 1024 + 1));
      expect(cli(dir, ['gate', '--current', currentResult.path, '--baseline', oversized]).stderr).toContain('exceeds 4194304 bytes');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('latest uses finish timestamps with a deterministic tie and concurrent gates create distinct artifacts', async () => {
    const dir = makeProject();
    try {
      addCases(dir);
      const first = planRun(dir, ['--trials', '1']);
      recordAll(dir, first, () => 8);
      const firstResult = json(cli(dir, ['bench', 'finish', '--run', first.run_id, '--json']));
      const second = planRun(dir, ['--trials', '1']);
      recordAll(dir, second, () => 8.1);
      const secondResult = json(cli(dir, ['bench', 'finish', '--run', second.run_id, '--json']));
      const current = planRun(dir, ['--trials', '1']);
      recordAll(dir, current, () => 8.2);
      const currentResult = json(cli(dir, ['bench', 'finish', '--run', current.run_id, '--json']));

      const rewriteTimestamp = (path, timestamp) => {
        const document = JSON.parse(readFileSync(path, 'utf8'));
        writeFileSync(path, JSON.stringify({ ...document, timestamp }, null, 2) + '\n');
      };
      rewriteTimestamp(firstResult.path, '2026-08-27T00:00:00.000Z');
      rewriteTimestamp(secondResult.path, '2026-08-26T00:00:00.000Z');
      let latest = json(cli(dir, ['gate', '--current', currentResult.path, '--baseline', 'latest', '--json']));
      expect(latest.baseline.run_id).toBe(first.run_id);

      rewriteTimestamp(secondResult.path, '2026-08-27T00:00:00.000Z');
      const tied = [firstResult.path, secondResult.path].sort()[0];
      latest = json(cli(dir, ['gate', '--current', currentResult.path, '--baseline', 'latest', '--json']));
      expect(latest.baseline.path).toBe(tied);

      const before = new Set(readdirSync(join(dir, '.xm', 'eval', 'gates')));
      const [left, right] = await Promise.all([
        cliAsync(dir, ['gate', '--current', currentResult.path, '--baseline', firstResult.path, '--json']),
        cliAsync(dir, ['gate', '--current', currentResult.path, '--baseline', firstResult.path, '--json']),
      ]);
      expect(left.code, left.stderr).toBe(0);
      expect(right.code, right.stderr).toBe(0);
      const created = readdirSync(join(dir, '.xm', 'eval', 'gates')).filter(name => !before.has(name));
      expect(created.length).toBe(2);
      expect(new Set(created).size).toBe(2);
      for (const name of created) expect(name).toMatch(new RegExp(`${current.run_id}-${first.run_id}-[0-9a-f]{12}-[0-9a-f]{12}-[0-9a-f]{12}-gate\\.json$`));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
