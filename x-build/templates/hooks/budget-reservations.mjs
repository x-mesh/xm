// budget-reservations.mjs — small, dependency-free reservation ledger for the
// budget PreToolUse hook. This is copied beside the hook, so keep it Node builtin
// only and do not store tool prompts, task names, or other user content.

import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const DEFAULT_RESERVATION_TTL_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 10 * 1000;
const LOCK_TIMEOUT_MS = 1000;

function numeric(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms) {
  // Atomics.wait avoids a child-process/shell dependency in every hook call.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath, now = Date.now()) {
  const started = now;
  for (;;) {
    try {
      mkdirSync(lockPath);
      return () => { try { rmdirSync(lockPath); } catch { /* best effort */ } };
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      try { if (lstatSync(lockPath).isSymbolicLink()) return null; } catch { continue; }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockPath);
          continue;
        }
      } catch { continue; }
      if (Date.now() - started >= LOCK_TIMEOUT_MS) return null;
      sleep(4);
    }
  }
}

function isSymlink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function lexists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

function inferredRoot(filePath) {
  const marker = `${sep}.xm${sep}build${sep}metrics${sep}reservations.jsonl`;
  const absolute = resolve(filePath);
  const index = absolute.lastIndexOf(marker);
  return index > 0 ? absolute.slice(0, index) : null;
}

/**
 * The hook only owns <root>/.xm/build/metrics/reservations.jsonl. Reject every
 * symlink in that path, including sidecars, before a mkdir/write can escape the
 * project. This also keeps accidental callers from using the helper as a
 * generic arbitrary-path writer.
 */
function safeLedgerPaths(filePath, rootDir) {
  const root = resolve(rootDir || inferredRoot(filePath) || '');
  const ledger = resolve(filePath);
  const metrics = join(root, '.xm', 'build', 'metrics');
  if (!rootDir && !inferredRoot(filePath)) return false;
  if (ledger !== join(metrics, 'reservations.jsonl')) return false;
  try {
    if (!lexists(root) || isSymlink(root)) return false;
    for (const component of [join(root, '.xm'), join(root, '.xm', 'build'), metrics]) {
      if (lexists(component) && isSymlink(component)) return false;
      if (!lexists(component)) mkdirSync(component);
      if (isSymlink(component)) return false;
    }
    for (const path of [ledger, ledger + '.lock', ledger + '.bak', ledger + '.pending', ledger + '.tmp', ledger + '.bak.tmp', ledger + '.pending.tmp']) {
      if (lexists(path) && isSymlink(path)) return false;
    }
    return true;
  } catch { return false; }
}

/** A row is active through its deadline; it expires exactly at expires_at. */
export function isActiveReservation(row, now = Date.now()) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const cost = Number(row.cost_usd);
  const expiresAt = Date.parse(row.expires_at);
  return Number.isFinite(cost) && cost > 0 && Number.isFinite(expiresAt) && now < expiresAt;
}

/** Torn/malformed JSONL rows are ignored rather than poisoning future dispatches. */
export function activeReservations(text, now = Date.now()) {
  if (typeof text !== 'string') return [];
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (isActiveReservation(row, now)) rows.push(row);
    } catch { /* crash-torn row: ignore and compact it under the next lock */ }
  }
  return rows;
}

export function activeReservationTotal(rows) {
  return rows.reduce((sum, row) => sum + Number(row.cost_usd), 0);
}

// A syntactically valid but schema-invalid row is just as unsafe as torn JSON:
// treating it as $0 could erase an in-flight reservation. Current ledgers must
// therefore be wholly valid before they are used as a source of truth.
function parseLedgerStrict(text) {
  if (typeof text !== 'string') return { ok: false, rows: [] };
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || !Number.isFinite(Number(row.cost_usd)) || Number(row.cost_usd) <= 0
        || !Number.isFinite(Date.parse(row.expires_at))) return { ok: false, rows: [] };
      rows.push(row);
    } catch { return { ok: false, rows: [] }; }
  }
  return { ok: true, rows };
}

function readLedger(path) {
  try {
    if (!existsSync(path)) return { exists: false, text: '', ok: true, rows: [] };
    const text = readFileSync(path, 'utf8');
    return { exists: true, text, ...parseLedgerStrict(text) };
  } catch { return { exists: true, text: '', ok: false, rows: [] }; }
}

