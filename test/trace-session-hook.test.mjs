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
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync, spawn, spawnSync } from 'node:child_process';
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

function runHookAsync(phase, stdin, extraEnv = {}, hookPath = HOOK_PATH) {
  const isoHome = makeTmp();
  const env = {
    PATH: process.env.PATH,
    HOME: isoHome,
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath, phase], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

async function waitForFile(file) {
  const deadline = Date.now() + 3000;
  while (!existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(existsSync(file)).toBe(true);
}

function startClaimOwner(claimFile, holdMs = 100) {
  const script = [
    "const fs = require('node:fs')",
    "const [file, hold] = process.argv.slice(1)",
    "fs.writeFileSync(file, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }))",
    "process.stdout.write('ready\\n')",
    "setTimeout(() => process.exit(0), Number(hold))",
  ].join(';');
  const child = spawn(process.execPath, ['-e', script, claimFile, String(holdMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', resolve);
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { child, ready, exited };
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
    expect(runHook('stop', payload, env).status).toBe(0); // session_end is written at Stop, not PostToolUse

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
    expect(runHook('stop', payload, env).status).toBe(0); // session_end is written at Stop, not PostToolUse

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
    expect(runHook('stop', payload, env).status).toBe(0); // session_end is written at Stop, not PostToolUse

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
    expect(runHook('stop', payload, env).status).toBe(0); // session_end is written at Stop, not PostToolUse

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

describe('trace-session hook — Agent tool spans inside an xm session', () => {
  const skillPayload = (repo, toolUseId = 'toolu_skill') => ({ tool_name: 'Skill', tool_use_id: toolUseId, tool_input: { skill: 'xm:solver' }, cwd: repo });
  const agentPayload = (repo, toolUseId, extra = {}) => ({
    tool_name: 'Agent',
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    tool_input: { description: 'Scan tests', prompt: 'p', subagent_type: 'Explore', model: 'haiku', ...(extra.input || {}) },
    ...(extra.response !== undefined ? { tool_response: extra.response } : {}),
    cwd: repo,
  });
  const stopPayload = (repo) => ({ hook_event_name: 'Stop', cwd: repo });
  const openSession = (toolUseId) => {
    const repo = makeTmp();
    const xmRoot = join(repo, '.xm');
    const env = { CLAUDE_PROJECT_DIR: repo, XM_ROOT: xmRoot };
    expect(runHook('pre', skillPayload(repo, toolUseId), env).status).toBe(0);
    return { repo, xmRoot, env, tracesDir: join(xmRoot, 'traces') };
  };
  const readAll = (tracesDir) => Object.fromEntries(readdirSync(tracesDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => [f, readFileSync(join(tracesDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l))]));

  test('the session stays open past PostToolUse(Skill) and closes at Stop, so an Agent call made after the skill loaded is recorded', () => {
    const { repo, env, tracesDir } = openSession();
    // The Skill tool returns as soon as its instructions are loaded — before any Agent call.
    expect(runHook('post', skillPayload(repo), env).status).toBe(0);
    expect(existsSync(join(tracesDir, '.active'))).toBe(true);

    expect(runHook('pre', agentPayload(repo, 'toolu_01'), env).status).toBe(0);
    expect(existsSync(join(tracesDir, '.agents', 'toolu_01.json'))).toBe(true);
    expect(runHook('post', agentPayload(repo, 'toolu_01', { response: { result: 'done' } }), env).status).toBe(0);
    expect(runHook('stop', stopPayload(repo), env).status).toBe(0);

    const rows = readTrace(tracesDir);
    const steps = rows.filter((l) => l.type === 'agent_step');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ id: 'toolu_01', role: 'Explore', model: 'haiku', status: 'success', source: 'hook', description: 'Scan tests', v: 1 });
    expect(typeof steps[0].duration_ms).toBe('number');
    expect(steps[0].duration_ms).toBeGreaterThanOrEqual(0);
    const end = rows.find((l) => l.type === 'session_end');
    expect(end.agent_count).toBe(1);
    expect(end.close_reason).toBeUndefined();
    expect(existsSync(join(tracesDir, '.active'))).toBe(false);
    expect(existsSync(join(tracesDir, '.agents', 'toolu_01.json'))).toBe(false);
  });

  test('status follows the tool response: error marker → error, background dispatch → launched, no response → unknown', () => {
    const { repo, env, tracesDir } = openSession();
    for (const [id, extra] of [
      ['toolu_err', { response: { is_error: true, content: 'boom' } }],
      ['toolu_bg', { input: { run_in_background: true }, response: { agentId: 'x' } }],
      ['toolu_silent', {}],
    ]) {
      expect(runHook('pre', agentPayload(repo, id, extra), env).status).toBe(0);
      expect(runHook('post', agentPayload(repo, id, extra), env).status).toBe(0);
    }
    expect(runHook('stop', stopPayload(repo), env).status).toBe(0);

    const steps = readTrace(tracesDir).filter((l) => l.type === 'agent_step');
    expect(Object.fromEntries(steps.map((s) => [s.id, s.status]))).toEqual({ toolu_err: 'error', toolu_bg: 'launched', toolu_silent: 'unknown' });
    expect(steps.every((s) => typeof s.duration_ms === 'number')).toBe(true);
  });

  test('interleaved parallel agents → each agent_step keeps its own id and a measured duration', () => {
    const { repo, env, tracesDir } = openSession();
    expect(runHook('pre', agentPayload(repo, 'toolu_a'), env).status).toBe(0);
    expect(runHook('pre', agentPayload(repo, 'toolu_b'), env).status).toBe(0);
    expect(runHook('post', agentPayload(repo, 'toolu_b', { response: { ok: true } }), env).status).toBe(0);
    expect(runHook('post', agentPayload(repo, 'toolu_a', { response: { ok: true } }), env).status).toBe(0);
    expect(runHook('stop', stopPayload(repo), env).status).toBe(0);

    const steps = readTrace(tracesDir).filter((l) => l.type === 'agent_step');
    expect(steps.map((s) => s.id).sort()).toEqual(['toolu_a', 'toolu_b']);
    for (const step of steps) {
      expect(typeof step.duration_ms).toBe('number');
      expect(step.status).toBe('success');
    }
  });

  test('an agent still running when the turn ends is written as abandoned and counted; its late post adds no second row', () => {
    const { repo, env, tracesDir } = openSession('toolu_skill_a');
    expect(runHook('pre', agentPayload(repo, 'toolu_lost'), env).status).toBe(0);
    expect(runHook('stop', stopPayload(repo), env).status).toBe(0);

    let rows = readTrace(tracesDir);
    const abandoned = rows.filter((l) => l.type === 'agent_step');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({ id: 'toolu_lost', role: 'Explore', model: 'haiku', status: 'abandoned', description: 'Scan tests' });
    expect(rows.find((l) => l.type === 'session_end').agent_count).toBe(1);
    expect(existsSync(join(tracesDir, '.agents', 'toolu_lost.abandoned'))).toBe(true);

    // A new skill session opens in the next turn, then the lost agent's post finally arrives.
    expect(runHook('pre', skillPayload(repo, 'toolu_skill_b'), env).status).toBe(0);
    expect(runHook('post', agentPayload(repo, 'toolu_lost', { response: { ok: true } }), env).status).toBe(0);
    const all = readAll(tracesDir);
    expect(Object.keys(all)).toHaveLength(2);
    const totalSteps = Object.values(all).flat().filter((l) => l.type === 'agent_step');
    expect(totalSteps).toHaveLength(1); // the abandoned row only — nothing attached to the new session
  });

  test('post without its pre → recorded untimed as unknown, exit 0', () => {
    const { repo, env, tracesDir } = openSession();
    const res = runHook('post', agentPayload(repo, 'toolu_orphan'), env);
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
    expect(runHook('stop', stopPayload(repo), env).status).toBe(0);

    const step = readTrace(tracesDir).find((l) => l.type === 'agent_step');
    expect(step).toMatchObject({ id: 'toolu_orphan', duration_ms: null, status: 'unknown' });
  });

  test('missing tool_use_id → pre writes no marker, post records an untimed step with a generated id', () => {
    const { repo, env, tracesDir } = openSession();
    expect(runHook('pre', agentPayload(repo, null), env).status).toBe(0);
    expect(existsSync(join(tracesDir, '.agents'))).toBe(false);
    expect(runHook('post', agentPayload(repo, null, { response: { ok: true } }), env).status).toBe(0);
    expect(runHook('stop', stopPayload(repo), env).status).toBe(0);

    const step = readTrace(tracesDir).find((l) => l.type === 'agent_step');
    expect(step.id).toMatch(/^agent-[0-9a-f]{6}$/);
    expect(step.duration_ms).toBeNull();
    expect(step.status).toBe('success');
  });

  test('a session left open by a turn that never reached Stop is closed as superseded when the next skill starts', () => {
    const { repo, env, tracesDir } = openSession('toolu_skill_a');
    expect(runHook('pre', skillPayload(repo, 'toolu_skill_b'), env).status).toBe(0);

    const all = readAll(tracesDir);
    const files = Object.keys(all);
    expect(files).toHaveLength(2);
    const ends = Object.values(all).flat().filter((l) => l.type === 'session_end');
    expect(ends).toHaveLength(1);
    expect(ends[0].close_reason).toBe('superseded');
    expect(existsSync(join(tracesDir, '.active'))).toBe(true); // the new session is the open one
  });

  test('outside an xm session → exit 0, silent, no .xm created', () => {
    const base = makeTmp();
    const env = { CLAUDE_PROJECT_DIR: base };
    for (const phase of ['pre', 'post']) {
      const res = runHook(phase, agentPayload(base, 'toolu_x'), env);
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('');
      expect(res.stderr).toBe('');
    }
    const stop = runHook('stop', stopPayload(base), env);
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe('');
    expect(existsSync(join(base, '.xm'))).toBe(false);
  });
});

describe('trace-session hook — the same hook wired twice (project + global settings)', () => {
  test('a second pre for one Skill tool_use_id opens no second session; two stops write one session_end', () => {
    const repo = makeTmp();
    const xmRoot = join(repo, '.xm');
    const env = { CLAUDE_PROJECT_DIR: repo, XM_ROOT: xmRoot };
    const payload = { tool_name: 'Skill', tool_use_id: 'toolu_skill_1', tool_input: { skill: 'xm:solver' }, cwd: repo };

    expect(runHook('pre', payload, env).status).toBe(0);
    expect(runHook('pre', payload, env).status).toBe(0);
    expect(runHook('stop', { cwd: repo }, env).status).toBe(0);
    expect(runHook('stop', { cwd: repo }, env).status).toBe(0);

    const rows = readTrace(join(xmRoot, 'traces')); // exactly one session file
    expect(rows.filter((l) => l.type === 'session_start')).toHaveLength(1);
    expect(rows.filter((l) => l.type === 'session_end')).toHaveLength(1);
    expect(existsSync(join(xmRoot, 'traces', '.active'))).toBe(false);
  });

  test('a second pre/post for one Agent tool_use_id records one agent_step', () => {
    const repo = makeTmp();
    const xmRoot = join(repo, '.xm');
    const env = { CLAUDE_PROJECT_DIR: repo, XM_ROOT: xmRoot };
    const skill = { tool_name: 'Skill', tool_use_id: 'toolu_skill_2', tool_input: { skill: 'xm:solver' }, cwd: repo };
    const agent = { tool_name: 'Agent', tool_use_id: 'toolu_agent_2', tool_input: { subagent_type: 'Explore' }, tool_response: { ok: true }, cwd: repo };

    expect(runHook('pre', skill, env).status).toBe(0);
    expect(runHook('pre', agent, env).status).toBe(0);
    expect(runHook('pre', agent, env).status).toBe(0);
    expect(runHook('post', agent, env).status).toBe(0);
    expect(runHook('post', agent, env).status).toBe(0);
    expect(runHook('stop', { cwd: repo }, env).status).toBe(0);

    const rows = readTrace(join(xmRoot, 'traces'));
    const steps = rows.filter((l) => l.type === 'agent_step');
    expect(steps).toHaveLength(1);
    expect(steps[0].status).toBe('success');
    expect(rows.find((l) => l.type === 'session_end').agent_count).toBe(1);
  });

  test('a bare-id .active written by an older hook is still closed at Stop', () => {
    const repo = makeTmp();
    const xmRoot = join(repo, '.xm');
    const env = { CLAUDE_PROJECT_DIR: repo, XM_ROOT: xmRoot };
    const traces = join(xmRoot, 'traces');
    mkdirSync(traces, { recursive: true });
    const legacyId = 'solver-20260101-000000-abcd';
    writeFileSync(join(traces, `${legacyId}.jsonl`), JSON.stringify({ type: 'session_start', session_id: legacyId, ts: new Date().toISOString(), v: 1, skill: 'solver' }) + '\n');
    writeFileSync(join(traces, '.active'), legacyId);

    expect(runHook('stop', { cwd: repo }, env).status).toBe(0);
    const rows = readTrace(traces);
    expect(rows.find((l) => l.type === 'session_end')).toBeDefined();
    expect(existsSync(join(traces, '.active'))).toBe(false);
  });
});

describe('trace-session hook — stale sessions, dead claims, and dispatch detection', () => {
  const skill = (repo, toolUseId, sessionId = 'conv-a') => ({ tool_name: 'Skill', tool_use_id: toolUseId, session_id: sessionId, tool_input: { skill: 'xm:solver' }, cwd: repo });
  const agent = (repo, toolUseId, extra = {}) => ({
    tool_name: 'Agent', tool_use_id: toolUseId, session_id: extra.session_id || 'conv-a',
    tool_input: { subagent_type: 'Explore', model: 'haiku', ...(extra.input || {}) },
    ...(extra.response !== undefined ? { tool_response: extra.response } : {}),
    cwd: repo,
  });
  const fresh = () => {
    const repo = makeTmp();
    const xmRoot = join(repo, '.xm');
    return { repo, xmRoot, env: { CLAUDE_PROJECT_DIR: repo, XM_ROOT: xmRoot }, tracesDir: join(xmRoot, 'traces') };
  };
  const rowsOf = (tracesDir) => readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readFileSync(join(tracesDir, f), 'utf8').trim().split('\n').map((l) => JSON.parse(l)));

  test('a background dispatch is launched even without the request flag, and an error response wins over launched', () => {
    const { repo, env, tracesDir } = fresh();
    expect(runHook('pre', skill(repo, 'toolu_s'), env).status).toBe(0);
    for (const [id, extra] of [
      ['toolu_ack', { response: { agentId: 'a0e7dc39', status: 'running' } }],          // flag omitted, acknowledgement shape
      ['toolu_bgerr', { input: { run_in_background: true }, response: { is_error: true, content: 'spawn failed' } }],
      ['toolu_done', { response: { result: 'summary text' } }],
    ]) {
      expect(runHook('pre', agent(repo, id, extra), env).status).toBe(0);
      expect(runHook('post', agent(repo, id, extra), env).status).toBe(0);
    }
    expect(runHook('stop', { cwd: repo }, env).status).toBe(0);
    const steps = rowsOf(tracesDir).filter((l) => l.type === 'agent_step');
    expect(Object.fromEntries(steps.map((s) => [s.id, s.status]))).toEqual({ toolu_ack: 'launched', toolu_bgerr: 'error', toolu_done: 'success' });
  });

  test('a session older than the age bound is closed as stale instead of collecting the next agents', () => {
    const { repo, env, tracesDir } = fresh();
    expect(runHook('pre', skill(repo, 'toolu_old'), env).status).toBe(0);
    const activeFile = join(tracesDir, '.active');
    const active = JSON.parse(readFileSync(activeFile, 'utf8'));
    active.opened_at = new Date(Date.now() - 7 * 3600_000).toISOString();
    writeFileSync(activeFile, JSON.stringify(active));

    expect(runHook('pre', agent(repo, 'toolu_late'), env).status).toBe(0);
    expect(existsSync(activeFile)).toBe(false);
    expect(existsSync(join(tracesDir, '.agents', 'toolu_late.json'))).toBe(false);
    const end = rowsOf(tracesDir).find((l) => l.type === 'session_end');
    expect(end.close_reason).toBe('stale');
  });

  test('a session opened in another Claude conversation is closed as stale by the next hook', () => {
    const { repo, env, tracesDir } = fresh();
    expect(runHook('pre', skill(repo, 'toolu_a', 'conv-a'), env).status).toBe(0);
    expect(runHook('post', agent(repo, 'toolu_x', { session_id: 'conv-b', response: { ok: true } }), env).status).toBe(0);
    expect(existsSync(join(tracesDir, '.active'))).toBe(false);
    const rows = rowsOf(tracesDir);
    expect(rows.find((l) => l.type === 'session_end').close_reason).toBe('stale');
    expect(rows.filter((l) => l.type === 'agent_step')).toHaveLength(0);
  });

  test('a claim left by a hook that died mid-open is taken over after the grace period; a fresh claim is not', () => {
    const { repo, env, tracesDir } = fresh();
    const claimsDir = join(tracesDir, '.claims');
    mkdirSync(claimsDir, { recursive: true });
    const stale = join(claimsDir, 'toolu_dead.skill');
    writeFileSync(stale, 'x');
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    utimesSync(stale, tenSecondsAgo, tenSecondsAgo);
    expect(runHook('pre', skill(repo, 'toolu_dead'), env).status).toBe(0);
    expect(readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1); // session opened despite the dead claim
    expect(runHook('stop', { cwd: repo }, env).status).toBe(0);

    writeFileSync(join(claimsDir, 'toolu_busy.skill'), 'x'); // another registration is opening right now
    expect(runHook('pre', skill(repo, 'toolu_busy'), env).status).toBe(0);
    expect(readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1); // no second session
  });

  test('one duplicate hook takes over when the live claim owner exits before opening a session', async () => {
    const { repo, env, tracesDir } = fresh();
    const claimsDir = join(tracesDir, '.claims');
    mkdirSync(claimsDir, { recursive: true });
    const claimFile = join(claimsDir, 'toolu_failed.skill');
    const owner = startClaimOwner(claimFile);
    await owner.ready;

    const pending = [
      runHookAsync('pre', skill(repo, 'toolu_failed'), env),
      runHookAsync('pre', skill(repo, 'toolu_failed'), env),
    ];
    await owner.exited;

    expect((await Promise.all(pending)).map((result) => result.status)).toEqual([0, 0]);
    expect(readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(tracesDir, '.active'), 'utf8')).tool_use_id).toBe('toolu_failed');
  });

  test('a live owner without session evidence delays a duplicate hook for less than one second', async () => {
    const { repo, env, tracesDir } = fresh();
    const claimsDir = join(tracesDir, '.claims');
    mkdirSync(claimsDir, { recursive: true });
    const owner = startClaimOwner(join(claimsDir, 'toolu_live.skill'), 1000);
    await owner.ready;

    const startedAt = Date.now();
    expect(runHook('pre', skill(repo, 'toolu_live'), env).status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
    owner.child.kill();
    await owner.exited;
  });

  test('an old claim is recovered even when its PID now belongs to a live process', () => {
    const { repo, env, tracesDir } = fresh();
    const claimsDir = join(tracesDir, '.claims');
    mkdirSync(claimsDir, { recursive: true });
    const claimFile = join(claimsDir, 'toolu_reused.skill');
    writeFileSync(claimFile, JSON.stringify({ pid: process.pid, created_at: new Date(Date.now() - 10_000).toISOString() }));
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    utimesSync(claimFile, tenSecondsAgo, tenSecondsAgo);

    expect(runHook('pre', skill(repo, 'toolu_reused'), env).status).toBe(0);
    expect(readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(tracesDir, '.active'), 'utf8')).tool_use_id).toBe('toolu_reused');
  });

  test('a delayed recovery cannot steal the replacement claim before its session is published', async () => {
    const { repo, env, tracesDir } = fresh();
    const claimsDir = join(tracesDir, '.claims');
    mkdirSync(claimsDir, { recursive: true });
    const claimFile = join(claimsDir, 'toolu_race.skill');
    writeFileSync(claimFile, 'x');
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(claimFile, oldTime, oldTime);

    const recoveryPoint = 'function replaceAbandonedClaim(claimFile, activeFile, toolUseId) {';
    const publicationPoint = '  try {\n    // A session left open';
    const source = readFileSync(HOOK_PATH, 'utf8');
    expect(source).toContain(recoveryPoint);
    expect(source).toContain(publicationPoint);
    const controlledHook = join(repo, 'controlled-hook.mjs');
    writeFileSync(controlledHook, source
      .replace(recoveryPoint, `${recoveryPoint}\n  pauseAtTestGate('recovery');`)
      .replace(publicationPoint, "  try {\n    pauseAtTestGate('publication');\n    // A session left open")
      .replace('\nmain();', `
function pauseAtTestGate(point) {
  if (process.env.TEST_GATE !== point) return;
  fs.writeFileSync(process.env.TEST_READY, 'ready');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(process.env.TEST_RELEASE)) {
    if (Date.now() >= deadline) throw new Error('test gate timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
main();`));
    const recoveryReady = join(repo, 'recovery-ready');
    const recoveryRelease = join(repo, 'recovery-release');
    const publicationReady = join(repo, 'publication-ready');
    const publicationRelease = join(repo, 'publication-release');
    const delayed = runHookAsync('pre', skill(repo, 'toolu_race'), {
      ...env, TEST_GATE: 'recovery', TEST_READY: recoveryReady, TEST_RELEASE: recoveryRelease,
    }, controlledHook);
    let replacement;
    try {
      await waitForFile(recoveryReady);
      replacement = runHookAsync('pre', skill(repo, 'toolu_race'), {
        ...env, TEST_GATE: 'publication', TEST_READY: publicationReady, TEST_RELEASE: publicationRelease,
      }, controlledHook);
      await waitForFile(publicationReady);
      const replacementClaim = readFileSync(claimFile, 'utf8');
      writeFileSync(recoveryRelease, 'release');
      expect((await delayed).status).toBe(0);
      expect(readFileSync(claimFile, 'utf8')).toBe(replacementClaim);
      expect(existsSync(join(tracesDir, '.active'))).toBe(false);
    } finally {
      writeFileSync(recoveryRelease, 'release');
      writeFileSync(publicationRelease, 'release');
      await delayed;
      if (replacement) await replacement;
    }
    expect(readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
  });

  test('recovery respects a live recovery lock and reclaims it after its owner exits', async () => {
    const { repo, env, tracesDir } = fresh();
    const claimsDir = join(tracesDir, '.claims');
    mkdirSync(claimsDir, { recursive: true });
    const claimFile = join(claimsDir, 'toolu_locked.skill');
    writeFileSync(claimFile, 'x');
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(claimFile, oldTime, oldTime);
    const recoveryDir = `${claimFile}.recovering`;
    mkdirSync(recoveryDir);
    const owner = startClaimOwner(join(recoveryDir, 'original-owner.json'), 5000);
    try {
      await owner.ready;
      expect(runHook('pre', skill(repo, 'toolu_locked'), env).status).toBe(0);
      expect(readFileSync(claimFile, 'utf8')).toBe('x');
      expect(readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(0);
    } finally {
      owner.child.kill();
      await owner.exited;
    }
    expect(runHook('pre', skill(repo, 'toolu_locked'), env).status).toBe(0);
    expect(readdirSync(tracesDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
    expect(existsSync(recoveryDir)).toBe(false);
    expect(readdirSync(claimsDir)).toEqual(['toolu_locked.skill']);
  });
});
