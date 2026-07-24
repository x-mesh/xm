/**
 * x-inbox inbox operations — list/take/resolve/drop over a ledger dir, plus pin
 * re-notification (cross-project-handoff R7, R9).
 *
 * This module is the receiving side's interaction surface: a user (or the
 * `/xm:inbox` skill, wired separately in t9) lists what landed in
 * `.xm/inbox/`, takes one to start working on it, resolves completed work,
 * or drops one they don't want. These transitions use
 * `ledger.mjs`'s `readLedger`/`writeLedger` — this module owns no I/O of its
 * own beyond that.
 *
 * Out of scope on purpose: promoting a taken item into an x-build task.
 * `later promote` cannot carry an item's body (x-build tasks have no
 * `description` field to hold why/repro/fix_direction — confirmed by reading
 * x-build's task schema), so `take()` instead returns the full item so the
 * *caller* decides what to do with its content. Do not wire this into
 * `later promote` expecting the body to survive the trip.
 *
 * Pin re-notification (R7) is injected, not hardwired: this module never
 * imports a mem-mesh client. It depends only on the `PinPort` shape below,
 * which a sibling task (t6) is still finalizing the real implementation of.
 * Tests here use a fake; production wiring swaps in the real one without
 * touching this file.
 */

import {
  readLedger, writeLedger, writeLedgerIfAbsent, reconcile, RECONCILE_ACTIONS, validateItem,
} from './ledger.mjs';
import { resolveMemMeshProjectId } from './target.mjs';
import { join, resolve } from 'node:path';

/**
 * Sort rank for `list()` — new work first, then work in progress, then
 * terminal items. Ties keep `readLedger`'s existing created_at-ascending
 * order (Array#sort is a stable sort in both V8 and JavaScriptCore/Bun).
 * An item somehow carrying a status outside `ledger.mjs`'s `STATUSES` (only
 * possible via a hand-edited or corrupted-but-parseable file, since
 * `readLedger` does not itself call `validateItem`) sorts last, defensively.
 */
const STATUS_RANK = Object.freeze({
  captured: 0,
  delivered: 0,
  in_progress: 1,
  actioned: 1,
  resolved: 2,
  dismissed: 3,
});

/** Thrown by take()/drop()/reconcileItemPin() when `id` matches no ledger item. */
export class InboxItemNotFoundError extends Error {
  constructor(id) {
    super(`No inbox item with id ${JSON.stringify(id)}`);
    this.name = 'InboxItemNotFoundError';
    this.id = id;
  }
}

/** Thrown when a mem-mesh memory body cannot safely become a local inbox item. */
export class InboxMaterializationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxMaterializationError';
  }
}

/**
 * Materialization is intentionally narrower than the shared ledger writer:
 * it is the receiving-side ingress and may only create files in this cwd's
 * `.xm/inbox`. `writeLedger()` also supports other owned ledgers such as an
 * outbox, which is right for its generic callers but wrong for a body read
 * from mem-mesh. Check before reading for a duplicate too, so this API cannot
 * be used to inspect another project's ledger.
 */
function assertOwnedInboxDir(dir, cwd) {
  const owner = resolve(cwd);
  const expected = join(owner, '.xm', 'inbox');
  const received = resolve(owner, dir);
  if (received !== expected) {
    throw new InboxMaterializationError(
      `refusing to materialize outside receiving inbox (dir=${JSON.stringify(received)}, expected=${JSON.stringify(expected)})`,
    );
  }
  return expected;
}

/**
 * Materialize one durable mem-mesh memory body into this project's inbox.
 *
 * The caller supplies the memory's `content` (the JSON body produced by
 * `buildMemMeshPayload()`), because this module intentionally has no MCP
 * client. The receiving skill obtains that content through mem-mesh and
 * passes it here. The transport payload normalizes `to_project` to the
 * target's mem-mesh project id, so strict equality with this cwd's identity
 * prevents one project's memory search result from entering another ledger.
 *
 * Existing ids are deliberately left byte-for-byte untouched. In particular,
 * a repeated memory search must not reset a locally progressed or terminal
 * item back to `delivered`. This makes materialization idempotent while the
 * local ledger remains authoritative for receiving-side status.
 *
 * @param {string} dir receiving `.xm/inbox` directory
 * @param {string|object} memoryContent JSON memory content or an already-parsed item
 * @param {{ cwd?: string, projectId?: string, memoryId?: string, pinId?: string, beforePersist?: () => void }} [opts]
 * @returns {{ item: object, created: boolean }}
 */
