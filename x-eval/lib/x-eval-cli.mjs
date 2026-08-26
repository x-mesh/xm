#!/usr/bin/env node

/**
 * x-eval-cli.mjs — executable half of x-eval.
 *
 * x-eval's judge panels are LLM prompt-programs (skills/eval/subcommands/*.md);
 * this CLI holds the parts that must be deterministic. It never calls a model
 * and never stores model output — only results, hashes, and counts.
 *
 * Commands:
 *   assert  --cmd 'name=<command>' [--file 'name=exists|absent=<path>']
 *           [--grep 'name=[!]<regex>:<path>'] [--json-eq 'name=<a.b>=<value>:<file>']
 *           [--cwd <dir>] [--timeout-ms N] [--env KEY]... [--json]
 *   case    add --prompt <text> | --prompt-file <f> [--rubric R] [--tag T]... [--risk high]
 *               [--assert-cmd 'name=cmd']... [--assert-file ...] [--assert-grep ...]
 *               [--assert-json ...] [--assert "<judge statement>"]... [--min-overall N]
 *               [--source-ref <ref>] [--json]
 *           list [--tag T] [--json]
 *           show <case-id> [--json]
 *   bench   plan   --set all|<tag>|<id,id> --strategies "a,b" [--no-direct] [--trials N] [--json]
 *           record --run <id> --job <job-id> --score-file <f> [--run-assertions] [--cwd d] [--json]
 *           status --run <id> [--json]
 *           finish --run <id> [--baseline latest|<run-id>|<file>] [--allow-partial]
 *                  [--max-avg-drop 0.5] [--json]
 *   gate    (--run <id> | --current <bench.json>) --baseline latest|<run-id>|<file>
 *           [--max-avg-drop 0.5] [--json]
 *   help
 *
 * Exit codes: 0 ok · 1 assertion HARD_FAIL · 2 usage error · 3 regression gate failed.
 *
 * Zero-dependency: node builtins + sibling modules under ./x-eval/ only (a
 * cross-plugin import breaks in the versioned marketplace-cache layout).
 */

import { existsSync, statSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { projectRoot, evalDir } from './x-eval/root.mjs';
import { runAssertions, parseSpec, DEFAULT_TIMEOUT_MS } from './x-eval/assert.mjs';
import { buildCase, writeCase, readCase, listCases, selectCases } from './x-eval/cases.mjs';
import {
  parseStrategies, buildManifest, writeManifest, readManifest, recordJob, finishRun, runStatus, latestBenchPath, formatBenchReport,
} from './x-eval/bench.mjs';
import { compareBench, readBenchFile, formatGateReport, DEFAULT_MAX_AVG_DROP } from './x-eval/gate.mjs';

const REPEATABLE = new Set(['cmd', 'file', 'grep', 'json-eq', 'env', 'tag', 'assert', 'assert-cmd', 'assert-file', 'assert-grep', 'assert-json']);
const BOOLEAN = new Set(['json', 'help', 'no-direct', 'run-assertions', 'allow-partial']);

class UsageError extends Error {}
class GateFailed extends Error {}

/** { opts, pos }. Repeatable flags collect into arrays; boolean flags never consume a value. */
function parseArgs(args) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (BOOLEAN.has(key)) { opts[key] = true; continue; }
    const value = args[i + 1];
    if (value === undefined || (value.startsWith('--') && value.length > 2)) throw new UsageError(`--${key} requires a value`);
    i += 1;
    if (REPEATABLE.has(key)) (opts[key] ||= []).push(value);
    else opts[key] = value;
  }
  return { opts, pos };
}

