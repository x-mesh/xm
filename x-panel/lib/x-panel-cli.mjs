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
} from './x-panel/core.mjs';
import { invokeProvider, isAvailable, knownProviders } from './x-panel/adapters.mjs';
import { normalizeFindings, normalizeVerdicts, synthesize } from './x-panel/synth.mjs';

// ── helpers ──────────────────────────────────────────────────────────

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function gitDiff() {
  const r = spawnSync('git', ['--no-pager', 'diff', 'HEAD'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return (r.stdout || '').trim() || '(no diff against HEAD)';
}

function resolveTarget(arg) {
  if (!arg) return { kind: 'git-diff', text: gitDiff() };
  if (existsSync(arg)) return { kind: 'file', text: readText(arg) || '', ref: arg };
  return { kind: 'literal', text: arg };
}

function parseFlags(raw) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--json') flags.json = true;
    else if (a === '--models' || a === '-m') flags.models = raw[++i];
    else if (a === '--judge') flags.judge = raw[++i];
    else pos.push(a);
  }
  return { flags, pos };
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

function renderVerdict(v, dir) {
  const total = v.models.length;
  const lines = [];
  lines.push(`${C.bold}Panel verdict${C.reset} — ${C.green}${v.counts.unique} issue(s)${C.reset} (from ${v.counts.confirmed} confirmed findings), ${C.yellow}${v.counts.contested} contested${C.reset}  ${C.dim}(models: ${v.models.join(', ')})${C.reset}`);
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
  lines.push('');
  const unanimous = v.consensus.filter(c => c.consensus === total).length;
  const single = v.consensus.filter(c => c.consensus === 1).length;
  const div = v.models.map(m => `${m}:${v.by_model[m].raised}`).join(' · ');
  lines.push(`${C.dim}Raised per model: ${div}  ·  ${unanimous} unanimous, ${single} single-model (diversity)${C.reset}`);
  lines.push(`${C.dim}saved: ${join(dir, 'verdict.json')}${C.reset}`);
  return lines.join('\n');
}

// ── commands ─────────────────────────────────────────────────────────

function cmdReview(pos, flags) {
  const models = (flags.models || 'claude,codex').split(',').map(s => s.trim()).filter(Boolean);
  if (models.length < 2) {
    console.error('panel needs at least 2 models, e.g. --models claude,codex');
    process.exitCode = 1;
    return;
  }
  const judge = flags.judge || 'rule';
  if (judge !== 'rule') {
    console.error(`${C.yellow}⚠ --judge ${judge} not implemented in PoC — using rule-based synthesis${C.reset}`);
  }

  const usable = [];
  for (const m of models) {
    if (!knownProviders().includes(m) && !process.env[`X_PANEL_CMD_${m.toUpperCase()}`]) {
      console.error(`${C.yellow}⚠ unknown provider "${m}" — skipping${C.reset}`);
      continue;
    }
    if (!isAvailable(m)) {
      console.error(`${C.yellow}⚠ ${m} CLI not found on PATH — skipping (install it or set X_PANEL_CMD_${m.toUpperCase()})${C.reset}`);
      continue;
    }
    usable.push(m);
  }
  if (usable.length < 2) {
    console.error(`${C.red}panel needs ≥2 available models, found ${usable.length}${C.reset}`);
    process.exitCode = 1;
    return;
  }

  const target = resolveTarget(pos[0]);
  const run = runId(stamp());
  const dir = join(PANEL_DIR, run);
  ensureDir(dir);

  // Round 1 — independent review
  const round1 = {};
  for (const m of usable) {
    const res = invokeProvider(m, reviewPrompt(target.text));
    if (!res.ok) console.error(`${C.red}⚠ ${m} round1 failed: ${res.error}${C.reset}`);
    const findings = res.ok ? normalizeFindings(res.json) : [];
    round1[m] = findings;
    writeJSON(join(dir, `${m}.r1.json`), { model: m, ok: res.ok, error: res.error, findings, raw: res.raw });
  }

  // Round 2 — adversarial: each model refutes the others' findings
  const round2 = {};
  for (const m of usable) {
    const others = usable.filter(x => x !== m);
    // Tag each opponent finding with a global ref `owner#idx` so 3+ models don't collide.
    const otherFindings = others.flatMap(o => (round1[o] || []).map(f => ({ ...f, gref: `${o}#${f.idx}` })));
    const res = invokeProvider(m, refutePrompt(target.text, others.join('+'), otherFindings));
    if (!res.ok) console.error(`${C.red}⚠ ${m} round2 failed: ${res.error}${C.reset}`);
    const verdicts = res.ok ? normalizeVerdicts(res.json) : [];
    round2[m] = verdicts;
    writeJSON(join(dir, `${m}.r2.json`), { model: m, ok: res.ok, error: res.error, verdicts, raw: res.raw });
  }

  const verdict = synthesize(usable, round1, round2);
  const record = {
    run,
    created_at: new Date().toISOString(),
    target_kind: target.kind,
    target_ref: target.ref || null,
    judge: 'rule',
    ...verdict,
  };
  writeJSON(join(dir, 'verdict.json'), record);

  if (flags.json) console.log(JSON.stringify(record, null, 2));
  else console.log(renderVerdict(verdict, dir));
}

function printHelp() {
  console.log(`x-panel — Cross-Model Adversarial Review Panel (PoC)

Calls multiple LLM CLIs headlessly, has each review the same target, runs one
adversarial round, and synthesizes a verdict. Tool-neutral: run it from any shell.

Commands:
  review [target]               Run the panel
    --models claude,codex       Models to use (default: claude,codex)
    --judge rule                Synthesis (PoC: rule only)
    --json                      Emit the verdict record as JSON
    target: file path | literal string | omitted (uses git diff HEAD)

  help                          Show this help

Providers: ${knownProviders().join(', ')} (override a command with X_PANEL_CMD_<MODEL>)
Output: .xm/panel/<run>/{<model>.r1.json, <model>.r2.json, verdict.json}
`);
}

// ── entry ────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const { flags, pos } = parseFlags(rest);

switch (cmd) {
  case 'review': cmdReview(pos, flags); break;
  case 'help': case '--help': case '-h': case undefined: printHelp(); break;
  default:
    console.error(`Unknown command: "${cmd}". Run: x-panel help`);
    process.exitCode = 1;
}
