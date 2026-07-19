#!/usr/bin/env node
/**
 * x-inbox-cli.mjs — CLI surface for cross-project-handoff toss/inbox
 * (cross-project-handoff R1-R11, t9/t11). Wires the `xm/lib/x-inbox/*.mjs`
 * modules (ledger, redact, target, toss, inbox, retention — see their
 * headers for the design rationale) into two dispatcher entry points:
 * `xm toss <project> "<title>" ...` and `xm inbox {list,take,drop,record}`.
 *
 * Subcommands (this file, invoked as `node x-inbox-cli.mjs <sub> ...`):
 *   toss <project> "<title>" --command <cmd> --output <text> --fix <text>
 *        [--why <text>] [--output-file <path>] [--to-files a,b,c]
 *        [--from-commit <hash>] [--json]
 *   list [--json]
 *   take <id>
 *   drop <id>
 *   record <id> [--pin-id <id>] [--memory-id <id>] [--scope outbox|inbox] [--json]
 *
 * NO NETWORK CALLS ANYWHERE IN THIS FILE (t11 invariant). This process is a
 * plain `node` subprocess — it shares neither Claude Code's MCP session nor
 * its auth, so it cannot call `pin_add`/`pin_get`/`add` itself. Those calls
 * belong to the SKILL that drives `/xm:toss` / `/xm:inbox` (it runs inside
 * Claude Code and already has a live, authenticated MCP session):
 *   - `toss --json` captures + writes the outbox item, then prints the exact
 *     MCP arguments (`toss.mjs`'s `buildMemMeshPayload()`) for the skill to
 *     pass to `mcp__mem-mesh__pin_add` / `mcp__mem-mesh__add` itself.
 *   - `record` is the write-back half: once the skill's MCP calls resolve,
 *     it hands the returned `pin_id`/`memory_id` back here to persist into
 *     the same ledger item (`ledger.mjs`'s `recordMemMesh()`).
 * See `xm/lib/x-inbox/toss.mjs`'s header for the full rationale (an earlier
 * version of this file called the global fetch API against mem-mesh directly
 * over HTTP; that premise was live-tested and found false — no local
 * listener, remote Bearer auth).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { toss, describeCapture } from './x-inbox/toss.mjs';
import {
  list as listLedger, take, drop, InboxItemNotFoundError,
} from './x-inbox/inbox.mjs';
import { recordMemMesh, LedgerItemNotFoundError } from './x-inbox/ledger.mjs';
import { archiveExpired } from './x-inbox/retention.mjs';

/** Every flag this CLI defines. Used to tell "flag with no value" apart from
 *  "flag whose value merely looks like a flag" — see getFlag(). */
const KNOWN_FLAGS = new Set([
  '--command', '--output', '--output-file', '--fix', '--why', '--to-files',
  '--from-commit', '--pin-id', '--memory-id', '--scope', '--json', '--help',
]);

/**
 * Read `--name value`, also accepting `--name=value`.
 *
 * The next token counts as "no value" only when it is a KNOWN flag. Rejecting
 * anything merely starting with `--` was wrong for this CLI specifically: the
 * values it carries are captured command output and shell commands, which
 * legitimately begin with `--` or `---` (`--fix "--legacy-peer-deps"`, a diff
 * hunk, a `---BEGIN` line). Those were reported as "required flag missing".
 * `--name=value` is the unambiguous escape when a value collides with a real
 * flag name.
 */
function getFlag(args, name) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq !== undefined) return eq.slice(name.length + 1);

  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || KNOWN_FLAGS.has(v)) return true;
  return v;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function nonEmptyStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function inboxDirFor(cwd) {
  return join(cwd, '.xm', 'inbox');
}

function outboxDirFor(cwd) {
  return join(cwd, '.xm', 'outbox');
}

function tossUsage() {
  return 'Usage: xm toss <project> "<title>" --command <cmd> --output <text> --fix <text> '
    + '[--why <text>] [--output-file <path>] [--to-files a,b,c] [--from-commit <hash>] [--json]\n';
}

