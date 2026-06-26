#!/usr/bin/env node

/**
 * x-recall — Cross-Session Artifact Index CLI
 *
 * Indexes everything under .xm/ (review, op, plan, eval, probe, humble,
 * solver, research, prd, handoff) into one list/show/search surface so
 * sequential Claude → Codex → Cursor sessions in the same repo can find and
 * read each other's outputs. Read-only except `handoff-md`.
 *
 * Usage: node <plugin-root>/lib/x-recall-cli.mjs <command> [args] [options]
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { XM_ROOT, C } from './x-recall/core.mjs';
import { scanAll, resolveSelector, search, knownTypes } from './x-recall/scan.mjs';
import { renderList, renderShow, renderSearch } from './x-recall/render.mjs';
import { writeHandoffMd } from './x-recall/handoff-md.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Best-effort trace integration. A static top-level import of the x-trace
// module crashes with ERR_MODULE_NOT_FOUND in the versioned plugin-cache
// layout (no xm sibling), so resolve dynamically and fall back to no-ops.
function findTraceWriter() {
  const candidates = [
    join(__dirname, 'x-trace', 'trace-writer.mjs'),
    join(__dirname, '..', '..', 'xm', 'lib', 'x-trace', 'trace-writer.mjs'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

async function loadTrace() {
  const path = findTraceWriter();
  if (!path) {
    const noop = () => {};
    return { createSessionId: () => null, sessionStart: noop, sessionEnd: noop };
  }
  return import(path);
}

// ── Flag parsing ─────────────────────────────────────────────────────

function parseFlags(raw) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--json') flags.json = true;
    else if (a === '--last') flags.last = true;
    else if (a === '--type' || a === '-t') flags.type = raw[++i];
    else if (a === '--project' || a === '-p') flags.project = raw[++i];
    else if (a === '--since') flags.since = raw[++i];
    else if (a === '--limit' || a === '-n') flags.limit = parseInt(raw[++i], 10) || undefined;
    else pos.push(a);
  }
  return { flags, pos };
}

// ── Commands ─────────────────────────────────────────────────────────

function run(cmd, pos, flags) {
  switch (cmd) {
    case 'list': {
      const arts = scanAll(XM_ROOT, { type: flags.type, project: flags.project, since: flags.since });
      console.log(renderList(arts, { json: flags.json, limit: flags.limit }));
      break;
    }
    case 'show': {
      const sel = pos[0] || flags.type;
      if (!sel) {
        console.error('Usage: xm recall show <id|type> [--last] [--json]');
        process.exitCode = 1;
        return;
      }
      const art = resolveSelector(XM_ROOT, sel);
      if (!art) {
        console.error(`Not found: ${sel}\nRun: xm recall list`);
        process.exitCode = 1;
        return;
      }
      console.log(renderShow(art, { json: flags.json }));
      break;
    }
    case 'search': {
      const q = pos.join(' ').trim();
      if (!q) {
        console.error('Usage: xm recall search "<query>" [--type T]');
        process.exitCode = 1;
        return;
      }
      const arts = search(XM_ROOT, q, { type: flags.type, project: flags.project, since: flags.since });
      console.log(renderSearch(arts, q, { json: flags.json }));
      break;
    }
    case 'handoff-md': {
      const res = writeHandoffMd(XM_ROOT);
      if (!res.ok) {
        console.error(`handoff-md: ${res.reason} (${res.path})`);
        process.exitCode = 1;
        return;
      }
      console.log(`${C.green}✓${C.reset} wrote ${res.path}`);
      break;
    }
    case 'types':
      console.log(knownTypes().join('\n'));
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: "${cmd}". Run: xm recall help`);
      process.exitCode = 1;
  }
}

function printHelp() {
  console.log(`x-recall — Cross-Session Artifact Index

Find and read review/op/plan/eval/probe outputs across sessions and tools.
Reads .xm/ directly, so Codex and Cursor can call it via plain bash.

Commands:
  list                          List all artifacts, newest first
    [--type T] [--project P]    Filter by type or build/solver project
    [--since 7d|2026-05-01]     Only artifacts on/after this date
    [--limit N] [--json]

  show <id|type> [--last]       Print one artifact's content
    [--json]                    e.g. show review --last  ·  show op:council-2026-04-06-...

  search "<query>"              Full-text + metadata search across artifacts
    [--type T] [--json]

  handoff-md                    (Re)generate tool-neutral .xm/build/HANDOFF.md
                                from SESSION-STATE.json (readable by any tool)

  types                         List known artifact types
  help                          Show this help

Types: ${knownTypes().join(', ')}

Examples:
  xm recall list --type review --since 7d
  xm recall show review --last
  xm recall search "sql injection" --type review
`);
}

// ── Entry ────────────────────────────────────────────────────────────
// Skip top-level execution when imported by the dashboard server.
if (process.env.XKIT_SERVER !== '1') {
  const raw = process.argv.slice(2);
  const [cmd, ...rest] = raw;
  const { flags, pos } = parseFlags(rest);

  const trace = await loadTrace();
  const sid = trace.createSessionId('x-recall');
  trace.sessionStart(sid, 'x-recall', { command: cmd || 'help' });
  const t0 = Date.now();
  run(cmd, pos, flags);
  trace.sessionEnd(sid, { totalDurationMs: Date.now() - t0, status: process.exitCode ? 'error' : 'success' });
}

// Exports for the dashboard server / tests (no side effects under XKIT_SERVER).
export { scanAll, resolveSelector, search } from './x-recall/scan.mjs';
