import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRIFT_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-build', 'drift.mjs');
const CLI_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

// ── Unit: parsePrdBaseline ────────────────────────────────────────

const { parsePrdBaseline, computeDrift, shareStem } = await import(DRIFT_PATH);

const FULL_PRD = `# PRD — test

## 1. Goal
Build a reliable scoring system for project gates.

## 2. Success Criteria
- [SC1] The scoring function returns a value between 0 and 1.
- [SC2] The gate pass flag is set correctly based on threshold.
- [SC3] Constraint violations are detected from task text.

## 3. Constraints
- [C1] No external imports allowed in scoring logic.
- [C2] All functions must be pure and deterministic.

## 6. Architecture
- \`scoring.mjs\` exports weightedScore and passes helpers
- \`drift.mjs\` uses ScoringEngine internally
- DataModel: TaskRecord, BaselineSpec, DriftResult
`;

const MINIMAL_PRD = `# PRD — minimal

## 1. Goal
Simple goal with no structured criteria.
`;

describe('parsePrdBaseline — normal PRD', () => {
  test('parses goal text', () => {
    const b = parsePrdBaseline(FULL_PRD);
    expect(b.goal).toContain('reliable scoring system');
  });

  test('parses all SC items', () => {
    const b = parsePrdBaseline(FULL_PRD);
    expect(b.successCriteria).toHaveLength(3);
    expect(b.successCriteria[0]).toEqual({ id: 'SC1', desc: 'The scoring function returns a value between 0 and 1.' });
    expect(b.successCriteria[2].id).toBe('SC3');
  });

  test('parses all constraint items', () => {
    const b = parsePrdBaseline(FULL_PRD);
    expect(b.constraints).toHaveLength(2);
    expect(b.constraints[0]).toEqual({ id: 'C1', desc: 'No external imports allowed in scoring logic.' });
  });

  test('extracts ontology keywords from Architecture section', () => {
    const b = parsePrdBaseline(FULL_PRD);
    // Should find backtick-quoted tokens and capitalized words
    expect(b.ontologyKeywords.length).toBeGreaterThan(0);
    // 'scoring' should appear from `scoring.mjs`
    expect(b.ontologyKeywords.some(k => k.includes('scoring'))).toBe(true);
  });
});

describe('parsePrdBaseline — minimal / missing sections', () => {
  test('returns empty arrays when no SC/constraint sections', () => {
    const b = parsePrdBaseline(MINIMAL_PRD);
    expect(b.successCriteria).toHaveLength(0);
    expect(b.constraints).toHaveLength(0);
  });

  test('still returns goal from minimal PRD', () => {
    const b = parsePrdBaseline(MINIMAL_PRD);
    expect(b.goal).toContain('Simple goal');
  });

  test('returns empty baseline for null/empty input', () => {
    expect(parsePrdBaseline(null)).toEqual({ goal: '', successCriteria: [], constraints: [], ontologyKeywords: [] });
    expect(parsePrdBaseline('')).toEqual({ goal: '', successCriteria: [], constraints: [], ontologyKeywords: [] });
  });
});

// ── Unit: computeDrift ────────────────────────────────────────────

const baseline = parsePrdBaseline(FULL_PRD);

describe('computeDrift — boundary scores (0 and 1)', () => {
  test('score = 0 when no tasks', () => {
    const r = computeDrift(baseline, [], { threshold: 0.75 });
    expect(r.goal_score).toBe(0);
    expect(r.weighted).toBeGreaterThanOrEqual(0);
    expect(r.weighted).toBeLessThanOrEqual(1);
    expect(r.gate_pass).toBe(false);
    expect(r.threshold).toBe(0.75);
  });

  test('gate_pass=true when threshold=0 and no tasks', () => {
    const r = computeDrift(baseline, [], { threshold: 0 });
    expect(r.gate_pass).toBe(true);
  });

  test('constraint_score=1 when no violation signals', () => {
    // Tasks that mention C1/C2 but with no violation keywords
    const tasks = [
      { id: 't1', name: 'Implement scoring [SC1] satisfying C1', status: 'completed', done_criteria: ['scoring returns 0 to 1'] },
    ];
    const r = computeDrift(baseline, tasks, { threshold: 0.5 });
    expect(r.constraint_score).toBe(1);
  });

  test('perfect score when all SCs covered', () => {
    const tasks = [
      { id: 't1', name: 'scoring function [SC1]', status: 'completed', done_criteria: ['returns value between 0 and 1'] },
      { id: 't2', name: 'gate pass logic [SC2]', status: 'completed', done_criteria: ['gate pass flag set correctly'] },
      { id: 't3', name: 'constraint violation detection [SC3]', status: 'completed', done_criteria: ['violations detected from task text'] },
    ];
    const r = computeDrift(baseline, tasks, { threshold: 0.75 });
    expect(r.goal_score).toBe(1);
    expect(r.constraint_score).toBe(1);
    expect(r.weighted).toBeGreaterThanOrEqual(0.75);
  });
});

