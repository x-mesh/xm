/**
 * x-inbox retention — bounds inbox/outbox ledger growth without ever risking
 * an unresolved item (cross-project-handoff R11, PRD Q1).
 *
 * Confirmed policy (Q1, decided over ledger-append growth from x-build's
 * later.mjs — see file header there for the anti-pattern this avoids):
 *
 *   - Only TERMINAL items (`status` is `actioned` or `dismissed`) are ever
 *     archived, and only after `DEFAULT_RETENTION_DAYS` (30) have passed.
 *   - `delivered` (unresolved) items are kept forever, no matter their age.
 *     An open-count cap was rejected on purpose: capping would make `toss`
 *     refuse new deliveries while the inbox owner is busy — exactly when
 *     they're least likely to stop and clear it out, so the tool stops
 *     getting used. Deleting terminal items outright was also rejected:
 *     archive must be reversible (see `readArchive()` below), not deletion.
 *
 * ── Which timestamp starts the 30-day clock? ──────────────────────────────
 * The shared ledger schema (`ledger.mjs`, deliberately not modified here)
 * requires `created_at` but does not mandate a status-transition timestamp —
 * no future writer is guaranteed to stamp `resolved_at`/`updated_at` when it
 * flips `status` to `actioned`/`dismissed`. `terminalSince()` below prefers
 * `resolved_at`, then `updated_at`, then falls back to `created_at`. Falling
 * back can only make the clock start EARLIER than the true transition time
 * (an item can't become terminal before it was created), never later — so
 * the worst case is archiving a terminal item a bit sooner than "30 days
 * since it closed." That costs nothing because archiving relocates, it does
 * not delete (see below), and it only ever affects items already terminal —
 * it can never pull in an unresolved item early. If a later writer (the
 * `/xm:inbox take|drop` CLI, R9) starts stamping `resolved_at` on transition,
 * this module picks it up automatically with no changes needed here.
 *
 * ── Where archived items go, and why ───────────────────────────────────────
 * Archived items move to `<ledgerDir>/archive/<id>.json` — same per-item
 * file convention as the live ledger, just one directory level down. Chosen
 * over the alternatives:
 *
 *   - A single combined `archive.json` array (rejected): every archive pass
 *     would need a read-modify-write of the whole file, re-introducing the
 *     exact unbounded-single-file growth (and lock contention) this task
 *     exists to avoid. Per-item files make each archive operation an
 *     independent, idempotent, atomically-renamed write via the SAME
 *     `writeLedger()` this module imports (no new write path, no new schema).
 *   - Placing it directly as a `.json` file inside the ledger dir (rejected):
 *     `readLedger()` (ledger.mjs) globs every `*.json` file in the directory
 *     it's given and JSON.parses each one as an item. A bare archive file
 *     sitting next to live items would get parsed and returned as a bogus
 *     "item" by every future `readLedger(ledgerDir)` call. A subdirectory
 *     name (`archive`) does not end in `.json`, so `readdirSync(...).filter(f
 *     => f.endsWith('.json'))` skips it entirely — no collision, verified
 *     against the exact filter in ledger.mjs `readLedger()`.
 *   - Sharding by year-month (rejected, at least for now): adds a filename
 *     scheme and multi-file reads for recovery with no payoff at the volume
 *     this system runs at (single user, local project-to-project handoffs).
 *     Revisit only if `archive/` itself needs pagination.
 *
 * Recoverability: an archived item is a file, unchanged, just moved. To
 * restore one, read it back (`readArchive()` below) and `writeLedger(dir,
 * item)` — no format translation needed.
 *
 * ── When does this run? ────────────────────────────────────────────────────
 * No cron, no session hook — deliberately (forbidden by the task, and this
 * project already has one cautionary tale: `later.mjs` never reaps anything
 * at all). Instead, `archiveExpired()` is meant to be called opportunistically
 * by every `/xm:inbox` subcommand that reads the ledger (`list`, `take`,
 * `drop` — R9, not yet built as of this file) BEFORE it calls `readLedger()`.
 * This is a deliberate design constraint, not a placeholder: `ledger.mjs` is
 * off-limits for edits, so the sweep cannot be embedded inside `readLedger()`
 * itself — it has to be an explicit call at each read call site. The sweep is
 * cheap (one directory listing + zero-to-few small file writes) and fully
 * idempotent (an already-archived item's source file is simply gone, so a
 * second pass over the same items is a safe no-op) — safe to call
 * unconditionally on every invocation, no debouncing required.
 */

import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { readLedger, writeLedger } from './ledger.mjs';

/** Default retention window in days. Exposed as a named export (not just a
 * magic number below) so a future config layer (`xm config`) can override it
 * per-project — that wiring is out of scope here; this constant is the seam. */
export const DEFAULT_RETENTION_DAYS = 30;

/** `status` values that make an item eligible for archiving. `delivered`
 * (unresolved) is deliberately absent — see file header. */
