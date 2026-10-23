import { afterAll, describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderCodexShared } from '../xm/lib/install/transform/codex-shared.mjs';
import { renderCursorShared } from '../xm/lib/install/transform/cursor-shared.mjs';
import { renderKiroShared } from '../xm/lib/install/transform/kiro-shared.mjs';

const REPO = join(import.meta.dirname, '..');
const CLI = join(REPO, 'xm', 'lib', 'install', 'install-cli.mjs');
const SKILLS = join(REPO, 'xm', 'skills');
const LIB = join(REPO, 'xm', 'lib');
const ROOTS = [];
afterAll(() => { for (const root of ROOTS) rmSync(root, { recursive: true, force: true }); });

function dirWithHooks(prefix, hooks) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  ROOTS.push(root);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ hooks }));
  return root;
}

const stopHook = (command) => [{ hooks: [{ type: 'command', command }] }];
// The shape of a personal hook that broke `xm update`: a printf with quotes.
const UNSAFE = `printf '%s\\n' '{"hookSpecificOutput":{}}'`;

describe('hook translation skips only the commands it cannot install', () => {
  const root = dirWithHooks('xm-hook-skip-', {
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: UNSAFE }] }],
    Stop: stopHook('echo stop-ok'),
  });

  for (const [target, render] of [
    ['codex', () => renderCodexShared({ projectRoot: root, scope: 'global' })],
    ['cursor', () => renderCursorShared({ projectRoot: root, pluginRoots: [], scope: 'global' })],
    ['kiro', () => renderKiroShared({ projectRoot: root, scope: 'global' })],
  ]) {
    test(`${target} keeps the safe hook, drops the unsafe one, and says so`, () => {
      const { outputs, notes } = render();
      const written = outputs.map((output) => output.content).join('\n');
      expect(written).toContain('echo stop-ok');
      expect(written).not.toContain('printf');
      expect(notes.some((note) => note.startsWith(`${target}: skipped a hook with shell metacharacters`))).toBe(true);
    });
  }
});

describe('global install hook source', () => {
  test('a global Codex install reads hooks from HOME, not from the working directory', () => {
    const home = dirWithHooks('xm-hook-home-', { Stop: stopHook('echo from-home') });
    const project = dirWithHooks('xm-hook-project-', { Stop: stopHook('echo from-project') });

    const result = spawnSync('node', [CLI, '--target', 'codex', '--global', '--yes', '--force',
      '--skills-dir', SKILLS, '--lib-dir', LIB], {
      cwd: project,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.status !== 0) throw new Error(`stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const hooks = readFileSync(join(home, '.codex', 'hooks.json'), 'utf8');
    expect(hooks).toContain('echo from-home');
    expect(hooks).not.toContain('echo from-project');
  }, 60_000);

  test('--propagate carries the skipped-hook note in its JSON result', () => {
    const home = dirWithHooks('xm-hook-propagate-', {
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: UNSAFE }] }],
      Stop: stopHook('echo stop-ok'),
    });
    const env = { ...process.env, HOME: home };
    const install = spawnSync('node', [CLI, '--target', 'codex', '--global', '--yes', '--force',
      '--skills-dir', SKILLS, '--lib-dir', LIB], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    if (install.status !== 0) throw new Error(`stdout:\n${install.stdout}\nstderr:\n${install.stderr}`);

    const propagate = spawnSync('node', [CLI, '--propagate', '--skills-dir', SKILLS, '--lib-dir', LIB],
      { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
    expect(propagate.status).toBe(0);
    const codex = JSON.parse(propagate.stdout).results.find((row) => row.target === 'codex');
    expect(codex.notes).toHaveLength(1);
    expect(codex.notes[0]).toStartWith('codex: skipped a hook with shell metacharacters (not installed): PostToolUse:');
  }, 60_000);
});
