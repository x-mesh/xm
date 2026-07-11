#!/usr/bin/env node

/**
 * x-panel — Cross-Model Adversarial Review Panel (PoC)
 *
 * Tool-neutral orchestrator: calls multiple LLM CLIs headlessly, has each
 * review the same target, runs one adversarial round (each model refutes the
 * others' findings), and synthesizes a verdict. The "leader" is this CLI, not
 * a fixed model — judge is a setting (rule | <model>), so any tool that can run
 * `node x-panel-cli.mjs` orchestrates the panel.
 *
 * Usage: node lib/x-panel-cli.mjs review [target] --models claude,codex [--judge rule] [--json]
 *   target: a file path (read), a literal string, or omitted (uses `git diff HEAD`)
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';
import {
  PANEL_DIR, XM_ROOT, C, provColor, join, existsSync, ensureDir, writeJSON, readText, runId,
  loadPanelConfig, savePanelConfig,
} from './x-panel/core.mjs';
import { invokeProviderAsync, invokeProviderText, probeProvider, isAvailable, knownProviders, autodetectModels, providerMeta, checkAuth, providerReady, listModels, supportsResume, proseOutsideJSON } from './x-panel/adapters.mjs';
import { randomUUID } from 'node:crypto';
import { normalizeFindings, normalizeVerdicts, synthesize } from './x-panel/synth.mjs';
import { mergePolicy, evaluateVerdict, DEFAULT_POLICY } from './x-panel/gate.mjs';
import { createTmEventsPublisher, subscribeXkRun } from './x-panel/tm-events.mjs';
import { readEventsLog, formatEventLine, maxSeq } from './x-panel/events-log.mjs';

// ── helpers ──────────────────────────────────────────────────────────

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  // include ms so two runs in the same second don't collide on the run dir
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function gitDiff() {
  const r = spawnSync('git', ['--no-pager', 'diff', 'HEAD'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return (r.stdout || '').trim() || '(no diff against HEAD)';
}

// A label may be "codex:gpt-5"; sanitize for filesystem use.
function safeLabel(label) {
  return label.replace(/[^a-z0-9._-]/gi, '-');
}

function resolveTarget(arg) {
  if (!arg) return { kind: 'git-diff', text: gitDiff() };
  if (existsSync(arg)) return { kind: 'file', text: readText(arg) || '', ref: arg };
  return { kind: 'literal', text: arg };
}

function compactTitle(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '...' : text;
}

function redactPanelText(value) {
  return String(value || '')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, 'AKIA[redacted]')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)["']?[^"'\s,}]+/gi, '$1[redacted]');
}

function tailText(value, max = 4000) {
  const text = String(value || '');
  return text.length > max ? text.slice(text.length - max) : text;
}

/** Changed file paths from a `git diff` body (via the `diff --git a/X b/Y` headers). */
function diffFiles(diffText) {
  const files = [];
  const re = /^diff --git a\/(.+?) b\//gm;
  let m;
  while ((m = re.exec(String(diffText || '')))) files.push(m[1]);
  return files;
}

/** A meaningful, human-readable title for a panel run (not the timestamp run id). */
function targetTitle(target) {
  // literal targets are user-pasted text that may contain secrets — redact BEFORE truncating,
  // so a secret straddling the 80-char cut can't leak a fragment too short for the redaction
  // regex to match. `[redacted]` tokens are short, so truncating after redaction is safe.
  if (target.kind === 'literal') return compactTitle(redactPanelText(target.text), 80);
  if (target.kind === 'file' && target.ref) return `Review ${target.ref.split('/').pop()}`;
  if (target.kind === 'git-diff') {
    const files = diffFiles(target.text);
    if (!files.length) return 'git diff (no changes)';
    const names = files.map((f) => f.split('/').pop());
    const shown = names.slice(0, 2).join(', ');
    return files.length > 2 ? `diff: ${shown} +${files.length - 2} more` : `diff: ${shown}`;
  }
  return null;
}

// A provenance tag for a cross-vendor run (e.g. "op:debate", "build:consensus"). Constrained
// to a short, filesystem/log-safe token so a caller can't smuggle markup or newlines into the
// dashboard. null when not provided → the dashboard falls back to a generic "cross" label.
function sourceTag(value) {
  const tag = String(value || '').trim().replace(/[^a-z0-9:_./-]/gi, '-').slice(0, 40);
  return tag || null;
}

// Size-based timeout auto-raise: a bigger target/prompt needs more wall time per model. Only
// grows when --timeout was not given explicitly; capped and config-tunable. Shared by review and
// cross so cross-vendor sub-invocations get the same headroom for large prompts (not a flat base).
function autoRaiseTimeoutS(baseS, textLen, explicit, cfg, onRaise) {
  if (explicit) return baseS;
  const SOFT = cfg.timeout_soft_chars || 20000;   // grow only beyond this size
  const RATE = cfg.timeout_chars_per_s || 300;    // +1s per RATE chars over SOFT
  const MAX = cfg.timeout_max_s || 1200;          // hard cap
  if (textLen <= SOFT) return baseS;
  const scaled = Math.min(MAX, baseS + Math.ceil((textLen - SOFT) / RATE));
  if (scaled > baseS && onRaise) onRaise(scaled, MAX, textLen);
  return Math.max(baseS, scaled);
}

// First non-empty line of a prompt — a usable fallback title when --title is omitted, so a
// cross run still gets a human-ish name instead of just its timestamp id.
function firstLine(value) {
  for (const line of String(value || '').split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return null;
}

function parseFlags(raw) {
  const flags = {};
  const pos = [];
  const unknown = [];  // typo'd/unrecognized --flags — rejected before any model spawns
  // --key=value long-option form: unlike the space-separated form below, the value may legitimately
  // start with '--' (e.g. --prompt='-- note: ...'). Maps each value-flag to its stored key.
  const valueFlags = {
    '--models': 'models', '-m': 'models', '--judge': 'judge', '--preset': 'preset',
    '--review-prompt-file': 'reviewPromptFile', '--review-prompt': 'reviewPrompt',
    '--lens-tag': 'lensTag', '--prompt-file': 'promptFile', '--prompt': 'prompt',
    '--check': 'check', '--source': 'source', '--title': 'title', '--policy': 'policy',
  };
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      const key = a.slice(0, eq), val = a.slice(eq + 1);
      if (key === '--timeout') { flags.timeout = parseInt(val, 10) || undefined; continue; }
      if (valueFlags[key]) { flags[valueFlags[key]] = val; continue; }
      // unknown --key=value → fall through to positional handling below
    }
    if (a === '--json') flags.json = true;
    else if (a === '--models' || a === '-m') flags.models = raw[++i];
    else if (a === '--judge') flags.judge = raw[++i];
    else if (a === '--timeout') flags.timeout = parseInt(raw[++i], 10) || undefined;
    else if (a === '--preset') flags.preset = raw[++i];
    else if (a === '--check') flags.check = raw[++i];
    else if (a === '--policy') flags.policy = raw[++i];
    else if (a === '--fast') flags.preset = 'fast';
    else if (a === '--full') flags.preset = 'full';
    else if (a === '--global') flags.global = true;
    else if (a === '--auth') flags.auth = true;
    else if (a === '--probe') flags.probe = true;
    else if (a === '--stream') flags.stream = true;
    else if (a === '--no-stream') flags.stream = false;
    else if (a === '--tm-events') flags.tmEvents = true;
    else if (a === '--no-tm-events') flags.tmEvents = false;
    else if (a === '--session-reuse') flags.sessionReuse = true;
    else if (a === '--no-session-reuse') flags.sessionReuse = false;
    else if (a === '--partial') flags.partial = true;
    else if (a === '--no-partial') flags.partial = false;
    else if (a === '--watch' || a === '--follow') flags.watch = true;
    else if (a === '--logs') flags.logs = true;
    else if (a === '--fresh') flags.fresh = true;
    else if (a === '--interval') flags.interval = parseInt(raw[++i], 10) || undefined;
    else if (a === '--all') flags.all = true;
    else if (a === '--force') flags.force = true;
    // Only consume the next token as the count when it's actually numeric — a bare `--lines`
    // (or `--lines --all`) must NOT swallow the following flag. Bare → a sensible default of 3.
    else if (a === '--lines') { const nx = raw[i + 1]; flags.lines = (nx != null && /^\d+$/.test(nx)) ? (i++, Math.max(0, parseInt(nx, 10))) : 3; }
    // Take the next token as a value ONLY if it isn't another --flag (so a missing value
    // doesn't silently swallow the following option as the prompt body). '-' (stdin) is kept.
    else if (a === '--review-prompt-file') flags.reviewPromptFile = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    else if (a === '--review-prompt') flags.reviewPrompt = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined; // '-' = stdin
    else if (a === '--lens-tag') flags.lensTag = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    else if (a === '--prompt-file') flags.promptFile = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    else if (a === '--prompt') flags.prompt = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    // Provenance for cross-vendor sub-invocations: --source tags the caller (e.g. op:debate,
    // build:consensus), --title gives the run a human name. Both surface in the dashboard list.
    else if (a === '--source') flags.source = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    else if (a === '--title') flags.title = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    // A dash-prefixed token that matched no known flag is a typo (e.g. `--heolp`).
    // Routing it to positionals would make it a literal review target and fan out
    // every model on garbage — collect it for an up-front rejection instead.
    else if (a.startsWith('-') && a !== '-') unknown.push(a);
    else pos.push(a);
  }
  return { flags, pos, unknown };
}

/**
 * Resolve an injected round-1 prompt override (a custom lens instruction) from
 * --review-prompt-file <path>, or --review-prompt - (stdin) / --review-prompt "<text>".
 * Returns null when none given (→ default reviewer prompt, no behavior change).
 */
function loadPromptArg(flags, fileKey, textKey, label) {
  const fail = (msg) => { console.error(`${C.red}✗ ${msg}${C.reset}`); process.exitCode = 1; return undefined; };
  let body;
  // `'key' in flags` distinguishes "flag absent" from "flag present but value missing"
  // (parseFlags sets the key to undefined when no value follows).
  if (fileKey in flags) {
    if (!flags[fileKey]) return fail(`${label}-file needs a path`);
    body = readText(flags[fileKey]);
    if (body == null) return fail(`${label}-file: cannot read ${flags[fileKey]}`);
  } else if (textKey in flags) {
    if (flags[textKey] == null) return fail(`${label} needs a value (or - for stdin)`);
    if (flags[textKey] === '-') { try { body = readFileSync(0, 'utf8'); } catch { return fail(`${label} -: cannot read stdin`); } }
    else body = flags[textKey];
  } else {
    return null; // not supplied
  }
  // An empty/whitespace prompt would run a full multi-model run with NO instruction.
  if (!String(body).trim()) return fail(`${label} is empty`);
  return body;
}

// Review round-1 override (null = default reviewer prompt, no behavior change).
function loadPromptOverride(flags) {
  return loadPromptArg(flags, 'reviewPromptFile', 'reviewPrompt', '--review-prompt');
}

/** Decide the model set: --models flag > preset > config > autodetect installed CLIs. */
function resolveModels(flags, cfg) {
  if (flags.models) return flags.models.split(',').map(s => s.trim()).filter(Boolean);
  if (flags.preset) {
    const presets = { fast: ['claude', 'codex'], full: autodetectModels(), ...(cfg.presets || {}) };
    if (presets[flags.preset]) return presets[flags.preset];
    console.error(`${C.yellow}⚠ unknown preset "${flags.preset}" — using config/autodetect${C.reset}`);
  }
  if (Array.isArray(cfg.models) && cfg.models.length) return cfg.models;
  return autodetectModels();
}

// ── prompts ──────────────────────────────────────────────────────────

// The output contract is appended last so it FORCE-OVERRIDES any output format an
// injected lens prompt might request — findings always come back JSON-shaped.
const FINDINGS_CONTRACT = `Return ONLY a JSON object, with no prose before or after:
{"findings":[{"severity":"critical|high|medium|low","file":"path or null","line":number_or_null,"claim":"one-line issue","evidence":"why it is real, with a concrete reference"}]}
If there are no real issues, return {"findings":[]}.`;

// overrideBody (a custom per-lens instruction) replaces the default reviewer intro;
// with overrideBody=null the returned string is byte-identical to the original prompt.
function reviewPrompt(target, overrideBody = null) {
  const intro = overrideBody != null
    ? String(overrideBody).trim()
    : 'You are a code reviewer. Review the following change and report only real, evidence-backed issues.';
  return `${intro}

TARGET:
${target}

${FINDINGS_CONTRACT}`;
}

// Per-finding evidence cap in the refute prompt. Evidence is model-authored and can be
// huge; truncation is EXPLICIT (marker, never silent) so a refuter knows it judged a cut.
const REFUTE_EVIDENCE_MAX = 500;

// One findings list shared by BOTH refute prompt builders — refuters must see each
// finding's evidence (normalizeFindings preserves it; dropping it here made round 2
// judge blind), and building the list in one place keeps the two prompts in sync.
function refuteFindingsList(otherFindings) {
  return otherFindings.map((f) => {
    const head = `[${f.gref}] (${f.severity}) ${f.file ?? ''}:${f.line ?? ''} ${f.claim}`;
    const ev = String(f.evidence || '').replace(/\s+/g, ' ').trim();
    if (!ev) return head;
    const body = ev.length > REFUTE_EVIDENCE_MAX
      ? `${ev.slice(0, REFUTE_EVIDENCE_MAX).trimEnd()} … [evidence truncated]`
      : ev;
    return `${head}\n  evidence: ${body}`;
  }).join('\n') || '(none)';
}

function refutePrompt(target, otherLabel, otherFindings) {
  const list = refuteFindingsList(otherFindings);
  return `You are a skeptical second reviewer of a code change. Other reviewers (${otherLabel}) reported the findings below. For EACH finding decide whether it is a real, actionable issue.

TARGET:
${target}

FINDINGS (each tagged with a [id]):
${list}

Return ONLY a JSON object, no prose. Use the exact bracketed [id] string as "ref":
{"verdicts":[{"ref":"<id, e.g. codex#0>","stance":"refute|concede|abstain","reason":"one line"}]}
- refute = wrong, not real, or not actionable.
- concede = a real issue worth fixing.
- abstain = cannot judge from the provided evidence.`;
}

// Refute prompt for a RESUMED provider session (t5): the target is already in
// the session context from round 1, so only the others' findings travel — the
// whole point of session reuse. MUST stay semantically identical to
// refutePrompt minus the TARGET block; drift here skews the verdict (the
// findings list itself is shared via refuteFindingsList, so it cannot drift).
function refutePromptResumed(otherLabel, otherFindings) {
  const list = refuteFindingsList(otherFindings);
  return `You are now a skeptical second reviewer of the SAME code change you just reviewed — it is already in this conversation; do not ask for it again. Other reviewers (${otherLabel}) reported the findings below. For EACH finding decide whether it is a real, actionable issue.

FINDINGS (each tagged with a [id]):
${list}

Return ONLY a JSON object, no prose. Use the exact bracketed [id] string as "ref":
{"verdicts":[{"ref":"<id, e.g. codex#0>","stance":"refute|concede|abstain","reason":"one line"}]}
- refute = wrong, not real, or not actionable.
- concede = a real issue worth fixing.
- abstain = cannot judge from the provided evidence.`;
}

// ── pre-run readiness gate (shared by review AND cross) ──────────────

