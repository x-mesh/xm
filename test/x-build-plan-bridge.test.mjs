import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..');
const CLI = join(REPO, 'x-build', 'lib', 'x-build-cli.mjs');

function run(cwd, args, env = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd,
    env: { ...process.env, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: join(cwd, '.xm', 'build'), XKIT_SERVER: '0', ...env },
    encoding: 'utf8',
  });
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function executableEnvelope() {
  return {
    schema_version: 1, status: 'complete', executable: true, goal: 'Ship imported plan',
    requirements: [{ id: 'R1', text: 'Add API', priority: 'must' }, { id: 'R2', text: 'Add tests', priority: 'must' }], assumptions: [],
    decision: { selected: 'Native plan', alternatives: [] },
    tasks: [
      { id: 'A', title: 'Implement API', depends_on: [], requirement_refs: ['R1'], expected_files: ['src/api.mjs'], done_criteria: ['API returns expected data'] },
      { id: 'B', title: 'Add tests', depends_on: ['A'], requirement_refs: ['R2'], expected_files: ['test/api.test.mjs'], done_criteria: ['node --test passes'] },
    ],
    steps: [['A'], ['B']], validation: { commands: ['node --test'], requirement_refs: ['R1', 'R2'] },
    disagreements: [], unresolved_questions: [], provenance: { source: 'native' },
  };
}

describe('xm build plan bridge', () => {
  test('plan delegates to x-plan and never creates an x-build project', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-build-plan-bridge-'));
    try {
      const result = run(cwd, ['plan', '--mode', 'quick', '- Add export', '- Add tests']);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('deprecated');
      expect(result.stderr).toContain('xm plan');
      expect(result.stdout).toContain('# Plan:');
      expect(existsSync(join(cwd, '.xm', 'plan'))).toBe(true);
      expect(existsSync(join(cwd, '.xm', 'build', 'projects'))).toBe(false);
      expect(readdirSync(join(cwd, '.xm', 'plan')).length).toBe(1);
      expect(result.stderr).toContain('this workspace has no x-build project');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('plan preserves x-plan machine errors and exit codes', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-build-plan-bridge-'));
    try {
      const result = run(cwd, ['plan', '--mode', 'standard', '--json', 'Add API']);
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stdout).errors[0].code).toBe('cli.standard_contract');
      expect(existsSync(join(cwd, '.xm', 'build', 'projects'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('legacy-plan retains the former x-build planner explicitly', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-build-plan-bridge-'));
    try {
      expect(run(cwd, ['init', 'demo']).code).toBe(0);
      const result = run(cwd, ['legacy-plan', 'Add API', '--quick', '--json']);
      expect(result.code, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.project).toBe('demo');
      expect(existsSync(join(cwd, '.xm', 'build', 'projects', 'demo'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('an executable plan is imported into the x-build project', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-build-plan-bridge-'));
    try {
      expect(run(cwd, ['init', 'demo']).code).toBe(0);
      const file = join(cwd, 'envelope.json');
      writeFileSync(file, JSON.stringify(executableEnvelope()));

      const result = run(cwd, ['plan', '--persist', '--file', file]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('importing');

      const projectDir = join(cwd, '.xm', 'build', 'projects', 'demo');
      expect(existsSync(join(projectDir, 'phases', '02-plan', 'PRD.md'))).toBe(true);
      const tasks = JSON.parse(readFileSync(join(projectDir, 'phases', '02-plan', 'tasks.json'), 'utf8')).tasks;
      expect(tasks.map((task) => task.depends_on)).toEqual([[], ['t1']]);
      expect(JSON.parse(readFileSync(join(projectDir, 'manifest.json'), 'utf8')).current_phase).toBe('02-plan');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a draft plan is saved but not imported, and says why', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-build-plan-bridge-'));
    try {
      expect(run(cwd, ['init', 'demo']).code).toBe(0);
      const result = run(cwd, ['plan', '--mode', 'quick', 'Add an export command']);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain('still a draft');
      expect(result.stderr).toContain('xm build legacy-plan');
      expect(existsSync(join(cwd, '.xm', 'build', 'projects', 'demo', 'phases', '02-plan', 'PRD.md'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('--no-import keeps the plan out of the x-build project', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-build-plan-bridge-'));
    try {
      expect(run(cwd, ['init', 'demo']).code).toBe(0);
      const file = join(cwd, 'envelope.json');
      writeFileSync(file, JSON.stringify(executableEnvelope()));

      const result = run(cwd, ['plan', '--no-import', '--persist', '--file', file]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toContain('importing');
      expect(existsSync(join(cwd, '.xm', 'build', 'projects', 'demo', 'phases', '02-plan', 'PRD.md'))).toBe(false);
      expect(readdirSync(join(cwd, '.xm', 'plan')).length).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('--global is refused because the two roots would diverge', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-build-plan-bridge-'));
    try {
      const result = run(cwd, ['plan', '--global', 'Add an export command']);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('--global is not supported');
      expect(existsSync(join(cwd, '.xm', 'plan'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Every standalone x-build install takes this branch: the plugin cache ships
  // no x-plan module tree, so loadXPlanMain() always throws there.
  test('delegates through the xm dispatcher when x-plan is not colocated', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'x-build-plan-bridge-'));
    try {
      const lib = join(cwd, 'install', 'lib');
      cpSync(join(REPO, 'x-build', 'lib'), lib, { recursive: true });
      expect(existsSync(join(lib, 'x-plan-cli.mjs'))).toBe(false);

      const bin = join(cwd, 'bin');
      mkdirSync(bin, { recursive: true });
      const stub = join(bin, 'xm');
      writeFileSync(stub, '#!/bin/sh\necho "stub xm $*"\nexit 7\n');
      chmodSync(stub, 0o755);

      const result = spawnSync('node', [join(lib, 'x-build-cli.mjs'), 'plan', 'Add an export command'], {
        cwd,
        env: { ...process.env, PATH: bin + ':' + process.env.PATH, XM_ROOT: join(cwd, '.xm'), X_BUILD_ROOT: join(cwd, '.xm', 'build'), XKIT_SERVER: '0' },
        encoding: 'utf8',
      });
      expect(result.status).toBe(7);
      expect(result.stderr).toContain('x-plan module is not colocated');
      expect(result.stdout).toContain('stub xm plan Add an export command');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
