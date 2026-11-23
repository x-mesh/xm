import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `xm setup` installs the x-build lease guard for every project on the machine. A project
// that never ran `xm build hooks install`, such as a new one, is where an agent ignored a
// failed `route start` and dispatched executors with no lease.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETUP = join(REPO, 'xm', 'scripts', 'setup-global.mjs');
const BUILD_CLI = join(REPO, 'x-build', 'lib', 'x-build-cli.mjs');
const TEMPLATES = join(REPO, 'x-build', 'templates', 'hooks');
const { XM_LIB: _xmLib, X_KIT_LIB: _xKitLib, XM_HOOK_SRC: _hookSrc, X_BUILD_ROOT: _buildRoot, XM_ROOT: _xmRoot, XM_BUILD_HOOKS_OFF: _hooksOff, ...BASE_ENV } = process.env;
const USER_HOOK = { matcher: 'Agent', hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook.sh' }] };
const SESSION = '11111111-2222-4333-8444-555555555555';

let home;
let project;
const setup = (...args) => spawnSync('node', [SETUP, ...args], {
  cwd: REPO, encoding: 'utf8', env: { ...BASE_ENV, HOME: home, XM_BIN_DIR: join(home, 'bin') },
});
const settings = () => JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
const guardFile = () => join(home, '.claude', 'hooks', 'xm-build', 'xm-build-lease-guard.mjs');
const stateFile = () => join(home, '.claude', 'hooks', 'xm-build', 'hook-state.mjs');
const guardGroups = () => (settings().hooks?.PreToolUse || []).filter(group => (group.hooks || []).some(h => h.command.includes('xm-build-lease-guard.mjs')));
const route = (...args) => spawnSync('node', [BUILD_CLI, 'route', ...args], {
  cwd: project, encoding: 'utf8', env: { ...BASE_ENV, HOME: home, XM_ROOT: join(project, '.xm'), CLAUDE_CODE_SESSION_ID: SESSION, GIT_CEILING_DIRECTORIES: tmpdir() },
});
// The installed copy, called the way Claude Code calls it: no project variable is needed.
const agentCall = (payload, env = {}) => spawnSync('node', [guardFile()], {
  input: JSON.stringify({ tool_name: 'Agent', session_id: SESSION, cwd: project, ...payload }),
  encoding: 'utf8', env: { ...BASE_ENV, HOME: home, ...env },
});
// The project is not a git repository, so `route start` fails after the lease checks.
function failedStart() {
  const decided = route('decide', '--kind', 'bugfix', '--scope', 'bounded', '--independent', '--files', 'src/a.txt,src/b.txt', '--risk', 'low', '--failure-modes', '2', '--gates', 'test,boundary', '--json');
  const id = JSON.parse(decided.stdout).decision_id;
  expect(route('confirm', '--decision-id', id, '--host', 'claude', '--session-model', 'unknown', '--source', 'default').status).toBe(0);
  const started = route('start', '--decision-id', id, '--expected-files', 'src/a.txt', '--gate-cmd', 'test=test -f src/a.txt', '--gate-cmd', 'boundary=test -s src/a.txt');
  expect(started.stderr).toContain('is not in a git repository');
  return id;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'xm-setup-lease-'));
  project = mkdtempSync(join(tmpdir(), 'xm-setup-lease-project-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [USER_HOOK] } }));
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }); });

describe('xm setup lease guard hook', () => {
  test('installs the template pair once, beside user hooks, and survives a reinstall with another node path', () => {
    const result = setup('install');
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(guardFile(), 'utf8')).toBe(readFileSync(join(TEMPLATES, 'xm-build-lease-guard.mjs'), 'utf8'));
    expect(readFileSync(stateFile(), 'utf8')).toBe(readFileSync(join(TEMPLATES, 'hook-state.mjs'), 'utf8'));
    expect(guardGroups()).toEqual([{ matcher: 'Agent', hooks: [{ type: 'command', command: expect.stringMatching(new RegExp(`^"[^"]+" "${guardFile()}"$`)) }] }]);
    expect(settings().hooks.PreToolUse).toContainEqual(USER_HOOK);

    const stale = settings();
    stale.hooks.PreToolUse = stale.hooks.PreToolUse.map(group => ({ ...group, hooks: group.hooks.map(h => ({ ...h, command: h.command.replace(/^"[^"]+" "(.*xm-build-lease-guard\.mjs)"$/, '"/old/node" "$1"') })) }));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(stale));
    expect(setup('install').status).toBe(0);
    expect(guardGroups()).toHaveLength(1);
    expect(guardGroups()[0].hooks[0].command).not.toContain('/old/node');
    expect(settings().hooks.PreToolUse).toContainEqual(USER_HOOK);
  });

  test('the installed copy blocks an Agent call after route start failed, in a project with no hooks of its own', () => {
    expect(setup('install').status).toBe(0);
    expect(existsSync(join(project, '.claude'))).toBe(false);
    const id = failedStart();
    const blocked = agentCall();
    expect(blocked.status, blocked.stderr).toBe(2);
    expect(blocked.stderr).toContain(`\`xm build route start\` failed for ${id}`);
    expect(agentCall({ session_id: '99999999-2222-4333-8444-555555555555' }).status).toBe(0);
    expect(agentCall({}, { XM_BUILD_HOOKS_OFF: '1' }).status).toBe(0);
  });

  test('stays silent in a project with no .xm and on a payload it cannot read', () => {
    expect(setup('install').status).toBe(0);
    for (const payload of [{}, { cwd: 42 }, { cwd: null, session_id: 7 }, { cwd: join(project, 'missing') }]) {
      const result = agentCall(payload);
      expect([result.status, result.stderr]).toEqual([0, '']);
    }
  });

  test('status reports it without changing overall, and names the re-run when it is missing', () => {
    expect(setup('install').status).toBe(0);
    const installed = setup('status');
    expect(installed.stdout).toContain(`lease guard hook : ${guardFile()}`);
    expect(installed.stdout).toContain('overall          : OK');
    rmSync(join(home, '.claude', 'hooks', 'xm-build'), { recursive: true });
    const missing = setup('status');
    expect(missing.stdout).toContain('lease guard hook : (missing — re-run xm init)');
    expect(missing.stdout).toContain('overall          : OK');
    expect(missing.status).toBe(0);
  });

  test('--no-hooks installs no lease guard', () => {
    expect(setup('install', '--no-hooks').status).toBe(0);
    expect(existsSync(join(home, '.claude', 'hooks', 'xm-build'))).toBe(false);
    expect(guardGroups()).toHaveLength(0);
  });

  test('uninstall removes the pair and its entry and keeps user hooks', () => {
    setup('install');
    const result = setup('uninstall');
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(home, '.claude', 'hooks', 'xm-build'))).toBe(false);
    expect(guardGroups()).toHaveLength(0);
    expect(settings().hooks.PreToolUse).toContainEqual(USER_HOOK);
  });

  test('uninstall keeps a file the user put in the directory', () => {
    setup('install');
    const own = join(home, '.claude', 'hooks', 'xm-build', 'mine.mjs');
    writeFileSync(own, '// mine\n');
    expect(setup('uninstall').status).toBe(0);
    expect(existsSync(own)).toBe(true);
    expect(existsSync(guardFile())).toBe(false);
    expect(existsSync(stateFile())).toBe(false);
  });
});
