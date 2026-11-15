/**
 * release commit — new files under test/ and scripts/ ship with the release
 *
 * cmdReleaseCommit staged tracked changes (`git add -u`) plus the plugin and xm
 * directories. A new test or release script is untracked and sits in neither, so
 * the release commit left it out without a word. The list that named `scripts/`
 * and `test/` was declared and never used.
 *
 * The staging applies to the xm-marketplace layout only. Other projects reach
 * this command through xm:ship, which stages its planned files itself.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(import.meta.dir, '..', 'x-build', 'lib', 'x-build-cli.mjs');

let repo;

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(rel, contents) {
  mkdirSync(join(repo, rel, '..'), { recursive: true });
  writeFileSync(join(repo, rel), contents, 'utf8');
}

function init(files) {
  repo = mkdtempSync(join(tmpdir(), 'xkit-commit-'));
  git('init', '-q', '.');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (const [rel, contents] of Object.entries(files)) write(rel, contents);
  git('add', '-A');
  git('commit', '-qm', 'release: initial');
}

function releaseCommit() {
  const r = spawnSync('node', [CLI, 'release', 'commit', '--msg', 'release: next'], { cwd: repo, encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean);
}

function untracked() {
  return git('status', '--porcelain', '--untracked-files=all').split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3));
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test('a marketplace release commit carries new files under test/ and scripts/', () => {
  init({
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'xm', source: './xm', version: '1.0.0' }] }),
    'package.json': JSON.stringify({ version: '1.0.0' }),
    '.gitignore': '*.log\n',
    'test/old.test.mjs': '// old\n',
  });
  write('package.json', JSON.stringify({ version: '1.0.1' }));
  write('test/new.test.mjs', '// new test\n');
  write('test/fixtures/new-fixture.json', '{}\n');
  write('scripts/new.sh', 'echo new\n');
  write('test/run.log', 'ignored\n');
  write('notes.txt', 'not part of the release\n');

  const files = releaseCommit();
  expect(files).toContain('package.json');
  expect(files).toContain('test/new.test.mjs');
  expect(files).toContain('test/fixtures/new-fixture.json');
  expect(files).toContain('scripts/new.sh');
  expect(files).not.toContain('test/run.log');
  expect(files).not.toContain('notes.txt');
  expect(untracked()).toEqual(['notes.txt']);
});

test('a project without the marketplace layout keeps its untracked files out', () => {
  init({ 'package.json': JSON.stringify({ version: '1.0.0' }), 'test/old.test.mjs': '// old\n' });
  write('package.json', JSON.stringify({ version: '1.0.1' }));
  write('test/wip.test.mjs', '// work in progress\n');
  write('scripts/wip.sh', 'echo wip\n');

  const files = releaseCommit();
  expect(files).toEqual(['package.json']);
  expect(untracked().sort()).toEqual(['scripts/wip.sh', 'test/wip.test.mjs']);
});