function usage() {
  return [
    'Usage: xm eval <command> [options]',
    '',
    'Commands:',
    "  assert   Run deterministic assertions (exit 0 = all PASS, 1 = HARD_FAIL, 2 = usage)",
    "           --cmd 'name=<command>'         command exits 0 → PASS (no shell: quote args, no | ; & $ > <)",
    "           --file 'name=exists=<path>'    or absent=<path>",
    "           --grep 'name=[!]<regex>:<path>' ! = must NOT match",
    "           --json-eq 'name=<a.b>=<value>:<file.json>'",
    '           --cwd <dir>  --timeout-ms <N>  --env KEY (pass an extra env var through)  --json',
    '  case     add --prompt <text> | --prompt-file <f> [--rubric R] [--tag T]... [--risk high]',
    "               [--assert-cmd 'name=cmd']... [--assert-file/--assert-grep/--assert-json ...]",
    '               [--assert "<judge statement>"]... [--min-overall N] [--source-ref R] [--json]',
    '           list [--tag T] [--json] · show <case-id> [--json]',
    '  bench    plan --set all|<tag>|<id,id> --strategies "refine,debate" [--no-direct] [--trials N] [--json]',
    '           record --run <id> --job <job-id> --score-file <f> [--run-assertions] [--cwd d] [--json]',
    '           status --run <id> [--json]',
    '           finish --run <id> [--baseline latest|<run-id>|<file>] [--allow-partial] [--max-avg-drop 0.5] [--json]',
    '  gate     (--run <id> | --current <bench.json>) --baseline latest|<run-id>|<file> [--max-avg-drop 0.5] [--json]',
    '  help     Show this help',
    '',
    'Exit codes: 0 ok · 1 assertion HARD_FAIL · 2 usage error · 3 regression gate failed.',
    'Records and results carry metrics, ids and hashes — never model or command output.',
  ].join('\n');
}

function isUsageError(error) {
  return error instanceof UsageError || /must look like|must match|has an empty spec|must be|needs at least|is required|unknown case id|no runnable|invalid case id|invalid run id|unknown job|unknown bench run|must not contain|already exists|strategy "/.test(error?.message || '');
}

// ── assert ───────────────────────────────────────────────────────────

function formatAssertTable(report) {
  const lines = [`📋 Assertions (${report.results.length} checked, executable)`, ''];
  const width = Math.max(4, ...report.results.map(r => r.name.length));
  lines.push(`| ${'name'.padEnd(width)} | kind | result    | detail`);
  for (const r of report.results) {
    const detail = r.result === 'PASS'
      ? (r.kind === 'cmd' ? `exit 0 · ${r.duration_ms}ms` : '')
      : (r.error || (r.kind === 'cmd' ? `exit ${r.exit_code ?? r.signal}` : r.kind === 'grep' ? `matched=${r.matched}` : r.kind === 'json' ? `actual=${r.actual}` : `exists=${r.exists}`));
    lines.push(`| ${r.name.padEnd(width)} | ${r.kind.padEnd(4)} | ${(r.result === 'PASS' ? '✓ PASS' : '⛔ HARD_FAIL').padEnd(9)} | ${detail}`);
  }
  lines.push('');
  lines.push(report.passed ? '✓ all assertions passed' : `⛔ ${report.hard_fail} assertion(s) hard-failed — passed = false`);
  return lines.join('\n');
}

function resolveCwd(opts) {
  const root = projectRoot();
  const cwd = resolve(root, opts.cwd || '.');
  if (cwd !== root && !cwd.startsWith(root + sep)) throw new UsageError(`--cwd must stay inside the project root (${root})`);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new UsageError(`--cwd is not a directory: ${cwd}`);
  return cwd;
}

function collectAssertionItems(opts, { cmd = 'cmd', file = 'file', grep = 'grep', json = 'json-eq' } = {}) {
  const items = [];
  for (const raw of opts[cmd] || []) { const { name, spec } = parseSpec(raw, 'cmd'); items.push({ kind: 'cmd', name, spec, command: spec }); }
  for (const raw of opts[file] || []) { const { name, spec } = parseSpec(raw, 'file'); items.push({ kind: 'file', name, spec }); }
  for (const raw of opts[grep] || []) { const { name, spec } = parseSpec(raw, 'grep'); items.push({ kind: 'grep', name, spec }); }
  for (const raw of opts[json] || []) { const { name, spec } = parseSpec(raw, 'json'); items.push({ kind: 'json', name, spec }); }
  return items;
}

