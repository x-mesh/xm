import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// `xm install` renders SKILL *sources* into other tools' formats, so it needs a
// root that actually carries skills/. resolve_lib, however, prefers the Codex
// global bundle (~/.codex/xm) over the marketplace cache, and that bundle has
// no skills/ — it mirrors lib/, hooks/ and agents/ only, because its SKILLs are
// rendered output. The dispatcher used to paper over the miss with
// `$PLUGIN_ROOT/xm/skills`, which on that bundle assembles the nonexistent
// ~/.codex/xm/xm/skills and fails as `scan failed: skillsDir not found`.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCHER = join(REPO, 'xm', 'scripts', 'xm');

// XM_LIB/X_KIT_LIB outrank every other candidate, so a developer shell
// exporting either one would point these fixtures at the real checkout.
const { XM_LIB: _xmLib, X_KIT_LIB: _xKitLib, XM_MARKET: _xmMarket, ...BASE_ENV } = process.env;

let home;

/** Stub CLI that reports the flags the dispatcher chose, instead of installing. */
function stubCli(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
}

/** A marketplace cache root: lib/ + (optionally) the skills/ sources beside it. */
function cacheRoot(version, { skills = true } = {}) {
  const root = join(home, '.claude', 'plugins', 'cache', 'xm', 'xm', version);
  stubCli(join(root, 'lib', 'install', 'install-cli.mjs'));
  if (skills) mkdirSync(join(root, 'skills', 'build'), { recursive: true });
  return root;
}

/** The Codex global bundle: one flat lib/, deliberately no skills/. */
function codexBundle() {
  const root = join(home, '.codex', 'xm');
  stubCli(join(root, 'lib', 'install', 'install-cli.mjs'));
  mkdirSync(join(root, 'hooks'), { recursive: true });
  return root;
}

function xmInstall(...args) {
  const r = spawnSync('bash', [DISPATCHER, 'install', ...args], {
    cwd: home,               // never the repo: a source checkout wins resolve_lib
    env: { ...BASE_ENV, HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

/** Read the --skills-dir/--lib-dir pair out of the stub's argv echo. */
function flags(stdout) {
  const argv = JSON.parse(stdout.trim().split('\n').at(-1));
  const at = (flag) => argv[argv.indexOf(flag) + 1];
  return { skillsDir: at('--skills-dir'), libDir: at('--lib-dir') };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xm-install-dispatch-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('xm install — skills-dir resolution', () => {
  test('reaches past the skills-less Codex bundle to the marketplace cache', () => {
    codexBundle();
    const root = cacheRoot('2.0.0');

    const r = xmInstall('--target', 'codex', '--global');

    expect(r.exitCode).toBe(0);
    // The doubled path is the actual regression: ~/.codex/xm + "/xm/skills".
    expect(r.stdout).not.toContain(join('xm', 'xm', 'skills'));
    expect(flags(r.stdout)).toEqual({
      skillsDir: join(root, 'skills'),
      libDir: join(root, 'lib'),
    });
  });

  test('takes lib/ from the same cache root as skills/, never a mixed pair', () => {
    const bundle = codexBundle();
    const root = cacheRoot('2.0.0');

    const { libDir } = flags(xmInstall('--target', 'codex', '--global').stdout);

    expect(libDir).toBe(join(root, 'lib'));
    expect(libDir).not.toBe(join(bundle, 'lib'));
  });

  test('picks the newest cache root by version, not by string order', () => {
    codexBundle();
    cacheRoot('9.0.0');
    const newest = cacheRoot('10.0.0');

    expect(flags(xmInstall('--target', 'codex', '--global').stdout).skillsDir)
      .toBe(join(newest, 'skills'));
  });

  test('skips a cache root that carries no skills/ sources', () => {
    codexBundle();
    const withSkills = cacheRoot('1.0.0');
    cacheRoot('2.0.0', { skills: false });

    expect(flags(xmInstall('--target', 'codex', '--global').stdout).skillsDir)
      .toBe(join(withSkills, 'skills'));
  });

  test('uses the sibling skills/ when the cache itself answers', () => {
    const root = cacheRoot('2.0.0');   // no Codex bundle: the cache wins resolve_lib

    expect(flags(xmInstall('--target', 'codex', '--global').stdout)).toEqual({
      skillsDir: join(root, 'skills'),
      libDir: join(root, 'lib'),
    });
  });

  test('fails with an actionable message when no SKILL source exists anywhere', () => {
    codexBundle();

    const r = xmInstall('--target', 'codex', '--global');

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('no SKILL sources found');
    expect(r.stderr).toContain('xm update');
    // Must not hand install-cli a fabricated path and let it fail downstream.
    expect(r.stdout).not.toContain('--skills-dir');
  });

  test('--list-installed still runs on a host with no SKILL sources', () => {
    codexBundle();

    const r = xmInstall('--list-installed');

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toContain('--list-installed');
  });
});