export function materializeMemory(dir, memoryContent, opts = {}) {
  let payload;
  try {
    payload = typeof memoryContent === 'string' ? JSON.parse(memoryContent) : memoryContent;
  } catch {
    throw new InboxMaterializationError('memory content is not valid JSON');
  }

  try {
    validateItem(payload);
  } catch (err) {
    throw new InboxMaterializationError(`memory content is not a valid inbox item: ${err.message}`);
  }

  const cwd = opts.cwd ?? process.cwd();
  const inboxDir = assertOwnedInboxDir(dir, cwd);
  const receiverProject = opts.projectId ?? resolveMemMeshProjectId(cwd, { allowEnvOverride: true });
  if (payload.to_project !== receiverProject) {
    throw new InboxMaterializationError(
      `memory item targets ${JSON.stringify(payload.to_project)}, not receiving project ${JSON.stringify(receiverProject)}`,
    );
  }

  const mem_mesh = { ...payload.mem_mesh };
  if (typeof opts.memoryId === 'string' && opts.memoryId.length > 0) mem_mesh.memory_id = opts.memoryId;
  if (typeof opts.pinId === 'string' && opts.pinId.length > 0) mem_mesh.pin_id = opts.pinId;
  const item = { ...payload, status: 'delivered', mem_mesh };
  // `writeLedgerIfAbsent` performs the duplicate check atomically. A second
  // materialization can race with another session's take/resolve, but it may
  // only return that local state — never overwrite it with `delivered`.
  return writeLedgerIfAbsent(inboxDir, item, { cwd, beforeCommit: opts.beforePersist });
}

function findItemOrThrow(dir, id) {
  const items = readLedger(dir);
  const item = items.find((i) => i.id === id);
  if (!item) throw new InboxItemNotFoundError(id);
  return item;
}

/**
 * List every ledger item in `dir`, unresolved-first. Callers MUST address
 * items by `.id` (stable, part of the schema) — never by an index into this
 * array. The list is recomputed from disk on every call, so an index a
 * caller cached from a previous call can silently point at a different item
 * once anything else in the dir changes; `id` cannot.
 *
 * @param {string} dir
 * @returns {object[]} full ledger items, sorted new < in-progress < terminal
 */
export function list(dir) {
  const items = readLedger(dir);
  return [...items].sort((a, b) => {
    const ra = STATUS_RANK[a?.status] ?? 99;
    const rb = STATUS_RANK[b?.status] ?? 99;
    return ra - rb;
  });
}

/**
 * Mark an item `in_progress` — the caller has started working on it. Returns
 * the full updated item (why/repro/fix_direction included) so the caller can
 * act on its content; this function does no promotion of its own (see
 * module header). Throws `InboxItemNotFoundError` and writes nothing when
 * `id` does not exist (PRD §7.5 R9).
 *
 * @param {string} dir
 * @param {string} id
 * @param {{ cwd?: string }} [opts] forwarded to writeLedger's ownership check
 * @returns {object} the updated item
 */
export function take(dir, id, opts = {}) {
  const item = findItemOrThrow(dir, id);
  // A terminal report has an immutable receipt/provenance chain. Re-opening
  // it through `take` would leave that receipt attached to an in-progress
  // item and make a later terminal transition contradictory.
  if (item.status === 'resolved' || item.status === 'dismissed') return item;
  const { resolved_at: _resolvedAt, ...openItem } = item;
  const updated = {
    ...openItem,
    status: 'in_progress',
    updated_at: new Date(opts.now ?? Date.now()).toISOString(),
  };
  writeLedger(dir, updated, opts);
  return updated;
}

