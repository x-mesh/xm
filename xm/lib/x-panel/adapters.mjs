/**
 * x-panel/adapters — provider headless invocation + JSON extraction.
 *
 * Each provider is called non-interactively in the shell and its stdout is
 * scanned for a JSON object. Tests override a provider's command via
 * X_PANEL_CMD_<MODEL> (a path to a node stub) so the flow runs without real
 * model calls.
 *
 * Failures are surfaced, never swallowed (Lesson L6): a missing CLI or a
 * non-zero exit returns { ok:false, error } and the caller logs it.
 */

import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

// A non-zero/absent exit code, labeled. A signal death gives code === null (the child
// was KILLED, not a normal exit) — surface the signal so `exit null` isn't a dead end:
// `exit null (SIGKILL)` = OOM/hard-kill, `(SIGABRT)` = crash/panic, `(SIGTERM)` = external
// terminate. Our own timeout guard reports its own descriptive error, so a signal reaching
// this close handler came from OUTSIDE (OS/OOM or the CLI self-aborting), not from us.
const exitLabel = (code, signal) => (signal ? `exit ${code} (${signal})` : `exit ${code}`);

// Each builds [bin, args]. `model` (optional) maps to that CLI's --model flag;
// when null the CLI uses its own default model.
export function normalizeKiroModel(model) {
  const value = String(model || '').trim();
  if (!value) return null;
  // Kiro CLI lists Claude models as claude-opus-4.8 / claude-sonnet-4.6,
  // while Anthropic API IDs commonly use claude-opus-4-8. Accept either.
  return value.replace(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(.*)$/i, 'claude-$1-$2.$3$4');
}

// Reasoning-effort levels codex accepts via `-c model_reasoning_effort=<level>`.
// Kept in lockstep with x-build/cost-engine.mjs MODEL_EFFORT_LEVELS — DO NOT import
// that module: adapters.mjs is a zero-import leaf (node builtins only), and an
// x-panel→x-build edge would invert the plugin dependency AND dies under the
// versioned plugin-cache layout (see x-memory cache-crash lesson). Mirror, never couple.
const CODEX_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Split a codex `"model[:effort]"` spec into { model, effort, warning }.
 * Local re-implementation of cost-engine.parseModelSpec (see the note above on why
 * it is copied, not imported). Rules mirror it exactly:
 *  - falsy / empty / non-string spec → no model requested (CLI default), NOT an error.
 *  - no colon → the whole string is the model.
 *  - multiple colons ("a:b:c") → split at the LAST colon; only the final segment is
 *    an effort candidate ("a:b" stays the model).
 *  - trailing ':' or an unknown effort (typo) → drop the effort, keep the model, and
 *    return a warning (FM2: never swallow the signal — the caller surfaces it).
 */
function parseCodexSpec(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    return { model: null, effort: null, warning: null }; // no model → CLI default, not a user error
  }
  const trimmed = spec.trim();
  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) return { model: trimmed, effort: null, warning: null };
  const model = trimmed.slice(0, idx);
  const effortCandidate = trimmed.slice(idx + 1);
  if (model === '') return { model: null, effort: null, warning: `codex: empty model in spec "${trimmed}"` };
  if (effortCandidate === '') return { model, effort: null, warning: `codex: trailing ':' with no reasoning effort in "${trimmed}"` };
  if (!CODEX_EFFORT_LEVELS.includes(effortCandidate)) {
    return { model, effort: null, warning: `codex: unknown reasoning effort "${effortCandidate}" (expected ${CODEX_EFFORT_LEVELS.join('|')})` };
  }
  return { model, effort: effortCandidate, warning: null };
}

// Turn a codex "model[:effort]" spec into its argv fragment
// (`--model <id> -c model_reasoning_effort=<effort>`), surfacing any parse warning
// on stderr — a dropped/typo'd effort must be visible, never silent (FM2, L6).
function codexModelArgs(spec) {
  const { model, effort, warning } = parseCodexSpec(spec);
  if (warning) process.stderr.write(`[x-panel] ${warning}\n`);
  return [
    ...(model ? ['--model', model] : []),
    ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
  ];
}

/**
 * Assemble a `codex exec … resume` argv. Exec-level flags (--sandbox / --json /
 * --skip-git-repo-check) AND --model / -c MUST precede the `resume` subcommand:
 * codex parses them as `exec` options, so `resume … --sandbox` errors out with a
 * usage failure (verified locally). The session id and prompt are resume's own
 * positionals and come last. No consumer yet — this is the contract t8+ builds on.
 *
 * sessionId를 생략하면 `--last`(가장 최근 세션 재개)를 넣는다 — codex 문서의
 * "If omitted, use --last" 및 t8 Codex Overlay의 `resume --last` 지시와 정합
 * (E2E에서 발견: 생략 시 prompt가 SESSION_ID 위치 인자로 오파싱되어 실패).
 *
 * @param {{ execFlags?: string[], sessionId?: string|null, model?: string|null, prompt?: string }} opts
 * @returns {[string, string[]]} [bin, args]
 */
export function buildCodexResumeArgs({ execFlags = [], sessionId = null, model = null, prompt = '' } = {}) {
  const args = [
    'exec',
    ...(Array.isArray(execFlags) ? execFlags : []),
    ...codexModelArgs(model),
    'resume',
    ...(sessionId ? [String(sessionId)] : ['--last']),
    ...(prompt ? [String(prompt)] : []),
  ];
  return ['codex', args];
}

// THE single source of provider command definitions — shared by panel review
// AND every cross-vendor consumer (x-review/op/agent/eval/solver/build), which
// all reach these via `xm panel cross`. Providers live in CODE, not config:
// `panel.*` config only tunes panel-review behavior (models/judge/stream); the
// lone config key the cross path also reads is `timeout_s` (cmdCross).
const BUILTIN = {
  // --output-format json wraps the answer in a result envelope that also carries usage
  // + total_cost_usd (unwrapEnvelope lifts both). Without it claude reports zero tokens,
  // which is why every cost figure in the kit read "estimated".
  claude: (prompt, model) => ['claude', ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), prompt]],
  // --sandbox read-only matches the streaming codex path: review/cross prompts never edit the repo.
  // A "model[:effort]" spec maps to --model <id> + -c model_reasoning_effort=<effort> (codexModelArgs).
  // --json emits the JSONL event stream (thread.started / item.completed / turn.completed)
  // that carries the session id AND real token counts. It also REMOVES the stderr session
  // banner (measured), so parseJsonlOutput's thread.started is now the only capture path.
  codex: (prompt, model) => ['codex', ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', ...codexModelArgs(model), prompt]],
  // agy's -p/--print CONSUMES the next token as the prompt value, so --model must
  // precede -p (unlike claude/codex whose -p is a boolean with a positional prompt).
  // Wrong order (`-p --model X <prompt>`) makes -p eat "--model", dropping the real
  // prompt → agy replies with a generic self-intro that fails JSON parsing.
  agy: (prompt, model) => ['agy', [...(model ? ['--model', model] : []), '-p', prompt]], // Antigravity CLI (formerly gemini)
  cursor: (prompt, model) => ['cursor-agent', ['-p', '-f', ...(model ? ['--model', model] : []), prompt]], // -f bypasses workspace-trust
  kiro: (prompt, model) => {
    const m = normalizeKiroModel(model);
    // --trust-tools= (empty) = trust NO tools, so a review prompt can't make kiro run
    // tools / hang waiting for approval under --no-interactive. (Harmless stderr warning.)
    return ['kiro-cli', ['chat', '--no-interactive', '--wrap', 'never', '--trust-tools=', ...(m ? ['--model', m] : []), prompt]];
  },
};

