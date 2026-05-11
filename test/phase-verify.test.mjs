import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

function run(args, opts = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
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
  test('phase next auto-advances from research to plan', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
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
