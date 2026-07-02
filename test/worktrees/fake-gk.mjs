#!/usr/bin/env node
/**
 * fake-gk — deterministic stub for `gk worktree finish` agent-mode envelopes.
 *
 * Purpose: exercise the gk-state -> xm-state mapping (worktrees.mjs) and the
 * finish queue WITHOUT a real git-kit. It prints one agent-mode envelope JSON
 * to stdout and exits with the state's exit code:
 *     ok -> 0, blocked -> 1, paused -> 3, error -> 2
 *
 * Scenario selection (first wins):
 *   1. CLI arg:  node fake-gk.mjs <scenario>
 *   2. env:      FAKE_GK_SCENARIO=<scenario> node fake-gk.mjs
 *
 * Both the executable path (subprocess, used by the finish-queue task) and the
 * exported factories (imported by unit tests) share GK_SCENARIOS, so there is
 * one source of truth for every envelope shape.
 *
 * finish-queue (t7) extras:
 *   FAKE_GK_FINISH_SCENARIOS  JSON map taskId -> scenario | scenario[]. An array
 *                             is indexed by per-task call count (locked→retry).
 *   FAKE_GK_COUNTER_DIR       dir for per-task call counters (array scenarios).
 *   FAKE_GK_LOG               append {task,start,end,pid,scenario} per finish so
 *                             a test can assert serial (non-overlapping) order.
 *   FAKE_GK_SYNC_SCENARIO     scenario for `gk sync` (resume base drift).
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN_ID = '20260702-120102-123';

// Each entry returns a fully-formed agent-mode envelope: {state, ok, result, error}.
export const GK_SCENARIOS = {
  ok: () => ({
    state: 'ok',
    ok: true,
    result: {
      gate: { phase: 'before', before: 'passed', after: 'skipped', merged: true, run_id: RUN_ID },
    },
    error: null,
  }),

  // before gate panel-verdict fail (gate exit 1) -> NEEDS_FIX
  // Faithful to measured gk v0.106.0: no result.gate on before-gate failure,
  // exit code lives in error.message text only.
  before_failed: () => ({
    state: 'blocked',
    ok: false,
    result: null,
    error: {
      code: 'worktree_gate_before_failed',
      message: 'worktree finish: gate failed before merge (exit 1)',
      hint: 'the gate rejected the patch; nothing merged (target unchanged)',
      remedies: [
        { command: 'xm build gate-panel --project <p> --task <t> --phase before --patch <patch> --json', safety: 'safe' },
      ],
    },
  }),

  // before gate wrapper/runtime error (gate exit 2) -> BLOCKED
  // Faithful to measured gk v0.106.0 output: result.gate is null on a
  // before-gate failure and the exit code only appears in error.message.
  before_error: () => ({
    state: 'blocked',
    ok: false,
    result: null,
    error: {
      code: 'worktree_gate_before_failed',
      message: 'worktree finish: gate failed before merge (exit 2)',
      hint: 'the gate rejected the patch; nothing merged (target unchanged)',
      remedies: [{ command: 'xm panel doctor --json', safety: 'safe' }],
    },
  }),

  dirty: () => ({
    state: 'blocked',
    ok: false,
    result: null,
    error: {
      code: 'worktree_gate_dirty',
      message: 'uncommitted changes in worktree',
      remedies: [{ command: 'git -C <path> status', safety: 'safe' }],
    },
  }),

  locked: () => ({
    state: 'blocked',
    ok: false,
    result: null,
    error: {
      code: 'worktree_gate_locked',
      message: 'target merge lock held',
      remedies: [{ command: 'GK_AGENT=1 git-kit worktree finish --to <base> ...', safety: 'safe' }],
    },
  }),

  no_target: () => ({
    state: 'blocked',
    ok: false,
    result: null,
    error: {
      code: 'worktree_gate_no_target',
      message: 'could not resolve parent/base',
      remedies: [{ command: 'GK_AGENT=1 git-kit worktree finish --to develop ...', safety: 'safe' }],
    },
  }),

  // after gate fail: merge kept, cleanup withheld, recover[] provided (exit 3)
  after_paused: () => ({
    state: 'paused',
    ok: false,
    result: {
      gate: {
        phase: 'after',
        before: 'passed',
        after: 'failed',
        paused: true,
        merged: true,
        patch: '/tmp/gk-gate-after.patch',
        run_id: RUN_ID,
        recover: [
          { command: 'GK_AGENT=1 git-kit worktree finish --to <base> --resume-accept --cleanup', safety: 'safe' },
          { command: 'git -C <path> reset --hard <before>', safety: 'destructive' },
        ],
      },
    },
    error: null,
  }),

  // gk merge/promote conflict pause: resume/abort remedies (exit 3)
  merge_conflict: () => ({
    state: 'paused',
    ok: false,
    result: {
      conflict: true,
      remedies: [
        { command: 'GK_AGENT=1 git-kit merge --continue', safety: 'safe' },
        { command: 'GK_AGENT=1 git-kit merge --abort', safety: 'destructive' },
      ],
    },
    error: null,
  }),

  // --resume-accept on an unmerged branch: gk refuses, no data loss (exit 1)
  resume_not_merged: () => ({
    state: 'blocked',
    ok: false,
    result: null,
    error: {
      code: 'worktree_resume_not_merged',
      message: 'branch not merged into target; refusing to cleanup',
      remedies: [{ command: 'GK_AGENT=1 git-kit worktree finish --to <base> --gate "..." --gate-phase before', safety: 'safe' }],
    },
  }),
};

// Acquire envelopes — exercised by acquire.test.mjs. The ok path returns a path
// supplied via FAKE_GK_ACQUIRE_PATH so the test can point gk at a real linked
// worktree it created, then verify the TASK-CONTEXT snapshot + exclude landed.
export const ACQUIRE_SCENARIOS = {
  ok: (path) => ({
    schema: 1, state: 'ok', ok: true,
    result: { path, branch: null, parent: 'develop', created: true, reused: false, init: 'done' },
    error: null,
  }),
  blocked: () => ({
    schema: 1, state: 'blocked', ok: false, result: null,
    error: {
      code: 'worktree_acquire_failed',
      message: 'could not create worktree',
      remedies: [{ command: 'GK_AGENT=1 git-kit context --include=precheck', safety: 'safe' }],
    },
  }),
};

export function buildAcquireEnvelope(scenario, { path = null } = {}) {
  const f = ACQUIRE_SCENARIOS[scenario];
  if (!f) throw new Error(`fake-gk: unknown acquire scenario "${scenario}". Known: ${Object.keys(ACQUIRE_SCENARIOS).join(', ')}`);
  return f(path);
}

// `gk sync` envelopes (resume base-drift resolution).
export const SYNC_SCENARIOS = {
  ok: () => ({ state: 'ok', ok: true, result: { synced: true, rebased: true }, error: null }),
  conflict: () => ({
    state: 'paused', ok: false,
    result: {
      conflict: true,
      remedies: [
        { command: 'GK_AGENT=1 git-kit sync --continue', safety: 'safe' },
        { command: 'GK_AGENT=1 git-kit sync --abort', safety: 'destructive' },
      ],
    },
    error: null,
  }),
  blocked: () => ({
    state: 'blocked', ok: false, result: null,
    error: { code: 'sync_blocked', message: 'could not sync', remedies: [{ command: 'GK_AGENT=1 git-kit context', safety: 'safe' }] },
  }),
};

// Mirror real gk v0.106.0 stream behavior (measured): ok envelopes go to
// stdout, blocked/paused/error envelopes go to stderr. Keeping the stub
// faithful forces parseAgentEnvelope() to be exercised on both streams.
function emitEnvelope(envelope) {
  const line = JSON.stringify(envelope) + '\n';
  if (envelope.state === 'ok') process.stdout.write(line);
  else process.stderr.write(line);
}

export function exitCodeForState(state) {
  return ({ ok: 0, blocked: 1, paused: 3, error: 2 })[state] ?? 1;
}

// Per-task call counter (array-valued FAKE_GK_FINISH_SCENARIOS): returns the
// 0-based index of THIS call and increments the on-disk counter.
function nextCallIndex(taskId) {
  const dir = process.env.FAKE_GK_COUNTER_DIR;
  if (!dir) return 0;
  const file = join(dir, `count-${taskId ?? 'null'}`);
  let n = 0;
  try { n = parseInt(readFileSync(file, 'utf8'), 10) || 0; } catch { /* first call */ }
  try { writeFileSync(file, String(n + 1)); } catch { /* best effort */ }
  return n;
}