export function knownProviders() {
  return Object.keys(BUILTIN);
}

// Per-provider catalog metadata. The model LISTS are intentionally NOT hardcoded
// (cursor alone exposes 130+ variants, versioned weekly) — `list` is the live
// query command so this never goes stale. `multi` flags vendors that are model
// gateways (one CLI fronts several model families). `examples` are a few verified
// IDs (2026-06) to seed `--models name:model`; agy/codex omit them because their
// accepted ID form isn't unambiguous from the CLI — query `list` instead.
// `auth` is the CLI's own non-interactive auth-status command (exit 0 = signed in),
// verified 2026-06; `login` is the fix hint shown when it fails. agy has no such
// command, so its readiness can only be confirmed by an actual --probe call.
export const PROVIDER_META = {
  claude: { vendor: 'Anthropic', multi: false, list: 'claude --help', examples: 'claude-opus-4-8, claude-sonnet-4-6', auth: ['claude', ['auth', 'status']], login: 'claude auth login' },
  codex:  { vendor: 'OpenAI', multi: false, list: 'codex --help (no list cmd; pass -m <id>)', examples: '', auth: ['codex', ['login', 'status']], login: 'codex login' },
  agy:    { vendor: 'Google Antigravity', multi: true, list: 'agy models', examples: '', auth: null, login: 'agy install', creds: '.gemini/oauth_creds.json', listCmd: ['agy', ['models']] },
  cursor: { vendor: 'Cursor — multi-vendor gateway', multi: true, list: 'cursor-agent --list-models', examples: 'cursor:kimi-k2.5, cursor:claude-opus-4-8-thinking-high, cursor:gpt-5.5-high, cursor:gemini-3.1-pro, cursor:grok-4.3, cursor:glm-5.2-max', auth: ['cursor-agent', ['status']], login: 'cursor-agent login', listCmd: ['cursor-agent', ['--list-models']] },
  kiro:   { vendor: 'AWS Kiro — multi-vendor', multi: true, list: 'kiro-cli chat --list-models', examples: 'kiro:claude-opus-4.8, kiro:deepseek-3.2, kiro:minimax-m2.5, kiro:glm-5, kiro:qwen3-coder-next', auth: ['kiro-cli', ['whoami']], login: 'kiro-cli login', listCmd: ['kiro-cli', ['chat', '--list-models']] },
};

export function providerMeta(name) {
  return name ? (PROVIDER_META[name] || null) : PROVIDER_META;
}

/**
 * Readiness probe for one provider WITHOUT spending a model call: checks PATH
 * install, then runs the CLI's auth-status command (exit 0 = authenticated).
 * Returns { name, installed, authed, detail } where authed is true/false, or
 * null when it can't be known cheaply (no status cmd) — caller may then --probe.
 */
export function checkAuth(name, { timeout = 12_000 } = {}) {
  const meta = PROVIDER_META[name];
  if (!meta) return { name, installed: false, authed: null, assumedReady: false, detail: 'unknown provider' };
  if (!isAvailable(name)) return { name, installed: false, authed: null, assumedReady: false, detail: 'not on PATH' };
  // A test/env override stub stands in for the real CLI — treat as ready, unless the
  // test explicitly marks it unready (exercises the pre-run readiness gate hermetically).
  if (overridePath(name)) {
    if (process.env[`X_PANEL_STUB_UNREADY_${name.toUpperCase()}`]) {
      return { name, installed: true, authed: false, assumedReady: false, detail: 'X_PANEL_STUB_UNREADY override (stub not authenticated)' };
    }
    return { name, installed: true, authed: true, assumedReady: true, detail: 'X_PANEL_CMD override (assumed ready)' };
  }
  if (!meta.auth) {
    // No non-interactive auth-status command (agy). We can't confirm auth without a model call,
    // so authed stays null (?) — never promoted to ✓ (a present-but-expired token must not read as
    // a false ✓). BUT we set assumedReady when the creds file exists, so the picker/gate treats
    // agy as usable: excluding it outright made an authenticated agy a permanent false-negative.
    // The worst case (stale creds) is a loud mid-run failure, recoverable; a silent always-hidden
    // vendor is not. No creds → likely logged out → not assumed ready.
    let detail = 'no auth-status command — use --probe';
    let credsPresent = false;
    if (meta.creds) {
      const p = join(homedir(), meta.creds);
      credsPresent = existsSync(p);
      detail = credsPresent
        ? `credentials present (~/${meta.creds}); assumed ready — run --probe to confirm`
        : `no credentials at ~/${meta.creds} — likely logged out; --probe to confirm`;
    }
    return { name, installed: true, authed: null, assumedReady: credsPresent, detail };
  }
  const [bin, args] = meta.auth;
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, env: process.env });
  if (r.error) {
    const msg = (r.error.code === 'ETIMEDOUT') ? `auth check timed out (${timeout}ms)` : String(r.error.message || r.error);
    return { name, installed: true, authed: false, assumedReady: false, detail: msg.slice(0, 120) };
  }
  const clean = ((r.stdout || '') + ' ' + (r.stderr || '')).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
  let detail = clean.split('\n').map((s) => s.trim()).filter(Boolean)[0] || `exit ${r.status}`;
  // claude's status is a JSON object — summarize its fields instead of a bare "{".
  if (detail.startsWith('{')) {
    try {
      const j = JSON.parse((r.stdout || '').trim());
      detail = [j.authMethod || j.apiProvider, j.email].filter(Boolean).join(' · ') || (j.loggedIn ? 'logged in' : 'logged out');
    } catch { /* keep first line */ }
  }
  const authed = r.status === 0;
  return { name, installed: true, authed, assumedReady: authed, detail: detail.slice(0, 90) };
}

// A provider is usable in a run when it's installed AND either verified-authed (authed===true) OR
// assumed-ready (a no-auth-status CLI like agy whose credentials file is present). assumedReady is
// kept DISTINCT from authed===true so `doctor` can still mark it "unverified" — this only governs
// whether the auth gate (detect --auth, picker) offers the provider, not whether it's confirmed.
export function providerReady(c) {
  return !!c && c.installed === true && (c.authed === true || c.assumedReady === true);
}

/**
 * Fetch a provider's REAL model catalog by running its own --list-models command.
 * NOT hardcoded — always current (cursor's kimi-k2.5, kiro's deepseek, …). Returns
 * { ok, output, error }; ok=false when not installed or the CLI has no list command.
 */
export function listModels(name, { timeout = 30_000 } = {}) {
  const meta = PROVIDER_META[name];
  if (!meta) return { ok: false, output: '', error: `unknown provider: ${name}` };
  if (!isAvailable(name)) return { ok: false, output: '', error: 'not installed' };
  if (!meta.listCmd) return { ok: false, output: '', error: `no model-list command (${meta.list})` };
  const [bin, args] = meta.listCmd;
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: process.env });
  if (r.error) return { ok: false, output: '', error: String(r.error.message || r.error) };
  if (r.status !== 0) return { ok: false, output: r.stdout || '', error: `exit ${r.status}: ${(r.stderr || '').trim().slice(0, 100)}` };
  return { ok: true, output: (r.stdout || '').trim(), error: null };
}

