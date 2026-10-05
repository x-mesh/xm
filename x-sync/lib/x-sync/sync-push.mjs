#!/usr/bin/env node
/**
 * sync-push.mjs — Push .xm/ data to x-sync server
 * Usage: node sync-push.mjs [--project PROJECT_ID]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { readSyncConfig } from './sync-config.mjs';
import { isExcludedHandoffPath } from './sync-handoff.mjs';
import { contentHash, importedFiles, isSyncablePath, readSyncState, safePath, saveSyncState, withSyncLock } from './sync-storage.mjs';

// Resolve .xm/ directory (worktree-aware — same logic as shared-config.mjs)
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

// Recursively scan .xm/ for syncable files
// Include: traces, plans, build projects, and canonical handoff files.
// Exclude: per-machine config/mirror state, legacy namespaced handoffs, run/, *.tmp.
// `repro/` holds raw captured command output from x-solver — arbitrary stdout that can
// carry tokens, hostnames, or customer data. It stays on the machine that produced it.
function scanXmFiles(xmDir, state) {
  const files = [];
  const imports = importedFiles(state);

  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isSyncablePath(relPath) || isExcludedHandoffPath(relPath)) continue;

      if (entry.isDirectory()) {
        if (existsSync(join(fullPath, '.git'))) continue;
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        const content = readFileSync(safePath(xmDir, relPath), 'utf8');
        const hash = contentHash(content);
        if (imports.some(copy => copy.target === relPath && (copy.pending || copy.target !== copy.path || copy.hash === hash))) continue;
        files.push({ path: relPath, content, hash });
      }
    }
  }

  walk(xmDir, '');
  return files;
}

// Main
async function main() {
  const config = readSyncConfig();
  if (!config.server_url || !config.api_key) {
    throw new Error('x-sync not configured. Run: x-sync setup');
  }

  const xmDir = resolveXmDir();
  if (!existsSync(xmDir)) {
    throw new Error('No .xm/ directory found.');
  }

  const projectId = process.argv.includes('--project')
    ? process.argv[process.argv.indexOf('--project') + 1]
    : basename(resolve(xmDir, '..'));

  await withSyncLock(xmDir, async () => {
    const state = readSyncState(xmDir);
    const files = scanXmFiles(xmDir, state);
    console.log(`[x-sync push] ${files.length} local files from ${projectId} (${config.machine_id})`);
    const res = await fetch(`${config.server_url.replace(/\/+$/, '')}/sync/push`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': config.api_key,
      },
      // full_snapshot: scanXmFiles always sends the complete .xm file set, so the
      // server can tombstone paths absent from this push (deletion propagation).
      body: JSON.stringify({ machine_id: config.machine_id, project_id: projectId, files, full_snapshot: true }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Server error ${res.status}: ${err}`);
    }

    const result = await res.json();
    const extra = [];
    if (result.deleted) extra.push(`${result.deleted} deleted`);
    if (result.rejected) extra.push(`${result.rejected} rejected`);
    if (Array.isArray(result.write_errors) && result.write_errors.length) extra.push(`${result.write_errors.length} write-errors`);
    if (result.repaired) extra.push(`${result.repaired} materialized`);
    console.log(`[x-sync push] accepted: ${result.accepted}, skipped: ${result.skipped}${extra.length ? ', ' + extra.join(', ') : ''}`);
    if (result.rejected || result.write_errors?.length) throw new Error('Server did not finish the snapshot; retry after resolving the reported errors');

    // Save last_push state (merge with existing state instead of overwriting last_pull)
    state.last_push = Date.now();
    state.last_push_project = projectId;
    state.last_push_accepted = result.accepted;
    state.last_push_skipped = result.skipped;
    state.last_push_total = files.length;
    saveSyncState(xmDir, state);
  });
}

main().catch(err => { console.error(`[x-sync push] Failed: ${err.message}`); process.exitCode = 1; });
