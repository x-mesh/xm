#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, openSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { menuSelect, PromptAbort, printRail, printSection } from './x-remote-prompts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.XM_REMOTE_STATE_DIR || join(homedir(), '.xm', 'remote');
const hostConfig = join(stateDir, 'host.json');
const gatewayConfig = join(stateDir, 'gateway.json');
const paths = {
  gatewayPid: join(stateDir, 'gateway.pid'), gatewayLog: join(stateDir, 'gateway.log'),
  hostPid: join(stateDir, 'host.pid'), hostLog: join(stateDir, 'host.log'),
};
mkdirSync(stateDir, { recursive: true });

function flag(args, name, fallback = null) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] ?? fallback; }
function readPid(path) { try { return Number(readFileSync(path, 'utf8')); } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function readJson(path, fallback = {}) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function saveJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); chmodSync(path, 0o600); }
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
function requireFlag(value, name) { if (!value) throw new Error(`${name} is required`); return value; }
function gatewayValues() {
  const saved = readJson(gatewayConfig);
  return {
    discord_bot_token: process.env.DISCORD_BOT_TOKEN || saved.discord_bot_token || '',
    discord_channel_id: process.env.DISCORD_CHANNEL_ID || saved.discord_channel_id || '',
    discord_allowed_user_ids: process.env.DISCORD_ALLOWED_USER_IDS || saved.discord_allowed_user_ids || '',
    xm_remote_host_token: process.env.XM_REMOTE_HOST_TOKEN || saved.xm_remote_host_token || '',
  };
}
function gatewayEnv() {
  const cfg = gatewayValues();
  return {
    DISCORD_BOT_TOKEN: requireFlag(cfg.discord_bot_token, 'DISCORD_BOT_TOKEN'),
    DISCORD_CHANNEL_ID: requireFlag(cfg.discord_channel_id, 'DISCORD_CHANNEL_ID'),
    DISCORD_ALLOWED_USER_IDS: requireFlag(cfg.discord_allowed_user_ids, 'DISCORD_ALLOWED_USER_IDS'),
    XM_REMOTE_HOST_TOKEN: requireFlag(cfg.xm_remote_host_token, 'XM_REMOTE_HOST_TOKEN'),
  };
}
async function control(path, init) {
  const cfg = readJson(hostConfig);
  if (!cfg.gateway_url) throw new Error('run `xm remote host enroll` first');
  const res = await fetch(`http://127.0.0.1:${cfg.control_port || 19844}${path}`, init);
  const value = await res.json(); if (!res.ok) throw new Error(value.error || `HTTP ${res.status}`); return value;
}

