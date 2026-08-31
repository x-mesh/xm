import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Integration test for the overloaded `xm init` verb.
//
//   xm init                → global hook install (legacy meaning, unchanged)
//   xm init <reserved>     → global hook install (status/uninstall/flags)
//   xm init <name>         → create project <name> + register it
//   xm init . | --here     → create project named after the cwd
//   xm setup <...>         → canonical name for the global install
//
// The dangerous regression this guards is the crossover: a project name must
// never touch ~/.claude, and a reserved word must never create a project. HOME
// is sandboxed so a leaked global install is observable (and harmless).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const DISPATCHER = join(REPO, 'xm', 'scripts', 'xm');

let sandbox, home;

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function xm(args) {
  const r = spawnSync('bash', [DISPATCHER, ...args], {
    cwd: sandbox,
    env: { ...process.env, HOME: home, XM_LIB: REPO, XM_ROOT: join(sandbox, '.xm') },
    encoding: 'utf8',
    timeout: 30000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

const projectDir = (name) => join(sandbox, '.xm', 'build', 'projects', name);
const projectSlug = (name) => name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
const hookFile = () => join(home, '.claude', 'hooks', 'xm-trace-session.mjs');
const registryFile = () => join(home, '.xm', 'projects.json');

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'xm-init-'));
  home = join(sandbox, 'home');
  mkdirSync(home, { recursive: true });
  git(['init', '-q'], sandbox);
  git(['config', 'user.email', 't@t.co'], sandbox);
  git(['config', 'user.name', 't'], sandbox);
  git(['commit', '-q', '--allow-empty', '-m', 'seed'], sandbox);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('xm init — project route', () => {
  test('`xm init <name>` creates the project and does NOT install global hooks', () => {
    const r = xm(['init', 'aic']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Project "aic" initialized');
    expect(existsSync(join(projectDir('aic'), 'manifest.json'))).toBe(true);
    // The crossover guard: a project name must not trigger the machine install.
    expect(existsSync(hookFile())).toBe(false);
  });

  test('`xm init <name>` registers the project in the registry', () => {
    xm(['init', 'aic']);
    expect(existsSync(registryFile())).toBe(true);
    const reg = JSON.parse(readFileSync(registryFile(), 'utf8'));
    // The registry stores canonical paths; on macOS the sandbox lives under the
    // /var → /private/var symlink, so compare realpaths.
    expect(reg.projects.map((p) => p.path)).toContain(realpathSync(sandbox));
  });

  test('fails visibly when the project cannot be registered', () => {
    writeFileSync(join(home, '.xm'), 'blocked');
    const r = xm(['init', 'aic']);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(projectDir('aic'), 'manifest.json'))).toBe(true);
    expect(r.stderr).toContain('registry registration failed');
  });

  test('`xm init .` names the project after the current directory', () => {
    const r = xm(['init', '.']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(projectDir(projectSlug(basename(sandbox))), 'manifest.json'))).toBe(true);
  });

  test('`xm init --here` behaves like `xm init .`', () => {
    const r = xm(['init', '--here']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(projectDir(projectSlug(basename(sandbox))), 'manifest.json'))).toBe(true);
  });

  test('a duplicate name fails loudly instead of silently reusing', () => {
    xm(['init', 'aic']);
    const r = xm(['init', 'aic']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr + r.stdout).toContain('already exists');
  });
});

