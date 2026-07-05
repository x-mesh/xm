/**
 * project-kind — deterministic greenfield/brownfield classifier gauge tests.
 * Mirrors x-build/lib/x-build/core.mjs:gaugeProjectKind's own decision rule:
 * all 4 signals miss -> greenfield; 1+ hit -> brownfield; a git execution
 * error overrides to brownfield regardless of the other 3 signals.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'x-build', 'lib', 'x-build-cli.mjs');

function run(args, cwd, env) {
  const r = spawnSync('node', [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

function runJSON(args, cwd, env) {
  const r = run([...args, '--json'], cwd, env);
  return JSON.parse(r.stdout);
}

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe', shell: '/bin/bash' }).toString().trim();
}

function findSignal(out, id) {
  return out.signals.find((s) => s.id === id);
}

describe('project-kind — deterministic greenfield/brownfield gauge', () => {
  test('empty directory -> greenfield (all 4 signals miss)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      const out = runJSON(['project-kind', '--cwd', tmp], tmp);
      expect(out.kind).toBe('greenfield');
      expect(out.hits).toBe(0);
      expect(out.total).toBe(4);
      expect(out.signals.every((s) => s.hit === false)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('README.md only -> greenfield (docs alone are not a project signal)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      writeFileSync(join(tmp, 'README.md'), '# Hello\n');
      const out = runJSON(['project-kind', '--cwd', tmp], tmp);
      expect(out.kind).toBe('greenfield');
      expect(out.hits).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('clone-like directory (git history + manifest + lockfile + source tree) -> brownfield, all 4 signals hit', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      git('init -q', tmp);
      git('config user.email t@t.com', tmp);
      git('config user.name T', tmp);
      writeFileSync(join(tmp, 'package.json'), '{"name":"clone-like"}\n');
      writeFileSync(join(tmp, 'bun.lockb'), '');
      mkdirSync(join(tmp, 'src'), { recursive: true });
      writeFileSync(join(tmp, 'src', 'index.js'), 'module.exports = {};\n');
      git('add -A && git commit -q -m c1', tmp);
      writeFileSync(join(tmp, 'src', 'index.js'), 'module.exports = { v: 2 };\n');
      git('add -A && git commit -q -m c2', tmp);

      const out = runJSON(['project-kind', '--cwd', tmp], tmp);
      expect(out.kind).toBe('brownfield');
      expect(out.hits).toBe(4);
      expect(findSignal(out, 'manifest-present').hit).toBe(true);
      expect(findSignal(out, 'lockfile-present').hit).toBe(true);
      expect(findSignal(out, 'source-tree-present').hit).toBe(true);
      expect(findSignal(out, 'git-history-present').hit).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('monorepo subdirectory -> brownfield via upward manifest search (child itself is empty)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      writeFileSync(join(tmp, 'package.json'), '{"name":"monorepo-root"}\n');
      writeFileSync(join(tmp, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
      const child = join(tmp, 'child');
      mkdirSync(child, { recursive: true });

      const out = runJSON(['project-kind', '--cwd', child], tmp);
      expect(out.kind).toBe('brownfield');
      const manifestSignal = findSignal(out, 'manifest-present');
      expect(manifestSignal.hit).toBe(true);
      expect(manifestSignal.evidence).toContain('upward level 1');
      // The child directory itself has none of the other 3 signals.
      expect(findSignal(out, 'lockfile-present').hit).toBe(false);
      expect(findSignal(out, 'source-tree-present').hit).toBe(false);
      expect(findSignal(out, 'git-history-present').hit).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // F7: PK_UPWARD_BOUND is 6 — a manifest exactly at the bound must still hit,
  // one level past it must miss (bound-exhausted), never scanning to fs root.
  test('manifest exactly 6 levels up -> brownfield (upward level 6); 7 levels up -> greenfield (bound exhausted)', () => {
    const tmpHit = mkdtempSync(join(tmpdir(), 'pk-test-'));
    const tmpMiss = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      writeFileSync(join(tmpHit, 'package.json'), '{"name":"root-6"}\n');
      const targetHit = join(tmpHit, 'a1', 'a2', 'a3', 'a4', 'a5', 'a6');
      mkdirSync(targetHit, { recursive: true });
      const outHit = runJSON(['project-kind', '--cwd', targetHit], tmpHit);
      expect(outHit.kind).toBe('brownfield');
      const manifestHit = findSignal(outHit, 'manifest-present');
      expect(manifestHit.hit).toBe(true);
      expect(manifestHit.evidence).toContain('upward level 6');

      writeFileSync(join(tmpMiss, 'package.json'), '{"name":"root-7"}\n');
      const targetMiss = join(tmpMiss, 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7');
      mkdirSync(targetMiss, { recursive: true });
      const outMiss = runJSON(['project-kind', '--cwd', targetMiss], tmpMiss);
      expect(outMiss.kind).toBe('greenfield');
      expect(findSignal(outMiss, 'manifest-present').hit).toBe(false);
    } finally {
      rmSync(tmpHit, { recursive: true, force: true });
      rmSync(tmpMiss, { recursive: true, force: true });
    }
  });

  // F11: an empty src/ dir must not satisfy source-tree-present — the signal
  // requires at least one real file underneath, not just the directory name.
  test('empty src/ directory only -> source-tree-present misses, kind greenfield', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      mkdirSync(join(tmp, 'src'), { recursive: true });
      const out = runJSON(['project-kind', '--cwd', tmp], tmp);
      expect(findSignal(out, 'source-tree-present').hit).toBe(false);
      expect(out.kind).toBe('greenfield');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('.xm/ only directory -> greenfield (harness bookkeeping is not a project signal)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      mkdirSync(join(tmp, '.xm'), { recursive: true });
      const out = runJSON(['project-kind', '--cwd', tmp], tmp);
      expect(out.kind).toBe('greenfield');
      expect(out.hits).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('git init with 0 commits -> git-history signal MISSES (not an error), overall greenfield', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      git('init -q', tmp);
      const out = runJSON(['project-kind', '--cwd', tmp], tmp);
      const gitSignal = findSignal(out, 'git-history-present');
      expect(gitSignal.hit).toBe(false);
      expect(gitSignal.evidence).not.toMatch(/^error:/);
      expect(out.kind).toBe('greenfield');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('git execution failure overrides kind to brownfield (fail-safe: unreadable state is never "new")', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    const noGitPathDir = mkdtempSync(join(tmpdir(), 'pk-nogit-path-'));
    try {
      // Absolute path bypasses PATH resolution for launching node itself; the
      // env we pass becomes the CLI child's own process.env, which its inner
      // `spawnSync('git', ...)` inherits (it doesn't override env itself) —
      // so `git` becomes unresolvable (ENOENT) without breaking node's launch.
      const r = spawnSync(process.execPath, [CLI, 'project-kind', '--cwd', tmp, '--json'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: noGitPathDir },
      });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.kind).toBe('brownfield');
      const gitSignal = findSignal(out, 'git-history-present');
      expect(gitSignal.hit).toBe(false);
      expect(gitSignal.evidence).toMatch(/^error:/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(noGitPathDir, { recursive: true, force: true });
    }
  });

  test('x-build init stamps manifest.json with the gauged project_kind', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pk-test-'));
    try {
      run(['init', 'test-proj'], tmp);
      const manifest = JSON.parse(
        readFileSync(join(tmp, '.xm', 'build', 'projects', 'test-proj', 'manifest.json'), 'utf8')
      );
      expect(manifest.project_kind).toBe('greenfield');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
