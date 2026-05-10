// @ts-check
/**
 * propagate-lock.mjs — process-scoped lock for propagate/install operations.
 *
 * Provides atomic file-based locking with:
 *   - O_EXCL creation (POSIX atomic)
 *   - Stale-lock takeover (expired TTL OR dead PID)
 *   - SIGINT/SIGTERM/exit cleanup
 *
 * SRP: this module owns ONLY the process-level lock lifecycle.
 * merge.mjs owns the file-merge lock (acquireLock there is file-scoped).
 *
 * API:
 *   acquireProcessLock(lockPath, options?) → { released: boolean, release: () => void }
 *   releaseProcessLock(lockPath)           → void
 */

import {
  openSync, writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync,
  closeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** Default TTL: 5 minutes */
const DEFAULT_TTL_MS = 300_000;

/**
 * @typedef {{ pid: number, timestamp: number, argv: string[] }} LockPayload
 */

/**
 * Check whether a PID is alive by sending signal 0.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine if an existing lock is stale.
 * Stale conditions (any one is sufficient):
 *   1. JSON parse failed (payload is null)
 *   2. timestamp + ttlMs < now  (expired)
 *   3. PID is not alive
 *
 * @param {LockPayload | null} payload
 * @param {number} ttlMs
 * @param {number} now
 * @returns {boolean}
 */
function isStale(payload, ttlMs, now) {
  if (payload === null) return true;
  if (payload.timestamp + ttlMs < now) return true;
  if (!isPidAlive(payload.pid)) return true;
  return false;
}

/**
 * Read and parse an existing lock file. Returns null on any error.
 * @param {string} lockPath
 * @returns {LockPayload | null}
 */
function readLockPayload(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Attempt O_EXCL creation of lockPath. Returns fd on success, throws on failure.
 * @param {string} lockPath
 * @returns {number} file descriptor
 */
function openExclusive(lockPath) {
  return openSync(lockPath, 'wx');
}

/**
 * Write payload JSON to an open fd and close it.
 * @param {number} fd
 * @param {LockPayload} payload
 */
function writeLockPayload(fd, payload) {
  writeFileSync(fd, JSON.stringify(payload));
  closeSync(fd);
}

/**
 * Release (unlink) the lock file. Safe to call if already gone.
 * @param {string} lockPath
 */
export function releaseProcessLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch {
    // File already gone — that's fine.
  }
}

/**
 * Acquire a process-scoped lock at `lockPath`.
 *
 * @param {string} lockPath
 * @param {{ ttlMs?: number, argv?: string[] }} [options]
 * @returns {{ released: boolean, release: () => void }}
 * @throws {Error} If a fresh, alive lock is held by another process.
 */
export function acquireProcessLock(lockPath, options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const argv = options.argv ?? [];
  const now = Date.now();

  // 1. Ensure parent directory exists (mode 0o700).
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  /** @type {LockPayload | null} */
  let existingPayload = null;

  // 2. Try O_EXCL create.
  let fd;
  try {
    fd = openExclusive(lockPath);
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code !== 'EEXIST') throw err;

    // Lock exists — check staleness.
    existingPayload = readLockPayload(lockPath);

    if (!isStale(existingPayload, ttlMs, now)) {
      throw new Error(
        `lock held: ${lockPath} (pid=${existingPayload?.pid})`
      );
    }

    // Stale — remove and retry once.
    try { unlinkSync(lockPath); } catch { /* race-OK */ }

    try {
      fd = openExclusive(lockPath);
    } catch (retryErr) {
      const re = /** @type {NodeJS.ErrnoException} */ (retryErr);
      if (re.code === 'EEXIST') {
        // Lost the race after stale removal — re-read for error message.
        const racePayload = readLockPayload(lockPath);
        throw new Error(
          `lock held: ${lockPath} (pid=${racePayload?.pid})`
        );
      }
      throw retryErr;
    }
  }

  // 3. Write payload.
  /** @type {LockPayload} */
  const payload = { pid: process.pid, timestamp: Date.now(), argv };
  writeLockPayload(fd, payload);

  // 4. Register cleanup handlers.
  let released = false;

  function release() {
    if (released) return;
    released = true;
    releaseProcessLock(lockPath);
  }

  // SIGINT/SIGTERM: release only (no process.exit — caller decides).
  process.once('SIGINT', release);
  process.once('SIGTERM', release);
  process.once('exit', release);

  return { released: true, release };
}