// A CLI on PATH but logged-out joins the panel and dies mid-round, burning every other
// model's tokens. Gate participants on providerReady (install + auth/creds — the same
// no-model-call check as `doctor`) BEFORE spawning anything. checkAuth costs up to ~12s
// per provider, so `ready` verdicts are cached with a TTL (readiness-cache.json, same
// pattern as the preflight cache): only ready=true is cached — a failing provider can be
// fixed at any moment (login) and must always re-check. Bypass the cache with --fresh;
// tune/disable with panel.readiness_ttl_s (default 1800, 0 = off). X_PANEL_CMD overrides
// are instant, so they skip the cache entirely (keeps tests hermetic).
// Returns { ready, skipped } — every exclusion is reported LOUDLY with a doctor hint.
function gateReadiness(entries, cfg, { fresh = false } = {}) {
  // --fresh bypasses cache READS only — a fresh ready=true probe still refreshes the
  // cache (throwing away the evidence --fresh just paid ~12s for would force the NEXT
  // run to probe again). readiness_ttl_s 0 disables the cache entirely (reads AND writes).
  const ttlS = cfg.readiness_ttl_s != null ? Math.max(0, Number(cfg.readiness_ttl_s) || 0) : 1800;
  const cacheOn = ttlS > 0;
  const cachePath = join(PANEL_DIR, 'readiness-cache.json');
  const cached = cacheOn ? (((readJSONSafe(cachePath) || {}).entries) || {}) : {};
  const byName = new Map(); // one check per provider NAME — claude:opus/claude:sonnet share auth
  const ready = [];
  const skipped = [];
  let wroteCache = false;
  for (const e of entries) {
    let v = byName.get(e.name);
    if (!v) {
      const overridden = !!process.env[`X_PANEL_CMD_${e.name.toUpperCase()}`];
      const hit = !overridden && !fresh && cached[e.name];
      if (hit && hit.ready && Date.now() - hit.at_ms < ttlS * 1000) {
        v = { ready: true, detail: `cached ${Math.round((Date.now() - hit.at_ms) / 1000)}s ago (--fresh to re-check)` };
      } else {
        const c = checkAuth(e.name);
        v = { ready: providerReady(c), detail: c.detail || '' };
        if (v.ready && !overridden && cacheOn) {
          cached[e.name] = { ready: true, at_ms: Date.now(), detail: v.detail };
          wroteCache = true;
        }
      }
      byName.set(e.name, v);
    }
    if (v.ready) {
      ready.push(e);
    } else {
      skipped.push({ name: e.name, label: e.label, reason: 'not_ready', detail: v.detail });
      console.error(`${C.yellow}⚠ ${e.label} not ready (${v.detail}) — excluded from this run. Check: xm panel doctor${C.reset}`);
    }
  }
  if (wroteCache) {
    // 7-day hard prune so stale provider names never pile up (mirrors the preflight cache).
    const now = Date.now();
    const entriesOut = Object.fromEntries(Object.entries(cached).filter(([, c]) => c && c.at_ms && now - c.at_ms < 7 * 86400_000));
    try { ensureDir(PANEL_DIR); writeJSON(cachePath, { schema: 1, entries: entriesOut }); } catch { /* best-effort */ }
  }
  return { ready, skipped };
}

// ── event log (shared by review AND cross) ───────────────────────────

// events.jsonl is the durable, pollable log — keep it MILESTONE-only so its size
// (and every dashboard poll that reads it) stays bounded. High-frequency deltas
// (text/thinking/stdout/stderr chunks) update the small, overwritten status.json
// instead of appending a line each time.
// stdout/stderr are kept (raw mode is coarse: 1–2 chunks, not the bloat source).
// The high-frequency stream-mode deltas (text/thinking) are deliberately absent.
const MILESTONE = new Set(['spawn', 'exit', 'timeout', 'error', 'json_parsed', 'json_missing', 'usage_final', 'lifecycle', 'stdout', 'stderr']);

// Sequenced, redacted, tail-bounded appender for a run's events.jsonl. One factory for
// review AND cross so both namespaces get identical forensics (cross had none — the
// highest-traffic path was a black box on failure).
function makeEventWriter(eventPath) {
  let seq = 0;
  let appendWarned = false;
  return (event) => {
    const record = { seq: ++seq, at: new Date().toISOString(), ...event };
    if (record.text != null) {
      const redacted = redactPanelText(record.text);
      record.text = tailText(redacted, 2000);
      record.truncated = redacted.length > record.text.length;
    }
    try {
      appendFileSync(eventPath, JSON.stringify(record) + '\n', 'utf8');
    } catch (err) {
      // The event log is forensics, not the product — never kill the run over it. But a
      // silently missing log later misreads as "legacy run" in --logs, so warn ONCE (L6).
      if (!appendWarned) {
        appendWarned = true;
        process.stderr.write(`${C.yellow}⚠ events.jsonl append failed (${err?.code || err?.message || err}) — this run's event log will be incomplete${C.reset}\n`);
      }
    }
  };
}

// ── render ───────────────────────────────────────────────────────────

function sev(s) {
  const color = s === 'critical' || s === 'high' ? C.red : s === 'medium' ? C.yellow : C.dim;
  return `${color}[${s}]${C.reset}`;
}

// A model killed by a SIGNAL surfaces as `exit null (SIGKILL)` etc (adapters.mjs exitLabel).
// A signal death is an intermittent EXTERNAL kill (observed: kiro-cli self-aborts mid-review) —
// not a deterministic failure like bad auth or a missing CLI, so it's worth ONE fresh retry.
const SIGNAL_DEATH = /\(SIG[A-Z0-9]+\)/;

// Run one round across all models in parallel, reporting start/heartbeat/elapsed
// on stderr so a long round (large diff) isn't a silent black box.
async function runRound(roundLabel, usable, makePrompt, timeoutMs, onUpdate, onResult, onProviderEvent, stream = false, partial = true, expectKeys = null) {
  process.stderr.write(`${C.dim}${roundLabel} — ${usable.length} models in parallel…${C.reset}\n`);
  const pending = new Set(usable.map((e) => e.label));
  const t0 = Date.now();
  // Tick fast (2s) so the live status.json — and thus the dashboard's per-model
  // "(Ns)" — ticks up visibly while a round runs. The stderr console line stays
  // at ~30s so the terminal isn't spammed. Without the fast tick, elapsed_s only
  // updated on completion and every running model showed "0s" the whole round.
  let lastStderr = 0;
  const hb = setInterval(() => {
    const el = Math.round((Date.now() - t0) / 1000);
    if (el - lastStderr >= 30) {
      lastStderr = el;
      process.stderr.write(`  ${C.dim}… ${el}s — waiting on: ${[...pending].join(', ') || '(done)'}${C.reset}\n`);
    }
    if (onUpdate) onUpdate({ event: 'progress', elapsed_s: el });
  }, 2000);
  if (hb.unref) hb.unref();
  try {
    const invoke = (e) => {
      // makePrompt may return a plain string OR { prompt, session, fallbackPrompt }
      // (t5 session reuse) — normalize here so round builders stay declarative.
      const req = makePrompt(e);
      const { prompt, session = null, fallbackPrompt = null } = typeof req === 'string' ? { prompt: req } : req;
      return invokeProviderAsync(e.name, prompt, {
        timeout: timeoutMs,
        model: e.model,
        stream,
        partial,
        session,
        fallbackPrompt,
        expectKeys,
        onEvent: (ev) => onProviderEvent && onProviderEvent(e, ev),
      });
    };
    const results = await Promise.all(usable.map(async (e) => {
      const s = Date.now();
      let res = await invoke(e);
      // Retry a signal-killed model ONCE (a fresh spawn nearly always survives) instead of
      // dropping it from the panel. One retry only — a second signal death is accepted as a
      // genuine failure, and deterministic failures (numeric exit) are never retried.
      if (!res.ok && SIGNAL_DEATH.test(res.error || '')) {
        process.stderr.write(`  ${C.yellow}↻${C.reset} ${e.label} ${C.dim}(${res.error}) — retrying once${C.reset}\n`);
        if (onProviderEvent) onProviderEvent(e, { type: 'lifecycle', event: 'retry', model: e.label, reason: res.error });
        res = await invoke(e);
      }
      pending.delete(e.label);
      const dt = Math.round((Date.now() - s) / 1000);
      process.stderr.write(res.ok
        ? `  ${C.green}✓${C.reset} ${e.label} ${C.dim}(${dt}s)${C.reset}\n`
        : `  ${C.red}✗${C.reset} ${e.label} ${C.dim}(${dt}s)${C.reset}: ${res.error}\n`);
      if (onResult) onResult(e, res);
      if (onUpdate) onUpdate({ event: 'model_done', label: e.label, ok: res.ok, error: res.error, elapsed_s: dt });
      return [e.label, res];
    }));
    return results;
  } finally {
    clearInterval(hb);
  }
}

function renderVerdict(v, dir) {
  const total = v.models.length;
  const lines = [];
  const unrev = v.counts.unreviewed ? `, ${C.red}${v.counts.unreviewed} unreviewed${C.reset}` : '';
  lines.push(`${C.bold}Panel verdict${C.reset} — ${C.green}${v.counts.unique} issue(s)${C.reset} (from ${v.counts.confirmed} confirmed findings), ${C.yellow}${v.counts.contested} contested${C.reset}${unrev}  ${C.dim}(models: ${v.models.join(', ')})${C.reset}`);
  // A model whose round 1 died or came back unparseable is NOT part of this verdict —
  // saying so up top prevents the "N/N models agreed" over-read (mem-mesh ed2ff3e3).
  for (const m of v.models) {
    const bm = v.by_model[m] || {};
    const r1 = bm.r1 || 'ok';
    if (r1 === 'failed') {
      lines.push(`${C.red}⚠ ${m}: round 1 FAILED${C.reset} (${(v.by_model[m].r1_error || 'error')}) — its findings are missing from this verdict; raw kept in ${safeLabel(m)}.r1.json`);
    } else if (r1 === 'suspect_empty') {
      lines.push(`${C.yellow}⚠ ${m}: 0 findings but substantial prose in its raw output${C.reset} — possibly an unparsed review; check ${safeLabel(m)}.r1.json`);
    }
    // Round-2 fidelity: a refuter whose refs don't match the findings (or whose stances
    // had to be coerced to abstain) did NOT cleanly judge the panel — say so up top.
    if (bm.unmatched_refs || bm.invalid_stances) {
      const parts = [];
      if (bm.unmatched_refs) parts.push(`${bm.unmatched_refs} unmatched ref(s)`);
      if (bm.invalid_stances) parts.push(`${bm.invalid_stances} invalid stance(s)`);
      lines.push(`${C.yellow}⚠ ${m}: round-2 fidelity — ${parts.join(', ')}${C.reset} — findings it never addressed are UNREVIEWED, not confirmed; check ${safeLabel(m)}.r2.json`);
    }
  }
  lines.push('');
  lines.push(`${C.bold}ISSUES${C.reset} ${C.dim}(merged across models, by consensus)${C.reset}`);
  if (!v.consensus.length) lines.push('  (none)');
  for (const c of v.consensus) {
    const color = c.consensus === total ? C.green : C.yellow;
    const tag = `${color}${c.consensus}/${total}${C.reset}`;
    const claim = (c.claims[0] && c.claims[0].claim) || '';
    lines.push(`  ${sev(c.severity)} ${tag} ${c.file ?? ''}${c.line ? ':' + c.line : ''}  ${claim}  ${C.dim}— ${c.models.join(', ')}${C.reset}`);
  }
  if (v.contested.length) {
    lines.push('');
    lines.push(`${C.bold}CONTESTED${C.reset} ${C.dim}(a model refuted)${C.reset}`);
    for (const f of v.contested) {
      const ref = f.opponents.find(o => o.stance === 'refute');
      lines.push(`  ${sev(f.severity)} ${f.file ?? ''}${f.line ? ':' + f.line : ''}  ${f.claim}  ${C.dim}— ${f.owner} vs ${ref ? ref.model + ': ' + ref.reason : '?'}${C.reset}`);
    }
  }
  if (v.unreviewed && v.unreviewed.length) {
    lines.push('');
    lines.push(`${C.bold}UNREVIEWED${C.reset} ${C.dim}(no opponent vouched — round 2 failed, abstained, or never addressed it)${C.reset}`);
    for (const f of v.unreviewed) {
      lines.push(`  ${sev(f.severity)} ${f.file ?? ''}${f.line ? ':' + f.line : ''}  ${f.claim}  ${C.dim}— raised by ${f.owner}${C.reset}`);
    }
  }
  lines.push('');
  const unanimous = v.consensus.filter(c => c.consensus === total).length;
  const single = v.consensus.filter(c => c.consensus === 1).length;
  const div = v.models.map(m => `${m}:${v.by_model[m].raised}`).join(' · ');
  lines.push(`${C.dim}Raised per model: ${div}  ·  ${unanimous} unanimous, ${single} single-model (diversity)${C.reset}`);
  lines.push(`${C.dim}saved: ${join(dir, 'verdict.json')}${C.reset}`);
  return lines.join('\n');
}

// ── commands ─────────────────────────────────────────────────────────