describe('computeDrift — partial coverage', () => {
  test('partial goal coverage gives fractional score', () => {
    // Only SC1 covered
    const tasks = [
      { id: 't1', name: 'scoring returns 0 to 1 [SC1]', status: 'completed', done_criteria: [] },
    ];
    const r = computeDrift(baseline, tasks, { threshold: 0.75 });
    // goal_score should be ~0.33 (1/3 SC covered)
    expect(r.goal_score).toBeCloseTo(1 / 3, 1);
    expect(r.gate_pass).toBe(false);
  });

  test('pending tasks do not contribute to goal_score', () => {
    const tasks = [
      { id: 't1', name: 'scoring [SC1]', status: 'pending', done_criteria: [] },
      { id: 't2', name: 'gate [SC2]', status: 'completed', done_criteria: [] },
    ];
    const withPending = computeDrift(baseline, tasks, { threshold: 0.1 });
    const onlyCompleted = computeDrift(baseline, [tasks[1]], { threshold: 0.1 });
    expect(withPending.goal_score).toBe(onlyCompleted.goal_score);
  });

  test('weighted is within [0,1] for any input', () => {
    const tasks = [
      { id: 't1', name: 'SC1 task', status: 'completed', done_criteria: ['scoring'] },
    ];
    const r = computeDrift(baseline, tasks, { threshold: 0.5 });
    expect(r.weighted).toBeGreaterThanOrEqual(0);
    expect(r.weighted).toBeLessThanOrEqual(1);
  });

  test('constraint violation detected via violation keyword + C# id', () => {
    const tasks = [
      { id: 't1', name: 'C1 bypass workaround needed', status: 'in_progress', done_criteria: [] },
    ];
    const r = computeDrift(baseline, tasks, { threshold: 0.1 });
    // C1 is violated (bypass keyword + C1 mention)
    expect(r.constraint_score).toBeLessThan(1);
  });
});

describe('computeDrift — empty baseline', () => {
  test('returns 1.0 constraint_score for PRD with no constraints', () => {
    const minBaseline = parsePrdBaseline(MINIMAL_PRD);
    const r = computeDrift(minBaseline, [], { threshold: 0.5 });
    expect(r.constraint_score).toBe(1);
    expect(r.ontology_score).toBeGreaterThanOrEqual(0);
  });
});

// ── CLI integration: verify-drift command ─────────────────────────

function run(args, opts = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, XKIT_SERVER: undefined, ...opts.env },
    encoding: 'utf8',
    timeout: 15000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function setupProject(tmp, name = 'drift-test') {
  run(['init', name], { cwd: tmp });
  return name;
}

function projectPath(tmp, name, ...segments) {
  return join(tmp, '.xm', 'build', 'projects', name, ...segments);
}

function writePRD(tmp, name, content) {
  const dir = projectPath(tmp, name, 'phases', '02-plan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PRD.md'), content);
}

