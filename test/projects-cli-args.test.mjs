/**
 * x-projects-cli argument parsing.
 *
 * `project add` read args[0] as the path, so `xm project add --id myproj` took
 * the FLAG as the path and reported "Skipped: --id — no .xm/" without
 * registering anything. registerCmd had already been patched for the same class
 * of bug, but with `args.find(a => !a.startsWith('-'))`, which returns the VALUE
 * of a value-taking flag — correct only because its one caller passes a
 * valueless `--quiet`. Both now share a parser that knows which flags consume
 * the next token.
 *
 * The registry lives at homedir()/.xm/projects.json, so every case runs with
 * HOME pointed at a throwaway directory.
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'xm', 'lib', 'x-projects-cli.mjs');

/** Run the CLI against a throwaway HOME and repo; return stdout+stderr and the registry. */
function run(args, { withXmDir = true } = {}) {
  // realpath: on macOS /var is a symlink to /private/var, and the CLI records the
  // resolved path while mkdtemp returns the symlinked one.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'xm-projhome-')));
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'xm-projrepo-')));
  if (withXmDir) mkdirSync(join(repo, '.xm'), { recursive: true });
  try {
    const r = spawnSync('node', [CLI, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    const registryPath = join(home, '.xm', 'projects.json');
    const registry = existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, 'utf8'))
      : null;
    return { out: `${r.stdout}${r.stderr}`, registry, repo };
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('xm project add — positional path vs flags', () => {
  test('a value-taking flag is not mistaken for the path', () => {
    // Pre-fix this printed "Skipped: --id — no .xm/" and registered nothing.
    const { out, registry, repo } = run(['add', '--id', 'myproj']);
    expect(out).not.toContain('Skipped: --id');
    expect(registry).not.toBeNull();
    const entry = (registry.projects || []).find((p) => p.id === 'myproj');
    expect(entry).toBeDefined();
    expect(entry.path).toBe(repo);
  });

  test("a flag's value is not mistaken for the path either", () => {
    // `args.find(a => !a.startsWith('-'))` would return "myproj" here.
    const { registry, repo } = run(['add', '--id', 'myproj', '--name', 'My Project']);
    const entry = (registry.projects || []).find((p) => p.id === 'myproj');
    expect(entry).toBeDefined();
    expect(entry.path).toBe(repo);
    expect(entry.path).not.toBe('myproj');
    expect(entry.path).not.toBe('My Project');
  });

  test('an explicit positional path still wins, before or after flags', () => {
    for (const args of [
      ['add', '.', '--id', 'myproj'],
      ['add', '--id', 'myproj', '.'],
    ]) {
      const { registry, repo } = run(args);
      const entry = (registry.projects || []).find((p) => p.id === 'myproj');
      expect(entry).toBeDefined();
      expect(entry.path).toBe(repo);
    }
  });

  test('no positional arg falls back to the working directory', () => {
    const { registry, repo } = run(['add']);
    expect((registry.projects || []).some((p) => p.path === repo)).toBe(true);
  });
});
