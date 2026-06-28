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
import { appendFileSync, readFileSync } from 'node:fs';
import {
  PANEL_DIR, C, join, existsSync, ensureDir, writeJSON, readText, runId,
  loadPanelConfig, savePanelConfig,
} from './x-panel/core.mjs';
import { invokeProviderAsync, invokeProviderText, isAvailable, knownProviders, autodetectModels } from './x-panel/adapters.mjs';
import { normalizeFindings, normalizeVerdicts, synthesize } from './x-panel/synth.mjs';

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

function parseFlags(raw) {
  const flags = {};
  const pos = [];
  // --key=value long-option form: unlike the space-separated form below, the value may legitimately
  // start with '--' (e.g. --prompt='-- note: ...'). Maps each value-flag to its stored key.
  const valueFlags = {
    '--models': 'models', '-m': 'models', '--judge': 'judge', '--preset': 'preset',
    '--review-prompt-file': 'reviewPromptFile', '--review-prompt': 'reviewPrompt',
    '--lens-tag': 'lensTag', '--prompt-file': 'promptFile', '--prompt': 'prompt',
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
    else if (a === '--fast') flags.preset = 'fast';
    else if (a === '--full') flags.preset = 'full';
    else if (a === '--global') flags.global = true;
    else if (a === '--stream') flags.stream = true;
    else if (a === '--no-stream') flags.stream = false;
    else if (a === '--partial') flags.partial = true;
    else if (a === '--no-partial') flags.partial = false;
    // Take the next token as a value ONLY if it isn't another --flag (so a missing value
    // doesn't silently swallow the following option as the prompt body). '-' (stdin) is kept.
    else if (a === '--review-prompt-file') flags.reviewPromptFile = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    else if (a === '--review-prompt') flags.reviewPrompt = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined; // '-' = stdin
    else if (a === '--lens-tag') flags.lensTag = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    else if (a === '--prompt-file') flags.promptFile = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    else if (a === '--prompt') flags.prompt = (raw[i + 1] !== undefined && !raw[i + 1].startsWith('--')) ? raw[++i] : undefined;
    else pos.push(a);
  }
  return { flags, pos };
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

function refutePrompt(target, otherLabel, otherFindings) {
  const list = otherFindings.map(f => `[${f.gref}] (${f.severity}) ${f.file ?? ''}:${f.line ?? ''} ${f.claim}`).join('\n') || '(none)';
  return `You are a skeptical second reviewer of a code change. Other reviewers (${otherLabel}) reported the findings below. For EACH finding decide whether it is a real, actionable issue.

TARGET:
${target}

FINDINGS (each tagged with a [id]):
${list}

Return ONLY a JSON object, no prose. Use the exact bracketed [id] string as "ref":
{"verdicts":[{"ref":"<id, e.g. codex#0>","stance":"refute|concede","reason":"one line"}]}
- refute = wrong, not real, or not actionable.
- concede = a real issue worth fixing.`;
}

// ── render ───────────────────────────────────────────────────────────

function sev(s) {
  const color = s === 'critical' || s === 'high' ? C.red : s === 'medium' ? C.yellow : C.dim;
  return `${color}[${s}]${C.reset}`;
}

// Run one round across all models in parallel, reporting start/heartbeat/elapsed
// on stderr so a long round (large diff) isn't a silent black box.
async function runRound(roundLabel, usable, makePrompt, timeoutMs, onUpdate, onResult, onProviderEvent, stream = false, partial = true) {
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
    const results = await Promise.all(usable.map(async (e) => {
      const s = Date.now();
      const res = await invokeProviderAsync(e.name, makePrompt(e), {
        timeout: timeoutMs,
        model: e.model,
        stream,
        partial,
        onEvent: (ev) => onProviderEvent && onProviderEvent(e, ev),
      });
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
    lines.push(`${C.bold}UNREVIEWED${C.reset} ${C.dim}(round 2 failed for all opponents — not vouched)${C.reset}`);
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
  const baseTimeoutS = flags.timeout || cfg.timeout_s || 240;
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

  const usable = [];
  for (const e of entries) {
    if (!knownProviders().includes(e.name) && !process.env[`X_PANEL_CMD_${e.name.toUpperCase()}`]) {
      console.error(`${C.yellow}⚠ unknown provider "${e.name}" — skipping${C.reset}`);
      continue;
    }
    if (!isAvailable(e.name)) {
      console.error(`${C.yellow}⚠ ${e.name} CLI not found on PATH — skipping (install it or set X_PANEL_CMD_${e.name.toUpperCase()})${C.reset}`);
      continue;
    }
    usable.push(e);
  }
  if (usable.length < 2) {
    console.error(`${C.red}panel needs ≥2 available models, found ${usable.length}${C.reset}`);
    process.exitCode = 1;
    return;
  }
  const labels = usable.map((e) => e.label);

  const target = resolveTarget(pos[0]);
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
  let timeoutS = baseTimeoutS;
  if (flags.timeout == null) {
    const SOFT = cfg.timeout_soft_chars || 20000;       // grow only beyond this size
    const RATE = cfg.timeout_chars_per_s || 300;        // +1s per RATE chars over SOFT
    const MAX = cfg.timeout_max_s || 900;               // hard cap
    const tlen = (target.text || '').length;
    if (tlen > SOFT) {
      const scaled = Math.min(MAX, baseTimeoutS + Math.ceil((tlen - SOFT) / RATE));
      if (scaled > timeoutS) {
        console.error(`${C.yellow}⚠ large target (${tlen} chars) — timeout auto-raised ${baseTimeoutS}s → ${scaled}s (cap ${MAX}s; --timeout to override)${C.reset}`);
        timeoutS = scaled;
      }
    }
  }
  const timeoutMs = timeoutS * 1000;
  const run = runId(stamp());
  // Cross-vendor REVIEW runs go to a separate .xm/review/ namespace so they never
  // collide with native panel history under .xm/panel/.
  const baseDir = reviewMode ? join(PANEL_DIR, '..', 'review') : PANEL_DIR;
  const dir = join(baseDir, run);
  ensureDir(dir);
  const eventPath = join(dir, 'events.jsonl');
  let eventSeq = 0;
  const writeEvent = (event) => {
    const record = { seq: ++eventSeq, at: new Date().toISOString(), ...event };
    if (record.text != null) {
      const redacted = redactPanelText(record.text);
      record.text = tailText(redacted, 2000);
      record.truncated = redacted.length > record.text.length;
    }
    try { appendFileSync(eventPath, JSON.stringify(record) + '\n', 'utf8'); } catch { /* best-effort */ }
  };

  // Live status for polling (dashboard / xm recall / cat .xm/panel/<run>/status.json)
  const zeroTokens = () => ({ input: 0, output: 0, cached: 0, reasoning: 0 });
  const status = {
    run, started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    phase: 'starting', target_kind: target.kind, target_title: targetTitle(target), stream, partial: stream ? partial : false, timeout_s: timeoutS,
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
  let lastStatusFlushMs = 0;
  const flushStatus = ({ force = false } = {}) => {
    const now = Date.now();
    if (!force && now - lastStatusFlushMs < 500) return;
    lastStatusFlushMs = now;
    status.updated_at = new Date().toISOString();
    try { writeJSON(join(dir, 'status.json'), status); } catch { /* best-effort */ }
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
  // events.jsonl is the durable, pollable log — keep it MILESTONE-only so its size
  // (and every dashboard poll that reads it) stays bounded. High-frequency deltas
  // (text/thinking/stdout/stderr chunks) update the small, overwritten status.json
  // instead of appending a line each time.
  // stdout/stderr are kept (raw mode is coarse: 1–2 chunks, not the bloat source).
  // The high-frequency stream-mode deltas (text/thinking) are deliberately absent.
  const MILESTONE = new Set(['spawn', 'exit', 'timeout', 'error', 'json_parsed', 'json_missing', 'usage_final', 'lifecycle', 'stdout', 'stderr']);
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

  // Round 1 — independent review (all models in parallel)
  startPhase('round1 (review)');
  const round1 = {};
  await runRound('round 1 (review)', usable, () => reviewPrompt(target.text, reviewOverride), timeoutMs, onModelDone, (e, res) => {
    const findings = res.ok ? normalizeFindings(res.json, lensTag) : [];
    round1[e.label] = findings;
    writeJSON(join(dir, `${safeLabel(e.label)}.r1.json`), { model: e.label, ok: res.ok, error: res.error, findings, usage: res.usage || null, raw: res.raw });
    writeEvent({ type: 'round_file_written', phase: status.phase, model: e.label, round: 1, ok: res.ok, count: findings.length, error: res.error || null });
  }, onProviderEvent, stream, partial);

  // Round 2 — adversarial: each model refutes the others' findings (in parallel)
  startPhase('round2 (refute)');
  const round2 = {};
  const abstained = new Set();
  await runRound('round 2 (refute)', usable, (e) => {
    const others = usable.filter(x => x.label !== e.label);
    // Tag each opponent finding with a global ref `owner#idx` so 3+ models don't collide.
    const otherFindings = others.flatMap(o => (round1[o.label] || []).map(f => ({ ...f, gref: `${o.label}#${f.idx}` })));
    return refutePrompt(target.text, others.map(o => o.label).join('+'), otherFindings);
  }, timeoutMs, onModelDone, (e, res) => {
    if (!res.ok) abstained.add(e.label); // round2 failure ≠ silent concede
    const verdicts = res.ok ? normalizeVerdicts(res.json) : [];
    round2[e.label] = verdicts;
    writeJSON(join(dir, `${safeLabel(e.label)}.r2.json`), { model: e.label, ok: res.ok, error: res.error, verdicts, usage: res.usage || null, raw: res.raw });
    writeEvent({ type: 'round_file_written', phase: status.phase, model: e.label, round: 2, ok: res.ok, count: verdicts.length, error: res.error || null });
  }, onProviderEvent, stream, partial);

  const verdict = synthesize(labels, round1, round2, abstained);
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
    usage: {
      totals: status.totals,
      by_model: Object.fromEntries(status.models.map((m) => [m.label, { tokens: m.cum_tokens, cost_usd: m.cum_cost_usd, credits: m.cum_credits }])),
    },
    ...verdict,
  };
  writeJSON(join(dir, 'verdict.json'), record);
  status.phase = 'done';
  writeEvent({ type: 'run_done', phase: status.phase, counts: verdict.counts });
  flushStatus({ force: true });

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
  const usable = [];
  for (const e of resolveEntries(flags, cfg)) {
    if (!knownProviders().includes(e.name) && !process.env[`X_PANEL_CMD_${e.name.toUpperCase()}`]) {
      console.error(`${C.yellow}⚠ unknown provider "${e.name}" — skipping${C.reset}`); continue;
    }
    if (!isAvailable(e.name)) {
      console.error(`${C.yellow}⚠ ${e.name} CLI not installed — skipping${C.reset}`); continue;
    }
    usable.push(e);
  }
  if (!usable.length) {
    console.error(`${C.red}cross needs ≥1 available model${C.reset} — none found. Install a model CLI or pass --models.`);
    process.exitCode = 1;
    return;
  }
  const prompt = loadPromptArg(flags, 'promptFile', 'prompt', '--prompt');
  if (prompt === undefined) return; // value error already logged
  if (prompt == null) { console.error(`${C.red}cross needs a prompt${C.reset} — pass --prompt "<text>", --prompt-file <path>, or --prompt -`); process.exitCode = 1; return; }
  const timeoutMs = (flags.timeout || cfg.timeout_s || 240) * 1000;
  const run = runId(stamp());
  const dir = join(PANEL_DIR, '..', 'cross', run);
  ensureDir(dir);
  const results = await Promise.all(usable.map(async (e) => {
    const res = await invokeProviderText(e.name, prompt, { timeout: timeoutMs, model: e.model });
    const rec = { model: e.label, provider: e.name, ok: res.ok, output: res.output || '', error: res.error || null };
    writeJSON(join(dir, `${safeLabel(e.label)}.json`), rec);
    return rec;
  }));
  const record = { run, created_at: new Date().toISOString(), models: usable.map((e) => e.label), prompt_chars: prompt.length, results };
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
    console.log(`\nSet defaults:\n  x-panel setup --models claude,codex,agy,kiro --judge rule [--global]`);
    return;
  }
  const path = savePanelConfig(patch, { global: flags.global });
  console.log(`${C.green}✓${C.reset} saved panel defaults → ${path}`);
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
    --models a,b,c              Override models — name or name:model (e.g. codex:gpt-5,cursor:sonnet-4-thinking,kiro:claude-sonnet-4.6)
    --fast | --full | --preset NAME   fast=claude,codex · full=all installed · or a named preset
    --judge rule                Synthesis (PoC: rule only)
    --timeout SECONDS           Per-model timeout (default 240; config: panel.timeout_s).
                                Auto-raised for large targets (cap panel.timeout_max_s=900); --timeout pins it.
    --stream | --no-stream      Structured streaming: live token/cost per model (claude/cursor/codex).
                                Opt-in (default off; config: panel.stream). kiro/agy stay raw.
    --partial | --no-partial    Token-level live text for claude/cursor (default on within --stream;
                                config: panel.stream_partial). Auto-off when target > panel.partial_max_chars
                                (default 50000) unless --partial forces it. codex/agy/kiro unaffected.
    --json

  setup [--models a,b] [--judge rule] [--global]
                                Save default models/judge to config
                                (project .xm/config.json, or ~/.xm with --global).
                                No args → show detected + current config.

  detect [--json]               Print available (installed) + known providers — lets a
                                caller decide single-vendor fallback BEFORE spending tokens
  cross --models a,b,c (--prompt "..." | --prompt-file <p> | --prompt -) [--json]
                                Generic cross-vendor invocation: run ONE prompt across N vendors,
                                return each vendor's RAW text output (no findings/merge). For
                                deliberation (debate/council) — caller does the synthesis.
                                Output under .xm/cross/<run>/.
  types                         List known providers

  Review-prompt injection (programmatic — for cross-vendor review by other plugins):
    --review-prompt-file <path>   Override round-1 reviewer prompt with a custom lens prompt
    --review-prompt -             Read the override from stdin
    --lens-tag <name>             Tag round-1 findings with this lens (flows to verdict)
                                  Injected runs write to .xm/review/<run>/ (not .xm/panel/).
  help

Model resolution: --models > preset > config > autodetect installed CLIs.
Providers: ${knownProviders().join(', ')} (override a command with X_PANEL_CMD_<MODEL>)
Output: .xm/panel/<run>/{<model>.r1.json, <model>.r2.json, verdict.json}
`);
}

// ── entry ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const SUB = new Set(['review', 'cross', 'setup', 'types', 'detect', 'help', '--help', '-h']);
let cmd = argv[0];
let rest;
if (!cmd) { cmd = 'review'; rest = []; }            // `x-panel` → review git diff
else if (SUB.has(cmd)) { rest = argv.slice(1); }
else { cmd = 'review'; rest = argv; }                // `x-panel ./file` / `x-panel --full` → review
const { flags, pos } = parseFlags(rest);

switch (cmd) {
  case 'review': await cmdReview(pos, flags); break;
  case 'cross': await cmdCross(pos, flags); break;
  case 'setup': cmdSetup(pos, flags); break;
  case 'types': console.log(knownProviders().join('\n')); break;
  case 'detect': {
    const info = { available: autodetectModels(), known: knownProviders() };
    if (flags.json) console.log(JSON.stringify(info));
    else console.log(`available: ${info.available.join(', ') || '(none)'}\nknown: ${info.known.join(', ')}`);
    break;
  }
  case 'help': case '--help': case '-h': printHelp(); break;
  default: printHelp();
}