function checkBinary(name) { return spawnSync('which', [name], { stdio: 'ignore' }).status === 0; }
function printCheck(label, ok, detail = '') { console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`); return ok; }
async function doctor() {
  console.log('x-remote doctor\n');
  const cfg = gatewayValues(); let failures = 0;
  const required = (label, value, valid = Boolean(value)) => { if (!printCheck(label, valid, valid ? 'configured' : 'missing/invalid')) failures += valid ? 0 : 1; };
  required('DISCORD_BOT_TOKEN', cfg.discord_bot_token);
  required('DISCORD_CHANNEL_ID', cfg.discord_channel_id, /^\d+$/.test(cfg.discord_channel_id));
  required('DISCORD_ALLOWED_USER_IDS', cfg.discord_allowed_user_ids, cfg.discord_allowed_user_ids.split(',').every((id) => /^\d+$/.test(id.trim())) && Boolean(cfg.discord_allowed_user_ids));
  required('XM_REMOTE_HOST_TOKEN', cfg.xm_remote_host_token);
  if (cfg.discord_bot_token && /^\d+$/.test(cfg.discord_channel_id)) {
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bot ${cfg.discord_bot_token}` } });
      const body = await res.json();
      printCheck('Discord bot token', res.ok && body.bot === true, res.ok ? `${body.username || body.id}` : `HTTP ${res.status}`) || failures++;
      const channel = await fetch(`https://discord.com/api/v10/channels/${cfg.discord_channel_id}`, { headers: { Authorization: `Bot ${cfg.discord_bot_token}` } });
      const channelBody = await channel.json();
      printCheck('Discord channel access', channel.ok, channel.ok ? `#${channelBody.name} type=${channelBody.type}` : `HTTP ${channel.status}`) || failures++;
    } catch (error) { printCheck('Discord API reachable', false, error.message); failures++; }
  }
  const host = readJson(hostConfig);
  required('host enrollment', host.host_id && host.gateway_url && host.token, host.host_id && host.gateway_url && host.token);
  required('Bun runtime', true, checkBinary('bun'));
  required('Node 22+', true, Number(process.versions.node.split('.')[0]) >= 22);
  required('Codex CLI', true, checkBinary('codex'));
  required('Claude CLI', true, checkBinary('claude'));
  const gatewayPid = readPid(paths.gatewayPid); printCheck('gateway process', alive(gatewayPid), alive(gatewayPid) ? `pid ${gatewayPid}` : 'stopped') || failures++;
  if (alive(gatewayPid)) { try { const res = await fetch(`http://127.0.0.1:${process.env.XM_REMOTE_GATEWAY_PORT || 19843}/health`); const body = await res.json(); printCheck('gateway health', res.ok && body.ok, JSON.stringify(body)) || failures++; } catch (error) { printCheck('gateway health', false, error.message); failures++; } }
  const hostPid = readPid(paths.hostPid); printCheck('host process', alive(hostPid), alive(hostPid) ? `pid ${hostPid}` : 'stopped') || failures++;
  if (alive(hostPid) && host.control_port) { try { const res = await fetch(`http://127.0.0.1:${host.control_port || 19844}/health`); const body = await res.json(); printCheck('host health', res.ok && body.ok, JSON.stringify(body)) || failures++; } catch (error) { printCheck('host health', false, error.message); failures++; } }
  console.log(`\n${failures ? `doctor: ${failures} problem(s)` : 'doctor: all checks passed'}`);
  return failures;
}

