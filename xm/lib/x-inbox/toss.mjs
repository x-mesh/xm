/**
 * x-inbox toss — capture + local ledger write for cross-project-handoff
 * (PRD R1, R5).
 *
 * `toss()` is the whole `/xm:toss <project> "<problem>"` flow MINUS the
 * actual mem-mesh delivery: resolve the target (R2, via target.mjs — never
 * guesses), build a fully-redacted, size-bounded ledger item (R1, R4), write
 * it into the SENDER's own `.xm/outbox/<id>.json` (R3 — never touches the
 * target's `.xm/`, per C2), and hand back an MCP tool-call payload for the
 * caller to actually deliver.
 *
 * Why this module does NOT call mem-mesh itself (transport ownership, t11):
 *   - An earlier version of this file called the global fetch API to POST
 *     to a `/mcp/tools/call` endpoint directly. Live testing found that
 *     premise false on every count: no
 *     process listens on port 8000 locally, mem-mesh is reached as a REMOTE
 *     HTTP MCP server with Bearer auth (`~/.claude.json` `mcpServers`), and a
 *     plain Node CLI process shares neither Claude Code's MCP session nor its
 *     auth. Teaching this CLI to read `~/.claude.json` and carry a bearer
 *     token would tie a project-agnostic script to one client's config
 *     format and make it a secret handler.
 *   - The fix: this module (and the CLI built on it) only ever touches the
 *     local outbox file. The SKILL that drives `/xm:toss` runs INSIDE Claude
 *     Code, so it already has a live, authenticated MCP session — it calls
 *     `mcp__mem-mesh__pin_add` / `mcp__mem-mesh__add` directly, using the
 *     `payload` this module builds (`buildMemMeshPayload()`) as the exact
 *     arguments. No URL, no token, ever appears in this file.
 *   - After the skill's MCP calls resolve, it writes the returned
 *     `pin_id`/`memory_id` back into the same outbox item via the CLI's
 *     `record` subcommand (`recordMemMesh()` in ledger.mjs) — the ledger
 *     stays the single source of truth even though delivery now happens in
 *     two separate steps (capture here, transport in the skill).
 *
 * Ledger vs transport split (see ledger.mjs header): the outbox write always
 * happens, unconditionally, the moment capture + target resolution succeed.
 * Whether the skill's subsequent MCP calls succeed, partially succeed, or
 * never happen at all (no MCP tools available — see SKILL.md) never un-writes
 * it — that split IS the fix for "mem-mesh down/unavailable must not lose the
 * report" (PRD Degraded Path, R5 failure mode).
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { writeLedger } from './ledger.mjs';
import { redact } from './redact.mjs';
import { resolveTarget, resolveMemMeshProjectId } from './target.mjs';

/**
 * Tag mem-mesh uses to tell an inbox-toss pin apart from an ordinary
 * work-tracking pin (t5, mem-mesh side, is implementing the reading half of
 * this contract via `tags`). Single source of truth — if t5 lands on a
 * different tag name, change it here only; every payload built by this
 * module reads from this constant.
 */
export const INBOX_PIN_TAG = 'inbox';

/**
 * Stable, searchable notification text for a toss delivery pin. The durable
 * memory contains the whole JSON item, but mem-mesh search cannot currently
 * filter memories by tag. Keeping the item id in the pin gives the receiving
 * skill an exact query key instead of making it search generic words such as
 * "inbox" or a possibly non-unique title.
 */
export function inboxPinContent(item) {
  return `${item.id} — ${item.title}`;
}

/**
 * Default `pin_add` importance for a toss notification when the caller
 * doesn't override it. Mid-scale on x-kit's own 1-5 convention (architecture
 * decisions = 5, feature work = 3-4, minor fixes = 1-2) — a cross-project bug
 * report is more than a minor fix but the receiving project hasn't triaged it
 * yet, so it does not default to 5.
 */
export const DEFAULT_PIN_IMPORTANCE = 3;

