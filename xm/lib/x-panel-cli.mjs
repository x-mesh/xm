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
import {
  PANEL_DIR, C, join, existsSync, ensureDir, writeJSON, readText, runId,
  loadPanelConfig, savePanelConfig,
} from './x-panel/core.mjs';
import { invokeProviderAsync, isAvailable, knownProviders, autodetectModels } from './x-panel/adapters.mjs';
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

function targetTitle(target) {
  if (target.kind === 'literal') return compactTitle(target.text);
  if (target.kind === 'file' && target.ref) return `Review ${target.ref}`;
  return null;
}

function parseFlags(raw) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--json') flags.json = true;
    else if (a === '--models' || a === '-m') flags.models = raw[++i];
    else if (a === '--judge') flags.judge = raw[++i];
    else if (a === '--timeout') flags.timeout = parseInt(raw[++i], 10) || undefined;
    else if (a === '--preset') flags.preset = raw[++i];
    else if (a === '--fast') flags.preset = 'fast';
    else if (a === '--full') flags.preset = 'full';
    else if (a === '--global') flags.global = true;
    else pos.push(a);
  }
  return { flags, pos };
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

function reviewPrompt(target) {
  return `You are a code reviewer. Review the following change and report only real, evidence-backed issues.

TARGET:
${target}

Return ONLY a JSON object, with no prose before or after:
{"findings":[{"severity":"critical|high|medium|low","file":"path or null","line":number_or_null,"claim":"one-line issue","evidence":"why it is real, with a concrete reference"}]}
If there are no real issues, return {"findings":[]}.`;
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
async function runRound(roundLabel, usable, makePrompt, timeoutMs, onUpdate, onResult) {
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
      const res = await invokeProviderAsync(e.name, makePrompt(e), { timeout: timeoutMs, model: e.model });
      pending.delete(e.label);
      const dt = Math.round((Date.now() - s) / 1000);
      process.stderr.write(res.ok
        ? `  ${C.green}✓${C.reset} ${e.label} ${C.dim}(${dt}s)${C.reset}\n`
        : `  ${C.red}✗${C.reset} ${e.label} ${C.dim}(${dt}s)${C.reset}: ${res.error}\n`);
      if (onResult) onResult(e, res);
      if (onUpdate) onUpdate({ event: 'model_done', label: e.label, ok: res.ok, elapsed_s: dt });
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
  // Per-model timeout: large diffs + many parallel models need headroom (dogfooding hit the 180s wall).
  const timeoutMs = (flags.timeout || cfg.timeout_s || 240) * 1000;
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
  const run = runId(stamp());
  const dir = join(PANEL_DIR, run);
  ensureDir(dir);

  // Live status for polling (dashboard / xm recall / cat .xm/panel/<run>/status.json)
  const status = {
    run, started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    phase: 'starting', target_kind: target.kind,
    models: usable.map((e) => ({ label: e.label, state: 'pending', elapsed_s: 0 })),
  };
  const flushStatus = () => {
    status.updated_at = new Date().toISOString();
    try { writeJSON(join(dir, 'status.json'), status); } catch { /* best-effort */ }
  };
  const onModelDone = (ev) => {
    if (ev.event === 'model_done') {
      const m = status.models.find((x) => x.label === ev.label);
      if (m) { m.state = ev.ok ? 'done' : 'failed'; m.elapsed_s = ev.elapsed_s; }
    } else if (ev.event === 'progress') {
      // Tick the elapsed clock of every still-running model so the dashboard
      // shows live progress instead of a frozen "0s" until completion.
      status.models.forEach((m) => { if (m.state === 'running') m.elapsed_s = ev.elapsed_s; });
    }
    flushStatus();
  };
  const startPhase = (phase) => {
    status.phase = phase;
    status.models.forEach((m) => { m.state = 'running'; m.elapsed_s = 0; });
    flushStatus();
  };
  flushStatus();

  // Round 1 — independent review (all models in parallel)
  startPhase('round1 (review)');
  const round1 = {};
  await runRound('round 1 (review)', usable, () => reviewPrompt(target.text), timeoutMs, onModelDone, (e, res) => {
    const findings = res.ok ? normalizeFindings(res.json) : [];
    round1[e.label] = findings;
    writeJSON(join(dir, `${safeLabel(e.label)}.r1.json`), { model: e.label, ok: res.ok, error: res.error, findings, raw: res.raw });
  });

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
    writeJSON(join(dir, `${safeLabel(e.label)}.r2.json`), { model: e.label, ok: res.ok, error: res.error, verdicts, raw: res.raw });
  });

  const verdict = synthesize(labels, round1, round2, abstained);
  const record = {
    run,
    created_at: new Date().toISOString(),
    target_kind: target.kind,
    target_ref: target.ref || null,
    target_title: targetTitle(target),
    judge: 'rule',
    ...verdict,
  };
  writeJSON(join(dir, 'verdict.json'), record);
  status.phase = 'done';
  flushStatus();

  if (flags.json) console.log(JSON.stringify(record, null, 2));
  else console.log(renderVerdict(verdict, dir));
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
    --timeout SECONDS           Per-model timeout (default 240; config: panel.timeout_s)
    --json

  setup [--models a,b] [--judge rule] [--global]
                                Save default models/judge to config
                                (project .xm/config.json, or ~/.xm with --global).
                                No args → show detected + current config.

  types                         List known providers
  help

Model resolution: --models > preset > config > autodetect installed CLIs.
Providers: ${knownProviders().join(', ')} (override a command with X_PANEL_CMD_<MODEL>)
Output: .xm/panel/<run>/{<model>.r1.json, <model>.r2.json, verdict.json}
`);
}

// ── entry ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const SUB = new Set(['review', 'setup', 'types', 'help', '--help', '-h']);
let cmd = argv[0];
let rest;
if (!cmd) { cmd = 'review'; rest = []; }            // `x-panel` → review git diff
else if (SUB.has(cmd)) { rest = argv.slice(1); }
else { cmd = 'review'; rest = argv; }                // `x-panel ./file` / `x-panel --full` → review
const { flags, pos } = parseFlags(rest);

switch (cmd) {
  case 'review': await cmdReview(pos, flags); break;
  case 'setup': cmdSetup(pos, flags); break;
  case 'types': console.log(knownProviders().join('\n')); break;
  case 'help': case '--help': case '-h': printHelp(); break;
  default: printHelp();
}
