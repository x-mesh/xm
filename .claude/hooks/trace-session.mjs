#!/usr/bin/env node
// .claude/hooks/trace-session.mjs
//
// Auto-record session_start (PreToolUse) and session_end (PostToolUse) for xm skills.
// Semantic trace entries (agent_call, fan_out, etc.) remain LLM best-effort via SKILL.md.
//
// Usage in settings.json:
//   PreToolUse  → node trace-session.mjs pre
//   PostToolUse → node trace-session.mjs post
//
// This hook is a STANDALONE file — it is copied to ~/.claude/hooks/ by `xm init`
// and must run without the xm plugin lib on disk. It therefore cannot import
// x-trace/lib/x-trace/trace-writer.mjs; the worktree resolution and git-snapshot
// logic below are intentional small duplicates of resolveXmDir()/gitSnapshot()
// there. Keep them in sync so the hook trace and the CLI trace land under the
// same .xm/ and carry the same git schema.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TRACED_PREFIXES = ['xm:'];
const DEBUG = process.env.XM_TRACE_DEBUG === '1';

function isTracedSkill(skill) {
  return TRACED_PREFIXES.some((p) => skill.startsWith(p));
}

// Best-effort diagnostics. Silent by default (a hook must never chatter into the
// session); surfaced to stderr only when XM_TRACE_DEBUG=1 so failures are
// discoverable without changing the never-block contract.
function debug(msg) {
  if (!DEBUG) return;
  try { process.stderr.write(`[xm-trace-hook] ${msg}\n`); } catch { /* nowhere to report */ }
}

// Mirror of trace-writer.mjs resolveXmDir() — resolve the .xm/ root, worktree-aware.
// Rule: XM_ROOT env → local .xm/ under base → main checkout's .xm/ via git-common-dir.
// `base` is the directory the skill was invoked in (CLAUDE_PROJECT_DIR || cwd).
function resolveXmDir(base) {
  // Explicit override wins (tests + isolated runs set this to an absolute .xm path).
  if (process.env.XM_ROOT) return process.env.XM_ROOT;
  // Prefer a local .xm/ in the invocation directory.
  const localXm = path.resolve(base, '.xm');
  if (fs.existsSync(localXm)) return localXm;
  // Worktree fallback: resolve the main checkout's .xm/ via the shared git dir,
  // so a worktree without its own .xm/ writes alongside the CLI's traces.
  const commonDir = gitCommonDir(base);
  if (commonDir) {
    const mainXm = path.resolve(base, commonDir, '..', '.xm');
    if (fs.existsSync(mainXm)) return mainXm;
  }
  return localXm;
}

// `git rev-parse --git-common-dir` from `dir` — the shared git dir for worktrees.
// Never throws; returns null outside a repo or on any failure.
function gitCommonDir(dir) {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error || r.status !== 0) return null;
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

// Mirror of trace-writer.mjs gitSnapshot() — snapshot git state of `dir` as
// { head, branch, dirty }. Never throws (FM1): any failure yields null for the
// affected field only, computed independently so a partial failure still records
// what it can. branch is null on detached HEAD / failure; dirty is null when
// status is unavailable, else a boolean.
function gitSnapshot(dir) {
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
  if (!branch || branch === 'HEAD') branch = null;
  const porcelain = run(['status', '--porcelain']);
  const dirty = porcelain === null ? null : porcelain.length > 0;
  return { head, branch, dirty };
}