async function tossCmd(args) {
  const toProject = args[0];
  const title = args[1];
  if (!nonEmptyStr(toProject) || !nonEmptyStr(title)) {
    process.stderr.write(tossUsage());
    return 2;
  }

  const command = getFlag(args, '--command');
  const outputFlag = getFlag(args, '--output');
  const outputFile = getFlag(args, '--output-file');
  const fixDirection = getFlag(args, '--fix');
  const why = getFlag(args, '--why');
  const toFilesRaw = getFlag(args, '--to-files');
  const fromCommitFlag = getFlag(args, '--from-commit');
  const json = hasFlag(args, '--json');

  if (!nonEmptyStr(command)) {
    process.stderr.write('xm toss: --command is required (the reproducible command that shows the problem)\n');
    process.stderr.write(tossUsage());
    return 2;
  }

  let output = typeof outputFlag === 'string' ? outputFlag : null;
  if (output === null && typeof outputFile === 'string') {
    try {
      output = readFileSync(outputFile, 'utf8');
    } catch (err) {
      process.stderr.write(`xm toss: failed to read --output-file ${outputFile}: ${err.message}\n`);
      return 1;
    }
  }
  if (!nonEmptyStr(output)) {
    process.stderr.write('xm toss: --output (or --output-file) is required — capture the actual command output, not a description of it\n');
    process.stderr.write(tossUsage());
    return 2;
  }
  if (!nonEmptyStr(fixDirection)) {
    process.stderr.write('xm toss: --fix is required — a "be careful"-level report is refused, not captured\n');
    process.stderr.write(tossUsage());
    return 2;
  }

  const toFiles = typeof toFilesRaw === 'string'
    ? toFilesRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const result = await toss({
    toProject,
    title,
    why: typeof why === 'string' ? why : undefined,
    repro: { command, output },
    anchors: {
      to_files: toFiles,
      ...(typeof fromCommitFlag === 'string' ? { from_commit: fromCommitFlag } : {}),
    },
    fixDirection,
  });

  if (!result.ok) {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: result.reason, message: result.message, candidates: result.candidates ?? [] }, null, 2)}\n`);
      return 1;
    }
    process.stderr.write(`✋ ${result.message}\n`);
    if (Array.isArray(result.candidates) && result.candidates.length > 0) {
      process.stderr.write(`   candidates: ${result.candidates.join(', ')}\n`);
    }
    return 1;
  }

  if (json) {
    // This IS the transport hand-off: the skill reads `mcp_calls` and passes
    // `mcp_calls.pin_add` / `mcp_calls.add` verbatim as arguments to
    // `mcp__mem-mesh__pin_add` / `mcp__mem-mesh__add`, then reports the
    // returned ids back via `xm inbox record`.
    process.stdout.write(`${JSON.stringify({
      ok: true,
      outbox_path: result.outboxPath,
      item_id: result.item.id,
      mem_mesh_project_id: result.memMeshProjectId,
      mcp_calls: result.payload,
    }, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(`${describeCapture(result)}\n`);
  process.stdout.write(`item id: ${result.item.id}\n`);
  process.stdout.write('Re-run with --json to get the MCP call payload for pin_add/add.\n');
  return 0;
}

async function listCmd(args) {
  const json = hasFlag(args, '--json');
  const cwd = process.cwd();
  const dir = inboxDirFor(cwd);

  // Opportunistic sweep before every read (retention.mjs header: cannot live
  // inside readLedger() itself, so every call site does it explicitly). This
  // is disk-only — no network, unlike the pin re-notification that used to
  // run here (t9). Renotification is now the SKILL's job: it inspects each
  // item's `mem_mesh.pin_id`, calls `mcp__mem-mesh__pin_get` itself, and
  // (when the pin is gone or completed) `mcp__mem-mesh__pin_add` +
  // `xm inbox record <id> --pin-id <new-id> --scope inbox` — see SKILL.md.
  archiveExpired(dir, { cwd });

  const items = listLedger(dir);

  if (json) {
    process.stdout.write(`${JSON.stringify({ items }, null, 2)}\n`);
    return 0;
  }

  if (items.length === 0) {
    process.stdout.write('Inbox is empty.\n');
    return 0;
  }

  const STATUS_ICON = { delivered: '📬', actioned: '🔧', dismissed: '🗑' };
  process.stdout.write(`📥 Inbox (${items.length})\n\n`);
  for (const item of items) {
    const icon = STATUS_ICON[item.status] || '  ';
    process.stdout.write(`  ${icon} ${item.id}  [${item.status}]  ${item.title}  (from ${item.from_project})\n`);
  }
  return 0;
}

async function takeCmd(args) {
  const id = args[0];
  if (!nonEmptyStr(id)) {
    process.stderr.write('Usage: xm inbox take <id>\n');
    return 2;
  }
  const cwd = process.cwd();
  const dir = inboxDirFor(cwd);
  archiveExpired(dir, { cwd });

  try {
    const item = take(dir, id, { cwd });
    process.stdout.write(`🔧 taken: ${item.id}  ${item.title}\n\n`);
    process.stdout.write(`from: ${item.from_project}\n`);
    if (item.why) process.stdout.write(`why: ${item.why}\n`);
    process.stdout.write(`\nrepro: ${item.repro.command}\n`);
    process.stdout.write(`${item.repro.output}${item.repro.truncated ? '\n...[truncated]' : ''}\n`);
    process.stdout.write(`\nfix direction: ${item.fix_direction}\n`);
    return 0;
  } catch (err) {
    if (err instanceof InboxItemNotFoundError) {
      process.stderr.write(`xm inbox take: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function dropCmd(args) {
  const id = args[0];
  if (!nonEmptyStr(id)) {
    process.stderr.write('Usage: xm inbox drop <id>\n');
    return 2;
  }
  const cwd = process.cwd();
  const dir = inboxDirFor(cwd);
  archiveExpired(dir, { cwd });

  try {
    const item = drop(dir, id, { cwd });
    process.stdout.write(`🗑 dropped: ${item.id}  ${item.title}\n`);
    return 0;
  } catch (err) {
    if (err instanceof InboxItemNotFoundError) {
      process.stderr.write(`xm inbox drop: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function recordUsage() {
  return 'Usage: xm inbox record <id> --pin-id <id> [--memory-id <id>] [--scope outbox|inbox] [--json]\n';
}

/**
 * Write-back subcommand (t11): persists a `pin_id`/`memory_id` the SKILL
 * obtained from its own `mcp__mem-mesh__pin_add`/`add` (or `pin_add`
 * re-notify) calls into the matching ledger item. This is the ONLY way
 * mem_mesh ids ever land in a ledger file post-capture — this process never
 * calls MCP itself to obtain them.
 *
 * `--scope` picks which ledger dir to write into:
 *   - `outbox` (default) — the sender-side record from `xm toss`.
 *   - `inbox` — a receiving-side re-notification record (new pin after the
 *     original one expired).
 */
async function recordCmd(args) {
  const id = args[0];
  if (!nonEmptyStr(id)) {
    process.stderr.write(recordUsage());
    return 2;
  }

  const pinId = getFlag(args, '--pin-id');
  const memoryId = getFlag(args, '--memory-id');
  const scopeFlag = getFlag(args, '--scope');
  const json = hasFlag(args, '--json');
  const scope = typeof scopeFlag === 'string' ? scopeFlag : 'outbox';

  if (scope !== 'outbox' && scope !== 'inbox') {
    process.stderr.write(`xm inbox record: --scope must be "outbox" or "inbox" (got ${JSON.stringify(scopeFlag)})\n`);
    return 2;
  }
  if (!nonEmptyStr(pinId) && !nonEmptyStr(memoryId)) {
    process.stderr.write('xm inbox record: at least one of --pin-id / --memory-id is required\n');
    process.stderr.write(recordUsage());
    return 2;
  }

  const patch = {};
  if (nonEmptyStr(pinId)) patch.pin_id = pinId;
  if (nonEmptyStr(memoryId)) patch.memory_id = memoryId;

  const cwd = process.cwd();
  const dir = scope === 'inbox' ? inboxDirFor(cwd) : outboxDirFor(cwd);

  try {
    const item = recordMemMesh(dir, id, patch, { cwd });
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, item }, null, 2)}\n`);
    } else {
      process.stdout.write(`recorded: ${item.id}  mem_mesh=${JSON.stringify(item.mem_mesh)}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof LedgerItemNotFoundError) {
      process.stderr.write(`xm inbox record: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function helpCmd() {
  process.stdout.write(`xm toss / xm inbox — cross-project handoff (PRD cross-project-handoff)

Usage:
  xm toss <project> "<title>" --command <cmd> --output <text> --fix <text>
          [--why <text>] [--output-file <path>] [--to-files a,b,c] [--from-commit <hash>] [--json]
  xm inbox list [--json]
  xm inbox take <id>
  xm inbox drop <id>
  xm inbox record <id> --pin-id <id> [--memory-id <id>] [--scope outbox|inbox] [--json]

This CLI never calls mem-mesh itself — \`toss --json\` prints the MCP call
arguments for the skill to use, and \`record\` writes the resulting ids back.
`);
  return 0;
}

const sub = process.argv[2] || 'help';
const rest = process.argv.slice(3);

let code = 0;
switch (sub) {
  case 'toss': code = await tossCmd(rest); break;
  case 'list': case 'ls': code = await listCmd(rest); break;
  case 'take': code = await takeCmd(rest); break;
  case 'drop': code = await dropCmd(rest); break;
  case 'record': code = await recordCmd(rest); break;
  case 'help': case '--help': case '-h': code = helpCmd(); break;
  default:
    process.stderr.write(`Unknown subcommand: ${sub}\nRun: xm inbox help\n`);
    code = 2;
}

process.exit(code);
