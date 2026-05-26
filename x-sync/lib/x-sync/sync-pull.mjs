#!/usr/bin/env node
/**
 * sync-pull.mjs — Pull .xm/ data from x-sync server
 * Usage: node sync-pull.mjs [--project PROJECT_ID] [--since TIMESTAMP]
 *
 * Multi-user merge strategy:
 *   - Unique-path files (traces, op, probe): overwrite (no conflict possible)
 *   - Shared-path files (manifest.json etc): machine-namespaced on pull
 *     e.g. manifest.json → manifest.{machine_id}.json
 *   - config.json: excluded from sync (per-machine local preference)
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename, extname, relative, isAbsolute } from 'node:path';
import { execSync } from 'node:child_process';
import { readSyncConfig } from './sync-config.mjs';

// Files excluded from sync (per-machine local settings)
const SYNC_EXCLUDE = new Set(['config.json']);

// Resolve `rel` under `base` and confirm the result stays inside `base`.
// Guards against a malicious/compromised server returning paths like "../../.ssh/authorized_keys".
function safeResolve(base, rel) {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  const target = resolve(base, rel);
  const r = relative(base, target);
  if (r === '' || r.startsWith('..') || isAbsolute(r)) return null;
  return target;
}

// Convert path to machine-namespaced: "dir/file.json" → "dir/file.{machineId}.json"
function namespacePath(filePath, machineId) {
  const ext = extname(filePath);
  if (ext) {
    return filePath.slice(0, -ext.length) + '.' + machineId + ext;
  }
  return filePath + '.' + machineId;
}

// Resolve .xm/ (same as sync-push)
function resolveXmDir() {
  const local = resolve(process.cwd(), '.xm');
  if (existsSync(local)) return local;
  try {
    const commonDir = execSync('git rev-parse --git-common-dir', {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const mainXm = resolve(process.cwd(), commonDir, '..', '.xm');
    if (existsSync(mainXm)) return mainXm;
  } catch {}
  return local;
}

// Read last pull cursor (monotonic server id) from .xm/.sync-state.json
function readPullCursor(xmDir) {
  const statePath = join(xmDir, '.sync-state.json');
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return state.last_pull_cursor ?? 0;
  } catch {
    return 0;
  }
}

// Save last pull state (merge so we don't wipe last_push or other keys)
function saveLastPull(xmDir, serverTime, projectId, fileCount, cursor) {
  const statePath = join(xmDir, '.sync-state.json');
  let state = {};
  try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  state.last_pull = serverTime;
  state.last_pull_at = Date.now();
  state.last_pull_project = projectId;
  state.last_pull_files = fileCount;
  if (cursor != null) state.last_pull_cursor = cursor;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state) + '\n', 'utf8');
}

async function main() {
  const config = readSyncConfig();
  if (!config.server_url || !config.api_key) {
    console.error('x-sync not configured. Run: x-sync setup  (or edit ~/.xm/sync.json)');
    process.exit(1);
  }

  const xmDir = resolveXmDir();
  const projectId = process.argv.includes('--project')
    ? process.argv[process.argv.indexOf('--project') + 1]
    : basename(resolve(xmDir, '..'));

  // Pull mode: --since (legacy timestamp) takes precedence; otherwise cursor-based.
  const useSince = process.argv.includes('--since');
  const since = useSince ? parseInt(process.argv[process.argv.indexOf('--since') + 1], 10) : 0;
  const cursor = useSince ? 0 : readPullCursor(xmDir);

  const params = new URLSearchParams({ project_id: projectId });
  if (useSince) params.set('since', String(since));
  else params.set('cursor', String(cursor));

  console.log(`[x-sync pull] project=${projectId} ${useSince ? `since=${since ? new Date(since).toISOString() : 'all'}` : `cursor=${cursor}`}`);

  try {
    const url = `${config.server_url}/sync/pull?${params.toString()}`;
    const res = await fetch(url, {
      headers: { 'X-Api-Key': config.api_key },
    });

    if (!res.ok) {
      console.error(`[x-sync pull] Server error ${res.status}`);
      process.exit(1);
    }

    const data = await res.json();
    const files = data.files ?? [];

    if (files.length === 0) {
      console.log('[x-sync pull] Already up to date.');
    } else {
      // Split into live writes and tombstones; group live files by path to detect
      // shared paths (multiple machines → same path).
      const byPath = new Map();
      const tombstones = [];
      for (const f of files) {
        if (f.machine_id === config.machine_id) continue; // skip own
        if (SYNC_EXCLUDE.has(f.path) || SYNC_EXCLUDE.has(basename(f.path))) continue; // skip excluded
        if (f.deleted) { tombstones.push(f); continue; }
        if (!byPath.has(f.path)) byPath.set(f.path, []);
        byPath.get(f.path).push(f);
      }

      let written = 0;
      let namespaced = 0;
      let removed = 0; // tombstoned remote copies deleted locally
      let rejected = 0; // server-supplied paths that escape xmDir
      const skippedOwn = files.filter(f => f.machine_id === config.machine_id).length;
      const skippedExcluded = files.filter(f =>
        f.machine_id !== config.machine_id &&
        (SYNC_EXCLUDE.has(f.path) || SYNC_EXCLUDE.has(basename(f.path)))
      ).length;

      const writeSafe = (relPath, content) => {
        const targetPath = safeResolve(xmDir, relPath);
        if (!targetPath) {
          rejected++;
          console.error(`[x-sync pull] REJECT traversal path=${relPath}`);
          return false;
        }
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, content, 'utf8');
        return true;
      };

      // Deletion propagation: only remove the machine-namespaced copy we wrote on a
      // prior pull. Never touch a non-namespaced path — it may be a local file.
      for (const f of tombstones) {
        const nsPath = safeResolve(xmDir, namespacePath(f.path, f.machine_id));
        if (nsPath && existsSync(nsPath)) {
          try { rmSync(nsPath, { force: true }); removed++; }
          catch (err) { console.error(`[x-sync pull] unlink failed path=${nsPath}: ${err.message}`); }
        }
      }

      for (const [path, versions] of byPath) {
        const safeLocal = safeResolve(xmDir, path);
        const localExists = safeLocal ? existsSync(safeLocal) : false;
        const needsNamespace = versions.length > 1 || localExists;

        if (!needsNamespace) {
          // Single remote, no local file — write directly
          const f = versions[0];
          if (writeSafe(f.path, f.content)) written++;
        } else {
          // Multiple machines or local exists — namespace by machine_id
          for (const f of versions) {
            if (writeSafe(namespacePath(f.path, f.machine_id), f.content)) {
              written++;
              namespaced++;
            }
          }
        }
      }

      const parts = [`${written} files written`];
      if (namespaced > 0) parts.push(`${namespaced} namespaced`);
      if (removed > 0) parts.push(`${removed} removed`);
      if (skippedOwn > 0) parts.push(`${skippedOwn} skipped (own machine)`);
      if (skippedExcluded > 0) parts.push(`${skippedExcluded} excluded`);
      if (rejected > 0) parts.push(`${rejected} rejected (unsafe path)`);
      console.log(`[x-sync pull] ${parts.join(', ')}`);
    }

    // Advance cursor/server_time for next pull
    if (data.server_time || data.cursor != null) {
      saveLastPull(xmDir, data.server_time, projectId, files.length, data.cursor);
    }
  } catch (err) {
    console.error(`[x-sync pull] Failed: ${err.message}`);
    process.exit(1);
  }
}

main();
