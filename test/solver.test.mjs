import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'x-solver', 'lib', 'x-solver-cli.mjs');

function run(args, opts = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, XM_SOLVER_ROOT: undefined, ...opts.env },
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function parseLastJSON(stdout) {
  const line = stdout
    .trim()
    .split('\n')
    .reverse()
    .find((candidate) => candidate.trim().startsWith('{'));
  return JSON.parse(line);
}

function setupProblem(tmp, description = 'simple question') {
  const result = run(['init', description], { cwd: tmp });
  expect(result.exitCode).toBe(0);
  return parseLastJSON(result.stdout).problem;
}

function writeSolverConfig(tmp, config) {
  const dir = join(tmp, '.xm', 'solver');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

function writeStrategyState(tmp, problem, state) {
  const statePath = join(
    tmp,
    '.xm',
    'solver',
    'problems',
    problem,
    'phases',
    '03-solve',
    'strategy-state.json'
  );
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

describe('x-solver CLI contracts', () => {
  test('direct classification does not require strategy set direct', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-test-'));
    try {
      setupProblem(tmp, 'hi');
      const classified = run(['classify'], { cwd: tmp });
      expect(classified.exitCode).toBe(0);
      const classification = parseLastJSON(classified.stdout);
      expect(classification.recommended_strategy).toBe('direct');
      expect(classified.stdout).toContain('Direct path');
      expect(classified.stdout).not.toContain('strategy set direct');

      const next = run(['next'], { cwd: tmp });
      expect(parseLastJSON(next.stdout).recommendation).toBe('direct');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('strategy set rejects direct because it is not a solve strategy', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-test-'));
    try {
      setupProblem(tmp, 'hi');
      const result = run(['strategy', 'set', 'direct'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('decompose|iterate|constrain');
      expect(result.stderr).not.toContain('pipeline');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('solve JSON exposes local solving.parallel_agents as agent_count', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-test-'));
    try {
      writeSolverConfig(tmp, { solving: { parallel_agents: 7 } });
      setupProblem(tmp, 'choose between cache options');
      const strategy = run(['strategy', 'set', 'constrain'], { cwd: tmp });
      expect(strategy.exitCode).toBe(0);

      const solve = run(['solve'], { cwd: tmp });
      expect(solve.exitCode).toBe(0);
      expect(parseLastJSON(solve.stdout).agent_count).toBe(7);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('solve-advance rejects invalid phases and skipped transitions', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-test-'));
    try {
      setupProblem(tmp, 'debug an intermittent timeout in the API');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });

      const invalid = run(['solve-advance', '--phase', 'banana'], { cwd: tmp });
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain('Unknown solve phase');

      const skipped = run(['solve-advance', '--phase', 'test'], { cwd: tmp });
      expect(skipped.exitCode).toBe(1);
      expect(skipped.stderr).toContain('Invalid phase transition');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('solve-advance allows iterate refine to retry hypothesize', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-test-'));
    try {
      const problem = setupProblem(tmp, 'debug an intermittent timeout in the API');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      writeStrategyState(tmp, problem, {
        strategy: 'iterate',
        current_phase: 'refine',
        phases_completed: ['diagnose', 'hypothesize', 'test'],
        current_iteration: 0,
        max_iterations: 3,
      });

      const result = run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp });
      expect(result.exitCode).toBe(0);
      const state = JSON.parse(
        readFileSync(
          join(
            tmp,
            '.xm',
            'solver',
            'problems',
            problem,
            'phases',
            '03-solve',
            'strategy-state.json'
          ),
          'utf8'
        )
      );
      expect(state.current_phase).toBe('hypothesize');
      expect(state.current_iteration).toBe(1);
      expect(state.phases_completed).toEqual(['diagnose']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The gate used to pass anything it had not actually checked: an unscored hard
// constraint judged `null`, and `null !== false` counted as a pass; an empty hard
// list made `[].every()` true. Both reported PASSED with zero evidence, contradicting
// the skill's own rule that "solved" is confirmed by execution only.
describe('x-solver verify gate', () => {
  function seedCandidate(tmp, problem) {
    expect(run(['candidates', 'add', 'a fix', '--source', 'executor'], { cwd: tmp }).exitCode).toBe(0);
    expect(run(['candidates', 'select', 'cand-1'], { cwd: tmp }).exitCode).toBe(0);
    return problem;
  }

  function verifyJSON(tmp) {
    const result = run(['verify'], { cwd: tmp });
    return { ...result, json: parseLastJSON(result.stdout) };
  }

  test('an unscored hard constraint is unverified, not passed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'unscored hard constraint');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });

      const { json, exitCode } = verifyJSON(tmp);
      expect(json.status).toBe('unverified');
      expect(json.reason).toBe('unscored_hard_constraints');
      expect(json.passed).toBe(false);
      expect(json.summary.hard_unverified).toBe(1);
      expect(exitCode).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no hard constraint at all is unverified, not a vacuous pass', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'no constraints');
      seedCandidate(tmp, problem);

      const { json, exitCode } = verifyJSON(tmp);
      expect(json.status).toBe('unverified');
      expect(json.reason).toBe('no_hard_constraints');
      expect(json.summary.hard_total).toBe(0);
      expect(exitCode).toBe(2);
      // The dead end must name its two exits, or the caller is just stuck.
      expect(json.passed).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a soft constraint alone does not satisfy the hard gate', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'soft only');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'should be tidy', '--type', 'soft'], { cwd: tmp });
      run(['candidates', 'score', 'cand-1', '--constraint', 'c1', '--score', '9'], { cwd: tmp });

      const { json } = verifyJSON(tmp);
      expect(json.status).toBe('unverified');
      expect(json.summary.hard_total).toBe(0);
      expect(json.summary.soft_scored).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('every hard constraint scored above zero passes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'all scored');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      run(['candidates', 'score', 'cand-1', '--constraint', 'c1', '--score', '8'], { cwd: tmp });

      const { json, exitCode } = verifyJSON(tmp);
      expect(json.status).toBe('passed');
      expect(json.passed).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The case that proves three values are real: with two values, a measured failure
  // and an unchecked constraint collapse to the same verdict.
  test('a measured failure is failed, distinct from unverified', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'one failed one unscored');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      run(['constraints', 'add', 'must be fast', '--type', 'hard'], { cwd: tmp });
      run(['candidates', 'score', 'cand-1', '--constraint', 'c1', '--score', '0'], { cwd: tmp });

      const { json, exitCode } = verifyJSON(tmp);
      expect(json.status).toBe('failed');
      expect(json.reason).toBe('hard_constraint_failed');
      expect(json.summary.hard_failed).toBe(1);
      expect(json.summary.hard_unverified).toBe(1);
      expect(exitCode).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--manual without evidence is refused and writes nothing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'manual no evidence');
      seedCandidate(tmp, problem);

      const result = run(['verify', '--manual', 'it works'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--evidence');
      const artifact = join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '04-verify', 'verification.json');
      expect(() => readFileSync(artifact, 'utf8')).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--evidence repeating the claim is refused', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'restated evidence');
      seedCandidate(tmp, problem);

      const result = run(['verify', '--manual', 'it works', '--evidence', 'it works'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Restating');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a valid attestation passes and keeps the constraint check it overlays', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'valid attestation');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'code stays maintainable', '--type', 'hard'], { cwd: tmp });

      const result = run(
        ['verify', '--manual', 'reviewed by hand', '--evidence', 'bun test -> 12 pass, 0 fail'],
        { cwd: tmp },
      );
      const json = parseLastJSON(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(json.status).toBe('passed');
      expect(json.method).toBe('manual');
      expect(json.attested_by).toBe('human');
      expect(json.manual.evidence).toContain('12 pass');
      // The old manual path overwrote the file with four fields, erasing every trace
      // of which constraints were never checked.
      expect(json.constraint_check).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--manual cannot overturn a constraint that was measured and failed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'attest over failure');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      run(['candidates', 'score', 'cand-1', '--constraint', 'c1', '--score', '0'], { cwd: tmp });

      const result = run(
        ['verify', '--manual', 'good enough', '--evidence', 'bun test -> 12 pass'],
        { cwd: tmp },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('c1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('next does not send an unverified problem to close', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'next routing');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      run(['verify'], { cwd: tmp });

      const json = parseLastJSON(run(['next'], { cwd: tmp }).stdout);
      // Neither passed nor failed: pointing at solve would be as wrong as close.
      expect(json.recommendation).toBe('verify');
      expect(json.message).toContain('unscored_hard_constraints');

      // The 05-close branch must not tell the caller to run a close that will refuse.
      run(['phase', 'set', 'close'], { cwd: tmp });
      const atClose = parseLastJSON(run(['next'], { cwd: tmp }).stdout);
      expect(atClose.recommendation).toBe('verify');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('close refuses an unverified problem and leaves it active', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'close gate');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      run(['verify'], { cwd: tmp });

      const result = run(['close', '--summary', 'done'], { cwd: tmp });
      expect(result.exitCode).toBe(2);
      const manifest = JSON.parse(
        readFileSync(join(tmp, '.xm', 'solver', 'problems', problem, 'manifest.json'), 'utf8'),
      );
      expect(manifest.state).toBe('active');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('close --force records closed, not solved, and needs a reason', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'forced close');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      run(['verify'], { cwd: tmp });

      expect(run(['close', '--force'], { cwd: tmp }).exitCode).toBe(1);

      const forced = run(['close', '--force', '--reason', 'shipping unproven, tracked in later'], { cwd: tmp });
      expect(forced.exitCode).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(tmp, '.xm', 'solver', 'problems', problem, 'manifest.json'), 'utf8'),
      );
      expect(manifest.state).toBe('closed');
      const summary = JSON.parse(
        readFileSync(join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '05-close', 'summary.json'), 'utf8'),
      );
      expect(summary.forced).toBe(true);
      expect(summary.verification_status).toBe('unverified');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // A legacy record's `passed` was produced by the two-valued rule this release
  // removed, so it says "passed" for exactly the states now called unverified. The
  // verdict is recomputed from the constraint check that is still on disk, and
  // `close --force --reason` remains the way out so nothing becomes unclosable.
  test('a legacy record is re-judged from its constraint check, not its passed flag', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'legacy artifact');
      seedCandidate(tmp, problem);
      const verifyDir = join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '04-verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(
        join(verifyDir, 'verification.json'),
        JSON.stringify({
          method: 'auto',
          passed: true,
          // The vacuous pass itself: a hard constraint that was never scored.
          constraint_check: [{ constraint_id: 'c1', type: 'hard', passed: null, note: 'Not scored' }],
          verified_at: '2026-01-01T00:00:00.000Z',
        }),
      );

      expect(run(['close', '--summary', 'done'], { cwd: tmp }).exitCode).toBe(2);

      const forced = run(['close', '--force', '--reason', 'legacy record, re-verified by hand'], { cwd: tmp });
      expect(forced.exitCode).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(tmp, '.xm', 'solver', 'problems', problem, 'manifest.json'), 'utf8'),
      );
      expect(manifest.state).toBe('closed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a legacy record whose hard constraints all passed still closes as solved', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'legacy genuine pass');
      seedCandidate(tmp, problem);
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      const verifyDir = join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '04-verify');
      mkdirSync(verifyDir, { recursive: true });
      writeFileSync(
        join(verifyDir, 'verification.json'),
        JSON.stringify({
          method: 'auto',
          passed: true,
          selected_candidate: 'cand-1',
          constraints: [{ id: 'c1', type: 'hard', description: 'must build' }],
          constraint_check: [{ constraint_id: 'c1', type: 'hard', passed: true, note: 'Score: 8' }],
          verified_at: '2026-01-01T00:00:00.000Z',
        }),
      );

      expect(run(['close', '--summary', 'done'], { cwd: tmp }).exitCode).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(tmp, '.xm', 'solver', 'problems', problem, 'manifest.json'), 'utf8'),
      );
      expect(manifest.state).toBe('solved');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('passed stays a boolean across all three verdicts', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-verify-'));
    try {
      const problem = setupProblem(tmp, 'boolean contract');
      seedCandidate(tmp, problem);
      expect(typeof verifyJSON(tmp).json.passed).toBe('boolean');
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      expect(typeof verifyJSON(tmp).json.passed).toBe('boolean');
      run(['candidates', 'score', 'cand-1', '--constraint', 'c1', '--score', '8'], { cwd: tmp });
      expect(typeof verifyJSON(tmp).json.passed).toBe('boolean');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// `reproduce` leads iterate so the failing evidence is provably recorded before the
// fix. Nothing in a prompt can establish that ordering; the phase machine can.
describe('x-solver reproduce gate', () => {
  function iterateProblem(tmp, description) {
    const problem = setupProblem(tmp, description);
    expect(run(['strategy', 'set', 'iterate'], { cwd: tmp }).exitCode).toBe(0);
    return problem;
  }

  function readState(tmp, problem) {
    return JSON.parse(
      readFileSync(
        join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '03-solve', 'strategy-state.json'),
        'utf8',
      ),
    );
  }

  // Every step is asserted: a helper that swallows exit codes turns a regressed gate
  // into a confusing crash somewhere else instead of naming the step that broke.
  function step(tmp, args) {
    const result = run(args, { cwd: tmp });
    if (result.exitCode !== 0) {
      throw new Error(`step failed (${args.join(' ')}) exit ${result.exitCode}\n${result.stderr}`);
    }
    return result;
  }

  function advanceTo(tmp, phase) {
    for (const p of ['diagnose', 'hypothesize', 'test', 'refine']) {
      step(tmp, ['solve-advance', '--phase', p]);
      if (p === phase) return;
    }
    // refine -> resolve now requires a hypothesis that survived an independent
    // refuter, with its evidence on file, so a test that wants the resolve phase has
    // to earn it.
    step(tmp, ['hypotheses', 'add', 'the recorded cause', '--check', 'rerun the repro']);
    step(tmp, ['hypotheses', 'update', 'h1', '--status', 'confirmed',
      '--evidence-for', 'bun test -> AssertionError x != y', '--source-kind', 'command']);
    step(tmp, ['hypotheses', 'update', 'h1', '--refutation', 'survived', '--refuted-by', 'refuter-1']);
    step(tmp, ['solve-advance', '--phase', 'resolve']);
  }

  test('iterate starts at reproduce, not diagnose', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-repro-'));
    try {
      const problem = iterateProblem(tmp, 'starts at reproduce');
      expect(readState(tmp, problem).current_phase).toBe('reproduce');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('leaving reproduce without a record is refused', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-repro-'));
    try {
      iterateProblem(tmp, 'no repro record');
      const result = run(['solve-advance', '--phase', 'diagnose'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('repro set');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a failure marker absent from the captured output is refused', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-repro-'));
    try {
      iterateProblem(tmp, 'invented marker');
      const result = run(
        ['repro', 'set', '--command', 'bun test', '--output', '1 fail: AssertionError',
          '--exit-code', '1', '--failure-marker', 'TypeError', '--status', 'reproduced'],
        { cwd: tmp },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not in the captured output');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('intermittent needs an observed rate', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-repro-'));
    try {
      iterateProblem(tmp, 'intermittent no rate');
      const base = ['repro', 'set', '--command', 'bun test', '--output', 'AssertionError here',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'intermittent'];
      expect(run(base, { cwd: tmp }).exitCode).toBe(1);
      expect(run([...base, '--runs', '10/3'], { cwd: tmp }).exitCode).toBe(1);

      const ok = run([...base, '--runs', '3/10'], { cwd: tmp });
      expect(ok.exitCode).toBe(0);
      // ceil(ln .05 / ln .7) = 9 — computed from the rate, not chosen.
      expect(parseLastJSON(ok.stdout).repro.required_clean_runs).toBe(9);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unavailable needs a justification, then lets the run continue', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-repro-'));
    try {
      iterateProblem(tmp, 'cannot reproduce');
      expect(run(['repro', 'set', '--status', 'unavailable'], { cwd: tmp }).exitCode).toBe(1);

      expect(
        run(['repro', 'set', '--status', 'unavailable', '--justification', 'needs production scale'], { cwd: tmp }).exitCode,
      ).toBe(0);
      // Not a dead end: an unreproducible bug still gets to be worked on.
      expect(run(['solve-advance', '--phase', 'diagnose'], { cwd: tmp }).exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('repro verify refuses output where the marker survives', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-repro-'));
    try {
      iterateProblem(tmp, 'marker survives');
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      advanceTo(tmp, 'resolve');

      const result = run(['repro', 'verify', '--output', 'still AssertionError', '--exit-code', '0'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('still present');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('repro verify ignores --command and re-uses the recorded one', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-repro-'));
    try {
      iterateProblem(tmp, 'command swap');
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      advanceTo(tmp, 'resolve');

      const result = run(
        ['repro', 'verify', '--command', 'echo ok', '--output', '4 pass', '--exit-code', '0', '--allow-no-diff', '--justification', 'test fixture'],
        { cwd: tmp },
      );
      // Swapping in an easier command is the cheapest way to fake a fix, so the
      // recorded command is the only one that counts.
      expect(parseLastJSON(result.stdout).repro.command).toBe('bun test');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a legacy problem sitting on diagnose still advances, with a warning', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-repro-'));
    try {
      const problem = iterateProblem(tmp, 'legacy state');
      // Exactly the shape a problem started before this phase existed has on disk.
      writeStrategyState(tmp, problem, {
        strategy: 'iterate',
        current_phase: 'diagnose',
        phases_completed: [],
        current_iteration: 0,
        max_iterations: 3,
        hypotheses: [],
      });

      const result = run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('predates the reproduce gate');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Every hypothesis used to be judged by the agent that generated it, so `confirmed`
// meant "one source agreed with itself". These gates make the fix wait for a second
// opinion, and give the run an honest way out when it never arrives.
describe('x-solver refutation gate and iteration exits', () => {
  function atRefine(tmp, description) {
    const problem = setupProblem(tmp, description);
    run(['strategy', 'set', 'iterate'], { cwd: tmp });
    run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
      '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
    for (const p of ['diagnose', 'hypothesize', 'test', 'refine']) {
      run(['solve-advance', '--phase', p], { cwd: tmp });
    }
    run(['hypotheses', 'add', 'cache is stale', '--check', 'rerun the repro'], { cwd: tmp });
    return problem;
  }

  function state(tmp, problem) {
    return JSON.parse(
      readFileSync(
        join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '03-solve', 'strategy-state.json'),
        'utf8',
      ),
    );
  }

  test('resolve is refused while the confirmed hypothesis is self-verified', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-refute-'));
    try {
      atRefine(tmp, 'self verified');
      run(['hypotheses', 'update', 'h1', '--status', 'confirmed'], { cwd: tmp });

      const result = run(['solve-advance', '--phase', 'resolve'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('independent refuter');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('single-signal is not enough for a root-cause fix', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-refute-'));
    try {
      atRefine(tmp, 'single signal');
      run(['hypotheses', 'update', 'h1', '--status', 'confirmed'], { cwd: tmp });
      run(['hypotheses', 'update', 'h1', '--refutation', 'single-signal'], { cwd: tmp });

      expect(run(['solve-advance', '--phase', 'resolve'], { cwd: tmp }).exitCode).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a hypothesis that survived refutation advances to resolve', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-refute-'));
    try {
      const problem = atRefine(tmp, 'survived');
      run(['hypotheses', 'update', 'h1', '--status', 'confirmed',
        '--evidence-for', 'cache.log: hit ratio 0% after deploy', '--source-kind', 'log'], { cwd: tmp });
      run(['hypotheses', 'update', 'h1', '--refutation', 'survived', '--refuted-by', 'refuter-1'], { cwd: tmp });

      expect(run(['solve-advance', '--phase', 'resolve'], { cwd: tmp }).exitCode).toBe(0);
      expect(state(tmp, problem).resolve_mode).toBe('root_cause');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the narrow exit needs a justification and marks the run as unconfirmed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-refute-'));
    try {
      const problem = atRefine(tmp, 'narrow exit');
      expect(run(['solve-advance', '--phase', 'resolve', '--unconfirmed', 'narrow'], { cwd: tmp }).exitCode).toBe(1);

      const ok = run(['solve-advance', '--phase', 'resolve', '--unconfirmed', 'narrow',
        '--justification', 'mitigating with logging while the cause is unknown'], { cwd: tmp });
      expect(ok.exitCode).toBe(0);
      expect(state(tmp, problem).resolve_mode).toBe('narrow');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects an unknown refutation verdict', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-refute-'));
    try {
      atRefine(tmp, 'bad verdict');
      const result = run(['hypotheses', 'update', 'h1', '--refutation', 'probably'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('survived, falsified, single-signal');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('exhausted iterations name three exits instead of resolving on a guess', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-refute-'));
    try {
      const problem = atRefine(tmp, 'exhausted');
      writeStrategyState(tmp, problem, {
        ...state(tmp, problem),
        current_phase: 'refine',
        current_iteration: 3,
        max_iterations: 3,
      });

      const result = run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('narrow');
      expect(result.stderr).toContain('extend');
      expect(result.stderr).toContain('abandon');
      // The old path advanced to resolve on "the most likely hypothesis" — a guess.
      expect(result.stderr).not.toContain('Advance to resolve instead');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('extending iterations needs a justification and is capped', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-refute-'));
    try {
      const problem = atRefine(tmp, 'extend cap');
      const base = { ...state(tmp, problem), current_phase: 'refine', current_iteration: 3, max_iterations: 3 };

      writeStrategyState(tmp, problem, base);
      expect(run(['solve-advance', '--phase', 'hypothesize', '--extend-iterations', '2'], { cwd: tmp }).exitCode).toBe(1);

      writeStrategyState(tmp, problem, base);
      expect(
        run(['solve-advance', '--phase', 'hypothesize', '--extend-iterations', '2', '--justification', 'new layer to try'], { cwd: tmp }).exitCode,
      ).toBe(0);

      writeStrategyState(tmp, problem, { ...base, iteration_extensions: 2 });
      const capped = run(['solve-advance', '--phase', 'hypothesize', '--extend-iterations', '2', '--justification', 'again'], { cwd: tmp });
      expect(capped.exitCode).toBe(1);
      expect(capped.stderr).toContain('cap 2');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('close --abandon records abandoned, never solved', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-refute-'));
    try {
      const problem = atRefine(tmp, 'abandon');
      expect(run(['close', '--abandon', '--summary', 'out of leads'], { cwd: tmp }).exitCode).toBe(0);
      const manifest = JSON.parse(
        readFileSync(join(tmp, '.xm', 'solver', 'problems', problem, 'manifest.json'), 'utf8'),
      );
      expect(manifest.state).toBe('abandoned');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// The review found the gates guarded entry but not exit, and that several of the
// deterministic checks were weaker than they read. These pin the closed chain.
describe('x-solver gate chain', () => {
  function gitRepo(prefix) {
    const tmp = mkdtempSync(join(tmpdir(), prefix));
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
    writeFileSync(join(tmp, 'app.js'), 'const x = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: tmp });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: tmp });
    return tmp;
  }

  function reproducedAtResolve(tmp, opts = {}) {
    const problem = setupProblem(tmp, 'chain problem');
    run(['strategy', 'set', 'iterate'], { cwd: tmp });
    run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
      '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
    for (const p of ['diagnose', 'hypothesize', 'test', 'refine']) run(['solve-advance', '--phase', p], { cwd: tmp });
    run(['hypotheses', 'add', 'stale cache', '--check', 'rerun the repro'], { cwd: tmp });
    run(['hypotheses', 'update', 'h1', '--status', 'confirmed',
      '--evidence-for', 'bun test -> AssertionError only with warm cache', '--source-kind', 'command'], { cwd: tmp });
    run(['hypotheses', 'update', 'h1', '--refutation', 'survived', '--refuted-by', 'refuter-1'], { cwd: tmp });
    run(['solve-advance', '--phase', 'resolve'], { cwd: tmp });
    if (!opts.noConstraint) run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
    run(['candidates', 'add', 'the fix', '--source', 'executor'], { cwd: tmp });
    run(['candidates', 'select', 'cand-1'], { cwd: tmp });
    run(['candidates', 'score', 'cand-1', '--constraint', 'c1', '--score', '8'], { cwd: tmp });
    return problem;
  }

  test('a reproduced failure that was never re-run cannot verify, however well scored', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      reproducedAtResolve(tmp);
      const result = run(['verify'], { cwd: tmp });
      const json = parseLastJSON(result.stdout);
      // Constraint scores say the solution meets its requirements. Only the regression
      // proof says the original failure stopped happening.
      expect(json.status).toBe('unverified');
      expect(json.reason).toBe('regression_proof_absent');
      expect(json.regression_proof).toBe('absent');
      expect(result.exitCode).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--manual cannot stand in for a regression proof', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      reproducedAtResolve(tmp);
      const result = run(['verify', '--manual', 'it works now', '--evidence', 'bun test -> 12 pass'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('repro verify');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('the chain closes once the recorded command is re-run clean', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      const problem = reproducedAtResolve(tmp);
      writeFileSync(join(tmp, 'app.js'), 'const x = 2;\n'); // a real edit to a tracked file
      expect(run(['repro', 'verify', '--output', '12 pass, 0 fail', '--exit-code', '0'], { cwd: tmp }).exitCode).toBe(0);

      const verified = run(['verify'], { cwd: tmp });
      expect(parseLastJSON(verified.stdout).status).toBe('passed');
      expect(run(['close', '--summary', 'fixed'], { cwd: tmp }).exitCode).toBe(0);
      const summary = JSON.parse(
        readFileSync(join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '05-close', 'summary.json'), 'utf8'),
      );
      expect(summary.regression_proof).toBe('proven');
      expect(summary.repro_status).toBe('reproduced');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // The digest used to fingerprint `git status --porcelain`, which is path + status
  // letters, so editing an already-modified file looked like no change at all.
  test('editing an already-dirty tracked file counts as a change', () => {
    const tmp = gitRepo('xs-digest-');
    try {
      writeFileSync(join(tmp, 'app.js'), 'const x = 1; // broken\n'); // dirty before repro set
      reproducedAtResolve(tmp);
      writeFileSync(join(tmp, 'app.js'), 'const x = 2; // fixed\n'); // same file, real fix

      const result = run(['repro', 'verify', '--output', '12 pass, 0 fail', '--exit-code', '0'], { cwd: tmp });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain('identical');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an untracked evidence file alone does not count as a change', () => {
    const tmp = gitRepo('xs-digest-');
    try {
      reproducedAtResolve(tmp);
      writeFileSync(join(tmp, 'after.txt'), '12 pass, 0 fail\n'); // only new untracked file

      const result = run(['repro', 'verify', '--output-file', join(tmp, 'after.txt'), '--exit-code', '0'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('identical');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an empty after-capture is not proof the failure is gone', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      reproducedAtResolve(tmp);
      writeFileSync(join(tmp, 'app.js'), 'const x = 2;\n');
      const result = run(['repro', 'verify', '--output', '   ', '--exit-code', '0'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('empty');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('repro verify refuses a nonzero after exit code', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      reproducedAtResolve(tmp);
      writeFileSync(join(tmp, 'app.js'), 'const x = 2;\n');
      const result = run(['repro', 'verify', '--output', '11 pass, 1 fail', '--exit-code', '1'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('exits 1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('repro set is refused outside the reproduce phase', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      const problem = setupProblem(tmp, 'phase gate');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      run(['solve-advance', '--phase', 'diagnose'], { cwd: tmp });

      // Recording a failure after leaving the phase would break the ordering guarantee
      // that is the whole reason `reproduce` comes first.
      const result = run(['repro', 'set', '--command', 'echo ok', '--output', 'AssertionError',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('reproduce phase');
      expect(problem).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('strategy set refuses to wipe a run in progress without --reset', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      const problem = setupProblem(tmp, 'no silent wipe');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });

      // This used to exit 0 and reset the iteration budget, the extension count, the
      // hypotheses and the repro record — bypassing every gate in one command.
      const result = run(['strategy', 'set', 'iterate'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--reset');
      expect(parseLastJSON(run(['repro', 'show'], { cwd: tmp }).stdout).repro.status).toBe('reproduced');

      expect(run(['strategy', 'set', 'iterate', '--reset'], { cwd: tmp }).exitCode).toBe(0);
      expect(problem).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('close refuses a verification that checked a different candidate', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      const problem = setupProblem(tmp, 'stale verification');
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      run(['candidates', 'add', 'first fix', '--source', 'executor'], { cwd: tmp });
      run(['candidates', 'select', 'cand-1'], { cwd: tmp });
      run(['candidates', 'score', 'cand-1', '--constraint', 'c1', '--score', '8'], { cwd: tmp });
      expect(run(['verify'], { cwd: tmp }).exitCode).toBe(0);

      run(['candidates', 'add', 'untested rewrite', '--source', 'executor'], { cwd: tmp });
      run(['candidates', 'select', 'cand-2'], { cwd: tmp });

      const result = run(['close', '--summary', 'done'], { cwd: tmp });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('stale');
      expect(problem).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('one extension cannot grant an unbounded budget', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      const problem = setupProblem(tmp, 'extend size');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      writeStrategyState(tmp, problem, {
        strategy: 'iterate', current_phase: 'refine',
        phases_completed: ['reproduce', 'diagnose', 'hypothesize', 'test'],
        current_iteration: 3, max_iterations: 3, hypotheses: [],
      });

      const huge = run(['solve-advance', '--phase', 'hypothesize', '--extend-iterations', '999',
        '--justification', 'many more rounds'], { cwd: tmp });
      expect(huge.exitCode).toBe(1);
      expect(huge.stderr).toContain('1..3');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('close --abandon needs a summary and will not overwrite a finished problem', () => {
    const tmp = gitRepo('xs-chain-');
    try {
      const problem = setupProblem(tmp, 'abandon guards');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      expect(run(['close', '--abandon'], { cwd: tmp }).exitCode).toBe(1);
      expect(run(['close', '--abandon', '--summary', 'no leads left'], { cwd: tmp }).exitCode).toBe(0);

      // An abandoned problem is no longer the active one, so a second --abandon cannot
      // even reach it implicitly. Naming it explicitly hits the terminal-state guard.
      const again = run(['close', '--problem', problem, '--abandon', '--summary', 'again'], { cwd: tmp });
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toContain('already abandoned');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// 2026-10 audit: runs that did their job were being recorded as failures, two
// mechanisms the docs rely on never received input, and one strategy could not be
// driven at all. These pin each contradiction to the CLI behaviour that fixes it.
describe('x-solver audit fixes', () => {
  function gitRepo(prefix) {
    const tmp = mkdtempSync(join(tmpdir(), prefix));
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
    writeFileSync(join(tmp, 'app.js'), 'const x = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: tmp });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: tmp });
    return tmp;
  }

  function readState(tmp, problem) {
    return JSON.parse(readFileSync(
      join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '03-solve', 'strategy-state.json'), 'utf8',
    ));
  }

  function readManifest(tmp, problem) {
    return JSON.parse(readFileSync(join(tmp, '.xm', 'solver', 'problems', problem, 'manifest.json'), 'utf8'));
  }

  function readSummary(tmp, problem) {
    return JSON.parse(readFileSync(
      join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '05-close', 'summary.json'), 'utf8',
    ));
  }

  // iterate up to and including a survived refutation, with evidence on file.
  function survivedAtRefine(tmp, description = 'audit chain') {
    const problem = setupProblem(tmp, description);
    run(['strategy', 'set', 'iterate'], { cwd: tmp });
    run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
      '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
    for (const p of ['diagnose', 'hypothesize']) run(['solve-advance', '--phase', p], { cwd: tmp });
    run(['hypotheses', 'add', 'stale cache after deploy', '--check', 'rerun the repro'], { cwd: tmp });
    run(['solve-advance', '--phase', 'test'], { cwd: tmp });
    run(['hypotheses', 'update', 'h1', '--status', 'confirmed',
      '--evidence-for', 'cache.log shows 0% hit ratio after deploy', '--source-kind', 'log'], { cwd: tmp });
    run(['solve-advance', '--phase', 'refine'], { cwd: tmp });
    run(['hypotheses', 'update', 'h1', '--refutation', 'survived', '--refuted-by', 'refuter-1'], { cwd: tmp });
    return problem;
  }

  // ── verify: the regression proof is execution evidence ───────────────────

  test('iterate: a proven regression with no hard constraint passes verify on the proof', () => {
    const tmp = gitRepo('xs-audit-');
    try {
      const problem = survivedAtRefine(tmp);
      expect(run(['solve-advance', '--phase', 'resolve'], { cwd: tmp }).exitCode).toBe(0);
      writeFileSync(join(tmp, 'app.js'), 'const x = 2;\n');
      expect(run(['repro', 'verify', '--output', '12 pass, 0 fail', '--exit-code', '0'], { cwd: tmp }).exitCode).toBe(0);
      run(['candidates', 'add', 'the fix', '--source', 'executor'], { cwd: tmp });
      run(['candidates', 'select', 'cand-1'], { cwd: tmp });

      const verified = run(['verify'], { cwd: tmp });
      const json = parseLastJSON(verified.stdout);
      expect(json.status).toBe('passed');
      expect(json.reason).toBe('regression_proof');
      expect(verified.exitCode).toBe(0);

      expect(run(['close', '--summary', 'fixed'], { cwd: tmp }).exitCode).toBe(0);
      expect(readManifest(tmp, problem).state).toBe('solved');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('iterate: a declared hard constraint still has to be scored, proof or not', () => {
    const tmp = gitRepo('xs-audit-');
    try {
      survivedAtRefine(tmp);
      run(['solve-advance', '--phase', 'resolve'], { cwd: tmp });
      writeFileSync(join(tmp, 'app.js'), 'const x = 2;\n');
      run(['repro', 'verify', '--output', '12 pass, 0 fail', '--exit-code', '0'], { cwd: tmp });
      run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
      run(['candidates', 'add', 'the fix', '--source', 'executor'], { cwd: tmp });
      run(['candidates', 'select', 'cand-1'], { cwd: tmp });

      const json = parseLastJSON(run(['verify'], { cwd: tmp }).stdout);
      expect(json.status).toBe('unverified');
      expect(json.reason).toBe('unscored_hard_constraints');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-iterate: no hard constraint is still unverified (the 2.3.0 gate stays)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'choose between cache options');
      run(['strategy', 'set', 'constrain'], { cwd: tmp });
      run(['candidates', 'add', 'redis', '--source', 'agent-1'], { cwd: tmp });
      run(['candidates', 'select', 'cand-1'], { cwd: tmp });
      const json = parseLastJSON(run(['verify'], { cwd: tmp }).stdout);
      expect(json.status).toBe('unverified');
      expect(json.reason).toBe('no_hard_constraints');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── close: diagnosis-only and direct answers get honest terminal states ───

  test('close --diagnosis-only records diagnosed with the surviving hypothesis', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = survivedAtRefine(tmp);
      expect(run(['close', '--diagnosis-only'], { cwd: tmp }).exitCode).toBe(1);

      const closed = run(['close', '--diagnosis-only', '--summary', 'cause confirmed, handed to triage'], { cwd: tmp });
      expect(closed.exitCode).toBe(0);
      expect(readManifest(tmp, problem).state).toBe('diagnosed');
      const summary = readSummary(tmp, problem);
      expect(summary.diagnosed).toBe(true);
      expect(summary.diagnosis[0].id).toBe('h1');
      expect(summary.diagnosis[0].evidence_for[0]).toContain('cache.log');
      expect(summary.diagnosis[0].refuted_by).toBe('refuter-1');
      const history = run(['history'], { cwd: tmp }).stdout;
      expect(history).toContain(problem);
      expect(history).toContain('Cause: h1 stale cache after deploy');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('close --diagnosis-only refuses without a surviving hypothesis', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = setupProblem(tmp, 'no survivor');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      for (const p of ['diagnose', 'hypothesize']) run(['solve-advance', '--phase', p], { cwd: tmp });
      run(['hypotheses', 'add', 'stale cache', '--check', 'rerun the repro'], { cwd: tmp });

      const result = run(['close', '--diagnosis-only', '--summary', 'nothing confirmed'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('--abandon');
      expect(readManifest(tmp, problem).state).toBe('active');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('close --diagnosis-only refuses once a fix was applied and re-run', () => {
    const tmp = gitRepo('xs-audit-');
    try {
      survivedAtRefine(tmp);
      run(['solve-advance', '--phase', 'resolve'], { cwd: tmp });
      writeFileSync(join(tmp, 'app.js'), 'const x = 2;\n');
      run(['repro', 'verify', '--output', '12 pass, 0 fail', '--exit-code', '0'], { cwd: tmp });

      const result = run(['close', '--diagnosis-only', '--summary', 'just the cause'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('verify');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a direct problem closes as answered with its summary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = setupProblem(tmp, 'hi');
      expect(parseLastJSON(run(['classify'], { cwd: tmp }).stdout).recommended_strategy).toBe('direct');

      expect(run(['close'], { cwd: tmp }).exitCode).toBe(1);
      const closed = run(['close', '--summary', 'answered in chat: use the dispatcher'], { cwd: tmp });
      expect(closed.exitCode).toBe(0);
      expect(readManifest(tmp, problem).state).toBe('answered');
      const summary = readSummary(tmp, problem);
      expect(summary.answered).toBe(true);
      expect(summary.solution).toContain('dispatcher');
      expect(parseLastJSON(run(['next'], { cwd: tmp }).stdout).recommendation).toBe('init');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('next tells a direct problem how to close instead of demanding verify', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'hi');
      run(['classify'], { cwd: tmp });
      const atClassify = parseLastJSON(run(['next'], { cwd: tmp }).stdout);
      expect(atClassify.recommendation).toBe('direct');
      expect(atClassify.message).toContain('close --summary');

      run(['phase', 'set', 'close'], { cwd: tmp });
      const atClose = parseLastJSON(run(['next'], { cwd: tmp }).stdout);
      expect(atClose.recommendation).toBe('close');
      expect(atClose.message).toContain('--summary');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── convergence actually receives the rounds it compares ─────────────────

  test('repeating the same hypotheses across rounds triggers the convergence stop', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = setupProblem(tmp, 'loop that repeats itself');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      run(['solve-advance', '--phase', 'diagnose'], { cwd: tmp });

      const round = (text) => {
        run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp });
        run(['hypotheses', 'add', text, '--check', 'rerun the repro'], { cwd: tmp });
        run(['solve-advance', '--phase', 'test'], { cwd: tmp });
        run(['solve-advance', '--phase', 'refine'], { cwd: tmp });
      };

      round('the cache is stale after every deploy');
      // retry 1: one round on file, nothing to compare against yet
      expect(run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp }).exitCode).toBe(0);
      expect(readState(tmp, problem).iteration_outputs[0].output).toContain('stale');
      run(['hypotheses', 'add', 'the cache is stale after every deploy', '--check', 'rerun the repro'], { cwd: tmp });
      for (const p of ['test', 'refine']) run(['solve-advance', '--phase', p], { cwd: tmp });

      // retry 2: round 2 restated round 1 — the loop is stalling and the CLI says so
      const stopped = run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp });
      expect(stopped.exitCode).toBe(1);
      expect(stopped.stderr).toContain('Early stop');
      expect(readState(tmp, problem).stop_reason).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('genuinely new hypotheses each round do not trip the convergence stop', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = setupProblem(tmp, 'loop that moves');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      run(['solve-advance', '--phase', 'diagnose'], { cwd: tmp });
      run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp });
      run(['hypotheses', 'add', 'the cache is stale after every deploy', '--check', 'rerun the repro'], { cwd: tmp });
      for (const p of ['test', 'refine']) run(['solve-advance', '--phase', p], { cwd: tmp });
      expect(run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp }).exitCode).toBe(0);
      run(['hypotheses', 'add', 'nginx keepalive drops the second request', '--check', 'rerun the repro'], { cwd: tmp });
      for (const p of ['test', 'refine']) run(['solve-advance', '--phase', p], { cwd: tmp });

      expect(run(['solve-advance', '--phase', 'hypothesize'], { cwd: tmp }).exitCode).toBe(0);
      expect(readState(tmp, problem).stop_reason).toBeUndefined();
      expect(readState(tmp, problem).hypotheses.map((h) => h.iteration)).toEqual([0, 1]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── hypotheses carry their evidence, and the gates read it ───────────────

  test('hypotheses update rejects an unknown status and an unknown source kind', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'status guard');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['hypotheses', 'add', 'something', '--check', 'rerun the repro'], { cwd: tmp });

      const bad = run(['hypotheses', 'update', 'h1', '--status', 'maybe'], { cwd: tmp });
      expect(bad.exitCode).toBe(1);
      expect(bad.stderr).toContain('pending, confirmed, refuted, inconclusive');

      const badKind = run(['hypotheses', 'update', 'h1', '--evidence-for', 'x', '--source-kind', 'vibes'], { cwd: tmp });
      expect(badKind.exitCode).toBe(1);
      expect(badKind.stderr).toContain('code, log, command, metric, test');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a confirmed hypothesis without recorded evidence cannot leave the test phase', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'evidence gate');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      for (const p of ['diagnose', 'hypothesize']) run(['solve-advance', '--phase', p], { cwd: tmp });
      run(['hypotheses', 'add', 'stale cache', '--check', 'rerun the repro'], { cwd: tmp });
      run(['solve-advance', '--phase', 'test'], { cwd: tmp });
      run(['hypotheses', 'update', 'h1', '--status', 'confirmed'], { cwd: tmp });

      const refused = run(['solve-advance', '--phase', 'refine'], { cwd: tmp });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('--evidence-for');

      run(['hypotheses', 'update', 'h1', '--evidence-for', 'cache.log: 0% hits', '--source-kind', 'log'], { cwd: tmp });
      expect(run(['solve-advance', '--phase', 'refine'], { cwd: tmp }).exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a survived hypothesis without evidence cannot enter resolve', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'late confirm');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      for (const p of ['diagnose', 'hypothesize', 'test', 'refine']) run(['solve-advance', '--phase', p], { cwd: tmp });
      run(['hypotheses', 'add', 'stale cache', '--check', 'rerun the repro'], { cwd: tmp });
      run(['hypotheses', 'update', 'h1', '--status', 'confirmed'], { cwd: tmp });
      run(['hypotheses', 'update', 'h1', '--refutation', 'survived', '--refuted-by', 'refuter-1'], { cwd: tmp });

      const refused = run(['solve-advance', '--phase', 'resolve'], { cwd: tmp });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('evidence');
      expect(refused.stderr).not.toContain('independent refuter');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── scope contract has a home ────────────────────────────────────────────

  test('scope set persists the contract, solve exposes it, expand needs a justification', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = setupProblem(tmp, 'scope home');
      expect(run(['scope', 'set', '--symptom', 'x', '--invariant', 'y'], { cwd: tmp }).exitCode).toBe(1);
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });

      expect(run(['scope', 'set', '--symptom', 'login fails'], { cwd: tmp }).exitCode).toBe(1);
      const set = run(['scope', 'set', '--symptom', 'login fails after deploy',
        '--invariant', 'session cookie survives a deploy', '--non-goals', 'rate limiting,ui copy',
        '--files', 'src/auth.js,src/session.js', '--tests', 'test/auth.test.js'], { cwd: tmp });
      expect(set.exitCode).toBe(0);

      const scope = readState(tmp, problem).scope;
      expect(scope.repro_command).toBe('bun test');
      expect(scope.failure_marker).toBe('AssertionError');
      expect(scope.files).toEqual(['src/auth.js', 'src/session.js']);
      expect(scope.non_goals).toEqual(['rate limiting', 'ui copy']);

      expect(parseLastJSON(run(['solve'], { cwd: tmp }).stdout).scope.invariant).toContain('session cookie');
      expect(parseLastJSON(run(['scope', 'show'], { cwd: tmp }).stdout).scope.symptom).toContain('login');

      expect(run(['scope', 'expand', '--files', 'src/cookie.js'], { cwd: tmp }).exitCode).toBe(1);
      expect(run(['scope', 'expand', '--files', 'src/cookie.js',
        '--justification', 'repro still fails: cookie parser is the second file on the path'], { cwd: tmp }).exitCode).toBe(0);
      const expanded = readState(tmp, problem).scope;
      expect(expanded.files).toContain('src/cookie.js');
      expect(expanded.expansions).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a scope recorded before repro set picks up the command and marker', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = setupProblem(tmp, 'scope first');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });
      expect(run(['scope', 'set', '--symptom', 'login fails', '--invariant', 'session survives deploy'], { cwd: tmp }).exitCode).toBe(0);
      expect(readState(tmp, problem).scope.repro_command).toBeNull();

      run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
        '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
      const scope = parseLastJSON(run(['scope', 'show'], { cwd: tmp }).stdout).scope;
      expect(scope.repro_command).toBe('bun test');
      expect(scope.failure_marker).toBe('AssertionError');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── pipeline is gone; classify stops recommending a strategy that cannot run ─

  test('strategy set pipeline is refused as removed', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'no pipeline');
      const result = run(['strategy', 'set', 'pipeline'], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('removed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a signal-free problem gets a low-confidence recommendation, never pipeline', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'the quarterly summary document needs a new section about onboarding and the team '
        + 'wants the tone consistent across every chapter so readers can follow along without extra effort '
        + 'from the start of the year to the end');
      const json = parseLastJSON(run(['classify'], { cwd: tmp }).stdout);
      expect(json.recommended_strategy).not.toBe('pipeline');
      expect(['decompose', 'iterate', 'constrain']).toContain(json.recommended_strategy);
      expect(json.confidence).toBeLessThan(0.7);
      expect(json.reasoning).toContain('LLM fallback');
      expect(json.alternative_strategies).not.toContain('pipeline');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a legacy pipeline problem is refused with the reset path, not a crash', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = setupProblem(tmp, 'legacy pipeline');
      const manifestPath = join(tmp, '.xm', 'solver', 'problems', problem, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      writeFileSync(manifestPath, JSON.stringify({ ...manifest, strategy: 'pipeline', current_phase: '03-solve' }));
      writeStrategyState(tmp, problem, { strategy: 'pipeline', current_phase: 'route', phases_completed: ['classify'] });

      for (const args of [['solve'], ['solve-advance', '--phase', 'meta-verify'], ['solve-status']]) {
        const result = run(args, { cwd: tmp });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('--reset');
      }
      expect(run(['strategy', 'set', 'iterate', '--reset'], { cwd: tmp }).exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── phase next/set cannot skip an unfinished solve ───────────────────────

  test('phase next refuses to leave an unfinished solve without --force --reason', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const problem = setupProblem(tmp, 'phase guard');
      run(['strategy', 'set', 'iterate'], { cwd: tmp });

      const refused = run(['phase', 'next'], { cwd: tmp });
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('reproduce');
      expect(readManifest(tmp, problem).current_phase).toBe('03-solve');

      expect(run(['phase', 'set', 'close'], { cwd: tmp }).exitCode).toBe(1);
      expect(run(['phase', 'set', 'verify', '--force'], { cwd: tmp }).exitCode).toBe(1);

      const forced = run(['phase', 'set', 'verify', '--force', '--reason', 'legacy run, solve state lost'], { cwd: tmp });
      expect(forced.exitCode).toBe(0);
      const manifest = readManifest(tmp, problem);
      expect(manifest.current_phase).toBe('04-verify');
      expect(manifest.phase_overrides[0].reason).toContain('legacy');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase next moves on once the last solve phase is reached, and never blocks going back', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'choose between cache options');
      run(['strategy', 'set', 'constrain'], { cwd: tmp });
      for (const p of ['generate', 'evaluate', 'select']) run(['solve-advance', '--phase', p], { cwd: tmp });
      expect(run(['phase', 'next'], { cwd: tmp }).exitCode).toBe(0);
      expect(run(['phase', 'set', 'solve'], { cwd: tmp }).exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── solve JSON carries what the leader otherwise has to go and look up ──

  test('solve JSON resolves cross_vendor from flag, then shared config, then false', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      setupProblem(tmp, 'choose between cache options');
      run(['strategy', 'set', 'constrain'], { cwd: tmp });
      expect(parseLastJSON(run(['solve'], { cwd: tmp }).stdout).cross_vendor).toEqual({ effective: false, source: 'default' });

      mkdirSync(join(tmp, '.xm'), { recursive: true });
      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({ cross_vendor: { solver: true } }));
      expect(parseLastJSON(run(['solve'], { cwd: tmp }).stdout).cross_vendor).toEqual({ effective: true, source: 'config:cross_vendor.solver' });
      expect(parseLastJSON(run(['solve', '--no-cross-vendor'], { cwd: tmp }).stdout).cross_vendor.effective).toBe(false);

      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({ cross_vendor: { default: true } }));
      expect(parseLastJSON(run(['solve'], { cwd: tmp }).stdout).cross_vendor.source).toBe('config:cross_vendor.default');
      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({}));
      expect(parseLastJSON(run(['solve', '--cross-vendor'], { cwd: tmp }).stdout).cross_vendor).toEqual({ effective: true, source: 'flag' });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('setup does not pin parallel_agents, so the shared agent_max_count applies', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-audit-'));
    try {
      const defaults = JSON.parse(readFileSync(join(__dirname, '..', 'x-solver', 'lib', 'default-config.json'), 'utf8'));
      expect(defaults.solving.parallel_agents).toBeUndefined();

      const setup = spawnSync('node', [join(__dirname, '..', 'x-solver', 'scripts', 'setup.mjs')], { cwd: tmp, encoding: 'utf8' });
      expect(setup.status).toBe(0);
      const written = JSON.parse(readFileSync(join(tmp, '.xm', 'solver', 'config.json'), 'utf8'));
      expect(written.solving.parallel_agents).toBeUndefined();

      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({ agent_max_count: 9 }));
      setupProblem(tmp, 'choose between cache options');
      run(['strategy', 'set', 'constrain'], { cwd: tmp });
      expect(parseLastJSON(run(['solve'], { cwd: tmp }).stdout).agent_count).toBe(9);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── PR #49 review findings ───────────────────────────────────────────────

  function legacyPipeline(tmp) {
    const problem = setupProblem(tmp, "legacy pipeline problem");
    const manifestPath = join(tmp, ".xm", "solver", "problems", problem, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, strategy: "pipeline", current_phase: "03-solve" }));
    writeStrategyState(tmp, problem, { strategy: "pipeline", current_phase: "route", phases_completed: ["classify"] });
    return problem;
  }

  test("review F1/F2: strategy show on a legacy pipeline problem refuses with the reset path", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-review-"));
    try {
      legacyPipeline(tmp);
      for (const args of [["strategy", "show"], ["strategy"]]) {
        const result = run(args, { cwd: tmp });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).not.toContain("TypeError");
        expect(result.stderr).toContain("--reset");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("review F9: phase next on a legacy pipeline problem names the reset path, not a missing strategy", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-review-"));
    try {
      legacyPipeline(tmp);
      const result = run(["phase", "next"], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--reset");
      expect(result.stderr).not.toContain("no strategy has been set");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("review F3/F4: close --diagnosis-only needs recorded evidence, a named refuter, and the refine phase", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-review-"));
    try {
      const problem = setupProblem(tmp, "diagnosis shortcut");
      run(["strategy", "set", "iterate"], { cwd: tmp });
      run(["repro", "set", "--command", "bun test", "--output", "AssertionError x != y",
        "--exit-code", "1", "--failure-marker", "AssertionError", "--status", "reproduced"], { cwd: tmp });
      for (const p of ["diagnose", "hypothesize"]) run(["solve-advance", "--phase", p], { cwd: tmp });
      run(["hypotheses", "add", "stale cache"], { cwd: tmp });
      run(["hypotheses", "update", "h1", "--status", "confirmed", "--refutation", "survived"], { cwd: tmp });
      const close = () => run(["close", "--diagnosis-only", "--summary", "cause handed to triage"], { cwd: tmp });

      const noEvidence = close();
      expect(noEvidence.exitCode).toBe(1);
      expect(noEvidence.stderr).toContain("--evidence-for");

      run(["hypotheses", "update", "h1", "--evidence-for", "cache.log: 0% hits", "--source-kind", "log"], { cwd: tmp });
      const noRefuter = close();
      expect(noRefuter.exitCode).toBe(1);
      expect(noRefuter.stderr).toContain("--refuted-by");

      run(["hypotheses", "update", "h1", "--refutation", "survived", "--refuted-by", "refuter-1"], { cwd: tmp });
      const wrongPhase = close();
      expect(wrongPhase.exitCode).toBe(1);
      expect(wrongPhase.stderr).toContain("refine");
      expect(readManifest(tmp, problem).state).toBe("active");

      for (const p of ["test", "refine"]) expect(run(["solve-advance", "--phase", p], { cwd: tmp }).exitCode).toBe(0);
      expect(close().exitCode).toBe(0);
      expect(readManifest(tmp, problem).state).toBe("diagnosed");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("review F5: classify --select direct lets a low-confidence problem close as answered", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-review-"));
    try {
      const problem = setupProblem(tmp, "the quarterly summary document needs a new section about onboarding and the team "
        + "wants the tone consistent across every chapter so readers can follow along without extra effort");
      expect(parseLastJSON(run(["classify"], { cwd: tmp }).stdout).recommended_strategy).not.toBe("direct");
      expect(run(["close", "--summary", "answered in chat"], { cwd: tmp }).exitCode).toBe(2);

      const solveChoice = run(["classify", "--select", "iterate"], { cwd: tmp });
      expect(solveChoice.exitCode).toBe(1);
      expect(solveChoice.stderr).toContain("strategy set");

      expect(run(["classify", "--select", "direct", "--reason", "user chose to answer in chat"], { cwd: tmp }).exitCode).toBe(0);
      expect(parseLastJSON(run(["next"], { cwd: tmp }).stdout).recommendation).toBe("direct");
      expect(run(["close", "--summary", "answered in chat: use the dispatcher"], { cwd: tmp }).exitCode).toBe(0);
      expect(readManifest(tmp, problem).state).toBe("answered");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("review F7: an evidence flag whose value starts with -- is refused, not dropped", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-review-"));
    try {
      const problem = setupProblem(tmp, "dash evidence");
      run(["strategy", "set", "iterate"], { cwd: tmp });
      run(["hypotheses", "add", "a cause"], { cwd: tmp });

      const result = run(["hypotheses", "update", "h1", "--status", "confirmed", "--evidence-for", "--- FAIL: TestX"], { cwd: tmp });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("--evidence-for needs a value");
      const h1 = readState(tmp, problem).hypotheses[0];
      expect(h1.evidence_for).toEqual([]);
      expect(h1.status).toBe("pending");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("review F8: scope set refuses to overwrite an existing contract without --reset", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-review-"));
    try {
      const problem = setupProblem(tmp, "scope overwrite");
      run(["strategy", "set", "iterate"], { cwd: tmp });
      run(["scope", "set", "--symptom", "login fails", "--invariant", "session survives deploy", "--files", "src/a.js"], { cwd: tmp });

      const again = run(["scope", "set", "--symptom", "login fails", "--invariant", "everything", "--files", "src/a.js,src/b.js"], { cwd: tmp });
      expect(again.exitCode).toBe(1);
      expect(again.stderr).toContain("scope expand");
      expect(readState(tmp, problem).scope.files).toEqual(["src/a.js"]);

      expect(run(["scope", "set", "--symptom", "login fails", "--invariant", "token refresh", "--files", "src/c.js", "--reset"], { cwd: tmp }).exitCode).toBe(0);
      expect(readState(tmp, problem).scope.files).toEqual(["src/c.js"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── PR #49 delta review follow-ups ───────────────────────────────────────

  test("follow-up: overriding a non-direct recommendation needs --reason, and close records it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-followup-"));
    try {
      const problem = setupProblem(tmp, "the quarterly summary document needs a new section about onboarding and the team "
        + "wants the tone consistent across every chapter so readers can follow along without extra effort");
      const recommended = parseLastJSON(run(["classify"], { cwd: tmp }).stdout).recommended_strategy;
      expect(recommended).not.toBe("direct");

      const bare = run(["classify", "--select", "direct"], { cwd: tmp });
      expect(bare.exitCode).toBe(1);
      expect(bare.stderr).toContain("--reason");
      expect(run(["classify", "--select", "direct", "--reason"], { cwd: tmp }).exitCode).toBe(1);

      expect(run(["classify", "--select", "direct", "--reason", "LLM fallback: a wording question with no code path"], { cwd: tmp }).exitCode).toBe(0);
      expect(run(["close", "--summary", "answered in chat"], { cwd: tmp }).exitCode).toBe(0);
      const summary = readSummary(tmp, problem);
      expect(summary.recommended_strategy).toBe(recommended);
      expect(summary.selected_strategy).toBe("direct");
      expect(summary.selected_reason).toContain("LLM fallback");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("follow-up: confirming a rule-based direct needs no reason", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-followup-"));
    try {
      setupProblem(tmp, "hi");
      expect(parseLastJSON(run(["classify"], { cwd: tmp }).stdout).recommended_strategy).toBe("direct");
      expect(run(["classify", "--select", "direct"], { cwd: tmp }).exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("follow-up: --refuted-by without a name is refused, so the refuter gate cannot pass on true", () => {
    const tmp = mkdtempSync(join(tmpdir(), "xs-followup-"));
    try {
      const problem = setupProblem(tmp, "nameless refuter");
      run(["strategy", "set", "iterate"], { cwd: tmp });
      run(["hypotheses", "add", "stale cache"], { cwd: tmp });

      for (const args of [
        ["hypotheses", "update", "h1", "--refutation", "survived", "--refuted-by"],
        ["hypotheses", "update", "h1", "--refutation", "survived", "--refuted-by", "--source-kind", "log"],
      ]) {
        const result = run(args, { cwd: tmp });
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("--refuted-by needs a value");
        // The hint has to ask for a name. The evidence-flag hint ("output: --- FAIL ...")
        // would put pasted output where the refuter belongs, and the gate reads only truthiness.
        expect(result.stderr).toContain("agent name");
        expect(result.stderr).not.toContain("output: --- FAIL");
      }
      const h1 = readState(tmp, problem).hypotheses[0];
      expect(h1.refuted_by).toBeUndefined();
      expect(h1.refutation).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('x-solver hypothesis plan', () => {
  function atHypothesize(tmp) {
    const problem = setupProblem(tmp, 'hypothesis plan');
    run(['strategy', 'set', 'iterate'], { cwd: tmp });
    run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
      '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
    for (const p of ['diagnose', 'hypothesize']) run(['solve-advance', '--phase', p], { cwd: tmp });
    return problem;
  }

  function hypotheses(tmp, problem) {
    return JSON.parse(readFileSync(
      join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '03-solve', 'strategy-state.json'), 'utf8',
    )).hypotheses;
  }

  test('add stores the likelihood and the check', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-hplan-'));
    try {
      const problem = atHypothesize(tmp);
      const r = run(['hypotheses', 'add', 'stale cache', '--likelihood', 'high', '--check', 'grep miss cache.log'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const [h] = hypotheses(tmp, problem);
      expect(h.likelihood).toBe('high');
      expect(h.check).toBe('grep miss cache.log');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('add refuses an unknown likelihood and a check without a value', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-hplan-'));
    try {
      const problem = atHypothesize(tmp);
      const bad = run(['hypotheses', 'add', 'stale cache', '--likelihood', 'certain', '--check', 'x'], { cwd: tmp });
      expect(bad.exitCode).not.toBe(0);
      expect(bad.stderr).toContain('Unknown --likelihood "certain"');
      // A "--"-prefixed value parses as the next flag and leaves --check `true`.
      const empty = run(['hypotheses', 'add', 'stale cache', '--check', '--likelihood', 'low'], { cwd: tmp });
      expect(empty.exitCode).not.toBe(0);
      expect(empty.stderr).toContain('--check needs a value');
      expect(hypotheses(tmp, problem) ?? []).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('test phase is refused while a pending hypothesis has no check', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-hplan-'));
    try {
      atHypothesize(tmp);
      run(['hypotheses', 'add', 'stale cache', '--check', 'rerun the repro'], { cwd: tmp });
      run(['hypotheses', 'add', 'nginx keepalive drops the second request'], { cwd: tmp });
      const refused = run(['solve-advance', '--phase', 'test'], { cwd: tmp });
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain('No verification check on file: h2.');

      expect(run(['hypotheses', 'update', 'h2', '--check', 'curl twice with keepalive'], { cwd: tmp }).exitCode).toBe(0);
      expect(run(['solve-advance', '--phase', 'test'], { cwd: tmp }).exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a hypothesis that is no longer pending does not need a check', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-hplan-'));
    try {
      atHypothesize(tmp);
      run(['hypotheses', 'add', 'stale cache', '--check', 'rerun the repro'], { cwd: tmp });
      run(['hypotheses', 'add', 'already ruled out'], { cwd: tmp });
      run(['hypotheses', 'update', 'h2', '--status', 'refuted'], { cwd: tmp });
      expect(run(['solve-advance', '--phase', 'test'], { cwd: tmp }).exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('list shows the most likely hypothesis first', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-hplan-'));
    try {
      atHypothesize(tmp);
      run(['hypotheses', 'add', 'unlikely race', '--likelihood', 'low', '--check', 'a'], { cwd: tmp });
      run(['hypotheses', 'add', 'no likelihood given', '--check', 'b'], { cwd: tmp });
      run(['hypotheses', 'add', 'stale cache', '--likelihood', 'high', '--check', 'c'], { cwd: tmp });
      const out = run(['hypotheses', 'list'], { cwd: tmp }).stdout;
      const order = ['stale cache', 'unlikely race', 'no likelihood given'].map((s) => out.indexOf(s));
      expect(order.every((i) => i >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(out).toContain('check: c');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('x-solver repro baseline', () => {
  function gitRepo() {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-baseline-'));
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
    writeFileSync(join(tmp, 'app.js'), 'const x = 1;\n');
    spawnSync('git', ['add', '-A'], { cwd: tmp });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: tmp });
    return tmp;
  }

  function reproSet(tmp) {
    const problem = setupProblem(tmp, 'baseline');
    run(['strategy', 'set', 'iterate'], { cwd: tmp });
    const r = run(['repro', 'set', '--command', 'node app.js', '--output', 'AssertionError x != y',
      '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
    const solve = join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '03-solve');
    return { r, solve, baseline: JSON.parse(readFileSync(join(solve, 'strategy-state.json'), 'utf8')).repro.baseline };
  }

  const headOf = (tmp) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).stdout.trim();

  test('a clean tree records HEAD and no patch, and ignores .xm', () => {
    const tmp = gitRepo();
    try {
      const { r, baseline } = reproSet(tmp);
      expect(r.exitCode).toBe(0);
      expect(baseline.head).toBe(headOf(tmp));
      expect(baseline.patch_path).toBeNull();
      expect(baseline.untracked).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a dirty tree records the uncommitted patch and the untracked files', () => {
    const tmp = gitRepo();
    try {
      writeFileSync(join(tmp, 'app.js'), 'const x = 2;\n');
      writeFileSync(join(tmp, 'new.txt'), 'evidence\n');
      const { solve, baseline } = reproSet(tmp);
      expect(baseline.head).toBe(headOf(tmp));
      expect(baseline.patch_path).toBe('repro/baseline.patch');
      expect(baseline.untracked).toEqual(['new.txt']);

      // The patch rebuilds the failing state from HEAD: revert app.js, then re-apply.
      const patchFile = join(solve, baseline.patch_path);
      spawnSync('git', ['checkout', '--', 'app.js'], { cwd: tmp });
      expect(spawnSync('git', ['apply', patchFile], { cwd: tmp }).status).toBe(0);
      expect(readFileSync(join(tmp, 'app.js'), 'utf8')).toBe('const x = 2;\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('outside git the repro is still recorded and the missing baseline is reported', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-baseline-nogit-'));
    try {
      const { r, baseline } = reproSet(tmp);
      expect(r.exitCode).toBe(0);
      expect(baseline).toBeNull();
      expect(r.stderr).toContain('No baseline recorded');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('x-solver regression test on the baseline', () => {
  const BUGGY = 'module.exports = (a, b) => a - b;\n';
  const FIXED = 'module.exports = (a, b) => a + b;\n';
  const CHECK = "const sum = require('./sum.js');\nif (sum(2, 3) !== 5) { console.error('REGRESSION: sum(2, 3) = ' + sum(2, 3)); process.exit(1); }\nconsole.log('ok');\n";

  function gitRepo(committedSum) {
    const tmp = mkdtempSync(join(tmpdir(), 'xs-regcmd-'));
    spawnSync('git', ['init', '-q'], { cwd: tmp });
    spawnSync('git', ['config', 'user.email', 't@t'], { cwd: tmp });
    spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
    writeFileSync(join(tmp, 'sum.js'), committedSum);
    spawnSync('git', ['add', '-A'], { cwd: tmp });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: tmp });
    return tmp;
  }

  // reproduce (with whatever sum.js is on disk now) up to the resolve phase.
  function atResolve(tmp) {
    const problem = setupProblem(tmp, 'sum is wrong');
    run(['strategy', 'set', 'iterate'], { cwd: tmp });
    run(['repro', 'set', '--command', 'node check.js', '--output', 'REGRESSION: sum(2, 3) = -1',
      '--exit-code', '1', '--failure-marker', 'REGRESSION', '--status', 'reproduced'], { cwd: tmp });
    for (const p of ['diagnose', 'hypothesize']) run(['solve-advance', '--phase', p], { cwd: tmp });
    run(['hypotheses', 'add', 'sum subtracts', '--check', 'node check.js'], { cwd: tmp });
    run(['solve-advance', '--phase', 'test'], { cwd: tmp });
    run(['hypotheses', 'update', 'h1', '--status', 'confirmed', '--evidence-for', 'sum.js uses a - b', '--source-kind', 'code'], { cwd: tmp });
    run(['solve-advance', '--phase', 'refine'], { cwd: tmp });
    run(['hypotheses', 'update', 'h1', '--refutation', 'survived', '--refuted-by', 'refuter-1'], { cwd: tmp });
    run(['solve-advance', '--phase', 'resolve'], { cwd: tmp });
    return problem;
  }

  function verify(tmp, extra) {
    return run(['repro', 'verify', '--output', 'ok', '--exit-code', '0', ...extra], { cwd: tmp });
  }

  const REG = ['--regression-test', 'check.js', '--regression-cmd', 'node check.js', '--regression-marker', 'REGRESSION'];

  function afterRecord(tmp, problem) {
    return JSON.parse(readFileSync(
      join(tmp, '.xm', 'solver', 'problems', problem, 'phases', '03-solve', 'strategy-state.json'), 'utf8',
    )).repro.after;
  }

  const worktrees = (tmp) => spawnSync('git', ['worktree', 'list'], { cwd: tmp, encoding: 'utf8' }).stdout.trim().split('\n').length;

  test('a test that fails on the baseline and passes now is pinned', () => {
    const tmp = gitRepo(BUGGY);
    try {
      const problem = atResolve(tmp);
      writeFileSync(join(tmp, 'sum.js'), FIXED);
      writeFileSync(join(tmp, 'check.js'), CHECK);
      const r = verify(tmp, REG);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Regression test pinned');
      const { regression } = afterRecord(tmp, problem);
      expect(regression.fails_before).toBe(true);
      expect(regression.passes_after).toBe(true);
      expect(regression.before_exit).toBe(1);
      expect(worktrees(tmp)).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a bug introduced by an uncommitted edit is rebuilt from the recorded patch', () => {
    const tmp = gitRepo(FIXED);
    try {
      writeFileSync(join(tmp, 'sum.js'), BUGGY);
      const problem = atResolve(tmp);
      writeFileSync(join(tmp, 'sum.js'), FIXED);
      writeFileSync(join(tmp, 'check.js'), CHECK);
      const r = verify(tmp, REG);
      expect(r.exitCode).toBe(0);
      expect(afterRecord(tmp, problem).regression.baseline_patch).toBe('repro/baseline.patch');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a test that passes on the baseline is refused and nothing is recorded', () => {
    const tmp = gitRepo(BUGGY);
    try {
      const problem = atResolve(tmp);
      writeFileSync(join(tmp, 'sum.js'), FIXED);
      writeFileSync(join(tmp, 'unrelated.js'), "console.log('fine');\n");
      const r = verify(tmp, ['--regression-test', 'unrelated.js', '--regression-cmd', 'node unrelated.js', '--regression-marker', 'REGRESSION']);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('does not fail on the code the bug was recorded on (it passed)');
      expect(afterRecord(tmp, problem)).toBeNull();
      expect(worktrees(tmp)).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a test that fails on the baseline for another reason is refused', () => {
    const tmp = gitRepo(BUGGY);
    try {
      atResolve(tmp);
      writeFileSync(join(tmp, 'sum.js'), FIXED);
      writeFileSync(join(tmp, 'broken.js'), "require('./missing-helper.js');\n");
      const r = verify(tmp, ['--regression-test', 'broken.js', '--regression-cmd', 'node broken.js', '--regression-marker', 'REGRESSION']);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('without the marker');
      expect(r.stderr).toContain('--regression-setup');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a test that still fails now is refused', () => {
    const tmp = gitRepo(BUGGY);
    try {
      atResolve(tmp);
      writeFileSync(join(tmp, 'sum.js'), `// touched, not fixed\n${BUGGY}`);
      writeFileSync(join(tmp, 'check.js'), CHECK);
      const r = verify(tmp, REG);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('does not pass now (the marker is still in its output)');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--regression-cmd without a marker is refused before anything runs', () => {
    const tmp = gitRepo(BUGGY);
    try {
      atResolve(tmp);
      writeFileSync(join(tmp, 'sum.js'), FIXED);
      writeFileSync(join(tmp, 'check.js'), CHECK);
      const r = verify(tmp, ['--regression-test', 'check.js', '--regression-cmd', 'node check.js']);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('--regression-cmd needs --regression-marker');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
