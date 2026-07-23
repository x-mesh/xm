import { describe, test, expect } from 'bun:test';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, existsSync, readdirSync, cpSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildManifest,
  writeManifest,
  manifestPath,
  discoverManifests,
  readManifestIfExists,
  shouldSkipTarget,
} from '../xm/lib/install/manifest.mjs';
import { TARGET_TOOLS } from '../xm/lib/install/types.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeTmpHome() {
  return mkdtempSync(join(tmpdir(), 'xm-propagate-'));
}

/**
 * Plant a minimal valid manifest at the global path for a given target under root.
 */
function plantManifest(root, target) {
  const manifest = buildManifest({
    target,
    scope: 'global',
    installRoot: root,
    entries: [{ relativePath: 'dummy.txt', content: 'hello', mode: 0o600 }],
    now: 1_000_000,
  });
  writeManifest(manifest);
}

describe('discoverManifests', () => {
  test('returns empty when no roots have manifests', () => {
    const home = makeTmpHome();
    const results = discoverManifests([home]);
    expect(results).toHaveLength(0);
  });

  test('finds cursor + codex global manifests', () => {
    const home = makeTmpHome();
    plantManifest(home, 'cursor');
    plantManifest(home, 'codex');

    const results = discoverManifests([home]);
    expect(results).toHaveLength(2);

    const targets = results.map((r) => r.target).sort();
    expect(targets).toContain('cursor');
    expect(targets).toContain('codex');

    for (const r of results) {
      expect(r.scope).toBe('global');
      expect(r.installRoot).toBe(home);
      expect(typeof r.path).toBe('string');
    }
  });

  test('ignores non-existent searchRoot', () => {
    const home = makeTmpHome();
    const nonExistent = join(home, 'does-not-exist');
    plantManifest(home, 'cursor');

    let threw = false;
    let results;
    try {
      results = discoverManifests([home, nonExistent]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(results).toHaveLength(1);
  });

  test('stable target ordering (alphabetical)', () => {
    const home = makeTmpHome();
    // Plant all 5 targets
    for (const target of TARGET_TOOLS) {
      plantManifest(home, target);
    }

    const results = discoverManifests([home]);
    expect(results).toHaveLength(5);

    const targets = results.map((r) => r.target);
    expect(targets).toEqual(['antigravity', 'codex', 'cursor', 'kiro', 'opencode']);
  });
});

describe('readManifestIfExists', () => {
  test('returns null for missing file', () => {
    const home = makeTmpHome();
    const missing = join(home, 'no-such-file.json');
    const result = readManifestIfExists(missing);
    expect(result).toBeNull();
  });

  test('returns parsed manifest when present', () => {
    const home = makeTmpHome();
    plantManifest(home, 'cursor');
    const path = manifestPath('cursor', home, 'global');

    const result = readManifestIfExists(path);
    expect(result).not.toBeNull();
    expect(result.kind).toBe('xm-install-manifest');
    expect(result.target).toBe('cursor');
    expect(result.scope).toBe('global');
  });
});

describe('shouldSkipTarget', () => {
  /**
   * Build a manifest AND write the actual files to disk so existsSync passes.
   */
  function buildManifestWithFiles(installRoot, entries) {
    // Write actual files to disk
    for (const e of entries) {
      const filePath = join(installRoot, e.relativePath);
      writeFileSync(filePath, e.content);
    }
    return buildManifest({
      target: 'cursor',
      scope: 'local',
      installRoot,
      entries: entries.map((e) => ({ ...e, mode: 0o644 })),
      now: 1_000_000,
    });
  }

  test('returns true when files match manifest exactly', () => {
    const root = mkdtempSync(join(tmpdir(), 'xm-skip-'));
    const entries = [
      { relativePath: 'file-a.txt', content: 'hello world' },
      { relativePath: 'file-b.txt', content: 'goodbye world' },
    ];
    const manifest = buildManifestWithFiles(root, entries);
    const plannedFiles = entries.map((e) => ({ relativePath: e.relativePath, content: e.content }));

    expect(shouldSkipTarget(manifest, plannedFiles)).toBe(true);
  });

  test('returns false when a manifest file is deleted from disk', () => {
    const root = mkdtempSync(join(tmpdir(), 'xm-skip-'));
    const entries = [
      { relativePath: 'keep.txt', content: 'present' },
      { relativePath: 'gone.txt', content: 'will be deleted' },
    ];
    const manifest = buildManifestWithFiles(root, entries);

    // Delete one file
    unlinkSync(join(root, 'gone.txt'));

    const plannedFiles = entries.map((e) => ({ relativePath: e.relativePath, content: e.content }));
    expect(shouldSkipTarget(manifest, plannedFiles)).toBe(false);
  });

  test('returns false when content sha256 differs', () => {
    const root = mkdtempSync(join(tmpdir(), 'xm-skip-'));
    const entries = [
      { relativePath: 'data.txt', content: 'original content' },
    ];
    const manifest = buildManifestWithFiles(root, entries);

    // plannedFiles has different content for same relativePath
    const plannedFiles = [{ relativePath: 'data.txt', content: 'changed content' }];
    expect(shouldSkipTarget(manifest, plannedFiles)).toBe(false);
  });

  test('returns false when planned set has extra file', () => {
    const root = mkdtempSync(join(tmpdir(), 'xm-skip-'));
    const entries = [
      { relativePath: 'base.txt', content: 'base' },
    ];
    const manifest = buildManifestWithFiles(root, entries);

    // plannedFiles adds an extra entry
    const plannedFiles = [
      { relativePath: 'base.txt', content: 'base' },
      { relativePath: 'extra.txt', content: 'extra' },
    ];
    expect(shouldSkipTarget(manifest, plannedFiles)).toBe(false);
  });

  test('returns false when planned set is missing a file', () => {
    const root = mkdtempSync(join(tmpdir(), 'xm-skip-'));
    const entries = [
      { relativePath: 'one.txt', content: 'one' },
      { relativePath: 'two.txt', content: 'two' },
    ];
    const manifest = buildManifestWithFiles(root, entries);

    // plannedFiles omits 'two.txt'
    const plannedFiles = [{ relativePath: 'one.txt', content: 'one' }];
    expect(shouldSkipTarget(manifest, plannedFiles)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --list-installed CLI tests
// ---------------------------------------------------------------------------

const REPO = join(__dirname, '..');
const CLI = join(REPO, 'xm', 'lib', 'install', 'install-cli.mjs');

function runListInstalled(home) {
  const result = spawnSync('node', [CLI, '--list-installed'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, HOME: home },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('--list-installed', () => {
  test('returns empty array when no manifests', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-li-empty-'));
    const result = runListInstalled(home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([]);
  });

  test('lists all installed targets', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-li-targets-'));
    // Plant cursor and codex manifests
    for (const target of ['cursor', 'codex']) {
      const manifest = buildManifest({
        target,
        scope: 'global',
        installRoot: home,
        entries: [{ relativePath: 'dummy.txt', content: 'hello', mode: 0o600 }],
        now: 1_000_000,
      });
      writeManifest(manifest);
    }
    const result = runListInstalled(home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(2);
    const targets = parsed.map((e) => e.target).sort();
    expect(targets).toContain('cursor');
    expect(targets).toContain('codex');
    for (const entry of parsed) {
      expect(typeof entry.prdVersion).toBe('string');
      expect(typeof entry.fileCount).toBe('number');
      expect(entry.fileCount).toBeGreaterThanOrEqual(1);
    }
  });

  test('includes broken manifest with error field', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-li-broken-'));
    // Plant a valid cursor manifest first so discoverManifests finds it
    const mp = manifestPath('cursor', home, 'global');
    // Write a broken JSON with wrong schemaVersion directly
    mkdirSync(join(home, '.cursor', 'xm'), { recursive: true });
    writeFileSync(mp, JSON.stringify({
      kind: 'xm-install-manifest',
      schemaVersion: 999,
      target: 'cursor',
      scope: 'global',
      installRoot: home,
      files: [],
    }, null, 2) + '\n', { mode: 0o600 });

    const result = runListInstalled(home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].target).toBe('cursor');
    expect(typeof parsed[0].error).toBe('string');
    expect(parsed[0].error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// --propagate CLI tests
// ---------------------------------------------------------------------------

const SKILLS = join(REPO, 'xm', 'skills');
const LIB = join(REPO, 'xm', 'lib');

function runPropagate(home, extraArgs = []) {
  const result = spawnSync('node', [CLI, '--propagate', '--skills-dir', SKILLS, '--lib-dir', LIB, ...extraArgs], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home },
    cwd: REPO,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

function runInstall(home, targets) {
  const result = spawnSync('node', [CLI, '--target', targets.join(','), '--global', '--yes', '--force',
    '--skills-dir', SKILLS, '--lib-dir', LIB], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, HOME: home },
    cwd: REPO,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

describe('--propagate', () => {
  test('propagates 0 manifests as no-op', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-prop-empty-'));
    const result = runPropagate(home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(0);
    expect(parsed.summary.total).toBe(0);
    expect(parsed.summary.success).toBe(0);
    expect(parsed.summary.skipped).toBe(0);
    expect(parsed.summary.failed).toBe(0);
  });

  test('propagates updates to installed targets when file is removed', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-prop-update-'));
    // First do a real install for cursor
    const installResult = runInstall(home, ['cursor']);
    expect(installResult.status).toBe(0);

    // Remove a file that was installed to force re-install
    const cursorSkillsDir = join(home, '.cursor', 'skills');
    expect(existsSync(cursorSkillsDir)).toBe(true);
    const skillDirs = readdirSync(cursorSkillsDir);
    expect(skillDirs.length).toBeGreaterThan(0);
    // Remove first SKILL.md from the first skill dir
    const firstSkillDir = join(cursorSkillsDir, skillDirs[0]);
    const files = readdirSync(firstSkillDir);
    expect(files.length).toBeGreaterThan(0);
    unlinkSync(join(firstSkillDir, files[0]));

    // Propagate should detect the change and re-install
    const result = runPropagate(home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].target).toBe('cursor');
    expect(parsed.results[0].status).toBe('updated');
    expect(parsed.summary.success).toBeGreaterThanOrEqual(1);
  });

  test('restores a deleted nested Codex reference sidecar through propagation', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-prop-codex-reference-'));
    expect(runInstall(home, ['codex']).status).toBe(0);

    const relativeReference = join('references', 'phases', 'plan.md');
    const pluginReference = join(home, 'plugins', 'xm', 'skills', 'build', relativeReference);
    const standaloneReference = join(home, '.agents', 'skills', 'xm-build', relativeReference);
    expect(existsSync(pluginReference)).toBe(true);
    expect(existsSync(standaloneReference)).toBe(true);

    unlinkSync(pluginReference);
    const result = runPropagate(home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].target).toBe('codex');
    expect(parsed.results[0].status).toBe('updated');
    expect(existsSync(pluginReference)).toBe(true);
    expect(existsSync(standaloneReference)).toBe(true);
  });

  test('skips when content matches and files exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-prop-skip-'));
    // Do a real install for cursor
    const installResult = runInstall(home, ['cursor']);
    expect(installResult.status).toBe(0);

    // Propagate immediately — nothing changed, should skip
    const result = runPropagate(home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].target).toBe('cursor');
    expect(parsed.results[0].status).toBe('skipped');
    expect(parsed.summary.skipped).toBe(1);
    expect(parsed.summary.success).toBe(0);
  });

  test('updates an INTACT install when the bundle content changed (stale-overlay regression)', () => {
    // The historical bug: propagate used verifyManifest.ok as the skip signal,
    // so an install whose files matched its OWN (old) manifest was skipped
    // forever — new bundle releases never reached codex/kiro/cursor overlays.
    const home = mkdtempSync(join(tmpdir(), 'xm-prop-stale-'));
    const skillsCopy = mkdtempSync(join(tmpdir(), 'xm-prop-skills-'));
    cpSync(SKILLS, skillsCopy, { recursive: true });

    // Install from the copied skills dir, then propagate against the SAME dir
    // → converged, skipped.
    const installResult = spawnSync('node', [CLI, '--target', 'cursor', '--global', '--yes', '--force',
      '--skills-dir', skillsCopy, '--lib-dir', LIB], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home }, cwd: REPO,
    });
    expect(installResult.status).toBe(0);

    // Simulate a new release: one skill's content changes upstream. Disk still
    // matches the old manifest (install is intact) — only a render-and-compare
    // can see the difference.
    const firstSkillMd = readdirSync(skillsCopy).map((d) => join(skillsCopy, d, 'SKILL.md')).find(existsSync);
    expect(firstSkillMd).toBeTruthy();
    appendFileSync(firstSkillMd, '\nStale-overlay regression marker.\n');

    const result = spawnSync('node', [CLI, '--propagate', '--skills-dir', skillsCopy, '--lib-dir', LIB], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home }, cwd: REPO,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].status).toBe('updated');   // NOT 'skipped'
    expect(parsed.summary.success).toBe(1);

    // The new content actually landed on disk.
    const skillName = dirname(firstSkillMd).split('/').pop();
    const installedDirs = readdirSync(join(home, '.cursor', 'skills'));
    const installedSkill = installedDirs.find((d) => d.includes(skillName));
    expect(installedSkill).toBeTruthy();
    const installed = readFileSync(join(home, '.cursor', 'skills', installedSkill, 'SKILL.md'), 'utf8');
    expect(installed).toContain('Stale-overlay regression marker.');

    // Convergence: a second propagate with the same inputs is a no-op.
    const again = spawnSync('node', [CLI, '--propagate', '--skills-dir', skillsCopy, '--lib-dir', LIB], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, HOME: home }, cwd: REPO,
    });
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout).results[0].status).toBe('skipped');
  });

  test('migrates incompatible schema', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-prop-migrate-'));
    // First do a real install to establish files on disk
    const installResult = runInstall(home, ['cursor']);
    expect(installResult.status).toBe(0);

    // Overwrite the manifest with an incompatible schemaVersion
    const mp = manifestPath('cursor', home, 'global');
    writeFileSync(mp, JSON.stringify({
      kind: 'xm-install-manifest',
      schemaVersion: 999,
      target: 'cursor',
      scope: 'global',
      installRoot: home,
      files: [],
    }, null, 2) + '\n', { mode: 0o600 });

    // Propagate should detect schema mismatch and migrate
    const result = runPropagate(home);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0].target).toBe('cursor');
    expect(parsed.results[0].status).toBe('migrated');
    expect(parsed.summary.migrated).toBe(1);
    expect(result.stderr).toContain('migrating');
    expect(result.stderr).toContain('cursor');

    // Verify manifest is now valid with schemaVersion 1
    const newManifest = readManifestIfExists(mp);
    expect(newManifest).not.toBeNull();
    expect(newManifest.schemaVersion).toBe(1);
  });
});
