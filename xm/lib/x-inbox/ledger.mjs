/**
 * x-inbox ledger — shared read/write core for `.xm/outbox/<id>.json` and
 * `.xm/inbox/<id>.json` (cross-project-handoff R3, R6).
 *
 * The ledger file is the source of truth for a handed-off item. mem-mesh
 * (pin + memory) is transport only — pins auto-expire after 7 days, the
 * ledger file does not. See PRD `cross-project-handoff` §8 for the full
 * "ledger vs transport" split and the state-consistency table this module
 * implements via `reconcile()`.
 *
 * Ownership invariant (C2): every `.xm/` writer in this codebase writes only
 * under the `.xm/` owned by its own cwd. `writeLedger()` enforces this by
 * resolving `dir` against the owner cwd (default `process.cwd()`, override
 * via `opts.cwd` for tests) and throwing if the resolved path escapes
 * `<owner cwd>/.xm/`.
 *
 * mem-mesh calls (pin_add/pin_get/etc.) are out of scope here — `reconcile()`
 * is a pure function that takes pin state as a plain argument. The caller
 * (future toss/inbox CLI tasks) is responsible for querying mem-mesh and
 * acting on the returned decision.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * Allowed values for item.status. Presence of a file alone never implies status.
 *
 * `captured` vs `delivered` exists because one enum was serving two different
 * lifecycles. The sender writes its outbox copy BEFORE the skill attempts any
 * mem-mesh call, so starting at `delivered` meant a never-sent item was
 * persisted claiming it had been sent — the only counter-signal being an empty
 * `mem_mesh`, which reads opposite to what `status` says. `captured` is the
 * honest capture-time state; `recordMemMesh()` promotes it once an id actually
 * comes back. On the receiving side an item materializes at `delivered`, which
 * is true by construction there.
 *
 * Non-terminal: captured, delivered, in_progress. Terminal: resolved,
 * dismissed (see retention.mjs TERMINAL_STATUSES). `actioned` remains valid
 * as a legacy non-terminal value written by older `take` implementations.
 */
export const STATUSES = Object.freeze([
  'captured', 'delivered', 'in_progress', 'actioned', 'resolved', 'dismissed',
]);

/** Ledger id charset: safe as a bare filename component, no path separators or traversal. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** Decisions `reconcile()` can return. */
export const RECONCILE_ACTIONS = Object.freeze({
  NONE: 'none',
  RENOTIFY: 'renotify',
  SELF_CREATE: 'self_create',
  SYNC_STATUS: 'sync_status',
});

/** Thrown by `recordMemMesh()` when `id` matches no ledger item in `dir`. */
export class LedgerItemNotFoundError extends Error {
  constructor(id, dir) {
    super(`No ledger item with id ${JSON.stringify(id)} in ${dir}`);
    this.name = 'LedgerItemNotFoundError';
    this.id = id;
    this.dir = dir;
  }
}

const REQUIRED_STRING_FIELDS = ['id', 'from_project', 'to_project', 'created_at', 'title'];

export function isValidLedgerId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

/**
 * Validate an item against the shared inbox/outbox schema. Throws with a
 * specific message on the first violation; does not collect all errors.
 */
export function validateItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError('validateItem: item must be a plain object');
  }
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof item[field] !== 'string' || item[field].length === 0) {
      throw new TypeError(`validateItem: "${field}" must be a non-empty string`);
    }
  }
  if (!isValidLedgerId(item.id)) {
    throw new TypeError(`validateItem: "id" must match ${ID_PATTERN} (got ${JSON.stringify(item.id)})`);
  }
  if (!STATUSES.includes(item.status)) {
    throw new TypeError(`validateItem: "status" must be one of ${STATUSES.join('|')} (got ${JSON.stringify(item.status)})`);
  }
  for (const optionalObjectField of ['repro', 'anchors', 'mem_mesh']) {
    const value = item[optionalObjectField];
    if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      throw new TypeError(`validateItem: "${optionalObjectField}" must be an object when present`);
    }
  }
  if (item.anchors?.to_files !== undefined && !Array.isArray(item.anchors.to_files)) {
    throw new TypeError('validateItem: "anchors.to_files" must be an array when present');
  }
  return item;
}

/**
 * Resolve `dir` against the owner cwd and assert it stays inside
 * `<ownerCwd>/.xm/`. Throws on escape. Exported so sibling tasks (toss,
 * inbox CLI) can reuse the same guard instead of re-deriving it.
 */
export function assertOwnedLedgerDir(dir, cwd = process.cwd()) {
  const ownerCwd = resolve(cwd);
  const ownerXmRoot = join(ownerCwd, '.xm');
  const absDir = resolve(ownerCwd, dir);
  if (absDir !== ownerXmRoot && !absDir.startsWith(ownerXmRoot + sep)) {
    throw new Error(`assertOwnedLedgerDir: refusing to write outside owned .xm/ (dir="${absDir}", owner="${ownerXmRoot}")`);
  }
  return absDir;
}

/**
 * Read every ledger item in `dir`. Missing directory reads as empty (dirs
 * are created lazily on first write). A single corrupt/partial file is
 * skipped rather than failing the whole read — ledger reads back a session
 * hook's injected list (R8) and one bad file must not take the rest down.
 * Returns items sorted by created_at ascending (falls back to id).
 */
export function readLedger(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const items = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      items.push(JSON.parse(raw));
    } catch {
      // Corrupt or mid-write file — skip, don't fail the whole ledger read.
      continue;
    }
  }
  items.sort((a, b) => {
    const ac = typeof a?.created_at === 'string' ? a.created_at : '';
    const bc = typeof b?.created_at === 'string' ? b.created_at : '';
    if (ac !== bc) return ac < bc ? -1 : 1;
    return String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
  });
  return items;
}