function ledgerText(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function durableWrite(path, text) {
  writeFileSync(path, text, 'utf8');
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function fsyncParent(path) {
  // Best effort: unsupported directory fsync must not turn a valid local
  // atomic rename into an unlocked write. The file itself was already fsynced.
  try {
    const fd = openSync(dirname(path), 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* platform does not expose directory fsync */ }
}

function atomicReplace(path, text) {
  const temp = path + '.tmp';
  try {
    durableWrite(temp, text);
    renameSync(temp, path);
    fsyncParent(path);
    return true;
  } catch {
    try { unlinkSync(temp); } catch { /* stale temp is cleaned under next lock */ }
    return false;
  }
}

function cleanupTemps(filePath) {
  for (const path of [filePath + '.tmp', filePath + '.bak.tmp', filePath + '.pending.tmp']) {
    try { unlinkSync(path); } catch { /* absent is normal */ }
  }
}

/**
 * Recover only from a durable journal/snapshot. A corrupt current ledger with
 * neither is ambiguous and remains fail-closed; allowing it would make a torn
 * active reservation disappear from the cap calculation.
 */
function recoverLedger(filePath) {
  const current = readLedger(filePath);
  if (current.ok && current.exists) return current;
  // pending is written before the current replacement. Counting it after a
  // crash may conservatively reserve an Agent that never started, but never
  // loses an Agent that did start.
  for (const candidatePath of [filePath + '.pending', filePath + '.bak']) {
    const candidate = readLedger(candidatePath);
    if (!candidate.exists || !candidate.ok) continue;
    if (!atomicReplace(filePath, candidate.text)) return { exists: true, text: '', ok: false, rows: [] };
    return candidate;
  }
  if (current.ok) return current; // first ledger, no journal/snapshot yet
  return { exists: true, text: '', ok: false, rows: [] };
}

/**
 * Atomically evaluate `spent + active reservations + amount` and reserve on
 * success. Lock acquisition failure is deliberately fail-closed: dispatching
 * without the lock would allow concurrent processes to oversubscribe the cap.
 */
export function checkAndReserve({ filePath, rootDir, cap, spent = 0, amount, ttl_ms, now = Date.now(), reservation_id, onStage } = {}) {
  const budget = numeric(cap, NaN);
  const current = Math.max(0, numeric(spent, 0));
  const requested = numeric(amount, NaN);
  const ttl = numeric(ttl_ms, DEFAULT_RESERVATION_TTL_MS);
  if (!filePath || !Number.isFinite(budget) || budget <= 0 || !Number.isFinite(requested) || requested <= 0 || !Number.isFinite(ttl) || ttl <= 0) {
    return { ok: false, reason: 'invalid_reservation_input' };
  }

  if (!safeLedgerPaths(filePath, rootDir)) return { ok: false, reason: 'unsafe_ledger_path' };
  const release = acquireLock(filePath + '.lock', now);
  if (!release) return { ok: false, reason: 'lock_unavailable' };
  try {
    cleanupTemps(filePath);
    const ledger = recoverLedger(filePath);
    if (!ledger.ok) return { ok: false, reason: 'ledger_corrupt' };
    const active = ledger.rows.filter((row) => isActiveReservation(row, now));
    const reserved = activeReservationTotal(active);
    const projected = current + reserved + requested;
    if (projected > budget) {
      // Compaction is journaled too. A crash cannot turn a stale cleanup into
      // lost active rows and then permit spend above the cap.
      const compacted = ledgerText(active);
      if (!atomicReplace(filePath + '.pending', compacted) || !atomicReplace(filePath, compacted) || !atomicReplace(filePath + '.bak', compacted)) {
        return { ok: false, reason: 'ledger_write_failed' };
      }
      try { unlinkSync(filePath + '.pending'); fsyncParent(filePath); } catch { /* conservative pending recovery is safe */ }
      return { ok: false, reason: 'cap_exceeded', spent: current, reserved, requested, projected, cap: budget };
    }
    const row = {
      reservation_id: reservation_id || randomUUID(),
      cost_usd: requested,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl).toISOString(),
    };
    const next = ledgerText(active.concat(row));
    // Journal first, then atomically install the ledger and matching snapshot.
    // The journal survives a crash between stages; recovery counts it rather
    // than silently allowing an extra dispatch.
    if (!atomicReplace(filePath + '.pending', next)) return { ok: false, reason: 'journal_write_failed' };
    onStage?.('pending'); // test-only crash injection; production never passes it
    if (!atomicReplace(filePath, next) || !atomicReplace(filePath + '.bak', next)) return { ok: false, reason: 'ledger_write_failed' };
    try { unlinkSync(filePath + '.pending'); fsyncParent(filePath); } catch { /* pending is safe recovery state */ }
    return { ok: true, reservation: row, spent: current, reserved, projected, cap: budget };
  } finally {
    release();
  }
}
