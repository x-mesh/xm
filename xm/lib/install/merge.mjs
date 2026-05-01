// @ts-check
/**
 * merge.mjs — marker-based file merge with lock + .bak rotation + symlink abort.
 * Implements PRD §5.3 (multi-writer protocol), R-SEC-05/14, ADR-003.
 *
 * Two write modes:
 *   1) overwrite      — full file replacement (per-skill .mdc / steering / prompts).
 *   2) merge-marker   — insert/replace `<!-- xm:BEGIN v2 --> ... <!-- xm:END -->` block,
 *                       preserve everything outside. Used for AGENTS.md / GEMINI.md.
 *
 * Locking:
 *   - Lock path: `<file>.lock`.
 *   - Created via fs.openSync(path, 'wx') (O_EXCL atomic).
 *   - Payload: { pid, timestamp, hostname }.
 *   - Stale (> 60s) locks are taken over after re-checking.
 *
 * Backups:
 *   - First write rotates existing `<file>` to `<file>.bak`, .bak.1, .bak.2 (max 3).
 *   - Symlink targets are NEVER backed up — function aborts.
 */

import {
  openSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  closeSync, existsSync, statSync, mkdirSync, chmodSync, lstatSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  MARKER_BEGIN, MARKER_END, LOCK_TTL_MS, MAX_BAK_ROTATION,
} from './types.mjs';
import { isSymlink, lockPayload, isStaleLock } from './security.mjs';

/**
 * @typedef {Object} MergeResult
 * @property {string} path
 * @property {'created'|'updated'|'unchanged'|'rotated-and-updated'} action
 * @property {boolean} backupTaken
 */

/**
 * Acquire an atomic lock on `<filePath>.lock`.
 * Returns a release function. Throws if a fresh lock exists.
 *
 * Stale-lock policy:
 *   - If existing lock is older than LOCK_TTL_MS, replace it.
 *   - If lock is fresh, throw.
 *
 * @param {string} filePath
 * @param {{ now?: number, ttlMs?: number }} [opts]
 * @returns {() => void}  release function
 */
export function acquireLock(filePath, opts = {}) {
  const lockPath = filePath + '.lock';
  const ttl = opts.ttlMs ?? LOCK_TTL_MS;
  const now = opts.now ?? Date.now();

  // Ensure parent dir exists before any lock-file open. Lock co-locates
  // with the target file path; if the target's parent doesn't exist yet
  // (first install of a fresh tool), create it.
  mkdirSync(dirname(lockPath), { recursive: true });

  if (existsSync(lockPath)) {
    /** @type {{ pid?: number, timestamp?: number, hostname?: string } | null} */
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    } catch { parsed = null; }
    if (!isStaleLock(parsed, ttl, now)) {
      throw new Error(
        `lock held: ${lockPath} pid=${parsed?.pid} age=${now - (parsed?.timestamp ?? 0)}ms (TTL=${ttl}ms)`
      );
    }
    // Stale: remove and proceed.
    try { unlinkSync(lockPath); } catch { /* race-OK */ }
  }

  // O_EXCL atomic create. If another writer races between unlink and openSync,
  // 'wx' fails with EEXIST and we surface that.
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    if (e.code === 'EEXIST') {
      throw new Error(`lock contention: ${lockPath}`);
    }
    throw err;
  }
  const payload = lockPayload({ now });
  writeFileSync(fd, JSON.stringify(payload));
  closeSync(fd);

  return function release() {
    try { unlinkSync(lockPath); } catch { /* file may already be gone */ }
  };
}

/**
 * Rotate `<file>`, `<file>.bak`, `<file>.bak.1`, `<file>.bak.2` chain.
 * Drops anything beyond MAX_BAK_ROTATION.
 *
 * @param {string} filePath
 * @returns {boolean}  true if a backup was created (file existed and was rotated)
 */
export function rotateBackup(filePath) {
  if (!existsSync(filePath)) return false;
  if (isSymlink(filePath)) {
    throw new Error(`refusing to back up symlink: ${filePath} (R-SEC-05)`);
  }
  // Rotate from oldest to newest:
  //   .bak.{MAX-1} → drop
  //   .bak.{i}     → .bak.{i+1}
  //   .bak         → .bak.1
  //   <file>       → .bak
  const oldest = `${filePath}.bak.${MAX_BAK_ROTATION - 1}`;
  if (existsSync(oldest)) {
    try { unlinkSync(oldest); } catch { /* ignore */ }
  }
  for (let i = MAX_BAK_ROTATION - 2; i >= 1; i--) {
    const src = `${filePath}.bak.${i}`;
    const dst = `${filePath}.bak.${i + 1}`;
    if (existsSync(src)) renameSync(src, dst);
  }
  if (existsSync(`${filePath}.bak`)) {
    renameSync(`${filePath}.bak`, `${filePath}.bak.1`);
  }
  renameSync(filePath, `${filePath}.bak`);
  return true;
}

/**
 * Atomically write `content` to `filePath` (tmp + rename).
 * Caller is responsible for symlink check and backup; this is the raw writer.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {{ mode?: number, mkdir?: boolean }} [opts]
 */
export function atomicWrite(filePath, content, opts = {}) {
  if (opts.mkdir !== false) mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  if (opts.mode !== undefined) chmodSync(tmp, opts.mode);
  renameSync(tmp, filePath);
}

/**
 * Overwrite a file. Backs up existing content (rotation). Refuses symlink.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {{ mode?: number }} [opts]
 * @returns {MergeResult}
 */