async function cmdReview(pos, flags) {
  const cfg = loadPanelConfig();
  const specs = resolveModels(flags, cfg);
  if (specs.length < 2) {
    console.error(`${C.red}panel needs ≥2 models${C.reset} — found ${specs.length}. Configure once:\n  x-panel setup --models claude,codex,agy,kiro [--global]\nor pass --models claude,codex`);
    process.exitCode = 1;
    return;
  }
  const judge = flags.judge || cfg.judge || 'rule';
  if (judge !== 'rule') {
    console.error(`${C.yellow}⚠ --judge ${judge} not implemented in PoC — using rule-based synthesis${C.reset}`);
  }
  // Per-model timeout base (large diffs + many parallel models need headroom). The
  // effective timeout is auto-raised for large targets below (after the target is known).
  const baseTimeoutS = flags.timeout || cfg.timeout_s || 600;
  // Structured streaming (live tokens/cost) is opt-in until dogfooded — default off
  // keeps the proven raw flow intact. Enable per-run with --stream or config panel.stream.
  const stream = (flags.stream != null) ? flags.stream : !!cfg.stream;
  const overrides = cfg.model_overrides || {};

  // Each spec is "name" or "name:model"; bare names fall back to model_overrides.
  // label distinguishes same-CLI/different-model entries (e.g. codex:gpt-5 vs codex:o3).
  const entries = specs.map((spec) => {
    const i = String(spec).indexOf(':');
    const name = (i < 0 ? spec : spec.slice(0, i)).trim();
    const model = (i < 0 ? (overrides[name] || null) : spec.slice(i + 1).trim()) || null;
    return { name, model, label: model ? `${name}:${model}` : name };
  });

  const skippedProviders = []; // structured skip record — surfaced in --json output (B4a)
  let usable = [];
  for (const e of entries) {
    if (!knownProviders().includes(e.name) && !process.env[`X_PANEL_CMD_${e.name.toUpperCase()}`]) {
      console.error(`${C.yellow}⚠ unknown provider "${e.name}" — skipping${C.reset}`);
      skippedProviders.push({ name: e.name, label: e.label, reason: 'unknown_provider', detail: 'not a known provider' });
      continue;
    }
    if (!isAvailable(e.name)) {
      console.error(`${C.yellow}⚠ ${e.name} CLI not found on PATH — skipping (install it or set X_PANEL_CMD_${e.name.toUpperCase()})${C.reset}`);
      skippedProviders.push({ name: e.name, label: e.label, reason: 'not_installed', detail: 'CLI not on PATH' });
      continue;
    }
    usable.push(e);
  }
  const target = resolveTarget(pos[0]);
  // Trivial-target guard (B4b): a clean tree yields the "(no diff against HEAD)" sentinel
  // (~25 chars) — running it still burns N models × 2 rounds for nothing. Blocks the
  // empty-diff sentinel / sub-minimum git-diff and any fully empty target; an EXPLICIT
  // literal/file target above the empty check is intentional and passes. --force overrides.
  // Runs BEFORE the readiness gate: this check is free (local git diff) while the gate
  // pays up to ~12s of checkAuth per provider — never spend that to say "nothing to review".
  if (!flags.force) {
    const trimmed = (target.text || '').trim();
    const minChars = cfg.min_target_chars || 40;
    const trivialDiff = target.kind === 'git-diff' && (trimmed === '(no diff against HEAD)' || trimmed.length < minChars);
    if (!trimmed || trivialDiff) {
      const why = target.kind === 'git-diff'
        ? `git diff is empty/trivial (${trimmed.length} chars — clean tree?)`
        : 'the target is empty';
      console.error(`${C.red}✗ nothing to review${C.reset} — ${why}. A panel run burns ${usable.length} models × 2 rounds. Pass a file/text target, make changes, or --force to run anyway.`);
      process.exitCode = 2;
      return;
    }
  }
  // Readiness gate: an installed-but-logged-out CLI must not join the panel and die
  // mid-round. Exclusions are loud (stderr + skipped_providers in --json).
  const gate = gateReadiness(usable, cfg, { fresh: flags.fresh });
  usable = gate.ready;
  skippedProviders.push(...gate.skipped);
  if (usable.length < 2) {
    console.error(`${C.red}panel needs ≥2 available models, found ${usable.length}${C.reset}`);
    process.exitCode = 1;
    return;
  }
  const labels = usable.map((e) => e.label);
  // Injected per-lens prompt (cross-vendor review mode): overrides round-1 intro only.
  const reviewOverride = loadPromptOverride(flags);
  if (reviewOverride === undefined) return; // unreadable --review-prompt-file (error already logged)
  const lensTag = flags.lensTag || null;
  const reviewMode = reviewOverride != null; // → write under .xm/review/ (separate namespace)
  // Token-level partial streaming: default on within --stream, but auto-disable on very
  // large targets (the extra delta events slow generation and can trip the timeout —
  // observed: a 1600-line diff timed out claude under partial). --partial forces it on;
  // --no-partial / config panel.stream_partial:false turn it off.
  let partial = (flags.partial != null) ? flags.partial : (cfg.stream_partial !== false);
  if (stream && partial && flags.partial == null) {
    const PARTIAL_MAX = cfg.partial_max_chars || 50000;
    const tlen = (target.text || '').length;
    if (tlen > PARTIAL_MAX) {
      partial = false;
      console.error(`${C.yellow}⚠ target ${tlen} chars > ${PARTIAL_MAX} — partial streaming auto-disabled (faster on large inputs; --partial to force)${C.reset}`);
    }
  }
  // Auto-raise the per-model timeout for large targets — a big diff needs more wall
  // time per model (observed: a 133K-char diff timed out claude at 300s). Only when
  // --timeout was not given explicitly; capped, and tunable via config.
  const timeoutS = autoRaiseTimeoutS(baseTimeoutS, (target.text || '').length, flags.timeout != null, cfg,
    (scaled, MAX, tlen) => console.error(`${C.yellow}⚠ large target (${tlen} chars) — timeout auto-raised ${baseTimeoutS}s → ${scaled}s (cap ${MAX}s; --timeout to override)${C.reset}`));
  const timeoutMs = timeoutS * 1000;
  const run = runId(stamp());
  // Cross-vendor REVIEW runs go to a separate .xm/review/ namespace so they never
  // collide with native panel history under .xm/panel/.
  const baseDir = reviewMode ? join(PANEL_DIR, '..', 'review') : PANEL_DIR;
  const dir = join(baseDir, run);
  ensureDir(dir);
  const eventPath = join(dir, 'events.jsonl');
  const writeEvent = makeEventWriter(eventPath);

  // Live status for polling (dashboard / xm recall / cat .xm/panel/<run>/status.json)
  const zeroTokens = () => ({ input: 0, output: 0, cached: 0, reasoning: 0 });
  const status = {
    run, started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    phase: 'starting', target_kind: target.kind, target_title: targetTitle(target), stream, partial: stream ? partial : false, timeout_s: timeoutS,
    skipped_providers: skippedProviders,
    // Cumulative cost/tokens across BOTH rounds (round-scoped live fields below are
    // reset each round by startPhase, so totals must live separately to be holdable).
    totals: { cost_usd: 0, credits: 0, tokens: zeroTokens() },
    models: usable.map((e) => ({
      label: e.label,
      provider: e.name,
      model: e.model,
      state: 'pending',
      round: null,
      elapsed_s: 0,
      started_at: null,
      updated_at: null,
      last_event: 'pending',
      stdout_bytes: 0,
      stderr_bytes: 0,
      stdout_tail: '',
      stderr_tail: '',
      error: null,
      // live (round-scoped) usage + phase
      phase_label: null,
      tokens: null,
      cost_usd: null,
      credits: null,
      // cumulative (across rounds) — never reset by startPhase
      cum_tokens: zeroTokens(),
      cum_cost_usd: 0,
      cum_credits: 0,
    })),
  };
  // Live push to a term-mesh daemon when one is present (XK-EVENTS-v1, t3):
  // mirrors every status flush onto the daemon event bus so in-term-mesh
  // subscribers get sub-second updates. Best-effort — status.json above stays
  // the authoritative record. Opt out: --no-tm-events / panel.tm_events:false.
  const tmEvents = createTmEventsPublisher({
    run, runKind: 'review', title: targetTitle(target), logPath: eventPath,
    enabled: flags.tmEvents != null ? flags.tmEvents : cfg.tm_events !== false,
  });
  let lastStatusFlushMs = 0;
  const flushStatus = ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastStatusFlushMs < 500) return;
    lastStatusFlushMs = now;
    status.updated_at = new Date().toISOString();
    try { writeJSON(join(dir, 'status.json'), status); } catch { /* best-effort */ }
    tmEvents.publishStatus(status);
  };
  const onModelDone = (ev) => {
    if (ev.event === 'model_done') {
      const m = status.models.find((x) => x.label === ev.label);
      if (m) {
        m.state = ev.ok ? 'done' : 'failed';
        m.elapsed_s = ev.elapsed_s;
        m.updated_at = new Date().toISOString();
        m.last_event = ev.ok ? 'model done' : 'model failed';
        m.error = ev.ok ? null : ev.error;
      }
      writeEvent({ type: 'model_done', model: ev.label, ok: ev.ok, elapsed_s: ev.elapsed_s, error: ev.error || null });
    } else if (ev.event === 'progress') {
      // Tick the elapsed clock of every still-running model so the dashboard
      // shows live progress instead of a frozen "0s" until completion.
      status.models.forEach((m) => { if (m.state === 'running') m.elapsed_s = ev.elapsed_s; });
    }
    flushStatus({ force: ev.event === 'model_done' });
  };
  // Milestone-only persistence — see MILESTONE / makeEventWriter (module scope, shared with cross).
  const onProviderEvent = (entry, ev) => {
    const m = status.models.find((x) => x.label === entry.label);
    const type = ev.type || 'event';
    const rawStream = type === 'stdout' || type === 'stderr' ? type : null;
    if (m) {
      m.updated_at = new Date().toISOString();
      if (type === 'spawn') {
        m.pid = ev.pid;
        m.last_event = (ev.mode === 'stream' || ev.mode === 'stream-partial') ? `spawned (${ev.mode})` : 'spawned';
      } else if (rawStream) {
        const bytesKey = `${rawStream}_bytes`;
        const tailKey = `${rawStream}_tail`;
        const text = redactPanelText(ev.text || '');
        m[bytesKey] = (m[bytesKey] || 0) + (ev.bytes || Buffer.byteLength(text));
        if (text) m[tailKey] = tailText(`${m[tailKey] || ''}${text}`, 4000);
        m.last_event = `${rawStream} +${ev.bytes || Buffer.byteLength(text)} bytes`;
      } else if (type === 'thinking') {
        m.phase_label = 'thinking';
        m.last_event = 'thinking';
      } else if (type === 'text') {
        m.phase_label = 'responding';
        const text = redactPanelText(ev.delta || '');
        if (text) m.stdout_tail = tailText(`${m.stdout_tail || ''}${text}`, 4000);
        m.last_event = 'responding';
      } else if (type === 'usage') {
        // live (round-scoped) display only — accumulation happens on usage_final
        m.tokens = ev.tokens || m.tokens;
        if (ev.cost_usd != null) m.cost_usd = ev.cost_usd;
        m.last_event = 'usage';
      } else if (type === 'usage_final') {
        const u = ev.usage || {};
        const t = { input: u.input || 0, output: u.output || 0, cached: u.cached || 0, reasoning: u.reasoning || 0 };
        m.tokens = t;
        m.cost_usd = (u.cost_usd != null) ? u.cost_usd : m.cost_usd;
        if (u.credits != null) m.credits = u.credits;
        // accumulate into cumulative totals (once per model per round)
        for (const k of ['input', 'output', 'cached', 'reasoning']) { m.cum_tokens[k] += t[k]; status.totals.tokens[k] += t[k]; }
        if (u.cost_usd != null) { m.cum_cost_usd += u.cost_usd; status.totals.cost_usd += u.cost_usd; }
        if (u.credits != null) { m.cum_credits += u.credits; status.totals.credits += u.credits; }
        m.last_event = 'usage final';
      } else if (type === 'json_parsed') {
        m.last_event = 'json parsed';
      } else if (type === 'json_missing') {
        m.last_event = 'json missing';
      } else if (type === 'timeout') {
        m.last_event = 'timeout';
        m.error = ev.error || 'timeout';
      } else if (type === 'error') {
        m.last_event = 'process error';
        m.error = ev.error || 'process error';
      } else if (type === 'exit') {
        m.last_event = ev.code === 0 ? 'process exited' : `exit ${ev.code}`;
      } else if (type === 'lifecycle') {
        m.last_event = ev.note || 'lifecycle';
      }
    }
    if (MILESTONE.has(type)) {
      writeEvent({
        type,
        phase: status.phase,
        model: entry.label,
        provider: entry.name,
        bytes: ev.bytes || null,
        pid: ev.pid || null,
        code: ev.code ?? null,
        tokens: ev.tokens || (ev.usage ? { input: ev.usage.input, output: ev.usage.output, cached: ev.usage.cached, reasoning: ev.usage.reasoning } : null),
        cost_usd: (ev.cost_usd != null) ? ev.cost_usd : (ev.usage && ev.usage.cost_usd != null ? ev.usage.cost_usd : null),
        credits: (ev.usage && ev.usage.credits != null) ? ev.usage.credits : null,
        note: ev.note || null,
        error: ev.error || null,
        text: ev.text || null,
      });
    }
    flushStatus({ force: MILESTONE.has(type) });
  };
  const startPhase = (phase) => {
    status.phase = phase;
    const now = new Date().toISOString();
    status.models.forEach((m) => {
      m.state = 'running';
      m.round = phase;
      m.elapsed_s = 0;
      m.started_at = now;
      m.updated_at = now;
      m.last_event = 'round started';
      m.stdout_bytes = 0;
      m.stderr_bytes = 0;
      m.stdout_tail = '';
      m.stderr_tail = '';
      m.error = null;
      // reset round-scoped live usage; cum_* / status.totals persist across rounds
      m.phase_label = null;
      m.tokens = null;
      m.cost_usd = null;
      m.credits = null;
    });
    writeEvent({ type: 'round_start', phase });
    flushStatus({ force: true });
  };
  writeEvent({ type: 'run_start', phase: status.phase, models: labels, target_kind: target.kind });
  flushStatus({ force: true });

  // t5 session reuse: round 1 creates a provider session (claude: caller uuid;
  // codex: id captured from the run banner), round 2 resumes it with only the
  // refute delta — the target never travels twice. Raw path only (--stream keeps
  // its dogfooded argv).
  // Opt out: --no-session-reuse / panel.session_reuse:false.
  const sessionReuse = !stream && (flags.sessionReuse != null ? flags.sessionReuse : cfg.session_reuse !== false);
  for (const e of usable) {
    if (sessionReuse && supportsResume(e.name)) {
      e._session1 = { mode: 'create', id: e.name === 'claude' ? randomUUID() : null };
    }
  }

  // Round 1 — independent review (all models in parallel)
  startPhase('round1 (review)');
  const round1 = {};
  // Models whose round 1 produced no usable findings: 'failed' (error/unparseable) or
  // 'suspect_empty' (ok with 0 findings but substantial prose in raw — likely a review
  // the parser couldn't lift). Threaded into synthesize so the verdict distinguishes
  // "reviewed, found nothing" from "never entered the verdict" (mem-mesh ed2ff3e3).
  const r1Status = {};
  // Warn-only signal, never a gate: a compliant answer leaves ~0 chars of prose outside
  // its JSON, a one-line "Here is the JSON:" preamble ~tens, a full prose review
  // thousands (observed 3.9KB). 200 sits in the wide gap between those modes.
  const SUSPECT_PROSE_MIN = 200;
  const r1Prompt = reviewPrompt(target.text, reviewOverride);
  await runRound('round 1 (review)', usable, (e) => (
    // fallbackPrompt = the same prompt: a failed --session-id spawn retries
    // stateless so session support can never cost a round (contract R4).
    e._session1 ? { prompt: r1Prompt, session: e._session1, fallbackPrompt: r1Prompt } : r1Prompt
  ), timeoutMs, onModelDone, (e, res) => {
    // Resume in round 2 only with a real session: claude echoes the caller's
    // uuid, codex must have disclosed one; a stateless fallback disables it.
    if (e._session1) {
      // A round-1 create that fell back to stateless must surface in the verdict —
      // otherwise round 2 (which goes stateless because there's no id) would record
      // plain 'stateless' and hide that session support failed.
      e._r1Fallback = res.resume === 'fallback';
      // Banner capture failed (codex): a session WAS created but its id is unknown —
      // distinct from a vendor that never supports resume (adapters emitted the warning).
      e._captureFailed = !!res.session_capture_failed;
      e._resumeId = res.resume === 'fallback' ? null : (res.session_id || null);
    }
    const findings = res.ok ? normalizeFindings(res.json, lensTag) : [];
    round1[e.label] = findings;
    if (!res.ok) r1Status[e.label] = { status: 'failed', error: res.error || 'failed' };
    else if (!findings.length && proseOutsideJSON(res.raw || '').length >= SUSPECT_PROSE_MIN) r1Status[e.label] = { status: 'suspect_empty' };
    const r1 = r1Status[e.label] ? r1Status[e.label].status : 'ok';
    writeJSON(join(dir, `${safeLabel(e.label)}.r1.json`), { model: e.label, ok: res.ok, error: res.error, r1_status: r1, findings, usage: res.usage || null, raw: res.raw });
    writeEvent({ type: 'round_file_written', phase: status.phase, model: e.label, round: 1, ok: res.ok, r1_status: r1, count: findings.length, error: res.error || null });
  }, onProviderEvent, stream, partial, ['findings']);

  // Round 2 — adversarial: each model refutes the others' findings (in parallel)
  startPhase('round2 (refute)');
  const round2 = {};
  const abstained = new Set();
  await runRound('round 2 (refute)', usable, (e) => {
    const others = usable.filter(x => x.label !== e.label);
    // Tag each opponent finding with a global ref `owner#idx` so 3+ models don't collide.
    const otherFindings = others.flatMap(o => (round1[o.label] || []).map(f => ({ ...f, gref: `${o.label}#${f.idx}` })));
    const otherLabel = others.map(o => o.label).join('+');
    const full = refutePrompt(target.text, otherLabel, otherFindings);
    if (!e._resumeId) return full;
    return { prompt: refutePromptResumed(otherLabel, otherFindings), session: { mode: 'resume', id: e._resumeId }, fallbackPrompt: full };
  }, timeoutMs, onModelDone, (e, res) => {
    if (!res.ok) abstained.add(e.label); // round2 failure ≠ silent concede
    // 'ok' | 'fallback' | 'capture_failed' (session created but its banner id was not
    // captured — round 2 went stateless) | 'stateless' (vendor never supports resume /
    // reuse disabled). capture_failed ≠ stateless: the former is a fixable capture bug.
    const resume = res.resume || (e._r1Fallback ? 'fallback' : e._captureFailed ? 'capture_failed' : 'stateless');
    const sm = status.models.find((x) => x.label === e.label);
    if (sm) sm.resume = resume;
    const verdicts = res.ok ? normalizeVerdicts(res.json) : [];
    round2[e.label] = verdicts;
    writeJSON(join(dir, `${safeLabel(e.label)}.r2.json`), { model: e.label, ok: res.ok, error: res.error, resume, verdicts, usage: res.usage || null, raw: res.raw });
    writeEvent({ type: 'round_file_written', phase: status.phase, model: e.label, round: 2, ok: res.ok, resume, count: verdicts.length, error: res.error || null });
  }, onProviderEvent, stream, partial, ['verdicts']);

  const verdict = synthesize(labels, round1, round2, abstained, r1Status);
  // Surface round-2 fidelity per model in the live status too, so `status <run>` /
  // --watch (and their --json snapshots) show a broken refuter without opening verdict.json.
  for (const m of status.models) {
    const bm = verdict.by_model[m.label];
    if (bm) {
      m.unmatched_refs = bm.unmatched_refs || 0;
      m.invalid_stances = bm.invalid_stances || 0;
    }
  }
  const record = {
    run,
    created_at: new Date().toISOString(),
    target_kind: target.kind,
    target_ref: target.ref || null,
    target_title: targetTitle(target),
    judge: 'rule',
    stream,
    partial: stream ? partial : false,
    timeout_s: timeoutS,
    skipped_providers: skippedProviders,
    usage: {
      totals: status.totals,
      by_model: Object.fromEntries(status.models.map((m) => [m.label, { tokens: m.cum_tokens, cost_usd: m.cum_cost_usd, credits: m.cum_credits, resume: m.resume || 'stateless' }])),
    },
    ...verdict,
  };
  writeJSON(join(dir, 'verdict.json'), record);
  status.phase = 'done';
  writeEvent({ type: 'run_done', phase: status.phase, counts: verdict.counts });
  flushStatus({ force: true });
  tmEvents.close();

  if (flags.json) console.log(JSON.stringify(record, null, 2));
  else console.log(renderVerdict(verdict, dir));
}

// Resolve provider entries (name / name:model) from --models/preset/config — shared by review & cross.
function resolveEntries(flags, cfg) {
  const overrides = cfg.model_overrides || {};
  return resolveModels(flags, cfg).map((spec) => {
    const i = String(spec).indexOf(':');
    const name = (i < 0 ? spec : spec.slice(0, i)).trim();
    const model = (i < 0 ? (overrides[name] || null) : spec.slice(i + 1).trim()) || null;
    return { name, model, label: model ? `${name}:${model}` : name };
  });
}