async function promptSecret(rl, label, fallback = '') {
  // readline does not mask input portably; keep the prompt explicit and never log the value.
  const suffix = fallback ? ' [현재 값 유지]' : '';
  const value = await rl.question(`${label}${suffix}: `);
  return value || fallback;
}
async function setupInteractive() {
  const rl = createInterface({ input: stdin, output: stdout });
  const existing = gatewayValues();
  const hostExisting = readJson(hostConfig);
  const draft = {
    gateway: { ...existing },
    host: { ...hostExisting },
  };
  const saveDraft = () => {
    if (draft.gateway.discord_bot_token || draft.gateway.discord_channel_id || draft.gateway.discord_allowed_user_ids || draft.gateway.xm_remote_host_token) saveJson(gatewayConfig, draft.gateway);
    if (draft.host.host_id || draft.host.gateway_url || draft.host.token) saveJson(hostConfig, draft.host);
  };
  try {
    printSection('x-remote setup', 'Esc/q back · Ctrl-C exit (saved items kept)');
    printRail('설정은 ~/.xm/remote에 mode 600으로 저장됩니다.');
    // Validate each field as it's collected (fail fast) instead of after every prompt —
    // the old order let an invalid value sit in draft.gateway (and get saveDraft()'d)
    // for several more prompts before the combined check at the end caught it — panel
    // review 2026-07-17 (kiro LOW).
    const token = await promptSecret(rl, 'Discord bot token', existing.discord_bot_token);
    if (!token) throw new Error('Discord bot token이 필요합니다');
    draft.gateway.discord_bot_token = token; saveDraft();
    const channel = await rl.question(`Discord channel ID${existing.discord_channel_id ? ` [${existing.discord_channel_id}]` : ''}: `) || existing.discord_channel_id;
    if (!/^\d+$/.test(channel || '')) throw new Error('Discord channel ID는 숫자여야 합니다');
    draft.gateway.discord_channel_id = channel; saveDraft();
    const users = await rl.question(`허용할 Discord user ID 목록${existing.discord_allowed_user_ids ? ` [${existing.discord_allowed_user_ids}]` : ''}: `) || existing.discord_allowed_user_ids;
    if (!users) throw new Error('허용할 Discord user ID가 최소 1개 필요합니다');
    draft.gateway.discord_allowed_user_ids = users; saveDraft();
    const hostToken = await promptSecret(rl, 'x-remote host token', existing.xm_remote_host_token);
    if (!hostToken) throw new Error('x-remote host token이 필요합니다');
    draft.gateway.xm_remote_host_token = hostToken; draft.host.token = hostToken; saveDraft();
    // Fall back to the EXISTING enrolled value (not a hardcoded default) so re-running
    // setup and pressing Enter on these three never silently overwrites a custom
    // gateway URL / control port — panel review 2026-07-17 (codex MEDIUM).
    const gatewayUrl = await rl.question(`Host gateway URL [${hostExisting.gateway_url || 'ws://127.0.0.1:19843'}]: `) || hostExisting.gateway_url || 'ws://127.0.0.1:19843';
    if (!/^wss?:\/\//.test(gatewayUrl)) throw new Error('Host gateway URL은 ws:// 또는 wss://로 시작해야 합니다');
    const hostId = await rl.question(`Host ID [${hostExisting.host_id || hostname()}]: `) || hostExisting.host_id || hostname();
    const controlPort = await rl.question(`Host control port [${hostExisting.control_port || 19844}]: `) || hostExisting.control_port || '19844';
    draft.host = { host_id: hostId, gateway_url: gatewayUrl, token: hostToken, control_port: Number(controlPort) };
    saveDraft();
    console.log(`설정 저장 완료: ${gatewayConfig}, ${hostConfig}`);
    const start = (await rl.question('gateway와 host를 지금 시작할까요? [Y/n]: ')).toLowerCase() !== 'n';
    if (start) { startGateway(); startHost(); }
  } catch (error) {
    saveDraft();
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || rl.closed) console.log('Input ended (EOF/abort) — saved items are kept');
    else throw error;
  } finally { rl.close(); }
}
function startGateway() { const env = gatewayEnv(); const pid = daemon({ runtime: 'bun', script: resolve(here, 'x-remote-gateway.mjs'), pidPath: paths.gatewayPid, logPath: paths.gatewayLog, env }); console.log(`x-remote gateway: started (pid ${pid})`); }
function startHost() { if (!existsSync(hostConfig)) throw new Error('run `xm remote host enroll` first'); const pid = daemon({ runtime: process.execPath, script: resolve(here, 'x-remote-host.mjs'), pidPath: paths.hostPid, logPath: paths.hostLog }); console.log(`x-remote host: started (pid ${pid})`); }
function restart(kind) { if (kind === 'gateway') { stop(paths.gatewayPid, 'x-remote gateway'); startGateway(); } else { stop(paths.hostPid, 'x-remote host'); startHost(); } }
async function interactive() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    printSection('x-remote', 'Esc/q back · Ctrl-C exit (saved items kept)');
    while (true) {
      const gatewayRunning = alive(readPid(paths.gatewayPid));
      const hostRunning = alive(readPid(paths.hostPid));
      const choice = await menuSelect(rl, {
        title: 'Choose an action',
        subtitle: 'Esc/q back · Ctrl-C exit (saved items kept)',
        header: [`Gateway: ${gatewayRunning ? 'running' : 'stopped'}`, `Host: ${hostRunning ? 'running' : 'stopped'}`],
        options: [
          { key: '1', label: 'Setup', hint: 'configure Discord, gateway, host' },
          { key: '2', label: 'Doctor', hint: 'validate settings and health' },
          { key: '3', label: 'Start', hint: 'gateway + host' },
          { key: '4', label: 'Stop', hint: 'host + gateway' },
          { key: '5', label: 'Restart', hint: 'host + gateway' },
          { key: '6', label: 'Gateway', hint: 'start · stop · restart' },
          { key: '7', label: 'Host', hint: 'start · stop · restart' },
          { key: '8', label: 'Status', hint: 'process and enrollment' },
          { key: '0', label: 'Exit' },
        ],
      });
      if (choice === '0') return;
      if (choice === '1') { rl.close(); return setupInteractive(); }
      if (choice === '2') await doctor();
      else if (choice === '3') { startGateway(); startHost(); }
      else if (choice === '4') { stop(paths.hostPid, 'x-remote host'); stop(paths.gatewayPid, 'x-remote gateway'); }
      else if (choice === '5') { stop(paths.hostPid, 'x-remote host'); stop(paths.gatewayPid, 'x-remote gateway'); startGateway(); startHost(); }
      else if (choice === '6') {
        const action = await menuSelect(rl, { title: 'Gateway', options: [{ key: '1', label: 'Start' }, { key: '2', label: 'Stop' }, { key: '3', label: 'Restart' }, { key: '0', label: 'Back' }] });
        if (action === '1') startGateway(); else if (action === '2') stop(paths.gatewayPid, 'x-remote gateway'); else if (action === '3') restart('gateway');
      } else if (choice === '7') {
        const action = await menuSelect(rl, { title: 'Host', options: [{ key: '1', label: 'Start' }, { key: '2', label: 'Stop' }, { key: '3', label: 'Restart' }, { key: '0', label: 'Back' }] });
        if (action === '1') startHost(); else if (action === '2') stop(paths.hostPid, 'x-remote host'); else if (action === '3') restart('host');
      } else if (choice === '8') {
        console.log(JSON.stringify({ gateway: { running: alive(readPid(paths.gatewayPid)), pid: readPid(paths.gatewayPid) }, host: { running: alive(readPid(paths.hostPid)), pid: readPid(paths.hostPid), enrolled: existsSync(hostConfig) } }, null, 2));
      }
    }
  } catch (error) {
    if (!(error instanceof PromptAbort)) throw error;
    console.log('Input ended (EOF/abort) — saved items are kept');
  } finally { if (!rl.closed) rl.close(); }
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) { if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive mode requires a TTY; use `xm remote doctor` or explicit subcommands'); return interactive(); }
  const [area, action = 'status', ...args] = argv;
  if (area === 'doctor') return process.exitCode = await doctor();
  if (area === 'setup' || area === 'configure') return setupInteractive();
  if (area === 'start') { startGateway(); return startHost(); }
  if (area === 'stop') { stop(paths.hostPid, 'x-remote host'); return stop(paths.gatewayPid, 'x-remote gateway'); }
  if (area === 'restart') { stop(paths.hostPid, 'x-remote host'); stop(paths.gatewayPid, 'x-remote gateway'); startGateway(); return startHost(); }
  if (area === 'gateway') {
    if (action === 'start') return startGateway();
    if (action === 'stop') return stop(paths.gatewayPid, 'x-remote gateway');
    if (action === 'restart') return restart('gateway');
    if (action === 'status') { const pid = readPid(paths.gatewayPid); return console.log(JSON.stringify({ running: alive(pid), pid, log: paths.gatewayLog })); }
  }
  if (area === 'host') {
    if (action === 'enroll') { const gatewayUrl = requireFlag(flag(args, '--gateway'), '--gateway'); const token = requireFlag(flag(args, '--token'), '--token'); const cfg = { host_id: flag(args, '--host-id', hostname()), gateway_url: gatewayUrl, token, control_port: Number(flag(args, '--control-port', '19844')) }; saveJson(hostConfig, cfg); console.log(`x-remote host: enrolled ${cfg.host_id}`); return; }
    if (action === 'start') return startHost();
    if (action === 'stop') return stop(paths.hostPid, 'x-remote host');
    if (action === 'restart') return restart('host');
    if (action === 'status') { const pid = readPid(paths.hostPid); return console.log(JSON.stringify({ running: alive(pid), pid, enrolled: existsSync(hostConfig), log: paths.hostLog })); }
  }
  if (area === 'run') { const prompt = flag([action, ...args], '--prompt') || flag([action, ...args], '-p'); const provider = flag([action, ...args], '--provider', 'codex'); console.log(JSON.stringify(await control('/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider, prompt, cwd: flag([action, ...args], '--cwd', process.cwd()) }) }), null, 2)); return; }
  if (area === 'sessions') { console.log(JSON.stringify(await control('/sessions'), null, 2)); return; }
  if (['steer', 'resume', 'interrupt'].includes(area)) { const sessionId = action; const text = args.join(' '); console.log(JSON.stringify(await control(`/sessions/${sessionId}/${area}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }), null, 2)); return; }
  console.log('Usage: xm remote [setup|doctor|start|stop|restart] | gateway start|stop|restart|status | host enroll|start|stop|restart|status | run --provider codex|claude --prompt TEXT | sessions | steer|resume|interrupt SESSION [TEXT]');
}
main().catch((error) => { console.error(`x-remote: ${error.message}`); process.exit(1); });
