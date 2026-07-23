import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

// Use isolated HOME to avoid global config (~/.xm/config.json) affecting tests
const TEST_HOME = mkdtempSync(join(tmpdir(), 'xb-home-'));

// Default cwd for cwd-less run() calls must NEVER be the host repo: a subprocess
// that reaches gitAutoCommit would commit the dev's pre-staged files into a tm()
// task commit (RV-2 / X-9-class test-isolation failure). Isolate it to a temp dir.
const RUN_DEFAULT_CWD = mkdtempSync(join(tmpdir(), 'xb-nocwd-'));
function run(args, opts = {}) {
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd: opts.cwd ?? RUN_DEFAULT_CWD,
    env: { ...process.env, XKIT_SERVER: undefined, HOME: TEST_HOME, ...opts.env },
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  };
}

function setupProject(tmp, name = 'test-proj') {
  run(['init', name], { cwd: tmp });
  return name;
}

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ── RV-2 regression: a cwd-less run() must never target the host repo ──
// If this default reverts to process.cwd(), a subprocess that reaches
// gitAutoCommit can sweep the dev's pre-staged files into a tm() task commit
// on the real working repo (the grill.md / X-9-class test-isolation failure).
describe('test isolation (RV-2)', () => {
  test('cwd-less run() default is isolated, not the host repo', () => {
    expect(RUN_DEFAULT_CWD.startsWith(tmpdir())).toBe(true);
    expect(RUN_DEFAULT_CWD).not.toBe(process.cwd());
  });

  test('a cwd-less task-completion flow leaves the host repo untouched', () => {
    const hostProj = join(process.cwd(), '.xm', 'build', 'projects', 'rv2-iso');
    const before = existsSync(hostProj);
    run(['init', 'rv2-iso']);                                  // no cwd → isolated temp
    run(['tasks', 'add', 'T']);                                // no cwd
    run(['tasks', 'update', 't1', '--status', 'completed']);   // would gitAutoCommit if on host
    const after = existsSync(hostProj);
    if (after && !before) { try { rmSync(hostProj, { recursive: true, force: true }); } catch {} }
    expect(after).toBe(before);                                // host .xm must be unchanged
  });
});

// ── Phase lifecycle ───────────────────────────────────────────────

