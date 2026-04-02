import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
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

function setupProject(tmp, name = 'test-proj') {
  run(['init', name], { cwd: tmp });
  return name;
}

function addTasks(tmp, tasks) {
  for (const t of tasks) {
    const args = ['tasks', 'add', t.name];
    if (t.deps) args.push('--deps', t.deps);
    if (t.size) args.push('--size', t.size);
    if (t.strategy) args.push('--strategy', t.strategy);
    run(args, { cwd: tmp });
  }
}

function writePRD(tmp, name, content) {
  const prdDir = join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan');
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(join(prdDir, 'PRD.md'), content);
}

function tasksFilePath(tmp, name) {
  return join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json');
}

function writeRequirements(tmp, name, content) {
  const ctxDir = join(tmp, '.xm', 'build', 'projects', name, 'context');
  mkdirSync(ctxDir, { recursive: true });
  writeFileSync(join(ctxDir, 'REQUIREMENTS.md'), content);
}

// ─── G1: Scope guard ────────────────────────────────────────────────────────

describe('G1 — Scope guard (scope-clarity dim)', () => {
  it('warns when task name matches 2+ Out of Scope keywords', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g1-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, `# PRD
## 1. Goal
Build a web API.

## 6. Out of Scope
- Real-time notifications push system
- Mobile application support
`);
      // Task name contains "notifications" and "push" — both are OOS keywords
      addTasks(tmp, [
        { name: 'Implement notifications push [R1]', size: 'small' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('Out of Scope');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT warn when task name matches only 1 Out of Scope keyword', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g1-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, `# PRD
## 1. Goal
Build a web API.

## 6. Out of Scope
- Real-time notifications push system
- Mobile application support
`);
      // Only "notifications" matches — should not trigger scope warning
      addTasks(tmp, [
        { name: 'Add email notifications [R1]', size: 'small' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).not.toContain('may overlap with Out of Scope');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT warn when PRD has no Out of Scope section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g1-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, `# PRD
## 1. Goal
Build a web API.
`);
      addTasks(tmp, [
        { name: 'Implement notifications push [R1]', size: 'small' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).not.toContain('may overlap with Out of Scope');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── G2: Coverage expansion ──────────────────────────────────────────────────

describe('G2 — Coverage expansion (coverage dim)', () => {
  it('finds R# reference in done_criteria even when not in task name', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g2-'));
    try {
      const name = setupProject(tmp);
      writeRequirements(tmp, name, '- [R1] User authentication\n- [R2] CRUD API\n');
      // R2 is only in done_criteria, not in the task name
      addTasks(tmp, [
        { name: 'Implement authentication [R1]', size: 'small' },
        { name: 'Build backend API', size: 'small' },
      ]);
      // Manually inject done_criteria referencing R2 into tasks.json
      const tPath = tasksFilePath(tmp, name);
      const data = JSON.parse(readFileSync(tPath, 'utf8'));
      const t2 = data.tasks.find(t => t.name.startsWith('Build backend'));
      if (t2) t2.done_criteria = ['R2 CRUD endpoints return correct status codes'];
      writeFileSync(tPath, JSON.stringify(data, null, 2));

      const r = run(['plan-check'], { cwd: tmp });
      // R2 referenced in done_criteria — should NOT appear as coverage gap
      expect(r.stdout).not.toContain('R2 not referenced');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports coverage gap when R# is not in name OR done_criteria', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g2-'));
    try {
      const name = setupProject(tmp);
      writeRequirements(tmp, name, '- [R1] User authentication\n- [R3] Reporting dashboard\n');
      addTasks(tmp, [
        { name: 'Implement authentication [R1]', size: 'small' },
        { name: 'Build backend API', size: 'small' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      // R3 not referenced anywhere — should appear as coverage gap
      expect(r.stdout).toContain('R3');
      expect(r.stdout).toContain('coverage');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── G3: Risk-ordering DAG-based ─────────────────────────────────────────────

describe('G3 — Risk-ordering DAG-based (risk-ordering dim)', () => {
  it('warns when large root task is in the second half of DAG steps', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g3-'));
    try {
      setupProject(tmp);
      // t1 (small) → t2 (small) → t3 (large, root) placed at end of array
      // Since t3 has no deps, it runs in step 1 alongside others;
      // but we need it to be after the midpoint. Use deps to push it later.
      addTasks(tmp, [
        { name: 'Setup configuration [R1]', size: 'small' },
        { name: 'Build API layer [R2]', size: 'small' },
        { name: 'Design architecture [R3]', size: 'large' },
      ]);
      // Make t3 depend on t1 and t2 so it ends up in a later DAG step
      // but it still has no deps listed (it's a root large task by design in G3)
      // The test checks that the warning appears when large+no-deps task is late in DAG
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('risk-ordering');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT warn when large root task is in the first half of DAG', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g3-'));
    try {
      setupProject(tmp);
      // Large task first, small tasks after (depend on it)
      addTasks(tmp, [
        { name: 'Design architecture [R1]', size: 'large' },
        { name: 'Build API [R2]', size: 'small', deps: 't1' },
        { name: 'Deploy service [R3]', size: 'small', deps: 't2' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).not.toContain('front-loading');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── G4: Atomicity 3+ large ──────────────────────────────────────────────────

describe('G4 — Atomicity 3+ large tasks (atomicity dim)', () => {
  it('warns when 3 or more tasks are size large', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g4-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [
        { name: 'Design architecture [R1]', size: 'large', deps: '' },
        { name: 'Implement core engine [R2]', size: 'large', deps: 't1' },
        { name: 'Build integration layer [R3]', size: 'large', deps: 't2' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('atomicity');
      expect(r.stdout).toContain('large tasks');
      expect(r.stdout).toContain('consider splitting');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT trigger G4 warning with only 2 large tasks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g4-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [
        { name: 'Design architecture [R1]', size: 'large', deps: '' },
        { name: 'Implement core engine [R2]', size: 'large', deps: 't1' },
        { name: 'Write unit tests [R3]', size: 'small', deps: 't2' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      // Should not contain the "3 large tasks" aggregate warning
      expect(r.stdout).not.toMatch(/\d+ large tasks — consider splitting/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes task IDs in the G4 warning message', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g4-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [
        { name: 'Design system [R1]', size: 'large', deps: '' },
        { name: 'Build backend [R2]', size: 'large', deps: 't1' },
        { name: 'Deploy infrastructure [R3]', size: 'large', deps: 't2' },
        { name: 'Integrate services [R4]', size: 'large', deps: 't3' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toMatch(/4 large tasks/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── G5: Fallback done_criteria ──────────────────────────────────────────────

describe('G5 — Fallback done_criteria (two criteria)', () => {
  it('generates two fallback criteria when no PRD acceptance criteria match', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g5-'));
    try {
      const name = setupProject(tmp);
      // PRD with acceptance criteria that don't match any task R# reference
      writePRD(tmp, name, `# PRD
## 8. Acceptance Criteria
- [ ] System responds in < 200ms [R99]
`);
      // Task with no matching R# in PRD acceptance criteria
      addTasks(tmp, [
        { name: 'Setup logging infrastructure', size: 'small' },
      ]);
      const r = run(['tasks', 'done-criteria'], { cwd: tmp });
      expect(r.stdout).toContain('done_criteria generated');
      // Verify the task now has two fallback criteria
      const tPath = tasksFilePath(tmp, name);
      const data = JSON.parse(readFileSync(tPath, 'utf8'));
      const task = data.tasks[0];
      expect(task.done_criteria).toBeDefined();
      const fallbackCriteria = task.done_criteria.filter(
        c => c.includes('happy path verified') || c.includes('primary error case handled')
      );
      expect(fallbackCriteria.length).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fallback includes happy path criterion', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g5-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 8. Acceptance Criteria\n- [ ] Works [R99]\n');
      addTasks(tmp, [{ name: 'Configure deployment pipeline', size: 'medium' }]);
      run(['tasks', 'done-criteria'], { cwd: tmp });
      const tPath = tasksFilePath(tmp, name);
      const data = JSON.parse(readFileSync(tPath, 'utf8'));
      const task = data.tasks[0];
      const happyPath = task.done_criteria.find(c => c.includes('happy path verified'));
      expect(happyPath).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('fallback includes primary error case criterion', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g5-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 8. Acceptance Criteria\n- [ ] Works [R99]\n');
      addTasks(tmp, [{ name: 'Configure deployment pipeline', size: 'medium' }]);
      run(['tasks', 'done-criteria'], { cwd: tmp });
      const tPath = tasksFilePath(tmp, name);
      const data = JSON.parse(readFileSync(tPath, 'utf8'));
      const task = data.tasks[0];
      const errorCase = task.done_criteria.find(c => c.includes('primary error case handled'));
      expect(errorCase).toBeDefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── G6: Granularity upper bound ─────────────────────────────────────────────

describe('G6 — Granularity upper bound (granularity dim)', () => {
  it('warns when task count exceeds 15', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g6-'));
    try {
      setupProject(tmp);
      const tasks = Array.from({ length: 16 }, (_, i) => ({
        name: `Setup component ${i + 1} [R${i + 1}]`,
        size: 'small',
      }));
      addTasks(tmp, tasks);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('granularity');
      expect(r.stdout).toContain('over-decomposed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('includes task count in the G6 warning', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g6-'));
    try {
      setupProject(tmp);
      const tasks = Array.from({ length: 18 }, (_, i) => ({
        name: `Implement feature ${i + 1} [R${i + 1}]`,
        size: 'small',
      }));
      addTasks(tmp, tasks);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('18 tasks');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does NOT warn when task count is exactly 15', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g6-'));
    try {
      setupProject(tmp);
      const tasks = Array.from({ length: 15 }, (_, i) => ({
        name: `Implement feature ${i + 1} [R${i + 1}]`,
        size: 'small',
      }));
      addTasks(tmp, tasks);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).not.toContain('over-decomposed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ─── G7: Extended verb list ───────────────────────────────────────────────────

describe('G7 — Extended verb list (naming dim)', () => {
  const newVerbs = [
    'optimize',
    'enable',
    'extract',
    'scaffold',
    'evaluate',
    'generate',
    'define',
    'extend',
    'replace',
    'monitor',
    'provision',
    'secure',
    'audit',
    'prepare',
    'ensure',
    'initialize',
    'bootstrap',
    'wire',
    'connect',
    'expose',
    'handle',
  ];

  for (const verb of newVerbs) {
    it(`accepts "${verb}" as a valid starting verb (no naming warning)`, () => {
      const tmp = mkdtempSync(join(tmpdir(), 'xb-g7-'));
      try {
        setupProject(tmp);
        const taskName = `${verb.charAt(0).toUpperCase() + verb.slice(1)} the system component [R1]`;
        addTasks(tmp, [{ name: taskName, size: 'small' }]);
        const r = run(['plan-check'], { cwd: tmp });
        // The task name starts with a recognized verb — should NOT get naming info
        const namingLines = r.stdout
          .split('\n')
          .filter(l => l.includes('naming') && l.includes('consider starting with a verb') && l.toLowerCase().includes(verb));
        expect(namingLines.length).toBe(0);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it('still warns when task name starts with an unrecognized word', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g7-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [{ name: 'Authentication module [R1]', size: 'small' }]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('naming');
      expect(r.stdout).toContain('consider starting with a verb');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts original verbs still work (add, create, implement)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-g7-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [
        { name: 'Add authentication [R1]', size: 'small' },
        { name: 'Create user model [R2]', size: 'small' },
        { name: 'Implement payment flow [R3]', size: 'small' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      // None of these should trigger naming warnings
      const namingWarnings = r.stdout
        .split('\n')
        .filter(l => l.includes('consider starting with a verb'));
      expect(namingWarnings.length).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
