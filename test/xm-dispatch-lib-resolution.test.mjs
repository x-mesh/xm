import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
