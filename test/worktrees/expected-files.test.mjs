/**
 * expected_files[] — schema storage + overlap/parallel-safe utils + plan-check warn.
 *
 * Covers task t3 of the worktree-pipeline plan:
 *   - `tasks add`/`tasks update --expected-files` store the field (comma-separated)
 *   - backward compat: reading tasks.json without the field does not break
 *   - expectedFilesOverlap() intersection (overlap / no overlap)
 *   - isParallelSafe() classifies empty/overlapping tasks as sequential
 *   - plan-check emits a warn (not error) for missing/empty/absolute expected_files
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(__dirname, '..', '..', 'x-build', 'lib', 'x-build-cli.mjs');

const {
  normalizeExpectedFiles, expectedFilesOverlap, isParallelSafe,
} = await import('../../x-build/lib/x-build/tasks.mjs');

// ── CLI helpers ────────────────────────────────────────────────────────────

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

function tasksFilePath(tmp, name) {
  return join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'tasks.json');
}

function planCheckJsonPath(tmp, name) {
  return join(tmp, '.xm', 'build', 'projects', name, 'phases', '02-plan', 'plan-check.json');
}

// ── pure-unit: overlap / parallel-safe ──────────────────────────────────────

describe('normalizeExpectedFiles', () => {
  it('coerces missing/null/non-array to []', () => {
    expect(normalizeExpectedFiles(undefined)).toEqual([]);
    expect(normalizeExpectedFiles(null)).toEqual([]);
    expect(normalizeExpectedFiles('a.mjs')).toEqual([]);
    expect(normalizeExpectedFiles({})).toEqual([]);
  });

  it('drops non-string / blank entries and trims', () => {
    expect(normalizeExpectedFiles([' a.mjs ', '', '  ', 'b.mjs', 42])).toEqual(['a.mjs', 'b.mjs']);
  });
});

describe('expectedFilesOverlap', () => {
  it('returns intersection when files overlap', () => {
    const a = { expected_files: ['src/a.mjs', 'src/b.mjs'] };
    const b = { expected_files: ['src/b.mjs', 'src/c.mjs'] };
    expect(expectedFilesOverlap(a, b)).toEqual(['src/b.mjs']);
  });

  it('returns [] when files do not overlap', () => {
    const a = { expected_files: ['src/a.mjs'] };
    const b = { expected_files: ['src/c.mjs'] };
    expect(expectedFilesOverlap(a, b)).toEqual([]);
  });

  it('returns [] when either task has no expected_files', () => {
    expect(expectedFilesOverlap({ expected_files: ['x'] }, {})).toEqual([]);
    expect(expectedFilesOverlap({}, { expected_files: ['x'] })).toEqual([]);
  });
});

describe('isParallelSafe', () => {
  it('classifies non-overlapping tasks with files as safe', () => {
    const tasks = [
      { id: 't1', expected_files: ['a.mjs'] },
      { id: 't2', expected_files: ['b.mjs'] },
    ];
    const { safe, sequential } = isParallelSafe(tasks);
    expect(safe.sort()).toEqual(['t1', 't2']);
    expect(sequential).toEqual([]);
  });

  it('classifies overlapping tasks as sequential (both sides)', () => {
    const tasks = [
      { id: 't1', expected_files: ['shared.mjs', 'a.mjs'] },
      { id: 't2', expected_files: ['shared.mjs'] },
      { id: 't3', expected_files: ['c.mjs'] },
    ];
    const { safe, sequential, reason } = isParallelSafe(tasks);
    expect(safe).toEqual(['t3']);
    expect(sequential.sort()).toEqual(['t1', 't2']);
    expect(reason).toContain('shared.mjs');
  });

  it('classifies empty/missing expected_files as sequential (unknown → sequential)', () => {
    const tasks = [
      { id: 't1', expected_files: [] },
      { id: 't2' },
      { id: 't3', expected_files: ['a.mjs'] },
    ];
    const { safe, sequential, reason } = isParallelSafe(tasks);
    expect(safe).toEqual(['t3']);
    expect(sequential.sort()).toEqual(['t1', 't2']);
    expect(reason).toContain('no expected_files');
  });
});

// ── CLI integration: store / load / plan-check ──────────────────────────────

describe('expected_files — CLI store/load + plan-check', () => {
  let TMP;
  const NAME = 'ef-proj';

  beforeAll(() => {
    TMP = mkdtempSync(join(tmpdir(), 'xb-ef-'));
    run(['init', NAME], { cwd: TMP });

    // t1: with expected-files on add
    run(['tasks', 'add', 'Implement search index', '--expected-files', 'src/search.mjs, src/index.mjs'], { cwd: TMP });
    // t2: no expected-files on add (defaults to [])
    run(['tasks', 'add', 'Write docs'], { cwd: TMP });
    // t3: set via update
    run(['tasks', 'add', 'Build cache'], { cwd: TMP });
    run(['tasks', 'update', 't3', '--expected-files', 'src/cache.mjs'], { cwd: TMP });
  });

  afterAll(() => {
    if (TMP) rmSync(TMP, { recursive: true, force: true });
  });

  it('tasks add stores expected_files as trimmed string[]', () => {
    const data = JSON.parse(readFileSync(tasksFilePath(TMP, NAME), 'utf8'));
    const t1 = data.tasks.find(t => t.id === 't1');
    expect(t1.expected_files).toEqual(['src/search.mjs', 'src/index.mjs']);
  });

  it('tasks add without --expected-files defaults to [] (backward-safe)', () => {
    const data = JSON.parse(readFileSync(tasksFilePath(TMP, NAME), 'utf8'));
    const t2 = data.tasks.find(t => t.id === 't2');
    expect(t2.expected_files).toEqual([]);
  });

  it('tasks update --expected-files replaces the list', () => {
    const data = JSON.parse(readFileSync(tasksFilePath(TMP, NAME), 'utf8'));
    const t3 = data.tasks.find(t => t.id === 't3');
    expect(t3.expected_files).toEqual(['src/cache.mjs']);
  });

  it('tasks update --expected-files "" clears the list', () => {
    run(['tasks', 'update', 't3', '--expected-files', ''], { cwd: TMP });
    const data = JSON.parse(readFileSync(tasksFilePath(TMP, NAME), 'utf8'));
    const t3 = data.tasks.find(t => t.id === 't3');
    expect(t3.expected_files).toEqual([]);
    // restore for later reads
    run(['tasks', 'update', 't3', '--expected-files', 'src/cache.mjs'], { cwd: TMP });
  });

  it('reads a tasks.json written WITHOUT the field (backward compat)', () => {
    // Simulate a legacy task with no expected_files field, then re-run a read path.
    const tPath = tasksFilePath(TMP, NAME);
    const data = JSON.parse(readFileSync(tPath, 'utf8'));
    delete data.tasks.find(t => t.id === 't2').expected_files;
    writeFileSync(tPath, JSON.stringify(data, null, 2));
    const res = run(['tasks', 'list'], { cwd: TMP });
    expect(res.exitCode).toBe(0);
    // util must treat legacy task as empty (sequential), not crash
    const reloaded = JSON.parse(readFileSync(tPath, 'utf8'));
    const { sequential } = isParallelSafe(reloaded.tasks);
    expect(sequential).toContain('t2');
  });

  it('plan-check emits a WARN (not error) for tasks missing expected_files', () => {
    const res = run(['plan-check'], { cwd: TMP });
    expect(res.exitCode).toBe(0);
    const jsonData = JSON.parse(readFileSync(planCheckJsonPath(TMP, NAME), 'utf8'));
    const efChecks = jsonData.checks.filter(c => c.dim === 'expected-files');
    expect(efChecks.length).toBeGreaterThan(0);
    // never error-level — must not fail existing projects
    expect(efChecks.every(c => c.level === 'warn')).toBe(true);
    // t2 (empty/legacy) is flagged
    expect(efChecks.some(c => c.task === 't2')).toBe(true);
    // plan-check overall still passes (no errors)
    expect(jsonData.passed).toBe(true);
  });

  it('plan-check warns on an absolute-path expected_files entry', () => {
    const tPath = tasksFilePath(TMP, NAME);
    const data = JSON.parse(readFileSync(tPath, 'utf8'));
    data.tasks.find(t => t.id === 't1').expected_files = ['/etc/passwd'];
    writeFileSync(tPath, JSON.stringify(data, null, 2));
    run(['plan-check'], { cwd: TMP });
    const jsonData = JSON.parse(readFileSync(planCheckJsonPath(TMP, NAME), 'utf8'));
    const abs = jsonData.checks.find(c => c.dim === 'expected-files' && c.task === 't1' && /absolute path/.test(c.msg));
    expect(abs).toBeTruthy();
    expect(abs.level).toBe('warn');
  });
});