// Parse a `--list-models` CLI dump into bare model IDs. Handles the two live formats
// we ship: cursor ("id - Description") and kiro ("[*] id  N.NNx credits  Desc"). Other
// shapes yield [] so the caller can fall back to its static hints.
export function parseModelIds(output) {
  const ids = [];
  for (const line of String(output || '').split('\n')) {
    const m = line.match(/^\s*\*?\s*([A-Za-z0-9][\w.:-]*)\s+-\s+/)          // cursor: "id - Description"
      || line.match(/^\s*\*?\s*([A-Za-z0-9][\w.:-]*)\s+[\d.]+x\s+credits/);  // kiro: "id  1.00x credits ..."
    if (m) ids.push(m[1]);
  }
  return [...new Set(ids)];
}

// Async, non-blocking model catalog: spawns the provider's own list command and parses
// it to IDs. Used by the dashboard so a slow CLI never blocks the server event loop
// (listModels is spawnSync). Returns { ok, models, error }.
export function listModelIds(name, { timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    const meta = PROVIDER_META[name];
    if (!meta) return resolve({ ok: false, models: [], error: `unknown provider: ${name}` });
    if (!isAvailable(name)) return resolve({ ok: false, models: [], error: 'not installed' });
    if (!meta.listCmd) return resolve({ ok: false, models: [], error: 'no model-list command' });
    const [bin, args] = meta.listCmd;
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env }); }
    catch (e) { return resolve({ ok: false, models: [], error: String(e.message || e) }); }
    let out = '', err = '', settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } done({ ok: false, models: parseModelIds(out), error: 'timeout' }); }, timeout);
    if (timer.unref) timer.unref();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; if (out.length > 8 * 1024 * 1024) out = out.slice(-8 * 1024 * 1024); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 50_000) err = err.slice(-50_000); });
    child.on('error', (e) => { clearTimeout(timer); done({ ok: false, models: [], error: String(e.message || e) }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const models = parseModelIds(out);
      if (code !== 0 && models.length === 0) return done({ ok: false, models: [], error: `${exitLabel(code, signal)}: ${err.trim().slice(0, 100)}` });
      done({ ok: true, models, error: null });
    });
  });
}

/** Known providers that are actually installed on PATH (or overridden via env). */
export function autodetectModels() {
  return knownProviders().filter(isAvailable);
}

function overridePath(name) {
  return process.env[`X_PANEL_CMD_${name.toUpperCase()}`] || null;
}

export function resolveCommand(name, prompt, model) {
  const override = overridePath(name);
  if (override) {
    // override is a node script invoked as: node <script> <name> <prompt>
    return ['node', [override, name, prompt]];
  }
  const fn = BUILTIN[name];
  return fn ? fn(prompt, model || null) : null;
}

// Ambient-context isolation for PROMPT runs (not auth/list probes). In a repo
// cwd the claude CLI auto-assembles project CLAUDE.md + hook-injected context
// around the -p prompt; with long prompts the model then echoes that
// scaffolding instead of answering (measured 2026-07-05: the identical 2.9KB
// prompt returned a 55-output-token scaffold echo from the repo cwd vs the
// full 10.5KB answer from a neutral cwd). A -p one-shot runs without tool
// permissions, so a repo cwd buys claude nothing — spawn it from the OS temp
// dir. Other vendors keep the caller's cwd ON PURPOSE (codex --sandbox
// read-only reads the repo). Flag alternatives were tested and rejected:
// --bare drops OAuth auth entirely; --setting-sources user still leaves
// user-scope hook injection active.
export function promptSpawnOpts(name) {
  return name === 'claude' ? { cwd: tmpdir() } : {};
}

// Grounded-refutation capability (roadmap 빅뱃3): can this vendor OPEN the cited
// files and verify a finding against the real code in round 2? Only when it runs
// in the caller's repo cwd AND has a genuine read tool. In v1 that is exactly
// codex — `exec --sandbox read-only` from the repo cwd gives it filesystem read
// (never write). claude is tmpdir-isolated with no tool permissions in a -p
// one-shot; cursor/agy/kiro run in the repo cwd but their read-tool access is
// unconfirmed, so they are treated as ungrounded (they argue from the finding
// text) until a live probe promotes them. Asking a vendor that CANNOT read to
// "open the file" would invite a hallucinated `checked:true`, which is worse than
// an honest text-only verdict — hence the allowlist, not a denylist.
const GROUND_CAPABLE = new Set(['codex']);
export function groundCapable(name) {
  return GROUND_CAPABLE.has(name);
}

export function isAvailable(name) {
  const override = overridePath(name);
  if (override) return existsSync(override);
  if (!(name in BUILTIN)) return false;
  const [bin] = BUILTIN[name]('');
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0;
}

// Contract extraction shared by every invoke path: with expectKeys the answer MUST
// carry one of the contract arrays (findings/verdicts) — an unrelated JSON object in
// the output is a parse failure, not a success. Without expectKeys the legacy
// first-object behavior is kept for generic callers.
function extractAnswerJSON(raw, expectKeys) {
  return expectKeys ? extractContractJSON(raw, expectKeys) : extractJSON(raw);
}
function jsonMissingError(expectKeys) {
  return expectKeys ? `no ${expectKeys.join('/')} JSON in output` : 'no JSON object in output';
}

// Append the most likely CAUSE to a parse/empty failure. On exit 0 with no usable
// answer, the reason is on stderr (a CLI/model error printed but exit-0'd) — surface its
// TAIL (where the actual message sits, after banners/spinners). If stderr is empty too,
// say the stdout was empty. Strips ANSI so the reason is readable in status/verdict.
export function withStderrReason(baseError, stdout, stderr) {
  const clean = String(stderr || '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').trim();
  if (clean) return `${baseError} — ${clean.slice(-400)}`;
  if (!String(stdout || '').trim()) return `${baseError} (empty output — the CLI produced nothing)`;
  return baseError;
}

/** Invoke a provider with a prompt; capture stdout and extract a JSON object. */
export function invokeProvider(name, prompt, { timeout = 180_000, model = null, expectKeys = null } = {}) {
  const resolved = resolveCommand(name, prompt, model);
  if (!resolved) return { ok: false, error: `unknown provider: ${name}`, raw: '', json: null };
  const [cmd, args] = resolved;
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024, env: process.env, ...promptSpawnOpts(name) });
  if (res.error) {
    return { ok: false, error: String(res.error.message || res.error), raw: '', json: null };
  }
  if (res.status !== 0) {
    return { ok: false, error: `exit ${res.status}: ${(res.stderr || '').trim().slice(0, 300)}`, raw: res.stdout || '', json: null };
  }
  const raw = res.stdout || '';
  const json = extractAnswerJSON(raw, expectKeys);
  if (!json) return { ok: false, error: withStderrReason(jsonMissingError(expectKeys), raw, res.stderr), raw, json: null };
  return { ok: true, error: null, raw, json };
}

/**
 * Async variant of invokeProvider — non-blocking so multiple models run in parallel.
 * When `stream` is set and the provider has a streaming profile, delegate to the
 * structured-streaming path (live token/cost events). Otherwise the original raw
 * path is used unchanged, so the default flow and its tests never regress.
 */