/**
 * Tail-truncation bound for captured command output, mirroring the existing
 * `.slice(-2000)` precedent in x-build/lib/x-build/core.mjs:639. Applied
 * BEFORE redact() (see `captureTossItem`) so a multi-MB capture never forces
 * the masking regexes to scan the full original text — only the kept tail,
 * bounding both stored-file size and redact() cost regardless of input size
 * (PRD 7.5 R1 failure mode).
 */
export const MAX_CAPTURED_OUTPUT_CHARS = 2000;

/**
 * Extra chars kept ahead of the final cut so redact() can see a secret's
 * identifying prefix even when the prefix sits just before the 2000-char
 * boundary. Masking runs on (bound + margin), then the already-masked text is
 * cut to the bound. Sized to comfortably cover a PEM header plus a long
 * `KEY=` name; it only widens what the regexes scan, never what is stored.
 */
export const REDACT_MARGIN_CHARS = 2000;

function nowIso() {
  return new Date().toISOString();
}

function currentCommit(cwd) {
  try {
    return execSync('git rev-parse HEAD', {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function generateId(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8);
  return `toss-${y}${m}${d}-${rand}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Pure capture step: validates inputs and builds a fully-formed, redacted,
 * size-bounded ledger item. No I/O beyond what the caller already supplied
 * (git commit hash resolution happens in `toss()`, not here) — this
 * function itself touches neither disk nor the network.
 *
 * Throws (does not return an error object) on any invalid input, per this
 * project's convention: a capture with no fix direction, no repro command,
 * or no repro output is not a report worth sending, so it is refused before
 * anything is written or transmitted.
 *
 * @param {object} input
 * @param {string} input.fromProject
 * @param {string} input.toProject
 * @param {string} input.title
 * @param {string} [input.why]
 * @param {{command: string, output: string}} input.repro
 * @param {{from_commit?: string|null, to_files?: string[]}} [input.anchors]
 * @param {string} input.fixDirection
 * @param {string} [input.id] - override for idempotent re-capture; auto-generated otherwise
 * @param {string} [input.createdAt] - override for tests; defaults to now
 * @returns {object} a ledger item satisfying ledger.mjs's `validateItem()`
 */
export function captureTossItem(input) {
  const {
    fromProject,
    toProject,
    title,
    why,
    repro,
    anchors,
    fixDirection,
    id,
    createdAt,
  } = input || {};

  if (!nonEmptyString(fromProject)) {
    throw new Error('captureTossItem: fromProject is required');
  }
  if (!nonEmptyString(toProject)) {
    throw new Error('captureTossItem: toProject is required');
  }
  if (!nonEmptyString(title)) {
    throw new Error('captureTossItem: title is required');
  }
  if (!repro || typeof repro !== 'object') {
    throw new Error('captureTossItem: repro is required ({ command, output })');
  }
  if (!nonEmptyString(repro.command)) {
    throw new Error('captureTossItem: repro.command is required and must be non-empty — a reproducible command is the whole point of a toss (SC2)');
  }
  if (!nonEmptyString(repro.output)) {
    throw new Error('captureTossItem: repro.output is required and must be non-empty — capture the actual command output, not a description of it (SC2)');
  }
  if (!nonEmptyString(fixDirection)) {
    throw new Error('captureTossItem: fix_direction is required — a "be careful"-level report is refused, not captured (project convention)');
  }

  const rawOutput = repro.output;
  const truncated = rawOutput.length > MAX_CAPTURED_OUTPUT_CHARS;
  // Redact BEFORE the final cut, on a margin-widened window. Truncating first
  // (the earlier order) could strip a secret's identifying prefix — a PEM
  // `-----BEGIN ... PRIVATE KEY-----` marker, or the `password=` key name —
  // away from the body that survives, and every pattern needs the marker and
  // the value in the SAME match to fire. The margin is masked, then the
  // already-masked text is cut to the real bound, so a marker landing inside
  // the margin still protects the body that is kept.
  const margin = truncated
    ? rawOutput.slice(-(MAX_CAPTURED_OUTPUT_CHARS + REDACT_MARGIN_CHARS))
    : rawOutput;
  const { text: maskedMargin } = redact(margin);
  const maskedOutput = maskedMargin.length > MAX_CAPTURED_OUTPUT_CHARS
    ? maskedMargin.slice(-MAX_CAPTURED_OUTPUT_CHARS)
    : maskedMargin;

  // The gate covers the COMMAND too, not just its output. A reproduction
  // command is the most likely place for a live credential to appear
  // (`curl -H "Authorization: Bearer sk-live-…"`), and it is shipped verbatim
  // into another project's durable memory. All five review vendors flagged
  // the command-only gap independently.
  const { text: maskedCommand } = redact(repro.command);

  // title / why / fix_direction are prose the reporter writes deliberately,
  // not captured machine output — a lower-risk class. They still go through
  // the gate: masking costs nothing on prose that holds no secret, and the
  // alternative is an undocumented carve-out that reads as an oversight.
  const { text: maskedTitle } = redact(title.trim());
  const { text: maskedWhy } = redact(typeof why === 'string' ? why : '');
  const { text: maskedFix } = redact(fixDirection.trim());

  const toFiles = Array.isArray(anchors?.to_files) ? anchors.to_files : [];

  return {
    id: nonEmptyString(id) ? id : generateId(),
    from_project: fromProject,
    to_project: toProject,
    created_at: nonEmptyString(createdAt) ? createdAt : nowIso(),
    // Capture-time state. NOT 'delivered' — nothing has been sent yet at this
    // point, and the sender's outbox copy is written before the skill attempts
    // any MCP call. recordMemMesh() promotes this to 'delivered' once a pin or
    // memory id actually comes back.
    status: 'captured',
    title: maskedTitle,
    why: maskedWhy,
    repro: { command: maskedCommand, output: maskedOutput, truncated },
    anchors: {
      from_commit: anchors?.from_commit ?? null,
      to_files: toFiles,
    },
    fix_direction: maskedFix,
    mem_mesh: {},
  };
}

/**
 * Build the exact arguments the SKILL should pass to the two MCP tool calls
 * that deliver a captured item to mem-mesh — `mcp__mem-mesh__pin_add` (an
 * expiring notification) and `mcp__mem-mesh__add` (the durable body). Pure —
 * no I/O, never throws, does not itself call anything.
 *
 * `add`'s `content` is the full item as JSON. The outbox's `to_project` is a
 * registry id chosen by the sender, while the receiving side identifies
 * itself by mem-mesh project id; those can differ. The transport copy
 * therefore normalizes only `to_project` to `memMeshProjectId`, preserving
 * the sender's local outbox record unchanged while making receiver ownership
 * validation unambiguous.
 *
 * @param {object} item a ledger item from `captureTossItem()`
 * @param {string} memMeshProjectId the TARGET project's mem-mesh identity
 *   (from `resolveTarget()` — never the sender's own)
 * @param {{ importance?: number }} [opts]
 * @returns {{
 *   pin_add: { content: string, project_id: string, tags: string[], importance: number },
 *   add: { content: string, project_id: string, category: string, tags: string[], anchors?: object },
 * }}
 */
export function buildMemMeshPayload(item, memMeshProjectId, opts = {}) {
  const { importance = DEFAULT_PIN_IMPORTANCE } = opts;
  const transportItem = { ...item, to_project: memMeshProjectId };

  return {
    pin_add: {
      content: inboxPinContent(item),
      project_id: memMeshProjectId,
      tags: [INBOX_PIN_TAG],
      importance,
    },
    add: {
      content: JSON.stringify(transportItem),
      project_id: memMeshProjectId,
      category: 'bug',
      tags: [INBOX_PIN_TAG],
      ...(item.anchors?.from_commit
        ? { anchors: { commit_hash: item.anchors.from_commit, file_paths: item.anchors.to_files } }
        : {}),
    },
  };
}

/**
 * Capture + local-write flow (R1). Order mirrors PRD §9 Happy Path steps 1-3
 * only — step 4 (mem-mesh delivery) is no longer this function's job (see
 * module header):
 *   1. capture (pure, validates + redacts + truncates) — rejects a bad
 *      capture before any target lookup or I/O
 *   2. resolveTarget() — the mandatory pre-flight gate (target.mjs); never
 *      proceeds on `ok:false`
 *   3. write the sender's own `.xm/outbox/<id>.json` (C2: own cwd only)
 *   4. build (not send) the mem-mesh MCP payload for the caller
 *
 * The outbox write happening unconditionally once capture + target
 * resolution succeed — independent of whatever the caller does with the
 * returned payload afterward — is what satisfies "outbox write succeeds even
 * when mem-mesh is unreachable / MCP unavailable" (t6 DoD / PRD R5 failure
 * mode).
 *
 * @returns {Promise<
 *   | { ok: true, item: object, outboxPath: string, memMeshProjectId: string,
 *       payload: ReturnType<typeof buildMemMeshPayload> }
 *   | { ok: false, reason: 'invalid_capture', message: string }
 *   | { ok: false, reason: 'unregistered'|'missing'|'ambiguous', message: string, candidates: string[] }
 * >}
 */
export async function toss(params = {}) {
  const {
    toProject,
    title,
    why,
    repro,
    anchors,
    fixDirection,
    cwd = process.cwd(),
    id,
    createdAt,
    importance,
  } = params;

  let item;
  try {
    const fromProject = resolveMemMeshProjectId(cwd, { allowEnvOverride: true });
    const fromCommit = anchors?.from_commit ?? currentCommit(cwd);
    item = captureTossItem({
      fromProject,
      toProject,
      title,
      why,
      repro,
      anchors: { ...anchors, from_commit: fromCommit },
      fixDirection,
      id,
      createdAt,
    });
  } catch (err) {
    return { ok: false, reason: 'invalid_capture', message: err.message };
  }

  let target;
  try {
    target = resolveTarget(toProject);
  } catch (err) {
    // loadRegistry() throws on a corrupt/unreadable ~/.xm/projects.json. Left
    // unguarded this escaped as a raw rejection, breaking the documented
    // result contract — and in --json mode the caller got no JSON at all.
    return { ok: false, reason: 'target_lookup_failed', message: err.message };
  }
  if (!target.ok) {
    return {
      ok: false, reason: target.reason, message: target.message, candidates: target.candidates,
    };
  }

  const outboxDir = join(cwd, '.xm', 'outbox');
  const outboxPath = join(outboxDir, `${item.id}.json`);
  try {
    writeLedger(outboxDir, item, { cwd });
  } catch (err) {
    // validateItem() TypeError (e.g. a caller-supplied `id` outside
    // ID_PATTERN) or real disk failure — unwritable dir, read-only fs, disk
    // full. Same contract reason as above: a structured failure, never a
    // stack trace, so `--json` stays parseable on every path.
    return { ok: false, reason: 'write_failed', message: err.message };
  }

  return {
    ok: true,
    item,
    outboxPath,
    memMeshProjectId: target.memMeshProjectId,
    payload: buildMemMeshPayload(item, target.memMeshProjectId, { importance }),
  };
}

/**
 * Human-readable one-line summary of a `toss()` result, for the CLI's
 * plain-text (non-`--json`) output. Since this module no longer attempts
 * delivery itself, it can only ever report the capture outcome — the caller
 * (skill) is responsible for reporting the actual MCP delivery outcome once
 * it has made those calls.
 */
export function describeCapture(result) {
  if (!result?.ok) {
    return `기록 실패: ${result?.message ?? 'unknown error'}`;
  }
  return `로컬 기록됨 (${result.outboxPath}) — mem-mesh 전송은 호출한 스킬이 MCP로 이어서 처리합니다.`;
}