function cmdAssert(args) {
  const { opts } = parseArgs(args);
  const items = collectAssertionItems(opts);
  if (!items.length) throw new UsageError('assert needs at least one --cmd / --file / --grep / --json-eq');
  const cwd = resolveCwd(opts);
  const timeoutMs = opts['timeout-ms'] != null ? Number(opts['timeout-ms']) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new UsageError('--timeout-ms must be a positive integer');
  const envKeys = (opts.env || []).filter(key => /^[A-Z_][A-Z0-9_]*$/.test(key));
  const report = { ...runAssertions(items, { cwd, timeoutMs, envKeys }), cwd };
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatAssertTable(report));
  return report.passed ? 0 : 1;
}

// ── case ─────────────────────────────────────────────────────────────

function cmdCase(args) {
  const [verb, ...rest] = args;
  const { opts, pos } = parseArgs(rest);
  switch (verb) {
    case 'add': {
      let prompt = opts.prompt;
      if (opts['prompt-file']) {
        const path = resolve(process.cwd(), opts['prompt-file']);
        if (!existsSync(path)) throw new UsageError(`--prompt-file not found: ${path}`);
        prompt = readFileSync(path, 'utf8');
      }
      if (!prompt) throw new UsageError('case add needs --prompt <text> or --prompt-file <file>');
      const assertions = collectAssertionItems(opts, { cmd: 'assert-cmd', file: 'assert-file', grep: 'assert-grep', json: 'assert-json' })
        .map(item => ({ kind: item.kind, name: item.name, spec: item.spec }));
      for (const text of opts.assert || []) assertions.push({ kind: 'judge', text });
      const payload = buildCase({
        prompt, rubric: opts.rubric || 'general', tags: opts.tag || [], risk: opts.risk || 'normal', assertions,
        minOverall: opts['min-overall'] ?? null, source: { plugin: 'manual', ref: opts['source-ref'] ?? null },
      });
      const written = writeCase(payload);
      if (opts.json) console.log(JSON.stringify({ ...written, rubric: payload.rubric, tags: payload.tags, risk: payload.risk, assertions: payload.assertions.length }, null, 2));
      else console.log(`${written.created ? '✅ case added' : '↩ case already exists'}: ${written.id}\n   ${written.path}\n   rubric=${payload.rubric} risk=${payload.risk} tags=${payload.tags.join(',') || '—'} assertions=${payload.assertions.length}`);
      return 0;
    }
    case 'list': {
      const { cases, invalid } = listCases({ tag: opts.tag || null });
      if (opts.json) { console.log(JSON.stringify({ cases, invalid }, null, 2)); return 0; }
      if (!cases.length) {
        console.log(`No cases under ${evalDir('cases')}${opts.tag ? ` with tag ${opts.tag}` : ''}.`);
        console.log('  Add one: xm eval case add --prompt "<task>" --rubric general --tag <tag>');
      } else {
        console.log(`📚 ${cases.length} case(s) in ${evalDir('cases')}`);
        for (const c of cases) console.log(`  ${c.id}  ${c.type.padEnd(6)} ${c.rubric.padEnd(14)} risk=${c.risk.padEnd(6)} tags=${(c.tags.join(',') || '—').padEnd(16)} ${c.type === 'task' ? c.prompt_preview : `(${c.status})`}`);
      }
      for (const bad of invalid) console.log(`  ⚠ ${bad.file}: ${bad.reason}`);
      return 0;
    }
    case 'show': {
      const id = pos[0];
      if (!id) throw new UsageError('case show needs a case id');
      const payload = readCase(id);
      if (!payload) throw new UsageError(`unknown case id ${id}`);
      console.log(JSON.stringify(payload, null, 2));
      return 0;
    }
    default:
      throw new UsageError(`case: unknown verb "${verb ?? ''}" (add | list | show)`);
  }
}

// ── bench ────────────────────────────────────────────────────────────

