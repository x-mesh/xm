#!/usr/bin/env node
// .claude/hooks/trace-session.mjs
//
// Auto-record an xm skill session: session_start when the Skill tool is invoked
// (PreToolUse), one agent_step per Agent tool call made before the assistant turn
// ends, and session_end at the Stop hook. PostToolUse(Skill) is deliberately not
// the close: it fires as soon as the skill's instructions are loaded, before the
// skill's own Agent calls. Other semantic entries (fan_out, synthesize) remain
// LLM best-effort via SKILL.md.
//
// Usage in settings.json (all three point at the same file):
//   PreToolUse  matcher Skill|Agent → node trace-session.mjs pre
//   PostToolUse matcher Skill|Agent → node trace-session.mjs post
//   Stop        (no matcher)        → node trace-session.mjs stop
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

// `.active` names the open session. Current hooks store {session_id, tool_use_id,
// opened_at, claude_session_id}; older installs stored the bare id, so both parse.
function readActive(activeFile) {
  if (!fs.existsSync(activeFile)) return null;
  let raw;
  try { raw = fs.readFileSync(activeFile, 'utf8').trim(); } catch { return null; }
  if (!raw) return null;
  if (!raw.startsWith('{')) return { session_id: raw, tool_use_id: null, opened_at: null, claude_session_id: null };
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.session_id !== 'string' || !parsed.session_id) return null;
    return {
      session_id: parsed.session_id,
      tool_use_id: typeof parsed.tool_use_id === 'string' ? parsed.tool_use_id : null,
      opened_at: typeof parsed.opened_at === 'string' ? parsed.opened_at : null,
      claude_session_id: typeof parsed.claude_session_id === 'string' ? parsed.claude_session_id : null,
    };
  } catch { return null; }
}

function hasAgentStep(traceFile, id) {
  try { return fs.readFileSync(traceFile, 'utf8').includes(`"id":${JSON.stringify(id)}`); } catch { return false; }
}

function makeSessionId(skillName) {
  const now = new Date();
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const hex = crypto.randomBytes(2).toString('hex');
  return `${skillName}-${date}-${time}-${hex}`;
}

const AGENT_TOOL_NAMES = new Set(['Agent']);
const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const STALE_MARKER_MS = 24 * 60 * 60 * 1000;
// A session no Stop ever closed must not swallow the next turns' agents.
const ACTIVE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
// A skill claim this old with no session behind it belongs to a hook that died mid-open.
const CLAIM_STALE_MS = 5000;
const CLAIM_POLL_MS = 25;
const CLAIM_WAIT_MS = 250;

// Create-exclusive claim. Two registrations of this hook (project settings and
// global settings both wired, as in the x-kit repo) fire for the same tool call;
// a check-then-write guard let both win, so every claim is a `wx` create.
function claim(file, data) {
  try { fs.writeFileSync(file, data, { flag: 'wx' }); return true; }
  catch (err) { if (err.code === 'EEXIST') return false; throw err; }
}

// Take sole ownership of a file by renaming it to `target`; the loser gets false.
function takeOver(file, target) {
  try { fs.renameSync(file, target); return true; }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function skillClaimData() {
  return JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() });
}

function claimOwner(file) {
  const data = readJsonFile(file);
  return Number.isSafeInteger(data?.pid) && data.pid > 0 ? data.pid : null;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return err?.code === 'EPERM'; }
}

