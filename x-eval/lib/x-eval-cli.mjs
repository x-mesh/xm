#!/usr/bin/env node

/**
 * x-eval-cli.mjs — executable half of x-eval.
 *
 * x-eval's judge panels are LLM prompt-programs (skills/eval/subcommands/*.md);
 * this CLI holds the parts that must be deterministic: code-based assertions
 * today, the case set / bench ledger / regression gate next. It never calls a
 * model and never stores model output — only results, hashes, and counts.
 *
 * Commands:
 *   assert  --cmd 'name=<command>' [--file 'name=exists|absent=<path>']
 *           [--grep 'name=[!]<regex>:<path>'] [--json-eq 'name=<a.b>=<value>:<file>']
 *           [--cwd <dir>] [--timeout-ms N] [--env KEY]... [--json]
 *   help
 *
 * Exit codes: 0 all assertions PASS · 1 at least one HARD_FAIL · 2 usage error.
 *
 * Zero-dependency: node builtins + sibling modules under ./x-eval/ only (a
 * cross-plugin import breaks in the versioned marketplace-cache layout).
 */

import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { projectRoot } from './x-eval/root.mjs';
import { runAssertions, parseSpec, DEFAULT_TIMEOUT_MS } from './x-eval/assert.mjs';

const REPEATABLE = new Set(['cmd', 'file', 'grep', 'json-eq', 'env']);
const BOOLEAN = new Set(['json', 'help']);

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
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`--${key} requires a value`);
    }
    i += 1;
    if (REPEATABLE.has(key)) (opts[key] ||= []).push(value);
    else opts[key] = value;
  }
  return { opts, pos };
}

class UsageError extends Error {}

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
    '  help     Show this help',
    '',
    'Results carry name/kind/result/exit_code/duration_ms/command_sha256 — never command output.',
  ].join('\n');
}

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

function cmdAssert(args) {
  const { opts } = parseArgs(args);
  const items = [];
  for (const raw of opts.cmd || []) { const { name, spec } = parseSpec(raw, 'cmd'); items.push({ kind: 'cmd', name, command: spec }); }
  for (const raw of opts.file || []) { const { name, spec } = parseSpec(raw, 'file'); items.push({ kind: 'file', name, spec }); }
  for (const raw of opts.grep || []) { const { name, spec } = parseSpec(raw, 'grep'); items.push({ kind: 'grep', name, spec }); }
  for (const raw of opts['json-eq'] || []) { const { name, spec } = parseSpec(raw, 'json'); items.push({ kind: 'json', name, spec }); }
  if (!items.length) throw new UsageError('assert needs at least one --cmd / --file / --grep / --json-eq');

  const root = projectRoot();
  const cwd = resolve(root, opts.cwd || '.');
  if (cwd !== root && !cwd.startsWith(root + sep)) throw new UsageError(`--cwd must stay inside the project root (${root})`);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new UsageError(`--cwd is not a directory: ${cwd}`);
  const timeoutMs = opts['timeout-ms'] != null ? Number(opts['timeout-ms']) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new UsageError('--timeout-ms must be a positive integer');
  const envKeys = (opts.env || []).filter(key => /^[A-Z_][A-Z0-9_]*$/.test(key));

  const report = { ...runAssertions(items, { cwd, timeoutMs, envKeys }), cwd };
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatAssertTable(report));
  return report.passed ? 0 : 1;
}

async function main(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'assert': return cmdAssert(rest);
      case 'help': case '--help': case '-h': case undefined:
        console.log(usage());
        return command === undefined ? 2 : 0;
      default:
        console.error(`xm eval: unknown command "${command}"\n`);
        console.error(usage());
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError || /must look like|must match|has an empty spec/.test(error?.message || '')) {
      console.error(`xm eval: ${error.message}`);
      return 2;
    }
    throw error;
  }
}

process.exitCode = await main(process.argv.slice(2));
