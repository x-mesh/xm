import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

// Default cwd for cwd-less run() calls must NEVER be the host repo: a subprocess
// that reaches gitAutoCommit would commit the dev's pre-staged files into a tm()
// task commit (RV-2 / X-9-class test-isolation failure). Isolate it to a temp dir.
const RUN_DEFAULT_CWD = mkdtempSync(join(tmpdir(), 'xb-nocwd-'));
function run(args, opts = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd ?? RUN_DEFAULT_CWD,
    env: { ...process.env, XKIT_SERVER: undefined, ...opts.env },
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function setupProject(tmp, name = 'test-proj') {
  run(['init', name], { cwd: tmp });
  return name;
}

// research/plan exit gates default to 'human-verify' (config-schema), so a plain
// `phase next` now BLOCKS on them. Mechanics tests opt into auto gates.
function autoGates(tmp) {
  const p = join(tmp, '.xm', 'config.json');
  mkdirSync(dirname(p), { recursive: true });
  const cfg = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  cfg.gates = { 'research-exit': 'auto', 'plan-exit': 'auto', 'execute-exit': 'auto', 'verify-exit': 'auto', 'close-exit': 'auto' };
  writeFileSync(p, JSON.stringify(cfg));
}

function projectPath(tmp, name, ...segments) {
  return join(tmp, '.xm', 'build', 'projects', name, ...segments);
}

function writePRD(tmp, name) {
  const dir = projectPath(tmp, name, 'phases', '02-plan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PRD.md'), '# PRD\n\n## 1. Goal\nTest project\n');
}

// ── Phase transitions ─────────────────────────────────────────────

