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
      expect(result.stderr).toContain('decompose|iterate|constrain|pipeline');
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
    // refuter, so a test that wants the resolve phase has to earn it.
    step(tmp, ['hypotheses', 'add', 'the recorded cause']);
    step(tmp, ['hypotheses', 'update', 'h1', '--status', 'confirmed']);
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
    run(['hypotheses', 'add', 'cache is stale'], { cwd: tmp });
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
      run(['hypotheses', 'update', 'h1', '--status', 'confirmed'], { cwd: tmp });
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

  function reproducedAtResolve(tmp) {
    const problem = setupProblem(tmp, 'chain problem');
    run(['strategy', 'set', 'iterate'], { cwd: tmp });
    run(['repro', 'set', '--command', 'bun test', '--output', 'AssertionError x != y',
      '--exit-code', '1', '--failure-marker', 'AssertionError', '--status', 'reproduced'], { cwd: tmp });
    for (const p of ['diagnose', 'hypothesize', 'test', 'refine']) run(['solve-advance', '--phase', p], { cwd: tmp });
    run(['hypotheses', 'add', 'stale cache'], { cwd: tmp });
    run(['hypotheses', 'update', 'h1', '--status', 'confirmed'], { cwd: tmp });
    run(['hypotheses', 'update', 'h1', '--refutation', 'survived', '--refuted-by', 'refuter-1'], { cwd: tmp });
    run(['solve-advance', '--phase', 'resolve'], { cwd: tmp });
    run(['constraints', 'add', 'must build', '--type', 'hard'], { cwd: tmp });
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
