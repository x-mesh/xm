/**
 * release detect — every marketplace plugin is tracked
 *
 * release.mjs maps a changed file to a plugin through PLUGIN_DIRS and finds the
 * plugin's marketplace entry through PLUGIN_NAME_MAP. x-remote was listed in
 * marketplace.json but in neither table, so its changes were never detected and
 * `remote` stayed at 0.1.0 across two releases that changed it.
 *
 * The fixture is built from the real marketplace.json, so a plugin that is added
 * there without the release mapping fails here.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dir, '..');
const CLI = join(ROOT, 'x-build', 'lib', 'x-build-cli.mjs');
const PLUGINS = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'))
  .plugins.map((p) => ({ name: p.name, dir: p.source.replace(/^\.\//, ''), version: p.version }));

let repo;

function git(...args) {
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(rel, contents) {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), contents, 'utf8');
}

// xm/lib mirrors the plugins and is filtered out, so xm's own change goes under xm/scripts.
function ownFile(dir) {
  return dir === 'xm' ? 'xm/scripts/seed.sh' : `${dir}/lib/seed.mjs`;
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'xkit-coverage-'));
  git('init', '-q', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');

  write('.claude-plugin/marketplace.json', JSON.stringify({
    plugins: PLUGINS.map(({ name, dir, version }) => ({ name, source: `./${dir}`, version })),
  }, null, 2));
  for (const { name, dir, version } of PLUGINS) {
    write(`${dir}/.claude-plugin/plugin.json`, JSON.stringify({ name, version }));
    write(ownFile(dir), 'seed\n');
  }
  git('add', '-A');
  git('commit', '-qm', 'release: initial');
});

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test('a change in any marketplace plugin is detected with its marketplace version', () => {
  expect(PLUGINS.length).toBeGreaterThanOrEqual(18);
  for (const { dir } of PLUGINS) write(ownFile(dir), 'changed\n');
  git('add', '-A');
  git('commit', '-qm', 'fix: touch every plugin');

  const out = execFileSync('node', [CLI, 'release', 'detect', '--json'], { cwd: repo, encoding: 'utf8' });
  const changed = JSON.parse(out).changed_plugins;
  for (const { name, dir, version } of PLUGINS) {
    const hit = changed.find((p) => p.name === dir);
    expect(hit, `${dir} is in marketplace.json but PLUGIN_DIRS in release.mjs does not list it`).toBeTruthy();
    expect(hit.current, `PLUGIN_NAME_MAP in release.mjs does not map ${dir} to "${name}"`).toBe(version);
  }
});
