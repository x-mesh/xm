import { describe, test, expect } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'xm', 'scripts', 'install.sh');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

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

function fixture({ installedVersion, withClaude = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'xm-install-script-'));
  const bin = join(home, 'bin');
  const calls = join(home, 'calls.log');
  mkdirSync(bin, { recursive: true });
  executable(join(bin, 'codex'), 'echo "codex $*" >> "$XM_TEST_CALLS"');
  if (withClaude) executable(join(bin, 'claude'), 'echo "claude $*" >> "$XM_TEST_CALLS"');
  if (installedVersion) {
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'xm@xm': [{ version: installedVersion }] },
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
    ...process.env,
    HOME: home,
    XM_BIN_DIR: join(home, '.local', 'bin'),
    XM_TEST_CALLS: calls,
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
});
