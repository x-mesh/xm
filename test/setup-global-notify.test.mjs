import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `xm setup --notify` opts in to the turn-done hook. Later installs refresh it
// while it is installed, and uninstall removes it from Claude and Codex.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(REPO, 'xm', 'scripts', 'setup-global.mjs');
const SOURCE = readFileSync(join(REPO, 'xm', 'hooks', 'notify-done.mjs'), 'utf8');
const { XM_LIB: _xmLib, X_KIT_LIB: _xKitLib, XM_HOOK_SRC: _hookSrc, ...BASE_ENV } = process.env;
const USER_HOOK = { hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook.sh' }] };

let home;
const setup = (...args) => spawnSync('node', [SETUP, ...args], {
  cwd: REPO, encoding: 'utf8', env: { ...BASE_ENV, HOME: home, XM_BIN_DIR: join(home, 'bin') },
});
const claudeSettings = () => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
const codexHooks = () => JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
const notifyCommands = (document, event) => (document.hooks?.[event] || [])
  .flatMap((group) => group.hooks || []).filter((h) => h.command.includes('xm-notify-done.mjs'));
const claudeHook = () => join(home, '.claude', 'hooks', 'xm-notify-done.mjs');
const codexHook = () => join(home, '.codex', 'xm', 'hooks', 'xm-notify-done.mjs');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xm-setup-notify-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [USER_HOOK], Notification: [USER_HOOK] } }));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('xm setup --notify', () => {
  test('is not installed without the flag', () => {
    const result = setup('install');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('notify hook: not enabled (opt in: xm');
    expect(existsSync(claudeHook())).toBe(false);
    expect(notifyCommands(claudeSettings(), 'Stop')).toEqual([]);
  });

  test('installs into Claude and Codex beside user hooks, and a later install refreshes it once', () => {
    mkdirSync(join(home, '.codex'));
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [USER_HOOK] } }));
    expect(setup('--notify').status).toBe(0);

    expect(readFileSync(claudeHook(), 'utf8')).toBe(SOURCE);
    expect(readFileSync(codexHook(), 'utf8')).toBe(SOURCE);
    for (const event of ['UserPromptSubmit', 'Stop', 'Notification']) {
      expect(notifyCommands(claudeSettings(), event)).toEqual([expect.objectContaining({ command: expect.stringMatching(new RegExp(`"${claudeHook()}" claude$`)), timeout: 15 })]);
    }
    for (const event of ['UserPromptSubmit', 'Stop']) {
      expect(notifyCommands(codexHooks(), event)).toEqual([expect.objectContaining({ command: expect.stringMatching(new RegExp(`"${codexHook()}" codex$`)), timeout: 15 })]);
    }
    expect(notifyCommands(codexHooks(), 'Notification')).toEqual([]);
    expect(claudeSettings().hooks.Notification).toContainEqual(USER_HOOK);
    expect(codexHooks().hooks.Stop).toContainEqual(USER_HOOK);

    writeFileSync(claudeHook(), '// stale copy\n');
    expect(setup('install').status).toBe(0);
    expect(readFileSync(claudeHook(), 'utf8')).toBe(SOURCE);
    for (const event of ['UserPromptSubmit', 'Stop', 'Notification']) expect(notifyCommands(claudeSettings(), event)).toHaveLength(1);
    expect(setup('status').stdout).toContain(`notify hook      : ${claudeHook()}`);
  });

  test('uninstall removes the hook files and entries and keeps user hooks', () => {
    mkdirSync(join(home, '.codex'));
    expect(setup('--notify').status).toBe(0);
    expect(setup('uninstall').status).toBe(0);
    expect(existsSync(claudeHook())).toBe(false);
    expect(existsSync(codexHook())).toBe(false);
    for (const event of ['UserPromptSubmit', 'Stop', 'Notification']) expect(notifyCommands(claudeSettings(), event)).toEqual([]);
    expect(notifyCommands(codexHooks(), 'Stop')).toEqual([]);
    expect(claudeSettings().hooks.Notification).toEqual([USER_HOOK]);
    expect(setup('status').stdout).toContain('notify hook      : (not enabled');
  });
});
