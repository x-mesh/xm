import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `xm init` wires the relay auto-reply hook into Claude (settings.json) and,
// when ~/.codex exists, Codex (hooks.json), next to whatever the user has there.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(REPO, 'xm', 'scripts', 'setup-global.mjs');
const SOURCE = readFileSync(join(REPO, 'xm', 'hooks', 'relay-autoreply.mjs'), 'utf8');
const { XM_LIB: _xmLib, X_KIT_LIB: _xKitLib, XM_HOOK_SRC: _hookSrc, ...BASE_ENV } = process.env;
const USER_HOOK = { hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook.sh' }] };

let home;
const setup = (...args) => spawnSync('node', [SETUP, ...args], {
  cwd: REPO, encoding: 'utf8', env: { ...BASE_ENV, HOME: home, XM_BIN_DIR: join(home, 'bin') },
});
const claudeSettings = () => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
const codexHooks = () => JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
const relayCommands = (document, event) => (document.hooks?.[event] || [])
  .flatMap(group => group.hooks || []).filter(h => h.command.includes('xm-relay-autoreply.mjs'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xm-setup-relay-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [USER_HOOK], Stop: [USER_HOOK] } }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('xm init relay auto-reply hook', () => {
  test('installs into Claude and Codex once, beside user hooks, and survives a reinstall with another node path', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [USER_HOOK] } }));
    expect(setup('install').status).toBe(0);

    const claudeHook = join(home, '.claude', 'hooks', 'xm-relay-autoreply.mjs');
    const codexHook = join(home, '.codex', 'xm', 'hooks', 'xm-relay-autoreply.mjs');
    expect(readFileSync(claudeHook, 'utf8')).toBe(SOURCE);
    expect(readFileSync(codexHook, 'utf8')).toBe(SOURCE);
    for (const event of ['UserPromptSubmit', 'Stop']) {
      expect(relayCommands(claudeSettings(), event)).toEqual([expect.objectContaining({ command: expect.stringMatching(new RegExp(`"${claudeHook}" claude$`)), timeout: 30 })]);
      expect(relayCommands(codexHooks(), event)).toEqual([expect.objectContaining({ command: expect.stringMatching(new RegExp(`"${codexHook}" codex$`)), timeout: 30 })]);
    }
    expect(claudeSettings().hooks.UserPromptSubmit).toContainEqual(USER_HOOK);
    expect(codexHooks().hooks.Stop).toContainEqual(USER_HOOK);

    const stale = codexHooks();
    stale.hooks.Stop = stale.hooks.Stop.map(group => ({ ...group, hooks: group.hooks.map(h => ({ ...h, command: h.command.replace(/^"[^"]+"/, '"/old/node"') })) }));
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify(stale));
    expect(setup('install').status).toBe(0);
    for (const event of ['UserPromptSubmit', 'Stop']) {
      expect(relayCommands(claudeSettings(), event)).toHaveLength(1);
      expect(relayCommands(codexHooks(), event)).toHaveLength(1);
    }
    expect(codexHooks().hooks.Stop).toContainEqual(USER_HOOK);
  });

  test('leaves Codex alone when ~/.codex does not exist', () => {
    const result = setup('install');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('~/.codex not found, Codex skipped');
    expect(existsSync(join(home, '.codex'))).toBe(false);
    expect(relayCommands(claudeSettings(), 'Stop')).toHaveLength(1);
  });

  test('an xm build without the hook source skips it with a warning and still installs the trace hook', () => {
    const result = spawnSync('node', [SETUP, 'install'], {
      cwd: home, encoding: 'utf8',
      env: { ...BASE_ENV, HOME: home, XM_BIN_DIR: join(home, 'bin'), XM_HOOK_SRC: join(REPO, 'xm', 'hooks', 'trace-session.mjs') },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('relay auto-reply hook skipped');
    expect(existsSync(join(home, '.claude', 'hooks', 'xm-trace-session.mjs'))).toBe(true);
    expect(relayCommands(claudeSettings(), 'Stop')).toHaveLength(0);
  });

  test('--no-hooks installs no relay hook', () => {
    mkdirSync(join(home, '.codex'));
    expect(setup('install', '--no-hooks').status).toBe(0);
    expect(existsSync(join(home, '.claude', 'hooks', 'xm-relay-autoreply.mjs'))).toBe(false);
    expect(relayCommands(claudeSettings(), 'Stop')).toHaveLength(0);
    expect(existsSync(join(home, '.codex', 'hooks.json'))).toBe(false);
  });

  test('uninstall removes both copies and their entries and keeps user hooks', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [USER_HOOK] } }));
    setup('install');
    expect(setup('uninstall').status).toBe(0);
    expect(existsSync(join(home, '.claude', 'hooks', 'xm-relay-autoreply.mjs'))).toBe(false);
    expect(existsSync(join(home, '.codex', 'xm', 'hooks', 'xm-relay-autoreply.mjs'))).toBe(false);
    expect(claudeSettings().hooks.UserPromptSubmit).toEqual([USER_HOOK]);
    expect(codexHooks().hooks).toEqual({ Stop: [USER_HOOK] });
  });

  test('a corrupt Codex hooks.json stops the install instead of being overwritten', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'hooks.json'), '{ not json');
    const result = setup('install');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot parse');
    expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).toBe('{ not json');
  });
});
