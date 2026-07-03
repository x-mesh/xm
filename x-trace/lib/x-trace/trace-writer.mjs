/**
 * trace-writer.mjs — Programmatic trace recording for xm CLI tools
 *
 * Usage:
 *   import { createSessionId, traceAppend, sessionStart, sessionEnd, agentStep } from './x-trace/trace-writer.mjs';
 */

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';

const TRACE_DIR_NAME = 'traces';

/**
 * Resolve the .xm/ root directory — worktree-aware.
 * Rule: XM_ROOT env → local .xm/ → main checkout's .xm/ via git-common-dir.
 * Shared by resolveTraceDir() (traces/) and last-store.mjs (last.json), so the
 * hook trace and the CLI trace always land under the same .xm/.
 */
export function resolveXmDir() {
  // Explicit override wins (tests + isolated runs set this to an absolute .xm path).
  if (process.env.XM_ROOT) return process.env.XM_ROOT;
  // Prefer a local .xm/ in the current working directory.
  const localXm = resolve(process.cwd(), '.xm');
  if (existsSync(localXm)) return localXm;
  // Worktree fallback: resolve the main checkout's .xm/ via the shared git dir.
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainXm = resolve(process.cwd(), commonDir, '..', '.xm');
    if (existsSync(mainXm)) return mainXm;
  } catch {}
  return localXm;
}

/** Resolve .xm/traces/ directory — worktree-aware */
export function resolveTraceDir() {
  return join(resolveXmDir(), TRACE_DIR_NAME);
}

/**
 * Snapshot the git state of `dir` → { head, branch, dirty }.
 * Never throws (FM1): missing git / bare repo / detached HEAD / any failure
 * yields null for the affected field only. Uses spawnSync (~10ms measured, so
 * no caching) and computes each field independently so a partial failure (e.g.
 * bare repo where status fails but rev-parse works) still records what it can.
 */
export function gitSnapshot(dir = process.cwd()) {
  const run = (args) => {
    try {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (r.error || r.status !== 0) return null;
      return r.stdout.trim();
    } catch {
      return null;
    }
  };
  const head = run(['rev-parse', 'HEAD']) || null;
  let branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') branch = null; // detached HEAD or failure → no branch name
  const porcelain = run(['status', '--porcelain']);
  const dirty = porcelain === null ? null : porcelain.length > 0;
  return { head, branch, dirty };
}

/** Generate session ID: {skill}-{YYYYMMDD}-{HHMMSS}-{4hex} */
export function createSessionId(skill) {
  const now = new Date();
  const date = now.toISOString().replace(/[-:T]/g, '').slice(0, 8);
  const time = now.toISOString().replace(/[-:T]/g, '').slice(8, 14);
  const rand = randomBytes(2).toString('hex');
  return `${skill}-${date}-${time}-${rand}`;
}

/** Append a single JSONL line — never throws */
export function traceAppend(sessionId, entry) {
  try {
    const traceDir = resolveTraceDir();
    mkdirSync(traceDir, { recursive: true });
    const filePath = join(traceDir, `${sessionId}.jsonl`);
    const line = JSON.stringify({ ...entry, session_id: sessionId, ts: new Date().toISOString(), v: 1 });
    appendFileSync(filePath, line + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`[x-trace] write failed: ${err.message}\n`);
  }
}

/** Convenience: write session_start */
export function sessionStart(sessionId, skill, args = {}) {
  const entry = { type: 'session_start', skill, args };
  // Optional git snapshot — omit outside a git repo so the schema stays clean.
  // Same event type, same v:1: dashboard session-boundary parsing is unaffected.
  const git = gitSnapshot();
  if (git.head) entry.git = git;
  traceAppend(sessionId, entry);
}

/** Convenience: write session_end */
export function sessionEnd(sessionId, { totalDurationMs = 0, agentCount = 0, status = 'success', tokensEstTotal = null } = {}) {
  const entry = { type: 'session_end', total_duration_ms: totalDurationMs, agent_count: agentCount, status };
  if (tokensEstTotal) entry.tokens_est_total = { ...tokensEstTotal, precision: 'estimate' };
  const git = gitSnapshot();
  if (git.head) entry.git = git;
  traceAppend(sessionId, entry);
}

/** Convenience: write agent_step */
export function agentStep(sessionId, { id, parentId = null, role, model, tokensEst = null, durationMs = 0, status = 'success', error = null } = {}) {
  const entry = { type: 'agent_step', id, parent_id: parentId, role, model, duration_ms: durationMs, status };
  if (tokensEst) entry.tokens_est = { ...tokensEst, precision: 'estimate' };
  if (error) entry.error = error;
  traceAppend(sessionId, entry);
}
