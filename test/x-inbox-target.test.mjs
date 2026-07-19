/**
 * x-inbox target resolution (cross-project-handoff t4): registry lookup +
 * .xm/ existence pre-check + unregistered/missing/ambiguous distinction, and
 * the mem-mesh identity-chain resolver used for the outgoing pin's project_id.
 *
 * resolveTarget() reads the real ~/.xm/projects.json through
 * x-projects-registry.mjs's home-dir-derived REGISTRY_PATH constant, so every
 * resolveTarget() scenario here runs inside a `node` subprocess with HOME
 * redirected to a disposable temp dir instead of importing target.mjs
 * in-process. Bun's in-process os.homedir() does not honor a
 * process.env.HOME override (see test/core-unit.test.mjs:673-679 for the
 * same quirk hitting loadSharedConfig) — but a real `node` subprocess does,
 * which is why core.test.mjs/coverage.test.mjs use the identical pattern.
 * This also guarantees these tests never read or mutate the developer's
 * actual global project registry.
 *
 * isSimilarProjectName() and resolveMemMeshProjectId() have no homedir
 * dependency, so they're exercised with a direct in-process import.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  resolveMemMeshProjectId,
  isSimilarProjectName,
  MEM_MESH_GIT_CONFIG_KEY,
  MEM_MESH_ENV_VAR,
} from '../xm/lib/x-inbox/target.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET_MJS_URL = pathToFileURL(
  join(__dirname, '..', 'xm', 'lib', 'x-inbox', 'target.mjs'),
).href;

function git(cmd, cwd) {
  return execSync(`git ${cmd}`, { cwd, stdio: 'pipe', shell: '/bin/bash' }).toString().trim();
}

function writeRegistry(home, projects) {
  const dir = join(home, '.xm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'projects.json'),
    JSON.stringify({ version: 1, updated_at: new Date().toISOString(), projects }, null, 2) + '\n',
  );
}

function makeEntry(id, path, overrides = {}) {
  return {
    id,
    path,
    name: id,
    added_at: '2026-07-19T00:00:00.000Z',
    last_seen: '2026-07-19T00:00:00.000Z',
    tags: [],
    archived: false,
    ...overrides,
  };
}

// Runs resolveTarget(name) in a fresh `node` subprocess with HOME -> home, so
// x-projects-registry.mjs's REGISTRY_PATH resolves inside our temp fixture
// instead of the developer's real ~/.xm/projects.json.
function resolveTargetIsolated(name, home) {
  const harnessDir = mkdtempSync(join(tmpdir(), 'x-inbox-target-harness-'));
  try {
    const harnessPath = join(harnessDir, 'run.mjs');
    writeFileSync(harnessPath, [
      `import { resolveTarget } from ${JSON.stringify(TARGET_MJS_URL)};`,
      'const result = resolveTarget(process.argv[2]);',
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n'));

    const r = spawnSync('node', [harnessPath, name], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      timeout: 10000,
    });
    if (r.status !== 0) {
      throw new Error(`harness exited ${r.status}: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
  } finally {
    rmSync(harnessDir, { recursive: true, force: true });
  }
}

describe('resolveTarget — 3 failure modes, each with a distinct reason (t4 done_criteria)', () => {
  test('unregistered: no entry and no similar name -> stops with reason "unregistered"', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-home-'));
    const projDir = mkdtempSync(join(tmpdir(), 'x-inbox-proj-'));
    try {
      mkdirSync(join(projDir, '.xm'), { recursive: true });
      writeRegistry(home, [makeEntry('git-kit', projDir)]);

      const result = resolveTargetIsolated('totally-unrelated-name-xyz', home);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('unregistered');
      expect(result.candidates).toEqual([]);
      expect(result.message).toMatch(/xm project add/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projDir, { recursive: true, force: true });
    }
  });

  test('missing: registered but .xm/ no longer exists at the path -> stops with reason "missing"', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-home-'));
    // Deliberately no .xm/ under ghostDir — simulates a deleted/moved checkout
    // that gcRegistry() (manual-only, 0 other call sites) never reaped.
    const ghostDir = mkdtempSync(join(tmpdir(), 'x-inbox-ghost-'));
    try {
      writeRegistry(home, [makeEntry('ghost-project', ghostDir)]);

      const result = resolveTargetIsolated('ghost-project', home);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('missing');
      expect(result.candidates).toEqual([]);
      expect(result.message).toMatch(/no longer exists/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(ghostDir, { recursive: true, force: true });
    }
  });

  test('ambiguous: 2 similarly-named registered entries -> stops with candidates, never guesses', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-home-'));
    const dirA = mkdtempSync(join(tmpdir(), 'x-inbox-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'x-inbox-b-'));
    try {
      mkdirSync(join(dirA, '.xm'), { recursive: true });
      mkdirSync(join(dirB, '.xm'), { recursive: true });
      writeRegistry(home, [makeEntry('git-kit', dirA), makeEntry('git-kits', dirB)]);

      const result = resolveTargetIsolated('gitkit', home);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('ambiguous');
      expect([...result.candidates].sort()).toEqual(['git-kit', 'git-kits']);
      expect(result.message).toMatch(/Did you mean/);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  test('ok: exact id match with .xm/ present resolves {path, memMeshProjectId} — the non-failure control case', () => {
    const home = mkdtempSync(join(tmpdir(), 'x-inbox-home-'));
    const projDir = mkdtempSync(join(tmpdir(), 'x-inbox-real-'));
    try {
      mkdirSync(join(projDir, '.xm'), { recursive: true });
      writeRegistry(home, [makeEntry('real-project', projDir)]);

      const result = resolveTargetIsolated('real-project', home);
      expect(result.ok).toBe(true);
      expect(result.path).toBe(projDir);
      expect(typeof result.memMeshProjectId).toBe('string');
      expect(result.memMeshProjectId.length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(projDir, { recursive: true, force: true });
    }
  });
});

describe('isSimilarProjectName — fuzzy-match heuristic backing the ambiguous branch', () => {
  test('hyphen/underscore-only difference counts as similar, not silently identical', () => {
    expect(isSimilarProjectName('gitkit', 'git-kit')).toBe(true);
  });

  test('unrelated short names do not match', () => {
    expect(isSimilarProjectName('zzz', 'git-kit')).toBe(false);
  });

  test('empty input never matches', () => {
    expect(isSimilarProjectName('', 'git-kit')).toBe(false);
    expect(isSimilarProjectName('git-kit', '')).toBe(false);
  });
});

describe('resolveMemMeshProjectId — mem-mesh\'s own priority chain, not resolveCanonicalPath()', () => {
  test('env var wins over everything else — ONLY when resolving self', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-mm-env-'));
    const orig = process.env[MEM_MESH_ENV_VAR];
    try {
      process.env[MEM_MESH_ENV_VAR] = 'env-project-id';
      // Self-identity ("what project am I?") — mem-mesh defines the env var as
      // the top of its chain, so it wins. toss() passes this flag for `cwd`.
      expect(resolveMemMeshProjectId(dir, { allowEnvOverride: true })).toBe('env-project-id');
    } finally {
      if (orig === undefined) delete process.env[MEM_MESH_ENV_VAR];
      else process.env[MEM_MESH_ENV_VAR] = orig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('env var is IGNORED when resolving a foreign target path (default)', () => {
    // Regression: the env var is process-wide, so honoring it for a foreign
    // path made every toss address the SENDER's project id no matter which
    // target was named. resolveTarget() resolves foreign paths and must not
    // opt in. Cross-vendor review split on this (claude/cursor: misrouting,
    // codex: documented override) — both are right, for different call sites.
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-mm-foreign-'));
    const orig = process.env[MEM_MESH_ENV_VAR];
    try {
      process.env[MEM_MESH_ENV_VAR] = 'sender-own-id';
      const resolved = resolveMemMeshProjectId(dir);
      expect(resolved).not.toBe('sender-own-id');
      // Falls through to the basename of the target path itself.
      expect(resolved).toBe(basename(dir));
    } finally {
      if (orig === undefined) delete process.env[MEM_MESH_ENV_VAR];
      else process.env[MEM_MESH_ENV_VAR] = orig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('git config mem-mesh.project-id wins over the basename fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-mm-cfg-'));
    try {
      git('init -q', dir);
      git(`config --local ${MEM_MESH_GIT_CONFIG_KEY} configured-id`, dir);
      expect(resolveMemMeshProjectId(dir)).toBe('configured-id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('.mem-mesh/project-id file wins over the basename fallback when git config is unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-mm-file-'));
    try {
      git('init -q', dir);
      mkdirSync(join(dir, '.mem-mesh'), { recursive: true });
      writeFileSync(join(dir, '.mem-mesh', 'project-id'), 'file-project-id\n');
      expect(resolveMemMeshProjectId(dir)).toBe('file-project-id');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to basename(git root) when nothing else is set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x-inbox-mm-fallback-'));
    try {
      git('init -q', dir);
      expect(resolveMemMeshProjectId(dir)).toBe(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('worktree identity does NOT collapse to the main checkout (unlike resolveCanonicalPath)', () => {
    const main = mkdtempSync(join(tmpdir(), 'x-inbox-mm-main-'));
    const worktreeParent = mkdtempSync(join(tmpdir(), 'x-inbox-mm-wt-'));
    try {
      git('init -q', main);
      git('config user.email t@t.com', main);
      git('config user.name T', main);
      writeFileSync(join(main, 'f.txt'), 'x');
      git('add -A && git commit -q -m c1', main);

      const worktreePath = join(worktreeParent, 'wt');
      git(`worktree add -q -b wt-branch "${worktreePath}"`, main);

      // mem-mesh's chain treats the worktree as its own project (basename of
      // its own toplevel) — x-kit's resolveCanonicalPath() would instead
      // fold this back to basename(main). This divergence is the identity
      // mismatch PRD §7 Risks calls out.
      expect(resolveMemMeshProjectId(worktreePath)).toBe('wt');

      git(`worktree remove --force "${worktreePath}"`, main);
    } finally {
      rmSync(main, { recursive: true, force: true });
      rmSync(worktreeParent, { recursive: true, force: true });
    }
  });
});