export const TERMINAL_STATUSES = Object.freeze(['actioned', 'dismissed']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toEpochMs(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** True when `item.status` is one of `TERMINAL_STATUSES`. */
export function isTerminal(item) {
  return !!item && TERMINAL_STATUSES.includes(item.status);
}

/**
 * The timestamp the 30-day retention clock runs from. See file header for
 * why the fallback chain is safe (can only undercount age, never overcount).
 */
export function terminalSince(item) {
  return item?.resolved_at ?? item?.updated_at ?? item?.created_at;
}

/**
 * Pure decision function — no I/O, no `Date.now()` inside. `now` is always
 * caller-supplied (`Date` instance or ISO string) so tests never depend on
 * the wall clock. This is the single source of truth for "is this item
 * archivable"; both `partitionForArchive()` and `archiveExpired()` below
 * route through it.
 *
 * @param {object} item - a parsed ledger item (see ledger.mjs schema)
 * @param {Date | string} now - current time, caller-supplied
 * @param {number} [retentionDays] - defaults to DEFAULT_RETENTION_DAYS
 * @returns {boolean}
 */
export function isArchivable(item, now, retentionDays = DEFAULT_RETENTION_DAYS) {
  // Core invariant (R11 / Q1): unresolved items are NEVER archived, at any
  // age. This check alone is what keeps a 300-day-old `delivered` item safe.
  if (!isTerminal(item)) return false;

  const sinceMs = toEpochMs(terminalSince(item));
  if (!Number.isFinite(sinceMs)) return false; // missing/malformed timestamp -> never auto-archive; stay visible rather than silently vanish

  const nowMs = toEpochMs(now);
  if (!Number.isFinite(nowMs)) return false;

  const thresholdMs = retentionDays * MS_PER_DAY;
  // Inclusive at the boundary: "30 days after" means archivable AT 30 days
  // elapsed, not only strictly past it. 29 days -> kept, 30 -> archived, 31 -> archived.
  return nowMs - sinceMs >= thresholdMs;
}

/**
 * Split a list of ledger items into `keep` (stays in the live ledger) and
 * `archive` (eligible for relocation). Pure — same caller-supplied-`now`
 * contract as `isArchivable()`.
 */
export function partitionForArchive(items, now, retentionDays = DEFAULT_RETENTION_DAYS) {
  const keep = [];
  const archive = [];
  for (const item of items ?? []) {
    (isArchivable(item, now, retentionDays) ? archive : keep).push(item);
  }
  return { keep, archive };
}

/** The archive subdirectory for a given ledger dir (e.g. `.xm/inbox` ->
 * `.xm/inbox/archive`). Exported so callers/tests can locate archived items
 * without duplicating the path convention. */
export function archiveDirFor(ledgerDir) {
  return join(ledgerDir, 'archive');
}

/**
 * Read back everything previously archived for `ledgerDir` — the recovery
 * path. Reuses `readLedger()` verbatim (same schema, same corrupt-file
 * skip-don't-throw behavior), just pointed at the archive subdirectory.
 */
export function readArchive(ledgerDir) {
  return readLedger(archiveDirFor(ledgerDir));
}

/**
 * Opportunistic sweep: read `ledgerDir`, move every archivable item into
 * `archiveDirFor(ledgerDir)`, and return the surviving (kept) items so the
 * caller doesn't need to re-read the ledger. Meant to be called by every
 * `/xm:inbox` subcommand before it acts on the ledger — see file header for
 * why this can't live inside `readLedger()` itself.
 *
 * Write-then-delete ordering: each item is written to the archive location
 * BEFORE its source file is removed, so a crash/throw mid-sweep can only
 * leave a duplicate (item present in both places — harmless, next sweep
 * just re-archives-and-deletes, `writeLedger` is idempotent per id), never a
 * lost item.
 *
 * @param {string} ledgerDir - e.g. `.xm/inbox` (absolute or cwd-relative)
 * @param {object} [opts]
 * @param {Date | string} [opts.now] - defaults to `new Date()`
 * @param {number} [opts.retentionDays] - defaults to DEFAULT_RETENTION_DAYS
 * @param {string} [opts.cwd] - ownership-check cwd, forwarded to writeLedger
 *   (see ledger.mjs assertOwnedLedgerDir); defaults to process.cwd()
 * @returns {{ archivedIds: string[], keptItems: object[] }}
 */
export function archiveExpired(ledgerDir, opts = {}) {
  const now = opts.now ?? new Date();
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cwd = opts.cwd ?? process.cwd();

  const items = readLedger(ledgerDir);
  const { keep, archive } = partitionForArchive(items, now, retentionDays);
  if (archive.length === 0) return { archivedIds: [], keptItems: keep };

  const archivedIds = [];
  for (const item of archive) {
    writeLedger(archiveDirFor(ledgerDir), item, { cwd });
    const source = join(ledgerDir, `${item.id}.json`);
    if (existsSync(source)) unlinkSync(source);
    archivedIds.push(item.id);
  }
  return { archivedIds, keptItems: keep };
}