// Tiny busy delay so serialized finish timestamps are distinct and orderable.
function busyWait(ms) { const t = Date.now() + ms; while (Date.now() < t) { /* spin */ } }

/** Build the envelope for a named scenario, or throw on an unknown name. */
export function buildEnvelope(scenario) {
  const factory = GK_SCENARIOS[scenario];
  if (!factory) {
    throw new Error(`fake-gk: unknown scenario "${scenario}". Known: ${Object.keys(GK_SCENARIOS).join(', ')}`);
  }
  return factory();
}

function main(argv) {
  // `worktree acquire <branch> ...` mode — scenario from FAKE_GK_SCENARIO env.
  if (argv[0] === 'worktree' && argv[1] === 'acquire') {
    const scenario = process.env.FAKE_GK_SCENARIO || 'ok';
    const branchArg = argv[2];
    // Multi-task fan-out: FAKE_GK_ACQUIRE_MAP is a JSON branch→path map so a
    // single fake gk can return a distinct real worktree per acquired branch.
    // Falls back to the single FAKE_GK_ACQUIRE_PATH.
    let acquirePath = process.env.FAKE_GK_ACQUIRE_PATH || null;
    const mapRaw = process.env.FAKE_GK_ACQUIRE_MAP;
    if (mapRaw && branchArg) {
      let map;
      try { map = JSON.parse(mapRaw); }
      catch (e) { process.stderr.write(`fake-gk: bad FAKE_GK_ACQUIRE_MAP: ${e.message}\n`); process.exit(2); }
      if (map[branchArg]) acquirePath = map[branchArg];
    }
    let envelope;
    try { envelope = buildAcquireEnvelope(scenario, { path: acquirePath }); }
    catch (err) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    if (envelope.result && branchArg && envelope.result.branch == null) envelope.result.branch = branchArg;
    emitEnvelope(envelope);
    process.exit(exitCodeForState(envelope.state));
  }

  // `worktree finish --help` capability probe — emit help text with/without --gate.
  if (argv[0] === 'worktree' && argv[1] === 'finish' && argv.includes('--help')) {
    const withGate = process.env.FAKE_GK_NO_GATE ? '' : '  --gate string   quality-gate command template\n';
    process.stdout.write(`Finish a managed worktree.\n${withGate}  --to string   target branch\n`);
    process.exit(0);
  }

  // `worktree finish ...` — the finish queue. Task id is parsed out of the
  // --gate template ("... --task <id> ..."); scenario resolves from the
  // per-task map (array = call-indexed) then the single-scenario fallback.
  if (argv[0] === 'worktree' && argv[1] === 'finish') {
    const start = Date.now();
    const gateIdx = argv.indexOf('--gate');
    let taskId = null;
    if (gateIdx >= 0 && typeof argv[gateIdx + 1] === 'string') {
      const m = argv[gateIdx + 1].match(/--task\s+(\S+)/);
      if (m) taskId = m[1];
    }
    let scenario = process.env.FAKE_GK_SCENARIO || 'ok';
    const mapRaw = process.env.FAKE_GK_FINISH_SCENARIOS;
    if (mapRaw && taskId) {
      let map;
      try { map = JSON.parse(mapRaw); }
      catch (e) { process.stderr.write(`fake-gk: bad FAKE_GK_FINISH_SCENARIOS: ${e.message}\n`); process.exit(2); }
      let entry = map[taskId];
      if (Array.isArray(entry)) entry = entry[Math.min(nextCallIndex(taskId), entry.length - 1)];
      if (entry) scenario = entry;
    }
    let envelope;
    try { envelope = buildEnvelope(scenario); }
    catch (err) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    busyWait(20);
    const end = Date.now();
    if (process.env.FAKE_GK_LOG) {
      appendFileSync(process.env.FAKE_GK_LOG, JSON.stringify({ task: taskId, start, end, pid: process.pid, scenario }) + '\n');
    }
    emitEnvelope(envelope);
    process.exit(exitCodeForState(envelope.state));
  }

  // `sync` — resume base-drift resolution.
  if (argv[0] === 'sync') {
    const scenario = process.env.FAKE_GK_SYNC_SCENARIO || 'ok';
    const f = SYNC_SCENARIOS[scenario];
    if (!f) { process.stderr.write(`fake-gk: unknown sync scenario "${scenario}". Known: ${Object.keys(SYNC_SCENARIOS).join(', ')}\n`); process.exit(2); }
    const envelope = f();
    emitEnvelope(envelope);
    process.exit(exitCodeForState(envelope.state));
  }

  const scenario = argv[0] || process.env.FAKE_GK_SCENARIO;
  if (!scenario) {
    process.stderr.write(`fake-gk: no scenario given (arg or FAKE_GK_SCENARIO). Known: ${Object.keys(GK_SCENARIOS).join(', ')}\n`);
    process.exit(2);
  }
  let envelope;
  try {
    envelope = buildEnvelope(scenario);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(envelope) + '\n');
  process.exit(exitCodeForState(envelope.state));
}

// Run only when executed directly, not when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
