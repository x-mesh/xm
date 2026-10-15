import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODEX_VALUE_OPTIONS = new Set(['-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env', '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval']);
const CODEX_SWITCH_OPTIONS = new Set(['--strict-config', '--oss', '--approve-for-me', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--worktree', '--search', '--no-alt-screen', '--no-daemon', '-h', '--help', '-V', '--version']);

function isCodexService(commandLine) {
  const args = commandLine.trim().split(/\s+/).slice(1);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') return false;
    if (!argument.startsWith('-')) return argument === 'app-server' || argument === 'queue';
    const shortOption = argument.slice(0, 2);
    const option = CODEX_VALUE_OPTIONS.has(shortOption) ? shortOption : argument.split('=', 1)[0];
    if (CODEX_VALUE_OPTIONS.has(option)) {
      if (argument === option) index++;
    } else if (!CODEX_SWITCH_OPTIONS.has(option)) return false;
  }
  return false;
}

// macOS ps prints comm as the full executable path cut to its column width
// ("/Users/me/.c"); the first word of args keeps that path whole.
function executable(comm, args) {
  return comm.includes('/') ? basename(args.trim().split(/\s+/)[0] || '') : comm;
}

export function liveSessionFiles(directory, provider, run = spawnSync) {
  const { owners, processes } = lockOwners(directory, provider, run);
  return new Map([...owners].flatMap(([id, holders]) => {
    const active = holders.filter(pid => processes.get(pid)?.isService === false);
    return active.length ? [[id, active]] : [];
  }));
}

// Codex 0.161+ CLIs hand their thread to the shared app-server daemon, so the
// daemon, not the CLI, holds that thread's writer lock.
export function daemonHeldCodexFiles(directory, run = spawnSync) {
  const { owners, processes } = lockOwners(directory, 'codex', run);
  return new Set([...owners].filter(([, holders]) => holders.every(pid => processes.get(pid)?.isService === true)).map(([id]) => id));
}

export function interactiveCodexCwds(run = spawnSync) {
  if (!process.getuid) throw new Error('live relay session detection requires macOS or Linux');
  const listed = run('ps', ['-A', '-o', 'pid=,uid=,comm=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  if (listed.error || ![0, 1].includes(listed.status)) throw new Error('cannot list live codex processes');
  const pids = [];
  for (const line of (listed.stdout || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || Number(match[2]) !== process.getuid() || executable(match[3], match[4]) !== 'codex' || isCodexService(match[4])) continue;
    pids.push(Number(match[1]));
  }
  const cwds = new Map();
  if (!pids.length) return cwds;
  const opened = run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-n', '-P', '-F', 'pn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  if (opened.error || ![0, 1].includes(opened.status)) throw new Error('cannot read live codex working directories');
  let pid;
  for (const line of (opened.stdout || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pids.includes(pid)) {
      const cwd = canonical(line.slice(1));
      cwds.set(cwd, [...(cwds.get(cwd) || []), pid]);
    }
  }
  return cwds;
}

export function canonical(path) {
  try { return realpathSync(path); } catch { return path; }
}

function lockOwners(directory, provider, run) {
  const empty = { owners: new Map(), processes: new Map() };
  if (!existsSync(directory)) return empty;
  const files = readdirSync(directory).filter(name => UUID.test(name.replace(/\.lock$/, '')))
    .map(name => join(realpathSync(directory), name));
  if (!files.length) return empty;
  if (!process.getuid) throw new Error('live relay session detection requires macOS or Linux');
  const result = run('lsof', ['-a', '-u', String(process.getuid()), '-n', '-P', '-F', 'pcfn', '--', ...files], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && result.status !== 1) || result.stderr?.trim()) {
    throw new Error(`cannot verify live ${provider} sessions: ${(result.stderr || result.error?.message || 'lsof failed').trim()}`);
  }
  const owners = new Map();
  const allowed = new Set(files);
  let pid;
  let command;
  for (const line of (result.stdout || '').split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); command = null; }
    else if (line.startsWith('c')) command = line.slice(1);
    else if (line.startsWith('n') && allowed.has(line.slice(1)) && command === provider && Number.isSafeInteger(pid) && pid > 0) {
      const id = basename(line.slice(1)).replace(/\.lock$/, '');
      owners.set(id, [...(owners.get(id) || []), pid]);
    }
  }
  if (!owners.size) return empty;
  const pids = [...new Set([...owners.values()].flat())];
  const listed = run('ps', ['-p', pids.join(','), '-o', 'pid=,comm=,args='], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  if (listed.error || ![0, 1].includes(listed.status)) throw new Error(`cannot verify live ${provider} processes`);
  const processes = new Map();
  for (const line of (listed.stdout || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || executable(match[2], match[3]) !== provider) continue;
    processes.set(Number(match[1]), { isService: provider === 'codex' && isCodexService(match[3]) });
  }
  return { owners, processes };
}
