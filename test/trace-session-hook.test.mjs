// @ts-check
//
// trace-session-hook — black-box tests for the standalone PreToolUse/PostToolUse
// trace hook (.claude/hooks/trace-session.mjs). The hook is run as a real
// subprocess (node <hook> pre|post) with a simulated Claude Code payload on
// stdin, so these tests exercise exactly what the harness runs.
//
// HOST POLLUTION IS FORBIDDEN. The hook resolves .xm/ (traces) and, on `pre`,
// auto-registers the project into ~/.xm/projects.json via os.homedir(). Every
// test therefore:
//   - creates its own dir(s) with mkdtempSync (under os.tmpdir(), never the repo)
//   - runs the hook subprocess with HOME pinned to a throwaway temp dir, so the
//     registry write + plugin-cache scan land in temp (or no-op), never the host
//   - points writes via XM_ROOT / CLAUDE_PROJECT_DIR at temp dirs
//   - rm -rf's every temp dir in afterAll
// No test may git-init, commit, or write inside the checked-out x-kit tree.

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK_PATH = fileURLToPath(new URL('../.claude/hooks/trace-session.mjs', import.meta.url));

/** @type {string[]} */
const tmpdirs = [];

function makeTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'xm-trace-hook-'));
  tmpdirs.push(dir);
  return dir;
}

/** Init a git repo in `dir` with one empty commit; returns HEAD sha. */
function gitInit(dir) {
  const git = (c) => execSync(`git ${c}`, { cwd: dir, stdio: 'pipe' });
  git('init -q');
  git('config user.email t@t.com');
  git('config user.name T');
  git('commit -q --allow-empty -m c1');
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

/**
 * Run the hook subprocess. `stdin` may be an object (JSON-encoded) or a raw
 * string (to simulate malformed input). HOME is pinned to a throwaway temp dir
 * so registry/cache side effects can never touch the host. Returns the spawn
 * result ({ status, stdout, stderr }).
 */
function runHook(phase, stdin, extraEnv = {}) {
  const isoHome = makeTmp();
  const env = {
    PATH: process.env.PATH,
    HOME: isoHome,
    ...extraEnv,
  };
  return spawnSync(process.execPath, [HOOK_PATH, phase], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
    env,
    encoding: 'utf8',
  });
}

