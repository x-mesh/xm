#!/usr/bin/env node
/**
 * sync-server.mjs — Manage local x-sync server lifecycle.
 * Usage:
 *   node sync-server.mjs start [--port N]
 *   node sync-server.mjs stop
 *   node sync-server.mjs status
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSyncConfig } from './sync-config.mjs';

const PID_PATH = '/tmp/x-sync-server.pid';
const LOG_PATH = '/tmp/x-sync-server.log';
const DEFAULT_PORT = 19842;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = resolve(__dirname, '..', 'x-sync-server.mjs');

function parseFlag(args, name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

function readPid() {
  if (!existsSync(PID_PATH)) return null;
  try {
    const pid = parseInt(readFileSync(PID_PATH, 'utf8').trim(), 10);
    if (Number.isFinite(pid)) return pid;
  } catch {}
  return null;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function checkHealth(port) {
  try {
    const res = await fetch(`http://localhost:${port}/dashboard/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function which(cmd) {
  try {
    return execSync(`command -v ${cmd}`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function start(args) {
  const existing = readPid();
  if (isAlive(existing)) {
    console.log(`⚠ Server already running (PID: ${existing})`);
    return;
  }
  if (existing) unlinkSync(PID_PATH);

  const port = parseFlag(args, '--port', String(DEFAULT_PORT));

  if (!existsSync(SERVER_SCRIPT)) {
    console.error(`❌ Server script not found: ${SERVER_SCRIPT}`);
    process.exit(1);
  }

  const runtime = which('bun') ? 'bun' : 'node';
  const config = readSyncConfig();
  const env = { ...process.env };
  if (config.api_key && !env.XM_SYNC_API_KEY) {
    env.XM_SYNC_API_KEY = config.api_key;
  }

  if (!env.XM_SYNC_API_KEY) {
    console.log('⚠️ XM_SYNC_API_KEY가 설정되지 않았습니다. 서버가 인증 없이 열립니다.');
  }

  const out = await import('node:fs').then((fs) => fs.openSync(LOG_PATH, 'a'));
  const child = spawn(runtime, [SERVER_SCRIPT, '--port', String(port)], {
    detached: true,
    stdio: ['ignore', out, out],
    env,
  });
  child.unref();

  writeFileSync(PID_PATH, String(child.pid), 'utf8');

  // Give it a moment to crash if it's going to
  await new Promise((r) => setTimeout(r, 800));
  if (!isAlive(child.pid)) {
    console.error(`❌ Server failed to start — see ${LOG_PATH}`);
    try {
      const tail = readFileSync(LOG_PATH, 'utf8').split('\n').slice(-15).join('\n');
      console.error(tail);
    } catch {}
    unlinkSync(PID_PATH);
    process.exit(1);
  }

  console.log(`✅ x-sync server started (PID: ${child.pid}, port: ${port})`);
  console.log(`   Log: ${LOG_PATH}`);
}

function stop() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    try {
      process.kill(pid);
      console.log(`✅ x-sync server stopped (PID: ${pid})`);
    } catch (err) {
      console.error(`❌ Failed to kill PID ${pid}: ${err.message}`);
    }
    try { unlinkSync(PID_PATH); } catch {}
    return;
  }

  if (existsSync(PID_PATH)) {
    unlinkSync(PID_PATH);
    console.log('⚠ Stale PID file removed.');
  }

  // Fallback: kill by port
  try {
    const pids = execSync(`lsof -ti:${DEFAULT_PORT}`, { encoding: 'utf8' }).trim();
    if (pids) {
      execSync(`kill ${pids}`);
      console.log(`✅ Killed process(es) on port ${DEFAULT_PORT}: ${pids}`);
      return;
    }
  } catch {}
  console.log(`ℹ No server running on port ${DEFAULT_PORT}`);
}

async function status() {
  const pid = readPid();
  if (pid && isAlive(pid)) {
    console.log(`✅ Server running (PID: ${pid})`);
    const health = await checkHealth(DEFAULT_PORT);
    if (health) {
      console.log(health);
    } else {
      console.log('⚠️ Health check failed');
    }
  } else {
    console.log('⚠ Server not running');
  }
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'start': await start(rest); break;
    case 'stop': stop(); break;
    case 'status': await status(); break;
    default:
      console.error('Usage: xm sync server start|stop|status [--port N]');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[x-sync server] ${err.message}`);
  process.exit(1);
});
