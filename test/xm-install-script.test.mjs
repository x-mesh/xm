import { describe, test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'xm', 'scripts', 'install.sh');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

// `xm/scripts/xm` resolves its lib from XM_LIB before every other candidate, so a
// developer shell exporting it (pointing at this checkout) overrides the fixture
// HOME these tests build: `xm which` reports the repo instead of the fixture's
// Codex bundle, and the resolve-order spec fails for everyone with the variable
// set while passing in CI. Same leak already fixed for xm-update (81b9aa0).
// CLAUDE_CONFIG_DIR is the same class of leak, newly reachable: install.sh now
// prefers it over $HOME/.claude for the registry, marketplace clone and plugin
// cache, so a developer shell exporting it points these fixtures at the real
// config. Strip it here and pin it to the fixture below, which also makes the
// new CLAUDE_CONFIG_DIR support the thing under test rather than a silent
// redirect around it.
const { XM_LIB: _ignoredXmLib, CLAUDE_CONFIG_DIR: _ignoredClaudeConfigDir, ...BASE_ENV } = process.env;

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

// Drop every PATH entry that holds a real `claude`, keeping the rest so node
// and curl stay reachable.
function pathWithoutClaude() {
  return (process.env.PATH || '')
    .split(':')
    .filter((dir) => dir && !existsSync(join(dir, 'claude')))
    .join(':');
}

// Write a marketplace clone and a registry so install.sh can build its
// version-comparison plan: `market` and `registry` are {name: version} maps.
function seedPluginState(home, { market, registry }) {
  const marketDir = join(home, '.claude', 'plugins', 'marketplaces', 'xm', '.claude-plugin');
  mkdirSync(marketDir, { recursive: true });
  writeFileSync(join(marketDir, 'marketplace.json'), JSON.stringify({
    name: 'xm',
    plugins: Object.entries(market).map(([name, version]) => ({ name, source: `./x-${name}`, version })),
  }));
  const plugins = {};
  for (const [name, version] of Object.entries(registry)) {
    const installPath = join(home, '.claude', 'plugins', 'cache', 'xm', name, version);
    mkdirSync(installPath, { recursive: true });
    plugins[`${name}@xm`] = [{ scope: 'user', installPath, version }];
  }
  const regDir = join(home, '.claude', 'plugins');
  mkdirSync(regDir, { recursive: true });
  writeFileSync(join(regDir, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
}

// install.sh now checks the registry after `claude plugin update/install`, so the
// stub has to do what claude does: record the version the marketplace clone
// offers (the repo's marketplace when the clone lacks it). XM_TEST_CLAUDE_NOOP=1
// makes it exit 0 and change nothing, which is the failure being guarded.
const CLAUDE_REGISTRY_STUB = `
const fs = require('fs');
const path = require('path');
if (process.env.XM_TEST_CLAUDE_NOOP === '1') process.exit(0);
const plugins = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins');
const regPath = path.join(plugins, 'installed_plugins.json');
const name = String(process.argv[2] || '').split('@')[0];
const read = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const versionIn = (m) => ((m && m.plugins) || []).find((p) => p.name === name)?.version;
const version = versionIn(read(path.join(plugins, 'marketplaces', 'xm', '.claude-plugin', 'marketplace.json')))
  || versionIn(read(process.env.XM_TEST_REPO_MARKET));
if (!version) process.exit(0);
// A corrupt registry is rewritten, as claude rewrites the whole file on install.
const reg = read(regPath) || { version: 2, plugins: {} };
const installPath = path.join(plugins, 'cache', 'xm', name, version);
fs.mkdirSync(installPath, { recursive: true });
reg.plugins = reg.plugins || {};
reg.plugins[name + '@xm'] = [{ scope: 'user', installPath, version }];
fs.mkdirSync(plugins, { recursive: true });
fs.writeFileSync(regPath, JSON.stringify(reg));
`;

function fixture({ installedVersion, withClaude = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'xm-install-script-'));
  const bin = join(home, 'bin');
  const calls = join(home, 'calls.log');
  mkdirSync(bin, { recursive: true });
  executable(join(bin, 'codex'), 'echo "codex $*" >> "$XM_TEST_CALLS"');
  if (withClaude) {
    writeFileSync(join(home, 'claude-registry-stub.js'), CLAUDE_REGISTRY_STUB);
    executable(join(bin, 'claude'), [
      'echo "claude $*" >> "$XM_TEST_CALLS"',
      'case "$1 $2" in',
      `  "plugin update"|"plugin install") node "${join(home, 'claude-registry-stub.js')}" "$3" ;;`,
      'esac',
    ].join('\n'));
  }
  if (installedVersion) {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    // installPath must exist: install.sh skips a plugin only when the registry
    // version matches the marketplace version AND its files are still on disk.
    const xmPath = join(home, '.claude', 'plugins', 'cache', 'xm', 'xm', installedVersion);
    mkdirSync(xmPath, { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: { 'xm@xm': [{ scope: 'user', installPath: xmPath, version: installedVersion }] },
    }));
  }
  // The inherited PATH keeps node/curl reachable but must not leak a real
  // `claude`: these fixtures decide Claude availability via the stub above, and
  // a developer's own claude would send install.sh down the Claude branch and
  // pull the *published* xm into `home`. resolve_lib prefers that marketplace
  // cache over the Codex bundle, so `xm version` would then report the released
  // version instead of the one under test — green only while the source and
  // remote versions coincide, and red on every release bump.
  const env = {
    ...BASE_ENV,
    HOME: home,
    // Pinned, not merely stripped: install.sh reads the registry, clone and
    // cache through this, so the fixture must be what it resolves to.
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    XM_BIN_DIR: join(home, '.local', 'bin'),
    XM_TEST_CALLS: calls,
    XM_TEST_REPO_MARKET: join(REPO, '.claude-plugin', 'marketplace.json'),
    PATH: `${bin}:${dirname(process.execPath)}:${pathWithoutClaude()}`,
  };
  return { home, calls, env };
}