// Event-based project auto-registration: invoking an xm: skill in a project IS the
// evidence that the project is in use, so register it (best-effort, idempotent — writes
// only when newly added). Resolves x-projects-registry from XM_LIB, the plugin cache
// (newest version), or the local repo. Never throws — tracing must not be blocked.
async function ensureProjectRegistered(projectRoot) {
  try {
    const candidates = [];
    const env = process.env.XM_LIB || process.env.X_KIT_LIB;
    if (env) {
      candidates.push(path.join(env, 'xm', 'lib', 'x-projects-registry.mjs'));
      candidates.push(path.join(env, 'x-projects-registry.mjs'));
    }
    const cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'xm', 'xm');
    try {
      const vers = fs.readdirSync(cacheRoot)
        .filter((v) => /\d/.test(v))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .reverse();
      for (const v of vers) candidates.push(path.join(cacheRoot, v, 'lib', 'x-projects-registry.mjs'));
    } catch { /* no cache dir */ }
    candidates.push(path.join(projectRoot, 'xm', 'lib', 'x-projects-registry.mjs'));

    const found = candidates.find((c) => { try { return fs.existsSync(c); } catch { return false; } });
    if (!found) return;
    const mod = await import(pathToFileURL(found).href);
    if (typeof mod.ensureRegistered === 'function') mod.ensureRegistered(projectRoot);
  } catch (err) {
    debug(`project register failed: ${err.message}`);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function pad2(n) { return String(n).padStart(2, '0'); }

function makeSessionId(skillName) {
  const now = new Date();
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const hex = crypto.randomBytes(2).toString('hex');
  return `${skillName}-${date}-${time}-${hex}`;
}

async function main() {
  const phase = process.argv[2]; // 'pre' or 'post'
  if (!phase) process.exit(0);

  let input;
  try {
    const raw = await readStdin();
    input = raw ? JSON.parse(raw) : {};
  } catch (err) {
    // Malformed stdin is not an error worth blocking on — stay silent (exit 0)
    // unless debugging.
    debug(`stdin parse failed: ${err.message}`);
    process.exit(0);
  }

  const skill = input.tool_input?.skill;
  if (typeof skill !== 'string' || !isTracedSkill(skill)) {
    process.exit(0);
  }

  // Base = the directory the skill was invoked in; the .xm/ root is then resolved
  // worktree-aware so we write where the CLI writes.
  const base = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const tracesDir = path.join(resolveXmDir(base), 'traces');
  const activeFile = path.join(tracesDir, '.active');
  const skillName = skill.replace('xm:', '');

  try {
    if (phase === 'pre') {
      const sessionId = makeSessionId(skillName);
      fs.mkdirSync(tracesDir, { recursive: true });
      await ensureProjectRegistered(base);

      const entry = {
        type: 'session_start',
        session_id: sessionId,
        ts: new Date().toISOString(),
        v: 1,
        skill: skillName,
        args: input.tool_input?.args || '',
      };
      // Optional git snapshot — omit outside a git repo so the schema stays clean.
      // Same event type, same v:1: dashboard session-boundary parsing is unaffected.
      const git = gitSnapshot(base);
      if (git.head) entry.git = git;

      fs.appendFileSync(path.join(tracesDir, `${sessionId}.jsonl`), JSON.stringify(entry) + '\n');
      fs.writeFileSync(activeFile, sessionId);

    } else if (phase === 'post') {
      if (!fs.existsSync(activeFile)) process.exit(0);

      const sessionId = fs.readFileSync(activeFile, 'utf8').trim();
      if (!sessionId) process.exit(0);

      const traceFile = path.join(tracesDir, `${sessionId}.jsonl`);
      if (!fs.existsSync(traceFile)) process.exit(0);

      // Read session_start to calculate duration
      let durationMs = 0;
      try {
        const first = fs.readFileSync(traceFile, 'utf8').split('\n')[0];
        const start = JSON.parse(first);
        durationMs = Date.now() - new Date(start.ts).getTime();
      } catch (err) { debug(`duration calc failed: ${err.message}`); }

      // Count agent_step entries for agent_count
      let agentCount = 0;
      try {
        const lines = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
        agentCount = lines.filter((l) => l.includes('"agent_step"')).length;
      } catch (err) { debug(`agent count failed: ${err.message}`); }

      const entry = {
        type: 'session_end',
        session_id: sessionId,
        ts: new Date().toISOString(),
        v: 1,
        // The hook fires on PostToolUse but cannot observe the skill's real
        // outcome — a Block/error verdict is not surfaced to the hook — so we
        // record 'unknown' rather than asserting success. (The CLI writer,
        // trace-writer.sessionEnd, sets a real status because it runs at the
        // true end of a known operation.) Key kept for schema parity;
        // analyze-traces already maps a missing/unknown status to 'unknown'.
        status: 'unknown',
        total_duration_ms: durationMs,
        agent_count: agentCount,
      };
      const git = gitSnapshot(base);
      if (git.head) entry.git = git;

      try { fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n'); } catch (err) { debug(`append session_end failed: ${err.message}`); }
      try { fs.unlinkSync(activeFile); } catch (err) { debug(`unlink active failed: ${err.message}`); }
    }
  } catch (err) {
    // Trace is best-effort — never block skill execution.
    debug(`fatal (swallowed): ${err.message}`);
  }

  process.exit(0);
}

main();
