import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

function run(args, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  // Pin the child's shared-config root to the temp project. Without XM_ROOT,
  // readSharedConfig() merges the developer's real ~/.xm/config.json UNDER the temp
  // one, and since `model_overrides` outranks `model_profile`, a maintainer with
  // `model_overrides: { planner: 'opus' }` in their home config makes every
  // "profile → model" assertion here fail on their machine and pass in CI. XM_ROOT
  // makes readSharedConfig skip the global tier entirely (shared-config.mjs), so
  // these tests read exactly the config the test wrote — and nothing else.
  const result = spawnSync('node', [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, XKIT_SERVER: undefined, XM_ROOT: join(cwd, '.xm'), ...opts.env },
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
    if (t.dc) args.push('--done-criteria', t.dc);
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
      // With no measured samples, forecast must say it is estimate-only (빌드3).
      expect(r.stdout).toContain('Estimate-only');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('roi refuses a routing suggestion from estimate-only data (빅뱃1 / L9)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      // a normal completion has no --tokens/--score → estimated cost, unscored
      run(['tasks', 'add', 'A'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'running'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'completed', '--no-commit'], { cwd: tmp });
      const r = run(['roi', '--json'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.suggestion).toBeNull();                 // never guess from placeholders
      expect(out.models.every(m => !m.calibrated)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('forecast update aggregates measured actuals + is reachable from the CLI (빌드3)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Feature'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'running'], { cwd: tmp });
      run(['tasks', 'update', 't1', '--status', 'completed', '--tokens-in', '100000', '--tokens-out', '40000', '--no-commit'], { cwd: tmp });
      const r = run(['forecast', 'update'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Token actuals updated');
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
      expect(output.prd_writer).toMatchObject({ role: 'planner', model: 'inherit' }); // default.planner rides the session model (+vendor additive 필드 허용)
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
      expect(r.exitCode).not.toBe(0); // R2 has no matching task — a gap now exits non-zero
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

// ── failure-mode-coverage: model-aware gate ─────────────────────────────
// The phase-routing experiment measured 0/3 pathological-input survival for
// sonnet execution without failure-mode enumeration (vs opus 2/3), so a
// risk-domain task resolving to sonnet-or-below without stress done_criteria
// must BLOCK the plan gate (passed:false), while opus keeps warn, and an
// explicit "none — <rationale>" waives the check.
describe('failure-mode-coverage model-aware gate', () => {
  const readPlanCheck = (tmp, name = 'test-proj') =>
    JSON.parse(readFileSync(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'plan-check.json'), 'utf8'));

  test('escalates to ERROR when a risk-domain task executes on sonnet', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeSharedConfig(tmp, { model_profile: 'default' }); // default.executor = sonnet (measured)
      addTasks(tmp, [{ name: 'Build regex matcher [R1]', size: 'small', dc: '341 test cases pass' }]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('[FAIL] failure-mode-coverage');
      expect(r.stdout).toContain('executes on sonnet');
      expect(readPlanCheck(tmp).passed).toBe(false); // blocks the Plan gate
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('explicit "none — <rationale>" waiver passes the gate', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeSharedConfig(tmp, { model_profile: 'default' });
      addTasks(tmp, [{ name: 'Build regex matcher [R1]', size: 'small', dc: 'none — read-only display of precompiled patterns, no adversarial input surface' }]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).not.toContain('[FAIL] failure-mode-coverage'); // waived — no error (delegation-contract may still warn)
      expect(readPlanCheck(tmp).passed).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('higher-tier execution keeps warn (probabilistic cushion, gate passes)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeSharedConfig(tmp, { model_profile: 'default', model_overrides: { executor: 'opus' } });
      addTasks(tmp, [{ name: 'Build regex matcher [R1]', size: 'small', dc: '341 test cases pass' }]);
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('failure-mode-coverage');
      expect(r.stdout).toContain('executes on opus');
      expect(r.stdout).not.toContain('[FAIL] failure-mode-coverage');
      expect(readPlanCheck(tmp).passed).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── interface_contract: delegation interface field (R6/R7) ─────────────
describe('interface_contract field', () => {
  const tasksJSON = (tmp, name = 'test-proj') =>
    JSON.parse(readFileSync(join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json'), 'utf8'));

  test('add + update + clear roundtrip, single-flag update passes the usage guard', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      run(['tasks', 'add', 'Write summary [R1]', '--interface-contract', 'summarize(text) → string; 500자 이내'], { cwd: tmp });
      expect(tasksJSON(tmp).tasks[0].interface_contract).toContain('summarize');
      // usage-guard regression: --interface-contract alone must not print usage
      const upd = run(['tasks', 'update', 't1', '--interface-contract', 'summarize(text) → {title, body}'], { cwd: tmp });
      expect(upd.stdout).not.toContain('Usage:');
      expect(tasksJSON(tmp).tasks[0].interface_contract).toContain('{title, body}');
      run(['tasks', 'update', 't1', '--interface-contract', ''], { cwd: tmp });
      expect(tasksJSON(tmp).tasks[0].interface_contract).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('plan-check warns delegation-contract for delegation-shaped tasks lacking it', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      writeSharedConfig(tmp, { model_profile: 'default' }); // executor → sonnet (low tier)
      run(['tasks', 'add', 'Write summary [R1]', '--done-criteria', 'summary exists'], { cwd: tmp });
      const r = run(['plan-check'], { cwd: tmp });
      expect(r.stdout).toContain('delegation-contract');
      expect(r.stdout).toContain('no interface_contract');
      // adding the contract silences the warning
      run(['tasks', 'update', 't1', '--interface-contract', 'summarize(text) → string'], { cwd: tmp });
      const r2 = run(['plan-check'], { cwd: tmp });
      expect(r2.stdout).not.toContain('no interface_contract');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('stress: newline/quote/10KB/non-ASCII contract survives parse → prompt → JSON emit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-dispatch-'));
    try {
      const contract = ('파서(s) → {"ok": true}\n불변식: "따옴표" 유지\n' + 'x'.repeat(10000)).slice(0, 10240);
      const r = run(['dispatch', '계약 스트레스 확인용 태스크', '--json'], { cwd: tmp });
      const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      expect(out.task.task_id).toBe('t1');
      const upd = run(['tasks', 'update', 't1', '--interface-contract', contract], { cwd: tmp });
      expect(upd.exitCode).toBe(0);
      const t = JSON.parse(readFileSync(join(tmp, '.xm', 'build', 'projects', 'dispatch', 'phases', '02-plan', 'tasks.json'), 'utf8')).tasks[0];
      expect(t.interface_contract.length).toBeGreaterThan(9000);
      expect(t.interface_contract).toContain('"따옴표"');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('interface_contract rides the plan entry and the agent prompt (dispatch --interface-contract)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-dispatch-'));
    try {
      const r = run(['dispatch', '요약 생성', '--interface-contract', 'summarize(text) → string; 500자 이내', '--json'], { cwd: tmp });
      const out = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
      expect(out.task.interface_contract).toContain('summarize');
      expect(out.task.prompt).toContain('## Interface Contract');
      expect(out.task.prompt.indexOf('## Definition of Done')).toBeLessThan(out.task.prompt.indexOf('## Interface Contract'));
      // no contract → field omitted cleanly
      const r2 = run(['dispatch', '두번째: 계약 없음', '--json'], { cwd: tmp });
      const out2 = JSON.parse(r2.stdout.slice(r2.stdout.indexOf('{')));
      expect(out2.task.interface_contract).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── project_kind-aware planning (greenfield vs brownfield) ─────────────
describe('project_kind-aware planning', () => {
  test('research on a greenfield project swaps perspectives, flags landscape as web, and suggests probe', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp); // empty tmp dir → greenfield (no manifest/lockfile/source/git signal)
      const r = run(['research', 'topic'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.project_kind).toBe('greenfield');
      expect(output.perspectives).toEqual(['landscape', 'user-scenarios', 'architecture', 'pitfalls']);
      expect(output.suggest_probe).toBe(true);
      const landscapeSpec = output.agents_spec.find((s) => s.perspective === 'landscape');
      expect(landscapeSpec.web).toBe(true);
      for (const spec of output.agents_spec) {
        if (spec.perspective !== 'landscape') expect(spec.web).toBeUndefined();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('research on a brownfield project (package.json present) keeps the existing perspectives with no web field', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      writeFileSync(join(tmp, 'package.json'), '{"name":"existing-project"}\n');
      setupProject(tmp);
      const r = run(['research', 'topic'], { cwd: tmp });
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout);
      expect(output.project_kind).toBe('brownfield');
      expect(output.perspectives).toEqual(['stack', 'features', 'architecture', 'pitfalls']);
      expect(output.suggest_probe).toBe(false);
      for (const spec of output.agents_spec) expect(spec.web).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a manifest missing the project_kind field (pre-migration) falls back to brownfield on plan + next', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      const manifestFile = join(tmp, '.xm', 'build', 'projects', name, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      delete manifest.project_kind;
      writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));

      const planOut = JSON.parse(run(['plan', 'Build something'], { cwd: tmp }).stdout);
      expect(planOut.project_kind).toBe('brownfield');

      const nextOut = JSON.parse(run(['next', '--json'], { cwd: tmp }).stdout);
      expect(nextOut.project_kind).toBe('brownfield');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('next --json signals round0_pending for a greenfield project until discuss-round0.json exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp); // greenfield; current_phase defaults to research
      const before = JSON.parse(run(['next', '--json'], { cwd: tmp }).stdout);
      expect(before.project_kind).toBe('greenfield');
      expect(before.round0_pending).toBe(true);

      const round0Path = join(tmp, '.xm', 'build', 'projects', name, 'phases', '01-research', 'discuss-round0.json');
      mkdirSync(dirname(round0Path), { recursive: true });
      writeFileSync(round0Path, JSON.stringify({ done: true }));

      const after = JSON.parse(run(['next', '--json'], { cwd: tmp }).stdout);
      expect(after.round0_pending).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('discuss round 0 saves to an isolated filename that never contaminates the round-1 chain', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      setupProject(tmp);
      const round0 = JSON.parse(run(['discuss', '--mode', 'interview', '--round', '0'], { cwd: tmp }).stdout);
      expect(round0.save_path.endsWith('discuss-round0.json')).toBe(true);

      // Simulate a completed round 0.
      writeFileSync(round0.save_path, JSON.stringify({ some: 'round0-data' }));

      // A real round-1 result, distinct from round 0's content. Round 2's
      // prevPath lookup is discuss-interview-r{2-1}.json = ...-r1.json.
      const r1Path = join(dirname(round0.save_path), 'discuss-interview-r1.json');
      writeFileSync(r1Path, JSON.stringify({ some: 'round1-data' }));

      // Asserting round1.previous_round === undefined (the old assertion) is
      // trivially true regardless of isolation: round 1's own prevPath lookup
      // is discuss-interview-r0.json, a file round 0 never writes to (it
      // writes discuss-round0.json instead), so that assertion passes even if
      // the isolation were broken. Round 2 is the real test: its prevPath
      // (discuss-interview-r1.json) DOES exist, so previous_round must carry
      // ONLY round 1's data, never round 0's.
      const round2 = JSON.parse(run(['discuss', '--mode', 'interview', '--round', '2'], { cwd: tmp }).stdout);
      expect(round2.previous_round).toEqual({ some: 'round1-data' });

      // And the round-1-chain filename round 1 would have looked up
      // (discuss-interview-r0.json) must never have been created by round 0.
      const r0ChainPath = join(dirname(round0.save_path), 'discuss-interview-r0.json');
      expect(existsSync(r0ChainPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── prd-check structural warnings (Section 9 / Section 10 / At a Glance) ──
describe('prd-check structural warnings (Section 9 / Section 10 / At a Glance)', () => {
  test('flags a >=3-step scenario without a diagram, a >=3-hop data flow without a diagram, and a missing At a Glance section', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      const body = [
        '# PRD',
        '',
        '## 9. Key Scenarios',
        '1. User opens the app',
        '2. User logs in',
        '3. User sees the dashboard',
        '',
        '## 10. Data Flow / Data Model',
        'Client → API → DB → Cache',
        '',
        '## 12. Acceptance Criteria',
        '- works',
        '',
      ].join('\n');
      writePRD(tmp, name, body);
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp }).stdout);
      expect(out.warnings.some((w) => /Section 9/.test(w))).toBe(true);
      expect(out.warnings.some((w) => /Section 10/.test(w))).toBe(true);
      expect(out.warnings.some((w) => /At a Glance/.test(w))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── F12: a fenced diagram alongside the scenario/data-flow content must
  // suppress the "no diagram" warning for that section (extractFencedBlocks
  // scoped to that section's own boundary, not leaking in from elsewhere).
  // Uses a "■ Diagram:" marker + non-empty fence so it's recognized by
  // sectionHasDiagram's primary rule — a plain unmarked arrow-text fence is
  // exactly the kind of "any fence exists" false pass the panel review
  // caught (see the two tests below), so this fixture must itself qualify
  // as a real diagram under the tightened check.
  test('a >=3-step scenario and a >=3-hop data flow with a fenced diagram present do NOT warn', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      const body = [
        '# PRD',
        '',
        '## 9. Key Scenarios',
        '1. User opens the app',
        '2. User logs in',
        '3. User sees the dashboard',
        '',
        '■ Diagram: User flow',
        '```',
        'User -> App -> Login -> Dashboard',
        '```',
        '',
        '## 10. Data Flow / Data Model',
        'Client → API → DB → Cache',
        '',
        '■ Diagram: Data flow',
        '```',
        '[Client] -> [API] -> [DB] -> [Cache]',
        '```',
        '',
        '## 12. Acceptance Criteria',
        '- works',
        '',
      ].join('\n');
      writePRD(tmp, name, body);
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp }).stdout);
      expect(out.warnings.some((w) => /Section 9/.test(w))).toBe(false);
      expect(out.warnings.some((w) => /Section 10/.test(w))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── Panel-review fix: an unrelated example fence (e.g. ```typescript) is
  // not a diagram — "any fence exists" previously suppressed the warning.
  test('a >=3-step scenario with only a typescript example fence (not a diagram) still warns', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      const body = [
        '# PRD',
        '',
        '## 9. Key Scenarios',
        '1. User opens the app',
        '2. User logs in',
        '3. User sees the dashboard',
        '',
        '```typescript',
        'interface Foo { bar: string; }',
        '```',
        '',
        '## 12. Acceptance Criteria',
        '- works',
        '',
      ].join('\n');
      writePRD(tmp, name, body);
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp }).stdout);
      expect(out.warnings.some((w) => /Section 9/.test(w))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('a >=3-hop data flow with only a typescript example fence (not a diagram) still warns', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'xb-test-'));
    try {
      const name = setupProject(tmp);
      const body = [
        '# PRD',
        '',
        '## 10. Data Flow / Data Model',
        'Client → API → DB → Cache',
        '',
        '```typescript',
        'interface Foo { bar: string; }',
        '```',
        '',
        '## 12. Acceptance Criteria',
        '- works',
        '',
      ].join('\n');
      writePRD(tmp, name, body);
      const out = JSON.parse(run(['prd-check', '--json'], { cwd: tmp }).stdout);
      expect(out.warnings.some((w) => /Section 10/.test(w))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