describe('phase lifecycle', () => {
  test('init starts at research phase', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      const manifest = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'manifest.json'));
      expect(manifest.current_phase).toBe('01-research');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase status shows current phase', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['phase', 'status'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Research');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase set jumps to target phase', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['phase', 'set', 'plan'], { cwd: tmp });
      const manifest = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'manifest.json'));
      expect(manifest.current_phase).toBe('02-plan');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('gate pass records approval', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['gate', 'pass', 'Looks good'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('pass');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('cache gitignore initialization', () => {
  test('init adds .xm/cache/ once and preserves existing newline conventions', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-cache-ignore-'));
    try {
      run(['init', 'first'], { cwd: tmp });
      expect(readFileSync(join(tmp, '.gitignore'), 'utf8')).toBe('.xm/cache/\n');

      run(['init', 'second'], { cwd: tmp });
      expect(readFileSync(join(tmp, '.gitignore'), 'utf8')).toBe('.xm/cache/\n');

      const crlf = mkdtempSync(join(tmpdir(), 'xb-cache-ignore-crlf-'));
      try {
        writeFileSync(join(crlf, '.gitignore'), 'node_modules/\r\ncustom-rule');
        run(['init', 'first'], { cwd: crlf });
        expect(readFileSync(join(crlf, '.gitignore'), 'utf8')).toBe('node_modules/\r\ncustom-rule\r\n.xm/cache/\r\n');
      } finally {
        rmSync(crlf, { recursive: true, force: true });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Task CRUD ─────────────────────────────────────────────────────

describe('task CRUD', () => {
  test('add + list + remove workflow', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'add', 'Task B', '--deps', 't1'], { cwd: tmp });

      const r = run(['tasks', 'list'], { cwd: tmp });
      expect(r.stdout).toContain('Task A');
      expect(r.stdout).toContain('Task B');
      expect(r.stdout).toContain('t1');

      // Can't remove t1 because t2 depends on it
      const r2 = run(['tasks', 'remove', 't1'], { cwd: tmp });
      expect(r2.exitCode).not.toBe(0);

      // Can remove t2 (no dependents)
      const r3 = run(['tasks', 'remove', 't2'], { cwd: tmp });
      expect(r3.exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('update status transitions', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'running'], { cwd: tmp });

      const tasks = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json'));
      const t1 = tasks.tasks.find(t => t.id === 't1');
      expect(t1.status).toBe('running');
      expect(t1.started_at).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('failed status records failed_at timestamp', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'failed', '--retry', 'false'], { cwd: tmp });

      const tasks = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json'));
      const t1 = tasks.tasks.find(t => t.id === 't1');
      expect(t1.status).toBe('failed');
      expect(t1.failed_at).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('invalid status rejected', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      const r = run(['tasks', 'update', 't1', '--status', 'invalid'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('Invalid status');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Steps (DAG) ───────────────────────────────────────────────────

describe('DAG steps', () => {
  test('steps compute creates step groups', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'add', 'Task B'], { cwd: tmp });
      run(['tasks', 'add', 'Task C', '--deps', 't1,t2'], { cwd: tmp });

      const r = run(['steps', 'compute'], { cwd: tmp });
      expect(r.exitCode).toBe(0);

      const steps = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'steps.json'));
      expect(steps.steps.length).toBe(2); // Step 1: t1,t2 (parallel), Step 2: t3
      expect(steps.steps[0].tasks).toContain('t1');
      expect(steps.steps[0].tasks).toContain('t2');
      expect(steps.steps[1].tasks).toContain('t3');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('unknown dependency rejected on add', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['tasks', 'add', 'Task A', '--deps', 't99'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('Unknown dependency');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Circuit breaker ───────────────────────────────────────────────

describe('circuit breaker', () => {
  test('status shows closed by default', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['circuit-breaker', 'status'], { cwd: tmp });
      expect(r.stdout).toContain('closed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('reset restores closed state', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['circuit-breaker', 'reset'], { cwd: tmp });
      const r = run(['circuit-breaker', 'status'], { cwd: tmp });
      expect(r.stdout).toContain('closed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Cost estimation ───────────────────────────────────────────────

describe('cost estimation', () => {
  test('estimateTaskCost returns multiplied costs for complex tasks', async () => {
    const { estimateTaskCost } = await import('../x-build/lib/x-build/core.mjs');

    const simple = estimateTaskCost({ name: 'Setup config', size: 'small', depends_on: [] }, 'sonnet');
    const complex = estimateTaskCost({
      name: 'Security auth review',
      size: 'large',
      depends_on: ['t1', 't2', 't3'],
      strategy: 'review',
    }, 'opus');

    expect(simple.confidence).toBe('high');
    expect(simple.multiplier).toBeCloseTo(1.0, 1);

    expect(complex.confidence).toBe('low');
    expect(complex.multiplier).toBeGreaterThan(1.5);
    expect(complex.cost_usd).toBeGreaterThan(simple.cost_usd);
  });
});

// ── Edge cases ────────────────────────────────────────────────────

describe('edge cases', () => {
  test('steps compute with zero tasks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['steps', 'compute'], { cwd: tmp });
      // Should handle gracefully (either empty steps or message)
      expect(r.stdout + r.stderr).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('20 chained tasks compute in < 10s', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      for (let i = 1; i <= 20; i++) {
        const args = ['tasks', 'add', `Task ${i}`];
        if (i > 1) args.push('--deps', `t${i - 1}`);
        run(args, { cwd: tmp });
      }
      const start = Date.now();
      const r = run(['steps', 'compute'], { cwd: tmp });
      const elapsed = Date.now() - start;
      expect(r.exitCode).toBe(0);
      expect(elapsed).toBeLessThan(10000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('50 chained tasks compute in < 15s (regression guard)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      for (let i = 1; i <= 50; i++) {
        const args = ['tasks', 'add', `Task ${i}`];
        if (i > 1) args.push('--deps', `t${i - 1}`);
        run(args, { cwd: tmp });
      }
      const start = Date.now();
      const r = run(['steps', 'compute'], { cwd: tmp });
      const elapsed = Date.now() - start;
      expect(r.exitCode).toBe(0);
      expect(elapsed).toBeLessThan(15000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('task update with numeric score stores correctly', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--score', '8.5'], { cwd: tmp });
      const tasks = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json'));
      expect(tasks.tasks[0].score).toBe(8.5);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('double init same project name handled gracefully', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      run(['init', 'proj'], { cwd: tmp });
      const r = run(['init', 'proj'], { cwd: tmp });
      // Should either warn or fail, not silently overwrite
      expect(r.stdout + r.stderr).toBeTruthy();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('status shows next action suggestion', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['status'], { cwd: tmp });
      // Matches both Korean and English modes
      expect(r.stdout).toMatch(/다음 단계|Next/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('run in wrong phase shows helpful message', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['run'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('Execute');
      expect(r.stdout).toContain('phase next');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Export/Import ─────────────────────────────────────────────────

describe('export', () => {
  test('export md creates report file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      const r = run(['export', '--format', 'md'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Exported');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('export csv creates csv file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Task A', '--size', 'large'], { cwd: tmp });
      const r = run(['export', '--format', 'csv'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Exported');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Misc commands ─────────────────────────────────────────────────

describe('misc commands', () => {
  test('next recommends action', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['next'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Next Step');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('context generates brief', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['context'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Context Brief');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('decisions add + list', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['decisions', 'add', 'Use PostgreSQL', '--type', 'architecture', '--rationale', 'Team expertise'], { cwd: tmp });
      const r = run(['decisions', 'list'], { cwd: tmp });
      expect(r.stdout).toContain('PostgreSQL');
      expect(r.stdout).toContain('Team expertise');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('close summarizes project', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['close', '--summary', 'Completed MVP'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── Task reopen ───────────────────────────────────────────────────

describe('task reopen', () => {
  test('basic reopen: completed → pending, reopen_history added, completed_at cleared', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'completed'], { cwd: tmp });

      const r = run(['tasks', 'reopen', 't1', '--reason', 'needs rework'], { cwd: tmp });
      expect(r.exitCode).toBe(0);

      const tasks = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json'));
      const t1 = tasks.tasks.find(t => t.id === 't1');
      expect(t1.status).toBe('pending');
      expect(t1.reopen_history).toHaveLength(1);
      expect(t1.reopen_history[0].reason).toBe('needs rework');
      expect(t1.reopen_history[0].from_status).toBe('completed');
      expect(t1.completed_at).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('--reason is required: missing reason exits non-zero', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'completed'], { cwd: tmp });

      const r = run(['tasks', 'reopen', 't1'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);

      // Task must remain completed
      const tasks = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json'));
      const t1 = tasks.tasks.find(t => t.id === 't1');
      expect(t1.status).toBe('completed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('non-REOPENABLE status (pending) rejected', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });

      // Task is pending by default — not in REOPENABLE set
      const r = run(['tasks', 'reopen', 't1', '--reason', 'retry'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('Cannot reopen');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('cascade: reopen root without --cascade leaves dependents intact', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'add', 'Task B', '--deps', 't1'], { cwd: tmp });
      run(['tasks', 'add', 'Task C', '--deps', 't2'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'completed'], { cwd: tmp });
      run(['tasks', 'update', 't2', '--status', 'completed'], { cwd: tmp });
      run(['tasks', 'update', 't3', '--status', 'completed'], { cwd: tmp });

      const r = run(['tasks', 'reopen', 't1', '--reason', 'root only'], { cwd: tmp });
      expect(r.exitCode).toBe(0);

      const tasks = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json'));
      expect(tasks.tasks.find(t => t.id === 't1').status).toBe('pending');
      expect(tasks.tasks.find(t => t.id === 't2').status).toBe('completed');
      expect(tasks.tasks.find(t => t.id === 't3').status).toBe('completed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('cascade: --cascade transitively reopens dependents', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'add', 'Task B', '--deps', 't1'], { cwd: tmp });
      run(['tasks', 'add', 'Task C', '--deps', 't2'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'completed'], { cwd: tmp });
      run(['tasks', 'update', 't2', '--status', 'completed'], { cwd: tmp });
      run(['tasks', 'update', 't3', '--status', 'completed'], { cwd: tmp });

      const r = run(['tasks', 'reopen', 't1', '--reason', 'cascade all', '--cascade'], { cwd: tmp });
      expect(r.exitCode).toBe(0);

      const tasks = readJSON(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json'));
      expect(tasks.tasks.find(t => t.id === 't1').status).toBe('pending');
      expect(tasks.tasks.find(t => t.id === 't2').status).toBe('pending');
      expect(tasks.tasks.find(t => t.id === 't3').status).toBe('pending');
      expect(tasks.tasks.find(t => t.id === 't2').reopen_history).toHaveLength(1);
      expect(tasks.tasks.find(t => t.id === 't3').reopen_history).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('audit: reopen writes entry to decisions.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['tasks', 'add', 'Task A'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'failed', '--retry', 'false'], { cwd: tmp });

      const reopenResult = run(['tasks', 'reopen', 't1', '--reason', 'audit check'], { cwd: tmp });
      expect(reopenResult.exitCode).toBe(0);

      const decisions = readJSON(
        join(tmp, '.xm', 'build', 'projects', name, 'context', 'decisions.json')
      );
      const reopenEntry = decisions.decisions?.find(d => d.type === 'reopen');
      expect(reopenEntry).toBeTruthy();
      expect(reopenEntry.rationale).toBe('audit check');
      expect(reopenEntry.title).toContain('t1');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