// Idle-reset timeout guard with an absolute backstop. `timeout` is the IDLE window: the child is
// killed only after it produces NO output for this long (genuinely stalled), so a model that keeps
// streaming keeps running — this is the dynamic, activity-based extension. `maxTimeout` is a hard
// wall-clock cap so a runaway can't stream forever. The two paths fire DISTINCT errors so a caller
// (and the dashboard) can tell "stalled" (hung) from "cap" (working but too long) — and both apart
// from a real exit-code/parse failure. Returns { touch, clear }: call touch() on every byte of
// output, clear() when the process settles.
function makeTimeoutGuard(timeout, maxTimeout, onKill) {
  const cap = maxTimeout && maxTimeout > timeout ? maxTimeout : Math.max(timeout * 2, timeout + 120_000);
  let idleTimer = null, hardTimer = null, done = false;
  const clear = () => { done = true; if (idleTimer) clearTimeout(idleTimer); if (hardTimer) clearTimeout(hardTimer); idleTimer = hardTimer = null; };
  const touch = () => {
    if (done) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { clear(); onKill(`stalled: no output for ${Math.round(timeout / 1000)}s`, 'idle'); }, timeout);
  };
  hardTimer = setTimeout(() => { clear(); onKill(`timeout ${Math.round(cap / 1000)}s wall-clock cap (was still producing output)`, 'cap'); }, cap);
  touch(); // arm immediately — silence from spawn to first byte also counts toward the idle window
  return { touch, clear };
}

// ── round-to-round session reuse (t5, docs/x-panel-term-mesh-phase2.md) ──────
//
// Round 2 (refute) used to re-send the full target to a cold process. With a
// provider session, round 1 creates it and round 2 resumes it with only the
// delta (the others' findings) — the target is already in the session context.

/** Providers whose CLI supports resuming a prior session non-interactively. */
export function supportsResume(name) {
  return name === 'claude' || name === 'codex';
}

// Matches the session id a CLI prints in its run banner (codex exec does; the
// capture is tolerant of "session id:", "session_id=", etc.). Exported so the
// live spike (x-panel/test/spike-resume.mjs) exercises the SHIPPED capture path.
export const SESSION_ID_RE = /session[ _-]?id[:=\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Session-aware argv. `session = { mode: 'create'|'resume', id: string|null }`.
 *  - claude: create ⇒ `--session-id <uuid>` (caller supplies the uuid — verified
 *    print-mode round-trip in x-panel/test/spike-resume.mjs); resume ⇒ `--resume <uuid>`.
 *  - codex: create ⇒ plain exec (the session is implicit; its id is CAPTURED from
 *    the run banner); resume ⇒ `exec … resume <id>` via buildCodexResumeArgs.
 *    NEVER `resume --last` here: a panel can hold several codex sessions (plus any
 *    user codex activity), and "most recent" would silently splice the wrong
 *    context — a wrong-session resume SUCCEEDS, so no fallback would catch it.
 *  - other providers ignore `session` (stateless, argv unchanged).
 * Returns null only for codex resume without an id — the caller must not ask for that.
 */
export function resolveSessionCommand(name, prompt, model, session) {
  if (!session) return resolveCommand(name, prompt, model);
  const override = overridePath(name);
  if (override) {
    return ['node', [override, name, prompt, '--session-mode', session.mode, ...(session.id ? ['--session-id', session.id] : [])]];
  }
  if (name === 'claude' && session.id) {
    // Keep --output-format json on the session path too, or round 2 loses usage and
    // (worse) returns an un-unwrapped envelope to the verdict parser.
    return ['claude', ['-p', '--output-format', 'json', ...(model ? ['--model', model] : []), session.mode === 'resume' ? '--resume' : '--session-id', session.id, prompt]];
  }
  if (name === 'codex' && session.mode === 'resume') {
    if (!session.id) return null;
    // --json on the resume leg too: round 2 must stay parseable (JSONL) and keep reporting usage.
    return buildCodexResumeArgs({ execFlags: ['--json', '--sandbox', 'read-only', '--skip-git-repo-check'], sessionId: session.id, model, prompt });
  }
  return resolveCommand(name, prompt, model);
}

export async function invokeProviderAsync(name, prompt, { timeout = 180_000, maxTimeout = null, model = null, onEvent = null, stream = false, partial = true, session = null, fallbackPrompt = null, expectKeys = null } = {}) {
  if (stream && supportsStream(name)) {
    // Session reuse is a raw-path feature: the structured-stream argv is kept
    // exactly as dogfooded. Callers already disable sessions under --stream.
    return invokeProviderStream(name, prompt, { timeout, maxTimeout, model, onEvent, partial, expectKeys });
  }
  const use = session && supportsResume(name) ? session : null;
  let res = await invokeProviderRaw(name, prompt, { timeout, maxTimeout, model, onEvent, session: use, expectKeys });
  if (use) {
    if (res.ok) {
      if (use.mode === 'resume') res.resume = 'ok';
    } else if (fallbackPrompt != null) {
      // LOUD stateless fallback (contract R4): same semantics, just costlier —
      // surfaced via a lifecycle event and the `resume: 'fallback'` marker.
      if (onEvent) {
        try { onEvent({ at: new Date().toISOString(), type: 'lifecycle', provider: name, model, note: `session ${use.mode} failed (${res.error}) — retrying stateless` }); } catch { /* observer only */ }
      }
      res = await invokeProviderRaw(name, fallbackPrompt, { timeout, maxTimeout, model, onEvent, session: null, expectKeys });
      res.resume = 'fallback';
    }
  }
  return res;
}

function invokeProviderRaw(name, prompt, { timeout = 180_000, maxTimeout = null, model = null, onEvent = null, session = null, expectKeys = null } = {}) {
  return new Promise((resolve) => {
    const emit = (event) => {
      if (!onEvent) return;
      try { onEvent({ at: new Date().toISOString(), ...event }); } catch { /* observer only */ }
    };
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const resolved = resolveSessionCommand(name, prompt, model, session);
    if (!resolved) {
      return resolve({
        ok: false,
        error: session ? `resume requested for ${name} without a session id` : `unknown provider: ${name}`,
        raw: '', json: null,
      });
    }
    const [cmd, args] = resolved;
    let child;
    try {
      // stdin must be closed (ignore) or non-interactive CLIs like codex/agy hang
      // waiting for input — spawnSync closes it automatically, spawn does not.
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, ...promptSpawnOpts(name) });
    } catch (e) {
      return resolve({ ok: false, error: String(e.message || e), raw: '', json: null });
    }
    emit({ type: 'spawn', provider: name, model, pid: child.pid, command: cmd });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const guard = makeTimeoutGuard(timeout, maxTimeout, (error, reason) => {
      emit({ type: 'timeout', provider: name, model, error, reason });
      child.kill('SIGKILL');
      finish({ ok: false, error, raw: stdout, json: null });
    });
    child.stdout.on('data', (d) => {
      stdout += d;
      guard.touch(); // output = alive → extend the idle window
      emit({ type: 'stdout', provider: name, model, bytes: Buffer.byteLength(d), text: d });
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      guard.touch(); // progress/heartbeat on stderr (spinners, cost lines) also counts as activity
      emit({ type: 'stderr', provider: name, model, bytes: Buffer.byteLength(d), text: d });
    });
    child.on('error', (e) => {
      guard.clear();
      const error = String(e.message || e);
      emit({ type: 'error', provider: name, model, error });
      finish({ ok: false, error, raw: '', json: null });
    });
    child.on('close', (code, signal) => {
      guard.clear();
      if (settled) return;
      emit({ type: 'exit', provider: name, model, code });
      // Structured-output vendors (claude --output-format json) wrap the answer in an
      // envelope carrying usage + total_cost_usd. Unwrap FIRST: findings extraction must
      // see the model's answer, not the envelope (which has no findings array). `raw`
      // downstream means "what the model said", so it carries the unwrapped text too —
      // the envelope's extras are lifted into usage/session instead of being re-parsed.
      const env = parseStructuredOutput(name, stdout, model);
      const answer = env.text;
      // Structured usage wins; kiro still reports a cost line on stderr in raw mode.
      const usage = env.usage || parseStderrUsage(name, stderr);
      if (usage) emit({ type: 'usage_final', provider: name, model, usage });
      if (code !== 0) return finish({ ok: false, error: `${exitLabel(code, signal)}: ${stderr.trim().slice(0, 300)}`, raw: answer, json: null, usage });
      if (env.error) {
        emit({ type: 'error', provider: name, model, error: env.error });
        return finish({ ok: false, error: env.error, raw: answer, json: null, usage });
      }
      const json = extractAnswerJSON(answer, expectKeys);
      if (!json) {
        emit({ type: 'json_missing', provider: name, model });
        // Exit 0 but no parseable answer: the CLI almost always explained WHY on stderr
        // (e.g. kiro's Bedrock "ValidationException: input_schema does not support oneOf")
        // or via an empty stdout. Surfacing that turns a vague "no findings JSON" into the
        // real cause, instead of forcing a dig through raw files (L6).
        return finish({ ok: false, error: withStderrReason(jsonMissingError(expectKeys), answer, stderr), raw: answer, json: null, usage });
      }
      emit({ type: 'json_parsed', provider: name, model });
      // Session establishment (t5): claude's id is caller-supplied (authoritative);
      // codex discloses its id in the run banner — captured or null (⇒ no resume).
      let session_id = null;
      let captureFailed = false;
      if (session && session.mode === 'create') {
        if (name === 'claude') session_id = session.id;
        // codex: the id now comes from the CLI's own `thread.started` JSONL event
        // (parseStructuredOutput). Under `exec --json` the stderr banner is gone entirely,
        // so SESSION_ID_RE has nothing to match — but the trust boundary that motivated
        // stderr-only capture still holds: model text is escaped INSIDE
        // item.completed.item.text and cannot forge a top-level thread.started line.
        // The stderr regex remains as a fallback for a CLI that still prints a banner.
        else {
          session_id = env.sessionId || (SESSION_ID_RE.exec(stderr) || [])[1] || null;
          if (!session_id) {
            // A missing banner is a CAPTURE FAILURE, distinct from a vendor that never
            // supports resume — surface it (L6) so it can't hide as plain "stateless".
            captureFailed = true;
            emit({ type: 'lifecycle', provider: name, model, note: 'session capture failed — no thread.started event (nor a run banner); round 2 will run stateless' });
          }
        }
      }
      finish({ ok: true, error: null, raw: answer, json, usage, ...(session_id ? { session_id } : {}), ...(captureFailed ? { session_capture_failed: true } : {}) });
    });
  });
}

