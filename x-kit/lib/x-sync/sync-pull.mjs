#!/usr/bin/env node
/**
 * sync-pull.mjs — Pull .xm/ data from x-sync server
 * Usage: node sync-pull.mjs [--project PROJECT_ID] [--since TIMESTAMP]
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { readSyncConfig } from './sync-config.mjs';

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

// Read last pull timestamp from .xm/.sync-state.json
function readLastPull(xmDir) {
  const statePath = join(xmDir, '.sync-state.json');
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    return state.last_pull ?? 0;
  } catch {
    return 0;
  }
}

// Save last pull timestamp
function saveLastPull(xmDir, serverTime) {
  const statePath = join(xmDir, '.sync-state.json');
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ last_pull: serverTime }) + '\n', 'utf8');
}

async function main() {
  const config = readSyncConfig();
  if (!config.server_url || !config.api_key) {
    console.error('x-sync not configured. Edit ~/.xm/sync.json');
    process.exit(1);
  }

  const xmDir = resolveXmDir();
  const projectId = process.argv.includes('--project')
    ? process.argv[process.argv.indexOf('--project') + 1]
    : basename(resolve(xmDir, '..'));

  // Since: CLI flag > last pull state > 0
  let since = 0;
  if (process.argv.includes('--since')) {
    since = parseInt(process.argv[process.argv.indexOf('--since') + 1], 10);
  } else {
    since = readLastPull(xmDir);
  }

  console.log(`[x-sync pull] project=${projectId} since=${since ? new Date(since).toISOString() : 'all'}`);

  try {
    const url = `${config.server_url}/sync/pull?project_id=${encodeURIComponent(projectId)}&since=${since}`;
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
      let written = 0;
      for (const f of files) {
        // Skip own machine's data (already local)
        if (f.machine_id === config.machine_id) continue;

        const targetPath = join(xmDir, f.path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, f.content, 'utf8');
        written++;
      }
      console.log(`[x-sync pull] ${written} files written (${files.length - written} skipped — own machine)`);
    }

    // Save server_time for next pull
    if (data.server_time) {
      saveLastPull(xmDir, data.server_time);
    }
  } catch (err) {
    console.error(`[x-sync pull] Failed: ${err.message}`);
    process.exit(1);
  }
}

main();
