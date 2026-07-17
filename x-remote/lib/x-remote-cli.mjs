#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.XM_REMOTE_STATE_DIR || join(homedir(), '.xm', 'remote');
const hostConfig = join(stateDir, 'host.json');
const paths = {
  gatewayPid: join(stateDir, 'gateway.pid'), gatewayLog: join(stateDir, 'gateway.log'),
  hostPid: join(stateDir, 'host.pid'), hostLog: join(stateDir, 'host.log'),
};
mkdirSync(stateDir, { recursive: true });

function flag(args, name, fallback = null) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] ?? fallback; }
function readPid(path) { try { return Number(readFileSync(path, 'utf8')); } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function stop(path, label) {
  const pid = readPid(path);
  if (!alive(pid)) { if (existsSync(path)) unlinkSync(path); console.log(`${label}: not running`); return; }
  process.kill(pid, 'SIGTERM'); unlinkSync(path); console.log(`${label}: stopped (pid ${pid})`);
}
function daemon({ runtime, script, pidPath, logPath, env = {} }) {
  const current = readPid(pidPath); if (alive(current)) throw new Error(`already running (pid ${current})`);
  const fd = openSync(logPath, 'a');
  const child = spawn(runtime, [script], { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, ...env } });
  child.unref(); writeFileSync(pidPath, String(child.pid), { mode: 0o600 }); return child.pid;
}
async function control(path, init) {
  const cfg = JSON.parse(readFileSync(hostConfig, 'utf8'));
  const res = await fetch(`http://127.0.0.1:${cfg.control_port || 19844}${path}`, init);
  const value = await res.json(); if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`); return value;
}
function requireFlag(value, name) { if (!value) throw new Error(`${name} is required`); return value; }

async function main() {
  const [area, action = 'status', ...args] = process.argv.slice(2);
  if (area === 'gateway') {
    if (action === 'start') {
      const token = requireFlag(process.env.DISCORD_BOT_TOKEN, 'DISCORD_BOT_TOKEN');
      const channel = requireFlag(process.env.DISCORD_CHANNEL_ID, 'DISCORD_CHANNEL_ID');
      const users = requireFlag(process.env.DISCORD_ALLOWED_USER_IDS, 'DISCORD_ALLOWED_USER_IDS');
      const hostToken = requireFlag(process.env.XM_REMOTE_HOST_TOKEN, 'XM_REMOTE_HOST_TOKEN');
      const pid = daemon({ runtime: 'bun', script: resolve(here, 'x-remote-gateway.mjs'), pidPath: paths.gatewayPid, logPath: paths.gatewayLog, env: { DISCORD_BOT_TOKEN: token, DISCORD_CHANNEL_ID: channel, DISCORD_ALLOWED_USER_IDS: users, XM_REMOTE_HOST_TOKEN: hostToken } });
      console.log(`x-remote gateway: started (pid ${pid}, log ${paths.gatewayLog})`); return;
    }
    if (action === 'stop') return stop(paths.gatewayPid, 'x-remote gateway');
    if (action === 'status') { const pid = readPid(paths.gatewayPid); console.log(JSON.stringify({ running: alive(pid), pid, log: paths.gatewayLog })); return; }
  }
  if (area === 'host') {
    if (action === 'enroll') {
      const gatewayUrl = requireFlag(flag(args, '--gateway'), '--gateway');
      const token = requireFlag(flag(args, '--token'), '--token');
      const cfg = { host_id: flag(args, '--host-id', hostname()), gateway_url: gatewayUrl, token, control_port: Number(flag(args, '--control-port', '19844')) };
      writeFileSync(hostConfig, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 }); console.log(`x-remote host: enrolled ${cfg.host_id}`); return;
    }
    if (action === 'start') {
      if (!existsSync(hostConfig)) throw new Error('run `xm remote host enroll` first');
      const pid = daemon({ runtime: process.execPath, script: resolve(here, 'x-remote-host.mjs'), pidPath: paths.hostPid, logPath: paths.hostLog });
      console.log(`x-remote host: started (pid ${pid}, log ${paths.hostLog})`); return;
    }
    if (action === 'stop') return stop(paths.hostPid, 'x-remote host');
    if (action === 'status') { const pid = readPid(paths.hostPid); console.log(JSON.stringify({ running: alive(pid), pid, enrolled: existsSync(hostConfig), log: paths.hostLog })); return; }
  }
  if (area === 'run') {
    const prompt = flag([action, ...args], '--prompt') || flag([action, ...args], '-p');
    const provider = flag([action, ...args], '--provider', 'codex');
    console.log(JSON.stringify(await control('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, prompt, cwd: flag([action, ...args], '--cwd', process.cwd()) }) }), null, 2)); return;
  }
  if (area === 'sessions') { console.log(JSON.stringify(await control('/sessions'), null, 2)); return; }
  if (['steer', 'resume', 'interrupt'].includes(area)) {
    const sessionId = action; const text = args.join(' ');
    console.log(JSON.stringify(await control(`/sessions/${sessionId}/${area}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }), null, 2)); return;
  }
  console.log('Usage: xm remote gateway start|stop|status | host enroll|start|stop|status | run --provider codex|claude --prompt TEXT | sessions | steer|resume|interrupt SESSION [TEXT]');
}
main().catch((error) => { console.error(`x-remote: ${error.message}`); process.exit(1); });
