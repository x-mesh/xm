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
 *   resolve|done <id> --summary <text> --verification <text> [--json]
 *   drop <id> --summary <text> [--json]
 *   record <id> [--pin-id <id>] [--memory-id <id>] [--scope outbox|inbox] [--json]
 *   materialize --content <memory-json> | --content-file <path>
 *               [--memory-id <id>] [--pin-id <id>] [--json]
 *   reconcile --pins <pin_list-json> | --pins-file <path> [--partial] [--json]
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
  list as listLedger, take, InboxItemNotFoundError,
  materializeMemory, InboxMaterializationError,
  pinInventory, INVENTORY_ACTIONS,
} from './x-inbox/inbox.mjs';
import { recordMemMesh, LedgerItemNotFoundError, readLedger } from './x-inbox/ledger.mjs';
import { archiveExpired } from './x-inbox/retention.mjs';
import {
  buildReceiptPayload, materializeReceipt,
  recordReceiptTransport, receiptStatus, transitionWithReceipt, ReceiptError,
} from './x-inbox/receipt.mjs';

/** Every flag this CLI defines. Used to tell "flag with no value" apart from
 *  "flag whose value merely looks like a flag" — see getFlag(). */
const KNOWN_FLAGS = new Set([
  '--command', '--output', '--output-file', '--fix', '--why', '--to-files',
  '--from-commit', '--pin-id', '--memory-id', '--scope', '--json', '--help',
  '--content', '--content-file', '--pins', '--pins-file', '--partial',
  '--summary', '--verification', '--receipt-memory-id',
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

  const STATUS_ICON = {
    delivered: '📬', in_progress: '🔧', actioned: '🔧', resolved: '✅', dismissed: '🗑',
  };
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

async function resolveCmd(args) {
  const id = args[0];
  const json = hasFlag(args, '--json');
  if (!nonEmptyStr(id)) {
    process.stderr.write('Usage: xm inbox resolve <id> --summary <text> --verification <text> [--json]\n');
    return 2;
  }
  const cwd = process.cwd();
  const dir = inboxDirFor(cwd);
  archiveExpired(dir, { cwd });

  try {
    const result = transitionWithReceipt(dir, id, 'resolved', {
      cwd, summary: getFlag(args, '--summary') || '', verification: getFlag(args, '--verification') || '',
    });
    const { item: withReceipt, receipt } = result;
    const payload = buildReceiptPayload(receipt, { pinId: withReceipt.mem_mesh?.pin_id });
    if (json) process.stdout.write(`${JSON.stringify({ ok: true, item: withReceipt, mcp_calls: payload }, null, 2)}\n`);
    else process.stdout.write(`✅ resolved: ${withReceipt.id}  ${withReceipt.title}\n`);
    return 0;
  } catch (err) {
    if (err instanceof InboxItemNotFoundError || err instanceof ReceiptError) {
      process.stderr.write(`xm inbox resolve: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function dropCmd(args) {
  const id = args[0];
  if (!nonEmptyStr(id)) {
    process.stderr.write('Usage: xm inbox drop <id> --summary <text> [--json]\n');
    return 2;
  }
  const cwd = process.cwd();
  const dir = inboxDirFor(cwd);
  archiveExpired(dir, { cwd });

  try {
    const result = transitionWithReceipt(dir, id, 'dismissed', {
      cwd, summary: getFlag(args, '--summary') || '', verification: getFlag(args, '--verification') || '',
    });
    const { item: withReceipt, receipt } = result;
    if (hasFlag(args, '--json')) process.stdout.write(`${JSON.stringify({ ok: true, item: withReceipt, mcp_calls: buildReceiptPayload(receipt, { pinId: withReceipt.mem_mesh?.pin_id }) }, null, 2)}\n`);
    else process.stdout.write(`🗑 dropped: ${withReceipt.id}  ${withReceipt.title}\n`);
    return 0;
  } catch (err) {
    if (err instanceof InboxItemNotFoundError || err instanceof ReceiptError) {
      process.stderr.write(`xm inbox drop: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function receiptCmd(args) {
  const action = args[0];
  const rest = args.slice(1);
  const cwd = process.cwd();
  const id = rest[0];
  const json = hasFlag(rest, '--json');
  if (!nonEmptyStr(id)) { process.stderr.write('Usage: xm inbox receipt <status|retry|record|materialize> <toss-id> [--content JSON] [--memory-id id] [--json]\n'); return 2; }
  try {
    if (action === 'status') {
      const value = receiptStatus(cwd, id);
      process.stdout.write(json ? `${JSON.stringify({ ok: true, ...value }, null, 2)}\n` : `${value.scope}: ${value.status}; receipt=${value.receipt?.transport ?? 'none'}\n`);
      return 0;
    }
    if (action === 'retry') {
      const receipt = readLedger(join(cwd, '.xm', 'receipts')).find((entry) => entry.receipt?.toss_id === id)?.receipt;
      if (!receipt) throw new ReceiptError(`no local receipt for ${id}`);
      // Same two calls the original terminal transition emitted: a retry
      // re-sends the receipt, and the delivery pin is still open if the
      // first attempt died before completing it.
      const pinId = readLedger(inboxDirFor(cwd)).find((entry) => entry.id === id)?.mem_mesh?.pin_id;
      process.stdout.write(`${JSON.stringify({ ok: true, mcp_calls: buildReceiptPayload(receipt, { pinId }) }, null, 2)}\n`);
      return 0;
    }
    if (action === 'record') {
      const memoryId = getFlag(rest, '--memory-id');
      const item = recordReceiptTransport(inboxDirFor(cwd), id, memoryId, { cwd });
      process.stdout.write(json ? `${JSON.stringify({ ok: true, item }, null, 2)}\n` : `receipt delivery recorded: ${id}\n`);
      return 0;
    }
    if (action === 'materialize') {
      const content = getFlag(rest, '--content');
      if (!nonEmptyStr(content)) throw new ReceiptError('--content is required');
      const result = materializeReceipt(outboxDirFor(cwd), content, { cwd });
      process.stdout.write(json ? `${JSON.stringify({ ok: true, ...result }, null, 2)}\n` : `receipt ${result.applied ? 'applied' : 'already applied'}: ${id}\n`);
      return 0;
    }
    throw new ReceiptError('receipt action must be status, retry, record, or materialize');
  } catch (err) {
    if (err instanceof ReceiptError || err instanceof LedgerItemNotFoundError) {
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, reason: 'receipt_rejected', message: err.message }, null, 2)}\n`);
      else process.stderr.write(`xm inbox receipt: ${err.message}\n`);
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

function materializeUsage() {
  return 'Usage: xm inbox materialize --content <memory-json> | --content-file <path> '
    + '[--memory-id <id>] [--pin-id <id>] [--json]\n';
}

/**
 * Persist a memory body the SKILL already fetched through MCP. This remains
 * disk-only: it neither searches mem-mesh nor writes outside this cwd's
 * `.xm/inbox`. Duplicate ids preserve the local item/status unchanged.
 *
 * `--content-file` exists because a memory body is a whole JSON document
 * carrying an embedded repro command and its captured output — passing that
 * as a shell argument means re-quoting nested escapes by hand, and a single
 * slip corrupts the repro silently. Same fallback shape as toss's
 * `--output-file`: the inline flag wins when both are given.
 */
async function materializeCmd(args) {
  const contentFlag = getFlag(args, '--content');
  const contentFile = getFlag(args, '--content-file');
  const memoryId = getFlag(args, '--memory-id');
  const pinId = getFlag(args, '--pin-id');
  const json = hasFlag(args, '--json');

  let content = typeof contentFlag === 'string' ? contentFlag : null;
  if (content === null && typeof contentFile === 'string') {
    try {
      content = readFileSync(contentFile, 'utf8');
    } catch (err) {
      process.stderr.write(`xm inbox materialize: failed to read --content-file ${contentFile}: ${err.message}\n`);
      return 1;
    }
  }
  if (!nonEmptyStr(content)) {
    process.stderr.write(materializeUsage());
    return 2;
  }
  if (memoryId === true || pinId === true) {
    process.stderr.write('xm inbox materialize: --memory-id and --pin-id require values\n');
    return 2;
  }

  try {
    const result = materializeMemory(inboxDirFor(process.cwd()), content, {
      cwd: process.cwd(),
      ...(typeof memoryId === 'string' ? { memoryId } : {}),
      ...(typeof pinId === 'string' ? { pinId } : {}),
    });
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, created: result.created, item: result.item }, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.created ? 'materialized' : 'already materialized'}: ${result.item.id}\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof InboxMaterializationError) {
      if (json) process.stdout.write(`${JSON.stringify({ ok: false, reason: 'rejected', message: err.message }, null, 2)}\n`);
      else process.stderr.write(`xm inbox materialize: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function reconcileUsage() {
  return 'Usage: xm inbox reconcile --pins <pin_list-json> | --pins-file <path> [--partial] [--json]\n';
}

/**
 * Diff a mem-mesh pin listing against this ledger and print what the SKILL
 * must do about each side. Still no network here (t11): the skill holds the
 * MCP session, calls `pin_list` itself, and pipes the result in.
 *
 * Accepts either `pin_list`'s whole envelope (`{pins:[...]}`) or a bare
 * array, because the skill copies whichever is at hand.
 */
async function reconcileCmd(args) {
  const pinsFlag = getFlag(args, '--pins');
  const pinsFile = getFlag(args, '--pins-file');
  const json = hasFlag(args, '--json');
  const complete = !hasFlag(args, '--partial');

  let raw = typeof pinsFlag === 'string' ? pinsFlag : null;
  if (raw === null && typeof pinsFile === 'string') {
    try {
      raw = readFileSync(pinsFile, 'utf8');
    } catch (err) {
      process.stderr.write(`xm inbox reconcile: failed to read --pins-file ${pinsFile}: ${err.message}\n`);
      return 1;
    }
  }
  if (!nonEmptyStr(raw)) {
    process.stderr.write(reconcileUsage());
    return 2;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`xm inbox reconcile: pin listing is not valid JSON: ${err.message}\n`);
    return 1;
  }
  const pins = Array.isArray(parsed) ? parsed : parsed?.pins;
  if (!Array.isArray(pins)) {
    process.stderr.write('xm inbox reconcile: expected pin_list\'s `pins` array (or the whole envelope)\n');
    return 1;
  }

  const report = pinInventory(inboxDirFor(process.cwd()), pins, { complete });
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`);
    return 0;
  }

  const { summary } = report;
  process.stdout.write(
    `pins ${pins.length} · materialize ${summary.materialize} · renotify ${summary.renotify} · unmappable ${summary.unmappable}\n`,
  );
  for (const pin of report.pins) {
    if (pin.action === INVENTORY_ACTIONS.MATERIALIZE) {
      process.stdout.write(`  📥 materialize ${pin.toss_id} (pin ${pin.pin_id})\n`);
    } else if (pin.action === INVENTORY_ACTIONS.RENOTIFY) {
      process.stdout.write(`  🔁 renotify ${pin.toss_id} (pin ${pin.pin_id} — ${pin.reason})\n`);
    } else if (pin.action === INVENTORY_ACTIONS.UNMAPPABLE) {
      process.stdout.write(`  ❓ unmappable pin ${pin.pin_id} — ${pin.content ?? ''}\n`);
    }
  }
  for (const item of report.items) {
    if (item.action === INVENTORY_ACTIONS.RENOTIFY) {
      process.stdout.write(`  🔁 renotify ${item.id} (${item.status} — ${item.reason})\n`);
    }
  }
  if (summary.materialize + summary.renotify + summary.unmappable === 0) {
    process.stdout.write('  ✅ ledger and pins agree — nothing to do\n');
  }
  return 0;
}

function helpCmd() {
  process.stdout.write(`xm toss / xm inbox — cross-project handoff (PRD cross-project-handoff)

Usage:
  xm toss <project> "<title>" --command <cmd> --output <text> --fix <text>
          [--why <text>] [--output-file <path>] [--to-files a,b,c] [--from-commit <hash>] [--json]
  xm inbox list [--json]
  xm inbox take <id>
  xm inbox resolve <id> --summary <text> --verification <text> [--json]   # alias: done
  xm inbox drop <id> --summary <text> [--json]
  xm inbox record <id> --pin-id <id> [--memory-id <id>] [--scope outbox|inbox] [--json]
  xm inbox materialize --content <memory-json> | --content-file <path>
                       [--memory-id <id>] [--pin-id <id>] [--json]
  xm inbox reconcile --pins <pin_list-json> | --pins-file <path> [--partial] [--json]
  xm inbox receipt <status|retry|record|materialize> <toss-id> [...]

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
  case 'resolve': case 'done': code = await resolveCmd(rest); break;
  case 'drop': code = await dropCmd(rest); break;
  case 'record': code = await recordCmd(rest); break;
  case 'materialize': code = await materializeCmd(rest); break;
  case 'reconcile': code = await reconcileCmd(rest); break;
  case 'receipt': code = await receiptCmd(rest); break;
  case 'help': case '--help': case '-h': code = helpCmd(); break;
  default:
    process.stderr.write(`Unknown subcommand: ${sub}\nRun: xm inbox help\n`);
    code = 2;
}

process.exit(code);