/**
 * Mark an item `resolved` after its fix has actually completed. This is
 * deliberately separate from `take`: starting work is not proof of
 * completion. The terminal timestamp drives the retention clock.
 *
 * @param {string} dir
 * @param {string} id
 * @param {{ cwd?: string, now?: Date|string|number }} [opts]
 * @returns {object} the updated item
 */
export function resolveItem(dir, id, opts = {}) {
  const item = findItemOrThrow(dir, id);
  // Terminal states are immutable. A late resolve must not turn a prior
  // dismissal into a contradictory terminal receipt (or vice versa).
  if (item.status === 'resolved' || item.status === 'dismissed') return item;
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const updated = { ...item, status: 'resolved', updated_at: at, resolved_at: at };
  writeLedger(dir, updated, opts);
  return updated;
}

/**
 * Mark an item `dismissed` — the caller does not want it. Throws
 * `InboxItemNotFoundError` and writes nothing when `id` does not exist (PRD
 * §7.5 R9).
 *
 * @param {string} dir
 * @param {string} id
 * @param {{ cwd?: string }} [opts] forwarded to writeLedger's ownership check
 * @returns {object} the updated item
 */
export function drop(dir, id, opts = {}) {
  const item = findItemOrThrow(dir, id);
  if (item.status === 'resolved' || item.status === 'dismissed') return item;
  const at = new Date(opts.now ?? Date.now()).toISOString();
  const updated = { ...item, status: 'dismissed', updated_at: at, resolved_at: at };
  writeLedger(dir, updated, opts);
  return updated;
}

/**
 * Pin transport port — the only seam this module has onto mem-mesh. The real
 * binding (pin_add/pin_get/pin_complete over MCP) is intentionally NOT
 * implemented here; this module depends only on this shape, so tests can
 * supply a fake without touching this file.
 *
 * As of t11, there is also no real implementation of this port anywhere in
 * `xm/lib/x-inbox-cli.mjs` — a plain Node CLI process cannot call an MCP tool
 * (no MCP session, no auth; see toss.mjs's header for the full story), so it
 * cannot implement `getState`/`create` by making a network call. Production
 * reconciliation instead happens SKILL-side: the skill calls
 * `mcp__mem-mesh__pin_get` itself for a pin id it already has (from
 * `xm inbox list --json`'s `mem_mesh.pin_id`), applies the same two rules
 * `reconcile()` encodes for a dead pin (not found, or `status: 'completed'`
 * → renotify), calls `mcp__mem-mesh__pin_add` itself when renotifying, and
 * writes the new id back via `ledger.mjs`'s `recordMemMesh()` (exposed as
 * `xm inbox record <id> --pin-id <id> --scope inbox`). This module's
 * `reconcileGivenItem`/`reconcileAllPins`/`reconcileItemPin` below remain
 * correct, pure-injection implementations of that same decision logic and
 * stay covered by tests with a fake `PinPort` — they are just not wired to a
 * live implementation in this codebase's CLI anymore. A future non-CLI
 * caller that DOES hold a live MCP/HTTP session (unlike this CLI) can still
 * satisfy this same `PinPort` shape and reuse these functions unmodified.
 *
 * @typedef {Object} PinState
 * @property {'in_progress'|'completed'} status
 *
 * @typedef {Object} PinPort
 * @property {(pinId: string) => (PinState|null)|Promise<PinState|null>} getState
 *   Look up a pin's current status by id. Return `null` when there is no
 *   live record for it at all (never created, hard-deleted, whatever the
 *   real backend's equivalent of "gone" is).
 * @property {(item: object) => ({pin_id: string})|Promise<{pin_id: string}>} create
 *   Create a brand-new pin seeded from a ledger item's content and return
 *   its id.
 */

