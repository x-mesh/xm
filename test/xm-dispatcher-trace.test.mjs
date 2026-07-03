import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Integration test for the `xm` bash dispatcher's t4 changes:
//   1. `xm trace`/`last`/`status` routing to x-trace-cli.mjs
//   2. best-effort terminal instrumentation (dispatcher activity ledger)
//   3. exit-code fidelity — instrumentation must never alter the real exit code
//
// The dispatcher is spawned via `bash <script> <arg...>`. spawnSync passes the
// args as a real argv array, so token parsing matches Claude Code / a real shell
// (unlike an unquoted `$var` in zsh, which does NOT word-split — a footgun when
// eyeballing this manually, not a dispatcher bug).

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const DISPATCHER = join(REPO, 'xm', 'scripts', 'xm');

let sandbox, xmRoot, home;

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

/** Run `xm <args...>` against the sandbox. `xmRootOverride` lets a test point the
 *  ledger at an unwritable path to exercise the instrumentation-failure path. */
function xm(args, { xmRootOverride } = {}) {
  const r = spawnSync('bash', [DISPATCHER, ...args], {
    cwd: sandbox,
    env: {
      ...process.env,
      HOME: home,
      XM_LIB: REPO,
      XM_ROOT: xmRootOverride ?? xmRoot,
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 };
}

/** The recorded `dispatcher` entry in last.json, or null when nothing was recorded. */
function dispatcherEntry() {
  const p = join(xmRoot, 'last.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j?.tools?.dispatcher ?? null;
  } catch {
    return null;
  }
}

function resetLedger() {
  const p = join(xmRoot, 'last.json');
  if (existsSync(p)) rmSync(p, { force: true });
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'xm-disp-'));
  xmRoot = join(sandbox, '.xm');
  home = join(sandbox, 'home');
  mkdirSync(xmRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  git(['init', '-q'], sandbox);
  git(['config', 'user.email', 't@t.co'], sandbox);
  git(['config', 'user.name', 't'], sandbox);
  git(['commit', '-q', '--allow-empty', '-m', 'seed'], sandbox);
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('xm dispatcher — trace routing', () => {
  test('`xm last` routes to x-trace-cli last', () => {
    const r = xm(['last']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No tool activity recorded yet');
  });

  test('`xm status --json` routes to x-trace-cli status', () => {
    const r = xm(['status', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
  });

  test('`xm trace last` routes to x-trace-cli', () => {
    const r = xm(['trace', 'last']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No tool activity recorded yet');
  });
});

describe('xm dispatcher — terminal instrumentation', () => {
  test('a mutating command records a dispatcher entry', () => {
    resetLedger();
    const r = xm(['config', 'set', '--local', 'trace_test_key', 'v']);
    expect(r.exitCode).toBe(0);
    const e = dispatcherEntry();
    expect(e).not.toBeNull();
    expect(e.note).toBe('config set');
    expect(e.status).toBe('ok');
  });

  test('a read command ($1 verb) records nothing', () => {
    resetLedger();
    xm(['config', 'get', 'model_profile']);
    expect(dispatcherEntry()).toBeNull();
  });

  test('a read command ($2 verb, e.g. `build tasks list`) records nothing', () => {
    resetLedger();
    xm(['build', 'tasks', 'list']);
    expect(dispatcherEntry()).toBeNull();
  });

  test('meta/read-only top-level commands record nothing', () => {
    for (const args of [['version'], ['which'], ['help'], ['last'], ['status'], ['trace', 'last']]) {
      resetLedger();
      xm(args);
      expect(dispatcherEntry()).toBeNull();
    }
  });
});

describe('xm dispatcher — exit-code fidelity', () => {
  test('successful command exits 0 with instrumentation active', () => {
    const r = xm(['score', '--parts', 'goal=0.9', '--weights', 'goal=1.0']);
    expect(r.exitCode).toBe(0);
  });

  test('unknown command preserves its exit 1', () => {
    const r = xm(['__no_such_command__']);
    expect(r.exitCode).toBe(1);
  });

  test('a failing subcommand preserves its non-zero exit code', () => {
    const r = xm(['solver', '__definitely_bad_subcommand__']);
    expect(r.exitCode).not.toBe(0);
  });

  test('instrumentation write failure does NOT alter a successful exit code', () => {
    // Point the ledger at an unwritable directory so `xm trace record` fails.
    const roParent = join(sandbox, 'ro');
    mkdirSync(roParent, { recursive: true });
    chmodSync(roParent, 0o000);
    try {
      const r = xm(['score', '--parts', 'goal=0.9', '--weights', 'goal=1.0'], {
        xmRootOverride: join(roParent, '.xm'),
      });
      expect(r.exitCode).toBe(0);
    } finally {
      chmodSync(roParent, 0o755);
    }
  });
});
