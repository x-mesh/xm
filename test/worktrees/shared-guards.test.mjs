/**
 * worktree-shared trust-boundary + root-resolution helpers.
 *
 * Covers the review-fix units:
 *   F3/F10 — validateIdSegment: rejects traversal / argv-injection segments,
 *            accepts the reserved __integration__ id.
 *   F6/F7  — resolveMainRepoRoot: from a LINKED worktree cwd resolves to the
 *            MAIN repo root (via git-common-dir), and buildAgentEnv points the
 *            injected root env at the main .xm/, not the worktree's.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { validateIdSegment, resolveMainRepoRoot } = await import('../../x-build/lib/x-build/worktree-shared.mjs');
const { buildAgentEnv } = await import('../../x-build/lib/x-build/worktrees.mjs');

const gitq = (cwd, c) => execSync(`git ${c}`, { cwd, stdio: 'pipe', shell: '/bin/bash' });

describe('validateIdSegment (F3/F10)', () => {
  test('accepts normal ids', () => {
    expect(validateIdSegment('demo', 'project')).toBeNull();
    expect(validateIdSegment('t1', 'task')).toBeNull();
    expect(validateIdSegment('my-proj_2.0', 'project')).toBeNull();
  });

  test('accepts the reserved __integration__ id', () => {
    expect(validateIdSegment('__integration__', 'task')).toBeNull();
  });

  test('rejects path traversal', () => {
    expect(validateIdSegment('../x', 'task')).toBeTruthy();
    expect(validateIdSegment('a/../b', 'task')).toBeTruthy();
    expect(validateIdSegment('..', 'task')).toBeTruthy();
  });

  test('rejects slashes / spaces / leading dash (argv injection)', () => {
    expect(validateIdSegment('a/b', 'task')).toBeTruthy();
    expect(validateIdSegment('a b', 'task')).toBeTruthy();
    expect(validateIdSegment('--flag', 'task')).toBeTruthy();
    expect(validateIdSegment('.hidden', 'task')).toBeTruthy();
  });

  test('rejects empty / non-string', () => {
    expect(validateIdSegment('', 'task')).toBeTruthy();
    expect(validateIdSegment(undefined, 'task')).toBeTruthy();
    expect(validateIdSegment(null, 'task')).toBeTruthy();
  });
});

describe('resolveMainRepoRoot + buildAgentEnv (F6/F7)', () => {
  let main;
  let wt;

  beforeAll(() => {
    main = mkdtempSync(join(tmpdir(), 'sg-main-'));
    gitq(main, 'init -q');
    gitq(main, 'config user.email t@t.com');
    gitq(main, 'config user.name T');
    writeFileSync(join(main, 'f.txt'), 'x\n');
    gitq(main, 'add -A && git commit -q -m c1');
    gitq(main, 'branch develop');
    wt = join(main, '..', `sg-wt-${Date.now()}`);
    gitq(main, `worktree add -q -b feat/wt ${JSON.stringify(wt)} develop`);
  });

  afterAll(() => {
    try { gitq(main, `worktree remove --force ${JSON.stringify(wt)}`); } catch {}
    for (const d of [main, wt]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
  });

  test('from a linked worktree cwd → resolves to the MAIN repo root', () => {
    const resolved = resolveMainRepoRoot(wt);
    expect(resolved).not.toBeNull();
    expect(realpathSync(resolved)).toBe(realpathSync(main));
  });

  test('from the main repo cwd → resolves to itself', () => {
    expect(realpathSync(resolveMainRepoRoot(main))).toBe(realpathSync(main));
  });

  test('buildAgentEnv points root env at MAIN .xm/ even from a worktree cwd', () => {
    // Env paths are constructed (not on disk), so compare against the realpath'd
    // main root rather than realpath-ing the .xm/ paths themselves.
    const realMain = realpathSync(main);
    const env = buildAgentEnv(resolveMainRepoRoot(wt));
    expect(env.X_BUILD_ROOT).toBe(join(realMain, '.xm', 'build'));
    expect(env.XM_ROOT).toBe(join(realMain, '.xm'));
    // never the worktree's own .xm/
    expect(env.X_BUILD_ROOT.startsWith(realpathSync(wt))).toBe(false);
  });

  test('non-git directory → null (caller falls back to cwd)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'sg-plain-'));
    try {
      expect(resolveMainRepoRoot(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