export function writeOverwrite(filePath, content, opts = {}) {
  if (existsSync(filePath) && isSymlink(filePath)) {
    throw new Error(`refusing to overwrite symlink: ${filePath} (R-SEC-05)`);
  }
  if (existsSync(filePath)) {
    const before = readFileSync(filePath, 'utf8');
    if (before === content) {
      // H3 (logic review): content is identical, but the on-disk mode may
      // differ from the renderer's expectation (e.g. cross-scope reinstall:
      // 0o644 → 0o600). Re-chmod when needed so global installs do not leak
      // a world-readable file (R-SEC-08).
      if (opts.mode !== undefined) {
        try {
          const currentMode = lstatSync(filePath).mode & 0o777;
          if (currentMode !== opts.mode) chmodSync(filePath, opts.mode);
        } catch { /* race or perms: surface via --verify, not here */ }
      }
      return { path: filePath, action: 'unchanged', backupTaken: false };
    }
  }
  const release = acquireLock(filePath);
  try {
    // Re-check symlink under lock to close TOCTOU window (R-SEC-05).
    if (existsSync(filePath) && isSymlink(filePath)) {
      throw new Error(`refusing to overwrite symlink (post-lock): ${filePath} (R-SEC-05)`);
    }
    const backup = rotateBackup(filePath);
    atomicWrite(filePath, content, opts);
    return {
      path: filePath,
      action: backup ? 'rotated-and-updated' : 'created',
      backupTaken: backup,
    };
  } finally {
    release();
  }
}

/**
 * Insert or replace the xm marker block in an existing or new file.
 *
 * @param {string} filePath
 * @param {string} blockContent  Body inside markers (markers themselves added by this fn).
 * @param {{ mode?: number, maxBlockBytes?: number }} [opts]
 * @returns {MergeResult}
 */
export function writeMergeMarker(filePath, blockContent, opts = {}) {
  if (existsSync(filePath) && isSymlink(filePath)) {
    throw new Error(`refusing to overwrite symlink: ${filePath} (R-SEC-05)`);
  }
  const block = `${MARKER_BEGIN}\n${blockContent.trimEnd()}\n${MARKER_END}\n`;
  if (opts.maxBlockBytes !== undefined && Buffer.byteLength(block, 'utf8') > opts.maxBlockBytes) {
    throw new Error(
      `merge-marker block exceeds ${opts.maxBlockBytes} bytes ` +
      `(${Buffer.byteLength(block, 'utf8')}); split the content`
    );
  }

  const release = acquireLock(filePath);
  try {
    // Read file under lock to close TOCTOU window (R-SEC-05).
    let nextContent;
    let pre = '';
    let post = '';
    let hadBlock = false;
    const existedBefore = existsSync(filePath);
    if (existedBefore) {
      const before = readFileSync(filePath, 'utf8');
      const begin = before.indexOf(MARKER_BEGIN);
      const end = before.indexOf(MARKER_END);
      if (begin !== -1 && end !== -1 && begin < end) {
        hadBlock = true;
        pre = before.slice(0, begin);
        post = before.slice(end + MARKER_END.length);
        // Drop the linefeed immediately after END if present, to avoid double blank lines.
        if (post.startsWith('\n')) post = post.slice(1);
      } else if (begin !== -1 || end !== -1) {
        throw new Error(
          `marker mismatch in ${filePath}: BEGIN at ${begin}, END at ${end}. Manual repair required.`
        );
      } else {
        // No prior block — append at end.
        pre = before.endsWith('\n') ? before : `${before}\n`;
      }
      nextContent = `${pre}${block}${post}`;
      if (nextContent === before) {
        return { path: filePath, action: 'unchanged', backupTaken: false };
      }
    } else {
      nextContent = block;
    }
    let backup = false;
    if (existedBefore) {
      backup = rotateBackup(filePath);
    }
    atomicWrite(filePath, nextContent, opts);
    /** @type {MergeResult['action']} */
    let action;
    if (!existedBefore) action = 'created';
    else if (hadBlock) action = 'updated';
    else if (backup) action = 'rotated-and-updated';
    else action = 'updated';
    return { path: filePath, action, backupTaken: backup };
  } finally {
    release();
  }
}

/**
 * Remove the xm marker block from a file. Used by `xm uninstall`.
 * If the file becomes empty after removal, it is deleted.
 *
 * @param {string} filePath
 * @returns {MergeResult & { removed?: boolean }}
 */
export function removeMarkerBlock(filePath) {
  if (!existsSync(filePath)) return { path: filePath, action: 'unchanged', backupTaken: false };
  if (isSymlink(filePath)) {
    throw new Error(`refusing to mutate symlink: ${filePath} (R-SEC-05)`);
  }
  const before = readFileSync(filePath, 'utf8');
  const begin = before.indexOf(MARKER_BEGIN);
  const end = before.indexOf(MARKER_END);
  if (begin === -1 || end === -1) {
    return { path: filePath, action: 'unchanged', backupTaken: false };
  }
  if (begin >= end) {
    throw new Error(`marker mismatch in ${filePath}: BEGIN at ${begin}, END at ${end}.`);
  }
  let next = before.slice(0, begin) + before.slice(end + MARKER_END.length);
  if (next.startsWith('\n')) next = next.slice(1);
  next = next.trimStart();
  const release = acquireLock(filePath);
  try {
    rotateBackup(filePath);
    if (next.trim().length === 0) {
      try { unlinkSync(filePath); } catch { /* already gone */ }
      return { path: filePath, action: 'updated', backupTaken: true, removed: true };
    }
    atomicWrite(filePath, next);
    return { path: filePath, action: 'updated', backupTaken: true };
  } finally {
    release();
  }
}