// ── structured streaming (live token/cost) ───────────────────────────
//
// Separate from the raw path above: stream-capable CLIs are invoked with their
// JSONL/stream-json flags, each line is parsed into normalized events, and the
// final answer text (not the envelope) is what findings are extracted from.

// Streaming command builders — deliberately NOT merged into BUILTIN so the raw
// (sync) path and its tests keep their exact argv.
const STREAM_BUILTIN = {
  // When `partial` is on, --include-partial-messages / --stream-partial-output emit
  // token-level text deltas (verified: claude → stream_event/content_block_delta/text_delta;
  // cursor → incremental assistant events). With partial off, the stream is still structured
  // (usage + final text) but the body arrives in one block — faster on very large inputs.
  // codex has no partial mode, so it stays final-block regardless.
  claude: (prompt, model, partial) => ['claude', ['-p', '--output-format', 'stream-json', ...(partial ? ['--include-partial-messages'] : []), '--verbose', ...(model ? ['--model', model] : []), prompt]],
  cursor: (prompt, model, partial) => ['cursor-agent', ['-p', '-f', '--output-format', 'stream-json', ...(partial ? ['--stream-partial-output'] : []), ...(model ? ['--model', model] : []), prompt]], // -f bypasses workspace-trust
  codex: (prompt, model) => {
    // --sandbox read-only prevents the agent from editing the repo; --json streams JSONL events.
    // "model[:effort]" → --model <id> + -c model_reasoning_effort=<effort> (codexModelArgs).
    return ['codex', ['exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', ...codexModelArgs(model), prompt]];
  },
};

// Only providers with a real streaming profile use the structured-stream path.
// An X_PANEL_CMD_* override does NOT make a provider stream-capable — the agy
// wrapper emits plain text, so agy/kiro must stay on the raw path even under
// --stream. (Test stubs override claude/codex, which ARE in STREAM_BUILTIN, so
// the stream path is still exercised.)
export function supportsStream(name) {
  return Object.prototype.hasOwnProperty.call(STREAM_BUILTIN, name);
}

/** The real streaming argv for a provider (no override) — for tests/inspection. */
export function streamCommand(name, prompt = '', model = null, partial = true) {
  const fn = STREAM_BUILTIN[name];
  return fn ? fn(prompt, model, partial) : null;
}

function resolveStreamCommand(name, prompt, model, partial) {
  const override = overridePath(name);
  if (override) return ['node', [override, name, prompt, '--stream', ...(partial ? ['--partial'] : [])]]; // hint the stub
  const fn = STREAM_BUILTIN[name];
  return fn ? fn(prompt, model || null, partial) : null;
}

// Approximate USD per 1M tokens. INLINE on purpose — importing x-build/cost-engine
// (even dynamically) throws under the versioned plugin-cache layout (see x-memory
// cache-crash lesson). claude reports its own total_cost_usd (authoritative, used
// directly); this table only estimates cursor/codex. PLACEHOLDER values — calibrate.
const PRICE_PER_MTOK = {
  'claude-opus-4-8': { input: 15, output: 75, cached: 1.5 },
  'claude-opus-4.8': { input: 15, output: 75, cached: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cached: 0.3 },
  default: { input: 5, output: 15, cached: 0.5 },
};
function priceFor(model) { return PRICE_PER_MTOK[model] || PRICE_PER_MTOK.default; }
export function costFromTokens(model, t) {
  const p = priceFor(model);
  const uncached = Math.max(0, (t.input || 0) - (t.cached || 0));
  return (uncached * p.input + (t.cached || 0) * p.cached + (t.output || 0) * p.output) / 1e6;
}

/**
 * Unwrap a structured-output ENVELOPE into the model's answer text + usage.
 *
 * claude `-p --output-format json` returns ONE object:
 *   { type:"result", subtype:"success", is_error:false, result:"<answer>",
 *     session_id, total_cost_usd, usage:{ input_tokens, output_tokens,
 *     cache_creation_input_tokens, cache_read_input_tokens }, … }
 *
 * The answer lives in `.result` — findings extraction MUST run on that, not on the
 * envelope (which carries no findings/verdicts array, so every parse would fail).
 * Cost is already computed by the CLI, so no per-token price math is needed.
 *
 * Detection is by SHAPE (`type:"result"`), not by vendor: a stubbed provider that
 * prints plain findings JSON is passed through untouched, and a claude run that ever
 * emits non-envelope output degrades gracefully to the plain path.
 *
 * @returns {{ text: string, usage: object|null, error: string|null }}
 */