describe('xm install.sh', () => {
  test('installs Codex globally on a Linux Codex-only host', () => {
    const { home, calls, env } = fixture();
    const result = spawnSync('bash', [SCRIPT, '--yes'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    expect(existsSync(join(home, '.codex', 'xm', 'manifest.json'))).toBe(true);
    expect(existsSync(join(home, '.agents', 'skills', 'xm-build', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'plugins', 'xm', '.codex-plugin', 'plugin.json'))).toBe(true);
    expect(readFileSync(calls, 'utf8')).toContain('codex plugin add xm@personal');
    expect(result.stdout).toContain('Codex integration installed');
    const cli = spawnSync(join(home, '.local', 'bin', 'xm'), ['version'], { cwd: home, env, encoding: 'utf8' });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain(`xm ${VERSION}`);
  }, 30_000);

  test('installed dispatcher prefers the explicit Codex bundle over a stale Claude cache', () => {
    const { home, env } = fixture();
    const result = spawnSync('bash', [SCRIPT, '--yes'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(0);

    mkdirSync(join(home, '.claude', 'plugins', 'cache', 'xm', 'xm', '0.0.1', 'lib'), { recursive: true });
    const which = spawnSync(join(home, '.local', 'bin', 'xm'), ['which'], { cwd: home, env, encoding: 'utf8' });

    expect(which.status).toBe(0);
    expect(which.stdout).toContain(`lib: ${join(home, '.codex', 'xm')}`);
    expect(which.stdout).not.toContain(join(home, '.claude', 'plugins', 'cache', 'xm'));
  }, 30_000);

  test('--no declines an available update before changing files', () => {
    const { home, env } = fixture({ installedVersion: '0.1.0', withClaude: true });
    const result = spawnSync('bash', [SCRIPT, '--no'], { cwd: home, env, encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Kept xm 0.1.0. No files were changed.');
    expect(existsSync(join(home, '.local', 'bin', 'xm'))).toBe(false);
    expect(existsSync(join(home, '.codex', 'xm', 'manifest.json'))).toBe(false);
  });

  test('--yes updates existing Claude plugins and repairs missing Codex install', () => {
    const { home, calls, env } = fixture({ installedVersion: '0.1.0', withClaude: true });
    const result = spawnSync('bash', [SCRIPT, '--yes'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const log = readFileSync(calls, 'utf8');
    expect(log).toContain('claude plugin marketplace update xm');
    expect(log).toContain('claude plugin update xm@xm -s user');
    expect(log).toContain('codex plugin add xm@personal');
    expect(existsSync(join(home, '.codex', 'xm', 'manifest.json'))).toBe(true);
    const plugin = JSON.parse(readFileSync(join(home, 'plugins', 'xm', '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(plugin.version).toBe(VERSION);
  }, 30_000);

  test('skips plugins already at the marketplace version and updates only the rest', () => {
    const { home, calls, env } = fixture({ installedVersion: '0.1.0', withClaude: true });
    seedPluginState(home, {
      market: { xm: VERSION, build: '3.0.0', panel: '0.9.0', probe: '2.2.1' },
      registry: { xm: '0.1.0', build: '2.0.0', panel: '0.9.0', probe: '2.2.1' },
    });

    const result = spawnSync('bash', [SCRIPT, '--yes'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const log = readFileSync(calls, 'utf8');
    // Stale ones get the expensive call...
    expect(log).toContain('claude plugin update build@xm -s user');
    expect(log).toContain('claude plugin update xm@xm -s user');
    // ...current ones do not.
    expect(log).not.toContain('panel@xm -s user');
    expect(log).not.toContain('probe@xm -s user');
    expect(result.stdout).toContain('2 plugin(s) already at the marketplace version');
  }, 30_000);

  test('reinstalls a plugin whose cached files are gone even when versions match', () => {
    const { home, calls, env } = fixture({ installedVersion: '0.1.0', withClaude: true });
    seedPluginState(home, {
      market: { xm: VERSION, panel: '0.9.0' },
      registry: { xm: '0.1.0', panel: '0.9.0' },
    });
    rmSync(join(home, '.claude', 'plugins', 'cache', 'xm', 'panel', '0.9.0'), { recursive: true });

    const result = spawnSync('bash', [SCRIPT, '--yes'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    expect(readFileSync(calls, 'utf8')).toContain('claude plugin install panel@xm -s user');
  }, 30_000);

  test('falls back to touching every plugin when the registry is unreadable', () => {
    const { home, calls, env } = fixture({ installedVersion: '0.1.0', withClaude: true });
    seedPluginState(home, {
      market: { xm: VERSION, build: '3.0.0', panel: '0.9.0' },
      registry: { xm: '0.1.0', build: '3.0.0', panel: '0.9.0' },
    });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), '{ not json');

    const result = spawnSync('bash', [SCRIPT, '--yes'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const log = readFileSync(calls, 'utf8');
    // A broken registry must never be read as "everything is current".
    for (const name of ['xm', 'build', 'panel']) {
      expect(log).toContain(`${name}@xm -s user`);
    }
    expect(result.stdout).not.toContain('already at the marketplace version');
  }, 30_000);

  // install.sh resolves the registry, clone and cache through CLAUDE_CONFIG_DIR.
  // Without a test that reads state from somewhere other than $HOME/.claude, the
  // variable could stop being honoured and every other test would stay green.
  test('resolves plugin state through CLAUDE_CONFIG_DIR, not $HOME/.claude', () => {
    const { home, calls, env } = fixture({ installedVersion: '0.1.0', withClaude: true });
    const altHome = mkdtempSync(join(tmpdir(), 'xm-install-altcfg-'));
    seedPluginState(altHome, {
      market: { xm: VERSION, panel: '0.9.0' },
      registry: { xm: '0.1.0', panel: '0.9.0' },
    });

    const result = spawnSync('bash', [SCRIPT, '--yes'], {
      cwd: home,
      env: { ...env, CLAUDE_CONFIG_DIR: join(altHome, '.claude') },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    // panel is current only in the ALTERNATE config; $HOME/.claude knows nothing
    // about it, so a skip here proves the alternate dir was the one consulted.
    expect(readFileSync(calls, 'utf8')).not.toContain('panel@xm -s user');
    expect(result.stdout).toContain('already at the marketplace version');
    rmSync(altHome, { recursive: true, force: true });
  }, 30_000);

  // The clone is refreshed only on an update run, so planning from it alone
  // drops a plugin it has not picked up yet — silently, with the run still
  // reporting success. The plan must cover the fetched marketplace too.
  test('installs a plugin missing from the marketplace clone', () => {
    const { home, calls, env } = fixture({ installedVersion: '0.1.0', withClaude: true });
    seedPluginState(home, {
      market: { xm: VERSION, panel: '0.9.0' }, // clone has not seen `build` yet
      registry: { xm: '0.1.0', panel: '0.9.0' },
    });
    // The fetched marketplace is the repo's own, which does carry `build`.
    expect(JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'))
      .plugins.map((p) => p.name)).toContain('build');

    const result = spawnSync('bash', [SCRIPT, '--yes'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    expect(readFileSync(calls, 'utf8')).toContain('claude plugin install build@xm -s user');
  }, 30_000);

  // `claude plugin marketplace update` can exit 0 without moving the clone. The
  // plan then compares the registry with the stale clone, calls everything
  // current, and the run used to report success while installing nothing.
  test('fails when the marketplace clone stays behind the released version', () => {
    const { home, env } = fixture({ installedVersion: '0.0.1', withClaude: true });
    seedPluginState(home, { market: { xm: '0.0.1' }, registry: { xm: '0.0.1' } });

    const result = spawnSync('bash', [SCRIPT, '--yes'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`The xm marketplace clone is still at 0.0.1, but ${VERSION} is released`);
    expect(result.stdout).not.toContain('Claude plugins are already current');
    expect(result.stdout).not.toContain('Claude plugins are ready');
  }, 30_000);

  test('fails when claude plugin update exits 0 without moving the plugin', () => {
    const { home, env } = fixture({ installedVersion: '0.1.0', withClaude: true });
    seedPluginState(home, { market: { xm: VERSION }, registry: { xm: '0.1.0' } });

    const result = spawnSync('bash', [SCRIPT, '--yes'], {
      cwd: home, env: { ...env, XM_TEST_CLAUDE_NOOP: '1' }, encoding: 'utf8', timeout: 60_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Claude plugins did not reach the marketplace version:');
    expect(result.stderr).toContain(`xm 0.1.0 (expected ${VERSION})`);
    expect(result.stdout).not.toContain('Claude plugins are ready');
  }, 30_000);
});
