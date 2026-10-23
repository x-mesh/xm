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

// `xm/scripts/xm` resolves its lib from XM_LIB before anything else, so a
// developer shell that exports it (pointing at this checkout) overrides the
// fixture HOME these tests build: resolve_lib returns the repo, the Codex-only
// branch is never reached, and the update tests fail for everyone with that
// variable set while passing in CI. Strip it once here rather than per-spawn.
const { XM_LIB: _ignoredXmLib, ...BASE_ENV } = process.env;

function executable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

describe('xm update cross-target convergence', () => {
  test('Codex-only dispatcher delegates update to the umbrella installer', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-update-codex-only-'));
    const bin = join(home, 'bin');
    const calls = join(home, 'calls.log');
    const installer = join(home, 'install.sh');
    mkdirSync(join(home, '.codex', 'xm', 'lib'), { recursive: true });
    mkdirSync(join(home, 'plugins', 'xm', '.codex-plugin'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, 'plugins', 'xm', '.codex-plugin', 'plugin.json'), JSON.stringify({ version: VERSION }));
    executable(join(bin, 'codex'), 'exit 0');
    executable(join(bin, 'curl'), `printf '%s' '{"plugins":[{"name":"xm","version":"${VERSION}"}]}'`);
    executable(installer, 'echo "installer $*" >> "$XM_TEST_CALLS"');

    const result = spawnSync('bash', [SCRIPT, 'update', '--force'], {
      cwd: home,
      env: {
        ...BASE_ENV,
        HOME: home,
        PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
        XM_INSTALL_SCRIPT: installer,
        XM_TEST_CALLS: calls,
      },
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    expect(result.stdout).toContain('The active xm lib is the Codex bundle');
    expect(result.stdout).toContain(`Codex installation updated to ${VERSION}`);
    expect(readFileSync(calls, 'utf8')).toContain('installer --yes');
  });

  // The installer can return 0 after reinstalling Codex from a stale Claude
  // cache. Success has to come from the version the bundle now declares.
  test('Codex bundle the installer did not move is reported as a failure', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-update-codex-stale-'));
    const bin = join(home, 'bin');
    const installer = join(home, 'install.sh');
    mkdirSync(join(home, '.codex', 'xm', 'lib'), { recursive: true });
    mkdirSync(join(home, 'plugins', 'xm', '.codex-plugin'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, 'plugins', 'xm', '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '0.1.0+codex.local-1' }));
    executable(join(bin, 'codex'), 'exit 0');
    executable(join(bin, 'curl'), `printf '%s' '{"plugins":[{"name":"xm","version":"${VERSION}"}]}'`);
    executable(installer, 'exit 0');

    const result = spawnSync('bash', [SCRIPT, 'update'], {
      cwd: home,
      env: { ...BASE_ENV, HOME: home, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, XM_INSTALL_SCRIPT: installer },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`the Codex bundle is still 0.1.0+codex.local-1, not ${VERSION}`);
    expect(result.stdout).not.toContain('Codex installation updated');
  });

  test('a failing installer stops the Codex update with its exit status', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-update-codex-fail-'));
    const bin = join(home, 'bin');
    const installer = join(home, 'install.sh');
    mkdirSync(join(home, '.codex', 'xm', 'lib'), { recursive: true });
    mkdirSync(join(home, 'plugins', 'xm', '.codex-plugin'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, 'plugins', 'xm', '.codex-plugin', 'plugin.json'), JSON.stringify({ version: VERSION }));
    executable(join(bin, 'codex'), 'exit 0');
    executable(join(bin, 'curl'), `printf '%s' '{"plugins":[{"name":"xm","version":"${VERSION}"}]}'`);
    executable(installer, 'exit 3');

    const result = spawnSync('bash', [SCRIPT, 'update', '--force'], {
      cwd: home,
      env: { ...BASE_ENV, HOME: home, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, XM_INSTALL_SCRIPT: installer },
      encoding: 'utf8',
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('the xm installer exited 3');
    expect(result.stdout).not.toContain('Codex installation updated');
  });

  test('Codex-only dry-run does not invoke the installer', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-update-codex-dry-'));
    const bin = join(home, 'bin');
    mkdirSync(join(home, '.codex', 'xm', 'lib'), { recursive: true });
    mkdirSync(join(home, 'plugins', 'xm', '.codex-plugin'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(home, 'plugins', 'xm', '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '0.1.0' }));
    executable(join(bin, 'codex'), 'exit 0');
    executable(join(bin, 'curl'), `printf '%s' '{"plugins":[{"name":"xm","version":"${VERSION}"}]}'`);

    const result = spawnSync('bash', [SCRIPT, 'update', '--dry-run'], {
      cwd: home,
      env: {
        ...BASE_ENV,
        HOME: home,
        PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
        XM_INSTALL_SCRIPT: join(home, 'must-not-exist.sh'),
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run — would run the xm installer');
  });

  test('refreshes Codex even when the Claude marketplace version is already current', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-update-'));
    const bin = join(home, 'bin');
    const calls = join(home, 'calls.log');
    mkdirSync(bin, { recursive: true });

    const env = {
      ...BASE_ENV,
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

  // The renderers skip a hook they cannot install and say so, but `xm update`
  // prints only the propagate JSON, so the note has to travel through it.
  test('prints the hooks a target skipped while propagating', () => {
    const home = mkdtempSync(join(tmpdir(), 'xm-update-skip-'));
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `printf '%s\\n' '{"x":1}'` }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo stop-ok' }] }],
    } }));
    const env = { ...BASE_ENV, HOME: home, XM_LIB: REPO, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` };

    const installed = spawnSync(process.execPath, [CLI, '--target', 'codex', '--global', '--yes', '--force',
      '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: home, env, encoding: 'utf8' });
    expect(installed.status).toBe(0);
    const cache = join(home, '.claude', 'plugins', 'cache', 'xm', 'xm', VERSION);
    mkdirSync(join(cache, '.claude-plugin'), { recursive: true });
    cpSync(LIB, join(cache, 'lib'), { recursive: true });
    cpSync(SKILLS, join(cache, 'skills'), { recursive: true });
    copyFileSync(join(REPO, 'xm', 'skills.checksums.json'), join(cache, 'skills.checksums.json'));
    copyFileSync(join(REPO, 'xm', '.claude-plugin', 'plugin.json'), join(cache, '.claude-plugin', 'plugin.json'));
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'xm@xm': [{ version: VERSION }] } }));
    executable(join(bin, 'curl'), `printf '%s' '{"plugins":[{"name":"xm","version":"${VERSION}"}]}'`);
    executable(join(bin, 'claude'), 'exit 0');
    executable(join(bin, 'codex'), 'exit 0');

    const result = spawnSync('bash', [SCRIPT, 'update', '--no-cli'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    expect(result.stdout).toContain('note: codex: skipped a hook with shell metacharacters (not installed): PostToolUse: printf');
  });
});
