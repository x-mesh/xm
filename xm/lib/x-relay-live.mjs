import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (provider === 'codex' && /(?:^|\s)(?:app-server|queue)(?:\s|$)/.test(match[3])) continue;
    live.add(Number(match[1]));
  }
  return new Map([...owners].flatMap(([id, holders]) => {
    const active = holders.filter(pid => live.has(pid));
    return active.length ? [[id, active]] : [];
  }));
}