function resolveBaseline(value, { excludeRunId = null } = {}) {
  if (!value) return null;
  if (value === 'latest') {
    const path = latestBenchPath({ excludeRunId });
    if (!path) throw new UsageError('no earlier bench result found under .xm/eval/benchmarks/ to use as --baseline latest');
    return path;
  }
  if (/^bench-/.test(value)) {
    const manifest = readManifest(value);
    if (!manifest.result_path) throw new UsageError(`run ${value} has not been finished — no result to compare against`);
    return manifest.result_path;
  }
  const path = resolve(process.cwd(), value);
  if (!existsSync(path)) throw new UsageError(`baseline file not found: ${path}`);
  return path;
}

function runGate({ currentPath, baselinePath, maxAvgDrop, json }) {
  const current = readBenchFile(currentPath);
  const baseline = readBenchFile(baselinePath);
  if (current.bench.type !== 'bench' || baseline.bench.type !== 'bench') throw new UsageError('gate needs two bench result files (type: "bench")');
  const report = compareBench(current.bench, baseline.bench, { maxAvgDrop });
  const now = new Date();
  const payload = {
    type: 'gate', timestamp: now.toISOString(),
    current: { run_id: current.bench.run_id || null, path: currentPath, sha256: current.sha256 },
    baseline: { run_id: baseline.bench.run_id || null, path: baselinePath, sha256: baseline.sha256 },
    ...report,
  };
  const dir = evalDir('gates');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now.toISOString().replace(/[:.]/g, '-')}-gate.json`);
  writeFileSync(path, JSON.stringify({ ...payload, artifact_path: path }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  if (json) console.log(JSON.stringify({ ...payload, artifact_path: path }, null, 2));
  else { console.log(formatGateReport(report, { currentPath, baselinePath })); console.log(`Saved: ${path}`); }
  return report.passed;
}

function parseMaxAvgDrop(opts) {
  if (opts['max-avg-drop'] == null) return DEFAULT_MAX_AVG_DROP;
  const n = Number(opts['max-avg-drop']);
  if (!(n >= 0)) throw new UsageError('--max-avg-drop must be a non-negative number');
  return n;
}

function cmdBench(args) {
  const [verb, ...rest] = args;
  const { opts } = parseArgs(rest);
  switch (verb) {
    case 'plan': {
      const strategies = parseStrategies(opts.strategies);
      const trials = opts.trials != null ? Number(opts.trials) : null;
      const selection = selectCases(opts.set);
      const manifest = buildManifest({ cases: selection.cases, strategies, includeDirect: !opts['no-direct'], trials });
      const path = writeManifest(manifest);
      const summary = { run_id: manifest.run_id, manifest: path, control: manifest.control, arms: manifest.arms, cases: manifest.cases.length, jobs: manifest.jobs.length, skipped: selection.skipped, invalid: selection.invalid };
      if (opts.json) console.log(JSON.stringify({ ...summary, job_ids: manifest.jobs.map(j => j.job_id), case_ids: manifest.cases.map(c => c.id) }, null, 2));
      else {
        console.log(`🧪 bench run ${manifest.run_id}: ${manifest.cases.length} case(s) × ${manifest.arms.length} arm(s) → ${manifest.jobs.length} job(s)`);
        console.log(`   arms: ${manifest.arms.join(', ')}${manifest.control ? ' (direct = single-agent control)' : ' (no control — --no-direct)'}`);
        console.log(`   manifest: ${path}`);
        for (const s of selection.skipped) console.log(`   skipped ${s.id}: ${s.reason}`);
        console.log('   next: score each job, then `xm eval bench record --run <id> --job <job-id> --score-file <metrics.json>`');
      }
      return 0;
    }
    case 'record': {
      if (!opts.run || !opts.job || !opts['score-file']) throw new UsageError('bench record needs --run, --job, and --score-file');
      const path = resolve(process.cwd(), opts['score-file']);
      if (!existsSync(path)) throw new UsageError(`--score-file not found: ${path}`);
      let raw;
      try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new UsageError(`--score-file is not valid JSON: ${error.message}`); }
      const cwd = opts.cwd ? resolveCwd(opts) : projectRoot();
      const { path: out, record } = recordJob({ runId: opts.run, jobId: opts.job, raw, runExecutableAssertions: !!opts['run-assertions'], cwd });
      if (opts.json) console.log(JSON.stringify({ path: out, ...record }, null, 2));
      else console.log(`${record.passed ? '✅' : '⛔'} recorded ${opts.job}: overall ${record.overall} (threshold ${record.pass_threshold})${record.assertion_hard_fail ? ' — executable assertion HARD_FAIL' : ''}\n   ${out}`);
      return 0;
    }
    case 'status': {
      if (!opts.run) throw new UsageError('bench status needs --run');
      const status = runStatus(opts.run);
      if (opts.json) console.log(JSON.stringify(status, null, 2));
      else {
        console.log(`🧪 ${status.run_id}: ${status.recorded}/${status.jobs} job(s) recorded · status ${status.status}${status.result_path ? ` · result ${status.result_path}` : ''}`);
        if (status.pending.length) console.log(`   pending: ${status.pending.slice(0, 12).join(', ')}${status.pending.length > 12 ? ` … +${status.pending.length - 12}` : ''}`);
        for (const bad of status.invalid) console.log(`   ⚠ ${bad.file}: ${bad.reason}`);
      }
      return 0;
    }
    case 'finish': {
      if (!opts.run) throw new UsageError('bench finish needs --run');
      const maxAvgDrop = parseMaxAvgDrop(opts);
      const baselinePath = resolveBaseline(opts.baseline, { excludeRunId: opts.run });
      let finished;
      try { finished = finishRun({ runId: opts.run, allowPartial: !!opts['allow-partial'] }); } catch (error) {
        if (error.result) throw new UsageError(error.message);
        throw error;
      }
      if (opts.json) console.log(JSON.stringify({ path: finished.path, ...finished.result }, null, 2));
      else { console.log(formatBenchReport(finished.result)); console.log(`Saved: ${finished.path}`); }
      if (baselinePath) {
        const passed = runGate({ currentPath: finished.path, baselinePath, maxAvgDrop, json: !!opts.json });
        if (!passed) throw new GateFailed('regression gate failed');
      }
      return 0;
    }
    default:
      throw new UsageError(`bench: unknown verb "${verb ?? ''}" (plan | record | status | finish)`);
  }
}

function cmdGate(args) {
  const { opts } = parseArgs(args);
  let currentPath;
  if (opts.current) {
    currentPath = resolve(process.cwd(), opts.current);
    if (!existsSync(currentPath)) throw new UsageError(`--current not found: ${currentPath}`);
  } else if (opts.run) {
    const manifest = readManifest(opts.run);
    if (!manifest.result_path) throw new UsageError(`run ${opts.run} has not been finished — run bench finish first`);
    currentPath = manifest.result_path;
  } else throw new UsageError('gate needs --run <id> or --current <bench.json>');
  if (!opts.baseline) throw new UsageError('gate needs --baseline latest|<run-id>|<file>');
  const baselinePath = resolveBaseline(opts.baseline, { excludeRunId: opts.run || null });
  const passed = runGate({ currentPath, baselinePath, maxAvgDrop: parseMaxAvgDrop(opts), json: !!opts.json });
  if (!passed) throw new GateFailed('regression gate failed');
  return 0;
}

async function main(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'assert': return cmdAssert(rest);
      case 'case': return cmdCase(rest);
      case 'bench': return cmdBench(rest);
      case 'gate': return cmdGate(rest);
      case 'help': case '--help': case '-h': case undefined:
        console.log(usage());
        return command === undefined ? 2 : 0;
      default:
        console.error(`xm eval: unknown command "${command}"\n`);
        console.error(usage());
        return 2;
    }
  } catch (error) {
    if (error instanceof GateFailed) return 3;
    if (isUsageError(error)) {
      console.error(`xm eval: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
