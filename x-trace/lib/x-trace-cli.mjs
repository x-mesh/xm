#!/usr/bin/env node

/**
 * x-trace-cli.mjs — CLI for xm's cross-tool activity ledger.
 *
 * Reads/writes the two artifacts produced by t1:
 *   - .xm/last.json   per-tool "last activity" pointer map (last-store.mjs)
 *   - .xm/traces/*.jsonl  session traces with git snapshots (trace-writer.mjs)
 *
 * Commands:
 *   record <tool> [--ref R] [--status S] [--note N] [--artifact A] [--session S]
 *   last   [tool] [--json]
 *   status [--json]
 *   since  <ref>
 *   doctor [--rebuild]
 *
 * Design notes:
 *   - `commitsSince()` runs `git rev-list --count <ref>..HEAD` INLINE (one
 *     spawnSync). It deliberately does NOT import x-build's release.mjs `git()`
 *     helper: that is a cross-plugin relative import, which breaks in the
 *     versioned marketplace-cache layout (bug_xmemory_cache_import_crash 동형).
 *     Same rationale last-store.mjs reimplements its own lock. The only imports
 *     here are the two sibling modules under ./x-trace/ (same plugin dir, safe).
 *   - `record` is best-effort observability (FM3): a last-store lock contention
 *     is caught, warned, and the process still exits 0 — a ledger write must
 *     never fail the caller's real work.
 *   - Unknown tool names are warned once, then recorded anyway (FM4).
 *   - Coverage is best-effort: `.xm/last.json` only knows about activity that was
 *     explicitly recorded, so empty/partial output carries an honesty note (A1).
 *
 * Zero-dependency: node builtins + the two t1 sibling modules only.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitSnapshot, resolveTraceDir } from './x-trace/trace-writer.mjs';
import { lastRead, lastWrite } from './x-trace/last-store.mjs';
import { createReplay, promoteReplayToEval } from './x-trace/replay.mjs';

/** Tools the dispatcher is expected to record. Anything else warns then records (FM4). */
const KNOWN_TOOLS = new Set(['review', 'build', 'panel', 'op', 'eval', 'ship', 'dispatcher']);

/** Honesty note appended wherever ledger coverage is incomplete (A1). */
const COVERAGE_NOTE =
  'Note: activity may exist that was never recorded — coverage is best-effort. (기록되지 않은 활동이 있을 수 있음)';

// ── helpers ──────────────────────────────────────────────────────────

/** Split raw args into { opts, pos }. Boolean flags never consume a following positional argument. */
function parseArgs(args) {
  const opts = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--rebuild') { opts.rebuild = true; continue; }
    if (a === '--promote-to-eval') { opts.promoteToEval = true; continue; }
    if (a.startsWith('--')) { opts[a.slice(2)] = args[++i]; continue; }
    pos.push(a);
  }
  return { opts, pos };
}

