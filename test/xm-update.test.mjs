import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const REPO = join(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'xm', 'scripts', 'xm');
const CLI = join(REPO, 'xm', 'lib', 'install', 'install-cli.mjs');
const SKILLS = join(REPO, 'xm', 'skills');
const LIB = join(REPO, 'xm', 'lib');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe('xm update cross-target convergence', () => {
  test('refreshes Codex even when the Claude marketplace version is already current', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-update-'));
    const bin = join(home, 'bin');
    const calls = join(home, 'calls.log');
    mkdirSync(bin, { recursive: true });

    const env = {
      ...process.env,
      HOME: home,
      XM_LIB: REPO,
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
      XM_TEST_CALLS: calls,
    };

    const installed = spawnSync(process.execPath, [CLI, '--target', 'codex', '--global', '--yes', '--force',
      '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: home, env, encoding: 'utf8' });
    expect(installed.status).toBe(0);

    const cache = join(home, '.claude', 'plugins', 'cache', 'xm', 'xm', VERSION);
    mkdirSync(cache, { recursive: true });
    cpSync(LIB, join(cache, 'lib'), { recursive: true });
    cpSync(SKILLS, join(cache, 'skills'), { recursive: true });
    copyFileSync(join(REPO, 'xm', 'skills.checksums.json'), join(cache, 'skills.checksums.json'));
    mkdirSync(join(cache, '.claude-plugin'), { recursive: true });
    copyFileSync(join(REPO, 'xm', '.claude-plugin', 'plugin.json'), join(cache, '.claude-plugin', 'plugin.json'));

    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: { 'xm@xm': [{ version: VERSION }] },
    }));

    executable(join(bin, 'curl'), `printf '%s' '{"plugins":[{"name":"xm","version":"${VERSION}"}]}'`);
    executable(join(bin, 'claude'), 'echo "claude $*" >> "$XM_TEST_CALLS"');
    executable(join(bin, 'codex'), 'echo "codex $*" >> "$XM_TEST_CALLS"');

    const result = spawnSync('bash', [SCRIPT, 'update', '--no-cli'], {
      cwd: home, env, encoding: 'utf8', timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Claude marketplace is already current; checking installed overlays.');
    expect(result.stdout).toContain('refreshing Codex plugin cache');
    const log = readFileSync(calls, 'utf8');
    expect(log).toContain('codex plugin add xm@personal');
    expect(log).not.toContain('claude plugin');

    const plugin = JSON.parse(readFileSync(join(home, 'plugins', 'xm', '.codex-plugin', 'plugin.json'), 'utf8'));
    expect(plugin.version).toMatch(new RegExp(`^${VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\+codex\\.local-`));
  });
});
