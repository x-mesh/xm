import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// resolve_lib picks between the Codex global bundle and the Claude marketplace
// cache. Preferring the bundle unconditionally let an untouched bundle shadow a
// cache the Claude plugin had since updated, for every cwd outside the source
// repo — `xm review` then ran code several releases old.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const DISPATCHER = join(REPO, 'xm', 'scripts', 'xm');

// XM_LIB/X_KIT_LIB outrank every other candidate, so a developer shell
// exporting either one would point these fixtures at the real checkout.
const { XM_LIB: _xmLib, X_KIT_LIB: _xKitLib, XM_MARKET: _xmMarket, ...BASE_ENV } = process.env;

let home;

function writeManifest(path, version) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ name: 'xm', version }, null, 2)}\n`);
}

/** The Codex global bundle: a flat lib/ plus the manifest that dates it. */
function codexBundle({ version } = {}) {
  mkdirSync(join(home, '.codex', 'xm', 'lib'), { recursive: true });
  if (version) writeManifest(join(home, 'plugins', 'xm', '.codex-plugin', 'plugin.json'), version);
}

/** A marketplace cache root, addressed by version directory. */
function cacheRoot(version) {
  writeManifest(join(home, '.claude', 'plugins', 'cache', 'xm', 'xm', version, '.claude-plugin', 'plugin.json'), version);
}

function xmVersion() {
  const r = spawnSync('bash', [DISPATCHER, 'version'], {
    cwd: home,               // never the repo: a source checkout wins resolve_lib
    env: { ...BASE_ENV, HOME: home },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return (r.stdout ?? '').trim();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xm-resolve-lib-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('resolve_lib — Codex bundle vs marketplace cache', () => {
  test('takes the cache when the cache is newer', () => {
    codexBundle({ version: '2.20.0' });
    cacheRoot('2.27.0');

    expect(xmVersion()).toBe('xm 2.27.0 (marketplace cache)');
  });

  test('takes the bundle when the bundle is newer', () => {
    codexBundle({ version: '2.27.0' });
    cacheRoot('2.20.0');

    expect(xmVersion()).toBe('xm 2.27.0 (Codex global bundle)');
  });

  test('keeps the bundle on a tie', () => {
    codexBundle({ version: '2.27.0' });
    cacheRoot('2.27.0');

    expect(xmVersion()).toBe('xm 2.27.0 (Codex global bundle)');
  });

  test('compares by version, not by string order', () => {
    codexBundle({ version: '2.9.0' });
    cacheRoot('2.10.0');

    expect(xmVersion()).toBe('xm 2.10.0 (marketplace cache)');
  });

  test('ignores the Codex cachebuster suffix', () => {
    codexBundle({ version: '2.27.0+codex.9f2a1b' });
    cacheRoot('2.27.0');

    expect(xmVersion()).toBe('xm 2.27.0+codex.9f2a1b (Codex global bundle)');
  });

  test('takes the cache when the bundle cannot state its version', () => {
    codexBundle();
    cacheRoot('2.27.0');

    expect(xmVersion()).toBe('xm 2.27.0 (marketplace cache)');
  });

  test('takes the bundle when there is no cache', () => {
    codexBundle({ version: '2.27.0' });

    expect(xmVersion()).toBe('xm 2.27.0 (Codex global bundle)');
  });

  test('takes the cache when there is no bundle', () => {
    cacheRoot('2.27.0');

    expect(xmVersion()).toBe('xm 2.27.0 (marketplace cache)');
  });
});

// The dashboard server serves ../public beside its lib. A Codex bundle that
// predates the public/ mirror resolves first on a version tie, and served a
// health endpoint with every page 404ing — so the dispatcher must skip it.
describe('xm dashboard — lib without browser assets', () => {
  /** A stub server that reports which lib the dispatcher launched. */
  function dashboardLib(libDir, { withPublic }) {
    mkdirSync(libDir, { recursive: true });
    writeFileSync(join(libDir, 'x-dashboard-server.mjs'), 'console.log(`SERVED ${import.meta.dir}`);\n');
    if (withPublic) {
      mkdirSync(join(libDir, '..', 'public'), { recursive: true });
      writeFileSync(join(libDir, '..', 'public', 'index.html'), '<!doctype html>\n');
    }
  }

  // Bun reports the resolved path; macOS tmpdir() is behind /var -> /private/var.
  beforeEach(() => { home = realpathSync(home); });

  function dashboardStop() {
    const r = spawnSync('bash', [DISPATCHER, 'dashboard', 'stop'], {
      cwd: home,
      env: { ...BASE_ENV, HOME: home },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? -1 };
  }

  test('falls back to the cache lib that ships public/', () => {
    codexBundle({ version: '2.54.0' });
    dashboardLib(join(home, '.codex', 'xm', 'lib'), { withPublic: false });
    cacheRoot('2.54.0');
    const cacheLib = join(home, '.claude', 'plugins', 'cache', 'xm', 'xm', '2.54.0', 'lib');
    dashboardLib(cacheLib, { withPublic: true });

    const r = dashboardStop();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`SERVED ${cacheLib}`);
    expect(r.stderr).toContain('has no ../public/');
  });

  test('fails loudly when no candidate lib ships public/', () => {
    codexBundle({ version: '2.54.0' });
    dashboardLib(join(home, '.codex', 'xm', 'lib'), { withPublic: false });

    const r = dashboardStop();
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('SERVED');
    expect(r.stderr).toContain('no cache lib has one');
  });

  test('keeps a lib that already ships public/', () => {
    codexBundle({ version: '2.54.0' });
    const codexLib = join(home, '.codex', 'xm', 'lib');
    dashboardLib(codexLib, { withPublic: true });

    const r = dashboardStop();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`SERVED ${codexLib}`);
    expect(r.stderr).not.toContain('has no ../public/');
  });
});