describe('xm init — global route (unchanged legacy meaning)', () => {
  test('`xm init` with no args installs hooks and points at the project form', () => {
    const r = xm(['init']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(hookFile())).toBe(true);
    expect(r.stdout).toContain('xm init <name>');
  });

  test('`xm init status` stays on the global route and creates no project', () => {
    const r = xm(['init', 'status']);
    // Not installed in a fresh sandbox → non-zero, but it must be the global
    // status report, not a project named "status".
    expect(r.stdout).toContain('overall');
    expect(existsSync(projectDir('status'))).toBe(false);
  });

  test('`xm init --help` stays on the global route', () => {
    const r = xm(['init', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('install global hooks');
  });
});

describe('xm setup — canonical global install', () => {
  test('`xm setup` installs the same hooks as legacy `xm init`', () => {
    const r = xm(['setup']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(hookFile())).toBe(true);
  });

  test('output is labelled with the verb the user typed', () => {
    const r = xm(['setup', 'status']);
    expect(r.stdout).toContain('[xm setup]');
    expect(r.stdout).not.toContain('[xm init]');
  });

  test('`xm setup uninstall` removes the hook', () => {
    xm(['setup']);
    expect(existsSync(hookFile())).toBe(true);
    const r = xm(['setup', 'uninstall']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(hookFile())).toBe(false);
  });

  test.each([['setup'], ['init']])('`xm %s --no-hooks` installs the dispatcher without hooks', (verb) => {
    const r = xm([verb, '--no-hooks']);
    expect(r.exitCode).toBe(0);
    expect(existsSync(hookFile())).toBe(false);
    expect(existsSync(join(home, '.claude', 'commands', 'xm.md'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'commands', 'xm-plan.md'))).toBe(true);
    expect(existsSync(join(home, '.local', 'bin', 'xm'))).toBe(true);
  });

  test('setup status and uninstall include the /xm-plan alias', () => {
    xm(['setup']);
    const status = xm(['setup', 'status']);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain('xm-plan alias');
    expect(status.stdout).toContain(join(home, '.claude', 'commands', 'xm-plan.md'));
    xm(['setup', 'uninstall']);
    expect(existsSync(join(home, '.claude', 'commands', 'xm-plan.md'))).toBe(false);
  });

  test('setup preserves and uninstall restores a user-owned xm-plan command', () => {
    const commands = join(home, '.claude', 'commands');
    mkdirSync(commands, { recursive: true });
    const alias = join(commands, 'xm-plan.md');
    writeFileSync(alias, 'my custom plan command\n');
    xm(['setup', '--no-hooks']);
    expect(readFileSync(alias, 'utf8')).toContain('xm-managed:xm-plan');
    expect(readFileSync(`${alias}.pre-xm`, 'utf8')).toBe('my custom plan command\n');
    xm(['setup', 'uninstall']);
    expect(readFileSync(alias, 'utf8')).toBe('my custom plan command\n');
    expect(existsSync(`${alias}.pre-xm`)).toBe(false);
  });

  test('setup rotates a stale backup and restores the latest user-owned command', () => {
    const commands = join(home, '.claude', 'commands');
    mkdirSync(commands, { recursive: true });
    const alias = join(commands, 'xm-plan.md');
    writeFileSync(alias, 'latest custom command\n');
    writeFileSync(`${alias}.pre-xm`, 'older custom command\n');
    xm(['setup', '--no-hooks']);
    expect(readFileSync(`${alias}.pre-xm`, 'utf8')).toBe('latest custom command\n');
    expect(readFileSync(`${alias}.pre-xm.1`, 'utf8')).toBe('older custom command\n');
    xm(['setup', 'uninstall']);
    expect(readFileSync(alias, 'utf8')).toBe('latest custom command\n');
  });

  test('uninstall does not resurrect a stale backup when the managed alias is absent', () => {
    const commands = join(home, '.claude', 'commands');
    mkdirSync(commands, { recursive: true });
    const alias = join(commands, 'xm-plan.md');
    writeFileSync(`${alias}.pre-xm`, 'stale custom command\n');
    xm(['setup', 'uninstall']);
    expect(existsSync(alias)).toBe(false);
    expect(readFileSync(`${alias}.pre-xm`, 'utf8')).toBe('stale custom command\n');
  });

  test('status rejects a user-owned xm-plan command as an installed alias', () => {
    xm(['setup']);
    const alias = join(home, '.claude', 'commands', 'xm-plan.md');
    writeFileSync(alias, 'my custom plan command\n');
    const status = xm(['setup', 'status']);
    expect(status.exitCode).not.toBe(0);
    expect(status.stdout).toContain('xm-plan alias    : (missing)');
  });
});