/**
 * Write (create or update) a ledger item, keyed by id — idempotent: calling
 * twice with the same id overwrites the same file. Atomic via `.tmp` +
 * `renameSync` (mirrors x-projects-registry.mjs saveRegistry()).
 *
 * `opts.cwd` overrides the owner cwd used for the ownership check; defaults
 * to `process.cwd()`. Real callers should never need it — it exists for
 * tests that don't want to `process.chdir()`.
 */
export function writeLedger(dir, item, opts = {}) {
  validateItem(item);
  const absDir = assertOwnedLedgerDir(dir, opts.cwd ?? process.cwd());
  mkdirSync(absDir, { recursive: true });

  const target = resolve(absDir, `${item.id}.json`);
  if (!target.startsWith(absDir + sep)) {
    // Defense in depth: id already validated against ID_PATTERN above, so
    // this should be unreachable, but never trust a single check for path escape.
    throw new Error(`writeLedger: refusing to write outside ledger dir (id=${JSON.stringify(item.id)})`);
  }

  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(item, null, 2) + '\n');
  renameSync(tmp, target);
  return item;
}

/**
 * Merge `patch` (a subset of `{ pin_id, memory_id }`) into an existing ledger
 * item's `mem_mesh` field and write it back — the write-back half of the
 * capture/transport split (t11): this codebase's CLI never calls mem-mesh
 * itself (see toss.mjs header), so the SKILL that drives `/xm:toss` or
 * `/xm:inbox` calls the real `pin_add`/`add`/`pin_get` MCP tools itself and
 * then hands the resulting ids back here to persist into the ledger — the
 * ledger file stays the single source of truth for what was actually
 * delivered.
 *
 * Idempotent and additive: only the keys present in `patch` are touched, any
 * existing `mem_mesh` fields not named in `patch` (e.g. a `pin_id` already
 * recorded, when only `memory_id` is being added later) are preserved.
 *
 * Throws `LedgerItemNotFoundError` (no write) when `id` does not exist in
 * `dir` — mirrors `inbox.mjs`'s `take`/`drop` not-found behavior.
 *
 * @param {string} dir
 * @param {string} id
 * @param {{ pin_id?: string, memory_id?: string }} patch
 * @param {{ cwd?: string }} [opts] forwarded to writeLedger's ownership check
 * @returns {object} the updated item
 */
export function recordMemMesh(dir, id, patch, opts = {}) {
  const items = readLedger(dir);
  const item = items.find((i) => i.id === id);
  if (!item) throw new LedgerItemNotFoundError(id, dir);

  const mem_mesh = { ...item.mem_mesh, ...patch };
  // Promote capture-time state once transport actually produced an id. Only
  // `captured` is promoted — never re-open an item the receiver already
  // in-progress/terminal items just because a pin id was recorded later.
  const delivered = Boolean(mem_mesh.pin_id || mem_mesh.memory_id);
  const status = item.status === 'captured' && delivered ? 'delivered' : item.status;

  const updated = { ...item, status, mem_mesh };
  writeLedger(dir, updated, opts);
  return updated;
}

/**
 * Pure decision function for the 5 state-consistency rules (PRD §8). No I/O,
 * no mem-mesh calls — the caller queries pin state and the local ledger item
 * and passes both in.
 *
 * @param {null | { status: 'in_progress' | 'completed' }} pinState
 *   `null` when no live pin exists (never created, or expired/closed).
 * @param {null | { status: string }} ledgerItem
 *   `null` when no ledger file exists for this id. Otherwise the parsed
 *   item (only `status` is inspected here).
 * @returns {{ action: string, reason: string }}
 */
export function reconcile(pinState, ledgerItem) {
  const pinExists = pinState != null;
  const pinCompleted = pinExists && pinState.status === 'completed';
  const ledgerExists = ledgerItem != null;
  const ledgerUnresolved = ledgerExists
    && ledgerItem.status !== 'resolved'
    && ledgerItem.status !== 'dismissed';

  // Rule 5: pin exists but is completed while the ledger still shows the
  // item unresolved — a status update was missed. Reflect pin state into
  // the ledger on read.
  if (ledgerExists && ledgerUnresolved && pinCompleted) {
    return { action: RECONCILE_ACTIONS.SYNC_STATUS, reason: 'pin_completed_ledger_unresolved' };
  }

  // Rule 1: both present — normal, nothing to do.
  if (pinExists && ledgerExists) {
    return { action: RECONCILE_ACTIONS.NONE, reason: 'normal' };
  }

  // Rule 2: pin gone (7-day expiry) but the ledger still has an unresolved
  // item — re-notify by recreating the pin from the ledger.
  if (!pinExists && ledgerExists && ledgerUnresolved) {
    return { action: RECONCILE_ACTIONS.RENOTIFY, reason: 'pin_expired' };
  }

  // Rule 3: pin exists but no local ledger file yet — self-create it from
  // the pin's content.
  if (pinExists && !ledgerExists) {
    return { action: RECONCILE_ACTIONS.SELF_CREATE, reason: 'ledger_missing' };
  }

  // Rule 4 (both absent = closed) and the remaining case (pin absent,
  // ledger present but already terminal) both resolve to no action.
  return { action: RECONCILE_ACTIONS.NONE, reason: pinExists || ledgerExists ? 'resolved' : 'closed' };
}