function replaceAbandonedClaim(claimFile, activeFile, toolUseId) {
  const recoveryDir = `${claimFile}.recovering`;
  const candidateDir = fs.mkdtempSync(`${recoveryDir}-`);
  const ownerName = `${path.basename(candidateDir)}.json`;
  let locked = false;
  const abandoned = `${claimFile}.abandoned.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
  try {
    fs.writeFileSync(path.join(candidateDir, ownerName), skillClaimData());
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.renameSync(candidateDir, recoveryDir); locked = true; break; }
      catch (err) { if (err.code !== 'EEXIST' && err.code !== 'ENOTEMPTY') throw err; }
      const names = fs.readdirSync(recoveryDir);
      if (names.length !== 1) return false;
      const ownerFile = path.join(recoveryDir, names[0]);
      const owner = claimOwner(ownerFile);
      if (!owner || processAlive(owner)) return false;
      // Unique owner names and nonempty directories protect a successor's lock.
      try { fs.unlinkSync(ownerFile); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
      try { fs.rmdirSync(recoveryDir); }
      catch (err) { if (err.code !== 'ENOENT' && err.code !== 'ENOTEMPTY' && err.code !== 'EEXIST') throw err; }
    }
    if (!locked) return false;
    if (readActive(activeFile)?.tool_use_id === toolUseId) return false;
    const owner = claimOwner(claimFile);
    let age = 0;
    try { age = Date.now() - fs.statSync(claimFile).mtimeMs; }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
    if ((!owner || processAlive(owner)) && age < CLAIM_STALE_MS) return false;
    if (!takeOver(claimFile, abandoned)) return false;
    return claim(claimFile, skillClaimData());
  }
  finally {
    try { fs.unlinkSync(abandoned); } catch { /* best-effort */ }
    if (locked) {
      try { fs.unlinkSync(path.join(recoveryDir, ownerName)); } catch { /* best-effort */ }
      try { fs.rmdirSync(recoveryDir); } catch { /* best-effort */ }
    } else {
      try { fs.rmSync(candidateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}

function acquireSkillClaim(claimFile, activeFile, toolUseId) {
  if (claim(claimFile, skillClaimData())) return true;
  if (readActive(activeFile)?.tool_use_id === toolUseId) return false;
  const owner = claimOwner(claimFile);
  let age = 0;
  try { age = Date.now() - fs.statSync(claimFile).mtimeMs; } catch { /* claim vanished */ }
  if ((owner && !processAlive(owner)) || age >= CLAIM_STALE_MS) {
    return replaceAbandonedClaim(claimFile, activeFile, toolUseId);
  }
  const deadline = Date.now() + CLAIM_WAIT_MS;
  while (Date.now() < deadline) {
    if (readActive(activeFile)?.tool_use_id === toolUseId) return false;
    if (!fs.existsSync(claimFile) && claim(claimFile, skillClaimData())) return true;
    const currentOwner = claimOwner(claimFile);
    if (currentOwner && !processAlive(currentOwner)) return replaceAbandonedClaim(claimFile, activeFile, toolUseId);
    wait(Math.min(CLAIM_POLL_MS, deadline - Date.now()));
  }
  if (readActive(activeFile)?.tool_use_id === toolUseId) return false;
  let finalAge = 0;
  try { finalAge = Date.now() - fs.statSync(claimFile).mtimeMs; } catch { /* claim vanished */ }
  const finalOwner = claimOwner(claimFile);
  if ((finalOwner && !processAlive(finalOwner)) || finalAge >= CLAIM_STALE_MS) {
    return replaceAbandonedClaim(claimFile, activeFile, toolUseId);
  }
  return !fs.existsSync(claimFile) && claim(claimFile, skillClaimData());
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function appendRow(traceFile, entry) {
  fs.appendFileSync(traceFile, JSON.stringify(entry) + '\n');
}

function countAgentSteps(traceFile) {
  try { return fs.readFileSync(traceFile, 'utf8').split('\n').filter((l) => l.includes('"agent_step"')).length; }
  catch { return 0; }
}

function toolUseIdOf(input) {
  return typeof input.tool_use_id === 'string' && TOOL_USE_ID_RE.test(input.tool_use_id) ? input.tool_use_id : null;
}

function agentFields(toolInput) {
  const fields = {
    role: typeof toolInput.subagent_type === 'string' && toolInput.subagent_type ? toolInput.subagent_type : 'agent',
    model: typeof toolInput.model === 'string' && toolInput.model ? toolInput.model : 'inherit',
  };
  if (typeof toolInput.description === 'string' && toolInput.description) fields.description = toolInput.description.slice(0, 120);
  return fields;
}

// A background dispatch answers with an acknowledgement (agent id / "launched"),
// not a result; the request flag alone is not reliable because it can be omitted.
function looksLaunched(response) {
  if (response == null) return false;
  if (typeof response === 'object' && response.status === 'running') return true;
  const text = typeof response === 'string' ? response : JSON.stringify(response).slice(0, 2000);
  return /agentId|Async agent launched|running in the background/i.test(text);
}

// Outcome as far as the PostToolUse payload shows it. An error marker wins even
// for a background dispatch; a dispatch acknowledgement is 'launched', not
// 'success' (the agent has not run yet and duration_ms is launch latency); no
// response at all stays 'unknown'. The post hook arriving never means success.
function agentStatus(input, toolInput) {
  const response = input.tool_response ?? input.tool_output;
  if (typeof response === 'string' && /^\s*error\b/i.test(response)) return 'error';
  if (response && typeof response === 'object' && (response.is_error === true || response.error)) return 'error';
  if (toolInput.run_in_background === true || looksLaunched(response)) return 'launched';
  if (response == null) return 'unknown';
  return 'success';
}

function purgeOld(dir, suffixes) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - STALE_MARKER_MS;
  for (const name of names) {
    if (!suffixes.some((s) => name.endsWith(s))) continue;
    const file = path.join(dir, name);
    try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch { /* best-effort */ }
  }
}

// The open session, or null. A session past ACTIVE_MAX_AGE_MS, or one opened in
// a different Claude conversation, is closed as stale instead of inherited.
function currentSession(tracesDir, base, input) {
  const active = readActive(path.join(tracesDir, '.active'));
  if (!active) return null;
  const openedAt = Date.parse(active.opened_at);
  const tooOld = Number.isFinite(openedAt) && Date.now() - openedAt > ACTIVE_MAX_AGE_MS;
  const otherConversation = Boolean(active.claude_session_id && typeof input.session_id === 'string' && input.session_id && active.claude_session_id !== input.session_id);
  if (tooOld || otherConversation) {
    closeSession(tracesDir, base, 'stale');
    return null;
  }
  return active;
}

// Agent tool spans. Only while an xm skill session is open: x-trace tracks xm
// tool executions, not every subagent in every project, and writing outside a
// session would create .xm/ in repositories that never opted in. The pre marker
// names the session the call started in, so the post attaches to that session
// even if another skill opened a new one in between. Every hand-over is a
// rename or a `wx` create, and the artifact is kept (.done / .abandoned / .post)
// so a second hook registration finds it and writes nothing.
function agentSpan(tracesDir, phase, input, base) {
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const toolUseId = toolUseIdOf(input);
  const pendingDir = path.join(tracesDir, '.agents');
  const marker = toolUseId ? path.join(pendingDir, `${toolUseId}.json`) : null;
  const active = currentSession(tracesDir, base, input);

  if (phase === 'pre') {
    if (!active) { debug('agent span skipped: no open xm session'); return; }
    if (!marker) { debug('agent span: no tool_use_id on pre — duration will be null'); return; }
    fs.mkdirSync(pendingDir, { recursive: true });
    const data = JSON.stringify({ session_id: active.session_id, ts: new Date().toISOString(), ...agentFields(toolInput) });
    if (!claim(marker, data)) debug(`agent span ${toolUseId} already opened by another hook registration`);
    return;
  }
  if (phase !== 'post') return;

  let started = null;
  if (marker) {
    const done = path.join(pendingDir, `${toolUseId}.done`);
    if (takeOver(marker, done)) {
      started = readJsonFile(done);
    } else if (fs.existsSync(done) || fs.existsSync(path.join(pendingDir, `${toolUseId}.abandoned`))) {
      debug(`agent span ${toolUseId} already recorded (done or abandoned)`);
      return;
    }
  }
  const sessionId = started?.session_id || active?.session_id;
  if (!sessionId) { debug('agent span skipped: no session to attach to'); return; }
  const traceFile = path.join(tracesDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(traceFile)) return;
  if (!started && toolUseId) {
    // No pre ever ran for this id: one registration wins the post claim.
    fs.mkdirSync(pendingDir, { recursive: true });
    if (!claim(path.join(pendingDir, `${toolUseId}.post`), new Date().toISOString())) {
      debug(`agent span ${toolUseId} already recorded by another hook registration`);
      return;
    }
  }

  const startedAt = started ? Date.parse(started.ts) : NaN;
  appendRow(traceFile, {
    type: 'agent_step',
    session_id: sessionId,
    ts: new Date().toISOString(),
    v: 1,
    id: toolUseId || `agent-${crypto.randomBytes(3).toString('hex')}`,
    parent_id: null,
    ...agentFields(toolInput),
    duration_ms: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null,
    status: agentStatus(input, toolInput),
    source: 'hook',
  });
}

// Close the open session: one owner (rename-claim on .active), leftover agent
// markers become 'abandoned' rows so an agent still running at turn end is
// visible instead of silently dropped, then session_end with the agent count.
// The closing claim survives until session_end is on disk; a failure puts
// .active back so the next Stop retries.
function closeSession(tracesDir, base, reason) {
  const activeFile = path.join(tracesDir, '.active');
  const owned = `${activeFile}.closing.${process.pid}`;
  if (!takeOver(activeFile, owned)) return false;
  try {
    const active = readActive(owned);
    const traceFile = active?.session_id ? path.join(tracesDir, `${active.session_id}.jsonl`) : null;
    if (!traceFile || !fs.existsSync(traceFile)) { fs.unlinkSync(owned); return false; }

    const pendingDir = path.join(tracesDir, '.agents');
    let markers = [];
    try { markers = fs.readdirSync(pendingDir).filter((n) => n.endsWith('.json')); } catch { markers = []; }
    for (const name of markers) {
      const id = name.replace(/\.json$/, '');
      const abandonedFile = path.join(pendingDir, `${id}.abandoned`);
      // Rename first: only the owner of the marker writes the row, so a post
      // racing this close cannot record the same call twice.
      if (!takeOver(path.join(pendingDir, name), abandonedFile)) continue;
      const data = readJsonFile(abandonedFile);
      if (data && data.session_id && data.session_id !== active.session_id) continue;
      const startedAt = Date.parse(data?.ts);
      appendRow(traceFile, {
        type: 'agent_step', session_id: active.session_id, ts: new Date().toISOString(), v: 1, id, parent_id: null,
        role: data?.role || 'agent', model: data?.model || 'inherit', ...(data?.description ? { description: data.description } : {}),
        duration_ms: Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null,
        status: 'abandoned', source: 'hook',
      });
    }
    purgeOld(pendingDir, ['.abandoned', '.done', '.post']);
    purgeOld(path.join(tracesDir, '.claims'), ['.skill']);

    let durationMs = 0;
    try {
      const start = JSON.parse(fs.readFileSync(traceFile, 'utf8').split('\n')[0]);
      durationMs = Date.now() - new Date(start.ts).getTime();
    } catch (err) { debug(`duration calc failed: ${err.message}`); }

    const entry = {
      type: 'session_end',
      session_id: active.session_id,
      ts: new Date().toISOString(),
      v: 1,
      // The hook cannot observe the skill's real outcome — a Block/error verdict
      // is not surfaced to it — so it records 'unknown' rather than asserting
      // success. (trace-writer.sessionEnd sets a real status because it runs at
      // the true end of a known operation.)
      status: 'unknown',
      total_duration_ms: durationMs,
      agent_count: countAgentSteps(traceFile),
    };
    if (reason !== 'stop') entry.close_reason = reason;
    const git = gitSnapshot(base);
    if (git.head) entry.git = git;
    appendRow(traceFile, entry);
    fs.unlinkSync(owned);
    return true;
  } catch (err) {
    try { fs.renameSync(owned, activeFile); } catch { /* best-effort */ }
    throw err;
  }
}

async function openSession(tracesDir, base, input, skillName) {
  fs.mkdirSync(tracesDir, { recursive: true });
  const activeFile = path.join(tracesDir, '.active');
  const toolUseId = toolUseIdOf(input);
  const git = gitSnapshot(base);
  let claimFile = null;
  if (toolUseId) {
    const claimsDir = path.join(tracesDir, '.claims');
    fs.mkdirSync(claimsDir, { recursive: true });
    claimFile = path.join(claimsDir, `${toolUseId}.skill`);
    if (!acquireSkillClaim(claimFile, activeFile, toolUseId)) {
      debug(`session for ${toolUseId} already opened by another hook registration`);
      return;
    }
  }
  try {
    // A session left open by a turn that never reached Stop is closed here so the
    // new one does not inherit its agents; the row says why it closed.
    if (readActive(activeFile)) closeSession(tracesDir, base, 'superseded');

    const sessionId = makeSessionId(skillName);
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
    if (git.head) entry.git = git;
    appendRow(path.join(tracesDir, `${sessionId}.jsonl`), entry);
    fs.writeFileSync(activeFile, JSON.stringify({
      session_id: sessionId,
      tool_use_id: toolUseId,
      opened_at: new Date().toISOString(),
      claude_session_id: typeof input.session_id === 'string' && input.session_id ? input.session_id : null,
    }));
    await ensureProjectRegistered(base);
  } catch (err) {
    if (claimFile) { try { fs.unlinkSync(claimFile); } catch { /* best-effort */ } }
    throw err;
  }
}

async function main() {
  const phase = process.argv[2]; // 'pre' | 'post' | 'stop'
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

  // Base = the directory the skill was invoked in; the .xm/ root is then resolved
  // worktree-aware so we write where the CLI writes.
  const base = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const tracesDir = path.join(resolveXmDir(base), 'traces');

  try {
    if (phase === 'stop') {
      // Turn end is the only signal that arrives after the skill's own Agent
      // calls; it closes whatever session the turn opened.
      closeSession(tracesDir, base, 'stop');
      process.exit(0);
    }

    if (AGENT_TOOL_NAMES.has(input.tool_name)) {
      agentSpan(tracesDir, phase, input, base);
      process.exit(0);
    }

    const skill = input.tool_input?.skill;
    if (typeof skill !== 'string' || !isTracedSkill(skill)) process.exit(0);

    if (phase === 'pre') {
      await openSession(tracesDir, base, input, skill.replace('xm:', ''));
    }
    // PostToolUse(Skill) fires as soon as the skill's instructions are loaded —
    // tens of milliseconds in, before any Agent call the skill makes — so it
    // must not close the session. Stop does.
  } catch (err) {
    // Trace is best-effort — never block tool execution.
    debug(`fatal (swallowed): ${err.message}`);
  }

  process.exit(0);
}

main();