// Generic cross-vendor raw invocation: run ONE prompt across N vendors in parallel and
// return each vendor's free-form text output. No findings parsing, no merge — the caller
// (e.g. x-op debate/council) does the deliberation. Output lands in .xm/cross/<run>/.
async function cmdCross(pos, flags) {
  const cfg = loadPanelConfig();
  // Warn (never silently drop — Lesson L6) when a requested provider is unknown/not installed:
  // a cross-vendor caller must SEE that it degraded toward single-vendor.
  const skippedProviders = []; // structured skip record — surfaced in --json output (B4a)
  let usable = [];
  for (const e of resolveEntries(flags, cfg)) {
    if (!knownProviders().includes(e.name) && !process.env[`X_PANEL_CMD_${e.name.toUpperCase()}`]) {
      console.error(`${C.yellow}⚠ unknown provider "${e.name}" — skipping${C.reset}`);
      skippedProviders.push({ name: e.name, label: e.label, reason: 'unknown_provider', detail: 'not a known provider' });
      continue;
    }
    if (!isAvailable(e.name)) {
      console.error(`${C.yellow}⚠ ${e.name} CLI not installed — skipping${C.reset}`);
      skippedProviders.push({ name: e.name, label: e.label, reason: 'not_installed', detail: 'CLI not on PATH' });
      continue;
    }
    usable.push(e);
  }
  // Readiness gate (same as review): a logged-out CLI must not join and die mid-run.
  const gate = gateReadiness(usable, cfg, { fresh: flags.fresh });
  usable = gate.ready;
  skippedProviders.push(...gate.skipped);
  if (!usable.length) {
    console.error(`${C.red}cross needs ≥1 available model${C.reset} — none found. Install a model CLI or pass --models.`);
    process.exitCode = 1;
    return;
  }
  const prompt = loadPromptArg(flags, 'promptFile', 'prompt', '--prompt');
  if (prompt === undefined) return; // value error already logged
  if (prompt == null) { console.error(`${C.red}cross needs a prompt${C.reset} — pass --prompt "<text>", --prompt-file <path>, or --prompt -`); process.exitCode = 1; return; }
  const baseTimeoutS = flags.timeout || cfg.timeout_s || 600;
  const timeoutS = autoRaiseTimeoutS(baseTimeoutS, prompt.length, flags.timeout != null, cfg,
    (scaled, MAX, tlen) => console.error(`${C.yellow}⚠ large prompt (${tlen} chars) — timeout auto-raised ${baseTimeoutS}s → ${scaled}s (cap ${MAX}s)${C.reset}`));
  const timeoutMs = timeoutS * 1000;
  const run = runId(stamp());
  const dir = join(PANEL_DIR, '..', 'cross', run);
  ensureDir(dir);
  // Provenance + human title, hoisted BEFORE the run so the live status.json can name an
  // in-progress run (not only a finished one). Title is redacted before truncation (same rule
  // as targetTitle): a caller may pass user text. Falls back to the prompt's first line.
  const source = sourceTag(flags.source);
  const title = compactTitle(redactPanelText(flags.title || firstLine(prompt) || ''), 80);
  // Live heartbeat — cross used to be a black box while running: no per-model state/elapsed/tail
  // until each vendor's result file appeared. A review-style status.json (lighter: no rounds, no
  // usage) is flushed on every provider event (throttled) plus a 2s tick, so status/--watch see
  // cross progress under the same 30s staleness rule as review instead of the mtime guess.
  const nowISO = () => new Date().toISOString();
  const status = {
    run, kind: 'cross', source, title, started_at: nowISO(), updated_at: nowISO(), phase: 'running',
    timeout_s: timeoutS, prompt_chars: prompt.length, skipped_providers: skippedProviders,
    models: usable.map((e) => ({
      label: e.label, provider: e.name, model: e.model,
      state: 'running', elapsed_s: 0, started_at: nowISO(), updated_at: nowISO(),
      last_event: 'pending', stdout_bytes: 0, stderr_bytes: 0, stdout_tail: '', stderr_tail: '',
      retried: false, error: null,
    })),
  };
  // Durable event log (same machinery as review) — cross runs used to keep NO
  // events.jsonl, so the highest-traffic path had zero forensics on a failure.
  const eventPath = join(dir, 'events.jsonl');
  const writeEvent = makeEventWriter(eventPath);
  // Live push to a term-mesh daemon when present (XK-EVENTS-v1, t3) — same
  // best-effort mirror as review; status.json stays authoritative.
  const tmEvents = createTmEventsPublisher({
    run, runKind: 'cross', title, logPath: eventPath,
    enabled: flags.tmEvents != null ? flags.tmEvents : cfg.tm_events !== false,
  });
  let lastFlushMs = 0;
  const flushStatus = ({ force = false } = {}) => {
    const t = Date.now();
    if (!force && t - lastFlushMs < 500) return;
    lastFlushMs = t;
    status.updated_at = nowISO();
    try { writeJSON(join(dir, 'status.json'), status); } catch { /* best-effort */ }
    tmEvents.publishStatus(status);
  };
  const t0 = Date.now();
  const hb = setInterval(() => {
    const el = Math.round((Date.now() - t0) / 1000);
    status.models.forEach((m) => { if (m.state === 'running') m.elapsed_s = el; });
    flushStatus();
  }, 2000);
  if (hb.unref) hb.unref();
  // Per-provider progress → status.json (redacted + tail-bounded, same rules as review),
  // and milestone events → events.jsonl (spawn/stdout/stderr/timeout/error/exit).
  const onProviderEvent = (m) => (ev) => {
    m.updated_at = nowISO();
    if (ev.type === 'spawn') { m.pid = ev.pid; m.last_event = 'spawned'; }
    else if (ev.type === 'stdout' || ev.type === 'stderr') {
      const text = redactPanelText(ev.text || '');
      m[`${ev.type}_bytes`] = (m[`${ev.type}_bytes`] || 0) + (ev.bytes || Buffer.byteLength(text));
      if (text) m[`${ev.type}_tail`] = tailText(`${m[`${ev.type}_tail`] || ''}${text}`, 4000);
      m.last_event = `${ev.type} +${ev.bytes || 0} bytes`;
    } else if (ev.type === 'timeout') { m.last_event = 'timeout'; m.error = ev.error || 'timeout'; }
    else if (ev.type === 'error') { m.last_event = 'process error'; m.error = ev.error || 'process error'; }
    else if (ev.type === 'exit') { m.last_event = ev.code === 0 ? 'process exited' : `exit ${ev.code}`; }
    if (MILESTONE.has(ev.type)) {
      writeEvent({
        type: ev.type,
        phase: status.phase,
        model: m.label,
        provider: m.provider,
        bytes: ev.bytes || null,
        pid: ev.pid || null,
        code: ev.code ?? null,
        note: ev.note || null,
        error: ev.error || null,
        text: ev.text || null,
      });
    }
    flushStatus({ force: ev.type !== 'stdout' && ev.type !== 'stderr' });
  };
  writeEvent({ type: 'run_start', phase: status.phase, models: usable.map((e) => e.label), source, title, prompt_chars: prompt.length });
  flushStatus({ force: true });

  let results;
  try {
    results = await Promise.all(usable.map(async (e, i) => {
      const m = status.models[i];
      const onEvent = onProviderEvent(m);
      let res = await invokeProviderText(e.name, prompt, { timeout: timeoutMs, model: e.model, onEvent });
      // One retry on a TRANSIENT failure (exit-0-empty / exit-N): cursor and other gateway CLIs
      // intermittently return an empty/failed result that succeeds on a second try. Do NOT retry a
      // timeout/stall — it already burned the full (600s+) window, so a retry just doubles the
      // wall-clock for a hung provider with no new information. That case is flagged by `timedOut`
      // (set by invokeProviderText's idle/cap guard), so we gate on the FLAG — never a substring of
      // the error text, which used to over-match exit-0-empty/exit-N messages that merely mention
      // "timeout" (e.g. `exit 0 but empty output: ...timed out...`). Retries are surfaced (L6).
      if (!res.ok && !res.timedOut) {
        console.error(`${C.yellow}⚠ ${e.label} failed (${res.error}) — retrying once${C.reset}`);
        writeEvent({ type: 'lifecycle', phase: status.phase, model: e.label, provider: e.name, note: `failed (${res.error}) — retrying once`, error: res.error });
        m.retried = true;
        m.last_event = 'retrying';
        m.error = null;
        flushStatus({ force: true });
        const retry = await invokeProviderText(e.name, prompt, { timeout: timeoutMs, model: e.model, onEvent });
        if (retry.ok) res = retry;
        else res = { ...res, error: `${res.error} (retried once, still failed: ${retry.error})` };
      }
      m.state = res.ok ? 'done' : 'failed';
      m.error = res.ok ? null : (res.error || m.error);
      m.elapsed_s = Math.round((Date.now() - t0) / 1000);
      m.updated_at = nowISO();
      m.last_event = res.ok ? 'done' : 'failed';
      writeEvent({ type: 'model_done', model: e.label, ok: res.ok, elapsed_s: m.elapsed_s, error: res.ok ? null : (res.error || null) });
      flushStatus({ force: true });
      const rec = { model: e.label, provider: e.name, ok: res.ok, output: res.output || '', error: res.error || null };
      writeJSON(join(dir, `${safeLabel(e.label)}.json`), rec);
      return rec;
    }));
  } finally {
    clearInterval(hb);
  }
  status.phase = 'done';
  writeEvent({ type: 'run_done', phase: status.phase, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  flushStatus({ force: true });
  tmEvents.close();
  const record = { run, created_at: new Date().toISOString(), source, title, models: usable.map((e) => e.label), skipped_providers: skippedProviders, prompt_chars: prompt.length, results };
  writeJSON(join(dir, 'result.json'), record);
  if (flags.json) console.log(JSON.stringify(record, null, 2));
  else for (const r of results) console.log(`\n${C.bold}## ${r.model}${C.reset}${r.ok ? '' : ` ${C.red}(FAILED: ${r.error})${C.reset}`}\n${r.output || ''}`);
  // Total failure must be a non-zero exit so callers (x-op) can detect it.
  if (!results.some((r) => r.ok)) { console.error(`${C.red}✗ all ${results.length} provider(s) failed${C.reset}`); process.exitCode = 1; }
}

function cmdSetup(pos, flags) {
  const patch = {};
  if (flags.models) patch.models = flags.models.split(',').map(s => s.trim()).filter(Boolean);
  if (flags.judge) patch.judge = flags.judge;
  if (!patch.models && !patch.judge) {
    const cfg = loadPanelConfig();
    console.log(`${C.bold}x-panel setup${C.reset}`);
    console.log(`  detected on PATH : ${autodetectModels().join(', ') || '(none)'}`);
    console.log(`  current models   : ${(cfg.models || []).join(', ') || '(autodetect)'}`);
    console.log(`  current judge    : ${cfg.judge || 'rule'}`);
    console.log(`  timeout_s        : ${cfg.timeout_s || 600}  ${C.dim}(shared with cross-vendor)${C.reset}`);
    console.log(`${C.dim}  scope            : models/judge/stream tune panel review only; cross-vendor`);
    console.log(`                     consumers pass --models directly and share providers (code-`);
    console.log(`                     defined in adapters) + timeout_s — never models/judge/stream.${C.reset}`);
    console.log(`\nSet defaults:\n  x-panel setup --models claude,codex,agy,kiro --judge rule [--global]`);
    return;
  }
  const path = savePanelConfig(patch, { global: flags.global });
  console.log(`${C.green}✓${C.reset} saved panel defaults → ${path}`);
}

// `xm panel types` — list providers with install status + how to discover each
// one's live model set. Model IDs are NOT baked in here; we point at the CLI's own
// list command so cursor/kiro's fast-moving catalogs (kimi, deepseek, glm, …) stay current.
function cmdTypes() {
  const installed = new Set(autodetectModels());
  const meta = providerMeta();
  for (const name of knownProviders()) {
    const m = meta[name] || {};
    const mark = installed.has(name) ? `${C.green}●${C.reset}` : `${C.dim}○${C.reset}`;
    const tag = m.multi ? `${C.cyan}${m.vendor}${C.reset}` : (m.vendor || '');
    console.log(`${mark} ${C.bold}${name}${C.reset}  ${tag}`);
    if (m.list) console.log(`    models : ${m.list}`);
    if (m.examples) console.log(`    ${C.dim}e.g. ${m.examples}${C.reset}`);
  }
  console.log(`\n${C.dim}● installed   ○ not on PATH${C.reset}`);
  console.log(`Use a specific model with --models name:model (e.g. ${C.bold}cursor:kimi-k2.5${C.reset}).`);
  console.log(`Full live catalog for a vendor: ${C.bold}xm panel models <vendor>${C.reset} (e.g. cursor → kimi, glm, grok).`);
}

// `xm panel models [vendor] [--check m1,m2]` — print a vendor's REAL model catalog
// fetched live from its own --list-models (never hardcoded → always current, so cursor's
// kimi-k2.5 shows up). With --check, verify specific model IDs exist in that catalog —
// the way to confirm a config / --models entry is valid before a run uses it.
function cmdModels(pos, flags) {
  const meta = providerMeta();
  const target = pos[0];
  const names = target ? [target] : knownProviders();
  const check = flags.check ? flags.check.split(',').map((s) => s.trim()).filter(Boolean) : null;
  let shown = false;
  for (const name of names) {
    if (!meta[name]) { console.log(`${C.red}unknown provider: ${name}${C.reset}`); continue; }
    if (!meta[name].listCmd) { if (target) console.log(`${C.yellow}${name}${C.reset}: no model-list command ${C.dim}(${meta[name].list})${C.reset}`); continue; }
    const r = listModels(name);
    if (!r.ok) { if (target || check) console.log(`${C.red}${name}${C.reset}: ${C.dim}${r.error}${C.reset}`); continue; }
    shown = true;
    if (check) {
      console.log(`${C.bold}${name}${C.reset}`);
      for (const c of check) {
        const model = c.includes(':') ? c.split(':').slice(1).join(':') : c;
        const esc = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const hit = new RegExp(`(^|[\\s|])${esc}([\\s|]|$)`, 'm').test(r.output);
        console.log(`  ${hit ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} ${model}${hit ? '' : `  ${C.dim}not in ${name}'s catalog${C.reset}`}`);
      }
    } else {
      console.log(`${C.bold}── ${name} ──${C.reset}`);
      console.log(r.output);
      console.log('');
    }
  }
  if (!shown && !target) console.log(`${C.dim}No installed provider has a model-list command. See: xm panel types${C.reset}`);
}

// `xm panel doctor` — pre-flight readiness so a run never fails mid-panel on a
// logged-out CLI (the cursor case). For each provider: installed on PATH? then its
// own auth-status command (exit 0 = signed in), NO model call. `--probe` makes one
// tiny real call for providers without an auth-status command (agy).
async function cmdDoctor(flags) {
  const rows = knownProviders().map((n) => checkAuth(n));
  if (flags.probe) {
    for (const r of rows) {
      if (!r.installed || r.authed !== null) continue; // only the "unknown" ones
      const res = await invokeProviderText(r.name, 'Reply with exactly: OK', { timeout: 30_000 });
      r.authed = !!(res.ok && /\bok\b/i.test(res.output || ''));
      r.assumedReady = r.authed; // probe resolved the unknown → assumed-ready tracks the verdict
      r.detail = r.authed ? 'probe ok' : `probe failed: ${(res.error || res.output || '').slice(0, 70)}`;
    }
  }
  if (flags.json) { console.log(JSON.stringify({ providers: rows }, null, 2)); return; }
  const meta = providerMeta();
  console.log(`${C.bold}x-panel doctor${C.reset} — provider readiness (install + auth, no model call)\n`);
  for (const r of rows) {
    let icon, label;
    if (!r.installed) { icon = `${C.dim}○${C.reset}`; label = `${C.dim}not installed${C.reset}`; }
    else if (r.authed === true) { icon = `${C.green}✓${C.reset}`; label = `${C.green}ready${C.reset}`; }
    else if (r.authed === false) { icon = `${C.red}✗${C.reset}`; label = `${C.red}NOT authenticated${C.reset}`; }
    // authed === null: a no-auth-status CLI (agy). creds present → assumed ready (~, usable);
    // creds absent → likely logged out (?, not offered).
    else if (r.assumedReady) { icon = `${C.cyan}~${C.reset}`; label = `${C.cyan}likely ready${C.reset} ${C.dim}(unverified)${C.reset}`; }
    else { icon = `${C.yellow}?${C.reset}`; label = `${C.yellow}auth unknown${C.reset}`; }
    console.log(`${icon} ${C.bold}${r.name}${C.reset}  ${label}  ${C.dim}${r.detail}${C.reset}`);
    if (r.installed && r.authed === false && meta[r.name] && meta[r.name].login) {
      console.log(`    ${C.dim}→ fix: ${meta[r.name].login}${C.reset}`);
    }
    if (r.authed === null && r.installed) {
      console.log(`    ${C.dim}→ confirm with: xm panel doctor --probe${C.reset}`);
    }
  }
  // "ready" = usable in a run (verified OR assumed); break out how many are still unverified so
  // the assumed ones are visible, not silently counted as fully confirmed.
  const verified = rows.filter((r) => r.authed === true).length;
  const ready = rows.filter(providerReady).length;
  const assumed = ready - verified;
  const tail = ready >= 2
    ? `${C.green}cross-vendor OK${C.reset}`
    : `${C.yellow}cross-vendor needs ≥2 ready (else single-vendor fallback)${C.reset}`;
  console.log(`\n${ready}/${rows.length} ready${assumed ? ` (${verified} verified + ${assumed} assumed — \`doctor --probe\` to confirm)` : ''} — ${tail}`);
}

// `xm panel preflight [--models <list>] [--timeout N] [--json]` — the REAL check:
// invoke each model the panel would actually use (resolveEntries → config/preset/
// --models, with name:model + model_overrides) with one tiny prompt and confirm it
// responds. doctor checks install+auth only (no model call), so an authed provider
// whose configured model is invalid/unavailable/rate-limited passes doctor but fails
// a real run — preflight catches that HERE, before spending a full panel.
async function cmdPreflight(pos, flags) {
  const cfg = loadPanelConfig();
  // Dedupe by label so a model listed via both a preset and --models isn't probed
  // (and billed) twice.
  const _seen = new Set();
  const entries = resolveEntries(flags, cfg).filter((e) => (_seen.has(e.label) ? false : (_seen.add(e.label), true)));
  if (entries.length === 0) {
    console.error(`${C.yellow}no models resolved — configure with: xm panel setup${C.reset}`);
    process.exit(1);
  }
  const timeoutMs = Math.max(5, (flags.timeout != null ? Number(flags.timeout) : 45)) * 1000;

  // t6: TTL cache — every probe is one real (billed) model call, so repeated
  // preflights within a session reuse recent LIVE verdicts. Only `ok` results
  // are cached: a failed provider can be fixed at any moment (login, model
  // rename) and must always re-probe. Bypass: --fresh; tune/disable:
  // panel.preflight_ttl_s (default 1800, 0 = off).
  const ttlS = flags.fresh ? 0 : (cfg.preflight_ttl_s != null ? Math.max(0, Number(cfg.preflight_ttl_s) || 0) : 1800);
  const cachePath = join(PANEL_DIR, 'preflight-cache.json');
  const cacheEntries = ttlS > 0 ? (((readJSONSafe(cachePath) || {}).entries) || {}) : {};

  // Probe one entry → result. `model` = the ACTUAL model the CLI resolved (probeProvider
  // reads it from the provider's own stream-json); `requested_model` = what we asked for.
  const probeOne = async (e) => {
    const base = { name: e.name, requested_model: e.model, label: e.label };
    if (!knownProviders().includes(e.name) && !process.env[`X_PANEL_CMD_${e.name.toUpperCase()}`]) {
      return { ...base, model: e.model, ok: false, status: 'unknown', ms: 0, detail: 'unknown provider' };
    }
    if (!isAvailable(e.name)) {
      return { ...base, model: e.model, ok: false, status: 'not_installed', ms: 0, detail: 'CLI not on PATH' };
    }
    const hit = cacheEntries[e.label];
    if (hit && hit.ok && Date.now() - hit.at_ms < ttlS * 1000) {
      const age = Math.round((Date.now() - hit.at_ms) / 1000);
      return { ...base, model: hit.model || e.model, ok: true, status: 'ok', ms: 0, cached: true, detail: `cached ${age}s ago (--fresh to re-probe)` };
    }
    const t0 = Date.now();
    let res;
    try {
      res = await probeProvider(e.name, { model: e.model, timeout: timeoutMs });
    } catch (err) {
      return { ...base, model: e.model, ok: false, status: 'error', ms: Date.now() - t0, detail: String(err?.message || err).slice(0, 90) };
    }
    const ms = Date.now() - t0;
    const model = res.model || e.model || null;
    const out = (res.text || '').replace(/\s+/g, ' ').trim();
    const ok = !!(res.ok && out.length > 0);
    if (ok) return { ...base, model, ok, status: 'ok', ms, detail: out.slice(0, 40) };
    const blob = `${res.error || ''} ${res.text || ''}`;
    const status = res.timedOut || /timeout|timed out/i.test(blob) ? 'timeout'
      : /auth|login|unauthor|forbidden|sign.?in|\b401\b|\b403\b/i.test(blob) ? 'auth'
      : /model|not found|unknown model|invalid|unsupported/i.test(blob) ? 'bad_model'
      : 'failed';
    return { ...base, model, ok, status, ms, detail: (res.error || 'no response').replace(/\s+/g, ' ').trim().slice(0, 90) };
  };

  const ICON = { ok: `${C.green}✓${C.reset}`, not_installed: `${C.dim}○${C.reset}`, unknown: `${C.dim}○${C.reset}` };
  const fmtLine = (r) => {
    const icon = ICON[r.status] || `${C.red}✗${C.reset}`;
    const verdict = r.ok ? `${C.green}live${C.reset}` : `${C.red}${r.status}${C.reset}`;
    const lat = r.ms ? `  ${C.dim}${(r.ms / 1000).toFixed(1)}s${C.reset}` : '';
    // Actual model that answered (cyan). "(default)" = live but the CLI didn't disclose it.
    const modelCol = r.model ? `  ${C.cyan}${r.model}${C.reset}` : (r.status === 'ok' ? `  ${C.dim}(default)${C.reset}` : '');
    return `${icon} ${C.bold}${r.label}${C.reset}  ${verdict}${lat}${modelCol}  ${C.dim}${r.detail || ''}${C.reset}`;
  };

  const isTTY = !!process.stdout.isTTY && !flags.json;
  const results = new Array(entries.length);
  if (!flags.json) console.log(`${C.bold}x-panel preflight${C.reset} — live model check (one tiny real call per model)\n`);

  // truncateVisible (module scope) keeps each provider on exactly one physical terminal row;
  // the cursor-up overwrite scheme below desyncs into duplicate lines if a row ever wraps.
  if (isTTY) {
    // Live block: one line per model, a spinner while pending, filled in place the moment
    // its probe resolves — so a slow provider (codex ~25s) doesn't blank the whole screen.
    const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    const state = entries.map((e) => ({ label: e.label, done: false, line: null }));
    let spin = 0, first = true;
    const render = () => {
      if (!first) process.stdout.write(`\x1b[${state.length}A`);
      first = false;
      const frame = SPIN[spin = (spin + 1) % SPIN.length];
      const width = Math.max(20, (process.stdout.columns || 80) - 1);
      for (const s of state) {
        const body = s.done ? s.line
          : `${C.cyan}${frame}${C.reset} ${C.bold}${s.label}${C.reset}  ${C.dim}checking…${C.reset}`;
        process.stdout.write(`\x1b[K${truncateVisible(body, width)}\n`);
      }
    };
    render();
    const timer = setInterval(render, 100);
    await Promise.all(entries.map((e, i) => probeOne(e).then((r) => { results[i] = r; state[i].done = true; state[i].line = fmtLine(r); })));
    clearInterval(timer);
    render(); // final frame — every line filled
  } else {
    // Non-TTY (piped): run in parallel; for text output print each line as it completes.
    await Promise.all(entries.map((e, i) => probeOne(e).then((r) => { results[i] = r; if (!flags.json) console.log(fmtLine(r)); })));
  }

  // Persist fresh `ok` verdicts (7-day hard prune so stale labels never pile up).
  if (ttlS > 0) {
    const now = Date.now();
    const entries = Object.fromEntries(Object.entries(cacheEntries).filter(([, v]) => v && v.at_ms && now - v.at_ms < 7 * 86400_000));
    for (const r of results) if (r && r.ok && !r.cached) entries[r.label] = { ok: true, model: r.model || null, at_ms: now };
    try { ensureDir(PANEL_DIR); writeJSON(cachePath, { schema: 1, entries }); } catch { /* best-effort */ }
  }

  const okN = results.filter((r) => r.ok).length;
  if (flags.json) {
    console.log(JSON.stringify({ ok: okN, total: results.length, cross_vendor: okN >= 2, results }, null, 2));
    process.exit(okN >= 1 ? 0 : 1);
  }

  const tail = okN >= 2 ? `${C.green}cross-vendor OK${C.reset}`
    : okN === 1 ? `${C.yellow}single-vendor only (cross-vendor needs ≥2)${C.reset}`
    : `${C.red}no live models — panel will fail${C.reset}`;
  console.log(`\n${okN}/${results.length} live — ${tail}`);
  if (okN < results.length) {
    console.log(`${C.dim}auth issue → xm panel doctor   ·   bad model → xm panel models <vendor> --check <id>${C.reset}`);
  }
  process.exit(okN >= 1 ? 0 : 1);
}

function printHelp() {
  console.log(`x-panel — Cross-Model Adversarial Review Panel (PoC)

Calls multiple model CLIs headlessly, has each review the same target, runs one
adversarial round, and synthesizes a verdict with consensus merge. Tool-neutral.

Commands:
  (review) [target]             Run the panel — "review" is optional:
                                  x-panel              review git diff with your default models
                                  x-panel ./file       review a file
                                  x-panel --full       review with all installed models
    --models a,b,c              Override models — name or name:model (e.g. cursor:kimi-k2.5,
                                cursor:claude-opus-4-8-thinking-high,kiro:deepseek-3.2). cursor & kiro are
                                multi-vendor; list a provider's live models with \`xm panel types\`.
    --fast | --full | --preset NAME   fast=claude,codex · full=all installed · or a named preset
    --judge rule                Synthesis (PoC: rule only)
    --timeout SECONDS           Per-model idle timeout (default 600; config: panel.timeout_s).
                                Resets on stdout activity (a working model keeps going); a model
                                silent this long is killed as stalled. Auto-raised for large
                                targets (cap panel.timeout_max_s, default 1200).
                                Auto-raised for large targets (cap panel.timeout_max_s=900); --timeout pins it.
    --stream | --no-stream      Structured streaming: live token/cost per model (claude/cursor/codex).
                                Opt-in (default off; config: panel.stream). kiro/agy stay raw.
    --tm-events | --no-tm-events  Live xk_run telemetry to a term-mesh daemon when one is detected
                                (default on; config: panel.tm_events). Best-effort — never blocks a run.
    --session-reuse | --no-session-reuse
                                Round 2 resumes each provider's round-1 session and sends only the
                                refute delta — the target never travels twice (default on; config:
                                panel.session_reuse). claude + codex only; codex needs its session id
                                from the run banner (else stateless). Any resume failure retries
                                stateless LOUDLY and is recorded as resume:"fallback" in the verdict.
                                Auto-off under --stream (stream argv is kept exactly as dogfooded).
    --partial | --no-partial    Token-level live text for claude/cursor (default on within --stream;
                                config: panel.stream_partial). Auto-off when target > panel.partial_max_chars
                                (default 50000) unless --partial forces it. codex/agy/kiro unaffected.
    --force                     Override the trivial-target guard: an empty target, or a git-diff
                                below panel.min_target_chars (default 40 — incl. the clean-tree
                                "(no diff against HEAD)" sentinel), exits 2 instead of burning
                                N models × 2 rounds. Review & cross also gate participants on
                                provider readiness (install + auth, no model call — cached 30min;
                                config panel.readiness_ttl_s, --fresh re-checks): excluded providers
                                are reported on stderr and as skipped_providers in --json.
    --json

  setup [--models a,b] [--judge rule] [--global]
                                Save default models/judge to config
                                (project .xm/config.json, or ~/.xm with --global).
                                No args → show detected + current config.

  doctor [--probe] [--json]     Static readiness: is each provider installed AND
                                authenticated? Catches logged-out CLIs before a run fails
                                mid-panel. NO model call (except --probe, for agy only).
  preflight [--models a,b,c] [--timeout N] [--json] [--fresh]
                                LIVE check: send one tiny prompt to each model the panel
                                would actually use (config/preset/--models, incl. name:model)
                                and report which respond. Catches an authed provider whose
                                CONFIGURED model is invalid/unavailable/rate-limited — which
                                doctor cannot see. Costs one minimal call per model. Exit 0 if
                                ≥1 live. Run this before a real panel when models are uncertain.
                                Recent "live" verdicts are cached (default 30min; config
                                panel.preflight_ttl_s, 0 = off) so repeated preflights in one
                                session cost nothing — failures are never cached. --fresh re-probes.
  detect [--auth] [--json]      Print available (installed) + known providers — lets a
                                caller decide single-vendor fallback BEFORE spending tokens.
                                --auth narrows "available" to installed AND ready: authenticated,
                                OR assumed-ready (a no-auth-status CLI like agy whose creds are
                                present). Still skips logged-out CLIs. Use doctor --probe to verify.
  cross --models a,b,c (--prompt "..." | --prompt-file <p> | --prompt -) [--json]
        [--source <tag>] [--title <text>]
                                Generic cross-vendor invocation: run ONE prompt across N vendors,
                                return each vendor's RAW text output (no findings/merge). For
                                deliberation (debate/council) — caller does the synthesis.
                                Output under .xm/cross/<run>/. Writes a live status.json
                                heartbeat (~2s) while running, so status/--watch show per-model
                                state · elapsed · output tail for cross runs too, plus an
                                events.jsonl milestone log (spawn/stderr/timeout/exit) so
                                status <run> --logs works for cross runs as well.
                                --source tags the calling workflow (e.g. op:debate, build:consensus,
                                solver:hypothesize, eval:judge) and --title names the run; both
                                surface in the dashboard panel list so runs are identifiable.
  gate <run> [--policy '<json>'] [--json]
                                Turn a finished run's verdict.json into a merge-gate EXIT CODE
                                (0 pass / 1 policy block / 2 error) — for CI and non-worktree users
                                (a panel --json run always exits 0, even with blocking findings).
                                Run a panel first (xm panel review <target>), then gate it by run id.
                                Policy defaults: block confirmed critical/high/medium, unreviewed
                                critical/high, contested critical, allow_low. --policy overrides per
                                bucket, e.g. '{"block_confirmed":["critical","high"]}'. Writes an
                                auditable gate-result.json next to the run.
  status [run] [--all] [--json] [--watch|--follow [--interval N]] [--logs]
                                Read run state from disk — see an IN-PROGRESS panel from the CLI.
                                Covers all three namespaces: .xm/panel (native), .xm/review
                                (lens-injected x-review runs, labeled "x-review(...)"), .xm/cross.
                                No run → list THIS project's recent runs (cwd/.xm),
                                with a project header + staleness (a dead run shows "stalled · Nago",
                                not a phantom "running"). --all → every registered project, grouped
                                (~/.xm/projects.json). A run id → per-model state + each model's
                                latest stdout tail. Read-only. --watch is a LIVE activity board:
                                only in-progress runs, one line per agent (state · elapsed · phase ·
                                tokens/cost · freshness), a per-run round progress (n/N done),
                                refreshed every N seconds (default 2); combine with --all to watch
                                every project at once. --lines N (or config panel.watch_lines) shows
                                an INTERPRETED tail under each agent: a findings/verdicts JSON answer
                                becomes one line per item (severity · file:line · claim / stance ·
                                ref · reason), a still-streaming answer a progress note, an echoed
                                prompt a waiting note; free-form text renders as-is.
                                --watch --json emits one COMPACT JSON snapshot per tick (JSONL, no
                                ANSI) for agent/pipe consumers. Watching a RUN ID ends when the run
                                finishes: exit 0 on done, 1 on stalled (dead process) — both for
                                text and --json. Compact one-line-per-run list otherwise (vendor
                                glyphs ✓✗●·, model-id in the run's detail view).
                                --follow = --watch. With a term-mesh daemon present, xk_run events
                                re-render immediately (<1s) between polls; if the daemon dies the
                                watch says so and continues polling (--no-tm-events to disable).
                                --logs <run> streams the RAW event log (events.jsonl: each model's
                                stdout/stderr/spawn/exit lines) instead of the interpreted board —
                                last N (--lines N, default 200), or tail -f with --watch. Works for
                                review AND cross runs (legacy cross runs predate the log).
  types                         List providers (install status) + how to query each
                                one's live models (cursor/kiro are multi-vendor: kimi, deepseek, …)
  models [vendor] [--check m1,m2]
                                Print a vendor's REAL live model catalog (cursor → kimi-k2.5, glm,
                                grok…). --check verifies model IDs exist — vet a config/--models entry.

  Review-prompt injection (programmatic — for cross-vendor review by other plugins):
    --review-prompt-file <path>   Override round-1 reviewer prompt with a custom lens prompt
    --review-prompt -             Read the override from stdin
    --lens-tag <name>             Tag round-1 findings with this lens (flows to verdict)
                                  Injected runs write to .xm/review/<run>/ (not .xm/panel/).
  help

Model resolution: --models > preset > config > autodetect installed CLIs.
Providers: ${knownProviders().join(', ')} — run \`xm panel types\` for each one's live models
(cursor & kiro front many vendors: kimi, deepseek, glm, gemini, grok…). Override a CLI with X_PANEL_CMD_<MODEL>.
Output: .xm/panel/<run>/{<model>.r1.json, <model>.r2.json, verdict.json}
`);
}

function readJSONSafe(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

const STATUS_STALE_MS = 30_000;       // review + cross flush status.json ~every 2s → 30s = dead
const CROSS_STALE_MS = 15 * 60_000;   // LEGACY cross runs only (pre-heartbeat, no status.json): mtime guess

// Human-readable age of an ISO timestamp ("12s" / "35m" / "6h" / "2d"), or null if unparseable.
function statusAge(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// One run dir → a normalized status row. STALENESS: a non-done review whose status.json hasn't been
// touched within STATUS_STALE_MS is a DEAD process (terminal closed / interrupted / crashed) — its
// last-written phase says "running" forever, which is misleading. Mark it "stalled" instead, so a
// 6-hours-ago interrupted run never masquerades as live. (Mirrors the dashboard's isPanelRunLive.)
function statusRunRow(entry) {
  if (entry.kind === 'cross') {
    const res = readJSONSafe(join(entry.dir, 'result.json'));
    const st = readJSONSafe(join(entry.dir, 'status.json'));
    const done = !!res || !!(st && st.phase === 'done');
    let models;
    if (res && res.results) models = res.results.map((v) => ({ label: v.model, state: v.ok === false ? 'failed' : 'done', error: v.error || null }));
    else if (res) models = (res.models || []).map((l) => ({ label: l, state: 'done' }));
    // Live heartbeat: cross writes a review-style status.json while running — full model
    // objects (state/elapsed/tails) so the --watch board renders cross like a review run.
    else if (st) models = st.models || [];
    else models = readdirSync(entry.dir).filter((f) => f.endsWith('.json') && f !== 'result.json' && f !== 'status.json').map((f) => {
      // a present per-vendor file means THAT vendor already finished — read its ok, don't call it "running".
      const v = readJSONSafe(join(entry.dir, f));
      return { label: (v && v.model) || f.replace(/\.json$/, ''), state: v ? (v.ok === false ? 'failed' : 'done') : 'running', error: (v && v.error) || null };
    });
    let live = false, age = null;
    if (!done) {
      if (st) {
        // heartbeat present → the same 30s freshness rule as review (status.json ticks ~2s).
        const t = Date.parse(st.updated_at || '');
        live = Number.isFinite(t) && (Date.now() - t) < STATUS_STALE_MS;
        age = statusAge(st.updated_at);
      } else {
        // legacy runs (pre-heartbeat) have only the dir mtime; keep the generous window — a
        // multi-vendor cross can legitimately run for minutes between file writes.
        const mt = (() => { try { return statSync(entry.dir).mtimeMs; } catch { return 0; } })();
        if (mt > 0) { live = (Date.now() - mt) < CROSS_STALE_MS; age = statusAge(new Date(mt).toISOString()); }
        // mt === 0 (stat failed) → leave live=false, age=null; never age off the epoch ("56 years ago").
      }
    }
    return { kind: 'cross', run: entry.run, source: (res && res.source) || (st && st.source) || 'cross',
      title: (res && res.title) || (st && st.title) || null,
      phase: done ? 'done' : live ? 'running' : 'stalled', live, stale: !done && !live, age,
      phaseRaw: st ? st.phase : null, models };
  }
  const st = readJSONSafe(join(entry.dir, 'status.json'));
  const done = (st && st.phase === 'done') || existsSync(join(entry.dir, 'verdict.json'));
  const t = st && Date.parse(st.updated_at || '');
  const live = !done && Number.isFinite(t) && (Date.now() - t) < STATUS_STALE_MS;
  const stale = !done && !live && !!st;
  const phase = done ? 'done' : stale ? 'stalled' : (st ? st.phase : 'unknown');
  // Namespace prefixes the source label ("x-review(file)" vs "review(file)") so a lens-injected
  // run from x-review is distinguishable from a native panel review in the same list.
  const srcBase = entry.ns || 'review';
  return { kind: 'review', run: entry.run, source: st && st.target_kind ? `${srcBase}(${st.target_kind})` : srcBase,
    title: (st && st.target_title) || null, phase, live, stale, age: st ? statusAge(st.updated_at) : null,
    phaseRaw: st ? st.phase : null, models: st ? st.models : [] };
}

// Canonical vendor order so the per-run glyph columns line up under one legend, run to run.
const STATUS_VENDORS = ['claude', 'codex', 'agy', 'cursor', 'kiro'];
const vendorOf = (label) => String(label || '').split(':')[0];
const statusLegend = () => `${C.dim}vendors ${STATUS_VENDORS.join(' ')} · ✓done ✗fail ●live ·absent${C.reset}`;

// Compact per-vendor state glyphs in canonical order: ✓done ✗failed ●running ·absent/other.
function statusGlyphs(models) {
  return STATUS_VENDORS.map((v) => {
    const m = (models || []).find((x) => vendorOf(x.label) === v);
    if (!m) return `${C.dim}·${C.reset}`;
    return m.state === 'done' ? `${C.green}✓${C.reset}` : m.state === 'failed' ? `${C.red}✗${C.reset}`
      : m.state === 'running' ? `${C.yellow}●${C.reset}` : `${C.dim}·${C.reset}`;
  }).join('');
}

// Human token count ("12.3k tok") for the watch board's live usage column, or null when
// the run carries no usage yet (raw mode / round not started).
function fmtTokens(t) {
  if (!t) return null;
  const n = (t.input || 0) + (t.output || 0);
  if (!n) return null;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

// Progress fragments for one agent: phase (thinking/responding), output volume, live
// tokens/cost, and freshness (how long since its last event) — the "is it actually
// moving" signals a bare state glyph + elapsed can't answer. Falls back to the last
// lifecycle event when none of the live signals exist (raw mode before first output).
function modelProgress(m) {
  const parts = [];
  if (m.phase_label) parts.push(m.phase_label);
  if (m.stdout_bytes) parts.push(`↑${m.stdout_bytes >= 1000 ? (m.stdout_bytes / 1000).toFixed(1) + 'k' : m.stdout_bytes}`);
  const tok = fmtTokens(m.tokens);
  if (tok) parts.push(tok);
  if (m.cost_usd != null && m.cost_usd > 0) parts.push(`$${m.cost_usd.toFixed(2)}`);
  const age = statusAge(m.updated_at);
  if (age) parts.push(`${age} ago`);
  // Round-2 fidelity (written post-synthesis): a refuter that mangled refs or stances.
  if (m.unmatched_refs) parts.push(`${C.yellow}${m.unmatched_refs} unmatched ref(s)${C.reset}`);
  if (m.invalid_stances) parts.push(`${C.yellow}${m.invalid_stances} invalid stance(s)${C.reset}`);
  if (!parts.length && m.last_event) parts.push(m.last_event);
  return parts;
}

// Compiled once (a /g regex resets lastIndex on each .replace, so reuse is safe).
const CLI_ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
function stripAnsiCli(s) {
  return String(s || '').replace(CLI_ANSI_RE, '');
}

// Hard-truncate a colored string to `max` VISIBLE chars without cutting an ANSI escape
// sequence in half — so a line can never wrap. A wrapped line desyncs every repaint scheme
// (preflight's cursor-up overwrite, --watch's clear-and-redraw) into duplicate rows.
function truncateVisible(s, max) {
  if (max <= 0) return '';
  let out = '', visible = 0, i = 0;
  while (i < s.length) {
    if (s[i] === '\x1b' && s[i + 1] === '[') {
      const end = s.indexOf('m', i);
      if (end !== -1) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    if (visible < max) { out += s[i]; visible++; }
    i++;
  }
  return out;
}

// ── live-output interpretation (status/--watch tails) ────────────────
// Round answers are contract JSON ({"findings":[…]} / {"verdicts":[…]}) — dumped raw on the
// watch board they are unreadable, and some provider CLIs (codex) echo OUR prompt into their
// stream before answering, so the tail can even show our own instructions back. Interpret
// instead: drop the echo, summarize a JSON answer one item per line, and only fall through
// to raw lines when the output is genuine free-form text (reasoning, cross runs).

// Fragments of the contract lines this CLI appends LAST to every round prompt
// (FINDINGS_CONTRACT / refutePrompt). In an echoed stream everything up to the last
// matching line is our prompt; everything after it is genuine model output. Each mark
// must be a literal that can only exist in the CONTRACT, never in a real answer — the
// schema placeholders ("critical|high|medium|low", "refute|concede") qualify; a bare
// '{"verdicts":[{"ref":' would also match the model's actual verdict JSON.
const PROMPT_ECHO_MARKS = [
  'Return ONLY a JSON object',
  'If there are no real issues, return',
  '"severity":"critical|high|medium|low"',
  '"stance":"refute|concede|abstain"',
  '- refute = wrong, not real',
  '- concede = a real issue worth fixing',
  '- abstain = cannot judge from the provided evidence',
];

function dropPromptEcho(lines) {
  const markerAt = [];
  for (let i = 0; i < lines.length; i++) {
    // A JSON answer line may QUOTE a contract fragment inside a claim (e.g. when the diff under
    // review contains these very marks) — never treat a JSON-shaped line as echo. The echoed
    // contract always ends in PROSE lines, so the cut point still lands after a full echo.
    if (lines[i].trimStart().startsWith('{')) continue;
    if (PROMPT_ECHO_MARKS.some((s) => lines[i].includes(s))) markerAt.push(i);
  }
  // A real echoed contract is a BLOCK: both rounds end in 2+ prose marker lines. A single
  // match is far more likely a genuine prose answer QUOTING one contract phrase — cutting
  // there would hide real output (logic-lens finding). Trade-off: while an echo is still
  // streaming in (only its first marker line arrived), that one line shows raw for a tick
  // or two until the rest of the block lands — transient noise beats lost content.
  if (markerAt.length < 2) return lines;
  return lines.slice(markerAt[markerAt.length - 1] + 1);
}

// JSON.parse turns \u001b (and other control-char) ESCAPES into real bytes AFTER the raw-text
// ANSI strip already ran — a decoded claim/reason/file could repaint or clear the operator's
// terminal (panel security consensus finding, CoVe-confirmed). Sanitize every decoded field
// at render time: strip well-formed ANSI, then any remaining control byte.
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;
function cleanField(v) {
  return stripAnsiCli(String(v ?? '')).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
}

// The model's own output lines: ANSI-stripped, echo-dropped, blanks removed. Prefer stdout
// (the answer); fall back to stderr, where some CLIs stream reasoning. A stream that is ALL
// prompt echo counts as "no content yet", so the stderr fallback can still kick in.
function tailContentLines(m) {
  for (const raw of [m.stdout_tail, m.stderr_tail]) {
    if (!raw || !String(raw).trim()) continue;
    const lines = dropPromptEcho(stripAnsiCli(raw).split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim()));
    if (lines.length) return lines;
  }
  return [];
}

// Longest balanced {...} prefix of `s`, or null while the object is still streaming (unclosed).
// Brace counting respects strings/escapes so a brace inside a "claim" doesn't derail it.
function jsonPrefix(s) {
  let depth = 0, str = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (str) { if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return s.slice(0, i + 1);
  }
  return null;
}

// Find the round's contract JSON inside free-form output. Complete object → {kind, items};
// object opened but not yet closed (still streaming) → {kind, partial: items so far};
// nothing recognizable → null (caller shows the raw lines).
function parseAnswerJSON(text) {
  for (const [key, probe] of [['findings', /"claim"\s*:/g], ['verdicts', /"stance"\s*:/g]]) {
    const k = text.lastIndexOf(`"${key}"`);
    if (k < 0) continue;
    const open = text.lastIndexOf('{', k);
    if (open < 0 || k - open > 20) continue; // `"findings"` mentioned in prose, not an object key
    const body = jsonPrefix(text.slice(open));
    if (body == null) return { kind: key, partial: (text.slice(k).match(probe) || []).length };
    try {
      const items = JSON.parse(body)[key];
      // Models sometimes emit null/non-object array elements — drop them here so no renderer
      // ever dereferences one (a null finding crashed the live watch loop on real data).
      if (Array.isArray(items)) return { kind: key, items: items.filter((x) => x && typeof x === 'object') };
    } catch { /* malformed close — fall through to raw lines */ }
  }
  return null;
}

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const worstSeverity = (items) => SEV_ORDER.find((s) => items.some((f) => cleanField(f.severity).toLowerCase() === s)) || 'low';

function summarizeFindings(items, n) {
  if (!items.length) return [`${C.green}✓ no issues found${C.reset}`];
  // A one-line budget can't fit "finding + overflow marker" (two lines) — collapse to a count.
  if (n === 1 && items.length > 1) return [`${sev(worstSeverity(items))} ${items.length} findings — ${cleanField(items[0].claim)}`];
  const shown = items.slice(0, items.length > n ? Math.max(1, n - 1) : n);
  const out = shown.map((f) => {
    const file = cleanField(f.file), lineNo = cleanField(f.line);
    const loc = file ? `${C.cyan}${file}${lineNo ? ':' + lineNo : ''}${C.reset}  ` : '';
    return `${sev(cleanField(f.severity) || 'low')} ${loc}${cleanField(f.claim)}`;
  });
  if (items.length > shown.length) out.push(`… +${items.length - shown.length} more`);
  return out;
}

function summarizeVerdicts(items, n) {
  if (!items.length) return ['verdicts: none'];
  if (n === 1 && items.length > 1) {
    const conc = items.filter((v) => v.stance === 'concede').length;
    const ref = items.filter((v) => v.stance === 'refute').length;
    const abst = items.length - conc - ref;
    return [`${items.length} verdicts — ${C.green}${ref} refute${C.reset} · ${C.yellow}${conc} concede${C.reset}${abst ? ` · ${C.dim}${abst} abstain${C.reset}` : ''}`];
  }
  const shown = items.slice(0, items.length > n ? Math.max(1, n - 1) : n);
  const out = shown.map((v) => {
    // stance renders as one of three LITERAL words (never the raw field) — nothing to sanitize.
    // Anything that isn't refute/concede reads as abstain, matching normalizeVerdicts.
    const stance = v.stance === 'concede' ? `${C.yellow}concede${C.reset}`
      : v.stance === 'refute' ? `${C.green}refute${C.reset}` : `${C.dim}abstain${C.reset}`;
    return `${stance} ${C.cyan}${cleanField(v.ref) || '?'}${C.reset}  ${cleanField(v.reason)}`;
  });
  if (items.length > shown.length) out.push(`… +${items.length - shown.length} more`);
  return out;
}

// Colored, human-readable tail for the text renderers (watch board + run detail):
// a findings/verdicts answer → one line per item, a still-streaming answer → a progress
// note, an all-echo stream → an explicit waiting note, anything else → the raw lines.
function renderTailSummary(m, n) {
  if (n <= 0) return [];
  try {
    const lines = tailContentLines(m);
    if (!lines.length) {
      const sawEcho = (m.stdout_tail && m.stdout_tail.trim()) || (m.stderr_tail && m.stderr_tail.trim());
      return sawEcho ? [`${C.cyan}⋯${C.reset} prompt echoed — waiting for the model's answer`] : [];
    }
    const ans = parseAnswerJSON(lines.join('\n'));
    if (!ans) return lines.slice(-n);
    if (ans.partial != null) {
      const unit = ans.kind === 'findings' ? 'finding' : 'verdict';
      return [`${C.cyan}⋯ answering${C.reset}${ans.partial ? ` — ${ans.partial} ${unit}${ans.partial === 1 ? '' : 's'} so far` : '…'}`];
    }
    return ans.kind === 'findings' ? summarizeFindings(ans.items, n) : summarizeVerdicts(ans.items, n);
  } catch (err) {
    // One malformed record must not kill the whole live watch loop — surface it loudly
    // on the offending row instead of crashing the board (Lesson L6: no silent failures).
    return [`${C.red}tail interpret failed: ${cleanField(err && err.message)}${C.reset}`];
  }
}

// The last `n` non-empty lines of an agent's live output for --json consumers — echo-dropped
// but otherwise verbatim (machines parse the JSON answer themselves).
function statusTailLines(m, n) {
  return n <= 0 ? [] : tailContentLines(m).slice(-n);
}

// All runs under one .xm root, newest first. THREE namespaces: .xm/panel (native panel),
// .xm/review (lens-injected cross-vendor reviews — same status.json format, separate dir so
// they never collide with panel history), .xm/cross (raw cross-vendor invocations). Missing
// the review namespace made x-review's in-progress panels invisible to status/--watch.
function collectStatusRuns(xmRoot, limit = 20) {
  // Only runId-shaped dirs (panel-<stamp>) are runs — .xm/review is SHARED with x-review's own
  // artifacts (history/, last-result.*), which must not appear as phantom runs.
  const mk = (dir, kind, ns) => existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('panel-')).map((e) => ({ kind, ns, run: e.name, dir: join(dir, e.name) }))
    : [];
  return [...mk(join(xmRoot, 'panel'), 'review', null), ...mk(join(xmRoot, 'review'), 'review', 'x-review'), ...mk(join(xmRoot, 'cross'), 'cross', null)]
    .sort((a, b) => b.run.localeCompare(a.run)).slice(0, limit).map(statusRunRow);
}

// Registered projects from ~/.xm/projects.json (the same source the dashboard uses) — non-archived,
// with an .xm dir. The current cwd's project is always first (even if unregistered).
function statusProjects() {
  const out = [], seen = new Set();
  const add = (name, xmRoot) => { if (!seen.has(xmRoot)) { seen.add(xmRoot); out.push({ name, xmRoot }); } };
  add(basename(dirname(XM_ROOT)) || 'project', XM_ROOT);
  // Resolve the global xm dir the same way core.mjs does (X_PANEL_GLOBAL_ROOT override → ~/.xm) so
  // the registry read honors test isolation and any custom global root, not a hardcoded homedir.
  const globalRoot = process.env.X_PANEL_GLOBAL_ROOT ? process.env.X_PANEL_GLOBAL_ROOT : join(homedir(), '.xm');
  try {
    const reg = JSON.parse(readFileSync(join(globalRoot, 'projects.json'), 'utf8'));
    for (const p of (reg.projects || [])) {
      if (p.archived) continue;
      const xr = join(p.path, '.xm');
      if (existsSync(xr)) add(p.name || p.id || basename(p.path), xr);
    }
  } catch { /* no registry → current project only */ }
  return out;
}

// One-line compact history row: {status} {source} {vendor glyphs} {title}  {dim time/id}.
// The per-model model-id (claude-opus-4-8 …) is dropped here — it lives in the detail view; the
// list only needs which vendor did what (glyph), so a 40-run list stays scannable.
function printStatusRow(r) {
  const g = r.phase === 'done' ? `${C.green}✓${C.reset}` : r.stale ? `${C.dim}⚠${C.reset}` : `${C.yellow}●${C.reset}`;
  const title = compactTitle(r.title || '', 46) || `${C.dim}${r.run}${C.reset}`;
  const meta = r.stale && r.age ? `${C.dim}${r.age} ago${C.reset}` : `${C.dim}${r.run.replace(/^panel-/, '')}${C.reset}`;
  console.log(`${g} ${C.cyan}${r.source.padEnd(15)}${C.reset} ${statusGlyphs(r.models)}  ${title}  ${meta}`);
}

// One agent → a machine-readable progress record: the SAME signals the text board renders
// (state, elapsed, phase, output volume, tokens/cost, freshness, optional output tail).
// tokens/cost prefer the round-scoped live fields and fall back to the cumulative ones, so
// a model between rounds still shows what it has consumed so far.
function watchModelJSON(m, linesN) {
  const out = {
    label: m.label,
    vendor: vendorOf(m.label),
    state: m.state,
    elapsed_s: m.elapsed_s ?? null,
    phase_label: m.phase_label || null,
    last_event: m.last_event || null,
    error: m.error || null,
    stdout_bytes: m.stdout_bytes || 0,
    tokens: m.tokens || ((m.cum_tokens && ((m.cum_tokens.input || 0) + (m.cum_tokens.output || 0) > 0)) ? m.cum_tokens : null),
    cost_usd: (m.cost_usd != null) ? m.cost_usd : (m.cum_cost_usd || null),
    updated_at: m.updated_at || null,
    // Round-2 fidelity counters (post-synthesis) — only present when non-zero, so the
    // compact snapshot shape stays stable for runs that never had a fidelity problem.
    ...(m.unmatched_refs ? { unmatched_refs: m.unmatched_refs } : {}),
    ...(m.invalid_stances ? { invalid_stances: m.invalid_stances } : {}),
    ...(linesN > 0 ? { tail: statusTailLines(m, linesN) } : {}),
  };
  // The text board interprets the tail from the raw record (full stdout/stderr tails);
  // non-enumerable so --watch --json snapshots keep their compact, stable shape.
  Object.defineProperty(out, '_rec', { value: m });
  return out;
}

// How many lines of each agent's live output to show under it — the "what is it reasoning"
// view. 0 = compact. Flag wins; else the persistent panel.watch_lines setting.
function watchLinesN(flags) {
  return flags.lines != null ? flags.lines : (loadPanelConfig().watch_lines || 0);
}

// The --watch board as one snapshot object — the single source for BOTH renderers: the
// text board prints it, --watch --json emits it as a JSONL line per tick.
function watchBoardSnapshot(flags) {
  const projects = flags.all ? statusProjects() : [{ name: basename(dirname(XM_ROOT)) || 'project', xmRoot: XM_ROOT }];
  const linesN = watchLinesN(flags);
  const live = [];
  let done = 0, stalled = 0;
  for (const p of projects) {
    for (const r of collectStatusRuns(p.xmRoot, 100)) {
      if (r.live && r.phase !== 'done') {
        const models = (r.models || []).map((m) => watchModelJSON(m, linesN));
        live.push({
          project: p.name, kind: r.kind, run: r.run, source: r.source, title: r.title,
          phase: r.phaseRaw || r.phase,
          elapsed_s: Math.max(0, ...(r.models || []).map((m) => m.elapsed_s || 0)),
          progress: { done: models.filter((m) => m.state === 'done' || m.state === 'failed').length, total: models.length },
          models,
        });
      } else if (r.stale) stalled++;
      else done++;
    }
  }
  return { at: new Date().toISOString(), live, done, stalled, projects: projects.length };
}

// One run's detail as a snapshot (JSONL line per tick under `status <run> --watch --json`).
// `found:false` = the run dir doesn't exist yet (a watcher may start before the run does).
// Resolve a run id to its on-disk dir across the THREE namespaces (panel → review → cross).
// The single run→dir resolver — watchRunSnapshot AND `--logs` share it, so adding a namespace
// happens in exactly one place. Returns null when the run doesn't exist yet.
function resolveRunDir(runArg) {
  const panel = join(PANEL_DIR, runArg);
  if (existsSync(panel)) return { dir: panel, kind: 'review' };
  const review = join(PANEL_DIR, '..', 'review', runArg);
  if (existsSync(review)) return { dir: review, kind: 'review' };
  const cross = join(PANEL_DIR, '..', 'cross', runArg);
  if (existsSync(cross)) return { dir: cross, kind: 'cross' };
  return null;
}

// done/stale drive the watch loop's end condition — a consumer needs the stream to END.
function watchRunSnapshot(runArg, linesN = 0) {
  const at = new Date().toISOString();
  // panel + review namespaces share the status.json format; cross has its own row shape.
  const resolved = resolveRunDir(runArg);
  if (resolved && resolved.kind === 'review') {
    const reviewDir = resolved.dir;
    const st = readJSONSafe(join(reviewDir, 'status.json'));
    const done = (st && st.phase === 'done') || existsSync(join(reviewDir, 'verdict.json'));
    const t = st && Date.parse(st.updated_at || '');
    // no status.json yet ≠ stalled — the run may not have flushed its first status; keep waiting.
    const stale = !done && !!st && !(Number.isFinite(t) && (Date.now() - t) < STATUS_STALE_MS);
    const models = ((st && st.models) || []).map((m) => watchModelJSON(m, linesN));
    return {
      at, run: runArg, kind: 'review', found: true,
      phase: done ? 'done' : stale ? 'stalled' : (st ? st.phase : 'starting'), done, stale,
      progress: { done: models.filter((m) => m.state === 'done' || m.state === 'failed').length, total: models.length },
      totals: (st && st.totals) || null,
      models,
    };
  }
  if (resolved && resolved.kind === 'cross') {
    const crossDir = resolved.dir;
    const row = statusRunRow({ kind: 'cross', run: runArg, dir: crossDir });
    const models = (row.models || []).map((m) => watchModelJSON(m, linesN)); // tails exist while the heartbeat status.json is live
    return {
      at, run: runArg, kind: 'cross', found: true,
      phase: row.phase, done: row.phase === 'done', stale: !!row.stale,
      progress: { done: models.filter((m) => m.state === 'done' || m.state === 'failed').length, total: models.length },
      totals: null,
      models,
    };
  }
  return { at, run: runArg, kind: null, found: false, phase: 'waiting', done: false, stale: false, progress: { done: 0, total: 0 }, models: [] };
}

// --watch board: NOT a history list — a live activity monitor answering "which project · which
// command · which agent · doing what right now". Only in-progress runs are expanded (one line per
// agent with its state + elapsed + current progress signals); finished/stalled runs collapse to a
// footer count. Empty when nothing is running.
function renderStatusWatch(flags) {
  const snap = watchBoardSnapshot(flags);
  const linesN = watchLinesN(flags);
  const width = Math.max(24, (process.stdout.columns || 100) - 12);
  const clock = new Date().toTimeString().slice(0, 8);
  console.log(`${C.bold}panel watch${C.reset} · ${snap.live.length ? `${C.yellow}${snap.live.length} live${C.reset}` : `${C.dim}0 live${C.reset}`} · ${C.dim}${clock}${C.reset}`);
  if (!snap.live.length) console.log(`\n${C.dim}(no active panels — a run appears here while it is in progress)${C.reset}`);
  for (const r of snap.live) {
    // The phase/progress fragment is the header's load-bearing info — full contrast, not dim.
    console.log(`\n${C.bold}▸ ${r.project}${C.reset}  ${C.cyan}${r.source}${C.reset}  ${r.title || r.run}   ${C.yellow}${r.phase}${C.reset} · ${r.progress.done}/${r.progress.total} done · ${r.elapsed_s}s`);
    for (const m of r.models) {
      const glyph = m.state === 'done' ? `${C.green}✓${C.reset} ` : m.state === 'failed' ? `${C.red}✗${C.reset} `
        : m.state === 'running' ? `${C.yellow}⏳${C.reset}` : `${C.dim}·${C.reset} `;
      const el = m.elapsed_s != null ? `${m.elapsed_s}s` : '';
      const hint = m.state === 'failed' ? `${C.red}${m.error || 'failed'}${C.reset}`
        : m.state === 'running' ? modelProgress(m).join(' · ')
        : (m.unmatched_refs || m.invalid_stances)
          ? `${C.yellow}⚠ ${m.unmatched_refs || 0} unmatched ref(s) · ${m.invalid_stances || 0} invalid stance(s)${C.reset}` : '';
      console.log(`    ${glyph} ${provColor(m.vendor)}${m.vendor.padEnd(8)}${C.reset} ${el.padEnd(5)} ${hint}`);
      // Content lines (opt-in via --lines N / panel.watch_lines): what this agent's output
      // MEANS — findings/verdicts summarized, prompt echo dropped — not a raw JSON dump.
      // Only the gutter bar is dim; the content itself stays full-contrast.
      for (const line of renderTailSummary(m._rec || m, linesN)) {
        console.log(`        ${C.dim}│${C.reset} ${truncateVisible(line, width)}`);
      }
    }
  }
  const stalled = snap.stalled ? `${C.reset}${C.yellow}${snap.stalled} stalled${C.reset}${C.dim}` : `${snap.stalled} stalled`;
  console.log(`\n${C.dim}idle · ${snap.done} done · ${stalled} · ${snap.projects} project${snap.projects === 1 ? '' : 's'}${flags.all ? '' : ' (--all for every project)'}${C.reset}`);
}

// `xm panel status <run> --logs [--watch]` — stream the run's RAW event log (events.jsonl:
// spawn/stdout/stderr/exit/json_parsed/…) instead of the interpreted status board. One-shot
// dumps the last N (default 200, or --lines N); --watch follows it tail -f style. This is the
// "what is each model actually printing right now" view the status board deliberately does not
// show (the board interprets tails into findings). Works across all three namespaces —
// review, x-review, AND cross (legacy cross runs predate the log → explicit note).
function cmdLogs(pos, flags) {
  const runArg = pos[0];
  if (!runArg) {
    console.error(`${C.red}✗ --logs needs a run id: xm panel status <run> --logs${C.reset}`);
    process.exitCode = 1;
    return;
  }
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
  const width = Math.max(24, (process.stdout.columns || 100) - 2);
  const backlog = flags.lines != null ? flags.lines : 200;
  const dump = (recs) => { for (const r of recs) console.log(formatEventLine(r, { color, width })); };
  // Cross runs write events.jsonl too now — logs work uniformly across all three
  // namespaces. A missing file means either a LEGACY cross run (recorded before the
  // event log existed) or a run that hasn't produced events yet — name the right one
  // instead of blaming every miss on legacy cross runs.
  const legacyNote = (r) => {
    const why = r && r.kind === 'cross'
      ? 'recorded before cross runs kept events.jsonl, or not started yet'
      : 'the run has not written any events yet';
    console.error(`${C.yellow}⚠ ${runArg} has no event log (${why}). Try: xm panel status ${runArg}${C.reset}`);
  };

  if (!flags.watch) {
    const r = resolveRunDir(runArg);
    if (!r) { console.error(`${C.red}✗ run not found: ${runArg}${C.reset}`); process.exitCode = 1; return; }
    if (!existsSync(join(r.dir, 'events.jsonl'))) { legacyNote(r); process.exitCode = 1; return; }
    dump(readEventsLog(r.dir, { limit: backlog }));
    return;
  }

  // --watch: prime with the backlog, then append only records newer than lastSeq each tick
  // (readEventsLog with sinceSeq is uncapped, so a >backlog burst is never dropped). No screen
  // clear — the log scrolls like tail -f. The poll loop is authoritative; the run's own
  // status.json (via watchRunSnapshot) supplies the end condition.
  const everyMs = Math.max(300, (flags.interval || 1) * 1000);
  let lastSeq = 0, primed = false, iv = null;
  const finish = (code) => { if (iv) clearInterval(iv); process.exit(code); };
  const tick = () => {
    const r = resolveRunDir(runArg);
    if (!r) { return; } // not created yet — keep waiting quietly (a watched run may not exist yet)
    // Mirror the one-shot missing-log check: a FINISHED run with no events.jsonl must fail
    // loudly (legacy cross run), not print "log ended" with exit 0. A run that simply
    // hasn't written events yet keeps being polled.
    if (!existsSync(join(r.dir, 'events.jsonl'))) {
      const snap = watchRunSnapshot(runArg);
      if (snap.done || snap.stale) { legacyNote(r); finish(1); }
      return;
    }
    if (!primed) {
      const recs = readEventsLog(r.dir, { limit: backlog });
      dump(recs);
      lastSeq = maxSeq(recs, 0);
      primed = true;
    } else {
      const fresh = readEventsLog(r.dir, { sinceSeq: lastSeq });
      if (fresh.length) { dump(fresh); lastSeq = maxSeq(fresh, lastSeq); }
    }
    const snap = watchRunSnapshot(runArg);
    if (snap.done || snap.stale) {
      const tail = readEventsLog(r.dir, { sinceSeq: lastSeq }); // final drain before we stop
      dump(tail);
      console.log(`${C.dim}— run ${snap.done ? 'done' : 'stalled'} · log ended${C.reset}`);
      finish(snap.done ? 0 : 1);
    }
  };
  tick();
  iv = setInterval(tick, everyMs);
  if (iv.unref) iv.unref();
  process.on('SIGINT', () => finish(0));
}

// `xm panel status [run] [--json] [--watch]` — read run state straight from disk so an IN-PROGRESS
// panel is visible from the CLI (not only the dashboard). No run id → list recent review + cross
// runs with their phase and per-model state. A run id → that run's per-model live state plus each
// model's latest stdout tail (what it is producing right now). Read-only; --watch polls live.
// --logs → cmdLogs (raw event stream instead of the interpreted board).

// ── flicker-free live repaint ────────────────────────────────────────
// Capture everything a render callback prints (console.log + direct writes) into one
// string, so the --watch loop can repaint the whole frame in place instead of clearing
// the screen first. A full-screen clear (2J) every tick blanks the terminal for an
// instant before the redraw — that visible gap is the flicker.
function captureFrame(fn) {
  const chunks = [];
  const origLog = console.log;
  const origWrite = process.stdout.write;
  console.log = (...args) => { chunks.push(args.map(String).join(' ') + '\n'); return undefined; };
  process.stdout.write = (s) => { chunks.push(typeof s === 'string' ? s : String(s)); return true; };
  try { fn(); } finally { console.log = origLog; process.stdout.write = origWrite; }
  return chunks.join('');
}

// Repaint `frame` without a blank gap: home the cursor, overwrite each line clearing its
// tail (\x1b[K, so a now-shorter line leaves no leftover chars), then erase any rows below
// (\x1b[J, for when the frame got shorter). The FIRST frame does one full clear (+scrollback
// wipe) to start on a clean canvas; every frame after only homes — never clears — so there
// is no flicker. Non-TTY (piped) output just streams the frame verbatim.
function paintFrame(frame, first) {
  if (!process.stdout.isTTY) { process.stdout.write(frame); return; }
  const ESC = String.fromCharCode(27);
  const body = frame.replace(/\n$/, '').split('\n').map((l) => l + ESC + '[K').join('\n');
  process.stdout.write((first ? `${ESC}[2J${ESC}[3J${ESC}[H` : `${ESC}[H`) + body + `${ESC}[J`);
}

// `xm panel gate <run> [--policy '<json>'] [--json]` — turn a finished run's
// verdict.json into a merge-gate exit code (0 pass / 1 policy block / 2 error) for
// CI and non-worktree users. Persists gate-result.json next to the run so the
// decision is auditable (L6). Policy defaults come from gate.mjs; --policy overrides
// per bucket (e.g. '{"block_confirmed":["critical","high"]}').
function cmdGate(pos, flags) {
  const runArg = pos[0];
  if (!runArg) {
    console.error(`${C.red}✗ usage: xm panel gate <run-id> [--policy '<json>'] [--json]${C.reset}`);
    console.error(`  Run a panel first (xm panel review <target>), then gate its verdict by run id.`);
    process.exitCode = 2;
    return;
  }
  const r = resolveRunDir(runArg);
  if (!r) { console.error(`${C.red}✗ run not found: ${runArg}${C.reset}`); process.exitCode = 2; return; }
  const verdictPath = join(r.dir, 'verdict.json');
  if (!existsSync(verdictPath)) {
    console.error(`${C.red}✗ ${runArg} has no verdict.json — the run is unfinished or failed. Check: xm panel status ${runArg}${C.reset}`);
    process.exitCode = 2;
    return;
  }
  const verdict = readJSONSafe(verdictPath);
  if (!verdict) { console.error(`${C.red}✗ ${runArg} verdict.json is unreadable/corrupt${C.reset}`); process.exitCode = 2; return; }

  let override = {};
  if (flags.policy != null) {
    try {
      override = JSON.parse(flags.policy);
      if (typeof override !== 'object' || Array.isArray(override)) throw new Error('policy must be a JSON object');
    } catch (e) {
      console.error(`${C.red}✗ --policy must be a JSON object: ${e.message}${C.reset}`);
      process.exitCode = 2;
      return;
    }
  }
  const policy = mergePolicy(override);
  const { decision, blocking } = evaluateVerdict(verdict, policy);
  const exitCode = decision === 'fail' ? 1 : 0;
  const result = {
    run: runArg, kind: r.kind, decision, exit_code: exitCode,
    policy, blocking_findings: blocking, counts: verdict.counts || null,
    evaluated_at: new Date().toISOString(),
  };
  try { writeJSON(join(r.dir, 'gate-result.json'), result); }
  catch (e) { process.stderr.write(`${C.yellow}⚠ failed to save gate-result.json: ${e.message}${C.reset}\n`); }

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const head = decision === 'pass' ? `${C.green}✓ gate pass${C.reset}` : `${C.red}✗ gate fail${C.reset}`;
    console.log(`${head} ${C.dim}(${runArg})${C.reset} — ${blocking.length} blocking finding(s)`);
    for (const b of blocking) console.log(`  ${C.red}✗${C.reset} [${b.kind}/${b.severity}] ${b.file || '?'}:${b.line ?? '?'} ${C.dim}${b.claim || ''}${C.reset}`);
    console.log(`${C.dim}  policy: confirmed=[${policy.block_confirmed.join(',')}] unreviewed=[${policy.block_unreviewed.join(',')}] contested=[${policy.block_contested.join(',')}] allow_low=${policy.allow_low}${C.reset}`);
  }
  process.exitCode = exitCode;
}

function cmdStatus(pos, flags) {
  if (flags.logs) { cmdLogs(pos, flags); return; }
  if (flags.watch) {
    const everyMs = Math.max(1, flags.interval || 2) * 1000;
    let iv = null;
    let firstFrame = true;
    // `let` — wrapped below so the t4 event subscription is torn down on finish.
    let finish = (code) => { if (iv) clearInterval(iv); process.exit(code); };
    const tick = () => {
      // --watch --json: machine-readable watch — one COMPACT JSON snapshot per tick (JSONL),
      // no ANSI, no screen clears, so an agent/pipe consumer reads progress line by line.
      if (flags.json) {
        if (pos[0]) {
          const snap = watchRunSnapshot(pos[0], watchLinesN(flags));
          console.log(JSON.stringify(snap));
          // A consumer loop needs the stream to END: exit 0 when the run completes, 1 when it
          // stalled (dead process — no more progress will ever arrive).
          if (snap.done || snap.stale) finish(snap.done ? 0 : 1);
        } else {
          console.log(JSON.stringify(watchBoardSnapshot(flags)));
        }
        return;
      }
      // Render the whole frame off-screen, then repaint it in place (paintFrame) — no
      // per-tick full-screen clear, so the board updates without the flicker a
      // clear-then-redraw produces. The run's end condition is captured and applied
      // AFTER the final frame is painted so its terminal state stays on screen.
      let endCode = null;
      const frame = captureFrame(() => {
        // A run id → live-tail that run's detail; no run id → the cross-run activity board.
        if (pos[0]) {
          // Don't loop the red "run not found" error — a watched run may simply not exist
          // yet; show a clean waiting line until it appears.
          const snap = watchRunSnapshot(pos[0]);
          if (snap.found) {
            renderStatusOnce(pos, flags);
            // A finished/stalled run stops the loop with its final frame on screen instead
            // of re-rendering a terminal state forever.
            if (snap.done || snap.stale) {
              console.log(`${C.dim}run ${snap.done ? 'done' : 'stalled'} — watch ended${C.reset}`);
              endCode = snap.done ? 0 : 1;
            }
          } else console.log(`${C.dim}waiting for ${pos[0]} …${C.reset}`);
        } else renderStatusWatch(flags);
        console.log(`${C.dim}every ${everyMs / 1000}s · Ctrl-C to exit${C.reset}`);
      });
      paintFrame(frame, firstFrame);
      firstFrame = false;
      if (endCode != null) finish(endCode);
    };
    // t4: push accelerator — with a term-mesh daemon present, xk_run events
    // trigger an immediate re-render between polls (<1s latency instead of the
    // interval). The poll loop stays authoritative (files are the source of
    // truth); losing the daemon mid-watch falls back to plain polling LOUDLY.
    let eventTimer = null;
    const sub = (flags.tmEvents === false) ? { active: false, close() {} } : subscribeXkRun({
      onEvent: (ev) => {
        if (pos[0] && ev.run !== pos[0]) return; // watching one run — ignore others
        if (eventTimer) return; // coalesce event bursts into one render per 150ms
        eventTimer = setTimeout(() => { eventTimer = null; tick(); }, 150);
      },
      onDrop: (reason) => {
        console.error(`${C.yellow}⚠ live events lost (${reason}) — continuing with ${everyMs / 1000}s polling${C.reset}`);
      },
    });
    const cleanup = () => { if (eventTimer) clearTimeout(eventTimer); sub.close(); };
    const _finish = finish;
    finish = (code) => { cleanup(); _finish(code); };
    tick();
    iv = setInterval(tick, everyMs); // NOT unref'd — the interval is what keeps the CLI alive
    process.on('SIGINT', () => { cleanup(); clearInterval(iv); process.stdout.write('\n'); process.exit(0); });
    return;
  }
  renderStatusOnce(pos, flags);
}

function renderStatusOnce(pos, flags) {
  const runArg = pos[0];

  // --all: every registered project's runs, grouped — the CLI equivalent of the dashboard Activity
  // view. Projects with no panel activity are skipped; projects with a live run float by the badge.
  if (flags.all && !runArg) {
    const projects = statusProjects();
    if (flags.json) {
      console.log(JSON.stringify(projects.map((p) => ({ project: p.name, xmRoot: p.xmRoot, runs: collectStatusRuns(p.xmRoot, 10) })), null, 2));
      return;
    }
    let any = false;
    for (const p of projects) {
      const runs = collectStatusRuns(p.xmRoot, 10);
      if (!runs.length) continue;
      if (!any) console.log(statusLegend());
      any = true;
      const live = runs.filter((r) => r.live && r.phase !== 'done').length;
      console.log(`\n${C.bold}▸ ${p.name}${C.reset}  ${C.dim}${p.xmRoot}${C.reset}${live ? `  ${C.yellow}● ${live} live${C.reset}` : ''}`);
      for (const r of runs) printStatusRow(r);
    }
    if (!any) console.log('(no panel runs in any registered project)');
    return;
  }

  // No run id → this project's runs (cwd-scoped). Header names the project so it's never ambiguous
  // whether the list is local or global (it is always local — use --all to span every project).
  if (!runArg) {
    const runs = collectStatusRuns(XM_ROOT, 20);
    if (flags.json) { console.log(JSON.stringify(runs, null, 2)); return; }
    console.log(`${C.dim}project${C.reset} ${C.bold}${basename(dirname(XM_ROOT)) || 'project'}${C.reset}  ${C.dim}${join(XM_ROOT, 'panel')}  (--all for every project)${C.reset}`);
    if (!runs.length) { console.log('(no panel runs)'); return; }
    console.log(statusLegend());
    for (const r of runs) printStatusRow(r);
    return;
  }

  // A run id → detail. Same three namespaces as collectStatusRuns (panel / review / cross).
  const panelDir = PANEL_DIR;
  const crossDir = join(PANEL_DIR, '..', 'cross');
  let dir = join(panelDir, runArg), kind = 'review';
  if (!existsSync(dir)) dir = join(PANEL_DIR, '..', 'review', runArg);
  if (!existsSync(dir)) { dir = join(crossDir, runArg); kind = 'cross'; }
  if (!existsSync(dir)) { console.error(`${C.red}run not found: ${runArg}${C.reset}`); process.exitCode = 1; return; }

  if (kind === 'cross') {
    const res = readJSONSafe(join(dir, 'result.json'));
    const stc = readJSONSafe(join(dir, 'status.json'));
    if (flags.json) {
      if (res) { console.log(JSON.stringify(res, null, 2)); return; }
      const results = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'result.json' && f !== 'status.json').map((f) => readJSONSafe(join(dir, f))).filter(Boolean);
      console.log(JSON.stringify({ run: runArg, phase: stc ? stc.phase : 'running', status: stc, results }, null, 2));
      return;
    }
    console.log(`${C.bold}${runArg}${C.reset}  ${C.cyan}cross/${(res && res.source) || (stc && stc.source) || 'cross'}${C.reset}  ${C.dim}[${res ? 'done' : 'running'}]${C.reset}  ${(res && res.title) || (stc && stc.title) || ''}`);
    if (res) {
      for (const v of (res.results || [])) {
        console.log(`\n${C.bold}## ${v.model}${C.reset}${v.ok === false ? ` ${C.red}(${v.error})${C.reset}` : ''}`);
        console.log((v.output || '').slice(-1200).trim() || `${C.dim}(no output)${C.reset}`);
      }
      return;
    }
    // In progress with a heartbeat → the same review-style per-model live view (state,
    // elapsed, last event, live stdout tail) instead of "(no output yet)" placeholders.
    for (const m of ((stc && stc.models) || [])) {
      const tail = stripAnsiCli(m.stdout_tail || m.stderr_tail || '').replace(/\s+/g, ' ').trim().slice(-200);
      const err = m.error ? ` ${C.red}${m.error}${C.reset}` : '';
      console.log(`\n${C.bold}${m.label}${C.reset} ${m.state}${m.elapsed_s != null ? ` (${m.elapsed_s}s)` : ''}${err}`);
      console.log(`  ${C.dim}${m.last_event || ''}${C.reset} ${tail}`);
    }
    if (!stc) console.log(`${C.dim}(legacy run — no live status; results appear per vendor as they finish)${C.reset}`);
    return;
  }

  const st = readJSONSafe(join(dir, 'status.json'));
  if (flags.json) { console.log(JSON.stringify({ status: st, done: existsSync(join(dir, 'verdict.json')) }, null, 2)); return; }
  if (!st) { console.log(`${runArg}: no status.json`); return; }
  // Same staleness rule as the list: a non-done run not touched within the window is a dead process,
  // so the per-model "running" states below are frozen-at-death, not live.
  const detailDone = st.phase === 'done' || existsSync(join(dir, 'verdict.json'));
  const t = Date.parse(st.updated_at || '');
  const stale = !detailDone && !(Number.isFinite(t) && (Date.now() - t) < STATUS_STALE_MS);
  // Round progress (n/N done) so a live detail header answers "how far along" at a glance.
  const mTotal = (st.models || []).length;
  const mDone = (st.models || []).filter((m) => m.state === 'done' || m.state === 'failed').length;
  const phaseTxt = detailDone ? 'done' : stale ? `stalled · ${statusAge(st.updated_at)} ago (process gone — states below are frozen)` : `${st.phase} · ${mDone}/${mTotal} done`;
  const phaseColor = detailDone ? C.green : stale ? C.dim : C.yellow;
  console.log(`${C.bold}${runArg}${C.reset}  ${phaseColor}[${phaseTxt}]${C.reset}  ${st.target_title || ''}`);
  const detailWidth = Math.max(24, (process.stdout.columns || 100) - 6);
  for (const m of (st.models || [])) {
    const err = m.error ? ` ${C.red}${m.error}${C.reset}` : '';
    console.log(`\n${C.bold}${m.label}${C.reset} ${m.state}${m.elapsed_s != null ? ` (${m.elapsed_s}s)` : ''}${err}`);
    if (m.last_event) console.log(`  ${C.dim}${m.last_event}${C.reset}`);
    // Round-2 fidelity (post-synthesis): a refuter with mangled refs/stances must be visible here.
    if (m.unmatched_refs || m.invalid_stances) {
      console.log(`  ${C.yellow}⚠ round-2 fidelity: ${m.unmatched_refs || 0} unmatched ref(s), ${m.invalid_stances || 0} invalid stance(s)${C.reset}`);
    }
    // Same interpreted view as the --watch board: findings/verdicts summarized, echo dropped.
    for (const line of renderTailSummary(m, 4)) console.log(`  ${C.dim}│${C.reset} ${truncateVisible(line, detailWidth)}`);
  }
}

// ── entry ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const SUB = new Set(['review', 'cross', 'gate', 'status', 'setup', 'types', 'models', 'detect', 'doctor', 'preflight', 'help', '--help', '-h']);
let cmd = argv[0];
let rest;
if (!cmd) { cmd = 'review'; rest = []; }            // `x-panel` → review git diff
else if (SUB.has(cmd)) { rest = argv.slice(1); }
else { cmd = 'review'; rest = argv; }                // `x-panel ./file` / `x-panel --full` → review
const { flags, pos, unknown } = parseFlags(rest);

// Reject typo'd flags before any model is spawned (a literal target never starts
// with `-`). Without this, `x-panel --heolp` reviews the string "--heolp" across
// every vendor, burning credits on a typo.
if (unknown.length && !['help', '--help', '-h'].includes(cmd)) {
  console.error(`x-panel: unknown flag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
  console.error(`A review target is a file path or text; flags start with --. Run 'x-panel --help' for usage.`);
  process.exit(1);
}

switch (cmd) {
  case 'review': await cmdReview(pos, flags); break;
  case 'cross': await cmdCross(pos, flags); break;
  case 'gate': cmdGate(pos, flags); break;
  case 'status': cmdStatus(pos, flags); break;
  case 'setup': cmdSetup(pos, flags); break;
  case 'types': cmdTypes(); break;
  case 'models': cmdModels(pos, flags); break;
  case 'doctor': await cmdDoctor(flags); break;
  case 'preflight': await cmdPreflight(pos, flags); break;
  case 'detect': {
    const known = knownProviders();
    const available = flags.auth
      ? known.filter((n) => providerReady(checkAuth(n))) // verified-authed OR assumed-ready (e.g. agy w/ creds)
      : autodetectModels();
    const info = { available, known };
    if (flags.json) console.log(JSON.stringify(info));
    else console.log(`available: ${info.available.join(', ') || '(none)'}\nknown: ${info.known.join(', ')}`);
    break;
  }
  case 'help': case '--help': case '-h': printHelp(); break;
  default: printHelp();
}
