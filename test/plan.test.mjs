import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
    if (t.team) args.push('--team', t.team);
    run(args, { cwd: tmp });
  }
}

function writePRD(tmp, name, content) {
  const prdDir = join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan');
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(join(prdDir, 'PRD.md'), content);
}

function writePlanCheck(tmp, name, content = { passed: true, checks: [] }) {
  const prdDir = join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan');
  mkdirSync(prdDir, { recursive: true });
  writeFileSync(join(prdDir, 'plan-check.json'), JSON.stringify(content, null, 2));
}

function writeRequirements(tmp, name, content) {
  const ctxDir = join(tmp, '.xm', 'build', 'projects', name, 'context');
  mkdirSync(ctxDir, { recursive: true });
  writeFileSync(join(ctxDir, 'REQUIREMENTS.md'), content);
}

function writeSharedConfig(tmp, cfg) {
  const xmDir = join(tmp, '.xm');
  mkdirSync(xmDir, { recursive: true });
  writeFileSync(join(xmDir, 'config.json'), JSON.stringify(cfg, null, 2));
}

describe('plan-check dimensions', () => {
  test('scope-clarity warns on missing done_criteria', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [
        { name: 'Implement auth [R1]', size: 'medium' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('scope-clarity');
      expect(r.stdout).toContain('no done_criteria');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('risk-ordering warns on late large root tasks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [
        { name: 'Setup config [R1]', size: 'small' },
        { name: 'Build API [R2]', size: 'small' },
        { name: 'Design architecture [R3]', size: 'large' },
      ]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('risk-ordering');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('tech-leakage dimension exists in output', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [{ name: 'Setup project [R1]', size: 'small' }]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('tech-leakage');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('done_criteria generation', () => {
  test('generates domain-specific criteria for auth tasks', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, `# PRD\n## 8. Acceptance Criteria\n- [ ] User can login [R1]\n`);
      addTasks(tmp, [{ name: 'Implement JWT auth [R1]', size: 'medium' }]);
      const r = run(['tasks', 'done-criteria'], { cwd: tmp });
      expect(r.stdout).toContain('done_criteria generated');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('forecast', () => {
  test('shows confidence indicators', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [
        { name: 'Setup basics [R1]', size: 'small' },
        { name: 'Security auth review [R2]', size: 'large', strategy: 'review' },
      ]);
      // Move to plan phase
      run(['phase', 'set', 'plan'], { cwd: tmp });
      run(['steps', 'compute'], { cwd: tmp });
      const r = run(['forecast'], { cwd: tmp });
      expect(r.stdout).toContain('Confidence');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('plan routing protocol', () => {
  test('plan --quick is parsed as an option, not part of the goal', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['plan', 'Build a hello world app', '--quick'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.action).toBe('auto-plan');
      expect(output.goal).toBe('Build a hello world app');
      expect(output.quick).toBe(true);
      expect(output.flow).toBe('quick');
      expect(output.skip_research).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('plan preserves flag-like text in the goal except --quick', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['plan', 'Build CLI --help docs', '--quick'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.goal).toBe('Build CLI --help docs');
      expect(output.quick).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('next --json recognizes PRD in the plan phase directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['phase', 'set', 'plan'], { cwd: tmp });
      writePRD(tmp, name, '# PRD\n\n## 1. Goal\nBuild API\n');
      const r = run(['next', '--json'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.artifacts.prd).toBe(true);
      expect(output.action).toBe('plan');
      expect(output.goal).toBe('Build API');
      expect(output.args).toEqual(['Build API']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('next --json does not advance from plan without a PRD', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['phase', 'set', 'plan'], { cwd: tmp });
      addTasks(tmp, [{ name: 'Implement auth [R1]', size: 'small' }]);
      writePlanCheck(tmp, name);
      const r = run(['next', '--json'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.artifacts.prd).toBe(false);
      expect(output.action).toBe('plan');
      expect(output.ready).toBe(false);
      expect(output.reason).toContain('PRD');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase next blocks Plan to Execute when PRD is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['phase', 'set', 'plan'], { cwd: tmp });
      addTasks(tmp, [{ name: 'Implement auth [R1]', size: 'small' }]);
      writePlanCheck(tmp, name);
      run(['gate', 'pass'], { cwd: tmp });
      const r = run(['phase', 'next'], { cwd: tmp });
      expect(r.stdout + r.stderr).toContain('PRD not generated');
      const status = JSON.parse(run(['status', '--json'], { cwd: tmp }).stdout);
      expect(status.phase.name).toBe('plan');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('phase set execute blocks when PRD is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['phase', 'set', 'execute'], { cwd: tmp });
      expect(r.stdout + r.stderr).toContain('PRD not generated');
      const status = JSON.parse(run(['status', '--json'], { cwd: tmp }).stdout);
      expect(status.phase.name).toBe('research');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('status --json recognizes PRD in the plan phase directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n\n## 1. Goal\nBuild API\n');
      const r = run(['status', '--json'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.context_files.prd).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('prd-gate', () => {
  test('outputs JSON with rubric', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 1. Goal\nBuild API\n## 8. Acceptance Criteria\n- [ ] Works\n');
      const r = run(['prd-gate'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.action).toBe('prd-gate');
      expect(output.rubric).toBeArray();
      expect(output.rubric.length).toBe(5);
      expect(output.threshold).toBe(7);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('fails without PRD', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['prd-gate'], { cwd: tmp });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('No PRD');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('consensus', () => {
  test('outputs JSON with 4 agents', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 1. Goal\nBuild API\n');
      const r = run(['consensus'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.action).toBe('consensus');
      expect(output.agents).toBeArray();
      expect(output.agents.length).toBe(4);
      expect(output.agents.map(a => a.role)).toEqual(['architect', 'critic', 'planner', 'security']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('agent models follow model_profile from shared config (economy → all sonnet)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 1. Goal\nBuild API\n');
      writeSharedConfig(tmp, { model_profile: 'economy' });
      const r = run(['consensus'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.agents.map(a => a.model)).toEqual(['sonnet', 'sonnet', 'sonnet', 'sonnet']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('model_overrides beats profile for consensus agents', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 1. Goal\nBuild API\n');
      writeSharedConfig(tmp, { model_profile: 'economy', model_overrides: { critic: 'opus' } });
      const r = run(['consensus'], { cwd: tmp });
      const output = JSON.parse(r.stdout);
      expect(output.agents.find(a => a.role === 'critic').model).toBe('opus');
      expect(output.agents.find(a => a.role === 'architect').model).toBe('sonnet');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('deterministic model emission (research / plan / next)', () => {
  test('research emits agents_spec with researcher role and profile-driven model', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeSharedConfig(tmp, { model_profile: 'economy' });
      const r = run(['research', 'topic'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.agents_spec).toBeArray();
      expect(output.agents_spec.length).toBe(4);
      for (const spec of output.agents_spec) {
        expect(spec.role).toBe('researcher');
        expect(spec.model).toBe('haiku'); // economy.researcher
      }
      expect(output.model).toBe('haiku');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('research --model flag overrides profile-driven model', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeSharedConfig(tmp, { model_profile: 'economy' });
      const r = run(['research', 'topic', '--model', 'opus'], { cwd: tmp });
      const output = JSON.parse(r.stdout);
      expect(output.model).toBe('opus');
      expect(output.agents_spec.every(s => s.model === 'opus')).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('plan emits prd_writer spec routed as large planner task', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeSharedConfig(tmp, { model_profile: 'economy' });
      const r = run(['plan', 'Build API'], { cwd: tmp });
      const output = JSON.parse(r.stdout);
      expect(output.prd_writer).toMatchObject({ role: 'planner', model: 'sonnet' }); // economy.planner (+vendor additive 필드 허용)
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('next --json plan action includes prd_writer spec', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      run(['phase', 'set', 'plan'], { cwd: tmp });
      writePRD(tmp, name, '# PRD\n\n## 1. Goal\nBuild API\n');
      writeSharedConfig(tmp, { model_profile: 'default' });
      const r = run(['next', '--json'], { cwd: tmp });
      const output = JSON.parse(r.stdout);
      expect(output.action).toBe('plan');
      expect(output.prd_writer).toMatchObject({ role: 'planner', model: 'opus' }); // default.planner (+vendor additive 필드 허용)
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('verify-traceability', () => {
  test('shows traceability matrix', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writeRequirements(tmp, name, '- [R1] User authentication\n- [R2] CRUD API\n');
      addTasks(tmp, [
        { name: 'Implement auth [R1]', size: 'medium' },
      ]);
      const r = run(['verify-traceability'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Traceability Matrix');
      expect(r.stdout).toContain('[R1]');
      expect(r.stdout).toContain('[R2]');
      expect(r.stdout).toContain('gaps');
      // R2 should show as gap
      expect(r.stdout).toContain('NONE');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('task features', () => {
  test('task add with --team stores team field', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const r = run(['tasks', 'add', 'Build payment [R1]', '--team', 'engineering'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const r2 = run(['tasks', 'list'], { cwd: tmp });
      expect(r2.stdout).toContain('Build payment');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('task add with --strategy stores strategy field', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Review auth [R1]', '--strategy', 'review'], { cwd: tmp });
      const r = run(['tasks', 'list'], { cwd: tmp });
      expect(r.stdout).toContain('[review]');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('task scoring shows quality summary', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [
        { name: 'Task A [R1]', size: 'small' },
        { name: 'Task B [R2]', size: 'small' },
      ]);
      run(['tasks', 'update', 't1', '--score', '8.0'], { cwd: tmp });
      run(['tasks', 'update', 't2', '--score', '6.5'], { cwd: tmp });
      const r = run(['tasks', 'list'], { cwd: tmp });
      expect(r.stdout).toContain('Quality');
      expect(r.stdout).toContain('avg');
      expect(r.stdout).toContain('below 7.0');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('failure-mode-coverage dimension', () => {
  test('warns when PRD has no Failure Modes section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 1. Goal\nBuild API\n## 8. Architecture\n[x]\n');
      addTasks(tmp, [{ name: 'Setup config [R1]', size: 'small' }]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('failure-mode-coverage');
      expect(r.stdout).toContain('no Failure Modes section');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('warns per-task when a risk-domain task lacks stress done_criteria', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      addTasks(tmp, [{ name: 'Build regex matcher [R1]', size: 'small' }]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('failure-mode-coverage');
      expect(r.stdout).toContain('touches a risk domain');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no warn when section present and task has stress done_criteria', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 1. Goal\nBuild\n## 7.5 Failure Modes\n- [R1] ReDoS → 검증: stress\n## 8. Architecture\n[x]\n');
      addTasks(tmp, [{ name: 'Build regex matcher [R1]', size: 'small' }]);
      run(['tasks', 'update', 't1', '--done-criteria', '스트레스: ReDoS (검증: stress test)'], { cwd: tmp });
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).not.toContain('no Failure Modes section');
      expect(r.stdout).not.toContain('touches a risk domain');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('failure-mode done_criteria derivation', () => {
  test('injects stress criteria from PRD Failure Modes section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 7.5 Failure Modes & Adversarial Inputs\n- [R1] adversarial 100k regex input → catastrophic backtracking → 검증: stress test < 100ms\n## 8. Architecture\n[x]\n');
      addTasks(tmp, [{ name: 'Build regex matcher [R1]', size: 'medium' }]);
      const r = run(['tasks', 'done-criteria'], { cwd: tmp });
      expect(r.stdout).toContain('done_criteria generated');
      expect(r.stdout).toContain('스트레스:');
      expect(r.stdout).toContain('catastrophic backtracking');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('no injection when PRD has no Failure Modes section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 8. Acceptance Criteria\n- [ ] Works [R1]\n');
      addTasks(tmp, [{ name: 'Build regex matcher [R1]', size: 'medium' }]);
      const r = run(['tasks', 'done-criteria'], { cwd: tmp });
      expect(r.stdout).toContain('done_criteria generated');
      expect(r.stdout).not.toContain('스트레스:');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scope creep detection', () => {
  test('warns when task matches Out of Scope', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      writePRD(tmp, name, '# PRD\n## 6. Out of Scope\n- Real-time notifications\n- Mobile app\n');
      const r = run(['tasks', 'add', 'Add notifications system [R5]'], { cwd: tmp });
      expect(r.stdout).toContain('Scope warning');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
