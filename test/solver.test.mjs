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