function writeTasks(tmp, name, tasks) {
  const dir = projectPath(tmp, name, 'phases', '02-plan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ tasks }, null, 2));
}

describe('verify-drift CLI', () => {
  test('shows message when no PRD exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-drift-'));
    try {
      setupProject(tmp);
      const r = run(['verify-drift'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('No PRD');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('creates drift-score.json with all required fields', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-drift-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, FULL_PRD);
      writeTasks(tmp, name, [
        { id: 't1', name: 'scoring function [SC1]', status: 'completed', done_criteria: ['returns value 0 to 1'] },
        { id: 't2', name: 'gate pass logic [SC2]', status: 'completed', done_criteria: ['flag set correctly'] },
        { id: 't3', name: 'constraint detection [SC3]', status: 'completed', done_criteria: ['violations detected'] },
      ]);

      const r = run(['verify-drift'], { cwd: tmp });
      expect(r.stdout).toContain('PRD Drift Score');

      const outPath = projectPath(tmp, name, 'phases', '04-verify', 'drift-score.json');
      expect(existsSync(outPath)).toBe(true);

      const score = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(typeof score.goal_score).toBe('number');
      expect(typeof score.constraint_score).toBe('number');
      expect(typeof score.ontology_score).toBe('number');
      expect(typeof score.weighted).toBe('number');
      expect(typeof score.gate_pass).toBe('boolean');
      expect(typeof score.threshold).toBe('number');
      expect(score.baseline_summary.success_criteria_count).toBe(3);
      expect(score.baseline_summary.constraints_count).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('gate PASS when all SCs covered (exitCode 0)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-drift-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, FULL_PRD);
      writeTasks(tmp, name, [
        { id: 't1', name: '[SC1] scoring', status: 'completed', done_criteria: ['value between 0 and 1'] },
        { id: 't2', name: '[SC2] gate', status: 'completed', done_criteria: ['flag set correctly based on threshold'] },
        { id: 't3', name: '[SC3] constraint violation', status: 'completed', done_criteria: ['violations are detected'] },
      ]);

      const r = run(['verify-drift', '--threshold', '0.1'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('PASS');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('gate FAIL when no tasks (exitCode 1)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-drift-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, FULL_PRD);
      // no tasks written — default empty

      const r = run(['verify-drift', '--threshold', '0.75'], { cwd: tmp });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('FAIL');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--threshold flag overrides default', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-drift-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, FULL_PRD);

      const r = run(['verify-drift', '--threshold', '0'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const outPath = projectPath(tmp, name, 'phases', '04-verify', 'drift-score.json');
      const score = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(score.threshold).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Unit: shareStem ───────────────────────────────────────────────

describe('shareStem', () => {
  test('returns true when one token starts with the other (>=5 chars)', () => {
    expect(shareStem('validation', 'validate')).toBe(true);
    expect(shareStem('validate', 'validation')).toBe(true);
    expect(shareStem('simulator', 'simulate')).toBe(true);
  });

  test('returns true when tokens share a common prefix of >=5 chars', () => {
    expect(shareStem('computation', 'computer')).toBe(true); // "comput" = 6 chars shared
    expect(shareStem('validates', 'validated')).toBe(true);  // "validat" = 7 chars shared
  });

  test('returns false when shared prefix is shorter than 5 chars', () => {
    expect(shareStem('scoring', 'scored')).toBe(false);  // common prefix "scor" = 4 chars < 5
    expect(shareStem('xyabc', 'xyzab')).toBe(false);    // common prefix "xy" = 2 chars < 5
  });

  test('returns false when second token is shorter than 5 chars', () => {
    expect(shareStem('validation', 'val')).toBe(false);
    expect(shareStem('scoring', 'scor')).toBe(false);
  });
});

// ── Unit: ontology fallback path ──────────────────────────────────

const FALLBACK_PRD = `# PRD — fallback

## 1. Goal
Build a ReliableScorer that handles DataValidation and ensures GatePass.

## 2. Success Criteria
- [SC1] The Scorer returns correct results.
`;

describe('ontology fallback (no Architecture / Data Model sections)', () => {
  test('uses capitalized words from goal + SC when no arch/data sections', () => {
    const b = parsePrdBaseline(FALLBACK_PRD);
    // Should fall back to capitalized words: ReliableScorer, DataValidation, GatePass, Scorer
    expect(b.ontologyKeywords.length).toBeGreaterThan(0);
    expect(b.ontologyKeywords.some(k => k === 'reliablescorer' || k === 'scorer')).toBe(true);
  });

  test('ontology fallback keywords are used in ontology_score computation', () => {
    const b = parsePrdBaseline(FALLBACK_PRD);
    // Task that mentions one of the fallback keywords
    const tasks = [
      { id: 't1', name: 'implement reliablescorer', status: 'completed', done_criteria: ['scorer returns correct results'] },
    ];
    const r = computeDrift(b, tasks, { threshold: 0 });
    // ontology_score should be > 0 because fallback keywords exist and task mentions them
    expect(r.ontology_score).toBeGreaterThan(0);
  });

  test('ontology_score = 1.0 when baseline has no ontology keywords at all', () => {
    // parsePrdBaseline of minimal PRD may produce some fallback keywords,
    // but a manually constructed baseline with empty keywords should score 1.0
    const emptyBaseline = { goal: '', successCriteria: [], constraints: [], ontologyKeywords: [] };
    const r = computeDrift(emptyBaseline, [], { threshold: 0 });
    expect(r.ontology_score).toBe(1);
  });
});