/**
 * Reconcile one ledger item's pin state against `ledger.mjs`'s `reconcile()`
 * and recreate the pin when the transport is dead but the item is still
 * unresolved (PRD R7 / §8 state-consistency table, row 2 "재고지").
 *
 * `RENOTIFY` (no live pin at all) and `SYNC_STATUS` (pin exists but reports
 * `completed`) are BOTH treated as "recreate the pin" here, not just
 * `RENOTIFY`: per PRD C5, this codebase's only path to a completed pin is
 * mem-mesh's 7-day auto-close (`_auto_close_stale_pins`, `session.py:164`) —
 * a delivery pin is never marked complete by genuine user action on the
 * receiving side (that's what `take`/`drop` are for, and they never touch
 * `mem_mesh.pin_id`). So a completed pin always means "expired," whether a
 * given `PinPort` implementation happens to surface that as `null` or as
 * `{status:'completed'}`. `ledger.mjs` itself only inspects raw pin state and
 * intentionally leaves this equivalence to the caller (see its `reconcile()`
 * jsdoc) — this is that caller's decision.
 *
 * At-most-one-pin-per-item (PRD §7.5 R7) falls out of persistence, not a
 * separate lock: once a new pin's id is written back into the item's
 * `mem_mesh.pin_id`, the next call observes that pin as live (assuming the
 * injected `pinPort` reports newly-created pins as `in_progress`) and takes
 * the `NONE` branch — no new pin gets created. Calling this repeatedly with
 * the same `pinPort` (e.g. once per session start) is therefore safe.
 *
 * Nothing is recreated for an already-terminal item — `reconcile()`'s
 * `ledgerUnresolved` check already excludes it from both RENOTIFY and
 * SYNC_STATUS, so a dead pin on a dismissed item is correctly left alone.
 *
 * @param {string} dir
 * @param {object} item a full ledger item (already read)
 * @param {PinPort} pinPort
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<{ id: string, action: string, reason: string, pin_id: string|null, recreated: boolean }>}
 */
async function reconcileGivenItem(dir, item, pinPort, opts) {
  const pinId = item.mem_mesh?.pin_id ?? null;
  const pinState = pinId ? await pinPort.getState(pinId) : null;
  const result = reconcile(pinState, item);

  const deadTransport = result.action === RECONCILE_ACTIONS.RENOTIFY
    || result.action === RECONCILE_ACTIONS.SYNC_STATUS;

  if (!deadTransport) {
    return { id: item.id, action: result.action, reason: result.reason, pin_id: pinId, recreated: false };
  }

  const created = await pinPort.create(item);
  const newPinId = created?.pin_id;
  if (typeof newPinId !== 'string' || newPinId.length === 0) {
    throw new TypeError('reconcileGivenItem: pinPort.create() must resolve to { pin_id: string }');
  }

  const updated = { ...item, mem_mesh: { ...item.mem_mesh, pin_id: newPinId } };
  writeLedger(dir, updated, opts);
  return { id: item.id, action: result.action, reason: result.reason, pin_id: newPinId, recreated: true };
}

/**
 * Reconcile a single item by id. Throws `InboxItemNotFoundError` (no writes,
 * no pinPort calls) when `id` does not exist.
 *
 * @param {string} dir
 * @param {string} id
 * @param {PinPort} pinPort
 * @param {{ cwd?: string }} [opts]
 */
export async function reconcileItemPin(dir, id, pinPort, opts = {}) {
  const item = findItemOrThrow(dir, id);
  return reconcileGivenItem(dir, item, pinPort, opts);
}

/**
 * Reconcile every item currently in `dir` (e.g. run once per session start).
 * Never throws for an empty or missing dir — `readLedger` already reads a
 * missing dir as `[]`.
 *
 * @param {string} dir
 * @param {PinPort} pinPort
 * @param {{ cwd?: string }} [opts]
 * @returns {Promise<Array<{ id: string, action: string, reason: string, pin_id: string|null, recreated: boolean }>>}
 */
export async function reconcileAllPins(dir, pinPort, opts = {}) {
  const items = readLedger(dir);
  const reports = [];
  for (const item of items) {
    reports.push(await reconcileGivenItem(dir, item, pinPort, opts));
  }
  return reports;
}