describe('phase transitions', () => {
  test('phase next advances research to plan when research-exit gate is auto', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      autoGates(tmp); // research-exit defaults to human-verify; opt into auto for the mechanics test
      const r = run(['phase', 'next'], { cwd: tmp });
      expect(r.stdout).toContain('Plan');
      const manifest = readJSON(projectPath(tmp, name, 'manifest.json'));
      expect(manifest.current_phase).toBe('02-plan');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('gate pass + phase next advances to plan', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      // Create minimal research artifacts
      writeFileSync(projectPath(tmp, name, 'context', 'CONTEXT.md'), '# Context\nGoal: test');
      run(['gate', 'pass', 'Research done'], { cwd: tmp });
      run(['phase', 'next'], { cwd: tmp });
      const manifest = readJSON(projectPath(tmp, name, 'manifest.json'));
      expect(manifest.current_phase).toBe('02-plan');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase set skips directly to execute', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name);
      run(['phase', 'set', 'execute'], { cwd: tmp });
      const manifest = readJSON(projectPath(tmp, name, 'manifest.json'));
      expect(manifest.current_phase).toBe('03-execute');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase set to verify', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name);
      run(['phase', 'set', 'verify'], { cwd: tmp });
      const manifest = readJSON(projectPath(tmp, name, 'manifest.json'));
      expect(manifest.current_phase).toBe('04-verify');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('invalid phase sub-command rejected', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['phase', 'invalid'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Delta PRD tier makes the Quick Mode path reachable (빌드6) ──────
// Quick Mode docs say "phase set execute" after a lightweight plan, but the
// Execute-entry wall requires a PRD to exist. A delta PRD (Goal+SC+AC, no
// template-version marker) satisfies the wall AND stays warning-only in prd-check.

describe('delta PRD tier', () => {
  const DELTA_PRD = '<!-- prd-tier: delta -->\n# PRD: Build X\n\n## Goal\nShip X.\n\n## Success Criteria\n- [ ] X works\n\n## 12. Acceptance Criteria\n- [ ] X returns 200 [R1]\n';

  test('a delta PRD is not blocked by prd-check and is tagged tier=delta', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-delta-'));
    try {
      const name = setupProject(tmp);
      const dir = projectPath(tmp, name, 'phases', '02-plan');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'PRD.md'), DELTA_PRD);
      const pc = JSON.parse(run(['prd-check', '--json'], { cwd: tmp }).stdout);
      expect(pc.blocked).toBe(false);
      expect(pc.tier).toBe('delta');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase set execute reaches Execute with only a delta PRD (documented Quick Mode path)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-delta-'));
    try {
      const name = setupProject(tmp);
      const dir = projectPath(tmp, name, 'phases', '02-plan');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'PRD.md'), DELTA_PRD);
      run(['phase', 'set', 'execute'], { cwd: tmp });
      expect(readJSON(projectPath(tmp, name, 'manifest.json')).current_phase).toBe('03-execute');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Phase exit gates are actually enforced (빌드1) ─────────────────
// Before 빌드1 every gate silently resolved to 'auto' (phase.mjs read gates from an
// unwritten file). These lock in that the schema's human-verify default now blocks,
// exits 2, records a ledger, and clears only on gate pass.

describe('phase exit gates are enforced', () => {
  test('human-verify default blocks phase next with exit 2 + a ledger entry', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-gate-'));
    try {
      const name = setupProject(tmp); // research-exit defaults to human-verify
      const r = run(['phase', 'next'], { cwd: tmp });
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toContain('requires human verification');
      // did NOT advance
      expect(readJSON(projectPath(tmp, name, 'manifest.json')).current_phase).toBe('01-research');
      // ledger recorded the block
      const status = readJSON(projectPath(tmp, name, 'phases', '01-research', 'status.json'));
      expect(status.gate.gate_type).toBe('human-verify');
      expect(status.gate.passed).toBe(false);
      // status --json surfaces resolved type + ledger
      const sj = JSON.parse(run(['status', '--json'], { cwd: tmp }).stdout);
      const research = sj.phases.find(p => p.id === '01-research');
      expect(research.gate_type).toBe('human-verify');
      expect(research.gate.passed).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('gate pass clears the gate; ledger shows passed_by=human', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-gate-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(projectPath(tmp, name, 'context', 'CONTEXT.md'), '# Context\nGoal: test');
      run(['gate', 'pass', 'Research verified'], { cwd: tmp });
      run(['phase', 'next'], { cwd: tmp });
      expect(readJSON(projectPath(tmp, name, 'manifest.json')).current_phase).toBe('02-plan');
      const status = readJSON(projectPath(tmp, name, 'phases', '01-research', 'status.json'));
      expect(status.gate.passed).toBe(true);
      expect(status.gate.passed_by).toBe('human');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('an explicit auto gate passes and records passed_by=auto', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-gate-'));
    try {
      const name = setupProject(tmp);
      autoGates(tmp);
      run(['phase', 'next'], { cwd: tmp });
      const status = readJSON(projectPath(tmp, name, 'phases', '01-research', 'status.json'));
      expect(status.gate.gate_type).toBe('auto');
      expect(status.gate.passed).toBe(true);
      expect(status.gate.passed_by).toBe('auto');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Checkpoint ────────────────────────────────────────────────────

describe('checkpoint', () => {
  test('checkpoint records marker', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['checkpoint', 'auto', 'Test checkpoint'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('checkpoint');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Verify coverage ───────────────────────────────────────────────

describe('verify-coverage', () => {
  test('detects covered and uncovered requirements', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'context', 'REQUIREMENTS.md'),
        '- [R1] User authentication\n- [R2] CRUD API\n- [R3] Admin panel\n'
      );
      run(['tasks', 'add', 'Implement auth [R1]'], { cwd: tmp });
      run(['tasks', 'add', 'Build CRUD API [R2]'], { cwd: tmp });

      const r = run(['verify-coverage'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[covered]');
      expect(r.stdout).toContain('[missing]');
      expect(r.stdout).toContain('R3');
      expect(r.stdout).toContain('2/3');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('100% coverage shows all covered', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'context', 'REQUIREMENTS.md'),
        '- [R1] Auth\n- [R2] API\n'
      );
      run(['tasks', 'add', 'Auth [R1]'], { cwd: tmp });
      run(['tasks', 'add', 'API [R2]'], { cwd: tmp });

      const r = run(['verify-coverage'], { cwd: tmp });
      expect(r.stdout).toContain('All requirements covered');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no requirements file shows message', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['verify-coverage'], { cwd: tmp });
      expect(r.stdout).toContain('No REQUIREMENTS');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Verify traceability ───────────────────────────────────────────

describe('verify-traceability', () => {
  test('full traceability with PRD + tasks + done_criteria', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'context', 'REQUIREMENTS.md'),
        '- [R1] Auth\n- [R2] API\n'
      );
      writeFileSync(
        projectPath(tmp, name, 'phases', '02-plan', 'PRD.md'),
        '# PRD\n## 8. Acceptance Criteria\n- [ ] User can login [R1]\n- [ ] CRUD works [R2]\n'
      );
      run(['tasks', 'add', 'Auth [R1]', '--done-criteria', 'Login works'], { cwd: tmp });
      run(['tasks', 'add', 'API [R2]', '--done-criteria', 'CRUD works'], { cwd: tmp });

      const r = run(['verify-traceability'], { cwd: tmp });
      expect(r.stdout).toContain('Traceability Matrix');
      expect(r.stdout).toContain('full');

      // Check saved JSON
      const traceFile = projectPath(tmp, name, 'phases', '04-verify', 'traceability.json');
      expect(existsSync(traceFile)).toBe(true);
      const trace = readJSON(traceFile);
      expect(trace.fully_covered).toBe(2);
      expect(trace.gaps).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('partial traceability detected', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'context', 'REQUIREMENTS.md'),
        '- [R1] Auth\n- [R2] API\n'
      );
      // Task without done_criteria, no PRD AC
      run(['tasks', 'add', 'Auth [R1]'], { cwd: tmp });

      const r = run(['verify-traceability'], { cwd: tmp });
      expect(r.stdout).toContain('partial');
      expect(r.stdout).toContain('gaps');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── AC parser vs current PRD template (regression) ────────────────
// The parser hardcoded `(?:8\.)?` while the template numbers the section
// "## 12. Acceptance Criteria" — every current-template PRD silently
// parsed 0 ACs. The regex is now `(?:\d+\.)?`, a PRD-present/0-AC state
// warns loudly, and verify-traceability exits non-zero on any gap.
describe('AC parser + traceability artifact (regression)', () => {
  test('REQUIREMENTS.md with no parseable R# items → loud failure, fresh artifact, non-zero exit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'context', 'REQUIREMENTS.md'),
        'free-form notes with no structured requirement items\n'
      );
      // A stale artifact from a previous run must be replaced, not left masquerading as current.
      writeFileSync(
        projectPath(tmp, name, 'phases', '04-verify', 'traceability.json'),
        JSON.stringify({ total: 9, gaps: 0, matrix: [{ req_id: 'R9', coverage: 'full' }] })
      );

      const r = run(['verify-traceability'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0); // zero requirements is a vacuous pass, not a green gate
      expect(r.stdout).toContain('No structured requirements');

      const trace = readJSON(projectPath(tmp, name, 'phases', '04-verify', 'traceability.json'));
      expect(trace.total).toBe(0);
      expect(trace.matrix.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('ACs under "## 12. Acceptance Criteria" parse; full coverage exits 0 with coverage:"full"', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'context', 'REQUIREMENTS.md'),
        '- [R1] Auth\n- [R2] API\n'
      );
      writeFileSync(
        projectPath(tmp, name, 'phases', '02-plan', 'PRD.md'),
        '# PRD\n## 12. Acceptance Criteria\n- [ ] User can login [R1]\n- [ ] CRUD works [R2]\n\n## 13. Boundaries\n- none\n'
      );
      run(['tasks', 'add', 'Auth [R1]', '--done-criteria', 'Login works'], { cwd: tmp });
      run(['tasks', 'add', 'API [R2]', '--done-criteria', 'CRUD works'], { cwd: tmp });

      const r = run(['verify-traceability'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('0 acceptance criteria parsed');

      const trace = readJSON(projectPath(tmp, name, 'phases', '04-verify', 'traceability.json'));
      expect(trace.fully_covered).toBe(2);
      expect(trace.gaps).toBe(0);
      for (const row of trace.matrix) {
        expect(row.coverage).toBe('full');
        expect(row.acceptance_criteria).toBe(1);
      }
      expect(trace.matrix.map((m) => m.req_id)).toEqual(['R1', 'R2']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('PRD present but 0 parseable ACs warns loudly in verify-traceability and tasks done-criteria', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'context', 'REQUIREMENTS.md'),
        '- [R1] Auth\n'
      );
      writePRD(tmp, name); // "## 1. Goal" only — no AC section
      run(['tasks', 'add', 'Auth [R1]'], { cwd: tmp });

      const trace = run(['verify-traceability'], { cwd: tmp });
      expect(trace.stdout).toContain('0 acceptance criteria parsed');

      const dc = run(['tasks', 'done-criteria'], { cwd: tmp });
      expect(dc.stdout).toContain('0 acceptance criteria parsed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a requirement with no matching task writes coverage:"gap" and forces a non-zero exit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'context', 'REQUIREMENTS.md'),
        '- [R1] Auth\n- [R2] API\n'
      );
      writeFileSync(
        projectPath(tmp, name, 'phases', '02-plan', 'PRD.md'),
        '# PRD\n## 12. Acceptance Criteria\n- [ ] User can login [R1]\n'
      );
      run(['tasks', 'add', 'Auth [R1]', '--done-criteria', 'Login works'], { cwd: tmp });

      const r = run(['verify-traceability'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);

      const trace = readJSON(projectPath(tmp, name, 'phases', '04-verify', 'traceability.json'));
      expect(trace.gaps).toBe(1);
      expect(trace.matrix.find((m) => m.req_id === 'R1').coverage).toBe('full');
      expect(trace.matrix.find((m) => m.req_id === 'R2').coverage).toBe('gap');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('tasks done-criteria derives criteria from a "## 12." AC section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(
        projectPath(tmp, name, 'phases', '02-plan', 'PRD.md'),
        '# PRD\n## 12. Acceptance Criteria\n- [ ] Login works [R1]\n'
      );
      run(['tasks', 'add', 'Auth [R1]'], { cwd: tmp });

      const r = run(['tasks', 'done-criteria'], { cwd: tmp });
      expect(r.exitCode).toBe(0);

      const tasks = readJSON(projectPath(tmp, name, 'phases', '02-plan', 'tasks.json'));
      expect(tasks.tasks[0].done_criteria).toContain('Login works [R1]');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Verify contracts ──────────────────────────────────────────────

describe('verify-contracts', () => {
  test('lists completed tasks with done_criteria', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Auth [R1]', '--done-criteria', 'Login works;Tests pass'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'completed'], { cwd: tmp });

      const r = run(['verify-contracts'], { cwd: tmp });
      expect(r.stdout).toContain('Acceptance Contract');
      expect(r.stdout).toContain('Login works');
      expect(r.stdout).toContain('Tests pass');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no completed tasks shows message', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['verify-contracts'], { cwd: tmp });
      expect(r.stdout).toContain('No completed tasks');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Verify review-fix gate ────────────────────────────────────────

function writeReviewResult(tmp, review = {}) {
  const dir = join(tmp, '.xm', 'review');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'last-result.json'), JSON.stringify({
    reviewed_commit: 'abc1234',
    verdict: 'request_changes',
    findings: [
      {
        severity: 'high',
        lens: 'logic',
        file: 'src/auth.ts',
        line: 42,
        summary: 'Auth bypass on missing token',
      },
      {
        severity: 'low',
        lens: 'docs',
        file: 'src/auth.ts',
        line: 7,
        summary: 'Missing comment',
      },
    ],
    ...review,
  }, null, 2));
}

describe('verify-review-fix', () => {
  test('--init creates triage template from last x-review result', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp);

      const r = run(['verify-review-fix', '--init'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('triage template');

      const triage = readJSON(join(tmp, '.xm', 'review', 'triage.json'));
      expect(triage.target_findings[0].id).toBe('F1');
      expect(triage.target_findings[0].decision).toBe('fix_now');
      expect(Array.isArray(triage.baseline_changed_files)).toBe(true);
      expect(triage.fix_scope.allowed_files).toContain('src/auth.ts');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('fails when Request Changes review has no triage', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp);

      const r = run(['verify-review-fix'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain('Review Fix Gate failed');
      expect(r.stdout).toContain('Missing triage file');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('passes with valid triage and verification contract', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp);
      mkdirSync(join(tmp, '.xm', 'review'), { recursive: true });
      writeFileSync(join(tmp, '.xm', 'review', 'triage.json'), JSON.stringify({
        reviewed_commit: 'abc1234',
        target_findings: [
          { id: 'F1', decision: 'fix_now', evidence: 'Reproduced by auth test' },
        ],
        fix_scope: { allowed_files: ['src/auth.ts'] },
        verification: ['bun test auth'],
      }, null, 2));

      const r = run(['verify-review-fix'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Review Fix Gate passed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('blocks Critical and High findings moved to backlog', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp);
      writeFileSync(join(tmp, '.xm', 'review', 'triage.json'), JSON.stringify({
        reviewed_commit: 'abc1234',
        target_findings: [
          { id: 'F1', decision: 'backlog', evidence: 'later' },
        ],
        fix_scope: { allowed_files: ['src/auth.ts'] },
        verification: ['bun test auth'],
      }, null, 2));

      const r = run(['verify-review-fix'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain('cannot be moved to backlog');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('passes immediately when verdict is LGTM with no triage-required findings', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp, {
        verdict: 'lgtm',
        findings: [
          { severity: 'low', lens: 'docs', file: 'src/x.ts', line: 1, summary: 'minor' },
        ],
      });

      const r = run(['verify-review-fix'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Review Fix Gate passed');
      expect(existsSync(join(tmp, '.xm', 'review', 'triage.json'))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('fails when triage reviewed_commit does not match last-result reviewed_commit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp);
      mkdirSync(join(tmp, '.xm', 'review'), { recursive: true });
      writeFileSync(join(tmp, '.xm', 'review', 'triage.json'), JSON.stringify({
        reviewed_commit: 'stale000',
        target_findings: [
          { id: 'F1', decision: 'fix_now', evidence: 'fixed' },
        ],
        fix_scope: { allowed_files: ['src/auth.ts'] },
        verification: ['bun test auth'],
      }, null, 2));

      const r = run(['verify-review-fix'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain('reviewed_commit does not match');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('requires explicit triage decision for Medium findings (no auto-backlog)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeReviewResult(tmp, {
        findings: [
          { severity: 'medium', lens: 'logic', file: 'src/cache.ts', line: 15, summary: 'O(n^2) lookup' },
        ],
      });

      const init = run(['verify-review-fix', '--init'], { cwd: tmp });
      expect(init.exitCode).toBe(0);
      const triage = readJSON(join(tmp, '.xm', 'review', 'triage.json'));
      expect(triage.target_findings[0].decision).toBe('');

      const verify = run(['verify-review-fix'], { cwd: tmp });
      expect(verify.exitCode).not.toBe(0);
      expect(verify.stdout).toContain('requires an explicit triage decision');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Later ──────────────────────────────────────────────────────────

describe('later', () => {
  test('adds and lists off-scope items without creating tasks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);

      const add = run([
        'later', 'add', 'Fix unrelated cache warning',
        '--reason', 'Found while touching auth but does not affect auth fix',
        '--source', 'review-fix:F2',
        '--files', 'src/cache.ts',
      ], { cwd: tmp });
      expect(add.exitCode).toBe(0);
      expect(add.stdout).toContain('l1');

      const list = run(['later', 'list'], { cwd: tmp });
      expect(list.stdout).toContain('Fix unrelated cache warning');
      expect(list.stdout).toContain('src/cache.ts');

      const tasks = readJSON(projectPath(tmp, name, 'phases', '02-plan', 'tasks.json'));
      expect(tasks?.tasks?.length ?? 0).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects items that affect the current task', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);

      const r = run([
        'later', 'add', 'Fix auth regression',
        '--impact', 'blocks-current',
      ], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('not safely deferable');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('validates current task references', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);

      const missing = run([
        'later', 'add', 'Fix unrelated cache warning',
        '--task', 't9',
      ], { cwd: tmp });
      expect(missing.exitCode).not.toBe(0);
      expect(missing.stderr).toContain('Unknown current task');

      run(['tasks', 'add', 'Current auth fix'], { cwd: tmp });
      const add = run([
        'later', 'add', 'Fix unrelated cache warning',
        '--task', 't1',
      ], { cwd: tmp });
      expect(add.exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('promotes later item to a task when ready', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['later', 'add', 'Fix unrelated cache warning', '--reason', 'Separate cleanup'], { cwd: tmp });

      const promote = run(['later', 'promote', 'l1', '--size', 'small'], { cwd: tmp });
      expect(promote.exitCode).toBe(0);
      expect(promote.stdout).toContain('l1');
      expect(promote.stdout).toContain('t1');

      const tasks = readJSON(projectPath(tmp, name, 'phases', '02-plan', 'tasks.json'));
      expect(tasks.tasks[0].name).toBe('Fix unrelated cache warning');
      expect(tasks.tasks[0].source).toBe('later:l1');

      const lot = readJSON(projectPath(tmp, name, 'later.json'));
      expect(lot.items[0].status).toBe('promoted');
      expect(lot.items[0].promoted_task_id).toBe('t1');

      const list = run(['later', 'list', '--status', 'all'], { cwd: tmp });
      expect(list.stdout).toContain('promoted: t1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('verify-scope fails when open later files change before promotion', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'cache.ts'), 'export const value = 1;\n');

      const add = run([
        'later', 'add', 'Fix unrelated cache warning',
        '--files', 'src/cache.ts',
      ], { cwd: tmp });
      expect(add.exitCode).toBe(0);

      const lot = readJSON(projectPath(tmp, name, 'later.json'));
      expect(lot.items[0].file_snapshots[0].file).toBe('src/cache.ts');
      expect(lot.items[0].file_snapshots[0].sha256).toHaveLength(64);

      const before = run(['later', 'verify-scope'], { cwd: tmp });
      expect(before.exitCode).toBe(0);

      writeFileSync(join(tmp, 'src', 'cache.ts'), 'export const value = 2;\n');
      const changed = run(['later', 'verify-scope'], { cwd: tmp });
      expect(changed.exitCode).not.toBe(0);
      expect(changed.stdout).toContain('Later scope check failed');
      expect(changed.stdout).toContain('src/cache.ts changed');

      run(['later', 'promote', 'l1'], { cwd: tmp });
      const promoted = run(['later', 'verify-scope'], { cwd: tmp });
      expect(promoted.exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('dismisses an open later item and records the reason', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['later', 'add', 'Old refactor idea', '--reason', 'Initial idea'], { cwd: tmp });

      const dismiss = run(['later', 'dismiss', 'l1', '--reason', 'Decided not needed'], { cwd: tmp });
      expect(dismiss.exitCode).toBe(0);
      expect(dismiss.stdout).toContain('l1');

      const lot = readJSON(projectPath(tmp, name, 'later.json'));
      expect(lot.items[0].status).toBe('dismissed');
      expect(lot.items[0].dismiss_reason).toBe('Decided not needed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('rejects dismiss of an already-promoted later item', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['later', 'add', 'Fix unrelated cache warning', '--reason', 'Separate cleanup'], { cwd: tmp });
      run(['later', 'promote', 'l1', '--size', 'small'], { cwd: tmp });

      const dismiss = run(['later', 'dismiss', 'l1'], { cwd: tmp });
      expect(dismiss.exitCode).not.toBe(0);
      expect(dismiss.stderr).toContain('already promoted');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Quality ───────────────────────────────────────────────────────

describe('quality', () => {
  test('quality runs without crash', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['quality'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      // Should show quality check output (might detect no tools)
      expect(r.stdout).toContain('quality');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('quality uses detected package manager for package scripts', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeFileSync(join(tmp, 'package.json'), JSON.stringify({
        scripts: {
          test: 'echo test-ok',
          build: 'echo build-ok',
        },
      }, null, 2));
      writeFileSync(join(tmp, 'bun.lockb'), '');

      const r = run(['quality'], { cwd: tmp });
      expect(r.exitCode).toBe(0);

      const quality = readJSON(projectPath(tmp, name, 'phases', '04-verify', 'quality-results.json'));
      expect(quality.results.find((check) => check.check === 'bun-test')?.passed).toBe(true);
      expect(quality.results.find((check) => check.check === 'bun-build')?.passed).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Handoff ───────────────────────────────────────────────────────

describe('handoff', () => {
  test('handoff saves session state', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      const r = run(['handoff'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(existsSync(projectPath(tmp, name, 'HANDOFF.json'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('handoff --restore shows saved state', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['handoff'], { cwd: tmp });
      const r = run(['handoff', '--restore'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Task A');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── run --json budget gate (regression) ─────────────────────────────
// Regression for: the --json execution plan (consumed by the skill layer to
// spawn agents) bypassed the budget gate entirely — only the human-readable
// path enforced it. A budget below the projected cost must block --json runs
// too (blocked:true, empty tasks, exit 1), not silently emit a spawnable plan.
describe('run --json budget gate (regression)', () => {
  let BUDGET_HOME;

  beforeAll(() => {
    // Isolated HOME so the developer's global ~/.xm/config.json budget (if any)
    // cannot perturb these assertions.
    BUDGET_HOME = mkdtempSync(join(tmpdir(), 'xb-budget-home-'));
  });

  afterAll(() => {
    rmSync(BUDGET_HOME, { recursive: true, force: true });
  });

  function driveToExecute(tmp) {
    const env = { HOME: BUDGET_HOME };
    const name = setupProject(tmp);
    run(['tasks', 'add', 'Build feature A'], { cwd: tmp, env });
    run(['tasks', 'add', 'Write tests B'], { cwd: tmp, env });
    writePRD(tmp, name);
    run(['phase', 'set', 'execute'], { cwd: tmp, env });
    run(['steps', 'compute'], { cwd: tmp, env });
    return name;
  }

  function writeBudget(tmp, maxUsd) {
    const dir = join(tmp, '.xm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ budget: { max_usd: maxUsd } }, null, 2));
  }

  test('emits a spawnable plan when no budget is configured', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      driveToExecute(tmp);
      const r = run(['run', '--json'], { cwd: tmp, env: { HOME: BUDGET_HOME } });
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.tasks.length).toBeGreaterThan(0);
      expect(typeof out.estimated_cost_usd).toBe('number');
      expect(out.tasks[0].on_complete).toMatch(/^xm build tasks update t\d+ --status completed$/);
      expect(out.tasks[0].on_fail).toMatch(/^xm build tasks update t\d+ --status failed$/);
      expect(out.blocked).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('blocks the --json plan when projected cost exceeds budget', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      driveToExecute(tmp);
      writeBudget(tmp, 0.0001); // far below any real task cost
      const r = run(['run', '--json'], { cwd: tmp, env: { HOME: BUDGET_HOME } });
      const out = JSON.parse(r.stdout);
      expect(out.blocked).toBe(true);
      expect(out.blocked_reason).toBe('budget_exceeded');
      expect(out.tasks).toEqual([]);
      expect(out.budget.level).toBe('exceeded');
      expect(r.exitCode).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('per-project {max_usd} cap blocks the --json plan (project passed through to checkBudget)', () => {
    // Regression: cmdRun called checkBudget(cost) without the project, so
    // budget.projects caps never applied on `run`. The documented object
    // shape { max_usd } must gate the plan and be surfaced in the verdict.
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = driveToExecute(tmp);
      const dir = join(tmp, '.xm');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), JSON.stringify({
        budget: { max_usd: 100, projects: { [name]: { max_usd: 0.0001 } } },
      }, null, 2));

      const r = run(['run', '--json'], { cwd: tmp, env: { HOME: BUDGET_HOME } });
      const out = JSON.parse(r.stdout);
      expect(out.blocked).toBe(true);
      expect(out.blocked_reason).toBe('budget_exceeded');
      expect(out.budget.ok).toBe(false);
      expect(out.budget.level).toBe('exceeded');
      expect(out.budget.project).toBe(name); // the binding cap is named
      expect(out.budget.max_usd).toBe(0.0001);
      expect(r.exitCode).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── cost: actual-token ingestion + profile-aware --json (regression) ─
// Regression for two audit findings:
//  - cost "actuals" were circular: estimates were recorded then averaged back
//    as "actuals". Real token counts must record cost_source:'actual'.
//  - run --json emitted models from a hardcoded map that ignored model_profile,
//    so the actual spawn path bypassed cost routing.
describe('cost: actual-token ingestion + profile-aware --json (regression)', () => {
  let CHOME;

  beforeAll(() => { CHOME = mkdtempSync(join(tmpdir(), 'xb-cost-home-')); });
  afterAll(() => { rmSync(CHOME, { recursive: true, force: true }); });

  function readMetrics(tmp) {
    const f = join(tmp, '.xm', 'build', 'metrics', 'sessions.jsonl');
    return readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  }

  function driveToExecute(tmp) {
    const env = { HOME: CHOME };
    const name = setupProject(tmp);
    run(['tasks', 'add', 'Build feature A'], { cwd: tmp, env });
    run(['tasks', 'add', 'Write tests B'], { cwd: tmp, env });
    writePRD(tmp, name);
    run(['phase', 'set', 'execute'], { cwd: tmp, env });
    run(['steps', 'compute'], { cwd: tmp, env });
    return name;
  }

  test('--tokens-in/--tokens-out records measured cost tagged actual', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const env = { HOME: CHOME };
      setupProject(tmp);
      run(['tasks', 'add', 'Build feature A'], { cwd: tmp, env });
      run(['tasks', 'update', 't1', '--status', 'running'], { cwd: tmp, env });
      run(['tasks', 'update', 't1', '--status', 'completed', '--tokens-in', '120000', '--tokens-out', '45000', '--no-commit'], { cwd: tmp, env });

      const m = readMetrics(tmp).reverse().find((x) => x.type === 'task_complete' && x.taskId === 't1');
      expect(m).toBeTruthy();
      expect(m.cost_source).toBe('actual');
      expect(m.tokens_in).toBe(120000);
      expect(m.tokens_out).toBe(45000);
      expect(m.actual_cost_usd).toBeGreaterThan(0);
      expect(m.cost_usd).toBe(m.actual_cost_usd);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('completion without tokens is tagged estimated (excluded from actuals)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const env = { HOME: CHOME };
      setupProject(tmp);
      run(['tasks', 'add', 'Build feature A'], { cwd: tmp, env });
      run(['tasks', 'update', 't1', '--status', 'running'], { cwd: tmp, env });
      run(['tasks', 'update', 't1', '--status', 'completed', '--no-commit'], { cwd: tmp, env });

      const m = readMetrics(tmp).reverse().find((x) => x.type === 'task_complete' && x.taskId === 't1');
      expect(m.cost_source).toBe('estimated');
      expect(m.actual_cost_usd).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a measured completion auto-refreshes token-actuals.json (빌드3)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const env = { HOME: CHOME };
      setupProject(tmp);
      run(['tasks', 'add', 'Feature'], { cwd: tmp, env });
      run(['tasks', 'update', 't1', '--status', 'running'], { cwd: tmp, env });
      run(['tasks', 'update', 't1', '--status', 'completed', '--tokens-in', '100000', '--tokens-out', '40000', '--no-commit'], { cwd: tmp, env });
      // computeTokenActuals ran automatically — no manual `forecast update` needed.
      const actualsPath = join(tmp, '.xm', 'build', 'metrics', 'token-actuals.json');
      expect(existsSync(actualsPath)).toBe(true);
      const actuals = JSON.parse(readFileSync(actualsPath, 'utf8'));
      const measured = Object.values(actuals.sample_counts).reduce((a, b) => a + b, 0);
      expect(measured).toBe(1); // the one measured task, counted under its size
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('run --json honors model_profile (economy → sonnet, max → opus)', () => {
    // A fresh project per profile: run --json now marks tasks RUNNING (keystone),
    // so a second run --json on the same project finds nothing ready — each
    // profile must be checked on its own first run.
    // default.executor is sonnet by measurement (docs/phase-model-routing-experiment.md);
    // max keeps opus, so the profile axis is still observable end-to-end.
    for (const [profile, expected] of [['economy', 'sonnet'], ['max', 'opus']]) {
      const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
      try {
        driveToExecute(tmp);
        writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({ model_profile: profile }));
        const out = JSON.parse(run(['run', '--json'], { cwd: tmp, env: { HOME: CHOME } }).stdout);
        expect(out.tasks.find((t) => t.role === 'executor').model).toBe(expected);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  test('keystone: run --json marks RUNNING so completion records a metric with the plan model', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const env = { HOME: CHOME };
      driveToExecute(tmp);
      writeFileSync(join(tmp, '.xm', 'config.json'), JSON.stringify({ model_profile: 'max' })); // executor -> opus
      const plan = JSON.parse(run(['run', '--json'], { cwd: tmp, env }).stdout);
      expect(plan.tasks.find((t) => t.task_id === 't1').model).toBe('opus');

      // Complete via the json-driven path; before the keystone this recorded
      // no metric (started_at unset) or model='sonnet' (_assigned_model unset).
      run(['tasks', 'update', 't1', '--status', 'completed', '--no-commit'], { cwd: tmp, env });
      const m = readMetrics(tmp).reverse().find((x) => x.type === 'task_complete' && x.taskId === 't1');
      expect(m).toBeTruthy();
      expect(m.model).toBe('opus');
      expect(m.routing_decision_id).toBeTruthy();
      expect(m.correlation_id).toBe(m.routing_decision_id); // persisted by marking, not freshly generated
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('run-status --json reports structured step state and a next_action', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const env = { HOME: CHOME };
      driveToExecute(tmp);
      run(['run', '--json'], { cwd: tmp, env }); // marks t1,t2 RUNNING
      const st = JSON.parse(run(['run-status', '--json'], { cwd: tmp, env }).stdout);
      expect(st.all_done).toBe(false);
      expect(Array.isArray(st.steps)).toBe(true);
      expect(st.steps.reduce((n, s) => n + s.running, 0)).toBeGreaterThan(0);
      expect(typeof st.next_action).toBe('string');
      expect(st.circuit_breaker.state).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('run --reconcile reclaims stale RUNNING tasks to pending', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const env = { HOME: CHOME };
      const name = driveToExecute(tmp);
      run(['run', '--json'], { cwd: tmp, env }); // marks t1,t2 RUNNING (started_at=now)
      const tf = join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json');
      const data = JSON.parse(readFileSync(tf, 'utf8'));
      const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago → stale (>30m)
      for (const t of data.tasks) if (t.status === 'running') t.started_at = oldTs;
      writeFileSync(tf, JSON.stringify(data));

      const out = JSON.parse(run(['run', '--reconcile', '--json'], { cwd: tmp, env }).stdout);
      expect(out.count).toBeGreaterThan(0);
      const after = JSON.parse(readFileSync(tf, 'utf8'));
      expect(after.tasks.find((t) => t.id === 't1').status).toBe('pending');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── prd-check + plan-exit gate (regression) ──────────────────────────
// Deterministic PRD gate keyed to the template's own rule: unresolved
// [A*, low] assumptions or unanswered "Status: blocking" questions block
// entry to Execute. Verifies precise detection (no false positives on the
// template's "blocking | answered" menu) and the --force override.
describe('prd-check + plan-exit gate (regression)', () => {
  let H;
  beforeAll(() => { H = mkdtempSync(join(tmpdir(), 'xb-prd-home-')); });
  afterAll(() => { rmSync(H, { recursive: true, force: true }); });

  function writePrd(tmp, name, body) {
    const dir = join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'PRD.md'), body);
  }

  test('passes on a clean PRD', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '# PRD\n\n## 0. Assumptions & Open Questions\n- [A1, high] safe to proceed\n\n## 12. Acceptance Criteria\n- works\n');
      const r = run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).blocked).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('blocks on low-confidence assumption and unanswered blocking question', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '# PRD\n\n## 0. Assumptions\n- [A3, low] auth supports refresh tokens\n- [Q1] ambiguous behavior → Status: blocking\n\n## 12. Acceptance Criteria\n- x\n');
      const r = run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } });
      const out = JSON.parse(r.stdout);
      expect(out.blocked).toBe(true);
      expect(out.blocking.length).toBe(2);
      expect(r.exitCode).toBe(1);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('answered question and the template "blocking | answered" menu are not flagged', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '# PRD\n\n## 0. Assumptions\n- [A1, high] ok\n- [Q1] resolved → Status: answered\n- [Q2] menu → Status: blocking | answered\n');
      expect(JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout).blocked).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('phase set execute is gated by a blocking PRD; --force overrides', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '# PRD\n\n## 0. Assumptions\n- [A3, low] risky unresolved assumption\n');
      run(['phase', 'set', 'execute'], { cwd: tmp, env: { HOME: H } });
      expect(readJSON(projectPath(tmp, name, 'manifest.json')).current_phase).not.toBe('03-execute');
      run(['phase', 'set', 'execute', '--force'], { cwd: tmp, env: { HOME: H } });
      expect(readJSON(projectPath(tmp, name, 'manifest.json')).current_phase).toBe('03-execute');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── Diagram gate (R4/R5/R12): marker-versioned block vs warn ─────────
  test('versioned PRD with no Section 8 diagram blocks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '<!-- prd-template-version: 2 -->\n# PRD\n\n## 8. Architecture\nNo diagram present, just prose.\n\n## 12. Acceptance Criteria\n- x\n');
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(true);
      expect(out.blocking.some((b) => /Section 8/.test(b))).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('versioned PRD with a "■ Diagram:" marker + fenced block in Section 8 passes', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '<!-- prd-template-version: 2 -->\n# PRD\n\n## 8. Architecture\n\n■ Diagram:\n```\nClient -> Server -> DB\n```\n\n## 12. Acceptance Criteria\n- x\n');
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('un-versioned (pre-existing) PRD with no Section 8 diagram only warns, never blocks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '# PRD\n\n## 8. Architecture\nProse only, no diagram.\n\n## 12. Acceptance Criteria\n- x\n');
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(false);
      expect(out.warnings.some((w) => /Section 8/.test(w) && /diagram/i.test(w))).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('a diagram in Section 9 does not satisfy Section 8\'s requirement (no scope leak)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '<!-- prd-template-version: 2 -->\n# PRD\n\n## 9. Key Scenarios\n\n■ Diagram:\n```\nClient -> Server -> DB\n```\n\n## 12. Acceptance Criteria\n- x\n');
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(true);
      expect(out.blocking.some((b) => /Section 8/.test(b) && /missing/i.test(b))).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('a language-tagged code fence (```typescript) alone does not count as a diagram', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '<!-- prd-template-version: 2 -->\n# PRD\n\n## 8. Architecture\n\n```typescript\ninterface Foo { bar: string; }\n```\n\n## 12. Acceptance Criteria\n- x\n');
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('phase set execute: diagram-missing versioned PRD blocks (force overrides); un-versioned PRD passes without --force', () => {
    const tmpBlocked = mkdtempSync(join(tmpdir(), 'xb-test-'));
    const tmpOld = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const nameBlocked = setupProject(tmpBlocked);
      writePrd(tmpBlocked, nameBlocked, '<!-- prd-template-version: 2 -->\n# PRD\n\n## 8. Architecture\nNo diagram present, just prose.\n\n## 12. Acceptance Criteria\n- x\n');
      run(['phase', 'set', 'execute'], { cwd: tmpBlocked, env: { HOME: H } });
      expect(readJSON(projectPath(tmpBlocked, nameBlocked, 'manifest.json')).current_phase).not.toBe('03-execute');
      run(['phase', 'set', 'execute', '--force'], { cwd: tmpBlocked, env: { HOME: H } });
      expect(readJSON(projectPath(tmpBlocked, nameBlocked, 'manifest.json')).current_phase).toBe('03-execute');

      const nameOld = setupProject(tmpOld);
      writePrd(tmpOld, nameOld, '# PRD\n\n## 8. Architecture\nNo diagram, old template.\n\n## 12. Acceptance Criteria\n- x\n');
      run(['phase', 'set', 'execute'], { cwd: tmpOld, env: { HOME: H } });
      expect(readJSON(projectPath(tmpOld, nameOld, 'manifest.json')).current_phase).toBe('03-execute');
    } finally {
      rmSync(tmpBlocked, { recursive: true, force: true });
      rmSync(tmpOld, { recursive: true, force: true });
    }
  });

  test('save plan stamps the version marker once and never duplicates it on re-save', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      const body = '# PRD\n\n## 1. Goal\nTest project\n';
      run(['save', 'plan', '--content', body], { cwd: tmp, env: { HOME: H } });
      const prdFile = join(projectPath(tmp, name, 'phases', '02-plan'), 'PRD.md');
      const saved = readFileSync(prdFile, 'utf8');
      expect(saved.startsWith('<!-- prd-template-version: 2 -->')).toBe(true);
      expect((saved.match(/prd-template-version/g) || []).length).toBe(1);

      // Re-save with the already-stamped content, as a caller reading the file
      // back and re-submitting it would. Must not stamp a second marker.
      run(['save', 'plan', '--content', saved], { cwd: tmp, env: { HOME: H } });
      const savedAgain = readFileSync(prdFile, 'utf8');
      expect((savedAgain.match(/prd-template-version/g) || []).length).toBe(1);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('a PRD written directly (bypassing save plan) carries no marker and is treated as pre-existing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '# PRD\n\n## 8. Architecture\nNo diagram here.\n\n## 12. Acceptance Criteria\n- x\n');
      const prdFile = readFileSync(join(projectPath(tmp, name, 'phases', '02-plan'), 'PRD.md'), 'utf8');
      expect(prdFile).not.toContain('prd-template-version');
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── F1: auxBox rule — box-drawing diagram without the "■ Diagram:" marker ─
  test('versioned PRD with a box-drawing fence (no "■ Diagram:" marker) passes via the auxBox rule', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, [
        '<!-- prd-template-version: 2 -->',
        '# PRD',
        '',
        '## 8. Architecture',
        '',
        'The system flow:',
        '',
        '```',
        '┌────────┐     ┌────────┐',
        '│ Client │────▶│ Server │',
        '└────────┘     └────────┘',
        '```',
        '',
        '## 12. Acceptance Criteria',
        '- x',
        '',
      ].join('\n'));
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  test('versioned PRD with only a decorative single-line divider fence still blocks (density guard)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, [
        '<!-- prd-template-version: 2 -->',
        '# PRD',
        '',
        '## 8. Architecture',
        '',
        'Some prose before a divider.',
        '',
        '```',
        '──────────────────────────────',
        '```',
        '',
        'More prose after.',
        '',
        '## 12. Acceptance Criteria',
        '- x',
        '',
      ].join('\n'));
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── F4: auxMermaid rule ────────────────────────────────────────────────
  test('versioned PRD with a fenced ```mermaid graph LR``` block (no marker) passes via the auxMermaid rule', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, [
        '<!-- prd-template-version: 2 -->',
        '# PRD',
        '',
        '## 8. Architecture',
        '',
        '```mermaid',
        'graph LR',
        '  Client --> Server --> DB',
        '```',
        '',
        '## 12. Acceptance Criteria',
        '- x',
        '',
      ].join('\n'));
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── Panel-review fix: an EMPTY ```mermaid fence must not satisfy the
  // auxMermaid rule — `lang === 'mermaid'` alone (no body check) previously
  // let a blank fence through.
  test('an empty ```mermaid fence (no content) does not satisfy the auxMermaid rule and blocks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, [
        '<!-- prd-template-version: 2 -->',
        '# PRD',
        '',
        '## 8. Architecture',
        '',
        '```mermaid',
        '```',
        '',
        '## 12. Acceptance Criteria',
        '- x',
        '',
      ].join('\n'));
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── F9 regression: a nested ``` shown as literal content inside a ````
  // (4-backtick) fence must not prematurely close the outer fence. Without
  // CommonMark delimiter-length matching, the naive toggle would treat the
  // inner ``` pair as closing/reopening the fence, exposing a `## `-looking
  // line as "outside a fence" and cutting Section 8's scope short before it
  // reaches the real diagram below.
  test('a nested ``` (3-backtick) inside a ```` (4-backtick) fence does not cut off a diagram further down', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, [
        '<!-- prd-template-version: 2 -->',
        '# PRD',
        '',
        '## 8. Architecture',
        '',
        '````markdown',
        'Example fence syntax:',
        '```',
        '## comment inside nested fence',
        '```',
        '````',
        '',
        '■ Diagram: System Architecture',
        '',
        '```',
        '[Client] ──▶ [Server] ──▶ [(DB)]',
        '```',
        '',
        '## 12. Acceptance Criteria',
        '- x',
        '',
      ].join('\n'));
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── F5: below-threshold version marker downgrades to warning ──────────
  test('PRD stamped below PRD_TEMPLATE_VERSION with no Section 8 diagram warns but does not block', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, '<!-- prd-template-version: 1 -->\n# PRD\n\n## 8. Architecture\nNo diagram, prose only.\n\n## 12. Acceptance Criteria\n- x\n');
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(false);
      expect(out.warnings.some((w) => /Section 8/.test(w))).toBe(true);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── F2 regression: a `## comment` line inside a fence must not truncate
  // Section 8's scope before it reaches the real diagram further down. ────
  test('a "## comment" line inside a bash fence in Section 8 does not cut off a diagram further down (fence-aware scope)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePrd(tmp, name, [
        '<!-- prd-template-version: 2 -->',
        '# PRD',
        '',
        '## 8. Architecture',
        '',
        'Setup script:',
        '',
        '```bash',
        '#!/bin/bash',
        '## comment explaining setup',
        'echo "hello"',
        '```',
        '',
        '■ Diagram: System Architecture',
        '',
        '```',
        '[Client] ──▶ [Server] ──▶ [(DB)]',
        '```',
        '',
        '## 12. Acceptance Criteria',
        '- x',
        '',
      ].join('\n'));
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp, env: { HOME: H } }).stdout);
      expect(out.blocked).toBe(false);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });

  // ── F10: `save requirements` (a non-`plan` artifact type) must never be
  // stamped with the PRD template-version marker — that marker is specific
  // to the PRD ("plan") artifact. ─────────────────────────────────────────
  test('save requirements does not stamp a prd-template-version marker', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      const body = '# Requirements\n\n- [R1] Something\n';
      run(['save', 'requirements', '--content', body], { cwd: tmp, env: { HOME: H } });
      const saved = readFileSync(projectPath(tmp, name, 'context', 'REQUIREMENTS.md'), 'utf8');
      expect(saved).not.toContain('prd-template-version');
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  });
});