export function unwrapEnvelope(stdout) {
  const s = String(stdout || '').trim();
  if (!s.startsWith('{')) return { text: stdout, usage: null, error: null };
  let env;
  try { env = JSON.parse(s); } catch { return { text: stdout, usage: null, error: null }; }
  if (!env || typeof env !== 'object' || env.type !== 'result') {
    return { text: stdout, usage: null, error: null };
  }
  const u = env.usage || {};
  // Canonical panel token buckets — the same shape the stream path emits and the status
  // accumulator sums ({input, output, cached, reasoning}). Emitting anything else leaves
  // every bucket at zero while the cost silently lands (measured on the first live run).
  // cache_creation is billed as fresh input; cache_read is the cheap re-use bucket.
  const usage = {
    input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    output: u.output_tokens || 0,
    cached: u.cache_read_input_tokens || 0,
    reasoning: 0,
    // The CLI already priced the turn (incl. cache tiers) — trust it over local rates.
    cost_usd: typeof env.total_cost_usd === 'number' ? env.total_cost_usd : null,
  };
  const failed = env.is_error === true || (env.subtype && env.subtype !== 'success');
  return {
    text: typeof env.result === 'string' ? env.result : '',
    usage,
    error: failed ? `provider reported ${env.subtype || 'error'}${env.api_error_status ? ` (${env.api_error_status})` : ''}` : null,
  };
}

/**
 * Parse a JSONL structured-output stream (codex `exec --json`) from the RAW path.
 *
 *   {"type":"thread.started","thread_id":"019f…"}          ← the session id
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}   ← the answer
 *   {"type":"turn.completed","usage":{input_tokens, cached_input_tokens, …}}
 *
 * Reuses parseStreamLine — the same parser the streaming path has been running against
 * this exact format — instead of introducing a second, unproven one.
 *
 * TRUST BOUNDARY: session capture used to read ONLY stderr, because stdout was raw model
 * output and a prompt-injected review target could forge a `session id: <uuid>` line to
 * steer round 2's `--resume`. Under `--json` that no longer holds: the model's text is
 * ESCAPED INSIDE an `item.completed.item.text` string and cannot break out to become a
 * top-level `thread.started` line. Taking the FIRST such event keeps it deterministic.
 * (The stderr banner is gone entirely under --json — measured, so there is no fallback.)
 */