/** Shorten a 7–40 hex sha to 7 chars; pass through non-sha refs (e.g. a subject line). */
function shortRef(ref) {
  if (!ref) return '(none)';
  return /^[0-9a-f]{7,40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

/** Coarse relative age of an ISO timestamp: "12s ago" → "3d ago". */
function relativeTime(ts) {
  const then = Date.parse(ts);
  if (Number.isNaN(then)) return 'unknown time';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Count commits on HEAD since `ref` — INLINE `git rev-list --count <ref>..HEAD`.
 * Returns null when there is no git, `ref` is unresolvable, or the output is not
 * a number. See the file header for why this is not imported from release.mjs.
 */
function commitsSince(ref) {
  if (!ref) return null;
  const r = spawnSync('git', ['rev-list', '--count', `${ref}..HEAD`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.status !== 0) return null;
  const n = parseInt((r.stdout || '').trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Committer time (ISO) of `ref`, or NaN when unresolvable — best-effort.
 * Uses %cI so string parse yields a comparable epoch.
 */
function refCommitTime(ref) {
  const r = spawnSync('git', ['show', '-s', '--format=%cI', ref], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.error || r.status !== 0) return NaN;
  return Date.parse((r.stdout || '').trim());
}

/**
 * Epoch of a trace filename's embedded timestamp, or NaN.
 * createSessionId() format: `{skill}-YYYYMMDD-HHMMSS-{hex}` where the timestamp
 * is UTC (toISOString slices). Skill may contain hyphens, so match from the end.
 */
function sessionFileTime(name) {
  const m = name.replace(/\.jsonl$/, '').match(/-(\d{8})-(\d{6})-[0-9a-f]+$/i);
  if (!m) return NaN;
  const [, d, t] = m;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  return Date.parse(iso);
}

/** The commit anchor to count "since" from for a record: recorded HEAD, else ref. */
function statusBase(rec) {
  return rec.head || rec.ref || null;
}

// ── commands ─────────────────────────────────────────────────────────

/**
 * record <tool> — write a last-activity pointer. Missing tool is a usage error
 * (exit 1); everything else is best-effort and exits 0, including a lock throw
 * (FM3) and an unknown tool name (FM4, warned then recorded).
 */
function cmdRecord(pos, opts) {
  const tool = pos[0];
  if (!tool) {
    console.error('Usage: xm trace record <tool> [--ref R] [--status S] [--note N] [--artifact A] [--session S]');
    process.exit(1);
  }
  if (!KNOWN_TOOLS.has(tool)) {
    process.stderr.write(
      `[x-trace] warning: "${tool}" is not a known tool (${[...KNOWN_TOOLS].join(', ')}) — recording anyway.\n`,
    );
  }
  const head = gitSnapshot().head; // HEAD at record time; null outside a git repo
  const ref = opts.ref ?? head;
  if (!ref) {
    process.stderr.write('[x-trace] warning: no --ref given and no git HEAD found — recording with null ref.\n');
  }
  const entry = {
    ref,
    head,
    status: opts.status ?? null,
    note: opts.note ?? null,
    artifact_ref: opts.artifact ?? null,
  };
  if (opts.session) entry.session_id = opts.session;

  try {
    const rec = lastWrite(tool, entry);
    console.log(`recorded ${tool}: ${shortRef(rec.ref)}${rec.status ? ` (${rec.status})` : ''}`);
  } catch (err) {
    // FM3: last-store throws only on lock contention. Never fail the caller's
    // real work over a best-effort ledger write — warn and exit 0.
    process.stderr.write(`[x-trace] record skipped (best-effort): ${err.message}\n`);
  }
}

/** last [tool] — human-readable one-liner per tool, or full/single map with --json. */
function cmdLast(pos, opts) {
  const tools = lastRead().tools || {};
  const onlyTool = pos[0];

  if (opts.json) {
    const out = onlyTool ? { [onlyTool]: tools[onlyTool] ?? null } : tools;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const keys = onlyTool ? (tools[onlyTool] ? [onlyTool] : []) : Object.keys(tools).sort();
  if (keys.length === 0) {
    console.log(onlyTool ? `No recorded activity for "${onlyTool}".` : 'No tool activity recorded yet.');
    console.log(COVERAGE_NOTE);
    return;
  }
  for (const k of keys) {
    const r = tools[k];
    const flag = r.chain_broken ? ' ⚠ chain broken' : '';
    console.log(`${k}: ${shortRef(r.ref)} (${r.status ?? 'no status'}, ${relativeTime(r.ts)})${flag}`);
  }
}

/** status — commits on HEAD since each tool last acted. --json for the structured map. */
function cmdStatus(pos, opts) {
  const tools = lastRead().tools || {};
  const keys = Object.keys(tools).sort();

  if (opts.json) {
    const out = {};
    for (const k of keys) {
      const r = tools[k];
      const base = statusBase(r);
      out[k] = { ref: r.ref ?? null, head: r.head ?? null, commits_since: commitsSince(base), chain_broken: !!r.chain_broken };
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (keys.length === 0) {
    console.log('No tool activity recorded yet.');
    console.log(COVERAGE_NOTE);
    return;
  }
  for (const k of keys) {
    const r = tools[k];
    const base = statusBase(r);
    const n = commitsSince(base);
    const since = n === null ? 'unknown commits since (ref not resolvable)' : `${n} commit${n === 1 ? '' : 's'} since`;
    const flag = r.chain_broken ? ' ⚠ chain broken' : '';
    console.log(`${k}: ${since} ${shortRef(base)}${flag}`);
  }
}

/** since <ref> — tools recorded after ref's commit time + trace files newer than it (best-effort). */
function cmdSince(pos) {
  const ref = pos[0];
  if (!ref) {
    console.error('Usage: xm trace since <ref>');
    process.exit(1);
  }
  const refTime = refCommitTime(ref);
  if (Number.isNaN(refTime)) {
    console.log(`Could not resolve commit time for "${ref}" — is it a valid ref in this repo?`);
    console.log(COVERAGE_NOTE);
    return; // best-effort: not a hard error, exit 0
  }

  const tools = lastRead().tools || {};
  const active = [];
  for (const [k, rec] of Object.entries(tools)) {
    const t = Date.parse(rec.ts);
    if (!Number.isNaN(t) && t >= refTime) active.push({ tool: k, ts: rec.ts, ref: rec.ref });
  }

  const traceDir = resolveTraceDir();
  const sessions = [];
  if (existsSync(traceDir)) {
    for (const f of readdirSync(traceDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const ft = sessionFileTime(f);
      if (!Number.isNaN(ft) && ft >= refTime) sessions.push(f);
    }
  }

  if (active.length === 0 && sessions.length === 0) {
    console.log(`No tool activity or trace sessions recorded since ${shortRef(ref)}.`);
    console.log(COVERAGE_NOTE);
    return;
  }
  if (active.length) {
    console.log(`Tools active since ${shortRef(ref)}:`);
    for (const x of active.sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
      console.log(`  ${x.tool}: ${shortRef(x.ref)} (${relativeTime(x.ts)})`);
    }
  }
  if (sessions.length) {
    console.log(`Trace sessions since ${shortRef(ref)} (best-effort filename match):`);
    for (const s of sessions.sort()) console.log(`  ${s}`);
  }
}

/** doctor [--rebuild] — validate last.json, or reconstruct it from git-bearing traces. */
function cmdDoctor(opts) {
  if (opts.rebuild) { doctorRebuild(); return; }

  const tools = lastRead().tools || {};
  const keys = Object.keys(tools);
  console.log(`last.json: ${keys.length} tool${keys.length === 1 ? '' : 's'} recorded.`);
  let issues = 0;
  for (const k of keys) {
    const r = tools[k];
    const problems = [];
    if (!r || typeof r !== 'object') {
      problems.push('malformed record');
    } else {
      if (!('ref' in r)) problems.push('missing ref');
      if (!('head' in r)) problems.push('missing head');
      if (!r.ts || Number.isNaN(Date.parse(r.ts))) problems.push('invalid ts');
      if (r.chain_broken) problems.push('chain broken (rebase/force-push since last record)');
    }
    if (problems.length) { issues++; console.log(`  ⚠ ${k}: ${problems.join('; ')}`); }
    else console.log(`  ✓ ${k}`);
  }
  if (keys.length && issues === 0) console.log('All records valid.');
  console.log("Run 'xm trace doctor --rebuild' to reconstruct last.json from traces (new traces only).");
}

/** replay <trace-id> --span <span-id> — persist deterministic replay inputs. */
function cmdReplay(pos, opts) {
  const traceId = pos[0];
  const spanId = opts.span;
  if (!traceId || !spanId) {
    console.error('Usage: xm trace replay <trace-id> --span <span-id> [--model M] [--prompt-override FILE] [--result FILE] [--promote-to-eval] [--json]');
    process.exitCode = 1;
    return;
  }
  try {
    const { manifest, manifestPath, repoRoot } = createReplay(traceId, spanId, {
      model: opts.model,
      promptOverride: opts['prompt-override'],
      result: opts.result,
    });
    const evalCase = opts.promoteToEval
      ? promoteReplayToEval({ root: repoRoot, traceId, spanId, seed: manifest.seed, diff: manifest.replay_diff, manifestPath })
      : null;
    const warnings = manifest.warnings || [];
    if (opts.json) {
      console.log(JSON.stringify({
        replay_of: manifest.replay_of,
        seed: manifest.seed,
        manifest: manifestPath,
        snapshot: manifest.snapshot,
        diff: manifest.replay_diff,
        eval_case: evalCase,
        warnings,
      }, null, 2));
      return;
    }
    console.log(`Replay artifact created: ${manifestPath}`);
    console.log(`  replay_of: ${manifest.replay_of}`);
    console.log(`  seed: ${manifest.seed}`);
    console.log(`  snapshot: ${manifest.snapshot.archive} (${manifest.snapshot.archive_bytes} bytes)`);
    const diff = manifest.replay_diff;
    console.log('  diff (original | replay):');
    console.log(`    output: ${diff.output.comparison} (${diff.output.original.sha256 ?? 'unavailable'} | ${diff.output.replay.sha256 ?? 'unavailable'})`);
    console.log(`    tokens: ${diff.tokens.total.original ?? 'unavailable'} | ${diff.tokens.total.replay ?? 'unavailable'}`);
    console.log(`    cost: ${diff.cost.original ?? 'unavailable'} | ${diff.cost.replay ?? 'unavailable'}`);
    console.log(`    quality (${diff.quality.rubric}): ${diff.quality.score.original ?? 'unavailable'} | ${diff.quality.score.replay ?? 'awaiting x-eval'}`);
    if (evalCase) console.log(`  x-eval case: ${evalCase.path} (${evalCase.created ? 'created' : 'already exists'})`);
    for (const warning of warnings) console.warn(`[x-trace] warning: ${warning.code} (${warning.phase}, ${warning.bytes} bytes)`);
  } catch (err) {
    console.error(`[x-trace] replay failed: ${err.message}`);
    process.exitCode = 1;
  }
}

/**
 * Reconstruct last.json by tail-scanning .xm/traces/*.jsonl for the latest
 * session_end carrying a git.head, per skill. Only traces written by t1 (which
 * added the git field) are usable; older traces are counted and honestly
 * reported as non-reconstructable. Writes in ts order so lastWrite() chains base.
 */
function doctorRebuild() {
  const traceDir = resolveTraceDir();
  if (!existsSync(traceDir)) {
    console.log('No traces directory found — nothing to rebuild from.');
    console.log(COVERAGE_NOTE);
    return;
  }

  const bySkill = new Map(); // skill -> { head, ts }
  let scanned = 0, usable = 0, legacy = 0;
  for (const f of readdirSync(traceDir)) {
    if (!f.endsWith('.jsonl')) continue;
    scanned++;
    let lines;
    try { lines = readFileSync(join(traceDir, f), 'utf8').trim().split('\n'); } catch { continue; }

    let skill = null, endGit = null, endTs = null;
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'session_start' && e.skill) skill = e.skill;
      if (e.type === 'session_end') {
        endTs = e.ts || null;
        endGit = e.git && e.git.head ? e.git.head : null;
      }
    }
    if (!skill) {
      const m = f.replace(/\.jsonl$/, '').match(/^(.*)-\d{8}-\d{6}-[0-9a-f]+$/i);
      if (m) skill = m[1];
    }
    if (skill && endGit) {
      usable++;
      const prev = bySkill.get(skill);
      if (!prev || (endTs || '') > (prev.ts || '')) bySkill.set(skill, { head: endGit, ts: endTs });
    } else if (skill && endTs && !endGit) {
      legacy++;
    }
  }

  const ordered = [...bySkill.entries()].sort((a, b) => ((a[1].ts || '') < (b[1].ts || '') ? -1 : 1));
  for (const [skill, info] of ordered) {
    lastWrite(skill, {
      ref: info.head, head: info.head, ts: info.ts,
      status: 'rebuilt', note: 'reconstructed by doctor --rebuild',
    });
  }

  console.log(`Rebuilt last.json: ${ordered.length} tool(s) from ${usable}/${scanned} usable trace file(s).`);
  if (legacy) {
    console.log(`Note: ${legacy} legacy trace(s) had no git field and could not be reconstructed (pre-t1 traces).`);
  }
  console.log(COVERAGE_NOTE);
}

// ── router ───────────────────────────────────────────────────────────

function printHelp() {
  console.log(`x-trace — cross-tool activity ledger (.xm/last.json + traces)

Commands:
  record <tool> [--ref R] [--status S] [--note N] [--artifact A] [--session S]
                                Record a tool's latest activity. Best-effort:
                                omitted --ref defaults to the current git HEAD.
  last [tool] [--json]          Show the last activity per tool (or one tool).
  status [--json]               Commits on HEAD since each tool last acted.
  since <ref>                   Tools + trace sessions recorded since <ref>.
  doctor [--rebuild]            Validate last.json; --rebuild reconstructs it
                                from traces that recorded git state.
  replay <trace-id> --span <id> Freeze a deterministic replay manifest, four-axis
                                diff, and safe filesystem snapshot (max 3 forks/trace).
                                --result FILE accepts output hash/metrics only;
                                --promote-to-eval creates an idempotent eval case.
  help                          Show this help.

Known tools: ${[...KNOWN_TOOLS].join(', ')}`);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { opts, pos } = parseArgs(rest);
  switch (cmd) {
    case 'record': cmdRecord(pos, opts); break;
    case 'last':   cmdLast(pos, opts); break;
    case 'status': cmdStatus(pos, opts); break;
    case 'since':  cmdSince(pos); break;
    case 'doctor': cmdDoctor(opts); break;
    case 'replay': cmdReplay(pos, opts); break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: "${cmd}". Run: xm trace help`);
      process.exit(1);
  }
}

// Run only when invoked directly (node <file> or via the dispatcher symlink) —
// realpathSync resolves symlinks so a dispatcher-symlinked call still matches.
// Guarded so importing this module in tests is side-effect-free.
const isMain = (() => {
  try { return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
})();
if (isMain) main();

export { cmdRecord, cmdLast, cmdStatus, cmdSince, cmdDoctor, cmdReplay, commitsSince, relativeTime, shortRef, sessionFileTime };
