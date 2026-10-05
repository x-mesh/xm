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

export function liveSessionFiles(directory, provider, run = spawnSync) {
  if (!existsSync(directory)) return new Map();
  const files = readdirSync(directory).filter(name => UUID.test(name.replace(/\.lock$/, '')))
    .map(name => join(realpathSync(directory), name));
  if (!files.length) return new Map();
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
  if (!owners.size) return owners;
  const pids = [...new Set([...owners.values()].flat())];
  const processes = run('ps', ['-p', pids.join(','), '-o', 'pid=,comm=,args='], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.error || ![0, 1].includes(processes.status)) throw new Error(`cannot verify live ${provider} processes`);
  const live = new Set();
  for (const line of (processes.stdout || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || basename(match[2]) !== provider) continue;
    if (provider === 'codex' && isCodexService(match[3])) continue;
    live.add(Number(match[1]));
  }
  return new Map([...owners].flatMap(([id, holders]) => {
    const active = holders.filter(pid => live.has(pid));
    return active.length ? [[id, active]] : [];
  }));
}