export function parseJsonlOutput(name, stdout, model) {
  let text = '';
  let usage = null;
  let sessionId = null;
  for (const line of String(stdout || '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    let obj;
    try { obj = JSON.parse(s); } catch { continue; } // a torn line is not fatal
    if (!sessionId && obj.type === 'thread.started' && typeof obj.thread_id === 'string') {
      sessionId = obj.thread_id;
    }
    const r = parseStreamLine(name, obj, model);
    if (typeof r.finalText === 'string' && r.finalText) text = r.finalText;
    if (r.usage) usage = r.usage;
  }
  return { text, usage, sessionId };
}

/**
 * Route a vendor's stdout through the right structured-output reader.
 * claude → single result envelope; codex → JSONL event stream; everything else → plain text.
 * @returns {{ text: string, usage: object|null, error: string|null, sessionId: string|null }}
 */
export function parseStructuredOutput(name, stdout, model) {
  if (name === 'claude') {
    const e = unwrapEnvelope(stdout);
    return { ...e, sessionId: null }; // claude's id is caller-supplied, never parsed
  }
  if (name === 'codex') {
    const j = parseJsonlOutput(name, stdout, model);
    return { text: j.text, usage: j.usage, error: null, sessionId: j.sessionId };
  }
  return { text: stdout, usage: null, error: null, sessionId: null };
}

/** kiro (raw mode) prints `▸ Credits: 0.30 • Time: 4s` on stderr (ANSI-wrapped). */
function parseStderrUsage(name, stderr) {
  if (name !== 'kiro') return null;
  const clean = String(stderr || '').replace(/\x1b\[[0-9;]*[mGKH]/g, '');
  const m = clean.match(/Credits:\s*([0-9.]+)/i);
  return m ? { credits: parseFloat(m[1]), cost_usd: null } : null;
}

/** Extract text from a cursor stream event — text lives in message.content[].text. */
function cursorEventText(obj) {
  if (typeof obj.text === 'string') return obj.text;
  const c = obj.message && obj.message.content;
  if (Array.isArray(c)) return c.map((b) => (b && b.type === 'text' && b.text ? b.text : '')).join('');
  if (obj.message && typeof obj.message.text === 'string') return obj.message.text;
  return '';
}

/**
 * Parse ONE provider JSONL line into normalized events + optional final
 * text/usage. Returns { events, finalText?, usage? }. Unknown lines → no events.
 */
export function parseStreamLine(name, obj, model) {
  const events = [];
  let finalText, usage;
  const setUsage = (tokens, cost_usd) => {
    const cost = (cost_usd != null) ? cost_usd : costFromTokens(model, tokens);
    usage = { ...tokens, cost_usd: cost };
    events.push({ kind: 'usage', tokens, cost_usd: cost });
  };
  if (name === 'claude') {
    // Token-level deltas (--include-partial-messages): stream_event → content_block_delta.
    // We take live text ONLY from these deltas; the aggregate `assistant` event is the
    // SAME text re-emitted, so handling it too would double-count the tail.
    if (obj.type === 'stream_event' && obj.event && obj.event.type === 'content_block_delta' && obj.event.delta) {
      const d = obj.event.delta;
      if (d.type === 'text_delta' && d.text) events.push({ kind: 'text', delta: d.text });
      else if (d.type === 'thinking_delta' && d.thinking) events.push({ kind: 'thinking', delta: d.thinking });
      // signature_delta and others: ignore
    } else if (obj.type === 'result') {
      if (typeof obj.result === 'string') finalText = obj.result;
      const u = obj.usage || {};
      setUsage({ input: u.input_tokens || 0, output: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0, reasoning: 0 }, obj.total_cost_usd);
    }
  } else if (name === 'cursor') {
    // --stream-partial-output: response deltas arrive as incremental `assistant` events,
    // thinking deltas as `thinking` events; text lives in message.content[].text.
    if (obj.type === 'thinking') {
      const d = cursorEventText(obj);
      events.push(d ? { kind: 'thinking', delta: d } : { kind: 'thinking' });
    } else if (obj.type === 'text' || obj.type === 'assistant') {
      const d = cursorEventText(obj);
      if (d) events.push({ kind: 'text', delta: d });
    } else if (obj.type === 'result') {
      if (typeof obj.result === 'string') finalText = obj.result;
      const u = obj.usage || {};
      setUsage({ input: u.inputTokens || 0, output: u.outputTokens || 0, cached: u.cacheReadTokens || 0, reasoning: 0 });
    }
  } else if (name === 'codex') {
    if (obj.type === 'thread.started' || obj.type === 'turn.started') {
      events.push({ kind: 'lifecycle', note: obj.type });
    } else if (obj.type === 'item.completed' && obj.item && obj.item.type === 'agent_message') {
      finalText = obj.item.text || '';
      if (finalText) events.push({ kind: 'text', delta: finalText });
    } else if (obj.type === 'turn.completed') {
      const u = obj.usage || {};
      // codex's input_tokens is the TOTAL prompt, of which cached_input_tokens were served
      // from cache (OpenAI convention) — unlike claude, whose buckets are disjoint. Counting
      // both whole double-billed the cached prefix in costFromTokens; subtract it so `input`
      // means FRESH input, matching the claude mapping and the bucket's name.
      const cached = u.cached_input_tokens || 0;
      setUsage({
        input: Math.max(0, (u.input_tokens || 0) - cached),
        output: u.output_tokens || 0,
        cached,
        reasoning: u.reasoning_output_tokens || 0,
      });
    }
  }
  return { events, finalText, usage };
}

function invokeProviderStream(name, prompt, { timeout = 180_000, maxTimeout = null, model = null, onEvent = null, partial = true, expectKeys = null } = {}) {
  return new Promise((resolve) => {
    const emit = (event) => { if (!onEvent) return; try { onEvent({ at: new Date().toISOString(), ...event }); } catch { /* observer only */ } };
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const resolved = resolveStreamCommand(name, prompt, model, partial);
    if (!resolved) return resolve({ ok: false, error: `no stream profile: ${name}`, raw: '', json: null });
    const [cmd, args] = resolved;
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, ...promptSpawnOpts(name) }); }
    catch (e) { return resolve({ ok: false, error: String(e.message || e), raw: '', json: null }); }
    emit({ type: 'spawn', provider: name, model, pid: child.pid, command: cmd, mode: partial ? 'stream-partial' : 'stream' });

    // Bounds — the async path has no maxBuffer, so cap every accumulator.
    const RAW_CAP = 2_000_000, TEXT_CAP = 1_000_000, LINE_CAP = 4_000_000, ERR_CAP = 200_000;
    let rawCap = '', buf = '', textBuf = '', stderr = '';
    let finalText = null, usage = null;

    const handleLine = (line) => {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch { return; } // skip non-JSON notices
      const r = parseStreamLine(name, obj, model);
      for (const ev of r.events) {
        if (ev.kind === 'text' && ev.delta && textBuf.length < TEXT_CAP) textBuf += ev.delta;
        emit({ type: ev.kind, provider: name, model, ...ev });
      }
      if (r.finalText != null) finalText = r.finalText;
      if (r.usage) usage = r.usage;
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const guard = makeTimeoutGuard(timeout, maxTimeout, (error) => {
      emit({ type: 'timeout', provider: name, model, error });
      child.kill('SIGKILL');
      finish({ ok: false, error, raw: rawCap, json: null, usage });
    });
    child.stdout.on('data', (d) => {
      guard.touch(); // streaming tokens = alive → reset the idle window (working models keep going)
      if (rawCap.length < RAW_CAP) rawCap += d;
      buf += d;
      if (buf.length > LINE_CAP) buf = buf.slice(buf.length - LINE_CAP); // overflow guard for newline-less floods
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); handleLine(line); }
    });
    child.stderr.on('data', (d) => { guard.touch(); stderr += d; if (stderr.length > ERR_CAP) stderr = stderr.slice(-ERR_CAP); emit({ type: 'stderr', provider: name, model, bytes: Buffer.byteLength(d), text: d }); });
    child.on('error', (e) => { guard.clear(); emit({ type: 'error', provider: name, model, error: String(e.message || e) }); finish({ ok: false, error: String(e.message || e), raw: '', json: null }); });
    child.on('close', (code, signal) => {
      guard.clear();
      if (settled) return;
      if (buf.trim()) handleLine(buf); // flush the trailing (unterminated) line — carries final result/usage
      emit({ type: 'exit', provider: name, model, code });
      if (usage) emit({ type: 'usage_final', provider: name, model, usage });
      // A non-zero exit is a failure REGARDLESS of any JSON in partial output —
      // otherwise a crashed provider whose stream happened to contain a JSON object
      // would be reported as a successful review (matches the raw path's contract).
      if (code !== 0) return finish({ ok: false, error: `${exitLabel(code, signal)}: ${stderr.trim().slice(0, 300)}`, raw: rawCap, json: null, usage });
      // Findings come from the final answer text (NOT the raw JSONL envelope).
      const text = finalText != null ? finalText : textBuf;
      let json = extractAnswerJSON(text, expectKeys);
      // rawCap fallback is ALWAYS shape-guarded (even without expectKeys): a JSONL
      // envelope line (e.g. {"type":"system"}) must NOT be mistaken for a successful
      // review, so only an object actually carrying findings/verdicts is accepted.
      if (!json) {
        json = extractContractJSON(rawCap, expectKeys || ['findings', 'verdicts']);
      }
      if (!json) { emit({ type: 'json_missing', provider: name, model }); return finish({ ok: false, error: withStderrReason(jsonMissingError(expectKeys), rawCap, stderr), raw: rawCap, json: null, usage }); }
      emit({ type: 'json_parsed', provider: name, model });
      finish({ ok: true, error: null, raw: rawCap, json, usage });
    });
  });
}

/**
 * Invoke a provider and return its RAW text output (no JSON requirement). Used by
 * generic cross-vendor deliberation (debate/council) where the answer is free-form
 * prose, not findings JSON. ok = process exited 0.
 */
export function invokeProviderText(name, prompt, { timeout = 180_000, maxTimeout = null, model = null, onEvent = null } = {}) {
  return new Promise((resolve) => {
    // Observer-only progress events (same shapes as invokeProviderAsync's raw path:
    // spawn/stdout/stderr/timeout/error/exit) so a cross-vendor caller can write a live
    // status heartbeat. Never throws into the invocation.
    const emit = (event) => {
      if (!onEvent) return;
      try { onEvent({ at: new Date().toISOString(), ...event }); } catch { /* observer only */ }
    };
    const resolved = resolveCommand(name, prompt, model);
    if (!resolved) return resolve({ ok: false, output: '', error: `unknown provider: ${name}` });
    const [cmd, args] = resolved;
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, ...promptSpawnOpts(name) }); }
    catch (e) { return resolve({ ok: false, output: '', error: String(e.message || e) }); }
    emit({ type: 'spawn', provider: name, model, pid: child.pid, command: cmd });
    let stdout = '', stderr = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Idle-reset timeout: a vendor still streaming text keeps going; only true silence kills it.
    // `timedOut: true` marks this as a timeout/stall (not an exit code) so callers can decide NOT
    // to retry a hung provider by checking the FLAG, never by substring-matching the error text.
    const guard = makeTimeoutGuard(timeout, maxTimeout, (error, reason) => {
      emit({ type: 'timeout', provider: name, model, error, reason });
      child.kill('SIGKILL');
      done({ ok: false, output: stdout, error, timedOut: true });
    });
    child.stdout.on('data', (d) => { guard.touch(); stdout += d; if (stdout.length > 16 * 1024 * 1024) stdout = stdout.slice(-16 * 1024 * 1024); emit({ type: 'stdout', provider: name, model, bytes: Buffer.byteLength(d), text: d }); });
    child.stderr.on('data', (d) => { guard.touch(); stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-200_000); emit({ type: 'stderr', provider: name, model, bytes: Buffer.byteLength(d), text: d }); });
    child.on('error', (e) => { guard.clear(); const error = String(e.message || e); emit({ type: 'error', provider: name, model, error }); done({ ok: false, output: '', error }); });
    child.on('close', (code, signal) => {
      guard.clear();
      if (settled) return;
      emit({ type: 'exit', provider: name, model, code });
      // Cross returns the vendor's RAW TEXT to its caller, so a structured-output envelope
      // must be unwrapped here too — otherwise every cross consumer (debate/council/solve)
      // would receive the JSON envelope instead of the model's prose. Usage rides along,
      // giving the cross path the token/cost telemetry it never had.
      const env = parseStructuredOutput(name, stdout, model);
      if (env.usage) emit({ type: 'usage_final', provider: name, model, usage: env.usage });
      if (code !== 0) return done({ ok: false, output: env.text, error: `${exitLabel(code, signal)}: ${stderr.trim().slice(0, 300)}`, usage: env.usage || null });
      if (env.error) { emit({ type: 'error', provider: name, model, error: env.error }); return done({ ok: false, output: env.text, error: env.error, usage: env.usage || null }); }
      const out = String(env.text || '').trim();
      // exit 0 but EMPTY stdout: a gateway CLI (cursor especially, also agy) can return
      // success with no answer — transient rate-limit, silent auth refusal, or an empty
      // completion. The raw-text path used to pass this through as ok:true/output:'' →
      // the result was silently blanked in the panel (the "can't capture cursor" case).
      // Treat empty-on-success as a failure so it's surfaced loud (L6) and is retryable,
      // forwarding any stderr as the reason.
      if (!out) return done({ ok: false, output: '', error: `exit 0 but empty output${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ' (no stdout from CLI)'}` });
      done({ ok: true, output: out, error: null, usage: env.usage || null });
    });
  });
}

