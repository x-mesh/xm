import { afterAll, describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, resolve, isAbsolute } from 'node:path';
import { mkdtempSync, readdirSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { TARGET_TOOLS, TARGET_DIR } from '../xm/lib/install/types.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const CLI = join(REPO, 'xm', 'lib', 'install', 'install-cli.mjs');
const SKILLS = join(REPO, 'xm', 'skills');
const LIB = join(REPO, 'xm', 'lib');
const TEMP_ROOTS = [];

function makeTmp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  TEMP_ROOTS.push(path);
  // Resolved: the installer reports the real install root, and on macOS
  // tmpdir() hands back the /var -> /private/var symlink, so an unresolved
  // prefix never matches the paths the CLI prints.
  return realpathSync(path);
}

afterAll(() => {
  for (const path of TEMP_ROOTS) rmSync(path, { recursive: true, force: true });
});

function run(args, opts = {}) {
  const result = spawnSync('node', [CLI, ...args], {
    cwd: opts.cwd ?? REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status ?? -1 };
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/**
 * Relative ESM specifiers a module resolves at load time.
 *
 * Scanned line-wise with block-comment tracking: a JSDoc usage example such as
 * `*   import { x } from './y.mjs'` is documentation, not a dependency, and
 * treating it as one reports files that were never imported.
 */
function relativeSpecifiers(source) {
  const specifiers = [];
  let inBlockComment = false;
  let pending = '';
  for (const raw of source.split('\n')) {
    let line = raw;
    if (inBlockComment) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      line = line.slice(close + 2);
      inBlockComment = false;
    }
    const open = line.indexOf('/*');
    if (open !== -1) {
      const close = line.indexOf('*/', open + 2);
      if (close === -1) { inBlockComment = true; line = line.slice(0, open); }
      else line = line.slice(0, open) + line.slice(close + 2);
    }
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (!pending && !/^(import|export)\b/.test(trimmed)) continue;
    pending = pending ? `${pending} ${trimmed}` : trimmed;
    const match = pending.match(/(?:^import|\bfrom)\s*['"]([^'"]+)['"]/);
    if (match) {
      if (match[1].startsWith('.')) specifiers.push(match[1]);
      pending = '';
    } else if (pending.length > 4000) {
      pending = '';
    }
  }
  return specifiers;
}

describe('install bundle is self-contained', () => {
  for (const target of TARGET_TOOLS) {
    test(`${target}: every relative import resolves inside the bundle`, () => {
      const tmp = makeTmp(`xm-bundle-${target}-`);
      const installed = run(['--target', target, '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
      expect(installed.status).toBe(0);

      const root = bundleRootFor(tmp, target);
      const unresolved = [];
      for (const file of walkFiles(root)) {
        if (!/\.(mjs|js|cjs)$/.test(file)) continue;
        for (const specifier of relativeSpecifiers(readFileSync(file, 'utf8'))) {
          const dependency = resolve(dirname(file), specifier);
          const inside = relative(root, dependency);
          if (inside.startsWith('..') || isAbsolute(inside) || !existsSync(dependency)) {
            unresolved.push(`${relative(root, file)} -> ${specifier}`);
          }
        }
      }
      expect(unresolved).toEqual([]);
    });
  }

  test('codex: the review lifecycle loads from the installed bundle', () => {
    const tmp = makeTmp('xm-bundle-import-');
    expect(run(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp }).status).toBe(0);

    const lifecycle = join(bundleRootFor(tmp, 'codex'), 'lib', 'review-lifecycle.mjs');
    expect(existsSync(lifecycle)).toBe(true);
    const loaded = spawnSync('node', ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(lifecycle).href)})`], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(loaded.stderr).toBe('');
    expect(loaded.status).toBe(0);
  });

  test('codex: lens prompts the lifecycle reads by path ship with the bundle', () => {
    const tmp = makeTmp('xm-bundle-lenses-');
    expect(run(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp }).status).toBe(0);

    const lenses = join(bundleRootFor(tmp, 'codex'), 'skills', 'review', 'lenses');
    const shipped = readdirSync(lenses).filter((name) => name.endsWith('.md')).sort();
    const source = readdirSync(join(SKILLS, 'review', 'lenses')).filter((name) => name.endsWith('.md')).sort();
    expect(shipped).toEqual(source);
  });

  test('codex: the dry-run plan lists exactly the bundle files the install writes', () => {
    const tmp = makeTmp('xm-bundle-parity-');
    const planned = run(['--dry-run', '--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp });
    expect(planned.status).toBe(0);

    // Scoped to the two mirrored trees: the manifest, hooks and agent payloads
    // under the same root are planned as their own kinds, not as bundle files.
    const mirrored = ['lib', 'skills'].map((tree) => join(bundleRootFor(tmp, 'codex'), tree));
    const plannedPaths = planned.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop())
      .filter((path) => mirrored.some((tree) => path?.startsWith(`${tree}/`)))
      .sort();

    expect(run(['--target', 'codex', '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: tmp }).status).toBe(0);
    const writtenPaths = mirrored.flatMap((tree) => walkFiles(tree)).sort();

    expect(writtenPaths.length).toBeGreaterThan(0);
    expect(plannedPaths).toEqual(writtenPaths);
  });
});

function bundleRootFor(root, target) {
  return join(root, TARGET_DIR[target], 'xm');
}
