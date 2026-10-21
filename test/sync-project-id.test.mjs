import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSyncProjectId } from '../x-sync/lib/x-sync/sync-config.mjs';

let fixture;
let savedEnv;

function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '.'], { cwd: dir });
  mkdirSync(join(dir, '.xm'), { recursive: true });
  return dir;
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'xm-sync-project-id-'));
  savedEnv = process.env.MEM_MESH_PROJECT_ID;
  delete process.env.MEM_MESH_PROJECT_ID;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MEM_MESH_PROJECT_ID;
  else process.env.MEM_MESH_PROJECT_ID = savedEnv;
  rmSync(fixture, { recursive: true, force: true });
});

test('a root .xm with no override keeps the folder name', () => {
  const repo = gitRepo(join(fixture, 'alpha'));
  expect(resolveSyncProjectId(join(repo, '.xm'))).toBe('alpha');
});

test('a root .xm follows .mem-mesh/project-id so differently named checkouts match', () => {
  const alpha = gitRepo(join(fixture, 'alpha'));
  const beta = gitRepo(join(fixture, 'beta'));
  for (const repo of [alpha, beta]) {
    mkdirSync(join(repo, '.mem-mesh'));
    writeFileSync(join(repo, '.mem-mesh', 'project-id'), 'shared\n');
  }
  expect(resolveSyncProjectId(join(alpha, '.xm'))).toBe('shared');
  expect(resolveSyncProjectId(join(beta, '.xm'))).toBe('shared');
});

test('a root .xm follows git config mem-mesh.project-id', () => {
  const repo = gitRepo(join(fixture, 'alpha'));
  execFileSync('git', ['config', '--local', 'mem-mesh.project-id', 'configured'], { cwd: repo });
  expect(resolveSyncProjectId(join(repo, '.xm'))).toBe('configured');
});

test('a nested .xm keeps its folder name so sibling trees never merge', () => {
  const repo = gitRepo(join(fixture, 'mono'));
  mkdirSync(join(repo, '.mem-mesh'));
  writeFileSync(join(repo, '.mem-mesh', 'project-id'), 'shared\n');
  for (const pkg of ['a', 'b']) mkdirSync(join(repo, 'packages', pkg, '.xm'), { recursive: true });
  expect(resolveSyncProjectId(join(repo, 'packages', 'a', '.xm'))).toBe('a');
  expect(resolveSyncProjectId(join(repo, 'packages', 'b', '.xm'))).toBe('b');
});

test('outside git the folder name is used', () => {
  const dir = join(fixture, 'plain');
  mkdirSync(join(dir, '.xm'), { recursive: true });
  expect(resolveSyncProjectId(join(dir, '.xm'))).toBe('plain');
});

test('MEM_MESH_PROJECT_ID is ignored because push-all shares one environment', () => {
  const repo = gitRepo(join(fixture, 'alpha'));
  process.env.MEM_MESH_PROJECT_ID = 'leaked';
  expect(resolveSyncProjectId(join(repo, '.xm'))).toBe('alpha');
});