// Preflight probe: run one tiny prompt in stream-json mode and report (a) liveness
// — did the CLI answer with any text on exit 0 — and (b) the ACTUAL model the CLI
// resolved, captured from the provider's own stream-json `model` field. That field
// is the only reliable source of the real model when no explicit --model was passed
// (the CLI picks its own default and never tells the caller otherwise). Unlike the
// review stream path this accepts free text (no findings-JSON requirement), and it
// falls back to raw-text liveness (model unknown) for providers with no stream profile.
export function probeProvider(name, { timeout = 45_000, model = null } = {}) {
  return new Promise((resolve) => {
    const resolved = resolveStreamCommand(name, 'Reply with exactly: OK', model, false);
    if (!resolved) {
      return invokeProviderText(name, 'Reply with exactly: OK', { timeout, model })
        .then((r) => resolve({ ok: r.ok, model: null, text: (r.output || '').trim(), error: r.error || null, timedOut: !!r.timedOut }))
        .catch((err) => resolve({ ok: false, model: null, text: '', error: String(err?.message || err) }));
    }
    const [cmd, args] = resolved;
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, ...promptSpawnOpts(name) }); }
    catch (e) { return resolve({ ok: false, model: null, text: '', error: String(e.message || e) }); }
    let stdout = '', stderr = '', buf = '', text = '', actualModel = null, sawJson = false, settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const guard = makeTimeoutGuard(timeout, null, (error) => { child.kill('SIGKILL'); done({ ok: false, model: actualModel, text: text.trim(), error, timedOut: true }); });
    const handleLine = (line) => {
      const s = line.trim();
      if (!s) return;
      let o; try { o = JSON.parse(s); } catch { return; }
      sawJson = true;
      if (!actualModel) {
        if (typeof o.model === 'string' && o.model) actualModel = o.model;
        else if (o.message && typeof o.message.model === 'string' && o.message.model) actualModel = o.message.model;
      }
      const r = parseStreamLine(name, o, model);
      for (const ev of r.events) if (ev.kind === 'text' && ev.delta) text += ev.delta;
      if (r.finalText != null) text = r.finalText;
    };
    child.stdout.on('data', (d) => { guard.touch(); stdout += d; buf += d; let nl; while ((nl = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
    child.stderr.on('data', (d) => { guard.touch(); stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-200_000); });
    child.on('error', (e) => { guard.clear(); done({ ok: false, model: actualModel, text: '', error: String(e.message || e) }); });
    child.on('close', (code, signal) => {
      guard.clear();
      if (buf.trim()) handleLine(buf);
      // Liveness = a real answer. If the CLI spoke stream-json (sawJson), require the
      // PARSED answer text — a bare JSONL envelope with no answer is NOT alive. Only
      // when the CLI emitted no JSON at all (e.g. kiro's plain-text mode) do we accept
      // raw stdout as the answer.
      const t = (sawJson ? text : (text || stdout)).trim();
      if (code !== 0) return done({ ok: false, model: actualModel, text: t, error: `${exitLabel(code, signal)}: ${stderr.trim().slice(0, 300)}` });
      if (!t) return done({ ok: false, model: actualModel, text: '', error: `exit 0 but empty output${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}` });
      done({ ok: true, model: actualModel, text: t, error: null });
    });
  });
}

/** Extract the first balanced top-level JSON object from text. */
export function extractJSON(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Scan EVERY balanced top-level {...} candidate in `text`, not just the first.
 * A candidate that fails JSON.parse (a prose "{placeholder}") is skipped and the
 * scan resumes right after its opening brace — extractJSON returns null in that
 * case and drops any real answer that follows it. Returns [{ obj, start, end }]
 * in document order. `limit` bounds the number of scan attempts so adversarial
 * brace-floods can't go quadratic.
 */
export function scanJSONObjects(text, limit = 32) {
  const out = [];
  if (!text) return out;
  let from = 0;
  for (let attempts = 0; attempts < limit; attempts++) {
    const start = text.indexOf('{', from);
    if (start < 0) break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) { from = start + 1; continue; } // unbalanced — an inner object may still close
    try {
      out.push({ obj: JSON.parse(text.slice(start, end)), start, end });
      from = end;
    } catch {
      from = start + 1; // prose brace — keep scanning past it
    }
  }
  return out;
}

/**
 * Contract-aware extraction: among ALL parseable JSON objects in `text`, return the
 * one that actually carries an expected contract array (e.g. findings/verdicts).
 * Selection: largest expected-key array wins; ties → the LATER object (final-answer
 * position). Models that disobey "return ONLY JSON" tend to quote the prompt's
 * `{"findings":[]}` example inside their prose — first-object extraction (extractJSON)
 * picked that echo and silently reported 0 findings as a SUCCESS (mem-mesh ed2ff3e3).
 * Returns null when no candidate carries any expected key: for a contract round that
 * is a parse FAILURE (loud), never "0 findings".
 */
export function extractContractJSON(text, keys) {
  let best = null, bestScore = -1;
  for (const { obj } of scanJSONObjects(text)) {
    let score = -1;
    for (const k of keys) {
      if (Array.isArray(obj[k])) score = Math.max(score, obj[k].length);
    }
    if (score < 0) continue; // no contract key — envelope/echo/random JSON
    if (score >= bestScore) { best = obj; bestScore = score; } // ties → later wins
  }
  return best;
}

/**
 * The prose left over once every parseable JSON object and code-fence marker is
 * removed. A contract-compliant answer leaves ~nothing; a model that reviewed in
 * prose (and only echoed an empty contract object) leaves its whole review here.
 * Callers use the length as a "suspect empty findings" signal.
 */
export function proseOutsideJSON(text) {
  if (!text) return '';
  let out = '';
  let cursor = 0;
  for (const { start, end } of scanJSONObjects(text)) {
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);
  return out.replace(/```[a-zA-Z]*/g, '').trim();
}
