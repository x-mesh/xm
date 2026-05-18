#!/usr/bin/env node
/**
 * sync-status.mjs — Show x-sync configuration and last sync state
 * Usage: node sync-status.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
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

function fmtTime(ms) {
  if (!ms) return null;
  try {
    return new Date(typeof ms === 'number' ? ms : Date.parse(ms)).toISOString();
  } catch { return String(ms); }
}

function resolveProjectId(xmDir) {
  return basename(resolve(xmDir, '..'));
}

async function main() {
  const config = readSyncConfig();
  const configured = !!(config.server_url && config.api_key);
  const state = readSyncState();
  const localPid = isServerRunning();

  const xmDir = resolveXmDir();
  const xmExists = existsSync(xmDir);
  const projectId = resolveProjectId(xmDir);

  // last_pull (server_time from pull response), last_pull_at (local clock when pull happened)
  const lastPullServer = fmtTime(state?.last_pull);
  const lastPullLocal = fmtTime(state?.last_pull_at || state?.lastPullAt);
  const lastPullProject = state?.last_pull_project;
  const lastPullFiles = state?.last_pull_files;

  const lastPush = fmtTime(state?.last_push);
  const lastPushProject = state?.last_push_project;
  const lastPushAccepted = state?.last_push_accepted;
  const lastPushSkipped = state?.last_push_skipped;
  const lastPushTotal = state?.last_push_total;

  const apiKeyDisplay = config.api_key ? '****configured****' : 'Not set';

  let remoteHealth = null;
  if (configured) {
    remoteHealth = await checkServerHealth(config.server_url);
  }

  // Server line: prefer remote status when configured; only mention local if running
  let serverLine;
  if (localPid) {
    serverLine = `Local PID ${localPid}` + (remoteHealth !== null ? ` (remote: ${remoteHealth ? 'healthy' : 'unreachable'})` : '');
  } else if (remoteHealth !== null) {
    serverLine = remoteHealth ? '✅ Remote healthy' : '❌ Remote unreachable';
  } else {
    serverLine = '(not configured)';
  }

  console.log('x-sync Status');
  console.log('');
  console.log(`  Config:        ${SYNC_CONFIG_PATH}`);
  console.log(`  Server URL:    ${config.server_url || '(not set)'}`);
  console.log(`  Machine ID:    ${config.machine_id || '(not set)'}`);
  console.log(`  API Key:       ${apiKeyDisplay}`);
  console.log('');
  console.log(`  cwd:           ${process.cwd()}`);
  console.log(`  .xm/ path:     ${xmDir}${xmExists ? '' : '  (does not exist)'}`);
  console.log(`  Project ID:    ${projectId}    (← used by next push/pull)`);
  console.log('');
  if (lastPullServer || lastPullLocal) {
    console.log(`  Last Pull:     ${lastPullLocal || '(unknown local time)'}`);
    console.log(`    server_time: ${lastPullServer || '(none)'}`);
    if (lastPullProject) console.log(`    project:     ${lastPullProject}${lastPullProject !== projectId ? '  ⚠ differs from current cwd project' : ''}`);
    if (lastPullFiles != null) console.log(`    files:       ${lastPullFiles}`);
  } else {
    console.log('  Last Pull:     Never');
  }
  if (lastPush) {
    console.log(`  Last Push:     ${lastPush}`);
    if (lastPushProject) console.log(`    project:     ${lastPushProject}${lastPushProject !== projectId ? '  ⚠ differs from current cwd project' : ''}`);
    if (lastPushTotal != null) console.log(`    files:       ${lastPushAccepted}/${lastPushTotal} accepted, ${lastPushSkipped} skipped`);
  } else {
    console.log('  Last Push:     Never');
  }
  console.log(`  Server:        ${serverLine}`);
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