/** Read + parse every JSONL entry from the single trace file in `tracesDir`. */
function readTrace(tracesDir) {
  const files = readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'));
  expect(files.length).toBe(1); // exactly one session recorded
  return readFileSync(join(tracesDir, files[0]), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

afterAll(() => {
  for (const dir of tmpdirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  tmpdirs.length = 0;
});

describe('trace-session hook — git snapshot on session boundaries', () => {
  test('session_start and session_end carry a git field in a repo (v:1 unchanged)', () => {
    const repo = makeTmp();
    const head = gitInit(repo);
    const xmRoot = join(repo, '.xm');
    const payload = { tool_input: { skill: 'xm:review', args: 'PR' }, cwd: repo };
    const env = { CLAUDE_PROJECT_DIR: repo, XM_ROOT: xmRoot };

    expect(runHook('pre', payload, env).status).toBe(0);
    expect(runHook('post', payload, env).status).toBe(0);

    const lines = readTrace(join(xmRoot, 'traces'));
    const start = lines.find((l) => l.type === 'session_start');
    const end = lines.find((l) => l.type === 'session_end');

    expect(start.git).toBeDefined();
    expect(start.git.head).toBe(head);
    expect(typeof start.git.branch).toBe('string');
    expect(start.git.dirty).toBe(false); // clean tree right after commit
    expect(start.v).toBe(1); // schema version unchanged

    expect(end.git).toBeDefined();
    expect(end.git.head).toBe(head);
    expect(end.v).toBe(1);
  });
});

describe('trace-session hook — session_end status', () => {
  test("status is 'unknown' (the hook cannot observe the skill outcome), never hardcoded 'success'", () => {
    const repo = makeTmp();
    gitInit(repo);
    const xmRoot = join(repo, '.xm');
    const payload = { tool_input: { skill: 'xm:solver' }, cwd: repo };
    const env = { CLAUDE_PROJECT_DIR: repo, XM_ROOT: xmRoot };

    expect(runHook('pre', payload, env).status).toBe(0);
    expect(runHook('post', payload, env).status).toBe(0);

    const end = readTrace(join(xmRoot, 'traces')).find((l) => l.type === 'session_end');
    expect(end.status).toBe('unknown');
    expect(end.status).not.toBe('success');
  });
});

describe('trace-session hook — worktree resolution', () => {
  test('a worktree without its own .xm records into the main checkout .xm (git-common-dir)', () => {
    const main = makeTmp();
    gitInit(main);
    mkdirSync(join(main, '.xm'), { recursive: true }); // main has been used → .xm exists

    // Linked worktree at a path that does not exist yet (git creates it).
    const wtParent = makeTmp();
    const worktree = join(wtParent, 'wt');
    execSync(`git worktree add -q ${worktree} -b feat`, { cwd: main, stdio: 'pipe' });

    // Skill invoked *inside the worktree* — no XM_ROOT, so resolution must fall
    // back to the shared git dir and land in main/.xm, matching the CLI writer.
    const payload = { tool_input: { skill: 'xm:review' }, cwd: worktree };
    const env = { CLAUDE_PROJECT_DIR: worktree };

    expect(runHook('pre', payload, env).status).toBe(0);
    expect(runHook('post', payload, env).status).toBe(0);

    // Recorded in main, not in the worktree.
    expect(existsSync(join(main, '.xm', 'traces'))).toBe(true);
    expect(existsSync(join(worktree, '.xm'))).toBe(false);

    const lines = readTrace(join(main, '.xm', 'traces'));
    expect(lines.find((l) => l.type === 'session_start')).toBeDefined();
    expect(lines.find((l) => l.type === 'session_end')).toBeDefined();
    // git snapshot reflects the worktree branch, proving base = invocation dir.
    expect(lines.find((l) => l.type === 'session_start').git.branch).toBe('feat');

    // Clean up the worktree registration so afterAll's rm doesn't leave a dangling ref.
    try { execSync(`git worktree remove --force ${worktree}`, { cwd: main, stdio: 'pipe' }); } catch { /* best-effort */ }
  });
});

describe('trace-session hook — XM_ROOT precedence', () => {
  test('XM_ROOT wins over a local .xm in the invocation dir', () => {
    const repo = makeTmp();
    gitInit(repo);
    mkdirSync(join(repo, '.xm'), { recursive: true }); // a local .xm that must be ignored

    const override = makeTmp();
    const xmRoot = join(override, '.xm');
    const payload = { tool_input: { skill: 'xm:op' }, cwd: repo };
    const env = { CLAUDE_PROJECT_DIR: repo, XM_ROOT: xmRoot };

    expect(runHook('pre', payload, env).status).toBe(0);
    expect(runHook('post', payload, env).status).toBe(0);

    // Written under XM_ROOT, not the repo's local .xm.
    expect(existsSync(join(xmRoot, 'traces'))).toBe(true);
    expect(existsSync(join(repo, '.xm', 'traces'))).toBe(false);
    expect(readTrace(join(xmRoot, 'traces')).find((l) => l.type === 'session_end')).toBeDefined();
  });
});

describe('trace-session hook — abnormal input is silent and side-effect-free', () => {
  test('malformed stdin → exit 0, no output, no .xm created', () => {
    const base = makeTmp();
    const env = { CLAUDE_PROJECT_DIR: base };
    const res = runHook('pre', 'not json {{{ broken', env);

    expect(res.status).toBe(0);        // never blocks the skill
    expect(res.stdout).toBe('');       // no chatter into the session
    expect(res.stderr).toBe('');       // silent by default (no XM_TRACE_DEBUG)
    expect(existsSync(join(base, '.xm'))).toBe(false); // no write on bad input
  });

  test('valid JSON but a non-xm skill → exit 0, no .xm created', () => {
    const base = makeTmp();
    const env = { CLAUDE_PROJECT_DIR: base };
    const res = runHook('pre', { tool_input: { skill: 'other:thing' }, cwd: base }, env);

    expect(res.status).toBe(0);
    expect(existsSync(join(base, '.xm'))).toBe(false);
  });
});
