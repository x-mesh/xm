#!/usr/bin/env node
/**
 * sync-status.mjs — Show x-sync configuration and last sync state
 * Usage: node sync-status.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { readSyncConfig } from './sync-config.mjs';

const SYNC_CONFIG_PATH = join(homedir(), '.xm', 'sync.json');
const SERVER_PID_PATH = '/tmp/x-sync-server.pid';

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

function readSyncState() {
  const xmDir = resolveXmDir();
  const statePath = join(xmDir, '.sync-state.json');
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function isServerRunning() {
  if (!existsSync(SERVER_PID_PATH)) return null;
  try {
    const pid = parseInt(readFileSync(SERVER_PID_PATH, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

async function checkServerHealth(url) {
  try {
    const res = await fetch(`${url}/dashboard/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  const config = readSyncConfig();
  const configured = !!(config.server_url && config.api_key);
  const state = readSyncState();
  const localPid = isServerRunning();

  const lastPull = state?.last_pull_at || state?.lastPullAt || null;
  const apiKeyDisplay = config.api_key ? '****configured****' : 'Not set';

  let serverLine = 'Not running locally';
  if (localPid) {
    serverLine = `Running (PID: ${localPid})`;
  }

  let remoteHealth = null;
  if (configured) {
    remoteHealth = await checkServerHealth(config.server_url);
  }

  console.log('x-sync Status');
  console.log('');
  console.log(`  Config:     ${SYNC_CONFIG_PATH}`);
  console.log(`  Server URL: ${config.server_url || '(not set)'}`);
  console.log(`  Machine ID: ${config.machine_id || '(not set)'}`);
  console.log(`  API Key:    ${apiKeyDisplay}`);
  console.log('');
  console.log(`  Last Pull:  ${lastPull || 'Never'}`);
  console.log(`  Server:     ${serverLine}`);
  if (remoteHealth !== null) {
    console.log(`  Remote:     ${remoteHealth ? '✅ Healthy' : '❌ Unreachable'}`);
  }
  console.log('');
  console.log('  Quick commands:');
  console.log('    xm sync setup          Configure sync credentials');
  console.log('    xm sync server start   Start local server');
  console.log('    xm sync push           Push .xm/ to server');
  console.log('    xm sync pull           Pull from server');

  if (!configured) {
    console.log('');
    console.log('⚠ Sync not configured. Run: xm sync setup');
  }
}

main().catch((err) => {
  console.error(`[x-sync status] ${err.message}`);
  process.exit(1);
});
