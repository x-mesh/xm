/**
 * release detect — xm-native sources are genuine xm changes
 *
 * xm/ is mostly a MIRROR of the x-* plugins, so detect filters it out to avoid
 * churn bumps. But some skills and commands live ONLY under xm/ (handoff, handon,
 * ship, kit, later, inbox, toss, and xm's own dispatcher command). Treating those
 * as mirror churn made a SKILL-only fix report "no changes to release" and ship
 * nothing — it had to be worked around by hand with `--plugins xm`.
 *
 * Membership is derived from the filesystem (does x-<name>/ exist?), never a
 * hardcoded list, so a newly added xm-native skill is picked up automatically.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dir, '..', 'x-build', 'lib', 'x-build-cli.mjs');

let repo;

function git(...args) {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(rel, contents) {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), contents, 'utf8');
}

function detect() {
  const out = execFileSync('node', [CLI, 'release', 'detect', '--json'], { cwd: repo, encoding: 'utf8' });
  return JSON.parse(out);
}

function changedNames() {
  return detect().changed_plugins.map(p => p.name).sort();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'xkit-detect-'));
  git('init', '-q', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  // Minimal xm-marketplace layout: one mirrored plugin (x-build) and the xm bundle.
  write('.claude-plugin/marketplace.json', JSON.stringify({
    plugins: [{ name: 'build', source: './x-build' }, { name: 'xm', source: './xm' }],
  }, null, 2));
  write('x-build/.claude-plugin/plugin.json', JSON.stringify({ name: 'build', version: '1.0.0' }));
  write('xm/.claude-plugin/plugin.json', JSON.stringify({ name: 'xm', version: '1.0.0' }));
  write('x-build/skills/build/SKILL.md', '# build\n');
  write('xm/skills/build/SKILL.md', '# build (mirror)\n');   // mirror: x-build/ exists
  write('xm/skills/ship/SKILL.md', '# ship\n');              // xm-native: no x-ship/
  write('xm/commands/xm.md', '# xm dispatcher\n');           // xm-native command
  write('xm/scripts/install.sh', 'echo hi\n');

  git('add', '-A');
  git('commit', '-qm', 'release: initial');
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test('an xm-native SKILL.md change is a genuine xm release', () => {
  write('xm/skills/ship/SKILL.md', '# ship\n\nnew guidance\n');
  git('add', '-A');
  git('commit', '-qm', 'fix: ship skill');

  expect(changedNames()).toContain('xm');
});

test('an xm-native command change is a genuine xm release', () => {
  write('xm/commands/xm.md', '# xm dispatcher\n\n| `remote` | remote | ... |\n');
  git('add', '-A');
  git('commit', '-qm', 'fix: register remote in dispatcher');

  expect(changedNames()).toContain('xm');
});

test("xm's own dispatcher scripts still count", () => {
  write('xm/scripts/install.sh', 'echo updated\n');
  git('add', '-A');
  git('commit', '-qm', 'fix: installer');

  expect(changedNames()).toContain('xm');
});

// The whole reason xm is filtered by default: mirrored files would bump xm on
// every single plugin change, which is pure noise.
test('a mirrored SKILL.md alone does NOT trigger an xm release', () => {
  write('xm/skills/build/SKILL.md', '# build (mirror)\n\nsynced\n');
  git('add', '-A');
  git('commit', '-qm', 'chore: sync bundle');

  expect(changedNames()).not.toContain('xm');
});

test('a mirrored change alongside its source releases only the source plugin', () => {
  write('x-build/skills/build/SKILL.md', '# build\n\nreal edit\n');
  write('xm/skills/build/SKILL.md', '# build (mirror)\n\nreal edit\n');
  git('add', '-A');
  git('commit', '-qm', 'feat: build skill');

  // detect reports plugin DIRECTORY names (x-build), not marketplace names (build).
  const names = changedNames();
  expect(names).toContain('x-build');
  expect(names).not.toContain('xm');
});

// Filesystem-derived membership (Lesson L8): a brand-new xm-native skill must be
// picked up with no code change here.
test('a newly added xm-native skill is detected without a hardcoded list', () => {
  write('xm/skills/brandnew/SKILL.md', '# brandnew\n');
  git('add', '-A');
  git('commit', '-qm', 'feat: brandnew skill');

  expect(changedNames()).toContain('xm');
});
