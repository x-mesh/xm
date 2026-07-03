/**
 * last-store.mjs — Deterministic per-tool "last activity" pointer map for xm.
 *
 * Maintains `.xm/last.json`:
 *   { tools: { <tool>: { ref, head, base, ts, status, note, artifact_ref,
 *                        session_id?, chain_broken? } } }
 *
 *   - ref          the commit/subject the tool acted on (e.g. reviewed sha)
 *   - head         HEAD at record time
 *   - base         the SAME tool's previous head (auto-chained here)
 *   - chain_broken set true only when `base` is provably unreachable in the
 *                  current repo (rebase / force-push). Omitted when we cannot
 *                  determine reachability (no git / no HEAD) — best-effort (FM6).
 *
 * Concurrency: parallel writers (dispatcher tail + CLI record) may race. The
 * lock leaf below adapts the logic of modifyJSON (x-build/lib/x-build/core.mjs
 * :170-201) — acquire-first, reclaim stale mtime>10s, fail loud after 50 tries.
 * It is REIMPLEMENTED here, NOT imported: cross-plugin relative imports break in
 * the marketplace cache layout (bug_xmemory_cache_import_crash 동형). Only the
 * sibling ./trace-writer.mjs (same plugin dir) is imported, which is safe.
 *
 * Zero-dependency: node builtins only.
 *
 * NOTE: `.xm/last.json` is unrelated to `.xm/<project>/checkpoints/` — the
 * latter are x-build phase-gate markers (manual approval), a different concern.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveXmDir } from './trace-writer.mjs';

/** Absolute path to `.xm/last.json` — same location rule as resolveTraceDir, but at .xm/ root. */
function lastPath() {
  return join(resolveXmDir(), 'last.json');
}

/**
 * Serialize a read-modify-write with a lock file. ~30 lines, adapted from
 * modifyJSON (see header). Acquires the lock FIRST, reclaims a stale lock left
 * by a crashed writer (mtime > 10s), and fails loud after 50 attempts rather
 * than silently writing unlocked (L6).
 */
function withLock(path, fn) {
  const lockPath = path + '.lock';
  let acquired = false;
  for (let attempt = 0; attempt < 50 && !acquired; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      acquired = true;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e; // unexpected fs error — surface it
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10000) { unlinkSync(lockPath); continue; }
      } catch { continue; /* lock vanished between stat and now — retry immediately */ }
      const deadline = Date.now() + 20;
      while (Date.now() < deadline) { /* brief spin, then retry */ }
    }
  }
  if (!acquired) {
    process.stderr.write(`[x-trace] last-store: lock contention on ${path} — could not acquire ${lockPath} after 50 attempts.\n`);
    process.stderr.write(`          If a process crashed, remove the stale lock: rm ${JSON.stringify(lockPath)}\n`);
    throw new Error(`last-store: could not acquire lock for ${path}`);
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* best-effort */ }
  }
}

/** Atomic write via tmp + rename, so readers never observe a partial file (lastRead needs no lock). */
function writeAtomic(path, content) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

/** Preserve a corrupt last.json as `.bak` before recreating it (FM2). */
function backupCorrupt(path, raw) {
  try {
    writeFileSync(path + '.bak', raw);
    process.stderr.write(`[x-trace] last.json was corrupt — preserved as ${path}.bak, starting fresh.\n`);
  } catch { /* best-effort — never block the write */ }
}

/** True if `data` is a well-formed store ({ tools: {...} }). */
function isValidStore(data) {
  return data && typeof data === 'object' && data.tools && typeof data.tools === 'object';
}

/**
 * Decide chain_broken for a previous head `base` relative to the current repo.
 * Returns:
 *   true  — base is provably NOT reachable from HEAD (rebase/force-push, or the
 *           object no longer exists in this repo)
 *   false — base is an ancestor of (or equal to) HEAD — chain intact
 *   null  — cannot determine (no git / no HEAD) → caller omits the flag (FM6)
 */
function chainBroken(cwd, base) {
  const run = (args) => {
    try {
      return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  // First confirm this is a usable repo with a HEAD — otherwise we can't judge.
  const headCheck = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!headCheck || headCheck.error || headCheck.status !== 0) return null;
  const res = run(['merge-base', '--is-ancestor', base, 'HEAD']);
  if (!res || res.error) return null;
  if (res.status === 0) return false; // base is ancestor/equal → intact
  if (res.status === 1) return true;  // valid answer: not an ancestor → broken
  if (res.status === 128) return true; // base object absent in this repo → broken
  return null; // unknown status → omit the flag
}

/**
 * Read `.xm/last.json`. On a missing file returns an empty store. On a corrupt
 * (non-JSON / wrong shape) file, warns and returns an empty store — never throws
 * (FM2). Lock-free: lastWrite uses atomic rename so a read sees a whole file.
 * @returns {{ tools: Record<string, object> }}
 */
export function lastRead() {
  const path = lastPath();
  if (!existsSync(path)) return { tools: {} };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { tools: {} };
  }
  if (!raw.trim()) return { tools: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    process.stderr.write(`[x-trace] last.json is not valid JSON — treating as empty. Run 'xm trace doctor --rebuild' to reconstruct.\n`);
    return { tools: {} };
  }
  if (!isValidStore(parsed)) {
    process.stderr.write(`[x-trace] last.json is malformed (no tools map) — treating as empty. Run 'xm trace doctor --rebuild' to reconstruct.\n`);
    return { tools: {} };
  }
  return parsed;
}

/**
 * Record the latest activity pointer for `tool`, chaining `base` to the tool's
 * previous head. Lock-protected against concurrent writers; corrupt files are
 * backed up to `.bak` and recreated (FM2).
 *
 * @param {string} tool
 * @param {{ ref?: string, head?: string, ts?: string, status?: string,
 *           note?: string, artifact_ref?: string, session_id?: string }} entry
 * @returns {object} the stored record for `tool`
 */
export function lastWrite(tool, entry = {}) {
  if (!tool || typeof tool !== 'string') throw new Error('lastWrite: tool must be a non-empty string');
  const path = lastPath();
  mkdirSync(dirname(path), { recursive: true });

  return withLock(path, () => {
    // Read current store inside the lock; preserve corrupt content to .bak.
    let data = { tools: {} };
    if (existsSync(path)) {
      let raw = '';
      try { raw = readFileSync(path, 'utf8'); } catch { raw = ''; }
      if (raw.trim()) {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
        if (isValidStore(parsed)) {
          data = parsed;
        } else {
          backupCorrupt(path, raw);
        }
      }
    }
    if (!data.tools || typeof data.tools !== 'object') data.tools = {};

    const prev = data.tools[tool];
    const base = prev && prev.head ? prev.head : null;

    const record = {
      ref: entry.ref ?? null,
      head: entry.head ?? null,
      base,
      ts: entry.ts || new Date().toISOString(),
      status: entry.status ?? null,
      note: entry.note ?? null,
      artifact_ref: entry.artifact_ref ?? null,
    };
    if (entry.session_id) record.session_id = entry.session_id;

    // FM6: flag a broken chain only when we can prove `base` is unreachable.
    if (base) {
      const broken = chainBroken(process.cwd(), base);
      if (broken === true) record.chain_broken = true;
    }

    data.tools[tool] = record;
    writeAtomic(path, JSON.stringify(data, null, 2) + '\n');
    return record;
  });
}
